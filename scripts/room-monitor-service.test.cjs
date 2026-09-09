const assert = require('node:assert/strict');
const test = require('node:test');

const { LiveRecordService } = require('../src/server/app/service.cjs');
const { RoomMonitorService } = require('../src/server/app/room-monitor-service.cjs');

test('LiveRecordService 把监听生命周期委托给 RoomMonitorService，同时保留兼容入口', async () => {
  const service = new LiveRecordService();
  assert.ok(service.roomMonitor instanceof RoomMonitorService);
  assert.equal(service.monitorTimers, service.roomMonitor.monitorTimers);
  assert.equal(service.livePushMonitors, service.roomMonitor.livePushMonitors);
  assert.equal(service.roomTickLocks, service.roomMonitor.roomTickLocks);

  service.rooms.set('123', { id: '123', monitoring: true, liveStatus: 0, autoRecord: false });
  let statusChecks = 0;
  let detectedStatus = null;
  service.fetchRoomLiveStatus = async () => {
    statusChecks += 1;
    return { realRoomId: 123, liveStatus: 1 };
  };
  service.applyDetectedLiveStatus = async (_room, liveStatus) => {
    detectedStatus = liveStatus;
  };

  await service.tickRoom('123');

  assert.equal(statusChecks, 1);
  assert.equal(detectedStatus, 1);
  assert.equal(service.roomTickLocks.size, 0);
});

test('监听开关仍通过 LiveRecordService 的兼容入口调度定时器、推送与首轮检查', async () => {
  const service = new LiveRecordService();
  service.rooms.set('456', { id: '456', monitoring: false, liveStatus: 0, autoRecord: false });
  service.getState = () => ({ ok: true });
  service.saveStore = async () => {};
  service.emitState = () => {};
  service.log = () => {};
  let startedTimers = 0;
  let startedPushMonitors = 0;
  let ticks = 0;
  let stoppedTimers = 0;
  let stoppedPushMonitors = 0;
  service.startMonitorTimer = () => {
    startedTimers += 1;
  };
  service.startLivePushMonitor = async () => {
    startedPushMonitors += 1;
  };
  service.tickRoom = () => {
    ticks += 1;
  };
  service.stopMonitorTimer = () => {
    stoppedTimers += 1;
  };
  service.stopLivePushMonitor = () => {
    stoppedPushMonitors += 1;
  };

  await service.setMonitoring('456', true);
  await service.setMonitoring('456', false);

  assert.deepEqual(
    { startedTimers, startedPushMonitors, ticks, stoppedTimers, stoppedPushMonitors },
    { startedTimers: 1, startedPushMonitors: 1, ticks: 1, stoppedTimers: 1, stoppedPushMonitors: 1 }
  );
});
