const test = require('node:test');
const assert = require('node:assert/strict');

const { LiveRecordService } = require('../src/server/app/service.cjs');

test('burn requests are serialized globally and duplicate active recordings are rejected', async () => {
  const service = new LiveRecordService();
  const roomA = { id: '1', title: 'A', currentRecording: null };
  const roomB = { id: '2', title: 'B', currentRecording: null };
  service.rooms.set(roomA.id, roomA);
  service.rooms.set(roomB.id, roomB);
  const recordingA = { cleanPath: 'C:\\recordings\\a.clean.mp4', danmakuPath: 'C:\\recordings\\a.danmaku.jsonl' };
  const recordingB = { cleanPath: 'C:\\recordings\\b.clean.mp4', danmakuPath: 'C:\\recordings\\b.danmaku.jsonl' };
  const started = [];
  let releaseFirst;
  const firstIdle = new Promise((resolve) => {
    releaseFirst = resolve;
  });

  service.startBurnRecording = async (room) => {
    started.push(room.id);
    return true;
  };
  service.waitForBurnIdle = (roomId) => (roomId === roomA.id ? firstIdle : Promise.resolve());

  const first = await service.enqueueBurnRecording(roomA, recordingA);
  await new Promise((resolve) => setImmediate(resolve));
  const duplicate = await service.enqueueBurnRecording(roomA, recordingA);
  await service.enqueueBurnRecording(roomB, recordingB);

  assert.equal(duplicate.id, first.id);
  assert.deepEqual(started, [roomA.id]);
  assert.equal(service.burnQueue.length, 1);

  releaseFirst();
  await new Promise((resolve) => setImmediate(() => setImmediate(resolve)));
  assert.deepEqual(started, [roomA.id, roomB.id]);
  assert.equal(service.burnQueue.length, 0);
});
