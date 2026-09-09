'use strict';

const { MONITOR_FAST_CONFIRM_MS, getMonitorPollDelayMs, jitterMonitorPollDelay } = require('./room-monitor-scheduler.cjs');

const MONITOR_FAST_CONFIRM_WINDOW_MS = 15 * 1000;
// Stable checks should still surface a fresh "last checked" value eventually,
// but sending one room delta for every 10–15 second fallback poll does not add
// useful information for an unchanged room.
const ROOM_STATE_SYNC_INTERVAL_MS = 45 * 1000;

/**
 * Owns the live-status polling and danmaku-push lifecycle.  The recorder
 * remains the owner of rooms, persistence, notifications, and recording;
 * those cross-domain actions stay explicit through the injected host service.
 */
class RoomMonitorService {
  constructor(owner, dependencies = {}) {
    this.owner = owner;
    this.roomLabel = dependencies.roomLabel;
    this.getCookieValue = dependencies.getCookieValue;
    this.createBiliError = dependencies.createBiliError;
    this.DanmakuClient = dependencies.DanmakuClient;
    this.monitorTimers = new Map();
    this.livePushMonitors = new Map();
    this.roomTickLocks = new Set();
    this.lastRoomStateSyncAt = new Map();
  }

  publishRoomState(room, options = {}) {
    const roomId = String(room?.id || '');
    if (!roomId) return false;
    const now = Number(options.now ?? Date.now());
    const lastSyncedAt = Number(this.lastRoomStateSyncAt.get(roomId) || 0);
    const force = Boolean(options.force);
    if (!force && lastSyncedAt > 0 && now - lastSyncedAt < ROOM_STATE_SYNC_INTERVAL_MS) {
      return false;
    }
    this.lastRoomStateSyncAt.set(roomId, now);
    this.owner.markRoomDirty(roomId);
    return true;
  }

  async setMonitoring(roomId, enabled) {
    const room = this.owner.getRoom(roomId);
    room.monitoring = Boolean(enabled);
    if (room.monitoring) {
      this.owner.startMonitorTimer(room.id);
      this.owner.startLivePushMonitor(room.id).catch((error) => {
        this.owner.log('warn', `${this.roomLabel(room)} 开播推送监听启动失败：${error.message}`);
      });
      this.owner.log('info', `${this.roomLabel(room)} 已开始监听。`);
      this.owner.tickRoom(room.id);
    } else {
      this.owner.stopMonitorTimer(room.id);
      this.owner.stopLivePushMonitor(room.id);
      this.owner.log('info', `${this.roomLabel(room)} 已停止监听。`);
    }
    await this.owner.saveStore();
    this.publishRoomState(room, { force: true });
    return this.owner.getState();
  }

  applyMonitorPollJitter(delayMs) {
    return jitterMonitorPollDelay(delayMs);
  }

  isLivePushConnected(roomId) {
    const monitor = this.livePushMonitors.get(String(roomId));
    return Boolean(monitor?.authenticated && monitor?.client && !monitor.stopped);
  }

  startMonitorTimer(roomId, options = {}) {
    const roomKey = String(roomId);
    this.owner.stopMonitorTimer(roomKey);
    const schedule = (delayMs) => {
      const timer = setTimeout(async () => {
        if (this.monitorTimers.get(roomKey) !== timer) return;
        await this.owner.tickRoom(roomKey);
        const room = this.owner.rooms.get(roomKey);
        if (!room?.monitoring || this.monitorTimers.get(roomKey) !== timer) return;
        const nextDelayMs = getMonitorPollDelayMs(room, this.owner.settings, this.owner.isLivePushConnected(room.id));
        schedule(this.owner.applyMonitorPollJitter(nextDelayMs));
      }, Math.max(0, Number(delayMs) || 0));
      timer.unref?.();
      this.monitorTimers.set(roomKey, timer);
    };
    // Spread restored-room checks across the status endpoint. Enabling a room
    // still triggers its immediate tick separately.
    const initialDelayMs = options.initialDelayMs ?? Math.floor(Math.random() * 750);
    schedule(initialDelayMs);
  }

  stopMonitorTimer(roomId) {
    const roomKey = String(roomId);
    const timer = this.monitorTimers.get(roomKey);
    if (timer) {
      clearTimeout(timer);
      this.monitorTimers.delete(roomKey);
    }
  }

  async tickRoom(roomId) {
    const roomKey = String(roomId);
    const room = this.owner.rooms.get(roomKey);
    if (!room || !room.monitoring || this.roomTickLocks.has(roomKey)) {
      return;
    }
    this.roomTickLocks.add(roomKey);
    try {
      const previousLiveStatus = room.liveStatus;
      const previousRealRoomId = room.realRoomId;
      const status = await this.owner.fetchRoomLiveStatus(room.id);
      const liveDetectedAt = Date.now();
      room.realRoomId = status.realRoomId || room.realRoomId;
      await this.owner.applyDetectedLiveStatus(room, status.liveStatus, '轮询');
      if (room.realRoomId !== previousRealRoomId) {
        this.publishRoomState(room, { force: true });
      }
      if (room.liveStatus === 1 && room.autoRecord && !this.owner.isRoomRecording(room)) {
        await this.owner.startRecording(room.id, true, {
          liveDetectedAt,
          liveDetectionSource: previousLiveStatus === 1 ? '轮询恢复' : '轮询'
        });
      }
    } catch (error) {
      const previousError = room.lastError;
      room.lastCheckedAt = Date.now();
      room.lastError = error.message || String(error);
      this.owner.log('error', `${this.roomLabel(room)} 监听异常：${error.message}`);
      this.publishRoomState(room, { force: previousError !== room.lastError });
    } finally {
      this.roomTickLocks.delete(roomKey);
    }
  }

  async fetchRoomLiveStatus(roomId) {
    const roomInit = await this.owner.fetchBiliJson(
      `https://api.live.bilibili.com/room/v1/Room/room_init?id=${encodeURIComponent(roomId)}`
    );
    if (roomInit.code !== 0) {
      throw this.createBiliError('开播状态检查', roomInit);
    }
    return {
      realRoomId: Number(roomInit.data?.room_id || 0),
      liveStatus: Number(roomInit.data?.live_status || 0)
    };
  }

  async applyDetectedLiveStatus(room, liveStatus, source) {
    const previousLiveStatus = room.liveStatus;
    const previousLastError = room.lastError;
    room.liveStatus = Number(liveStatus || 0);
    room.lastCheckedAt = Date.now();
    room.lastError = undefined;
    const liveStatusChanged = previousLiveStatus !== room.liveStatus;
    if (previousLiveStatus !== undefined && liveStatusChanged) {
      room.monitorFastPollUntil = Date.now() + MONITOR_FAST_CONFIRM_WINDOW_MS;
      this.owner.log(
        room.liveStatus === 1 ? 'success' : 'info',
        `${this.roomLabel(room)}：${room.liveStatus === 1 ? '开播' : '下播'}（${source}）`
      );
      if (room.liveStatus === 1 && this.owner.settings.notifyLiveStarted) {
        this.owner.notify('开播提醒', `${this.roomLabel(room)} 已开播`, 'live.started', {
          roomId: room.id,
          roomTitle: room.title || '',
          anchor: room.anchor || ''
        });
      }
      if (previousLiveStatus === 1 && room.liveStatus !== 1 && this.owner.settings.notifyLiveEnded) {
        this.owner.notify('下播提醒', `${this.roomLabel(room)} 已下播`, 'live.ended', {
          roomId: room.id,
          roomTitle: room.title || '',
          anchor: room.anchor || ''
        });
      }
      this.owner.saveStore().catch((error) => {
        this.owner.log('warn', `${this.roomLabel(room)} 保存开播状态失败：${error.message}`);
      });
      if (room.monitoring) {
        this.owner.startMonitorTimer(room.id, {
          initialDelayMs: this.owner.applyMonitorPollJitter(MONITOR_FAST_CONFIRM_MS)
        });
      }
    }
    this.publishRoomState(room, { force: liveStatusChanged || Boolean(previousLastError) });
  }

  async startLivePushMonitor(roomId) {
    const room = this.owner.rooms.get(String(roomId));
    if (!room || !room.monitoring || this.livePushMonitors.has(room.id)) {
      return;
    }
    const monitor = {
      roomId: room.id,
      client: null,
      retryTimer: null,
      retryDelayMs: 2000,
      stopped: false,
      authenticated: false
    };
    this.livePushMonitors.set(room.id, monitor);
    await this.owner.connectLivePushMonitor(room, monitor);
  }

  async connectLivePushMonitor(room, monitor) {
    if (monitor.stopped || !room.monitoring || this.livePushMonitors.get(room.id) !== monitor) {
      return;
    }
    try {
      if (!room.realRoomId) {
        const status = await this.owner.fetchRoomLiveStatus(room.id);
        room.realRoomId = status.realRoomId || room.realRoomId;
        await this.owner.applyDetectedLiveStatus(room, status.liveStatus, '推送监听初始化');
      }
      const info = await this.owner.fetchDanmuInfo(room.realRoomId || room.id);
      if (info.code !== 0) {
        throw this.createBiliError('开播推送服务器', info);
      }
      const client = new this.DanmakuClient({
        roomId: Number(room.realRoomId || room.id),
        uid: Number(this.getCookieValue(this.owner.settings.cookie, 'DedeUserID') || 0),
        buvid: this.getCookieValue(this.owner.settings.cookie, 'buvid3') || this.getCookieValue(this.owner.settings.cookie, 'buvid4') || '',
        token: info.data?.token || '',
        hosts: info.data?.host_list || [],
        onAuthReply: (reply) => {
          if (Number(reply?.code || 0) === 0) {
            monitor.authenticated = true;
            monitor.retryDelayMs = 2000;
            this.owner.log('info', `${this.roomLabel(room)} 开播推送监听已连接。`);
            return;
          }
          this.owner.log('warn', `${this.roomLabel(room)} 开播推送认证失败：${reply?.message || reply?.code || '未知错误'}`);
          client.close('auth failed');
        },
        onCommand: (command) => {
          this.owner.handleLivePushCommand(room, monitor, command).catch((error) => {
            this.owner.log('warn', `${this.roomLabel(room)} 处理开播推送失败：${error.message}`);
          });
        },
        onError: (error) => {
          if (!monitor.stopped) {
            this.owner.log('warn', `${this.roomLabel(room)} 开播推送连接错误：${error.message}`);
          }
        },
        onClose: (reason) => {
          if (monitor.client === client) {
            monitor.client = null;
          }
          monitor.authenticated = false;
          if (!monitor.stopped) {
            if (room.monitoring) {
              const fallbackDelayMs = getMonitorPollDelayMs(room, this.owner.settings, false);
              this.owner.startMonitorTimer(room.id, {
                initialDelayMs: this.owner.applyMonitorPollJitter(fallbackDelayMs)
              });
            }
            this.owner.scheduleLivePushReconnect(room, monitor, reason);
          }
        }
      });
      monitor.client = client;
      client.connect();
    } catch (error) {
      this.owner.scheduleLivePushReconnect(room, monitor, error.message);
    }
  }

  async handleLivePushCommand(room, monitor, command) {
    if (monitor.stopped || !room.monitoring) {
      return;
    }
    const commandType = String(command?.cmd || '').split(':')[0].toUpperCase();
    if (commandType === 'LIVE') {
      const liveDetectedAt = Date.now();
      await this.owner.applyDetectedLiveStatus(room, 1, '弹幕服务器推送');
      if (room.autoRecord && !this.owner.isRoomRecording(room)) {
        await this.owner.startRecording(room.id, true, {
          livePushReceivedAt: liveDetectedAt,
          liveDetectedAt,
          liveDetectionSource: '弹幕服务器推送'
        });
      }
      setImmediate(() => {
        this.owner.refreshRoom(room.id, { silent: true }).catch(() => {});
      });
      return;
    }
    if (commandType === 'PREPARING') {
      await this.owner.applyDetectedLiveStatus(room, 0, '弹幕服务器推送');
      return;
    }
    if (commandType === 'ROOM_CHANGE') {
      const data = command?.data || {};
      room.title = String(data.title || room.title || '');
      this.publishRoomState(room, { force: true });
    }
  }

  scheduleLivePushReconnect(room, monitor, reason) {
    if (monitor.stopped || monitor.retryTimer || !room.monitoring) {
      return;
    }
    const delayMs = Math.min(60000, Math.max(2000, monitor.retryDelayMs || 2000));
    monitor.retryDelayMs = Math.min(60000, delayMs * 2);
    if (monitor.authenticated || delayMs >= 10000) {
      this.owner.log(
        'warn',
        `${this.roomLabel(room)} 开播推送已断开，${Math.round(delayMs / 1000)} 秒后重连：${reason || '连接关闭'}`
      );
    }
    monitor.retryTimer = setTimeout(() => {
      monitor.retryTimer = null;
      this.owner.connectLivePushMonitor(room, monitor).catch(() => {});
    }, delayMs);
    monitor.retryTimer.unref?.();
  }

  stopLivePushMonitor(roomId) {
    const roomKey = String(roomId);
    const monitor = this.livePushMonitors.get(roomKey);
    if (!monitor) {
      return;
    }
    monitor.stopped = true;
    clearTimeout(monitor.retryTimer);
    monitor.client?.close('停止监听');
    this.livePushMonitors.delete(roomKey);
  }

  stopAll() {
    for (const timer of this.monitorTimers.values()) {
      clearTimeout(timer);
    }
    this.monitorTimers.clear();
    for (const roomId of Array.from(this.livePushMonitors.keys())) {
      this.owner.stopLivePushMonitor(roomId);
    }
    this.lastRoomStateSyncAt.clear();
  }
}

module.exports = { RoomMonitorService, getMonitorPollDelayMs };
