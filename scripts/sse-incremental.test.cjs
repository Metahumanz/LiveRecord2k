const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const { LiveRecordService } = require('../src/server/app/service.cjs');

class FakeSseResponse extends EventEmitter {
  constructor() {
    super();
    this.writes = [];
  }

  write(value) {
    this.writes.push(String(value));
  }
}

test('SSE sends a full state once, then emits only marked room and log deltas', () => {
  const service = new LiveRecordService();
  service.rooms.set('123', {
    id: '123',
    title: '增量测试直播间',
    liveStatus: 0,
    monitoring: false,
    autoRecord: false,
    recording: false
  });
  const response = new FakeSseResponse();

  service.addClient(response);
  assert.match(response.writes.join(''), /event: state/);

  response.writes.length = 0;
  service.rooms.get('123').liveStatus = 1;
  service.markRoomDirty('123');
  service.log('info', '仅发送新增日志');
  service.flushState();

  const delta = response.writes.join('');
  assert.match(delta, /event: room/);
  assert.match(delta, /event: log/);
  assert.doesNotMatch(delta, /event: state/);
  assert.doesNotMatch(delta, /"recordings"/);
});

test('FFmpeg 风格的房间增量不会为每个 SSE 客户端构造完整 AppState', () => {
  const service = new LiveRecordService();
  service.rooms.set('123', {
    id: '123',
    title: '进度测试直播间',
    liveStatus: 1,
    monitoring: true,
    autoRecord: false,
    recording: true
  });
  const response = new FakeSseResponse();
  service.addClient(response);
  response.writes.length = 0;

  const originalGetState = service.getState.bind(service);
  let fullStateCalls = 0;
  service.getState = (...args) => {
    fullStateCalls += 1;
    return originalGetState(...args);
  };
  service.markRoomDirty('123');
  service.flushState();

  assert.equal(fullStateCalls, 0);
  assert.match(response.writes.join(''), /event: room/);
  assert.doesNotMatch(response.writes.join(''), /event: recording/);
  assert.doesNotMatch(response.writes.join(''), /event: mediaJob/);
  assert.doesNotMatch(response.writes.join(''), /event: settings/);
});

test('删除房间通过删除增量通知既有 SSE 客户端', () => {
  const service = new LiveRecordService();
  service.rooms.set('123', {
    id: '123',
    title: '待删除直播间',
    liveStatus: 0,
    monitoring: false,
    autoRecord: false,
    recording: false
  });
  const response = new FakeSseResponse();
  service.addClient(response);
  response.writes.length = 0;

  service.rooms.delete('123');
  service.markRoomDeleted('123');
  service.flushState();

  assert.match(response.writes.join(''), /event: room/);
  assert.match(response.writes.join(''), /"id":"123","deleted":true/);
});

test('媒体队列变化只发送 mediaJob 增量，不需要构造完整 AppState', () => {
  const service = new LiveRecordService();
  const response = new FakeSseResponse();
  service.addClient(response);
  response.writes.length = 0;

  const originalGetState = service.getState.bind(service);
  let fullStateCalls = 0;
  service.getState = (...args) => {
    fullStateCalls += 1;
    return originalGetState(...args);
  };
  const release = service.mediaJobs.registerExternal({
    id: 'recording:123:test',
    type: 'recording',
    resources: ['recording', 'network', 'diskWrite']
  });
  service.flushState();

  assert.equal(fullStateCalls, 0);
  assert.match(response.writes.join(''), /event: mediaJob/);
  assert.doesNotMatch(response.writes.join(''), /event: recording/);
  release();
});

test('client subscribes to each incremental SSE event and merges it into the last state', () => {
  const clientSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'client', 'recorderClient.ts'), 'utf8');
  for (const eventName of ['state', 'room', 'recording', 'mediaJob', 'log', 'settings', 'diskSpace', 'system']) {
    assert.match(clientSource, new RegExp(`addEventListener\\('${eventName}'`));
  }
  assert.match(clientSource, /mergeRoomEvent/);
  assert.match(clientSource, /mergeMediaJobEvent/);
});
