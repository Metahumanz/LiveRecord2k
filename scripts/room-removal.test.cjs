const assert = require('node:assert/strict');
const test = require('node:test');

const { BusinessError, LiveRecordService } = require('../src/server/app/service.cjs');

function createService() {
  const service = new LiveRecordService();
  service.saveStore = async () => {};
  service.emitState = () => {};
  service.log = () => {};
  return service;
}

function addRoomWithRecording(service, id = '123456') {
  const cleanPath = `C:\\recordings\\${id}_test.clean.mp4`;
  const room = service.normalizeRoom({
    id,
    realRoomId: Number(id),
    currentRecording: { roomId: id, cleanPath, danmakuPath: `${cleanPath}.jsonl`, valid: true }
  });
  room.currentRecording = { roomId: id, cleanPath, danmakuPath: `${cleanPath}.jsonl`, valid: true };
  service.rooms.set(id, room);
  return { room, cleanPath };
}

test('normal room removal reports every related queued media task as a state conflict', async () => {
  const service = createService();
  const { room, cleanPath } = addRoomWithRecording(service);
  service.burnQueue.push({ id: 'burn-job', roomId: room.id, recording: { cleanPath } });
  service.exportQueue.push({ id: 'export-job', cleanPath, request: { recording: { roomId: room.id, cleanPath } } });
  service.exportPreview = { id: 'preview-cache', sourcePath: cleanPath, status: 'queued', ready: false };
  service.exportPreviewProgress = { id: 'preview-job', status: 'queued' };

  await assert.rejects(
    service.removeRoom(room.id),
    (error) =>
      error instanceof BusinessError &&
      error.code === 'ROOM_BUSY' &&
      error.statusCode === 409 &&
      /烧录|导出|预览/.test(error.message)
  );
  assert.equal(service.rooms.has(room.id), true);
});

test('forced room removal cancels related queues and preview before deleting the room', async () => {
  const service = createService();
  const { room, cleanPath } = addRoomWithRecording(service);
  const cancelledJobIds = [];
  service.mediaJobs = {
    cancel(id) {
      cancelledJobIds.push(id);
      return true;
    },
    snapshot() {
      return [];
    },
    hasActive() {
      return false;
    }
  };
  service.burnQueue.push({ id: 'burn-job', roomId: room.id, recording: { cleanPath } });
  service.exportQueue.push({ id: 'export-job', cleanPath, request: { recording: { roomId: room.id, cleanPath } } });
  service.exportPreview = { id: 'preview-cache', sourcePath: cleanPath, status: 'queued', ready: false };
  service.exportPreviewProgress = { id: 'preview-job', status: 'queued' };
  service.pendingSegmentCleanups.set('cleanup-job', { roomId: room.id });

  await service.removeRoom(room.id, { force: true });

  assert.equal(service.rooms.has(room.id), false);
  assert.equal(service.burnQueue.length, 0);
  assert.equal(service.exportQueue.length, 0);
  assert.equal(service.pendingSegmentCleanups.has('cleanup-job'), false);
  assert.deepEqual(new Set(cancelledJobIds), new Set(['burn-job', 'export-job', 'preview-job']));
});
