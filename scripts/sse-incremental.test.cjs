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
    return true;
  }

  end() {
    this.ended = true;
    this.emit('close');
  }
}

class BackpressuredFakeSseResponse extends FakeSseResponse {
  constructor() {
    super();
    this.backpressured = false;
  }

  write(value) {
    this.writes.push(String(value));
    return !this.backpressured;
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

test('设置保存仅发送 settings 和 diskSpace 增量，不会重建无关 SSE 事件', async () => {
  const service = new LiveRecordService();
  service.ensureRecordingOutputRootReady = async () => true;
  service.saveStore = async () => {};
  service.getDiskSpace = async () => ({
    requestedPath: service.settings.outputDir,
    checkedPath: service.settings.outputDir,
    totalBytes: 100,
    freeBytes: 50,
    usedBytes: 50,
    usedPercent: 50,
    checkedAt: Date.now()
  });
  const response = new FakeSseResponse();
  service.addClient(response);
  response.writes.length = 0;

  await service.saveSettings({ preferHevc: !service.settings.preferHevc });
  service.flushState();

  const delta = response.writes.join('');
  assert.match(delta, /event: settings/);
  assert.match(delta, /event: diskSpace/);
  assert.doesNotMatch(delta, /event: room/);
  assert.doesNotMatch(delta, /event: recording/);
  assert.doesNotMatch(delta, /event: mediaJob/);
  assert.doesNotMatch(delta, /event: system/);
});

test('慢速 SSE 客户端在背压解除后获取新的完整状态', () => {
  const service = new LiveRecordService();
  service.rooms.set('123', {
    id: '123',
    title: '背压测试直播间',
    liveStatus: 0,
    monitoring: false,
    autoRecord: false,
    recording: false
  });
  const response = new BackpressuredFakeSseResponse();
  service.addClient(response);
  response.writes.length = 0;

  response.backpressured = true;
  service.rooms.get('123').liveStatus = 1;
  service.markRoomDirty('123');
  service.flushState();
  assert.equal(service.clients.get(response)?.paused, true);

  response.backpressured = false;
  response.emit('drain');

  assert.equal(service.clients.get(response)?.paused, false);
  assert.match(response.writes.join(''), /event: state/);
  assert.match(response.writes.join(''), /"liveStatus":1/);
});

test('修改远程凭据会通知并关闭既有远程 SSE 客户端', async () => {
  const service = new LiveRecordService();
  service.ensureRecordingOutputRootReady = async () => true;
  service.saveStore = async () => {};
  service.refreshOutputDiskSpace = async () => null;
  const remoteResponse = new FakeSseResponse();
  const localResponse = new FakeSseResponse();
  service.addClient(remoteResponse, { accessRequired: true, accessAuthenticated: true });
  service.addClient(localResponse, { accessRequired: false, localConsole: true });
  remoteResponse.writes.length = 0;
  localResponse.writes.length = 0;

  await service.saveSettings({ accessUsername: 'operator' });

  assert.match(remoteResponse.writes.join(''), /event: auth-invalidated/);
  assert.equal(remoteResponse.ended, true);
  assert.equal(service.clients.has(remoteResponse), false);
  assert.equal(localResponse.ended, undefined);
  assert.equal(service.clients.has(localResponse), true);
});

test('client subscribes to each incremental SSE event and merges it into the last state', () => {
  const clientSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'client', 'recorderClient.ts'), 'utf8');
  for (const eventName of ['state', 'room', 'recording', 'mediaJob', 'log', 'settings', 'diskSpace', 'system']) {
    assert.match(clientSource, new RegExp(`addEventListener\\('${eventName}'`));
  }
  assert.match(clientSource, /mergeRoomEvent/);
  assert.match(clientSource, /mergeMediaJobEvent/);
  assert.match(clientSource, /addEventListener\('auth-invalidated'/);
  assert.match(clientSource, /window\.location\.reload\(\)/);
});
