const http = require('node:http');
const https = require('node:https');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const zlib = require('node:zlib');
const tls = require('node:tls');
const crypto = require('node:crypto');
const { spawn, spawnSync } = require('node:child_process');
const WebSocket = require('ws');
const QRCode = require('qrcode');

let ffmpegStatic = null;
try {
  ffmpegStatic = require('ffmpeg-static');
} catch {
  ffmpegStatic = null;
}

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

const DANMAKU_OP = {
  HEARTBEAT: 2,
  HEARTBEAT_REPLY: 3,
  MESSAGE: 5,
  AUTH: 7,
  AUTH_REPLY: 8
};

const APP_NAME = 'BiliRecord2K';
const STORE_FILE = 'settings.json';
const DEFAULT_PORT = 3263;
const STREAM_QN_PROBES = [25000, 20000, 15000, 10000, 400, 250, 150];
const MIN_PLAYABLE_BYTES = 128 * 1024;
const NO_MEDIA_TIMEOUT_MS = 70 * 1000;
const WBI_MIXIN_KEY_TABLE = [
  46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49, 33, 9, 42, 19, 29, 28, 14,
  39, 12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40, 61, 26, 17, 0, 1, 60, 51, 30, 4, 22, 25, 54, 21, 56, 59,
  6, 63, 57, 62, 11, 36, 20, 34, 44, 52
];
const HOST = process.env.HOST || '127.0.0.1';
const PROD_MODE = process.argv.includes('--prod');
const DEV_MODE = process.argv.includes('--dev') || !PROD_MODE;
const OPEN_BROWSER = !process.argv.includes('--no-open') && process.env.BILI_RECORD_NO_OPEN !== '1';
const APP_ROOT = getAppRoot();
const DIST_ROOT = path.join(APP_ROOT, 'dist');
const APP_VERSION = getAppVersion();
const DEFAULT_UPDATE_MANIFEST_URL =
  process.env.BILI_RECORD_UPDATE_URL ||
  'https://github.com/Metahumanz/LiveRecord2k/releases/latest/download/update.json';
const GITHUB_LATEST_RELEASE_API = 'https://api.github.com/repos/Metahumanz/LiveRecord2k/releases/latest';
const UPDATE_CHECK_TIMEOUT_MS = 12000;
const RUN_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';
const MAX_PROXY_IMAGE_BYTES = 15 * 1024 * 1024;
const MAX_JSON_BODY_BYTES = 1024 * 1024;
const SEGMENT_ROTATION_GRACE_MS = 10 * 1000;
const PREVIEW_SESSION_TTL_MS = 10 * 60 * 1000;
const MAX_PREVIEW_PLAYLIST_BYTES = 2 * 1024 * 1024;

class LiveRecordService {
  constructor() {
    const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
    this.storePath = path.join(appData, 'BiliRecord2K', STORE_FILE);
    this.settings = this.createDefaultSettings();
    this.rooms = new Map();
    this.logs = [];
    this.monitorTimers = new Map();
    this.recordingSessions = new Map();
    this.recordingStartLocks = new Set();
    this.reconnectPendingRooms = new Set();
    this.burnSessions = new Map();
    this.previewSessions = new Map();
    this.recordings = [];
    this.clients = new Set();
    this.notifications = [];
    this.notificationSeq = 0;
    this.loginSession = null;
    this.wbiCache = null;
    this.updateState = {
      status: 'idle',
      currentVersion: APP_VERSION,
      latestVersion: '',
      message: '尚未检查更新',
      checkedAt: 0,
      downloadReceivedBytes: 0,
      downloadTotalBytes: 0,
      downloadProgress: null,
      updateLogPath: '',
      statusPath: '',
      packagePath: '',
      queued: false,
      manifest: null
    };
    this.queuedUpdateTimer = null;
    this.ffmpegPath = findFfmpegPath();
  }

  createDefaultSettings() {
    return {
      outputDir: path.join(os.homedir(), 'Videos', '哔哩录播2K'),
      cookie: '',
      pollIntervalSec: 15,
      targetQn: 15000,
      preferHevc: true,
      roomImageMode: 'keyframe',
      outputContainer: 'mp4',
      segmentMinutes: 60,
      autoBurnDanmaku: true,
      burnOverlayMode: 'danmaku-gift',
      burnCodec: 'libx265',
      burnCrf: 24,
      notifyLiveStarted: true,
      notifyLiveEnded: true,
      notifyRecordingStarted: true,
      notifyRecordingEnded: true,
      notifyBurnStarted: true,
      notifyBurnEnded: true,
      openBrowserOnStart: true,
      updateManifestUrl: DEFAULT_UPDATE_MANIFEST_URL,
      serverPort: DEFAULT_PORT
    };
  }

  async init() {
    await this.loadStore();
    await this.loadLastUpdateStatus();
    await fsp.mkdir(this.settings.outputDir, { recursive: true });
    await this.refreshRecordingLibrary({ silent: true });
    for (const room of this.rooms.values()) {
      if (room.monitoring) {
        this.startMonitorTimer(room.id);
      }
    }
    this.log('success', `WebUI 后端已启动，ffmpeg: ${this.ffmpegPath}`);
  }

  async loadStore() {
    try {
      const raw = await fsp.readFile(this.storePath, 'utf8');
      const store = JSON.parse(raw);
      this.settings = this.normalizeSettings({ ...this.settings, ...(store.settings || {}) });
      for (const savedRoom of store.rooms || []) {
        const room = this.normalizeRoom(savedRoom);
        this.rooms.set(room.id, room);
      }
      this.recordings = (store.recordings || []).map((recording) => this.normalizeRecording(recording)).filter(Boolean);
    } catch (error) {
      if (error.code !== 'ENOENT') {
        this.log('warn', `读取配置失败，将使用默认配置：${error.message}`);
      }
    }
  }

  async saveStore() {
    await fsp.mkdir(path.dirname(this.storePath), { recursive: true });
    const rooms = Array.from(this.rooms.values()).map((room) => ({
      id: room.id,
      realRoomId: room.realRoomId,
      shortId: room.shortId,
      title: room.title,
      anchor: room.anchor,
      cover: room.cover,
      keyframe: room.keyframe,
      liveStatus: room.liveStatus,
      monitoring: room.monitoring
    }));
    await fsp.writeFile(this.storePath, JSON.stringify({ settings: this.settings, rooms, recordings: this.recordings }, null, 2), 'utf8');
  }

  normalizeSettings(settings) {
    return {
      ...this.createDefaultSettings(),
      ...settings,
      outputContainer: normalizeContainer(settings.outputContainer),
      burnCodec: normalizeBurnCodec(settings.burnCodec),
      pollIntervalSec: clamp(Number(settings.pollIntervalSec || 15), 5, 300),
      segmentMinutes: clamp(Number(settings.segmentMinutes || 60), 0.05, 1440),
      targetQn: normalizeTargetQn(settings.targetQn),
      burnCrf: clamp(Number(settings.burnCrf || 24), 16, 35),
      preferHevc: Boolean(settings.preferHevc),
      roomImageMode: normalizeRoomImageMode(settings.roomImageMode),
      autoBurnDanmaku: Boolean(settings.autoBurnDanmaku),
      burnOverlayMode: normalizeBurnOverlayMode(settings.burnOverlayMode),
      notifyLiveStarted: settings.notifyLiveStarted !== false,
      notifyLiveEnded: settings.notifyLiveEnded !== false,
      notifyRecordingStarted: settings.notifyRecordingStarted !== false,
      notifyRecordingEnded: settings.notifyRecordingEnded !== false,
      notifyBurnStarted: settings.notifyBurnStarted !== false,
      notifyBurnEnded: settings.notifyBurnEnded !== false,
      openBrowserOnStart: settings.openBrowserOnStart !== false,
      updateManifestUrl: String(settings.updateManifestUrl || DEFAULT_UPDATE_MANIFEST_URL).trim(),
      serverPort: clamp(Number(settings.serverPort || DEFAULT_PORT), 1, 65535)
    };
  }

  normalizeRoom(room) {
    return {
      id: String(room.id || '').trim(),
      realRoomId: room.realRoomId,
      shortId: room.shortId,
      title: room.title,
      anchor: room.anchor,
      cover: room.cover,
      keyframe: room.keyframe,
      liveStatus: room.liveStatus,
      monitoring: Boolean(room.monitoring),
      recording: false,
      burning: false,
      lastCheckedAt: room.lastCheckedAt,
      lastError: undefined,
      qualityWarning: undefined,
      stream: undefined,
      currentRecording: undefined
    };
  }

  normalizeRecording(recording) {
    const cleanPath = String(recording?.cleanPath || '').trim();
    if (!cleanPath) {
      return null;
    }
    return {
      id: String(recording.id || cleanPath),
      roomId: recording.roomId ? String(recording.roomId) : '',
      roomTitle: String(recording.roomTitle || ''),
      anchor: String(recording.anchor || ''),
      startedAt: Number(recording.startedAt || Date.now()),
      cleanPath,
      danmakuPath: String(recording.danmakuPath || deriveSiblingPath(cleanPath, 'danmaku', 'jsonl')),
      cssPath: String(recording.cssPath || deriveSiblingPath(cleanPath, 'danmaku', 'css')),
      assPath: String(recording.assPath || deriveSiblingPath(cleanPath, 'danmaku', 'ass')),
      burnedPath: String(recording.burnedPath || deriveBurnedPath(cleanPath, 'danmaku-gift')),
      capturePath: String(recording.capturePath || ''),
      containerStage: normalizeContainerStage(recording.containerStage),
      validReason: String(recording.validReason || ''),
      mergeGroup: String(recording.mergeGroup || ''),
      mergeSequence: Number(recording.mergeSequence || 0),
      mergeOutputPath: String(recording.mergeOutputPath || ''),
      mergedFrom: Array.isArray(recording.mergedFrom) ? recording.mergedFrom.map(String) : undefined,
      durationSec: Number(recording.durationSec || 0),
      fileSize: Number(recording.fileSize || 0),
      valid: recording.valid !== false,
      eventCount: Number(recording.eventCount || 0),
      rawDanmakuCount: Number(recording.rawDanmakuCount || 0),
      capturedDanmakuCount: Number(recording.capturedDanmakuCount ?? recording.eventCount ?? 0),
      ignoredDanmakuCount: Number(recording.ignoredDanmakuCount || 0),
      danmakuCommandCounts: normalizeCommandCounts(recording.danmakuCommandCounts),
      danmakuStatus: recording.danmakuStatus,
      danmakuMessage: recording.danmakuMessage,
      danmakuPopularity: Number(recording.danmakuPopularity || 0),
      videoInfo: recording.videoInfo || null
    };
  }

  getState() {
    return {
      settings: { ...this.settings },
      rooms: Array.from(this.rooms.values()).map((room) => this.getPublicRoomState(room)),
      recordings: this.recordings,
      logs: this.logs,
      login: this.getPublicLoginState(),
      version: APP_VERSION,
      update: this.getPublicUpdateState(),
      ffmpegPath: this.ffmpegPath,
      startupEnabled: isStartupEnabled(),
      currentPort: this.currentPort || DEFAULT_PORT,
      storePath: this.storePath,
      appRoot: APP_ROOT,
      distRoot: DIST_ROOT
    };
  }

  getPublicRoomState(room) {
    const session = this.recordingSessions.get(room.id);
    const activeRecording = session && !session.finished ? this.getCurrentRecordingStateFromSession(session) : null;
    const currentRecording = activeRecording || room.currentRecording;
    const recordingIntent = this.hasRecordingIntent(room);
    return {
      ...room,
      recording: Boolean(room.recording || activeRecording || recordingIntent),
      burning: this.isRoomBurning(room),
      currentRecording: currentRecording ? cloneRecordingState(currentRecording) : undefined,
      stream: room.stream ? { ...room.stream, url: '[hidden]' } : undefined
    };
  }

  getCurrentRecordingStateFromSession(session) {
    return {
      startedAt: session.startedAt,
      cleanPath: session.cleanPath,
      danmakuPath: session.danmakuPath,
      cssPath: session.cssPath,
      assPath: session.assPath,
      burnedPath: session.burnedPath,
      capturePath: session.capturePath,
      containerStage: session.containerStage || 'capturing',
      validReason: session.validReason || '',
      mergeGroup: session.mergeGroup,
      mergeSequence: session.mergeSequence,
      mergeOutputPath: session.mergeOutputPath,
      durationSec: Math.max(0, (Date.now() - session.startedAt) / 1000),
      eventCount: Number(session.eventCount || 0),
      rawDanmakuCount: Number(session.rawDanmakuCount || 0),
      capturedDanmakuCount: Number(session.capturedDanmakuCount ?? session.eventCount ?? 0),
      ignoredDanmakuCount: Number(session.ignoredCommandCount || 0),
      danmakuCommandCounts: { ...(session.danmakuCommandCounts || {}) },
      danmakuStatus: session.danmakuStatus,
      danmakuMessage: session.danmakuMessage,
      danmakuPopularity: Number(session.danmakuPopularity || 0),
      videoInfo: session.videoInfo || null
    };
  }

  shouldUpdateCurrentRecording(room, session) {
    if (!room?.currentRecording || !session) {
      return false;
    }
    const activeSession = this.recordingSessions.get(room.id);
    if (activeSession) {
      return activeSession === session;
    }
    return isCurrentRecordingSession(room, session);
  }

  isRoomRecording(room) {
    return Boolean(room?.recording || (room?.id && (this.recordingSessions.has(room.id) || this.hasRecordingIntent(room))));
  }

  hasActiveRecordingSession(room) {
    return Boolean(room?.recording || (room?.id && (this.recordingSessions.has(room.id) || this.recordingStartLocks.has(room.id))));
  }

  hasRecordingIntent(room) {
    return Boolean(room?.id && (this.recordingStartLocks.has(room.id) || this.reconnectPendingRooms.has(room.id)));
  }

  isRoomBurning(room) {
    return Boolean(room?.burning || (room?.id && this.burnSessions.has(room.id)));
  }

  getPublicUpdateState() {
    return {
      ...this.updateState,
      currentVersion: APP_VERSION,
      activeJobs: this.hasActiveJobs()
    };
  }

  getPublicLoginState() {
    if (!this.loginSession) {
      return undefined;
    }
    return {
      status: this.loginSession.status,
      message: this.loginSession.message,
      qrImageDataUrl: this.loginSession.qrImageDataUrl,
      expiresAt: this.loginSession.expiresAt
    };
  }

  addClient(response) {
    this.clients.add(response);
    this.writeSseState(response);
    response.on('close', () => this.clients.delete(response));
  }

  emitState() {
    for (const response of this.clients) {
      this.writeSseState(response);
    }
  }

  writeSseState(response) {
    try {
      response.write(`data: ${JSON.stringify(this.getState())}\n\n`);
    } catch {
      this.clients.delete(response);
    }
  }

  log(level, message) {
    this.logs.push({
      id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
      time: Date.now(),
      level,
      message
    });
    if (this.logs.length > 400) {
      this.logs.splice(0, this.logs.length - 400);
    }
    this.emitState();
  }

  notify(title, message) {
    const notification = {
      id: ++this.notificationSeq,
      time: Date.now(),
      title: String(title || APP_NAME),
      message: String(message || '')
    };
    this.notifications.push(notification);
    if (this.notifications.length > 80) {
      this.notifications.splice(0, this.notifications.length - 80);
    }
    if (process.env.BILI_RECORD_TRAY !== '1') {
      showWindowsToast(notification.title, notification.message);
    }
  }

  getTrayStateText(afterSeq) {
    const port = this.currentPort || DEFAULT_PORT;
    const rooms = Array.from(this.rooms.values()).map((room) => this.getPublicRoomState(room));
    const monitoringCount = rooms.filter((room) => room.monitoring).length;
    const liveCount = rooms.filter((room) => room.liveStatus === 1).length;
    const recordingCount = rooms.filter((room) => room.recording).length;
    const burningCount = rooms.filter((room) => room.burning).length;
    const statusLabel = recordingCount ? '录制中' : burningCount ? '烧录中' : monitoringCount ? '监听中' : '空闲';
    const tooltip =
      `哔哩录播 2K | ${statusLabel} | ` +
      `监听 ${monitoringCount} / 直播 ${liveCount} / 录制 ${recordingCount} / 烧录 ${burningCount} | ` +
      `端口 ${port}`;

    const notification = this.notifications.find((item) => item.id > afterSeq);
    const seq = notification ? notification.id : this.notificationSeq;
    return [
      `seq=${seq}`,
      `url=${encodeURIComponent(`http://${HOST}:${port}`)}`,
      `tooltip=${encodeURIComponent(tooltip)}`,
      `notify=${notification ? 1 : 0}`,
      `title=${encodeURIComponent(notification?.title || '')}`,
      `message=${encodeURIComponent(notification?.message || '')}`
    ].join('\n');
  }

  async chooseOutputDir() {
    this.log('info', 'WebUI 模式请直接填写输出目录路径。');
    return undefined;
  }

  async openOutputDir() {
    await fsp.mkdir(this.settings.outputDir, { recursive: true });
    openPath(this.settings.outputDir);
    this.log('info', `已打开输出目录：${this.settings.outputDir}`);
    return this.getState();
  }

  async openPathDir(filePath) {
    const targetPath = String(filePath || '').trim();
    if (!targetPath) {
      throw new Error('路径为空。');
    }
    const resolved = path.resolve(targetPath);
    const stat = await fsp.stat(resolved).catch(() => null);
    const dir = stat?.isDirectory() ? resolved : path.dirname(resolved);
    await fsp.mkdir(dir, { recursive: true });
    openPath(dir);
    this.log('info', `已打开所在目录：${dir}`);
    return this.getState();
  }

  async startQrLogin() {
    this.clearLoginTimer();
    try {
      const { json } = await requestBiliJsonWithCookies(
        'https://passport.bilibili.com/x/passport-login/web/qrcode/generate'
      );
      if (json.code !== 0 || !json.data?.url || !json.data?.qrcode_key) {
        throw new Error(json.message || '二维码生成失败');
      }

      const qrImageDataUrl = await QRCode.toDataURL(json.data.url, {
        width: 260,
        margin: 1,
        color: {
          dark: '#10201f',
          light: '#ffffff'
        }
      });

      this.loginSession = {
        qrcodeKey: json.data.qrcode_key,
        qrImageDataUrl,
        status: 'waiting',
        message: '请使用哔哩哔哩 App 扫码',
        expiresAt: Date.now() + 180000,
        timer: null,
        polling: false
      };
      this.loginSession.timer = setInterval(() => {
        this.pollQrLogin().catch((error) => {
          if (!this.loginSession) {
            return;
          }
          this.loginSession.status = 'error';
          this.loginSession.message = error.message;
          this.clearLoginTimer(false);
          this.log('error', `扫码登录失败：${error.message}`);
          this.emitState();
        });
      }, 2200);
      this.log('info', '扫码登录二维码已生成。');
    } catch (error) {
      this.loginSession = {
        status: 'error',
        message: error.message,
        qrImageDataUrl: undefined,
        expiresAt: undefined,
        timer: null,
        polling: false
      };
      this.log('error', `扫码登录启动失败：${error.message}`);
    }
    this.emitState();
    return this.getState();
  }

  async pollQrLogin() {
    const session = this.loginSession;
    if (!session || session.polling || !session.qrcodeKey) {
      return;
    }
    if (session.expiresAt && Date.now() > session.expiresAt) {
      session.status = 'expired';
      session.message = '二维码已过期，请重新生成';
      this.clearLoginTimer(false);
      this.emitState();
      return;
    }

    session.polling = true;
    try {
      const { json, cookies } = await requestBiliJsonWithCookies(
        `https://passport.bilibili.com/x/passport-login/web/qrcode/poll?qrcode_key=${encodeURIComponent(
          session.qrcodeKey
        )}`
      );
      const data = json.data || {};
      const code = Number(data.code);

      if (json.code !== 0) {
        throw new Error(json.message || `登录轮询失败，接口状态码 ${json.code}`);
      }

      if (code === 0) {
        const mergedCookie = mergeCookieString(this.settings.cookie, cookies);
        if (!mergedCookie) {
          throw new Error('登录成功但没有收到登录凭证');
        }
        this.settings.cookie = mergedCookie;
        await this.saveStore();
        session.status = 'success';
        session.message = '登录成功，登录凭证已写入设置';
        this.clearLoginTimer(false);
        this.log('success', 'B 站扫码登录成功。');
        this.emitState();
        setTimeout(() => {
          if (this.loginSession?.status === 'success') {
            this.loginSession = null;
            this.emitState();
          }
        }, 1800);
        return;
      }

      if (code === 86090) {
        session.status = 'scanned';
        session.message = '已扫码，请在手机上确认登录';
      } else if (code === 86101) {
        session.status = 'waiting';
        session.message = '请使用哔哩哔哩 App 扫码';
      } else if (code === 86038) {
        session.status = 'expired';
        session.message = '二维码已过期，请重新生成';
        this.clearLoginTimer(false);
      } else {
        session.status = 'error';
        session.message = data.message || json.message || `未知登录状态，状态码 ${code}`;
        this.clearLoginTimer(false);
      }
      this.emitState();
    } finally {
      if (this.loginSession) {
        this.loginSession.polling = false;
      }
    }
  }

  async cancelQrLogin() {
    this.clearLoginTimer();
    this.loginSession = null;
    this.log('info', '扫码登录已取消。');
    this.emitState();
    return this.getState();
  }

  clearLoginTimer(clearSession = true) {
    if (this.loginSession?.timer) {
      clearInterval(this.loginSession.timer);
      this.loginSession.timer = null;
    }
    if (clearSession) {
      this.loginSession = null;
    }
  }

  async saveSettings(nextSettings) {
    const oldPollInterval = this.settings.pollIntervalSec;
    const oldOutputDir = this.settings.outputDir;
    this.settings = this.normalizeSettings({
      ...this.settings,
      ...nextSettings
    });
    await fsp.mkdir(this.settings.outputDir, { recursive: true });
    if (oldOutputDir !== this.settings.outputDir) {
      await this.refreshRecordingLibrary({ silent: true });
    }
    await this.saveStore();
    if (oldPollInterval !== this.settings.pollIntervalSec) {
      for (const room of this.rooms.values()) {
        if (room.monitoring) {
          this.startMonitorTimer(room.id);
        }
      }
    }
    this.log('success', '设置已保存。');
    this.emitState();
    return this.getState();
  }

  async addRoom(roomId) {
    const id = String(roomId || '').trim();
    if (!/^\d+$/.test(id)) {
      this.log('error', '房间号必须是数字。');
      return this.getState();
    }
    if (this.rooms.has(id)) {
      this.log('warn', `房间 ${id} 已经在列表里。`);
      return this.getState();
    }
    const room = this.normalizeRoom({ id, monitoring: true });
    this.rooms.set(id, room);
    await this.saveStore();
    this.log('info', `已添加房间 ${id}。`);
    this.emitState();
    await this.refreshRoom(id);
    await this.setMonitoring(id, true);
    return this.getState();
  }

  async removeRoom(roomId) {
    const room = this.getRoom(roomId);
    if (this.isRoomRecording(room)) {
      await this.stopRecording(room.id);
    }
    this.stopMonitorTimer(room.id);
    this.rooms.delete(room.id);
    await this.saveStore();
    this.log('info', `已移除房间 ${room.id}。`);
    this.emitState();
    return this.getState();
  }

  async refreshRoom(roomId, options = {}) {
    const room = this.getRoom(roomId);
    const silent = Boolean(options.silent);
    try {
      const previousLiveStatus = room.liveStatus;
      const info = await this.fetchRoomInfo(room.id);
      Object.assign(room, info, {
        lastCheckedAt: Date.now(),
        lastError: undefined
      });
      await this.saveStore();
      if (previousLiveStatus !== undefined && previousLiveStatus !== room.liveStatus) {
        this.log(
          room.liveStatus === 1 ? 'success' : 'info',
          `${roomLabel(room)}：${room.liveStatus === 1 ? '开播' : '下播'}`
        );
        if (room.liveStatus === 1 && this.settings.notifyLiveStarted) {
          this.notify('开播提醒', `${roomLabel(room)} 已开播`);
        }
        if (previousLiveStatus === 1 && room.liveStatus !== 1 && this.settings.notifyLiveEnded) {
          this.notify('下播提醒', `${roomLabel(room)} 已下播`);
        }
      } else if (!silent) {
        this.log(
          info.liveStatus === 1 ? 'success' : 'info',
          `${roomLabel(room)}：${info.liveStatus === 1 ? '正在直播' : '未开播'}`
        );
      }
    } catch (error) {
      room.lastCheckedAt = Date.now();
      room.lastError = error.message;
      if (!silent) {
        this.log('error', `${roomLabel(room)} 刷新失败：${error.message}`);
      }
    }
    this.emitState();
    return this.getState();
  }

  async setMonitoring(roomId, enabled) {
    const room = this.getRoom(roomId);
    room.monitoring = Boolean(enabled);
    if (room.monitoring) {
      this.startMonitorTimer(room.id);
      this.log('info', `${roomLabel(room)} 已开始监听。`);
      this.tickRoom(room.id);
    } else {
      this.stopMonitorTimer(room.id);
      this.log('info', `${roomLabel(room)} 已停止监听。`);
    }
    await this.saveStore();
    this.emitState();
    return this.getState();
  }

  startMonitorTimer(roomId) {
    this.stopMonitorTimer(roomId);
    const timer = setInterval(() => {
      this.tickRoom(roomId);
    }, this.settings.pollIntervalSec * 1000);
    this.monitorTimers.set(roomId, timer);
  }

  stopMonitorTimer(roomId) {
    const timer = this.monitorTimers.get(roomId);
    if (timer) {
      clearInterval(timer);
      this.monitorTimers.delete(roomId);
    }
  }

  async tickRoom(roomId) {
    const room = this.rooms.get(roomId);
    if (!room || !room.monitoring) {
      return;
    }
    try {
      await this.refreshRoom(room.id);
      if (room.liveStatus === 1 && !this.isRoomRecording(room)) {
        await this.startRecording(room.id, true);
      }
    } catch (error) {
      this.log('error', `${roomLabel(room)} 监听异常：${error.message}`);
    }
  }

  async fetchRoomInfo(roomId) {
    const roomInit = await this.fetchBiliJson(
      `https://api.live.bilibili.com/room/v1/Room/room_init?id=${encodeURIComponent(roomId)}`
    );
    if (roomInit.code !== 0) {
      throw createBiliError('房间初始化', roomInit);
    }

    const realRoomId = Number(roomInit.data.room_id);
    const roomInfo = await this.fetchBiliJson(
      `https://api.live.bilibili.com/room/v1/Room/get_info?room_id=${realRoomId}`
    );
    if (roomInfo.code !== 0) {
      throw createBiliError('房间信息', roomInfo);
    }

    let detailInfo = null;
    try {
      const detail = await this.fetchBiliJson(
        `https://api.live.bilibili.com/xlive/web-room/v1/index/getInfoByRoom?room_id=${realRoomId}`
      );
      if (detail.code === 0) {
        detailInfo = detail.data || null;
      }
    } catch {
      detailInfo = null;
    }

    let masterInfo = null;
    const uid = Number(roomInfo.data?.uid || roomInit.data?.uid || 0);
    if (uid) {
      try {
        const master = await this.fetchBiliJson(
          `https://api.live.bilibili.com/live_user/v1/Master/info?uid=${uid}`
        );
        if (master.code === 0) {
          masterInfo = master.data?.info || null;
        }
      } catch (error) {
        this.log('warn', `主播信息接口失败，继续使用房间信息：${error.message}`);
      }
    }

    const detailRoom = detailInfo?.room_info || {};
    const detailAnchor = detailInfo?.anchor_info?.base_info || {};
    return {
      realRoomId,
      shortId: Number(roomInit.data.short_id || 0),
      liveStatus: Number(detailRoom.live_status ?? roomInfo.data?.live_status ?? roomInit.data.live_status ?? 0),
      title: detailRoom.title || roomInfo.data?.title || roomInit.data.title || `直播间 ${realRoomId}`,
      anchor: detailAnchor.uname || masterInfo?.uname || roomInfo.data?.description || '',
      cover:
        detailRoom.cover ||
        detailRoom.user_cover ||
        roomInfo.data?.user_cover ||
        roomInfo.data?.cover ||
        roomInfo.data?.background ||
        '',
      keyframe:
        detailRoom.keyframe ||
        roomInfo.data?.keyframe ||
        detailRoom.cover ||
        roomInfo.data?.user_cover ||
        roomInfo.data?.cover ||
        ''
    };
  }

  async proxyImage(rawUrl, response) {
    let target;
    try {
      target = new URL(String(rawUrl || ''));
    } catch {
      writeJson(response, 400, { error: '图片地址无效' });
      return;
    }
    if (!['http:', 'https:'].includes(target.protocol)) {
      writeJson(response, 400, { error: '图片地址协议无效' });
      return;
    }

    const assetResponse = await fetch(target.toString(), {
      headers: createImageProxyHeaders(target, this.settings.cookie)
    });
    if (!assetResponse.ok) {
      writeJson(response, 502, { error: `图片获取失败：HTTP ${assetResponse.status}` });
      return;
    }
    const contentType = assetResponse.headers.get('content-type') || 'image/jpeg';
    if (!contentType.toLowerCase().startsWith('image/')) {
      writeJson(response, 502, { error: '远端返回的不是图片' });
      return;
    }
    const contentLength = Number(assetResponse.headers.get('content-length') || 0);
    if (contentLength > MAX_PROXY_IMAGE_BYTES) {
      writeJson(response, 502, { error: '远端图片过大' });
      return;
    }
    const body = Buffer.from(await assetResponse.arrayBuffer());
    if (body.length > MAX_PROXY_IMAGE_BYTES) {
      writeJson(response, 502, { error: '远端图片过大' });
      return;
    }
    response.writeHead(200, {
      'Content-Type': contentType,
      'Content-Length': String(body.length),
      'Cache-Control': 'no-store'
    });
    response.end(body);
  }

  async startPreview(roomId) {
    const room = this.getRoom(roomId);
    if (!room.realRoomId || room.liveStatus !== 1) {
      Object.assign(room, await this.fetchRoomInfo(room.id));
    }
    if (room.liveStatus !== 1) {
      throw new Error(`${roomLabel(room)} 当前未开播，无法打开实时预览。`);
    }
    const stream = await this.resolvePlayStream(room);
    const token = crypto.randomBytes(18).toString('base64url');
    const expiresAt = Date.now() + PREVIEW_SESSION_TTL_MS;
    this.previewSessions.set(token, {
      roomId: room.id,
      streamUrl: stream.url,
      expiresAt
    });
    this.prunePreviewSessions();
    this.log('info', `${roomLabel(room)} 已打开实时预览。`);
    return {
      previewUrl: createPreviewProxyPath(token, stream.url),
      expiresAt,
      stream: { ...stream, url: '[hidden]' }
    };
  }

  async servePreview(parsed, request, response) {
    const match = /^\/api\/preview\/([^/]+)\/([^/?#]+)/.exec(parsed.pathname);
    if (!match) {
      writeJson(response, 404, { error: '预览地址无效' });
      return;
    }
    const [, token, encodedUrl] = match;
    const session = this.previewSessions.get(token);
    if (!session || session.expiresAt < Date.now()) {
      this.previewSessions.delete(token);
      writeJson(response, 404, { error: '实时预览已过期，请重新打开。' });
      return;
    }

    let target;
    try {
      target = new URL(decodePreviewUrl(encodedUrl));
    } catch {
      writeJson(response, 400, { error: '预览资源地址无效' });
      return;
    }
    if (!['http:', 'https:'].includes(target.protocol)) {
      writeJson(response, 400, { error: '预览资源协议无效' });
      return;
    }

    session.expiresAt = Date.now() + PREVIEW_SESSION_TTL_MS;
    try {
      const body = await requestUrlBuffer(target.toString(), {
        headers: createPreviewProxyHeaders(target, this.settings.cookie, request.headers.range),
        retries: 2,
        timeoutMs: 20000
      });
      if (isPreviewPlaylist(target, body)) {
        if (body.length > MAX_PREVIEW_PLAYLIST_BYTES) {
          writeJson(response, 502, { error: '远端预览清单过大' });
          return;
        }
        const playlist = rewriteHlsManifest(body.toString('utf8'), target, token);
        writeText(response, 200, playlist, 'application/vnd.apple.mpegurl; charset=utf-8');
        return;
      }
      response.writeHead(200, {
        'Content-Type': previewMimeType(target.pathname),
        'Content-Length': String(body.length),
        'Cache-Control': 'no-store'
      });
      response.end(body);
    } catch (error) {
      writeJson(response, 502, { error: `实时预览获取失败：${error.message}` });
    }
  }

  prunePreviewSessions() {
    const now = Date.now();
    for (const [token, session] of this.previewSessions) {
      if (session.expiresAt < now) {
        this.previewSessions.delete(token);
      }
    }
  }

  async serveMedia(rawPath, request, response) {
    const filePath = path.resolve(String(rawPath || ''));
    if (!this.isKnownMediaPath(filePath)) {
      writeJson(response, 403, { error: '视频路径不在录像库或输出目录内' });
      return;
    }
    let stat;
    try {
      stat = await fsp.stat(filePath);
    } catch {
      writeJson(response, 404, { error: '视频文件不存在' });
      return;
    }
    if (!stat.isFile()) {
      writeJson(response, 400, { error: '路径不是视频文件' });
      return;
    }

    const total = stat.size;
    const range = request.headers.range;
    const headers = {
      'Content-Type': mimeType(filePath),
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'no-store'
    };
    if (!range) {
      response.writeHead(200, { ...headers, 'Content-Length': String(total) });
      fs.createReadStream(filePath).pipe(response);
      return;
    }

    const match = /^bytes=(\d*)-(\d*)$/i.exec(range);
    if (!match) {
      response.writeHead(416, { 'Content-Range': `bytes */${total}` });
      response.end();
      return;
    }
    const start = match[1] ? Number(match[1]) : 0;
    const end = match[2] ? Math.min(Number(match[2]), total - 1) : total - 1;
    if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= total) {
      response.writeHead(416, { 'Content-Range': `bytes */${total}` });
      response.end();
      return;
    }
    response.writeHead(206, {
      ...headers,
      'Content-Length': String(end - start + 1),
      'Content-Range': `bytes ${start}-${end}/${total}`
    });
    fs.createReadStream(filePath, { start, end }).pipe(response);
  }

  isKnownMediaPath(filePath) {
    const normalized = path.resolve(filePath).toLowerCase();
    const outputRoot = path.resolve(this.settings.outputDir).toLowerCase();
    if (normalized === outputRoot || normalized.startsWith(`${outputRoot}${path.sep}`)) {
      return true;
    }
    return this.recordings.some((recording) => path.resolve(recording.cleanPath).toLowerCase() === normalized);
  }

  async fetchDanmuInfo(roomId) {
    const query = await this.createWbiQuery({ id: Number(roomId), type: 0 });
    return this.fetchBiliJson(`https://api.live.bilibili.com/xlive/web-room/v1/index/getDanmuInfo?${query}`);
  }

  async createWbiQuery(params) {
    const mixinKey = await this.getWbiMixinKey();
    const signedParams = {
      ...params,
      wts: Math.floor(Date.now() / 1000)
    };
    const query = Object.keys(signedParams)
      .sort()
      .map((key) => {
        const value = String(signedParams[key] ?? '').replace(/[!'()*]/g, '');
        return `${encodeURIComponent(key)}=${encodeURIComponent(value)}`;
      })
      .join('&');
    const wRid = crypto.createHash('md5').update(`${query}${mixinKey}`).digest('hex');
    return `${query}&w_rid=${wRid}`;
  }

  async getWbiMixinKey() {
    if (this.wbiCache && this.wbiCache.expiresAt > Date.now()) {
      return this.wbiCache.mixinKey;
    }
    const nav = await this.fetchBiliJson('https://api.bilibili.com/x/web-interface/nav');
    const imgKey = basenameWithoutExt(nav.data?.wbi_img?.img_url);
    const subKey = basenameWithoutExt(nav.data?.wbi_img?.sub_url);
    if (!imgKey || !subKey) {
      throw new Error('获取 WBI 签名密钥失败。');
    }
    const rawKey = `${imgKey}${subKey}`;
    const mixinKey = WBI_MIXIN_KEY_TABLE.map((index) => rawKey[index] || '').join('').slice(0, 32);
    this.wbiCache = {
      mixinKey,
      expiresAt: Date.now() + 12 * 60 * 60 * 1000
    };
    return mixinKey;
  }

  async fetchBiliJson(url) {
    const response = await fetch(url, {
      headers: {
        Accept: 'application/json, text/plain, */*',
        Referer: 'https://live.bilibili.com/',
        'User-Agent': USER_AGENT,
        Cookie: sanitizeHeaderValue(this.settings.cookie)
      }
    });
    const text = await response.text();
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${text.slice(0, 120)}`);
    }
    try {
      return JSON.parse(text);
    } catch {
      throw new Error(`接口返回不是 JSON：${text.slice(0, 120)}`);
    }
  }

  async resolvePlayStream(room) {
    if (!room.realRoomId) {
      Object.assign(room, await this.fetchRoomInfo(room.id));
    }
    room.qualityWarning = undefined;

    const qnProbes = createQnProbeList(this.settings.targetQn);
    const candidates = [];
    const seenUrls = new Set();
    let lastPlayError = null;
    for (const requestedQn of qnProbes) {
      const params = new URLSearchParams({
        room_id: String(room.realRoomId),
        protocol: '0,1',
        format: '0,1,2',
        codec: '0,1',
        qn: String(requestedQn),
        platform: 'web',
        ptype: '8',
        dolby: '5',
        panorama: '1'
      });
      const playInfo = await this.fetchBiliJson(
        `https://api.live.bilibili.com/xlive/web-room/v2/index/getRoomPlayInfo?${params.toString()}`
      );
      if (playInfo.code !== 0) {
        lastPlayError = createBiliError(`直播流(qn ${requestedQn})`, playInfo);
        if ([-352, -101].includes(Number(playInfo.code))) {
          throw lastPlayError;
        }
        continue;
      }

      const streams = playInfo.data?.playurl_info?.playurl?.stream || [];
      for (const stream of streams) {
        for (const format of stream.format || []) {
          for (const codec of format.codec || []) {
            const baseUrl = codec.base_url || codec.baseUrl || '';
            for (const urlInfo of codec.url_info || []) {
              const host = urlInfo.host || '';
              const extra = urlInfo.extra || '';
              if (!host || !baseUrl) {
                continue;
              }
              const url = `${host}${baseUrl}${extra}`;
              if (seenUrls.has(url)) {
                continue;
              }
              seenUrls.add(url);
              candidates.push({
                url,
                codec: String(codec.codec_name || codec.codec || 'unknown').toLowerCase(),
                qn: Number(codec.current_qn || codec.qn || 0),
                requestedQn,
                acceptQn: Array.isArray(codec.accept_qn) ? codec.accept_qn.map(Number).filter(Boolean) : [],
                protocol: String(stream.protocol_name || 'unknown'),
                format: String(format.format_name || 'unknown'),
                host
              });
            }
          }
        }
      }
    }

    if (candidates.length === 0) {
      if (lastPlayError) {
        throw lastPlayError;
      }
      throw new Error('没有拿到可用直播流，可能未登录、未开播或清晰度受限。');
    }

    candidates.sort((a, b) => streamScore(b, this.settings) - streamScore(a, this.settings));
    room.stream = candidates[0];
    const availableQn = Array.from(
      new Set(candidates.flatMap((candidate) => [candidate.qn, ...(candidate.acceptQn || [])]).filter(Boolean))
    ).sort((a, b) => b - a);
    if (Number(this.settings.targetQn || 0) >= 10000 && Number(room.stream.qn || 0) < Number(this.settings.targetQn)) {
      room.qualityWarning = `请求 ${this.settings.targetQn}，接口实际选中 ${room.stream.qn}，可选 ${availableQn.join('/') || '未知'}。如果直播间确认有 2K/4K，请先扫码登录或刷新 Cookie。`;
      this.log(
        'warn',
        `${roomLabel(room)} 未拿到请求的高画质清晰度 ${this.settings.targetQn}，实际选中 ${room.stream.qn}，接口可选 ${availableQn.join('/') || '未知'}。如果直播间确认有 2K/4K，请先到设置页扫码登录，或重新扫码刷新 Cookie 后再试。`
      );
    }
    this.log(
      'success',
      `${roomLabel(room)} 选中直播流：编码 ${displayCodecName(room.stream.codec)}，清晰度码 ${room.stream.qn}，请求 ${qnProbes.join('/')}, 协议 ${room.stream.protocol}/${room.stream.format}，接口可选 ${availableQn.join('/') || '未知'}`
    );
    return room.stream;
  }

  async startRecording(roomId, autoStart = false, options = {}) {
    const room = this.getRoom(roomId);
    if (this.hasActiveRecordingSession(room) || (this.reconnectPendingRooms.has(room.id) && !options.streamReconnect)) {
      return this.getState();
    }
    this.recordingStartLocks.add(room.id);
    this.emitState();

    try {
      if (!room.realRoomId || room.liveStatus !== 1) {
        Object.assign(room, await this.fetchRoomInfo(room.id));
      }
      if (room.liveStatus !== 1) {
        this.log('warn', `${roomLabel(room)} 当前未开播，未开始录制。`);
        this.emitState();
        return this.getState();
      }

      const inheritedStream = options.stream?.url ? { ...options.stream } : null;
      const stream = inheritedStream || (await this.resolvePlayStream(room));
      if (inheritedStream) {
        room.stream = inheritedStream;
        this.log(
          'info',
          `${roomLabel(room)} 分段继续沿用上一段直播流：编码 ${displayCodecName(stream.codec)}，清晰度码 ${stream.qn}`
        );
      }
      await fsp.mkdir(this.settings.outputDir, { recursive: true });

      const timestamp = formatTimestamp(new Date());
      const baseName = sanitizeFilename(
        `${room.realRoomId || room.id}_${room.anchor || 'anchor'}_${room.title || 'live'}_${timestamp}`
      );
      const container = normalizeContainer(this.settings.outputContainer);
      const cleanPath = path.join(this.settings.outputDir, `${baseName}.clean.${container}`);
      const capturePath = container === 'mp4' ? path.join(this.settings.outputDir, `${baseName}.recording.mkv`) : cleanPath;
      const danmakuPath = path.join(this.settings.outputDir, `${baseName}.danmaku.jsonl`);
      const cssPath = path.join(this.settings.outputDir, `${baseName}.danmaku.css`);
      const assPath = path.join(this.settings.outputDir, `${baseName}.danmaku.ass`);
      const burnedPath = path.join(this.settings.outputDir, `${baseName}.danmaku.${container}`);
      const mergeGroup = String(options.mergeGroup || baseName);
      const mergeSequence = Number(options.mergeSequence || 0);
      const mergeOutputPath =
        options.mergeOutputPath || path.join(this.settings.outputDir, `${sanitizeFilename(mergeGroup)}.merged.${container}`);

      const segmentMinutes = Number(this.settings.segmentMinutes || 0);
      const segmentDurationSec = Number.isFinite(segmentMinutes) && segmentMinutes > 0 ? segmentMinutes * 60 : 0;
      const args = createRecordingArgs({
        streamUrl: stream.url,
        headers: this.createFfmpegHeaders(room),
        outputPath: capturePath,
        maxDurationSec: segmentDurationSec
      });

      const ffmpeg = spawn(this.ffmpegPath, args, {
        windowsHide: true,
        stdio: ['pipe', 'ignore', 'pipe']
      });

      const eventStream = fs.createWriteStream(danmakuPath, { flags: 'a' });
      const session = {
        roomId: room.id,
        ffmpeg,
        stream,
        eventStream,
        danmakuClient: null,
        startedAt: Date.now(),
        outputContainer: container,
        cleanPath,
        capturePath,
        danmakuPath,
        cssPath,
        assPath,
        burnedPath,
        containerStage: 'capturing',
        validReason: '',
        mergeGroup,
        mergeSequence,
        mergeOutputPath,
        eventCount: 0,
        rawDanmakuCount: 0,
        capturedDanmakuCount: 0,
        danmakuCommandCounts: {},
        lastEventEmitAt: 0,
        danmakuStatus: 'connecting',
        danmakuMessage: '弹幕通道连接中',
        danmakuPopularity: 0,
        ignoredCommandCount: 0,
        lastIgnoredEmitAt: 0,
        ffmpegProbeBuffer: '',
        ffmpegLogBuffer: '',
        videoInfo: null,
        rotateTimer: null,
        mediaWatchTimer: null,
        rotating: false,
        segmentMinutes,
        segmentDurationSec,
        finished: false,
        stopping: false
      };

      room.recording = true;
      room.currentRecording = {
        startedAt: session.startedAt,
        cleanPath,
        danmakuPath,
        cssPath,
        assPath,
        burnedPath,
        capturePath,
        containerStage: 'capturing',
        validReason: '',
        mergeGroup,
        mergeSequence,
        mergeOutputPath,
        eventCount: 0,
        rawDanmakuCount: 0,
        capturedDanmakuCount: 0,
        danmakuStatus: 'connecting',
        danmakuMessage: '弹幕通道连接中',
        danmakuPopularity: 0,
        ignoredDanmakuCount: 0,
        danmakuCommandCounts: {},
        videoInfo: null
      };
      this.recordingSessions.set(room.id, session);
      this.reconnectPendingRooms.delete(room.id);
      this.armRecordingRotation(room, session);
      this.armNoMediaWatch(room, session);
      const startReason = options.streamReconnect
        ? '直播流续录'
        : options.segmentContinue
          ? '分段继续'
          : autoStart
            ? '开播自动'
            : '手动';
      this.log(
        'success',
        `${roomLabel(room)} ${startReason}开始录制：${path.basename(cleanPath)}${
          capturePath !== cleanPath ? `（临时写入 ${path.basename(capturePath)}）` : ''
        }`
      );
      this.log('info', `${roomLabel(room)} 录制临时路径：${capturePath}`);
      if (this.settings.notifyRecordingStarted && !options.silentNotify) {
        this.notify('开始录制', `${roomLabel(room)} 正在写入 ${path.basename(cleanPath)}`);
      }

      ffmpeg.stderr.on('data', (chunk) => {
        const text = chunk.toString('utf8');
        session.ffmpegLogBuffer = `${session.ffmpegLogBuffer}${text}`.slice(-12000);
        if (!session.videoInfo) {
          session.ffmpegProbeBuffer = `${session.ffmpegProbeBuffer}${text}`.slice(-6000);
          const videoInfo = parseFfmpegVideoInfo(session.ffmpegProbeBuffer);
          if (videoInfo) {
            session.videoInfo = videoInfo;
            if (this.shouldUpdateCurrentRecording(room, session)) {
              room.currentRecording.videoInfo = videoInfo;
            }
            const actualQualityWarning = buildActualQualityWarning(this.settings, room.stream, videoInfo);
            if (actualQualityWarning) {
              room.qualityWarning = room.qualityWarning
                ? `${room.qualityWarning} 实际写入 ${videoInfo.width}x${videoInfo.height}。`
                : actualQualityWarning;
            }
            this.log(
              'success',
              `${roomLabel(room)} 实际写入视频：${videoInfo.width}x${videoInfo.height}${
                videoInfo.fps ? ` @ ${videoInfo.fps}fps` : ''
              }`
            );
            this.emitState();
          }
        }
        if (/(error|failed|invalid|HTTP\s+(?:403|404)|server returned\s+(?:403|404))/i.test(text)) {
          this.log('warn', `${roomLabel(room)} 录制进程：${compactLogLine(text)}`);
        }
      });

      ffmpeg.on('error', (error) => {
        this.log('error', `${roomLabel(room)} 录制进程启动失败：${error.message}`);
      });

      ffmpeg.on('close', async (code, signal) => {
        const captureSize = await getFileSize(session.capturePath || session.cleanPath);
        if (captureSize <= 0) {
          const detail = compactLogLine(session.ffmpegLogBuffer || '没有 stderr 输出');
          this.log(
            'error',
            `${roomLabel(room)} 录制进程没有生成临时视频文件，退出码 ${code}，信号 ${signal || '-'}。ffmpeg：${detail}`
          );
        }
        await this.finishRecording(room.id, session, code, signal);
      });

      this.startDanmakuCapture(room, session).catch((error) => {
        if (session.finished || this.recordingSessions.get(room.id) !== session) {
          return;
        }
        session.danmakuStatus = 'error';
        session.danmakuMessage = `弹幕连接失败：${error.message}`;
        if (this.shouldUpdateCurrentRecording(room, session)) {
          room.currentRecording.danmakuStatus = session.danmakuStatus;
          room.currentRecording.danmakuMessage = session.danmakuMessage;
        }
        this.log('warn', `${roomLabel(room)} 弹幕连接失败：${error.message}`);
        this.emitState();
      });

      this.emitState();
    } catch (error) {
      room.lastError = error.message;
      room.recording = false;
      this.reconnectPendingRooms.delete(room.id);
      this.log('error', `${roomLabel(room)} 开始录制失败：${error.message}`);
      this.emitState();
    } finally {
      this.recordingStartLocks.delete(room.id);
      if (!this.recordingSessions.has(room.id)) {
        this.reconnectPendingRooms.delete(room.id);
      }
      this.emitState();
    }
    return this.getState();
  }

  async startDanmakuCapture(room, session) {
    const info = await this.fetchDanmuInfo(room.realRoomId);
    if (info.code !== 0) {
      throw createBiliError('弹幕服务器', info);
    }
    if (session.finished || this.recordingSessions.get(room.id) !== session) {
      return;
    }
    const client = new DanmakuClient({
      roomId: room.realRoomId,
      uid: Number(getCookieValue(this.settings.cookie, 'DedeUserID') || 0),
      buvid: getCookieValue(this.settings.cookie, 'buvid3') || getCookieValue(this.settings.cookie, 'buvid4') || '',
      token: info.data?.token || '',
      hosts: info.data?.host_list || [],
      onOpen: () => {
        if (!session.finished) {
          this.updateDanmakuStatus(room, session, 'connecting', '弹幕通道已连接，正在认证');
        }
      },
      onAuthReply: (reply) => {
        if (session.finished) {
          return;
        }
        if (Number(reply?.code || 0) === 0) {
          this.updateDanmakuStatus(room, session, 'connected', '弹幕通道已认证，等待事件');
          return;
        }
        this.updateDanmakuStatus(room, session, 'error', `弹幕认证失败：${reply?.message || reply?.code || '未知错误'}`, 'warn');
      },
      onHeartbeat: (popularity) => {
        if (session.finished) {
          return;
        }
        session.danmakuPopularity = popularity;
        if (this.shouldUpdateCurrentRecording(room, session)) {
          room.currentRecording.danmakuPopularity = popularity;
        }
        this.emitState();
      },
      onClose: (reason) => {
        if (!session.finished) {
          this.updateDanmakuStatus(room, session, 'disconnected', `弹幕通道已断开：${reason}`, 'warn');
        }
      },
      onError: (error) => {
        if (!session.finished) {
          this.updateDanmakuStatus(room, session, 'error', `弹幕通道错误：${error.message}`, 'warn');
        }
      },
      onCommand: (command) => {
        if (session.finished || this.recordingSessions.get(room.id) !== session) {
          return;
        }
        const commandType = danmakuCommandType(command);
        session.rawDanmakuCount = (session.rawDanmakuCount || 0) + 1;
        session.danmakuCommandCounts[commandType] = (session.danmakuCommandCounts[commandType] || 0) + 1;
        if (this.shouldUpdateCurrentRecording(room, session)) {
          room.currentRecording.rawDanmakuCount = session.rawDanmakuCount;
          room.currentRecording.danmakuCommandCounts = { ...session.danmakuCommandCounts };
        }
        const event = normalizeDanmakuEvent(command, session.startedAt);
        if (!event) {
          session.ignoredCommandCount = (session.ignoredCommandCount || 0) + 1;
          if (this.shouldUpdateCurrentRecording(room, session)) {
            room.currentRecording.ignoredDanmakuCount = session.ignoredCommandCount;
          }
          const now = Date.now();
          if (session.ignoredCommandCount === 1 || now - session.lastIgnoredEmitAt > 5000) {
            session.lastIgnoredEmitAt = now;
            session.danmakuStatus = 'connected';
            session.danmakuMessage = `弹幕通道正常，收到互动包 ${session.rawDanmakuCount} 条，可烧录 ${session.eventCount} 条`;
            if (this.shouldUpdateCurrentRecording(room, session)) {
              room.currentRecording.danmakuStatus = session.danmakuStatus;
              room.currentRecording.danmakuMessage = session.danmakuMessage;
            }
            if (session.ignoredCommandCount === 1) {
              this.log('info', `${roomLabel(room)} ${session.danmakuMessage}`);
            }
            this.emitState();
          }
          return;
        }
        session.eventCount += 1;
        session.capturedDanmakuCount = session.eventCount;
        if (this.shouldUpdateCurrentRecording(room, session)) {
          room.currentRecording.eventCount = session.eventCount;
          room.currentRecording.capturedDanmakuCount = session.capturedDanmakuCount;
          room.currentRecording.danmakuStatus = 'connected';
          room.currentRecording.danmakuMessage = `已捕获 ${session.eventCount} 条可烧录事件`;
        }
        session.eventStream.write(`${JSON.stringify(event)}\n`);
        const now = Date.now();
        if (session.eventCount === 1 || now - session.lastEventEmitAt > 2000) {
          session.lastEventEmitAt = now;
          this.emitState();
        }
      }
    });
    session.danmakuClient = client;
    client.connect();
  }

  updateDanmakuStatus(room, session, status, message, level = 'info') {
    session.danmakuStatus = status;
    session.danmakuMessage = message;
    if (this.shouldUpdateCurrentRecording(room, session)) {
      room.currentRecording.danmakuStatus = status;
      room.currentRecording.danmakuMessage = message;
    }
    this.log(level, `${roomLabel(room)} ${message}`);
    this.emitState();
  }

  armRecordingRotation(room, session) {
    const minutes = Number(session.segmentMinutes || this.settings.segmentMinutes || 60);
    if (!Number.isFinite(minutes) || minutes <= 0) {
      return;
    }
    session.rotateTimer = setTimeout(() => {
      this.rotateRecordingSegment(room.id).catch((error) => {
        this.log('error', `${roomLabel(room)} 分段切换失败：${error.message}`);
      });
    }, minutes * 60 * 1000 + SEGMENT_ROTATION_GRACE_MS);
    session.rotateTimer.unref?.();
  }

  armNoMediaWatch(room, session) {
    session.mediaWatchTimer = setTimeout(async () => {
      if (session.finished || session.stopping || this.recordingSessions.get(room.id) !== session) {
        return;
      }
      if (session.videoInfo) {
        return;
      }
      const fileSize = await getFileSize(session.capturePath || session.cleanPath);
      if (fileSize >= MIN_PLAYABLE_BYTES) {
        this.log(
          'warn',
          `${roomLabel(room)} 录制已写入 ${formatBytes(fileSize)}，但还没解析到视频信息；继续观察。`
        );
        return;
      }
      session.noMediaDetected = true;
      this.log(
        'error',
        `${roomLabel(room)} 录制 ${Math.round(NO_MEDIA_TIMEOUT_MS / 1000)} 秒仍未写入有效视频数据，正在重连直播流。`
      );
      requestFfmpegStop(session.ffmpeg, { graceful: false, timeoutMs: 1500 });
    }, NO_MEDIA_TIMEOUT_MS);
    session.mediaWatchTimer.unref?.();
  }

  async rotateRecordingSegment(roomId) {
    const room = this.getRoom(roomId);
    const session = this.recordingSessions.get(room.id);
    if (!session || session.stopping || session.rotating) {
      return this.getState();
    }
    session.rotating = true;
    this.log('info', `${roomLabel(room)} 已达到 ${session.segmentMinutes} 分钟分段时长，正在切换到新文件。`);
    requestFfmpegStop(session.ffmpeg, { graceful: true, timeoutMs: 5000 });
    this.emitState();
    return this.getState();
  }

  async stopRecording(roomId) {
    const room = this.getRoom(roomId);
    const session = this.recordingSessions.get(room.id);
    if (!session) {
      return this.getState();
    }
    session.stopping = true;
    clearTimeout(session.rotateTimer);
    session.danmakuClient?.close('手动停止');
    requestFfmpegStop(session.ffmpeg, { graceful: true, timeoutMs: 5000 });
    this.log('info', `${roomLabel(room)} 正在停止录制。`);
    this.emitState();
    return this.getState();
  }

  async finishRecording(roomId, session, code, signal) {
    const room = this.rooms.get(roomId);
    if (!room || !session || session.finished) {
      return;
    }
    const wasActiveSession = this.recordingSessions.get(roomId) === session;

    clearTimeout(session.rotateTimer);
    clearTimeout(session.mediaWatchTimer);
    session.finished = true;
    session.danmakuClient?.close('录制结束');
    await new Promise((resolve) => session.eventStream.end(resolve));
    if (wasActiveSession) {
      room.recording = false;
    }
    const elapsedSec = Math.max(0, (Date.now() - session.startedAt) / 1000);
    const shouldContinueSegment =
      wasActiveSession && (session.rotating || hasReachedSegmentLimit(session, elapsedSec)) && !session.stopping;
    if (shouldContinueSegment) {
      this.recordingSessions.delete(roomId);
      await this.startNextSegmentNow(room, session);
    }
    const capturePath = session.capturePath || session.cleanPath;
    const fileSizeBeforeFinalize = await getFileSize(capturePath);
    const validBeforeFinalize = isRecordingFileLikelyPlayable({
      fileSize: fileSizeBeforeFinalize,
      elapsedSec,
      videoInfo: session.videoInfo
    });
    if (!validBeforeFinalize) {
      session.containerStage = 'failed';
      session.validReason = `临时文件过小或没有解析到视频流：${formatBytes(fileSizeBeforeFinalize)}`;
      if (this.shouldUpdateCurrentRecording(room, session)) {
        room.currentRecording.containerStage = session.containerStage;
        room.currentRecording.validReason = session.validReason;
      }
    }
    let finalized = normalizeContainer(session.outputContainer) !== 'mp4';
    if (finalized && validBeforeFinalize) {
      session.containerStage = 'ready';
    }
    if (validBeforeFinalize) {
      finalized = await this.finalizeRecordingContainer(room, session);
    }
    const fileSize = await getFileSize(session.cleanPath);
    const valid = isRecordingFileLikelyPlayable({
      fileSize,
      elapsedSec,
      videoInfo: session.videoInfo
    }) && finalized;
    if (!valid && !session.validReason) {
      session.containerStage = 'failed';
      session.validReason = finalized
        ? `最终文件过小或没有视频流：${formatBytes(fileSize)}`
        : '最终 MP4 封装失败，已保留临时文件。';
    }
    const finishedRecording = {
      startedAt: session.startedAt,
      cleanPath: session.cleanPath,
      danmakuPath: session.danmakuPath,
      cssPath: session.cssPath,
      assPath: session.assPath,
      burnedPath: session.burnedPath,
      capturePath: session.capturePath,
      containerStage: valid ? 'ready' : session.containerStage || 'failed',
      validReason: valid ? '' : session.validReason,
      mergeGroup: session.mergeGroup,
      mergeSequence: session.mergeSequence,
      mergeOutputPath: session.mergeOutputPath,
      durationSec: elapsedSec,
      fileSize,
      valid,
      eventCount: session.eventCount,
      rawDanmakuCount: session.rawDanmakuCount,
      capturedDanmakuCount: session.capturedDanmakuCount || session.eventCount,
      danmakuStatus: session.danmakuStatus,
      danmakuMessage: session.danmakuMessage,
      danmakuPopularity: session.danmakuPopularity,
      ignoredDanmakuCount: session.ignoredCommandCount,
      danmakuCommandCounts: session.danmakuCommandCounts,
      videoInfo: session.videoInfo
    };
    if (this.shouldUpdateCurrentRecording(room, session)) {
      Object.assign(room.currentRecording, finishedRecording);
    }
    if (valid) {
      this.rememberRecording(room, finishedRecording);
      await this.saveStore();
    } else {
      this.log(
        'error',
        `${roomLabel(room)} 当前录像文件过小或没有视频流，已跳过历史列表：${path.basename(
          session.cleanPath
        )}（最终 ${formatBytes(fileSize)}，临时 ${formatBytes(fileSizeBeforeFinalize)}）。${
          capturePath !== session.cleanPath && fs.existsSync(capturePath) ? `可检查临时文件：${capturePath}` : ''
        }${session.validReason ? `原因：${session.validReason}` : ''}`
      );
    }
    const unexpectedStreamEnd = wasActiveSession && !session.stopping && !shouldContinueSegment;
    const shouldReconnectLiveStream = unexpectedStreamEnd && room.monitoring && room.liveStatus === 1;
    if (shouldReconnectLiveStream) {
      this.reconnectPendingRooms.add(roomId);
    }
    if (this.recordingSessions.get(roomId) === session) {
      this.recordingSessions.delete(roomId);
    }
    const elapsedText = formatDurationSeconds(elapsedSec);

    if (shouldContinueSegment) {
      this.log(
        'success',
        `${roomLabel(room)} 分段文件完成：${path.basename(session.cleanPath)}，时长 ${elapsedText}，可烧录事件 ${session.eventCount} 条。`
      );
    } else if (session.stopping) {
      this.log(
        'success',
        `${roomLabel(room)} 录制结束：${path.basename(session.cleanPath)}，时长 ${elapsedText}，可烧录事件 ${session.eventCount} 条。`
      );
      if (this.settings.notifyRecordingEnded) {
        this.notify('录制结束', `${roomLabel(room)} 可烧录事件 ${session.eventCount} 条`);
      }
    } else if (code === 0) {
      this.log(
        'warn',
        `${roomLabel(room)} 直播流提前结束，已保存当前文件：${path.basename(session.cleanPath)}，时长 ${elapsedText}，可烧录事件 ${session.eventCount} 条。${
          shouldReconnectLiveStream ? '正在尝试续录。' : ''
        }`
      );
    } else {
      this.log('error', `${roomLabel(room)} 录制进程异常退出：退出码 ${code}，信号 ${signal || '-'}`);
      if (this.settings.notifyRecordingEnded) {
        this.notify('录制异常结束', `${roomLabel(room)} 退出码 ${code}`);
      }
    }

    this.emitState();

    if (shouldContinueSegment) {
      if (this.settings.autoBurnDanmaku && session.eventCount > 0) {
        setTimeout(() => {
          if (finishedRecording.valid) {
            this.startBurnRecording(room, finishedRecording).catch((error) => {
              this.log('error', `${roomLabel(room)} 自动烧录失败：${error.message}`);
            });
          }
        }, 500);
      }
    } else if (shouldReconnectLiveStream) {
      setTimeout(() => {
        const currentRoom = this.rooms.get(roomId);
        if (!currentRoom || !currentRoom.monitoring) {
          this.reconnectPendingRooms.delete(roomId);
          if (currentRoom) {
            this.finalizeReconnectGroup(currentRoom, session.mergeGroup, valid ? finishedRecording : null).catch((mergeError) => {
              this.log('error', `${roomLabel(currentRoom)} 续录片段合并失败：${mergeError.message}`);
            });
          }
          this.emitState();
          return;
        }
        if (this.hasActiveRecordingSession(currentRoom)) {
          this.reconnectPendingRooms.delete(roomId);
          this.emitState();
          return;
        }
        this.startRecording(roomId, true, {
          streamReconnect: true,
          silentNotify: true,
          mergeGroup: session.mergeGroup,
          mergeSequence: Number(session.mergeSequence || 0) + 1,
          mergeOutputPath: session.mergeOutputPath
        })
          .then(async () => {
            this.reconnectPendingRooms.delete(roomId);
            if (!currentRoom.recording) {
              await this.finalizeReconnectGroup(currentRoom, session.mergeGroup, valid ? finishedRecording : null);
            }
          })
          .catch((error) => {
            this.reconnectPendingRooms.delete(roomId);
            this.log('error', `${roomLabel(currentRoom)} 直播流续录失败：${error.message}`);
            this.finalizeReconnectGroup(currentRoom, session.mergeGroup, valid ? finishedRecording : null).catch((mergeError) => {
              this.log('error', `${roomLabel(currentRoom)} 续录片段合并失败：${mergeError.message}`);
            });
          })
          .finally(() => {
            this.emitState();
          });
      }, 1200);
    } else {
      await this.finalizeReconnectGroup(room, session.mergeGroup, valid ? finishedRecording : null);
    }
  }

  async startNextSegmentNow(room, session) {
    const roomId = room.id;
    const nextOptions = {
      segmentContinue: true,
      silentNotify: true,
      stream: session.stream,
      mergeGroup: session.mergeGroup,
      mergeSequence: Number(session.mergeSequence || 0) + 1,
      mergeOutputPath: session.mergeOutputPath
    };
    await this.startRecording(roomId, true, nextOptions).catch((error) => {
      const currentRoom = this.rooms.get(roomId) || room;
      this.log('error', `${roomLabel(currentRoom)} 分段继续录制失败：${error.message}`);
    });
  }

  async finalizeRecordingContainer(room, session) {
    if (normalizeContainer(session.outputContainer) !== 'mp4') {
      return true;
    }
    const sourcePath = session.capturePath || session.cleanPath;
    if (!fs.existsSync(sourcePath)) {
      session.containerStage = 'failed';
      session.validReason = `临时录制文件不存在：${sourcePath}`;
      if (this.shouldUpdateCurrentRecording(room, session)) {
        room.currentRecording.containerStage = session.containerStage;
        room.currentRecording.validReason = session.validReason;
      }
      this.log('error', `${roomLabel(room)} 临时录制文件不存在，无法生成 MP4：${sourcePath}`);
      return false;
    }
    const tmpPath = replaceExtension(session.cleanPath, '.finalizing.mp4');
    try {
      session.containerStage = 'finalizing';
      session.validReason = '';
      if (this.shouldUpdateCurrentRecording(room, session)) {
        room.currentRecording.containerStage = session.containerStage;
        room.currentRecording.validReason = session.validReason;
      }
      this.emitState();
      await fsp.rm(tmpPath, { force: true });
      await runFfmpegJob(
        this.ffmpegPath,
        createMp4FinalizeArgs({ inputPath: sourcePath, outputPath: tmpPath, streamCodec: session.videoInfo?.codec }),
        (line) => {
          if (/error|failed|invalid/i.test(line)) {
            this.log('warn', `${roomLabel(room)} MP4 收尾：${compactLogLine(line)}`);
          }
        }
      );
      const finalizedSize = await getFileSize(tmpPath);
      if (finalizedSize >= MIN_PLAYABLE_BYTES) {
        await fsp.rm(session.cleanPath, { force: true });
        await fsp.rename(tmpPath, session.cleanPath);
        if (sourcePath !== session.cleanPath) {
          await fsp.rm(sourcePath, { force: true }).catch(() => {});
        }
        session.containerStage = 'ready';
        session.validReason = '';
        if (this.shouldUpdateCurrentRecording(room, session)) {
          room.currentRecording.containerStage = session.containerStage;
          room.currentRecording.validReason = session.validReason;
        }
        this.log(
          'success',
          `${roomLabel(room)} MP4 封装完成：${path.basename(session.cleanPath)}（${formatBytes(finalizedSize)}）`
        );
        return true;
      } else {
        await fsp.rm(tmpPath, { force: true });
        session.containerStage = 'failed';
        session.validReason = `MP4 封装结果过小：${formatBytes(finalizedSize)}`;
        if (this.shouldUpdateCurrentRecording(room, session)) {
          room.currentRecording.containerStage = session.containerStage;
          room.currentRecording.validReason = session.validReason;
        }
        this.log(
          'error',
          `${roomLabel(room)} MP4 封装结果过小：${path.basename(tmpPath)}（${formatBytes(finalizedSize)}）`
        );
        return false;
      }
    } catch (error) {
      await fsp.rm(tmpPath, { force: true }).catch(() => {});
      session.containerStage = 'failed';
      session.validReason = `MP4 封装失败：${error.message}`;
      if (this.shouldUpdateCurrentRecording(room, session)) {
        room.currentRecording.containerStage = session.containerStage;
        room.currentRecording.validReason = session.validReason;
      }
      this.log('error', `${roomLabel(room)} MP4 封装失败，已保留临时文件 ${sourcePath}：${error.message}`);
      return false;
    }
  }

  rememberRecording(room, recording) {
    const item = this.normalizeRecording({
      ...recording,
      id: `${recording.cleanPath}:${recording.startedAt || Date.now()}`,
      roomId: room.id,
      roomTitle: room.title || '',
      anchor: room.anchor || ''
    });
    if (!item) {
      return;
    }
    this.recordings = [item, ...this.recordings.filter((saved) => saved.cleanPath !== item.cleanPath)].slice(0, 80);
  }

  async refreshRecordingLibrary(options = {}) {
    const discovered = await discoverRecordingFiles(this.settings.outputDir);
    const existing = new Map(this.recordings.map((recording) => [path.resolve(recording.cleanPath).toLowerCase(), recording]));
    const nextRecordings = [];
    for (const recording of discovered) {
      const key = path.resolve(recording.cleanPath).toLowerCase();
      const current = existing.get(key);
      const normalized = this.normalizeRecording({
        ...(current || {}),
        ...recording,
        roomId: current?.roomId || recording.roomId,
        roomTitle: current?.roomTitle || recording.roomTitle,
        anchor: current?.anchor || recording.anchor,
        videoInfo: current?.videoInfo || recording.videoInfo
      });
      if (normalized) {
        nextRecordings.push(normalized);
      }
    }
    const nextKeys = new Set(nextRecordings.map((recording) => path.resolve(recording.cleanPath).toLowerCase()));
    const removedCount = this.recordings.filter(
      (recording) => recording.cleanPath && !nextKeys.has(path.resolve(recording.cleanPath).toLowerCase())
    ).length;
    this.recordings = nextRecordings
      .filter(Boolean)
      .sort((a, b) => Number(b.startedAt || 0) - Number(a.startedAt || 0))
      .slice(0, 160);
    await this.saveStore();
    if (!options.silent) {
      const validCount = this.recordings.filter((recording) => recording.valid !== false).length;
      const removedText = removedCount > 0 ? `，已移除 ${removedCount} 个失效记录` : '';
      this.log(
        discovered.length > 0 ? 'success' : 'warn',
        `录像库已刷新，找到 ${discovered.length} 个源文件，可用 ${validCount} 个${removedText}。`
      );
      this.emitState();
    }
    return this.getState();
  }
  async finalizeReconnectGroup(room, mergeGroup, fallbackRecording) {
    const recording = await this.mergeReconnectGroupIfNeeded(room, mergeGroup, fallbackRecording);
    if (this.settings.autoBurnDanmaku && recording?.valid !== false && Number(recording?.eventCount || 0) > 0) {
      setTimeout(() => {
        this.startBurnRecording(room, recording).catch((error) => {
          this.log('error', `${roomLabel(room)} 自动烧录失败：${error.message}`);
        });
      }, 500);
    } else {
      this.scheduleQueuedUpdateCheck();
    }
    return recording;
  }

  async mergeReconnectGroupIfNeeded(room, mergeGroup, fallbackRecording) {
    const groupId = String(mergeGroup || '').trim();
    if (!groupId) {
      return fallbackRecording;
    }
    const segments = this.recordings
      .filter((recording) => recording.mergeGroup === groupId && !recording.mergedFrom?.length)
      .filter((recording) => recording.valid !== false)
      .filter((recording) => recording.cleanPath && recording.cleanPath !== recording.mergeOutputPath)
      .filter((recording) => fs.existsSync(recording.cleanPath))
      .sort((a, b) => {
        const sequenceDiff = Number(a.mergeSequence || 0) - Number(b.mergeSequence || 0);
        return sequenceDiff || Number(a.startedAt || 0) - Number(b.startedAt || 0);
      });
    if (segments.length < 2) {
      return fallbackRecording;
    }

    const outputPath = segments[0].mergeOutputPath || deriveSiblingPath(segments[0].cleanPath, 'merged');
    const container = getContainerFromPath(outputPath);
    const tmpPath = replaceExtension(outputPath, `.tmp.${container}`);
    const concatPath = replaceExtension(outputPath, '.concat.txt');
    const danmakuPath = deriveSiblingPath(outputPath, 'danmaku', 'jsonl');
    const cssPath = deriveSiblingPath(outputPath, 'danmaku', 'css');
    const assPath = deriveSiblingPath(outputPath, 'danmaku', 'ass');
    const burnedPath = deriveBurnedPath(outputPath, this.settings.burnOverlayMode);

    this.log('info', `${roomLabel(room)} 正在合并 ${segments.length} 个续录片段：${path.basename(outputPath)}`);
    await writeConcatFile(concatPath, segments.map((segment) => segment.cleanPath));
    await fsp.rm(tmpPath, { force: true });
    await runFfmpegJob(
      this.ffmpegPath,
      createConcatCopyArgs({ concatPath, outputPath: tmpPath, container }),
      (line) => {
        if (/error|failed|invalid/i.test(line)) {
          this.log('warn', `${roomLabel(room)} 合并：${compactLogLine(line)}`);
        }
      }
    );
    await fsp.rm(outputPath, { force: true });
    await fsp.rename(tmpPath, outputPath);
    await fsp.rm(concatPath, { force: true });
    await mergeDanmakuFiles(segments, danmakuPath);
    await copyFirstExistingFile(segments.map((segment) => segment.cssPath).filter(Boolean), cssPath, createDefaultDanmakuCss());

    const mergedRecording = this.normalizeRecording({
      id: `${outputPath}:${Date.now()}`,
      roomId: room.id,
      roomTitle: room.title || '',
      anchor: room.anchor || '',
      startedAt: segments[0].startedAt,
      cleanPath: outputPath,
      danmakuPath,
      cssPath,
      assPath,
      burnedPath,
      mergeGroup: groupId,
      mergeSequence: 0,
      mergeOutputPath: outputPath,
      mergedFrom: segments.map((segment) => segment.cleanPath),
      durationSec: segments.reduce((sum, segment) => sum + Number(segment.durationSec || 0), 0),
      fileSize: await getFileSize(outputPath),
      valid: true,
      eventCount: segments.reduce((sum, segment) => sum + Number(segment.eventCount || 0), 0),
      rawDanmakuCount: segments.reduce((sum, segment) => sum + Number(segment.rawDanmakuCount || 0), 0),
      capturedDanmakuCount: segments.reduce(
        (sum, segment) => sum + Number(segment.capturedDanmakuCount ?? segment.eventCount ?? 0),
        0
      ),
      ignoredDanmakuCount: segments.reduce((sum, segment) => sum + Number(segment.ignoredDanmakuCount || 0), 0),
      danmakuCommandCounts: mergeCommandCounts(segments.map((segment) => segment.danmakuCommandCounts)),
      videoInfo: segments[0].videoInfo || null
    });
    this.recordings = [mergedRecording, ...this.recordings.filter((recording) => recording.cleanPath !== outputPath)].slice(0, 80);
    if (!this.isRoomRecording(room)) {
      room.currentRecording = mergedRecording;
    }
    await this.saveStore();
    this.log(
      'success',
      `${roomLabel(room)} 续录片段已合并：${path.basename(outputPath)}，共 ${segments.length} 段，时长 ${formatDurationSeconds(
        mergedRecording.durationSec
      )}。`
    );
    this.emitState();
    return mergedRecording;
  }

  async startBurnDanmaku(roomId, options = {}) {
    const room = this.getRoom(roomId);
    if (this.isRoomBurning(room)) {
      return this.getState();
    }
    const recording = room.currentRecording;
    if (!recording?.cleanPath || !recording?.danmakuPath) {
      this.log('warn', `${roomLabel(room)} 没有可烧录的最近录像。`);
      return this.getState();
    }

    await this.startBurnRecording(room, recording, options);
    return this.getState();
  }

  async prepareDanmakuForRoom(roomId, options = {}) {
    const room = this.getRoom(roomId);
    const recording = room.currentRecording;
    if (!recording?.cleanPath || !recording?.danmakuPath) {
      this.log('warn', `${roomLabel(room)} 没有可生成字幕的最近录像。`);
      return this.getState();
    }
    const assets = await this.generateSubtitleAssets(recording, {
      overlayMode: options.overlayMode || this.settings.burnOverlayMode
    });
    this.log('success', `${roomLabel(room)} 字幕文件已生成：${path.basename(assets.cssPath)} / ${path.basename(assets.assPath)}`);
    this.emitState();
    return this.getState();
  }

  async startBurnRecording(room, recording, options = {}) {
    if (this.isRoomBurning(room)) {
      this.log('warn', `${roomLabel(room)} 已有弹幕版正在生成，跳过 ${path.basename(recording.cleanPath)}。`);
      return false;
    }
    if (!recording?.cleanPath || !recording?.danmakuPath || recording.valid === false) {
      this.log('warn', `${roomLabel(room)} 没有可烧录的最近录像。`);
      return false;
    }

    try {
      const overlayMode = normalizeBurnOverlayMode(options.overlayMode || this.settings.burnOverlayMode);
      const assets = await this.generateSubtitleAssets(recording, { overlayMode });
      if (options.prepareOnly) {
        this.log('success', `${roomLabel(room)} 字幕文件已生成：${path.basename(assets.cssPath)} / ${path.basename(assets.assPath)}`);
        return true;
      }
      const burnedPath = options.outputPath || deriveBurnedPath(recording.cleanPath, overlayMode);
      recording.burnedPath = burnedPath;

      const args = createBurnArgs({
        cleanPath: recording.cleanPath,
        assPath: assets.assPath,
        burnedPath,
        codec: this.settings.burnCodec,
        crf: this.settings.burnCrf,
        container: getContainerFromPath(burnedPath)
      });
      const ffmpeg = spawn(this.ffmpegPath, args, {
        windowsHide: true,
        stdio: ['ignore', 'ignore', 'pipe']
      });
      room.burning = true;
      this.burnSessions.set(room.id, ffmpeg);
      this.log('info', `${roomLabel(room)} 正在生成有弹幕版：${path.basename(burnedPath)}（${overlayModeLabel(overlayMode)}）`);
      if (this.settings.notifyBurnStarted) {
        this.notify('开始烧录弹幕版', `${roomLabel(room)} 正在生成 ${path.basename(burnedPath)}`);
      }

      ffmpeg.stderr.on('data', (chunk) => {
        const text = chunk.toString('utf8');
        if (/error|failed|invalid/i.test(text)) {
          this.log('warn', `${roomLabel(room)} 烧录：${compactLogLine(text)}`);
        }
      });
      ffmpeg.on('error', (error) => {
        this.log('error', `${roomLabel(room)} 烧录进程启动失败：${error.message}`);
      });
      ffmpeg.on('close', (code, signal) => {
        if (this.burnSessions.get(room.id) === ffmpeg) {
          room.burning = false;
          this.burnSessions.delete(room.id);
        }
        if (code === 0) {
          this.log('success', `${roomLabel(room)} 有弹幕版已生成：${path.basename(burnedPath)}`);
          if (this.settings.notifyBurnEnded) {
            this.notify('弹幕版已生成', `${roomLabel(room)} ${path.basename(burnedPath)}`);
          }
        } else {
          this.log('error', `${roomLabel(room)} 烧录失败：退出码 ${code}，信号 ${signal || '-'}`);
          if (this.settings.notifyBurnEnded) {
            this.notify('弹幕版烧录失败', `${roomLabel(room)} 退出码 ${code}`);
          }
        }
        this.emitState();
        this.scheduleQueuedUpdateCheck();
      });
    } catch (error) {
      room.burning = false;
      this.log('error', `${roomLabel(room)} 生成弹幕版失败：${error.message}`);
      return false;
    }
    this.emitState();
    return true;
  }

  async generateSubtitleAssets(recording, options = {}) {
    const overlayMode = normalizeBurnOverlayMode(options.overlayMode || this.settings.burnOverlayMode);
    const events = await readDanmakuEvents(recording.danmakuPath);
    const cssPath = options.cssPath || recording.cssPath || deriveSiblingPath(recording.cleanPath, 'danmaku', 'css');
    await ensureDanmakuCss(cssPath);
    const style = await readDanmakuStyle(cssPath);
    const assPath =
      options.assPath ||
      recording.assPath ||
      deriveSiblingPath(recording.cleanPath, overlayMode === 'danmaku' ? 'danmaku-only' : 'danmaku', 'ass');
    const ass = createAss(events, {
      overlayMode,
      style,
      startTime: options.startTime,
      endTime: options.endTime,
      shiftTime: options.shiftTime
    });
    await fsp.writeFile(assPath, ass, 'utf8');
    recording.cssPath = cssPath;
    recording.assPath = assPath;
    return { cssPath, assPath, eventCount: events.length };
  }

  async prepareSubtitleExport(options = {}) {
    const recording = this.normalizeRecording(options.recording || options);
    if (!recording) {
      throw new Error('请选择录像文件。');
    }
    if (recording.valid === false) {
      throw new Error('这个录像文件被标记为无效，请换一个源文件。');
    }
    const startTime = parseTimeInput(options.startTime ?? options.start);
    const endTime = parseTimeInput(options.endTime ?? options.end);
    const overlayMode = normalizeBurnOverlayMode(options.overlayMode || this.settings.burnOverlayMode);
    const suffix = createClipSuffix(startTime, endTime, overlayMode);
    const assets = await this.generateSubtitleAssets(recording, {
      overlayMode,
      startTime,
      endTime,
      shiftTime: Number.isFinite(startTime),
      cssPath: options.cssPath || recording.cssPath,
      assPath: deriveSiblingPath(recording.cleanPath, suffix, 'ass')
    });
    this.log('success', `字幕文件已生成：${path.basename(assets.cssPath)} / ${path.basename(assets.assPath)}`);
    return {
      ok: true,
      mode: 'subtitles',
      cleanPath: recording.cleanPath,
      cssPath: assets.cssPath,
      assPath: assets.assPath,
      eventCount: assets.eventCount
    };
  }

  async exportClip(options = {}) {
    const recording = this.normalizeRecording(options.recording || options);
    if (!recording) {
      throw new Error('请选择录像文件。');
    }
    if (recording.valid === false) {
      throw new Error('这个录像文件被标记为无效，请换一个源文件。');
    }
    if (!fs.existsSync(recording.cleanPath)) {
      throw new Error(`源视频不存在：${recording.cleanPath}`);
    }
    const mode = normalizeExportMode(options.mode);
    const overlayMode = normalizeBurnOverlayMode(options.overlayMode || this.settings.burnOverlayMode);
    const startTime = parseTimeInput(options.startTime ?? options.start);
    const endTime = parseTimeInput(options.endTime ?? options.end);
    if (!Number.isFinite(startTime) || startTime < 0) {
      throw new Error('开始时间无效，请输入 00:00:00 或秒数。');
    }
    if (!Number.isFinite(endTime) || endTime <= startTime) {
      throw new Error('结束时间必须大于开始时间。');
    }
    const duration = endTime - startTime;
    const outputDir = String(options.outputDir || path.dirname(recording.cleanPath));
    await fsp.mkdir(outputDir, { recursive: true });
    const outputPath =
      options.outputPath ||
      deriveClipPath(recording.cleanPath, outputDir, mode === 'clean' ? 'clean' : overlayMode, startTime, endTime);

    let cssPath = recording.cssPath;
    let assPath = recording.assPath;
    let args;
    if (mode === 'clean') {
      args = createClipCopyArgs({
        cleanPath: recording.cleanPath,
        outputPath,
        startTime,
        duration,
        container: getContainerFromPath(outputPath)
      });
    } else {
      const assets = await this.generateSubtitleAssets(recording, {
        overlayMode,
        startTime,
        endTime,
        shiftTime: true,
        cssPath: options.cssPath || recording.cssPath,
        assPath: deriveSiblingPath(outputPath, 'subtitle', 'ass')
      });
      cssPath = assets.cssPath;
      assPath = assets.assPath;
      args = createBurnArgs({
        cleanPath: recording.cleanPath,
        assPath,
        burnedPath: outputPath,
        codec: this.settings.burnCodec,
        crf: this.settings.burnCrf,
        container: getContainerFromPath(outputPath),
        startTime,
        duration
      });
    }

    this.log('info', `开始导出${mode === 'clean' ? '纯净' : '烧录'}片段：${path.basename(outputPath)}`);
    await runFfmpegJob(this.ffmpegPath, args, (line) => {
      if (/error|failed|invalid/i.test(line)) {
        this.log('warn', `剪辑导出：${compactLogLine(line)}`);
      }
    });
    this.log('success', `片段已导出：${path.basename(outputPath)}`);
    return {
      ok: true,
      mode,
      outputPath,
      cleanPath: recording.cleanPath,
      cssPath,
      assPath: mode === 'burn' ? assPath : undefined
    };
  }

  createFfmpegHeaders(room) {
    const lines = [
      `Referer: https://live.bilibili.com/${room.realRoomId || room.id}`,
      'Origin: https://live.bilibili.com'
    ];
    const cookie = sanitizeHeaderValue(this.settings.cookie);
    if (cookie) {
      lines.push(`Cookie: ${cookie}`);
    }
    return `${lines.join('\r\n')}\r\n`;
  }

  async clearLogs() {
    this.logs = [];
    this.emitState();
    return this.getState();
  }

  async openConfigDir() {
    const configDir = path.dirname(this.storePath);
    await fsp.mkdir(configDir, { recursive: true });
    openPath(configDir);
    this.log('info', `已打开配置目录：${configDir}`);
    this.emitState();
    return this.getState();
  }

  async checkUpdate() {
    this.updateState = {
      ...this.updateState,
      status: 'checking',
      currentVersion: APP_VERSION,
      message: '正在检查更新...',
      checkedAt: Date.now(),
      downloadReceivedBytes: 0,
      downloadTotalBytes: 0,
      downloadProgress: null,
      updateLogPath: this.getUpdateLogPath(),
      statusPath: this.getUpdateStatusPath()
    };
    this.emitState();
    let acceptingStatus = true;
    try {
      const manifest = await withTimeout(this.fetchUpdateManifest((message) => {
        if (!acceptingStatus) {
          return;
        }
        this.updateState = {
          ...this.updateState,
          status: 'checking',
          message,
          checkedAt: Date.now()
        };
        this.emitState();
      }), 45000, '检查更新超时：45 秒内没有收到更新源响应。');
      acceptingStatus = false;
      const latestVersion = manifest.version || manifest.tagName || '';
      const hasUpdate = compareVersions(latestVersion, APP_VERSION) > 0;
      this.updateState = {
        ...this.updateState,
        status: hasUpdate ? 'available' : 'up-to-date',
        currentVersion: APP_VERSION,
        latestVersion,
        message: hasUpdate ? `发现新版本 ${latestVersion}` : `当前已是最新版本 ${APP_VERSION}`,
        checkedAt: Date.now(),
        downloadReceivedBytes: 0,
        downloadTotalBytes: 0,
        downloadProgress: null,
        manifest
      };
      this.log(hasUpdate ? 'success' : 'info', this.updateState.message);
      this.emitState();
      return this.getState();
    } catch (error) {
      acceptingStatus = false;
      this.updateState = {
        ...this.updateState,
        status: 'error',
        message: `检查更新失败：${error.message}`,
        checkedAt: Date.now(),
        downloadReceivedBytes: 0,
        downloadTotalBytes: 0,
        downloadProgress: null,
        updateLogPath: this.getUpdateLogPath(),
        statusPath: this.getUpdateStatusPath()
      };
      this.log('error', this.updateState.message);
      this.emitState();
      return this.getState();
    }
  }

  async queueUpdateAfterJobs() {
    if (!this.updateState.manifest || this.updateState.status === 'idle' || this.updateState.status === 'up-to-date') {
      await this.checkUpdate();
    }
    if (!this.updateState.manifest || compareVersions(this.updateState.latestVersion, APP_VERSION) <= 0) {
      return this.getState();
    }
    if (!this.hasActiveJobs()) {
      return this.applyUpdate();
    }
    this.updateState = {
      ...this.updateState,
      status: 'queued',
      queued: true,
      message: `已排队更新到 ${this.updateState.latestVersion}，录制/烧录结束后自动启动安装器。`
    };
    this.log('info', this.updateState.message);
    this.emitState();
    return this.getState();
  }

  async downloadUpdateOnly() {
    if (this.updateState.queued || this.updateState.status === 'queued') {
      return this.getState();
    }
    if (!this.updateState.manifest || this.updateState.status === 'idle' || this.updateState.status === 'up-to-date') {
      await this.checkUpdate();
    }
    const manifest = this.updateState.manifest;
    if (!manifest || compareVersions(manifest.version, APP_VERSION) <= 0) {
      return this.getState();
    }

    try {
      const usablePackagePath = await this.getUsableDownloadedPackage(manifest);
      this.updateState = {
        ...this.updateState,
        status: usablePackagePath ? 'available' : 'downloading',
        queued: false,
        message: usablePackagePath
          ? `${updatePackageLabel(manifest)}已下载：${usablePackagePath}`
          : `正在下载 ${manifest.version} ${updatePackageLabel(manifest)}...`,
        downloadReceivedBytes: usablePackagePath ? this.updateState.downloadReceivedBytes : 0,
        downloadTotalBytes: usablePackagePath ? this.updateState.downloadTotalBytes : 0,
        downloadProgress: usablePackagePath ? 100 : 0,
        updateLogPath: this.getUpdateLogPath(),
        statusPath: this.getUpdateStatusPath(),
        packagePath: usablePackagePath || ''
      };
      this.emitState();

      const packagePath = usablePackagePath || (await this.downloadUpdatePackage(manifest));
      this.updateState = {
        ...this.updateState,
        status: 'available',
        queued: false,
        message: `${updatePackageLabel(manifest)}已下载：${packagePath}`,
        downloadProgress: 100,
        packagePath
      };
      this.log('success', `${updatePackageLabel(manifest)}已下载：${packagePath}`);
      this.emitState();
    } catch (error) {
      this.updateState = {
        ...this.updateState,
        status: 'error',
        queued: false,
        message: `手动下载更新失败：${error.message}`,
        downloadProgress: null,
        updateLogPath: this.getUpdateLogPath(),
        statusPath: this.getUpdateStatusPath()
      };
      this.log('error', this.updateState.message);
      this.emitState();
    }
    return this.getState();
  }

  async applyUpdate() {
    if (this.hasActiveJobs()) {
      this.updateState = {
        ...this.updateState,
        status: 'blocked',
        queued: false,
        message: '当前仍有录制或烧录任务，暂不更新。'
      };
      this.emitState();
      return this.getState();
    }

    if (!this.updateState.manifest || compareVersions(this.updateState.latestVersion, APP_VERSION) <= 0) {
      await this.checkUpdate();
    }
    const manifest = this.updateState.manifest;
    if (!manifest || compareVersions(manifest.version, APP_VERSION) <= 0) {
      return this.getState();
    }

    try {
      const usablePackagePath = await this.getUsableDownloadedPackage(manifest);
      this.updateState = {
        ...this.updateState,
        status: 'downloading',
        queued: false,
        message: usablePackagePath
          ? `正在使用已下载的 ${manifest.version} ${updatePackageLabel(manifest)}...`
          : `正在下载 ${manifest.version} ${updatePackageLabel(manifest)}...`,
        downloadReceivedBytes: usablePackagePath ? this.updateState.downloadReceivedBytes : 0,
        downloadTotalBytes: usablePackagePath ? this.updateState.downloadTotalBytes : 0,
        downloadProgress: usablePackagePath ? 100 : 0,
        updateLogPath: this.getUpdateLogPath(),
        statusPath: this.getUpdateStatusPath(),
        packagePath: usablePackagePath || ''
      };
      this.emitState();

      const packagePath = usablePackagePath || (await this.downloadUpdatePackage(manifest));
      this.updateState = {
        ...this.updateState,
        status: 'ready',
        message: `${updatePackageLabel(manifest)}已准备好，正在启动安装器...`,
        downloadProgress: 100,
        packagePath
      };
      this.emitState();

      const launched = this.launchUpdateInstaller(packagePath, manifest);
      if (!launched) {
        this.updateState = {
          ...this.updateState,
          status: 'available',
          queued: false,
          message: `更新包已下载，但当前更新源没有提供安装器。请打开下载目录后手动更新：${packagePath}`,
          downloadProgress: 100,
          packagePath
        };
        this.log('warn', this.updateState.message);
        this.emitState();
        return this.getState();
      }
      this.updateState = {
        ...this.updateState,
        status: 'applying',
        message: '安装器已启动，应用会在安装过程中自动重启。'
      };
      this.log('success', `已启动 ${manifest.version} 安装器：${packagePath}`);
      this.emitState();
    } catch (error) {
      this.updateState = {
        ...this.updateState,
        status: 'error',
        queued: false,
        message: `更新失败：${error.message}`,
        downloadProgress: null,
        updateLogPath: this.getUpdateLogPath(),
        statusPath: this.getUpdateStatusPath()
      };
      this.log('error', this.updateState.message);
      this.emitState();
    }
    return this.getState();
  }

  async getUsableDownloadedPackage(manifest) {
    const packagePath = String(this.updateState.packagePath || '').trim();
    if (!packagePath) {
      return '';
    }
    const stat = await fsp.stat(packagePath).catch(() => null);
    if (!stat?.isFile() || stat.size <= 0) {
      return '';
    }
    if (manifest.sha256) {
      const actual = await fileSha256(packagePath).catch(() => '');
      if (actual.toLowerCase() !== String(manifest.sha256).toLowerCase()) {
        await fsp.rm(packagePath, { force: true }).catch(() => {});
        this.log('warn', `已下载更新包校验失败，重新下载：${packagePath}`);
        return '';
      }
    }
    return packagePath;
  }

  launchUpdateInstaller(packagePath, manifest) {
    if (!isInstallerUpdatePackage(manifest, packagePath)) {
      return false;
    }
    const args = buildInstallerArgs(manifest, {
      packagePath,
      statusPath: this.getUpdateStatusPath(),
      logPath: this.getUpdateLogPath()
    });
    if (process.platform === 'win32') {
      const script = createElevatedInstallerLaunchScript(packagePath, args);
      const encoded = Buffer.from(script, 'utf16le').toString('base64');
      const child = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded], {
        detached: true,
        stdio: 'ignore',
        windowsHide: true
      });
      child.unref();
      return true;
    }
    const child = spawn(packagePath, args, {
      detached: true,
      stdio: 'ignore',
      windowsHide: false
    });
    child.unref();
    return true;
  }

  async fetchUpdateManifest(onStatus) {
    const source = this.settings.updateManifestUrl || DEFAULT_UPDATE_MANIFEST_URL;
    let raw;
    try {
      raw = await readTextSource(source, {
        timeoutMs: UPDATE_CHECK_TIMEOUT_MS,
        retries: 3,
        onRetry: ({ attempt, maxAttempts, error }) => {
          onStatus?.(
            `检查更新连接中断，正在重试 ${attempt}/${Math.max(1, Number(maxAttempts || 1) - 1)}：${
              error.message || error
            }`
          );
        }
      });
    } catch (error) {
      if (!isDefaultUpdateSource(source)) {
        throw error;
      }
      onStatus?.('默认更新清单连接失败，正在改用 GitHub Release API...');
      this.log('warn', `默认更新清单失败，改用 GitHub Release API：${error.message}`);
      raw = await readTextSource(GITHUB_LATEST_RELEASE_API, {
        timeoutMs: UPDATE_CHECK_TIMEOUT_MS,
        retries: 3,
        onRetry: ({ attempt, maxAttempts, error: retryError }) => {
          onStatus?.(
            `GitHub Release API 连接中断，正在重试 ${attempt}/${Math.max(1, Number(maxAttempts || 1) - 1)}：${
              retryError.message || retryError
            }`
          );
        }
      });
    }
    const payload = JSON.parse(raw);
    const manifest = normalizeUpdateManifest(payload);
    if (!manifest.version || !manifest.packageUrl) {
      throw new Error('更新源缺少 version 或 packageUrl。');
    }
    return manifest;
  }

  async downloadUpdatePackage(manifest) {
    const updateDir = this.getUpdateDir();
    await fsp.mkdir(updateDir, { recursive: true });
    const packagePath = path.join(updateDir, updatePackageFileName(manifest));
    this.updateState = {
      ...this.updateState,
      packagePath
    };
    this.emitState();
    let lastEmitAt = 0;
    await downloadFile(manifest.packageUrl, packagePath, (progress) => {
      if (progress.retrying) {
        this.updateState = {
          ...this.updateState,
          status: 'downloading',
          message: `下载连接中断，正在重试 ${progress.attempt}/${Math.max(1, Number(progress.maxAttempts || 1) - 1)}：${
            progress.error?.message || progress.error || '网络错误'
          }`
        };
        this.emitState();
        return;
      }
      const receivedBytes = Number(progress.receivedBytes || 0);
      const totalBytes = Number(progress.totalBytes || 0);
      const percent = totalBytes > 0 ? clamp(Math.round((receivedBytes / totalBytes) * 100), 0, 100) : null;
      const now = Date.now();
      this.updateState = {
        ...this.updateState,
        status: 'downloading',
        message:
          percent === null
            ? `正在下载 ${manifest.version} ${updatePackageLabel(manifest)}：已下载 ${formatBytes(receivedBytes)}`
            : `正在下载 ${manifest.version} ${updatePackageLabel(manifest)}：${percent}%（${formatBytes(receivedBytes)} / ${formatBytes(totalBytes)}）`,
        downloadReceivedBytes: receivedBytes,
        downloadTotalBytes: totalBytes,
        downloadProgress: percent
      };
      if (progress.done || now - lastEmitAt > 300) {
        lastEmitAt = now;
        this.emitState();
      }
    });
    this.updateState = {
      ...this.updateState,
      message: manifest.sha256 ? `${updatePackageLabel(manifest)}下载完成，正在校验...` : `${updatePackageLabel(manifest)}下载完成。`,
      downloadProgress: 100
    };
    this.emitState();
    if (manifest.sha256) {
      const actual = await fileSha256(packagePath);
      if (actual.toLowerCase() !== String(manifest.sha256).toLowerCase()) {
        await fsp.rm(packagePath, { force: true });
        throw new Error('更新包 SHA256 校验失败，已放弃更新。');
      }
    }
    return packagePath;
  }

  async loadLastUpdateStatus() {
    const statusPath = this.getUpdateStatusPath();
    try {
      const status = JSON.parse(await fsp.readFile(statusPath, 'utf8'));
      const updateStatus = String(status.status || '');
      const version = normalizeVersion(status.version || '');
      const message = String(status.message || '');
      if (updateStatus === 'error' || updateStatus === 'applying') {
        this.updateState = {
          ...this.updateState,
          status: 'error',
          latestVersion: version,
          message:
            updateStatus === 'applying'
              ? `上次旧版更新停在应用阶段，可能被文件占用或安全软件拦截。${status.logPath ? `日志：${status.logPath}` : ''}`
              : `上次更新失败：${message || '未知错误'}${status.logPath ? `，日志：${status.logPath}` : ''}`,
          checkedAt: Date.now(),
          statusPath,
          updateLogPath: status.logPath || this.getUpdateLogPath()
        };
        this.log('error', this.updateState.message);
      } else if (updateStatus === 'success') {
        if (version && compareVersions(version, APP_VERSION) > 0) {
          this.updateState = {
            ...this.updateState,
            status: 'error',
            latestVersion: version,
            message: `旧版更新流程完成到 ${version}，但当前仍是 ${APP_VERSION}。可能是旧进程没有退出，或更新包被复制到了错误目录。${
              status.logPath ? `日志：${status.logPath}` : ''
            }`,
            checkedAt: Date.now(),
            statusPath,
            updateLogPath: status.logPath || this.getUpdateLogPath()
          };
          this.log('error', this.updateState.message);
          return;
        }
        this.log('success', version ? `已更新到 ${version}。` : '更新已完成。');
        await this.cleanupUpdateDownloads(status.packagePath);
        await fsp.rm(statusPath, { force: true });
      }
    } catch (error) {
      if (error.code !== 'ENOENT') {
        this.log('warn', `读取更新状态失败：${error.message}`);
      }
    }
  }

  getUpdateStatusPath() {
    return path.join(this.getUpdateDir(), 'last-update-status.json');
  }

  getUpdateLogPath() {
    return path.join(this.getUpdateDir(), 'apply-update.log');
  }

  getUpdateDir() {
    return path.join(path.dirname(this.storePath), 'updates');
  }

  async cleanupUpdateDownloads(packagePath, attempt = 1) {
    const updateDir = this.getUpdateDir();
    const targets = new Set();
    const normalizedPackagePath = String(packagePath || '').trim();
    if (normalizedPackagePath && isPathInsideDirectory(normalizedPackagePath, updateDir)) {
      targets.add(path.resolve(normalizedPackagePath));
    }
    const entries = await fsp.readdir(updateDir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (!entry.isFile()) {
        continue;
      }
      const name = entry.name.toLowerCase();
      if (
        name.endsWith('.tmp') ||
        (/^bili-record-2k-/.test(name) && /\.(?:exe|zip)$/i.test(name))
      ) {
        targets.add(path.join(updateDir, entry.name));
      }
    }
    const failed = [];
    for (const target of targets) {
      try {
        await fsp.rm(target, { force: true });
      } catch (error) {
        failed.push(target);
        if (attempt === 1) {
          this.log('warn', `更新安装包暂时无法删除，稍后重试：${target}（${error.message}）`);
        }
      }
    }
    if (failed.length > 0 && attempt < 4) {
      setTimeout(() => {
        this.cleanupUpdateDownloads(packagePath, attempt + 1).catch((error) => {
          this.log('warn', `清理更新安装包失败：${error.message}`);
        });
      }, attempt * 2500).unref?.();
      return;
    }
    if (targets.size > 0 && failed.length === 0) {
      this.log('info', '已清理更新安装包。');
    }
  }

  scheduleQueuedUpdateCheck(delayMs = 1500) {
    if (!this.updateState.queued) {
      return;
    }
    clearTimeout(this.queuedUpdateTimer);
    this.queuedUpdateTimer = setTimeout(() => {
      if (!this.updateState.queued || this.hasActiveJobs()) {
        return;
      }
      this.applyUpdate().catch((error) => {
        this.updateState = {
          ...this.updateState,
          status: 'error',
          queued: false,
          message: `自动更新失败：${error.message}`
        };
        this.log('error', this.updateState.message);
        this.emitState();
      });
    }, delayMs);
    this.queuedUpdateTimer.unref?.();
  }

  hasActiveJobs() {
    return (
      this.recordingSessions.size > 0 ||
      this.recordingStartLocks.size > 0 ||
      this.reconnectPendingRooms.size > 0 ||
      this.burnSessions.size > 0 ||
      Array.from(this.rooms.values()).some((room) => room.recording || room.burning)
    );
  }

  async setStartup(enabled) {
    if (process.platform !== 'win32') {
      throw new Error('开机自启目前只支持 Windows。');
    }
    setStartupEnabled(Boolean(enabled));
    this.log(Boolean(enabled) ? 'success' : 'info', Boolean(enabled) ? '已开启开机自启。' : '已关闭开机自启。');
    this.emitState();
    return this.getState();
  }

  async testNotification() {
    this.notify('测试通知', '哔哩录播 2K Windows 通知功能正常');
    this.log('success', '已发送 Windows 测试通知。');
    this.emitState();
    return this.getState();
  }

  async requestShutdown() {
    this.log('info', '正在退出后台服务。');
    this.emitState();
    setTimeout(() => {
      this.shutdown();
      setTimeout(() => process.exit(0), 1500).unref();
    }, 250).unref();
    return { ok: true };
  }

  getRoom(roomId) {
    const room = this.rooms.get(String(roomId));
    if (!room) {
      throw new Error(`找不到房间 ${roomId}`);
    }
    return room;
  }

  shutdown() {
    this.clearLoginTimer();
    clearTimeout(this.queuedUpdateTimer);
    for (const timer of this.monitorTimers.values()) {
      clearInterval(timer);
    }
    this.monitorTimers.clear();
    for (const room of this.rooms.values()) {
      const session = this.recordingSessions.get(room.id);
      clearTimeout(session?.rotateTimer);
      clearTimeout(session?.mediaWatchTimer);
      session?.danmakuClient?.close('服务退出');
      if (session?.ffmpeg) {
        requestFfmpegStop(session.ffmpeg, { graceful: true, timeoutMs: 1500 });
      }
    }
    for (const ffmpeg of this.burnSessions.values()) {
      requestFfmpegStop(ffmpeg, { graceful: false, timeoutMs: 1500 });
    }
  }
}

class DanmakuClient {
  constructor(options) {
    this.roomId = options.roomId;
    this.uid = options.uid || 0;
    this.buvid = options.buvid || '';
    this.token = options.token;
    this.hosts = options.hosts;
    this.onOpen = options.onOpen;
    this.onAuthReply = options.onAuthReply;
    this.onHeartbeat = options.onHeartbeat;
    this.onClose = options.onClose;
    this.onError = options.onError;
    this.onCommand = options.onCommand;
    this.ws = null;
    this.heartbeatTimer = null;
  }

  connect() {
    const host = this.pickHost();
    this.ws = new WebSocket(host);
    this.ws.binaryType = 'nodebuffer';
    this.ws.on('open', () => {
      this.onOpen?.();
      this.sendAuth();
      this.heartbeatTimer = setInterval(() => this.sendHeartbeat(), 30000);
      this.sendHeartbeat();
    });
    this.ws.on('message', (data) => this.handleMessage(Buffer.from(data)));
    this.ws.on('error', (error) => this.onError?.(error));
    this.ws.on('close', (_code, reason) => {
      clearInterval(this.heartbeatTimer);
      this.onClose?.(reason?.toString() || 'closed');
    });
  }

  pickHost() {
    const list = Array.isArray(this.hosts) ? this.hosts : [];
    const best = list.find((item) => item.wss_port) || list[0];
    if (best?.host) {
      return `wss://${best.host}:${best.wss_port || 443}/sub`;
    }
    return 'wss://broadcastlv.chat.bilibili.com:443/sub';
  }

  sendAuth() {
    this.sendPacket(
      DANMAKU_OP.AUTH,
      JSON.stringify({
        uid: this.uid,
        roomid: this.roomId,
        protover: 2,
        platform: 'web',
        type: 2,
        key: this.token,
        buvid: this.buvid
      })
    );
  }

  sendHeartbeat() {
    this.sendPacket(DANMAKU_OP.HEARTBEAT, '');
  }

  sendPacket(operation, body) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return;
    }
    const payload = Buffer.from(body || '', 'utf8');
    const buffer = Buffer.alloc(16 + payload.length);
    buffer.writeUInt32BE(buffer.length, 0);
    buffer.writeUInt16BE(16, 4);
    buffer.writeUInt16BE(1, 6);
    buffer.writeUInt32BE(operation, 8);
    buffer.writeUInt32BE(1, 12);
    payload.copy(buffer, 16);
    this.ws.send(buffer);
  }

  handleMessage(buffer) {
    for (const packet of unpackDanmakuPackets(buffer)) {
      if (packet.operation === DANMAKU_OP.AUTH_REPLY) {
        this.onAuthReply?.(decodeAuthReply(packet));
        continue;
      }
      if (packet.operation === DANMAKU_OP.HEARTBEAT_REPLY) {
        if (packet.body.length >= 4) {
          this.onHeartbeat?.(packet.body.readUInt32BE(0));
        }
        continue;
      }
      if (packet.operation !== DANMAKU_OP.MESSAGE) {
        continue;
      }
      for (const body of safeDecodeDanmakuPacket(packet)) {
        try {
          const command = JSON.parse(body);
          this.onCommand?.(command);
        } catch {
          // Bilibili occasionally sends non-JSON payloads.
        }
      }
    }
  }

  close(reason) {
    clearInterval(this.heartbeatTimer);
    if (this.ws && this.ws.readyState <= WebSocket.OPEN) {
      this.ws.close(1000, reason || 'closed');
    }
  }
}

async function start() {
  const service = new LiveRecordService();
  await service.init();
  const vite = DEV_MODE ? await createViteMiddleware() : null;
  const port = getRuntimePort(service.settings.serverPort);
  service.currentPort = port;

  const server = http.createServer((request, response) => {
    handleRequest(service, vite, port, request, response).catch((error) => {
      writeJson(response, error.statusCode || 500, { error: error.message || String(error) });
    });
  });

  const url = `http://${HOST}:${port}`;
  server.on('error', (error) => {
    if (error.code === 'EADDRINUSE') {
      if (OPEN_BROWSER) {
        openUrl(url);
      }
      console.log(`端口 ${port} 已被占用，已尝试打开现有 WebUI: ${url}`);
      process.exit(0);
      return;
    }
    throw error;
  });

  server.listen(port, HOST, () => {
    console.log(`哔哩录播 2K WebUI 已启动: ${url}`);
    console.log('浏览器关闭后，保持这个 Node 进程运行即可继续监听/录制。');
    if (OPEN_BROWSER && service.settings.openBrowserOnStart) {
      setTimeout(() => openUrl(url), 300);
    }
  });

  const shutdown = () => {
    service.shutdown();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1500).unref();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

async function createViteMiddleware() {
  const { createServer } = await import('vite');
  const vite = await createServer({
    server: { middlewareMode: true },
    appType: 'spa'
  });
  return vite;
}

async function handleRequest(service, vite, port, request, response) {
  const parsed = new URL(request.url || '/', `http://${request.headers.host || `${HOST}:${port}`}`);
  if (parsed.pathname.startsWith('/api/')) {
    await handleApi(service, parsed, port, request, response);
    return;
  }

  if (vite) {
    await serveVite(vite, parsed.pathname, request, response);
    return;
  }

  await serveStatic(parsed.pathname, response);
}

async function handleApi(service, parsed, port, request, response) {
  const pathname = parsed.pathname;
  if (!isTrustedApiRequest(request, port)) {
    writeJson(response, 403, { error: 'Forbidden' });
    return;
  }
  if (request.method === 'GET' && pathname === '/api/state') {
    writeJson(response, 200, service.getState());
    return;
  }

  if (request.method === 'GET' && pathname === '/api/image') {
    await service.proxyImage(parsed.searchParams.get('url'), response);
    return;
  }

  if (request.method === 'GET' && pathname === '/api/media') {
    await service.serveMedia(parsed.searchParams.get('path'), request, response);
    return;
  }

  if (request.method === 'GET' && pathname.startsWith('/api/preview/')) {
    await service.servePreview(parsed, request, response);
    return;
  }

  if (request.method === 'GET' && pathname === '/api/tray/state') {
    const afterSeq = Number(parsed.searchParams.get('after') || 0);
    writeText(response, 200, service.getTrayStateText(afterSeq));
    return;
  }

  if (request.method === 'GET' && pathname === '/api/events') {
    response.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no'
    });
    service.addClient(response);
    return;
  }

  if (request.method !== 'POST') {
    writeJson(response, 405, { error: 'Method not allowed' });
    return;
  }

  const body = await readJsonBody(request);
  const routes = {
    '/api/auth/qr/start': () => service.startQrLogin(),
    '/api/auth/qr/cancel': () => service.cancelQrLogin(),
    '/api/settings/choose-output-dir': () => service.chooseOutputDir(),
    '/api/settings/save': () => service.saveSettings(body.settings || body),
    '/api/rooms/add': () => service.addRoom(body.roomId),
    '/api/rooms/remove': () => service.removeRoom(body.roomId),
    '/api/rooms/refresh': () => service.refreshRoom(body.roomId, { silent: Boolean(body.silent) }),
    '/api/rooms/monitor': () => service.setMonitoring(body.roomId, body.enabled),
    '/api/rooms/record/start': () => service.startRecording(body.roomId, false),
    '/api/rooms/record/stop': () => service.stopRecording(body.roomId),
    '/api/rooms/preview/start': () => service.startPreview(body.roomId),
    '/api/rooms/burn': () => service.startBurnDanmaku(body.roomId, body.options || {}),
    '/api/rooms/subtitles': () => service.prepareDanmakuForRoom(body.roomId, body.options || {}),
    '/api/export/subtitles': () => service.prepareSubtitleExport(body),
    '/api/export/clip': () => service.exportClip(body),
    '/api/recordings/scan': () => service.refreshRecordingLibrary(),
    '/api/logs/clear': () => service.clearLogs(),
    '/api/shell/open-output': () => service.openOutputDir(),
    '/api/shell/open-path-dir': () => service.openPathDir(body.path),
    '/api/shell/open-config': () => service.openConfigDir(),
    '/api/update/check': () => service.checkUpdate(),
    '/api/update/download': () => service.downloadUpdateOnly(),
    '/api/update/apply': () => service.applyUpdate(),
    '/api/update/queue': () => service.queueUpdateAfterJobs(),
    '/api/system/startup': () => service.setStartup(body.enabled),
    '/api/system/test-notification': () => service.testNotification(),
    '/api/system/shutdown': () => service.requestShutdown()
  };

  const action = routes[pathname];
  if (!action) {
    writeJson(response, 404, { error: 'Not found' });
    return;
  }

  try {
    const result = await action();
    writeJson(response, 200, result === undefined ? { ok: true } : result);
  } catch (error) {
    service.log('error', error.message || String(error));
    writeJson(response, 500, { error: error.message || String(error) });
  }
}

async function readJsonBody(request) {
  const chunks = [];
  let totalBytes = 0;
  for await (const chunk of request) {
    totalBytes += chunk.length;
    if (totalBytes > MAX_JSON_BODY_BYTES) {
      const error = new Error('请求体过大。');
      error.statusCode = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString('utf8').trim();
  if (!raw) {
    return {};
  }
  try {
    return JSON.parse(raw);
  } catch {
    const error = new Error('请求体不是有效 JSON。');
    error.statusCode = 400;
    throw error;
  }
}

function isTrustedApiRequest(request, port) {
  const fetchSite = String(request.headers['sec-fetch-site'] || '').toLowerCase();
  if (fetchSite && fetchSite !== 'same-origin' && fetchSite !== 'none') {
    return false;
  }
  const host = request.headers.host || `${HOST}:${port}`;
  const origin = request.headers.origin;
  if (origin && !isAllowedWebOrigin(origin, host, port)) {
    return false;
  }
  const referer = request.headers.referer;
  if (!origin && referer && !isAllowedWebOrigin(referer, host, port)) {
    return false;
  }
  return true;
}

function isAllowedWebOrigin(value, hostHeader, port) {
  let target;
  try {
    target = new URL(value);
  } catch {
    return false;
  }
  if (!['http:', 'https:'].includes(target.protocol)) {
    return false;
  }
  const originPort = Number(target.port || (target.protocol === 'https:' ? 443 : 80));
  const requestHost = normalizeHostHeader(hostHeader);
  if (requestHost.hostname && target.hostname.toLowerCase() === requestHost.hostname && originPort === requestHost.port) {
    return true;
  }
  return isLoopbackHost(target.hostname) && originPort === Number(port || DEFAULT_PORT);
}

function normalizeHostHeader(hostHeader) {
  const raw = String(hostHeader || '').trim();
  if (!raw) {
    return { hostname: '', port: DEFAULT_PORT };
  }
  try {
    const parsed = new URL(`http://${raw}`);
    return {
      hostname: parsed.hostname.toLowerCase(),
      port: Number(parsed.port || DEFAULT_PORT)
    };
  } catch {
    return { hostname: '', port: DEFAULT_PORT };
  }
}

function isLoopbackHost(hostname) {
  const host = String(hostname || '').toLowerCase();
  return host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]';
}

async function serveVite(vite, pathname, request, response) {
  await new Promise((resolve, reject) => {
    let settled = false;
    vite.middlewares(request, response, (error) => {
      if (settled) {
        return;
      }
      settled = true;
      if (error) {
        reject(error);
      } else {
        resolve();
      }
    });
    response.on('finish', () => {
      if (!settled) {
        settled = true;
        resolve();
      }
    });
  });

  if (response.writableEnded) {
    return;
  }

  const indexPath = path.join(APP_ROOT, 'index.html');
  const rawHtml = await fsp.readFile(indexPath, 'utf8');
  const html = await vite.transformIndexHtml(pathname, rawHtml);
  response.writeHead(200, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-cache'
  });
  response.end(html);
}

function writeJson(response, statusCode, payload) {
  response.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store'
  });
  response.end(JSON.stringify(payload));
}

function writeText(response, statusCode, text, contentType = 'text/plain; charset=utf-8') {
  response.writeHead(statusCode, {
    'Content-Type': contentType,
    'Cache-Control': 'no-store'
  });
  response.end(text);
}

async function serveStatic(pathname, response) {
  const root = DIST_ROOT;
  const decodedPath = decodeURIComponent(pathname);
  const safePath = decodedPath === '/' ? '/index.html' : decodedPath;
  let filePath = path.resolve(root, `.${safePath}`);

  if (!filePath.startsWith(`${root}${path.sep}`) && filePath !== root) {
    writeJson(response, 403, { error: 'Forbidden' });
    return;
  }

  try {
    const stat = await fsp.stat(filePath);
    if (stat.isDirectory()) {
      filePath = path.join(filePath, 'index.html');
    }
  } catch {
    filePath = path.join(root, 'index.html');
  }

  try {
    const data = await fsp.readFile(filePath);
    response.writeHead(200, {
      'Content-Type': mimeType(filePath),
      'Cache-Control': filePath.endsWith('index.html') ? 'no-cache' : 'public, max-age=31536000, immutable'
    });
    response.end(data);
  } catch (error) {
    writeJson(response, 404, { error: `dist 未构建或文件不存在：${error.message}` });
  }
}

function unpackDanmakuPackets(buffer) {
  const packets = [];
  let offset = 0;
  while (offset + 16 <= buffer.length) {
    const packetLength = buffer.readUInt32BE(offset);
    const headerLength = buffer.readUInt16BE(offset + 4);
    const version = buffer.readUInt16BE(offset + 6);
    const operation = buffer.readUInt32BE(offset + 8);
    const sequence = buffer.readUInt32BE(offset + 12);
    if (packetLength <= 0 || offset + packetLength > buffer.length) {
      break;
    }
    packets.push({
      version,
      operation,
      sequence,
      body: buffer.subarray(offset + headerLength, offset + packetLength)
    });
    offset += packetLength;
  }
  return packets;
}

function decodeDanmakuPacket(packet) {
  if (packet.version === 0 || packet.version === 1) {
    return [packet.body.toString('utf8')].filter(Boolean);
  }
  if (packet.version === 2) {
    const inflated = zlib.inflateSync(packet.body);
    return unpackDanmakuPackets(inflated).flatMap(decodeDanmakuPacket);
  }
  if (packet.version === 3) {
    const decompressed = zlib.brotliDecompressSync(packet.body);
    return unpackDanmakuPackets(decompressed).flatMap(decodeDanmakuPacket);
  }
  return [];
}

function safeDecodeDanmakuPacket(packet) {
  try {
    return decodeDanmakuPacket(packet);
  } catch {
    return [];
  }
}

function decodeAuthReply(packet) {
  const text = packet.body.toString('utf8').trim();
  if (text) {
    try {
      return JSON.parse(text);
    } catch {
      return { code: text };
    }
  }
  if (packet.body.length >= 4) {
    return { code: packet.body.readUInt32BE(0) };
  }
  return { code: 0 };
}

async function requestBiliJsonWithCookies(url) {
  const response = await fetch(url, {
    headers: {
      Accept: 'application/json, text/plain, */*',
      Referer: 'https://passport.bilibili.com/',
      Origin: 'https://passport.bilibili.com',
      'User-Agent': USER_AGENT
    }
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${text.slice(0, 120)}`);
  }
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`接口返回不是 JSON：${text.slice(0, 120)}`);
  }
  return {
    json,
    cookies: getSetCookieHeaders(response.headers)
  };
}

function getSetCookieHeaders(headers) {
  if (typeof headers.getSetCookie === 'function') {
    return headers.getSetCookie();
  }
  const combined = headers.get('set-cookie');
  if (!combined) {
    return [];
  }
  return splitSetCookieHeader(combined);
}

function splitSetCookieHeader(header) {
  return String(header)
    .split(/,(?=\s*[^;,=\s]+=[^;]+)/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function mergeCookieString(existingCookie, setCookieHeaders) {
  const jar = new Map();
  for (const part of String(existingCookie || '').split(';')) {
    const trimmed = part.trim();
    const index = trimmed.indexOf('=');
    if (index > 0) {
      jar.set(trimmed.slice(0, index), trimmed.slice(index + 1));
    }
  }

  for (const header of setCookieHeaders || []) {
    const pair = String(header).split(';')[0]?.trim();
    const index = pair.indexOf('=');
    if (index > 0) {
      jar.set(pair.slice(0, index), pair.slice(index + 1));
    }
  }

  return Array.from(jar.entries())
    .filter(([, value]) => value !== '')
    .map(([key, value]) => `${key}=${value}`)
    .join('; ');
}

function danmakuCommandType(command) {
  return String(command?.cmd || 'UNKNOWN').split(':')[0] || 'UNKNOWN';
}

function normalizeDanmakuEvent(command, startedAt) {
  const type = danmakuCommandType(command);
  const time = Math.max(0, (Date.now() - startedAt) / 1000);

  if (type === 'DANMU_MSG') {
    const info = command.info || [];
    return {
      type: 'danmaku',
      time,
      text: String(info[1] || ''),
      user: String(info[2]?.[1] || ''),
      color: Number(info[0]?.[3] || 0xffffff)
    };
  }

  if (type === 'SEND_GIFT' || type === 'COMBO_SEND') {
    const data = command.data || {};
    return {
      type: 'gift',
      time,
      user: String(data.uname || data.username || ''),
      giftName: String(data.giftName || data.gift_name || '礼物'),
      count: Number(data.num || data.combo_num || data.combo_count || 1),
      price: Number(data.price || data.discount_price || 0) / 1000
    };
  }

  if (type === 'SUPER_CHAT_MESSAGE' || type === 'SUPER_CHAT_MESSAGE_JPN') {
    const data = command.data || {};
    return {
      type: 'superchat',
      time,
      user: String(data.user_info?.uname || data.uname || ''),
      text: String(data.message || ''),
      price: Number(data.price || 0),
      duration: Number(data.time || data.duration || 60)
    };
  }

  if (type === 'GUARD_BUY' || type === 'USER_TOAST_MSG') {
    const data = command.data || {};
    return {
      type: 'guard',
      time,
      user: String(data.username || data.uname || data.user_show_info?.uname || ''),
      giftName: String(data.gift_name || data.role_name || guardName(data.guard_level)),
      count: Number(data.num || 1),
      price: Number(data.price || 0) / 1000
    };
  }

  return null;
}

const DEFAULT_DANMAKU_STYLE = {
  playWidth: 1920,
  playHeight: 1080,
  fontFamily: 'Microsoft YaHei',
  danmakuFontSize: 38,
  danmakuOutline: 2,
  danmakuLanes: 8,
  danmakuDuration: 8,
  danmakuTop: 36,
  danmakuLineHeight: 46,
  boxFontSize: 30,
  panelLeft: 34,
  superChatLanes: 3,
  superChatBottom: 618,
  giftLanes: 4,
  giftBottom: 934
};

async function readDanmakuEvents(danmakuPath) {
  const raw = await fsp.readFile(danmakuPath, 'utf8').catch((error) => {
    if (error.code === 'ENOENT') {
      return '';
    }
    throw error;
  });
  return raw
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

async function ensureDanmakuCss(cssPath) {
  try {
    await fsp.access(cssPath);
  } catch {
    await fsp.writeFile(cssPath, createDefaultDanmakuCss(), 'utf8');
  }
  return cssPath;
}

async function readDanmakuStyle(cssPath) {
  const raw = await fsp.readFile(cssPath, 'utf8').catch(() => '');
  return normalizeDanmakuStyle(parseCssVariables(raw));
}

function createDefaultDanmakuCss() {
  return `/* BiliRecord2K 弹幕烧录样式。修改后重新生成字幕/烧录即可生效。 */
:root {
  --play-width: 1920;
  --play-height: 1080;
  --font-family: Microsoft YaHei;
  --danmaku-font-size: 38;
  --danmaku-outline: 2;
  --danmaku-lanes: 8;
  --danmaku-duration: 8;
  --danmaku-top: 36;
  --danmaku-line-height: 46;
  --box-font-size: 30;
  --panel-left: 34;
  --superchat-lanes: 3;
  --superchat-bottom: 618;
  --gift-lanes: 4;
  --gift-bottom: 934;
}
`;
}

function parseCssVariables(css) {
  const values = {};
  const pattern = /--([a-z0-9-]+)\s*:\s*([^;]+);/gi;
  let match;
  while ((match = pattern.exec(String(css || '')))) {
    values[match[1]] = match[2].trim();
  }
  return values;
}

function normalizeDanmakuStyle(values = {}) {
  const pickNumber = (key, fallback, min, max) => clamp(Number(values[key] ?? fallback), min, max);
  const fontFamily = String(values['font-family'] || DEFAULT_DANMAKU_STYLE.fontFamily)
    .replace(/["']/g, '')
    .trim();
  return {
    playWidth: pickNumber('play-width', DEFAULT_DANMAKU_STYLE.playWidth, 640, 7680),
    playHeight: pickNumber('play-height', DEFAULT_DANMAKU_STYLE.playHeight, 360, 4320),
    fontFamily: fontFamily || DEFAULT_DANMAKU_STYLE.fontFamily,
    danmakuFontSize: pickNumber('danmaku-font-size', DEFAULT_DANMAKU_STYLE.danmakuFontSize, 12, 96),
    danmakuOutline: pickNumber('danmaku-outline', DEFAULT_DANMAKU_STYLE.danmakuOutline, 0, 8),
    danmakuLanes: Math.round(pickNumber('danmaku-lanes', DEFAULT_DANMAKU_STYLE.danmakuLanes, 1, 24)),
    danmakuDuration: pickNumber('danmaku-duration', DEFAULT_DANMAKU_STYLE.danmakuDuration, 2, 20),
    danmakuTop: pickNumber('danmaku-top', DEFAULT_DANMAKU_STYLE.danmakuTop, 0, 2000),
    danmakuLineHeight: pickNumber('danmaku-line-height', DEFAULT_DANMAKU_STYLE.danmakuLineHeight, 16, 180),
    boxFontSize: pickNumber('box-font-size', DEFAULT_DANMAKU_STYLE.boxFontSize, 12, 80),
    panelLeft: pickNumber('panel-left', DEFAULT_DANMAKU_STYLE.panelLeft, 0, 2000),
    superChatLanes: Math.round(pickNumber('superchat-lanes', DEFAULT_DANMAKU_STYLE.superChatLanes, 1, 10)),
    superChatBottom: pickNumber('superchat-bottom', DEFAULT_DANMAKU_STYLE.superChatBottom, 0, 4000),
    giftLanes: Math.round(pickNumber('gift-lanes', DEFAULT_DANMAKU_STYLE.giftLanes, 1, 16)),
    giftBottom: pickNumber('gift-bottom', DEFAULT_DANMAKU_STYLE.giftBottom, 0, 4000)
  };
}

function prepareAssEvents(events, options = {}) {
  const overlayMode = normalizeBurnOverlayMode(options.overlayMode);
  const startTime = Number(options.startTime);
  const endTime = Number(options.endTime);
  const hasStart = Number.isFinite(startTime);
  const hasEnd = Number.isFinite(endTime);
  return [...events]
    .filter((event) => {
      if (overlayMode === 'danmaku' && event.type !== 'danmaku') {
        return false;
      }
      if (!['danmaku', 'superchat', 'gift', 'guard'].includes(event.type)) {
        return false;
      }
      const eventStart = Number(event.time || 0);
      const eventEnd = eventStart + getDanmakuEventDuration(event);
      if (hasStart && eventEnd < startTime) {
        return false;
      }
      if (hasEnd && eventStart > endTime) {
        return false;
      }
      return true;
    })
    .map((event) => ({
      ...event,
      time: options.shiftTime && hasStart ? Math.max(0, Number(event.time || 0) - startTime) : Number(event.time || 0)
    }))
    .sort((a, b) => a.time - b.time);
}

function getDanmakuEventDuration(event) {
  if (event.type === 'superchat') {
    return clamp(Number(event.duration || 60), 30, 180);
  }
  if (event.type === 'danmaku') {
    return 8;
  }
  return event.type === 'guard' ? 8 : 5;
}

function createAss(events, options = {}) {
  const overlayMode = normalizeBurnOverlayMode(options.overlayMode);
  const style = normalizeDanmakuStyle(options.style);
  const sorted = prepareAssEvents(events, {
    overlayMode,
    startTime: options.startTime,
    endTime: options.endTime,
    shiftTime: options.shiftTime
  });
  const lines = [
    '[Script Info]',
    'ScriptType: v4.00+',
    'WrapStyle: 2',
    'ScaledBorderAndShadow: yes',
    `PlayResX: ${style.playWidth}`,
    `PlayResY: ${style.playHeight}`,
    '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    `Style: Danmaku,${style.fontFamily},${style.danmakuFontSize},&H00FFFFFF,&H000000FF,&H96000000,&H64000000,0,0,0,0,100,100,0,0,1,${style.danmakuOutline},0,7,20,20,20,1`,
    `Style: BoxText,${style.fontFamily},${style.boxFontSize},&H00FFFFFF,&H000000FF,&H32000000,&H00000000,0,0,0,0,100,100,0,0,1,1,0,7,0,0,0,1`,
    'Style: Shape,Arial,24,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,0,0,7,0,0,0,1',
    '',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text'
  ];

  const danmakuRows = Array(style.danmakuLanes).fill(0);
  const scRows = Array(style.superChatLanes).fill(0);
  const giftRows = Array(style.giftLanes).fill(0);

  for (const event of sorted) {
    if (event.type === 'danmaku') {
      const duration = style.danmakuDuration;
      const row = chooseLane(danmakuRows, event.time, duration);
      const y = style.danmakuTop + row * style.danmakuLineHeight;
      const width = estimateTextWidth(event.text, style.danmakuFontSize);
      const color = assColorFromRgb(event.color || 0xffffff);
      lines.push(
        dialogue(
          1,
          event.time,
          event.time + duration,
          'Danmaku',
          `{\\1c${color}\\move(1980,${y},-${width},${y})}${assEscape(event.text)}`
        )
      );
      continue;
    }

    if (event.type === 'superchat') {
      const duration = clamp(Number(event.duration || 60), 30, 180);
      const row = chooseLane(scRows, event.time, duration);
      const x = style.panelLeft;
      const y = style.superChatBottom - row * 132;
      const palette = superChatPalette(event.price || 0);
      const title = `${event.user || '用户'}  ￥${event.price || 0}`;
      lines.push(drawRect(7, event.time, event.time + duration, x, y, 570, 42, palette.header));
      lines.push(drawRect(6, event.time, event.time + duration, x, y + 42, 570, 88, palette.body));
      lines.push(
        dialogue(
          8,
          event.time,
          event.time + duration,
          'BoxText',
          `{\\fad(120,260)\\pos(${x + 18},${y + 8})\\fs27\\b1}${assEscape(title)}`
        )
      );
      lines.push(
        dialogue(
          8,
          event.time,
          event.time + duration,
          'BoxText',
          `{\\fad(120,260)\\pos(${x + 18},${y + 54})\\fs24\\b0}${assEscape(wrapText(event.text, 28, 2))}`
        )
      );
      continue;
    }

    if (event.type === 'gift' || event.type === 'guard') {
      const duration = event.type === 'guard' ? 8 : 5;
      const row = chooseLane(giftRows, event.time, duration);
      const x = style.panelLeft;
      const y = style.giftBottom - row * 56;
      const label =
        event.type === 'guard'
          ? `${event.user || '用户'} 开通 ${event.giftName || '舰长'} x${event.count || 1}`
          : `${event.user || '用户'} 送出 ${event.giftName || '礼物'} x${event.count || 1}`;
      lines.push(drawRect(5, event.time, event.time + duration, x, y, 500, 44, '&H8A2A1B12&'));
      lines.push(
        dialogue(
          6,
          event.time,
          event.time + duration,
          'BoxText',
          `{\\fad(120,260)\\pos(${x + 16},${y + 8})\\fs24}${assEscape(truncateText(label, 36))}`
        )
      );
    }
  }

  return `${lines.join('\n')}\n`;
}

function createRecordingArgs({ streamUrl, headers, outputPath, maxDurationSec }) {
  const args = [
    '-hide_banner',
    '-stats',
    '-y',
    '-rw_timeout',
    '30000000',
    '-reconnect',
    '1',
    '-reconnect_streamed',
    '1',
    '-reconnect_at_eof',
    '1',
    '-reconnect_on_network_error',
    '1',
    '-reconnect_on_http_error',
    '4xx,5xx',
    '-reconnect_delay_max',
    '10',
    '-user_agent',
    USER_AGENT,
    '-headers',
    headers,
    '-i',
    streamUrl
  ];
  if (Number.isFinite(Number(maxDurationSec)) && Number(maxDurationSec) > 0) {
    args.push('-t', formatFfmpegSeconds(maxDurationSec));
  }
  args.push(
    '-ignore_unknown',
    '-map',
    '0:v:0',
    '-map',
    '0:a?',
    '-c',
    'copy',
    '-dn',
    '-sn',
    '-f',
    'matroska',
    outputPath
  );
  return args;
}

function createMp4FinalizeArgs({ inputPath, outputPath, streamCodec }) {
  const args = [
    '-hide_banner',
    '-y',
    '-fflags',
    '+genpts',
    '-i',
    inputPath,
    '-ignore_unknown',
    '-map',
    '0:v:0',
    '-map',
    '0:a?',
    '-c',
    'copy',
    '-dn',
    '-sn',
    '-avoid_negative_ts',
    'make_zero'
  ];
  if (isHevcCodec(streamCodec)) {
    args.push('-tag:v', 'hvc1');
  }
  args.push('-movflags', '+faststart', outputPath);
  return args;
}

function createBurnArgs({ cleanPath, assPath, burnedPath, codec, crf, container, startTime, duration }) {
  const args = ['-hide_banner', '-y', '-i', cleanPath];
  if (Number.isFinite(Number(startTime)) && Number(startTime) > 0) {
    args.push('-ss', formatFfmpegSeconds(startTime));
  }
  if (Number.isFinite(Number(duration)) && Number(duration) > 0) {
    args.push('-t', formatFfmpegSeconds(duration));
  }
  args.push('-vf', `ass='${escapeFilterPath(assPath)}'`, '-c:v', codec || 'libx265');

  if ((codec || '').includes('nvenc')) {
    args.push('-preset', 'p5', '-cq', String(crf), '-b:v', '0');
  } else if ((codec || '').includes('qsv')) {
    args.push('-global_quality', String(crf));
  } else if ((codec || '').includes('amf')) {
    args.push('-quality', 'balanced', '-qp_i', String(crf), '-qp_p', String(crf));
  } else {
    args.push('-preset', 'medium', '-crf', String(crf));
  }

  if (container === 'mp4') {
    if (isHevcCodec(codec)) {
      args.push('-tag:v', 'hvc1');
    }
    args.push('-movflags', '+faststart');
  }

  args.push('-c:a', 'copy', burnedPath);
  return args;
}

function createClipCopyArgs({ cleanPath, outputPath, startTime, duration, container }) {
  const args = [
    '-hide_banner',
    '-y',
    '-ss',
    formatFfmpegSeconds(startTime),
    '-i',
    cleanPath,
    '-t',
    formatFfmpegSeconds(duration),
    '-map',
    '0',
    '-c',
    'copy',
    '-avoid_negative_ts',
    'make_zero'
  ];
  if (container === 'mp4') {
    args.push('-movflags', '+faststart');
  }
  args.push(outputPath);
  return args;
}

function createConcatCopyArgs({ concatPath, outputPath, container }) {
  const args = ['-hide_banner', '-y', '-f', 'concat', '-safe', '0', '-i', concatPath, '-map', '0', '-c', 'copy'];
  if (container === 'mp4') {
    args.push('-movflags', '+faststart');
  }
  args.push(outputPath);
  return args;
}

async function writeConcatFile(concatPath, filePaths) {
  const body = filePaths.map((filePath) => `file '${escapeConcatPath(filePath)}'`).join('\n');
  await fsp.writeFile(concatPath, `${body}\n`, 'utf8');
}

function escapeConcatPath(filePath) {
  return String(filePath).replace(/\\/g, '/').replace(/'/g, "'\\''");
}

async function mergeDanmakuFiles(segments, outputPath) {
  const lines = [];
  let offset = 0;
  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index];
    const events = await readDanmakuEvents(segment.danmakuPath);
    for (const event of events) {
      lines.push(JSON.stringify({ ...event, time: Math.max(0, Number(event.time || 0) + offset) }));
    }
    offset += getSegmentDurationForMerge(segment, segments[index + 1]);
  }
  await fsp.writeFile(outputPath, lines.length ? `${lines.join('\n')}\n` : '', 'utf8');
}

function getSegmentDurationForMerge(segment, nextSegment) {
  const duration = Number(segment.durationSec || 0);
  if (Number.isFinite(duration) && duration > 0) {
    return duration;
  }
  if (nextSegment?.startedAt && segment.startedAt) {
    return Math.max(0, (Number(nextSegment.startedAt) - Number(segment.startedAt)) / 1000);
  }
  return 0;
}

async function copyFirstExistingFile(candidates, outputPath, fallbackText) {
  for (const candidate of candidates) {
    try {
      if (candidate && fs.existsSync(candidate)) {
        await fsp.copyFile(candidate, outputPath);
        return outputPath;
      }
    } catch {
      // Keep looking.
    }
  }
  await fsp.writeFile(outputPath, fallbackText, 'utf8');
  return outputPath;
}

function drawRect(layer, start, end, x, y, width, height, color) {
  const shape = `m 0 0 l ${width} 0 l ${width} ${height} l 0 ${height}`;
  return dialogue(
    layer,
    start,
    end,
    'Shape',
    `{\\fad(120,260)\\p1\\pos(${x},${y})\\bord0\\shad0\\1c${color}}${shape}`
  );
}

function dialogue(layer, start, end, style, text) {
  return `Dialogue: ${layer},${assTime(start)},${assTime(end)},${style},,0,0,0,,${text}`;
}

function assTime(seconds) {
  const safe = Math.max(0, seconds);
  const h = Math.floor(safe / 3600);
  const m = Math.floor((safe % 3600) / 60);
  const s = Math.floor(safe % 60);
  const cs = Math.floor((safe - Math.floor(safe)) * 100);
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(cs).padStart(2, '0')}`;
}

function assEscape(text) {
  return String(text || '')
    .replace(/[{}]/g, '')
    .replace(/\r?\n/g, '\\N');
}

function assColorFromRgb(rgb) {
  const value = Number(rgb) || 0xffffff;
  const r = (value >> 16) & 0xff;
  const g = (value >> 8) & 0xff;
  const b = value & 0xff;
  return `&H00${hex2(b)}${hex2(g)}${hex2(r)}&`;
}

function hex2(value) {
  return Number(value).toString(16).padStart(2, '0').toUpperCase();
}

function superChatPalette(price) {
  if (price >= 1000) {
    return { header: '&H002D35E5&', body: '&H00503D8B&' };
  }
  if (price >= 500) {
    return { header: '&H00344BD9&', body: '&H00475AAE&' };
  }
  if (price >= 100) {
    return { header: '&H0000A5FF&', body: '&H002B8FE6&' };
  }
  if (price >= 50) {
    return { header: '&H0000C8B8&', body: '&H0033B9B0&' };
  }
  return { header: '&H00D88B2D&', body: '&H00B87931&' };
}

function chooseLane(lanes, start, duration) {
  let best = 0;
  for (let index = 0; index < lanes.length; index += 1) {
    if (lanes[index] <= start) {
      best = index;
      break;
    }
    if (lanes[index] < lanes[best]) {
      best = index;
    }
  }
  lanes[best] = start + duration;
  return best;
}

function estimateTextWidth(text, fontSize) {
  const length = Array.from(String(text || '')).reduce((sum, char) => {
    return sum + (/[\u4e00-\u9fa5]/.test(char) ? 1 : 0.58);
  }, 0);
  return Math.ceil(length * fontSize);
}

function truncateText(text, max) {
  const chars = Array.from(String(text || ''));
  if (chars.length <= max) {
    return text || '';
  }
  return `${chars.slice(0, max - 1).join('')}…`;
}

function wrapText(text, maxCharsPerLine, maxLines) {
  const chars = Array.from(String(text || ''));
  const lines = [];
  for (let index = 0; index < chars.length && lines.length < maxLines; index += maxCharsPerLine) {
    lines.push(chars.slice(index, index + maxCharsPerLine).join(''));
  }
  if (chars.length > maxCharsPerLine * maxLines && lines.length > 0) {
    lines[lines.length - 1] = `${Array.from(lines[lines.length - 1])
      .slice(0, maxCharsPerLine - 1)
      .join('')}…`;
  }
  return lines.join('\\N');
}

function sanitizeFilename(name) {
  return String(name || 'recording')
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 160);
}

function sanitizeHeaderValue(value) {
  return String(value || '').replace(/[\r\n]/g, '').trim();
}

function createImageProxyHeaders(target, cookie) {
  const headers = {
    Accept: 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
    'Cache-Control': 'no-cache',
    Pragma: 'no-cache',
    'User-Agent': USER_AGENT
  };
  if (isBilibiliHost(target.hostname)) {
    headers.Referer = 'https://live.bilibili.com/';
    const safeCookie = sanitizeHeaderValue(cookie);
    if (safeCookie) {
      headers.Cookie = safeCookie;
    }
  }
  return headers;
}

function createPreviewProxyHeaders(target, cookie, rangeHeader) {
  const headers = {
    Accept: '*/*',
    'Cache-Control': 'no-cache',
    Pragma: 'no-cache',
    'User-Agent': USER_AGENT
  };
  if (isBilibiliHost(target.hostname)) {
    headers.Referer = 'https://live.bilibili.com/';
    const safeCookie = sanitizeHeaderValue(cookie);
    if (safeCookie) {
      headers.Cookie = safeCookie;
    }
  }
  const range = sanitizeHeaderValue(rangeHeader);
  if (range) {
    headers.Range = range;
  }
  return headers;
}

function createPreviewProxyPath(token, targetUrl) {
  return `/api/preview/${encodeURIComponent(token)}/${encodePreviewUrl(targetUrl)}`;
}

function encodePreviewUrl(value) {
  return Buffer.from(String(value || ''), 'utf8').toString('base64url');
}

function decodePreviewUrl(value) {
  return Buffer.from(String(value || ''), 'base64url').toString('utf8');
}

function isPreviewPlaylist(target, body) {
  const pathname = target.pathname.toLowerCase();
  if (pathname.endsWith('.m3u8')) {
    return true;
  }
  const prefix = body.subarray(0, 16).toString('utf8');
  return prefix.startsWith('#EXTM3U');
}

function rewriteHlsManifest(text, baseUrl, token) {
  return String(text || '')
    .split(/\r?\n/)
    .map((line) => rewriteHlsManifestLine(line, baseUrl, token))
    .join('\n');
}

function rewriteHlsManifestLine(line, baseUrl, token) {
  const trimmed = String(line || '').trim();
  if (!trimmed) {
    return line;
  }
  if (trimmed.startsWith('#')) {
    return line.replace(/URI="([^"]+)"/g, (match, uri) => {
      const resolved = resolveHlsResourceUrl(uri, baseUrl);
      return resolved ? `URI="${createPreviewProxyPath(token, resolved)}"` : match;
    });
  }
  const resolved = resolveHlsResourceUrl(trimmed, baseUrl);
  return resolved ? createPreviewProxyPath(token, resolved) : line;
}

function resolveHlsResourceUrl(value, baseUrl) {
  const text = String(value || '').trim();
  if (!text || /^(?:data|blob):/i.test(text)) {
    return '';
  }
  try {
    return new URL(text, baseUrl).toString();
  } catch {
    return '';
  }
}

function previewMimeType(pathname) {
  const ext = path.extname(String(pathname || '')).toLowerCase();
  return (
    {
      '.m3u8': 'application/vnd.apple.mpegurl',
      '.m4s': 'video/iso.segment',
      '.mp4': 'video/mp4',
      '.ts': 'video/mp2t',
      '.aac': 'audio/aac',
      '.mp3': 'audio/mpeg',
      '.webvtt': 'text/vtt'
    }[ext] || 'application/octet-stream'
  );
}

function isBilibiliHost(hostname) {
  const host = String(hostname || '').toLowerCase();
  return (
    host === 'bilibili.com' ||
    host.endsWith('.bilibili.com') ||
    host === 'bilivideo.com' ||
    host.endsWith('.bilivideo.com') ||
    host === 'hdslb.com' ||
    host.endsWith('.hdslb.com') ||
    host === 'biliimg.com' ||
    host.endsWith('.biliimg.com')
  );
}

function getCookieValue(cookie, key) {
  for (const part of String(cookie || '').split(';')) {
    const trimmed = part.trim();
    const index = trimmed.indexOf('=');
    if (index > 0 && trimmed.slice(0, index) === key) {
      return trimmed.slice(index + 1);
    }
  }
  return '';
}

function createBiliError(label, payload) {
  const code = Number(payload?.code);
  const message = String(payload?.message || payload?.msg || code || '未知错误');
  if (code === -352) {
    return new Error(
      `${label}接口返回 -352：疑似 B 站风控或登录态不足。请到设置页扫码登录；如果已登录，重新扫码刷新 Cookie 后再试。`
    );
  }
  if (code === -101) {
    return new Error(`${label}接口提示账号未登录：请到设置页扫码登录后再试。`);
  }
  return new Error(`${label}接口返回 ${Number.isNaN(code) ? message : code}：${message}`);
}

function normalizeContainer(value) {
  return value === 'mkv' ? 'mkv' : 'mp4';
}

function normalizeContainerStage(value) {
  const stage = String(value || '').trim();
  return ['capturing', 'finalizing', 'ready', 'failed'].includes(stage) ? stage : undefined;
}

function normalizeCommandCounts(value) {
  if (!value || typeof value !== 'object') {
    return {};
  }
  return Object.fromEntries(
    Object.entries(value)
      .map(([key, count]) => [String(key), Number(count || 0)])
      .filter(([key, count]) => key && Number.isFinite(count) && count > 0)
  );
}

function mergeCommandCounts(items) {
  const merged = {};
  for (const item of items || []) {
    for (const [key, count] of Object.entries(normalizeCommandCounts(item))) {
      merged[key] = (merged[key] || 0) + count;
    }
  }
  return merged;
}

function normalizeBurnCodec(value) {
  const codec = String(value || '').trim();
  const supported = new Set(['libx265', 'libx264', 'hevc_nvenc', 'hevc_qsv', 'hevc_amf']);
  return supported.has(codec) ? codec : 'libx265';
}

function normalizeRoomImageMode(value) {
  return value === 'cover' ? 'cover' : 'keyframe';
}

function normalizeBurnOverlayMode(value) {
  return value === 'danmaku' ? 'danmaku' : 'danmaku-gift';
}

function normalizeExportMode(value) {
  return value === 'burn' ? 'burn' : 'clean';
}

function overlayModeLabel(value) {
  return normalizeBurnOverlayMode(value) === 'danmaku' ? '仅弹幕' : '弹幕和礼物';
}

function basenameWithoutExt(url) {
  const value = String(url || '').trim();
  if (!value) {
    return '';
  }
  return value.split('/').pop()?.split('.')[0] || '';
}

function normalizeTargetQn(value) {
  const qn = Number(value || 15000);
  if (!Number.isFinite(qn) || qn <= 0) {
    return 15000;
  }
  return qn === 20000 ? 25000 : qn;
}

function createQnProbeList(value) {
  const targetQn = normalizeTargetQn(value);
  const probes = [targetQn];
  for (const qn of STREAM_QN_PROBES) {
    if (qn <= targetQn) {
      probes.push(qn);
    }
  }
  return Array.from(new Set(probes.filter((qn) => Number.isFinite(qn) && qn > 0)));
}

function getContainerFromPath(filePath) {
  return path.extname(filePath).toLowerCase() === '.mkv' ? 'mkv' : 'mp4';
}

function deriveSiblingPath(filePath, suffix, extension) {
  const parsed = path.parse(filePath);
  const ext = extension || parsed.ext.replace(/^\./, '') || 'mp4';
  const base = parsed.name.replace(/\.clean$/i, '');
  return path.join(parsed.dir, `${base}.${suffix}.${ext}`);
}

function deriveBurnedPath(filePath, overlayMode) {
  return deriveSiblingPath(filePath, normalizeBurnOverlayMode(overlayMode) === 'danmaku' ? 'danmaku-only' : 'danmaku');
}

function deriveClipPath(cleanPath, outputDir, mode, startTime, endTime) {
  const parsed = path.parse(cleanPath);
  const container = parsed.ext.replace(/^\./, '') || 'mp4';
  const base = parsed.name.replace(/\.clean$/i, '');
  const suffix = createClipSuffix(startTime, endTime, mode);
  return path.join(outputDir, `${base}.${suffix}.${container}`);
}

function replaceExtension(filePath, extension) {
  const parsed = path.parse(filePath);
  return path.join(parsed.dir, `${parsed.name}${extension}`);
}

function isPathInsideDirectory(filePath, directory) {
  const relative = path.relative(path.resolve(directory), path.resolve(filePath));
  return Boolean(relative && !relative.startsWith('..') && !path.isAbsolute(relative));
}

function createClipSuffix(startTime, endTime, mode) {
  const start = safeTimeSlug(startTime);
  const end = Number.isFinite(Number(endTime)) ? safeTimeSlug(endTime) : 'end';
  return `clip_${start}-${end}.${normalizeClipModeName(mode)}`;
}

function normalizeClipModeName(mode) {
  if (mode === 'clean') {
    return 'clean';
  }
  return normalizeBurnOverlayMode(mode) === 'danmaku' ? 'danmaku-only' : 'danmaku';
}

function safeTimeSlug(value) {
  return formatFfmpegSeconds(value).replace('.', '_').replace(/:/g, '');
}

function parseTimeInput(value) {
  if (value === undefined || value === null || value === '') {
    return Number.NaN;
  }
  if (typeof value === 'number') {
    return value;
  }
  const text = String(value).trim();
  if (!text) {
    return Number.NaN;
  }
  if (/^\d+(?:\.\d+)?$/.test(text)) {
    return Number(text);
  }
  const parts = text.split(':').map((part) => Number(part));
  if (parts.some((part) => !Number.isFinite(part) || part < 0) || parts.length > 3) {
    return Number.NaN;
  }
  while (parts.length < 3) {
    parts.unshift(0);
  }
  return parts[0] * 3600 + parts[1] * 60 + parts[2];
}

function formatFfmpegSeconds(value) {
  const safe = Math.max(0, Number(value) || 0);
  return safe.toFixed(3).replace(/0+$/, '').replace(/\.$/, '');
}

function runFfmpegJob(ffmpegPath, args, onStderr) {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpegPath, args, {
      windowsHide: true,
      stdio: ['ignore', 'ignore', 'pipe']
    });
    let stderr = '';
    child.stderr.on('data', (chunk) => {
      const text = chunk.toString('utf8');
      stderr = `${stderr}${text}`.slice(-8000);
      onStderr?.(text);
    });
    child.on('error', reject);
    child.on('close', (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`ffmpeg 退出码 ${code}，信号 ${signal || '-'}：${compactLogLine(stderr)}`));
    });
  });
}

function isHevcCodec(codec) {
  const value = String(codec || '').toLowerCase();
  return value.includes('hevc') || value.includes('h265') || value.includes('x265');
}

function formatTimestamp(date) {
  const pad = (value) => String(value).padStart(2, '0');
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}_${pad(date.getHours())}${pad(
    date.getMinutes()
  )}${pad(date.getSeconds())}`;
}

function formatDurationSeconds(seconds) {
  const total = Math.max(0, Math.round(Number(seconds) || 0));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) {
    return `${h}小时${m}分${s}秒`;
  }
  if (m > 0) {
    return `${m}分${s}秒`;
  }
  return `${s}秒`;
}

function streamScore(stream, settings) {
  const codec = String(stream.codec || '').toLowerCase();
  const hevc = codec.includes('hevc') || codec.includes('h265');
  const avc = codec.includes('avc') || codec.includes('h264');
  const qualityScore = Number(stream.qn || 0) * 1_000_000;
  const codecScore = settings.preferHevc ? (hevc ? 10_000 : avc ? 1_000 : 0) : avc ? 10_000 : hevc ? 1_000 : 0;
  const protocolScore = stream.protocol.includes('hls') ? 500 : 250;
  const formatScore = stream.format.includes('fmp4') ? 200 : stream.format.includes('flv') ? 100 : 0;
  return qualityScore + codecScore + protocolScore + formatScore;
}

function displayCodecName(codec) {
  const value = String(codec || '').toLowerCase();
  if (value.includes('hevc') || value.includes('h265')) {
    return 'H.265';
  }
  if (value.includes('avc') || value.includes('h264')) {
    return 'H.264';
  }
  return String(codec || '未知').toUpperCase();
}

function escapeFilterPath(filePath) {
  return String(filePath).replace(/\\/g, '/').replace(/:/g, '\\:').replace(/'/g, "\\'");
}

function compactLogLine(text) {
  return String(text).replace(/\s+/g, ' ').trim().slice(0, 240);
}

function parseFfmpegVideoInfo(text) {
  const line = String(text || '')
    .split(/\r?\n/)
    .find((item) => /Video:/i.test(item) && /\d{3,5}x\d{3,5}/.test(item));
  if (!line) {
    return null;
  }
  const sizeMatch = line.match(/,\s*(\d{3,5})x(\d{3,5})(?:[\s,\[]|$)/);
  if (!sizeMatch) {
    return null;
  }
  const codecMatch = line.match(/Video:\s*([^,\r\n]+)/i);
  const fpsMatch = line.match(/,\s*([0-9]+(?:\.[0-9]+)?)\s*fps/i);
  const fps = fpsMatch ? Number(fpsMatch[1]) : 0;
  return {
    codec: codecMatch ? codecMatch[1].trim() : '',
    width: Number(sizeMatch[1]),
    height: Number(sizeMatch[2]),
    fps: Number.isFinite(fps) && fps > 0 ? fps : undefined
  };
}

function buildActualQualityWarning(settings, stream, videoInfo) {
  const targetQn = Number(settings?.targetQn || 0);
  if (targetQn < 10000 || !videoInfo) {
    return '';
  }
  const expectedMinHeight = targetQn >= 25000 ? 2000 : 1200;
  if (Number(videoInfo.height || 0) >= expectedMinHeight) {
    return '';
  }
  const acceptQn = Array.isArray(stream?.acceptQn) ? stream.acceptQn.filter(Boolean).join('/') : '';
  return `请求 ${targetQn}，接口选中 ${stream?.qn || '未知'}，实际写入 ${videoInfo.width}x${videoInfo.height}。${
    acceptQn ? `接口可选 ${acceptQn}。` : ''
  }如果直播间确认有 2K/4K，请先扫码登录或刷新 Cookie。`;
}

function clamp(value, min, max) {
  const number = Number(value);
  if (Number.isNaN(number)) {
    return min;
  }
  return Math.max(min, Math.min(max, number));
}

function roomLabel(room) {
  return `${room.anchor || room.title || '直播间'}(${room.realRoomId || room.id})`;
}

function guardName(level) {
  if (Number(level) === 1) {
    return '总督';
  }
  if (Number(level) === 2) {
    return '提督';
  }
  return '舰长';
}

function getRuntimePort(settingsPort) {
  const argv = process.argv;
  const inline = argv.find((arg) => arg.startsWith('--port='));
  if (inline) {
    return clamp(Number(inline.split('=').slice(1).join('=')), 1, 65535);
  }
  const portIndex = argv.indexOf('--port');
  if (portIndex >= 0 && argv[portIndex + 1]) {
    return clamp(Number(argv[portIndex + 1]), 1, 65535);
  }
  if (process.env.PORT) {
    return clamp(Number(process.env.PORT), 1, 65535);
  }
  return clamp(Number(settingsPort || DEFAULT_PORT), 1, 65535);
}

function getAppRoot() {
  const execDir = path.dirname(process.execPath);
  if (process.pkg || fs.existsSync(path.join(execDir, 'dist'))) {
    return execDir;
  }
  return path.resolve(__dirname, '..');
}

function findFfmpegPath() {
  const localBinary = process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg';
  const candidates = [
    path.join(APP_ROOT, 'bin', localBinary),
    path.join(APP_ROOT, localBinary),
    path.join(process.cwd(), 'bin', localBinary),
    ffmpegStatic,
    'ffmpeg'
  ].filter(Boolean);

  for (const candidate of candidates) {
    if (candidate === 'ffmpeg') {
      return candidate;
    }
    try {
      if (fs.existsSync(candidate)) {
        return candidate;
      }
    } catch {
      // Keep trying.
    }
  }
  return 'ffmpeg';
}

function getAppVersion() {
  const candidates = [
    path.join(APP_ROOT, 'version.json'),
    path.join(APP_ROOT, 'package.json'),
    path.join(process.cwd(), 'package.json'),
    path.resolve(__dirname, '..', 'package.json')
  ];
  for (const candidate of candidates) {
    try {
      if (!fs.existsSync(candidate)) {
        continue;
      }
      const data = JSON.parse(fs.readFileSync(candidate, 'utf8'));
      if (data.version) {
        return String(data.version);
      }
    } catch {
      // Keep looking.
    }
  }
  return '0.0.1';
}

async function requestUrlBuffer(rawUrl, options = {}, redirectCount = 0) {
  if (redirectCount > 8) {
    throw new Error('请求重定向次数过多。');
  }
  const maxAttempts = redirectCount === 0 ? clamp(Number(options.retries ?? 4), 1, 8) : 1;
  let lastError = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await requestUrlBufferOnce(rawUrl, options, redirectCount);
    } catch (error) {
      lastError = error;
      if (attempt >= maxAttempts || !isTransientNetworkError(error)) {
        break;
      }
      options.onRetry?.({ attempt, maxAttempts, error });
      await delay(Math.min(800 * attempt, 3000));
    }
  }
  if (lastError && maxAttempts > 1 && isTransientNetworkError(lastError)) {
    throw new Error(`网络请求失败（已重试 ${maxAttempts - 1} 次）：${lastError.message}`);
  }
  throw lastError;
}

function requestUrlBufferOnce(rawUrl, options = {}, redirectCount = 0) {
  const target = new URL(rawUrl);
  const proxy = getProxyForUrl(target);
  return proxy
    ? requestUrlViaHttpProxy(target, proxy, options, redirectCount)
    : requestUrlDirect(target, options, redirectCount);
}

function requestUrlDirect(target, options, redirectCount) {
  return new Promise((resolve, reject) => {
    const transport = target.protocol === 'https:' ? https : http;
    const request = transport.request(
      {
        protocol: target.protocol,
        hostname: target.hostname,
        port: target.port || (target.protocol === 'https:' ? 443 : 80),
        path: `${target.pathname}${target.search}`,
        method: options.method || 'GET',
        headers: options.headers || {}
      },
      (response) => collectUrlResponse(response, target, options, redirectCount, resolve, reject)
    );
    request.setTimeout(Number(options.timeoutMs || 45000), () => request.destroy(new Error('请求超时。')));
    request.on('error', reject);
    request.end(options.body);
  });
}

function isTransientNetworkError(error) {
  const code = String(error?.code || '').toUpperCase();
  const message = String(error?.message || '').toLowerCase();
  return (
    ['ECONNRESET', 'ETIMEDOUT', 'EAI_AGAIN', 'ECONNREFUSED', 'ENETUNREACH', 'EHOSTUNREACH', 'UND_ERR_SOCKET'].includes(code) ||
    message.includes('econnreset') ||
    message.includes('socket hang up') ||
    message.includes('timeout') ||
    message.includes('请求超时') ||
    message.includes('tls') ||
    message.includes('代理请求超时') ||
    message.includes('代理 connect 超时')
  );
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function withTimeout(promise, timeoutMs, message) {
  let timer = null;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(message || '操作超时。')), timeoutMs);
    timer.unref?.();
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) {
      clearTimeout(timer);
    }
  });
}

function requestFfmpegStop(child, options = {}) {
  if (!child || child.exitCode !== null || child.signalCode) {
    return;
  }
  const graceful = options.graceful !== false;
  if (graceful && child.stdin && !child.stdin.destroyed) {
    try {
      child.stdin.write('q\n');
      child.stdin.end();
    } catch {
      forceKillProcess(child);
    }
  } else {
    forceKillProcess(child);
  }
  const timer = setTimeout(() => forceKillProcess(child), Number(options.timeoutMs || 5000));
  timer.unref?.();
  child.once?.('close', () => clearTimeout(timer));
}

function forceKillProcess(child) {
  if (!child || child.exitCode !== null || child.signalCode) {
    return;
  }
  if (process.platform === 'win32' && child.pid) {
    const fallback = setTimeout(() => killChildDirectly(child), 1200);
    fallback.unref?.();
    const killer = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], {
      windowsHide: true,
      stdio: 'ignore'
    });
    killer.on('error', () => {
      clearTimeout(fallback);
      killChildDirectly(child);
    });
    killer.on('close', (code) => {
      clearTimeout(fallback);
      if (code !== 0) {
        killChildDirectly(child);
      }
    });
    return;
  }
  killChildDirectly(child);
}

function killChildDirectly(child) {
  if (!child || child.exitCode !== null || child.signalCode) {
    return;
  }
  try {
    child.kill('SIGKILL');
  } catch {
    try {
      child.kill();
    } catch {}
  }
}

async function getFileSize(filePath) {
  try {
    const stat = await fsp.stat(filePath);
    return stat.isFile() ? stat.size : 0;
  } catch {
    return 0;
  }
}

function isRecordingFileLikelyPlayable({ fileSize, elapsedSec, videoInfo }) {
  const size = Number(fileSize || 0);
  if (size <= 0) {
    return false;
  }
  if (videoInfo && size >= 32 * 1024) {
    return true;
  }
  if (Number(elapsedSec || 0) <= 20 && size >= 32 * 1024) {
    return true;
  }
  return size >= MIN_PLAYABLE_BYTES && Boolean(videoInfo);
}

function hasReachedSegmentLimit(session, elapsedSec) {
  const targetSec = Number(session?.segmentDurationSec || 0);
  if (!Number.isFinite(targetSec) || targetSec <= 0) {
    return false;
  }
  const toleranceSec = Math.min(5, Math.max(1, targetSec * 0.02));
  return Number(elapsedSec || 0) >= targetSec - toleranceSec;
}

function cloneRecordingState(recording) {
  return {
    ...recording,
    danmakuCommandCounts: { ...(recording.danmakuCommandCounts || {}) },
    videoInfo: recording.videoInfo ? { ...recording.videoInfo } : recording.videoInfo
  };
}

function isCurrentRecordingSession(room, session) {
  return Boolean(
    room?.currentRecording &&
      session &&
      room.currentRecording.startedAt === session.startedAt &&
      room.currentRecording.cleanPath === session.cleanPath
  );
}

function formatBytes(bytes) {
  const value = Number(bytes || 0);
  if (value >= 1024 * 1024 * 1024) {
    return `${(value / 1024 / 1024 / 1024).toFixed(2)} GB`;
  }
  if (value >= 1024 * 1024) {
    return `${(value / 1024 / 1024).toFixed(1)} MB`;
  }
  if (value >= 1024) {
    return `${Math.round(value / 1024)} KB`;
  }
  return `${Math.round(value)} B`;
}

async function discoverRecordingFiles(outputDir) {
  let entries;
  try {
    entries = await fsp.readdir(outputDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const recordings = [];
  for (const entry of entries) {
    if (!entry.isFile()) {
      continue;
    }
    const name = entry.name;
    if (!/\.(?:clean|merged)\.(?:mp4|mkv)$/i.test(name)) {
      continue;
    }
    if (/\.tmp\.|\.finalizing\.|\.clip_/i.test(name)) {
      continue;
    }
    const cleanPath = path.join(outputDir, name);
    const stat = await fsp.stat(cleanPath).catch(() => null);
    if (!stat?.isFile()) {
      continue;
    }
    const danmakuPath = deriveSiblingPath(cleanPath, 'danmaku', 'jsonl');
    const eventCount = await countDanmakuLines(danmakuPath);
    const valid = stat.size >= 32 * 1024;
    recordings.push({
      id: `${cleanPath}:${Math.round(stat.mtimeMs)}`,
      startedAt: stat.mtimeMs,
      cleanPath,
      danmakuPath,
      cssPath: deriveSiblingPath(cleanPath, 'danmaku', 'css'),
      assPath: deriveSiblingPath(cleanPath, 'danmaku', 'ass'),
      burnedPath: deriveBurnedPath(cleanPath, 'danmaku-gift'),
      capturePath: '',
      containerStage: valid ? 'ready' : 'failed',
      validReason: valid ? '' : `文件过小：${formatBytes(stat.size)}`,
      fileSize: stat.size,
      valid,
      eventCount,
      capturedDanmakuCount: eventCount,
      rawDanmakuCount: eventCount,
      ignoredDanmakuCount: 0,
      danmakuCommandCounts: {}
    });
  }
  return recordings;
}

async function countDanmakuLines(filePath) {
  try {
    const text = await fsp.readFile(filePath, 'utf8');
    return text.split(/\r?\n/).filter(Boolean).length;
  } catch {
    return 0;
  }
}

function requestUrlViaHttpProxy(target, proxy, options, redirectCount) {
  if (target.protocol === 'http:') {
    return new Promise((resolve, reject) => {
      const request = http.request(
        {
          hostname: proxy.hostname,
          port: proxy.port || 80,
          path: target.toString(),
          method: options.method || 'GET',
          headers: {
            ...(options.headers || {}),
            Host: target.host,
            ...proxyAuthorizationHeader(proxy)
          }
        },
        (response) => collectUrlResponse(response, target, options, redirectCount, resolve, reject)
      );
      request.setTimeout(Number(options.timeoutMs || 45000), () => request.destroy(new Error('代理请求超时。')));
      request.on('error', reject);
      request.end(options.body);
    });
  }

  return new Promise((resolve, reject) => {
    const connect = http.request({
      hostname: proxy.hostname,
      port: proxy.port || 80,
      method: 'CONNECT',
      path: `${target.hostname}:${target.port || 443}`,
      headers: {
        Host: `${target.hostname}:${target.port || 443}`,
        ...proxyAuthorizationHeader(proxy)
      }
    });
    connect.setTimeout(Number(options.timeoutMs || 45000), () => connect.destroy(new Error('代理 CONNECT 超时。')));
    connect.on('connect', (response, socket) => {
      if (response.statusCode !== 200) {
        socket.destroy();
        reject(new Error(`代理 CONNECT 失败：HTTP ${response.statusCode}`));
        return;
      }
      const secureSocket = tls.connect({ socket, servername: target.hostname });
      secureSocket.on('error', reject);
      secureSocket.once('secureConnect', () => {
        const request = https.request(
          {
            hostname: target.hostname,
            port: target.port || 443,
            path: `${target.pathname}${target.search}`,
            method: options.method || 'GET',
            headers: options.headers || {},
            createConnection: () => secureSocket,
            agent: false
          },
          (res) => collectUrlResponse(res, target, options, redirectCount, resolve, reject)
        );
        request.setTimeout(Number(options.timeoutMs || 45000), () => request.destroy(new Error('代理 HTTPS 请求超时。')));
        request.on('error', reject);
        request.end(options.body);
      });
    });
    connect.on('error', reject);
    connect.end();
  });
}

function collectUrlResponse(response, target, options, redirectCount, resolve, reject) {
  const statusCode = Number(response.statusCode || 0);
  const location = response.headers.location;
  if ([301, 302, 303, 307, 308].includes(statusCode) && location) {
    response.resume();
    resolve(requestUrlBuffer(new URL(location, target).toString(), options, redirectCount + 1));
    return;
  }
  const chunks = [];
  const totalBytes = Number(response.headers['content-length'] || 0);
  let receivedBytes = 0;
  response.on('data', (chunk) => {
    chunks.push(chunk);
    receivedBytes += chunk.length;
    options.onProgress?.({ receivedBytes, totalBytes, done: false });
  });
  response.on('end', () => {
    const body = Buffer.concat(chunks);
    if (statusCode < 200 || statusCode >= 300) {
      reject(new Error(`请求失败：HTTP ${statusCode} ${body.toString('utf8').slice(0, 180)}`.trim()));
      return;
    }
    options.onProgress?.({ receivedBytes: body.length, totalBytes, done: true });
    resolve(body);
  });
  response.on('error', reject);
}

function getProxyForUrl(target) {
  if (shouldBypassProxy(target.hostname)) {
    return null;
  }
  const envProxy =
    target.protocol === 'https:'
      ? process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy
      : process.env.HTTP_PROXY || process.env.http_proxy;
  const proxySource = envProxy || getWindowsProxyForUrl(target) || '';
  return normalizeProxyUrl(proxySource);
}

function shouldBypassProxy(hostname) {
  const noProxy = process.env.NO_PROXY || process.env.no_proxy || '';
  if (!noProxy.trim()) {
    return false;
  }
  const host = String(hostname || '').toLowerCase();
  return noProxy
    .split(',')
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean)
    .some((rule) => rule === '*' || host === rule || (rule.startsWith('.') ? host.endsWith(rule) : host.endsWith(`.${rule}`)));
}

function getWindowsProxyForUrl(target) {
  if (process.platform !== 'win32') {
    return '';
  }
  const winInetProxy = getWinInetProxyServer();
  if (winInetProxy) {
    return selectProxyServer(winInetProxy, target.protocol);
  }
  const winHttpProxy = getWinHttpProxyServer();
  return winHttpProxy ? selectProxyServer(winHttpProxy, target.protocol) : '';
}

function getWinInetProxyServer() {
  const key = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings';
  const enabled = spawnSync('reg.exe', ['query', key, '/v', 'ProxyEnable'], {
    encoding: 'utf8',
    windowsHide: true
  });
  if (enabled.status !== 0 || !/ProxyEnable\s+REG_DWORD\s+0x1/i.test(enabled.stdout || '')) {
    return '';
  }
  const server = spawnSync('reg.exe', ['query', key, '/v', 'ProxyServer'], {
    encoding: 'utf8',
    windowsHide: true
  });
  if (server.status !== 0) {
    return '';
  }
  return parseRegistryValue(server.stdout, 'ProxyServer');
}

function getWinHttpProxyServer() {
  const result = spawnSync('netsh.exe', ['winhttp', 'show', 'proxy'], {
    encoding: 'utf8',
    windowsHide: true
  });
  if (result.status !== 0 || /Direct access|直接访问|无代理/i.test(result.stdout || '')) {
    return '';
  }
  const line = String(result.stdout || '')
    .split(/\r?\n/)
    .map((item) => item.trim())
    .find((item) => /Proxy Server|代理服务器|代理服务器\(s\)/i.test(item));
  return line?.split(':').slice(1).join(':').trim() || '';
}

function parseRegistryValue(text, name) {
  const line = String(text || '')
    .split(/\r?\n/)
    .find((item) => new RegExp(`\\b${name}\\b`, 'i').test(item));
  return line?.match(/\sREG_\w+\s+(.+)$/i)?.[1]?.trim() || '';
}

function selectProxyServer(proxyConfig, protocol) {
  const text = String(proxyConfig || '').trim();
  if (!text) {
    return '';
  }
  if (!text.includes('=')) {
    return text;
  }
  const desired = protocol === 'https:' ? 'https' : 'http';
  const map = new Map();
  for (const entry of text.split(';')) {
    const [key, ...rest] = entry.split('=');
    if (key && rest.length) {
      map.set(key.trim().toLowerCase(), rest.join('=').trim());
    }
  }
  return map.get(desired) || map.get('http') || '';
}

function normalizeProxyUrl(value) {
  const text = String(value || '').trim();
  if (!text || /^socks/i.test(text)) {
    return null;
  }
  try {
    const url = new URL(/^[a-z]+:\/\//i.test(text) ? text : `http://${text}`);
    if (url.protocol !== 'http:') {
      return null;
    }
    return url;
  } catch {
    return null;
  }
}

function proxyAuthorizationHeader(proxy) {
  if (!proxy.username) {
    return {};
  }
  const token = Buffer.from(`${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password || '')}`).toString('base64');
  return { 'Proxy-Authorization': `Basic ${token}` };
}

async function readTextSource(source, options = {}) {
  const value = String(source || '').trim();
  if (!value) {
    throw new Error('更新源为空。');
  }
  if (/^https?:\/\//i.test(value)) {
    const body = await requestUrlBuffer(value, {
      headers: {
        Accept: 'application/json, text/plain, */*',
        'User-Agent': `${APP_NAME}/${APP_VERSION}`,
        ...(options.headers || {})
      },
      retries: options.retries,
      timeoutMs: options.timeoutMs,
      onRetry: options.onRetry
    });
    return body.toString('utf8');
  }
  const filePath = value.startsWith('file://') ? new URL(value) : path.resolve(APP_ROOT, value);
  return fsp.readFile(filePath, 'utf8');
}

function isDefaultUpdateSource(source) {
  const normalized = String(source || '').trim().replace(/\/+$/, '');
  const fallback = String(DEFAULT_UPDATE_MANIFEST_URL || '').trim().replace(/\/+$/, '');
  return normalized === fallback || normalized.endsWith('/releases/latest/download/update.json');
}

function normalizeUpdateManifest(payload) {
  if (!payload || typeof payload !== 'object') {
    throw new Error('更新源不是有效 JSON。');
  }
  if (Array.isArray(payload.assets)) {
    const installerAsset = payload.assets.find((asset) => isInstallerFileName(asset.name || asset.browser_download_url || ''));
    const zipAsset = payload.assets.find((asset) => /\.zip$/i.test(asset.name || asset.browser_download_url || ''));
    const packageAsset = installerAsset || zipAsset;
    return {
      version: normalizeVersion(payload.version || payload.tag_name || ''),
      tagName: payload.tag_name || '',
      packageType: installerAsset ? 'installer' : 'portable',
      packageUrl: packageAsset?.browser_download_url || packageAsset?.url || '',
      sha256: payload.sha256 || '',
      releaseUrl: payload.html_url || '',
      notes: payload.body || ''
    };
  }
  const files = Array.isArray(payload.files) ? payload.files : [];
  const installerFile =
    files.find((file) => String(file.kind || file.type || '').toLowerCase() === 'installer') ||
    files.find((file) => isInstallerFileName(file.name || file.url || ''));
  const zipFile =
    files.find((file) => String(file.kind || file.type || '').toLowerCase() === 'portable') ||
    files.find((file) => /\.zip$/i.test(file.name || file.url || ''));
  const packageFile = installerFile || zipFile;
  const packageUrl =
    payload.installerUrl ||
    payload.packageUrl ||
    payload.url ||
    payload.downloadUrl ||
    packageFile?.url ||
    '';
  const packageType = normalizeUpdatePackageType(payload.packageType || packageFile?.kind || packageFile?.type || packageUrl);
  return {
    version: normalizeVersion(payload.version || payload.tagName || ''),
    tagName: payload.tagName || payload.tag_name || '',
    packageType,
    packageUrl,
    sha256:
      payload.sha256 ||
      (packageType === 'installer' ? payload.installerSha256 : payload.portableSha256) ||
      packageFile?.sha256 ||
      '',
    installerArgs: payload.installerArgs,
    releaseUrl: payload.releaseUrl || payload.htmlUrl || '',
    notes: payload.notes || payload.body || ''
  };
}

function normalizeVersion(value) {
  return String(value || '').trim().replace(/^v/i, '');
}

function normalizeUpdatePackageType(value) {
  const text = String(value || '').trim().toLowerCase();
  if (text === 'installer' || isInstallerFileName(text)) {
    return 'installer';
  }
  return 'portable';
}

function isInstallerFileName(value) {
  const text = String(value || '').toLowerCase();
  return /\.(?:exe|msi|msix|appinstaller)(?:$|[?#])/i.test(text) && /(setup|install|installer)/i.test(text);
}

function isInstallerUpdatePackage(manifest, packagePath) {
  return normalizeUpdatePackageType(manifest?.packageType || manifest?.packageUrl || packagePath) === 'installer';
}

function normalizeInstallerArgs(manifest) {
  if (Array.isArray(manifest?.installerArgs)) {
    return manifest.installerArgs.map(String);
  }
  if (typeof manifest?.installerArgs === 'string') {
    return splitCommandLineArgs(manifest.installerArgs);
  }
  return ['/S'];
}

function buildInstallerArgs(manifest, paths) {
  const args = normalizeInstallerArgs(manifest);
  if (!args.some((arg) => String(arg).toUpperCase() === '/S')) {
    args.unshift('/S');
  }
  args.push(`/STATUS=${portableInstallerArgPath(paths.statusPath)}`);
  args.push(`/LOG=${portableInstallerArgPath(paths.logPath)}`);
  args.push(`/PACKAGE=${portableInstallerArgPath(paths.packagePath)}`);
  return args;
}

function portableInstallerArgPath(filePath) {
  return path.resolve(String(filePath || '')).replace(/\\/g, '/');
}

function createElevatedInstallerLaunchScript(packagePath, args) {
  const encodedArgs = args.map((arg) => base64Utf8(arg));
  return `
$ErrorActionPreference = 'Stop'
function DecodeText([string]$value) {
  [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($value))
}
$installer = DecodeText '${base64Utf8(packagePath)}'
$arguments = @(${encodedArgs.map((arg) => `(DecodeText '${arg}')`).join(', ')})
$argumentLine = ($arguments | ForEach-Object { '"' + ($_ -replace '"', '\"') + '"' }) -join ' '
Start-Process -FilePath $installer -ArgumentList $argumentLine -Verb RunAs
`;
}

function splitCommandLineArgs(value) {
  const args = [];
  const text = String(value || '');
  let current = '';
  let quote = '';
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if ((char === '"' || char === "'") && !quote) {
      quote = char;
      continue;
    }
    if (char === quote) {
      quote = '';
      continue;
    }
    if (/\s/.test(char) && !quote) {
      if (current) {
        args.push(current);
        current = '';
      }
      continue;
    }
    current += char;
  }
  if (current) {
    args.push(current);
  }
  return args;
}

function updatePackageLabel(manifest) {
  return isInstallerUpdatePackage(manifest, manifest?.packageUrl) ? '安装器' : '更新包';
}

function updatePackageFileName(manifest) {
  const version = sanitizeFilename(manifest?.version || 'latest');
  const urlName = packageFileNameFromUrl(manifest?.packageUrl || '');
  const extension = path.extname(urlName).toLowerCase();
  if (extension) {
    return `bili-record-2k-${version}${extension}`;
  }
  return isInstallerUpdatePackage(manifest, '') ? `bili-record-2k-${version}-setup.exe` : `bili-record-2k-${version}.zip`;
}

function packageFileNameFromUrl(value) {
  try {
    return path.basename(new URL(String(value || '')).pathname);
  } catch {
    return path.basename(String(value || ''));
  }
}

function compareVersions(a, b) {
  const left = normalizeVersion(a).split(/[.-]/).map((part) => Number(part) || 0);
  const right = normalizeVersion(b).split(/[.-]/).map((part) => Number(part) || 0);
  const length = Math.max(left.length, right.length, 3);
  for (let index = 0; index < length; index += 1) {
    const diff = (left[index] || 0) - (right[index] || 0);
    if (diff !== 0) {
      return diff;
    }
  }
  return 0;
}

async function downloadFile(url, targetPath, onProgress) {
  if (!/^https?:\/\//i.test(String(url || ''))) {
    throw new Error('更新包下载地址无效。');
  }
  const tmpPath = `${targetPath}.tmp`;
  await fsp.rm(tmpPath, { force: true });
  const body = await requestUrlBuffer(url, {
    headers: {
      Accept: 'application/x-msdownload, application/vnd.microsoft.portable-executable, application/zip, application/octet-stream, */*',
      'User-Agent': `${APP_NAME}/${APP_VERSION}`
    },
    onProgress,
    onRetry: ({ attempt, maxAttempts, error }) => {
      onProgress?.({
        retrying: true,
        attempt,
        maxAttempts,
        error,
        receivedBytes: 0,
        totalBytes: 0,
        done: false
      });
    }
  });
  await fsp.writeFile(tmpPath, body);
  await fsp.rm(targetPath, { force: true });
  await fsp.rename(tmpPath, targetPath);
}

async function fileSha256(filePath) {
  const hash = crypto.createHash('sha256');
  hash.update(await fsp.readFile(filePath));
  return hash.digest('hex');
}

function isStartupEnabled() {
  if (process.platform !== 'win32') {
    return false;
  }
  const result = spawnSync('reg.exe', ['query', RUN_KEY, '/v', APP_NAME], {
    encoding: 'utf8',
    windowsHide: true
  });
  return result.status === 0;
}

function setStartupEnabled(enabled) {
  const command = createStartupCommand();
  const args = enabled
    ? ['add', RUN_KEY, '/v', APP_NAME, '/t', 'REG_SZ', '/d', command, '/f']
    : ['delete', RUN_KEY, '/v', APP_NAME, '/f'];
  const result = spawnSync('reg.exe', args, {
    encoding: 'utf8',
    windowsHide: true
  });
  if (result.status !== 0 && enabled) {
    throw new Error((result.stderr || result.stdout || '写入开机自启失败').trim());
  }
  if (result.status !== 0 && !enabled && !/unable|找不到|不存在/i.test(result.stderr || result.stdout || '')) {
    throw new Error((result.stderr || result.stdout || '删除开机自启失败').trim());
  }
}

function createStartupCommand() {
  const execDir = path.dirname(process.execPath);
  const launcherPath = path.join(execDir, 'BiliRecord2K.exe');
  if (fs.existsSync(path.join(execDir, 'dist')) && fs.existsSync(launcherPath)) {
    return `"${launcherPath}" --prod --no-open`;
  }
  if (process.pkg || fs.existsSync(path.join(execDir, 'dist'))) {
    return `"${process.execPath}" --prod --no-open`;
  }
  return `"${process.execPath}" "${path.join(APP_ROOT, 'server', 'index.cjs')}" --prod --no-open`;
}

function showWindowsToast(title, message) {
  if (process.platform !== 'win32') {
    return;
  }
  const script = `
$ErrorActionPreference = 'Stop'
function DecodeText([string]$value) {
  [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($value))
}
$title = [System.Security.SecurityElement]::Escape((DecodeText '${base64Utf8(title)}'))
$message = [System.Security.SecurityElement]::Escape((DecodeText '${base64Utf8(message)}'))
[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null
[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] | Out-Null
$xmlText = "<toast><visual><binding template='ToastGeneric'><text>$title</text><text>$message</text></binding></visual></toast>"
$xml = [Windows.Data.Xml.Dom.XmlDocument]::new()
$xml.LoadXml($xmlText)
$toast = [Windows.UI.Notifications.ToastNotification]::new($xml)
[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('${APP_NAME}').Show($toast)
`;
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  const child = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true
  });
  child.unref();
}

function base64Utf8(value) {
  return Buffer.from(String(value || ''), 'utf8').toString('base64');
}

function openUrl(url) {
  if (process.platform === 'win32') {
    spawn('cmd.exe', ['/c', 'start', '', url], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true
    }).unref();
    return;
  }
  openPath(url);
}

function openPath(targetPath) {
  if (process.platform === 'win32') {
    spawn('explorer.exe', [targetPath], { detached: true, stdio: 'ignore' }).unref();
    return;
  }
  if (process.platform === 'darwin') {
    spawn('open', [targetPath], { detached: true, stdio: 'ignore' }).unref();
    return;
  }
  spawn('xdg-open', [targetPath], { detached: true, stdio: 'ignore' }).unref();
}

function mimeType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  return (
    {
      '.html': 'text/html; charset=utf-8',
      '.js': 'text/javascript; charset=utf-8',
      '.css': 'text/css; charset=utf-8',
      '.json': 'application/json; charset=utf-8',
      '.svg': 'image/svg+xml',
      '.png': 'image/png',
      '.ico': 'image/x-icon',
      '.webp': 'image/webp',
      '.mp4': 'video/mp4',
      '.mkv': 'video/x-matroska'
    }[ext] || 'application/octet-stream'
  );
}

start().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
