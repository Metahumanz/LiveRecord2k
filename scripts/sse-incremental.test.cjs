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

test('SSE sends a full state once, then emits room and log deltas', () => {
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
  service.logs.push({ id: 'incremental-log', time: Date.now(), level: 'info', message: '仅发送新增日志' });
  service.flushState();

  const delta = response.writes.join('');
  assert.match(delta, /event: room/);
  assert.match(delta, /event: log/);
  assert.doesNotMatch(delta, /event: state/);
  assert.doesNotMatch(delta, /"recordings"/);
});

test('client subscribes to each incremental SSE event and merges it into the last state', () => {
  const clientSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'client', 'recorderClient.ts'), 'utf8');
  for (const eventName of ['state', 'room', 'recording', 'mediaJob', 'log', 'settings', 'diskSpace']) {
    assert.match(clientSource, new RegExp(`addEventListener\\('${eventName}'`));
  }
  assert.match(clientSource, /mergeRoomEvent/);
  assert.match(clientSource, /mergeMediaJobEvent/);
});
