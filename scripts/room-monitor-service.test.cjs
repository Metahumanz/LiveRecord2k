const assert = require('node:assert/strict');
const test = require('node:test');

const { LiveRecordService } = require('../src/server/app/service.cjs');
const { RoomMonitorService } = require('../src/server/app/room-monitor-service.cjs');
const { getMonitorPollDelayMs } = require('../src/server/app/room-monitor-scheduler.cjs');

function createMonitorHarness(options = {}) {
  const room = {
    id: '123',
    realRoomId: '123',
    title: '测试直播间',
    monitoring: true,
    liveStatus: 0,
    autoRecord: false,
    ...options.room
  };
  const calls = {
    dirtyRooms: [],
    fullStateEmits: 0,
    logs: [],
    notifications: [],
    saved: 0,
    startTimers: [],
    startPushMonitors: [],
    ticks: 0,
    startRecordings: [],
    refreshes: 0
  };
  const rooms = new Map([[room.id, room]]);
  const owner = {
    rooms,
    settings: {
      pollIntervalSec: 15,
      cookie: '',
      notifyLiveStarted: false,
      notifyLiveEnded: false,
      ...options.settings
    },
    getRoom: (roomId) => {
      const found = rooms.get(String(roomId));
      if (!found) throw new Error(`missing room: ${roomId}`);
      return found;
    },
    getState: () => ({ ok: true }),
    log: (...args) => calls.logs.push(args),
    notify: (...args) => calls.notifications.push(args),
    saveStore: async () => {
      calls.saved += 1;
    },
    markRoomDirty: (roomId) => calls.dirtyRooms.push(String(roomId)),
    emitState: () => {
      calls.fullStateEmits += 1;
    },
    fetchRoomLiveStatus: options.fetchRoomLiveStatus || (async () => ({
      realRoomId: room.realRoomId,
      liveStatus: room.liveStatus
    })),
    isRoomRecording: options.isRoomRecording || ((target) => Boolean(target.recording)),
    startRecording: options.startRecording || (async (...args) => {
      calls.startRecordings.push(args);
    }),
    refreshRoom: options.refreshRoom || (async () => {
      calls.refreshes += 1;
    }),
    fetchBiliJson: options.fetchBiliJson || (async () => ({ code: 0, data: {} })),
    fetchDanmuInfo: options.fetchDanmuInfo || (async () => ({ code: 0, data: { token: 'token', host_list: [] } })),
    applyMonitorPollJitter: options.applyMonitorPollJitter || ((delayMs) => delayMs)
  };
  const monitor = new RoomMonitorService(owner, {
    roomLabel: (target) => `房间 ${target.id}`,
    getCookieValue: () => '',
    createBiliError: (stage, payload) => new Error(`${stage}: ${payload?.code || 'unknown'}`),
    DanmakuClient: options.DanmakuClient || class {}
  });

  // The production owner keeps these compatibility entry points. The harness
  // delegates the lifecycle methods back to the extracted service, while the
  // defaults for initial start actions remain observable and side-effect free.
  owner.startMonitorTimer = options.startMonitorTimer || ((...args) => {
    calls.startTimers.push(args);
  });
  owner.stopMonitorTimer = options.stopMonitorTimer || ((...args) => monitor.stopMonitorTimer(...args));
  owner.tickRoom = options.tickRoom || (() => {
    calls.ticks += 1;
  });
  owner.applyDetectedLiveStatus = options.applyDetectedLiveStatus || ((...args) => monitor.applyDetectedLiveStatus(...args));
  owner.startLivePushMonitor = options.startLivePushMonitor || (async (...args) => {
    calls.startPushMonitors.push(args);
  });
  owner.stopLivePushMonitor = options.stopLivePushMonitor || ((...args) => monitor.stopLivePushMonitor(...args));
  owner.connectLivePushMonitor = options.connectLivePushMonitor || ((...args) => monitor.connectLivePushMonitor(...args));
  owner.handleLivePushCommand = options.handleLivePushCommand || ((...args) => monitor.handleLivePushCommand(...args));
  owner.scheduleLivePushReconnect =
    options.scheduleLivePushReconnect || ((...args) => monitor.scheduleLivePushReconnect(...args));
  owner.isLivePushConnected = options.isLivePushConnected || ((...args) => monitor.isLivePushConnected(...args));

  return { monitor, owner, room, rooms, calls };
}

async function withFakeTimers(run) {
  const originalSetTimeout = global.setTimeout;
  const originalClearTimeout = global.clearTimeout;
  const timers = [];
  global.setTimeout = (callback, delayMs) => {
    const timer = {
      callback,
      delayMs: Number(delayMs),
      cleared: false,
      unref() {}
    };
    timers.push(timer);
    return timer;
  };
  global.clearTimeout = (timer) => {
    if (timer) timer.cleared = true;
  };
  try {
    return await run(timers);
  } finally {
    global.setTimeout = originalSetTimeout;
    global.clearTimeout = originalClearTimeout;
  }
}

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

test('RoomMonitorService 只标记对应房间，稳定轮询的 lastCheckedAt 会限频同步', async () => {
  const { monitor, room, calls } = createMonitorHarness();

  await monitor.applyDetectedLiveStatus(room, 0, '轮询');
  await monitor.applyDetectedLiveStatus(room, 0, '轮询');
  assert.deepEqual(calls.dirtyRooms, ['123'], '初次检查发送 room 增量，紧随其后的稳定检查不重复发送');

  await monitor.handleLivePushCommand(room, { stopped: false }, {
    cmd: 'ROOM_CHANGE',
    data: { title: '更新后的标题' }
  });
  assert.equal(room.title, '更新后的标题');
  assert.deepEqual(calls.dirtyRooms, ['123', '123']);

  await monitor.applyDetectedLiveStatus(room, 1, '轮询');
  assert.equal(room.liveStatus, 1);
  assert.deepEqual(calls.dirtyRooms, ['123', '123', '123'], '开播状态变化必须立即同步');
  assert.equal(calls.fullStateEmits, 0, '监听服务不能调用会标脏全部状态的 emitState');
});

test('监听异常只同步对应房间的错误状态，不触发完整 AppState', async () => {
  const { monitor, owner, room, calls } = createMonitorHarness();
  owner.fetchRoomLiveStatus = async () => {
    throw new Error('network timeout');
  };

  await monitor.tickRoom(room.id);

  assert.equal(room.lastError, 'network timeout');
  assert.deepEqual(calls.dirtyRooms, ['123']);
  assert.equal(calls.fullStateEmits, 0);
});

test('LIVE 推送与 autoRecord 只会发起一次录制', async () => {
  const { monitor, owner, room, calls } = createMonitorHarness({
    room: { liveStatus: 0, autoRecord: true }
  });
  let recordingIntent = false;
  owner.isRoomRecording = () => recordingIntent;
  owner.startRecording = async (...args) => {
    calls.startRecordings.push(args);
    recordingIntent = true;
  };

  await Promise.all([
    monitor.handleLivePushCommand(room, { stopped: false }, { cmd: 'LIVE' }),
    monitor.handleLivePushCommand(room, { stopped: false }, { cmd: 'LIVE' })
  ]);

  assert.equal(room.liveStatus, 1);
  assert.equal(calls.startRecordings.length, 1);
  assert.equal(calls.startRecordings[0][0], room.id);
  assert.equal(calls.startRecordings[0][1], true);
});

test('PREPARING 推送会切回下播，并进入三秒快速确认窗口', async () => {
  const { monitor, room, calls } = createMonitorHarness({ room: { liveStatus: 1 } });
  const before = Date.now();

  await monitor.handleLivePushCommand(room, { stopped: false }, { cmd: 'PREPARING' });

  assert.equal(room.liveStatus, 0);
  assert.ok(room.monitorFastPollUntil >= before + 15_000);
  assert.equal(calls.startTimers.length, 1);
  assert.deepEqual(calls.startTimers[0], [room.id, { initialDelayMs: 3_000 }]);
  assert.equal(getMonitorPollDelayMs(room, { pollIntervalSec: 60 }, true, Date.now()), 3_000);
});

test('推送断线会退回轮询，并以指数退避重连', async () => {
  await withFakeTimers(async (timers) => {
    const clients = [];
    class FakeDanmakuClient {
      constructor(options) {
        this.options = options;
        clients.push(this);
      }

      connect() {
        if (clients.length === 1) {
          this.options.onAuthReply({ code: 0 });
          this.options.onClose('network lost');
        } else if (clients.length === 2) {
          // A reconnect that fails before authentication must retain the
          // increased retry delay instead of resetting it back to two seconds.
          this.options.onClose('network lost again');
        }
      }

      close(reason) {
        this.options.onClose(reason || 'closed');
      }
    }
    const { monitor, room, calls } = createMonitorHarness({ DanmakuClient: FakeDanmakuClient });

    await monitor.startLivePushMonitor(room.id);
    assert.equal(calls.startTimers.length, 1);
    assert.deepEqual(calls.startTimers[0], [room.id, { initialDelayMs: 15_000 }]);
    assert.equal(timers.length, 1);
    assert.equal(timers[0].delayMs, 2_000);

    timers[0].callback();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(clients.length, 2);
    assert.equal(timers.length, 2);
    assert.equal(timers[1].delayMs, 4_000);

    monitor.stopAll();
  });
});

test('关闭监听后，即使已排队的重连回调触发也不会重建 WebSocket', async () => {
  await withFakeTimers(async (timers) => {
    let constructedClients = 0;
    class FakeDanmakuClient {
      constructor() {
        constructedClients += 1;
      }
    }
    const { monitor, room } = createMonitorHarness({ DanmakuClient: FakeDanmakuClient });
    const livePushMonitor = {
      roomId: room.id,
      client: { close() {} },
      retryTimer: null,
      retryDelayMs: 2_000,
      stopped: false,
      authenticated: false
    };
    monitor.livePushMonitors.set(room.id, livePushMonitor);
    monitor.scheduleLivePushReconnect(room, livePushMonitor, 'network lost');
    const retry = timers[0];

    room.monitoring = false;
    monitor.stopLivePushMonitor(room.id);
    retry.callback();
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(constructedClients, 0);
    assert.equal(monitor.livePushMonitors.size, 0);
  });
});

test('同一房间的并发 tick 被锁住，完成后会释放锁', async () => {
  const { monitor, owner, room } = createMonitorHarness();
  let resolveStatus;
  let fetches = 0;
  owner.fetchRoomLiveStatus = () => {
    fetches += 1;
    return new Promise((resolve) => {
      resolveStatus = resolve;
    });
  };

  const firstTick = monitor.tickRoom(room.id);
  const secondTick = monitor.tickRoom(room.id);
  assert.equal(fetches, 1);
  assert.equal(monitor.roomTickLocks.has(room.id), true);

  resolveStatus({ realRoomId: room.realRoomId, liveStatus: 0 });
  await Promise.all([firstTick, secondTick]);

  assert.equal(monitor.roomTickLocks.has(room.id), false);
});

test('stopAll 会释放轮询 timer、推送重连 timer 和 WebSocket', async () => {
  await withFakeTimers(async (timers) => {
    const { monitor, room } = createMonitorHarness();
    monitor.startMonitorTimer(room.id, { initialDelayMs: 123 });
    let closeCount = 0;
    const retryTimer = global.setTimeout(() => {}, 456);
    monitor.livePushMonitors.set(room.id, {
      roomId: room.id,
      client: { close: () => { closeCount += 1; } },
      retryTimer,
      retryDelayMs: 2_000,
      stopped: false,
      authenticated: false
    });
    monitor.lastRoomStateSyncAt.set(room.id, Date.now());

    monitor.stopAll();

    assert.equal(closeCount, 1);
    assert.equal(monitor.monitorTimers.size, 0);
    assert.equal(monitor.livePushMonitors.size, 0);
    assert.equal(monitor.lastRoomStateSyncAt.size, 0);
    assert.ok(timers.every((timer) => timer.cleared));
  });
});
