const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const QRCode = require('qrcode');
const {
  DanmakuClient,
  unpackDanmakuPackets,
  decodeDanmakuPacket,
  safeDecodeDanmakuPacket,
  decodeAuthReply,
  requestBiliJsonWithCookies,
  getSetCookieHeaders,
  splitSetCookieHeader,
  mergeCookieString,
  danmakuCommandType,
  normalizeDanmakuEvent,
  readDanmakuEvents,
  ensureDanmakuCss,
  readDanmakuStyle,
  createDefaultDanmakuCss,
  parseCssVariables,
  normalizeDanmakuStyle,
  prepareAssEvents,
  getDanmakuEventDuration,
  createAss,
  createRecordingArgs,
  createMp4FinalizeArgs,
  createBurnArgs,
  createClipCopyArgs,
  createConcatCopyArgs,
  writeConcatFile,
  escapeConcatPath,
  mergeDanmakuFiles,
  getSegmentDurationForMerge,
  copyFirstExistingFile,
  drawRect,
  dialogue,
  assTime,
  assEscape,
  assColorFromRgb,
  hex2,
  superChatPalette,
  chooseLane,
  estimateTextWidth,
  truncateText,
  wrapText,
  sanitizeFilename,
  sanitizeHeaderValue,
  createImageProxyHeaders,
  createPreviewProxyHeaders,
  createPreviewProxyPath,
  encodePreviewUrl,
  decodePreviewUrl,
  isPreviewPlaylist,
  rewriteHlsManifest,
  rewriteHlsManifestLine,
  resolveHlsResourceUrl,
  previewMimeType,
  isBilibiliHost,
  getCookieValue,
  createBiliError,
  normalizeContainer,
  normalizeContainerStage,
  normalizeCommandCounts,
  mergeCommandCounts,
  detectFfmpegCapabilities,
  runFfmpegProbe,
  parseFfmpegEncoderNames,
  parseFfmpegHwaccels,
  detectVideoAdapters,
  detectVideoAdapterVendor,
  hasVideoAdapterVendor,
  testFfmpegEncoder,
  normalizeBurnCodec,
  normalizeRoomImageMode,
  normalizeBurnOverlayMode,
  normalizeExportMode,
  overlayModeLabel,
  basenameWithoutExt,
  normalizeTargetQn,
  createQnProbeList,
  getContainerFromPath,
  deriveSiblingPath,
  deriveBurnedPath,
  deriveClipPath,
  replaceExtension,
  isPathInsideDirectory,
  createClipSuffix,
  normalizeClipModeName,
  safeTimeSlug,
  parseTimeInput,
  formatFfmpegSeconds,
  runFfmpegJob,
  createFfmpegJobProgress,
  updateFfmpegJobProgress,
  finishFfmpegJobProgress,
  parseFfmpegProgressTime,
  parseFfmpegTime,
  probeMediaFileInfo,
  resolveReliableDurationSec,
  readDanmakuDurationSec,
  isHevcCodec,
  formatTimestamp,
  formatDurationSeconds,
  streamScore,
  displayCodecName,
  escapeFilterPath,
  compactLogLine,
  parseFfmpegVideoInfo,
  buildActualQualityWarning,
  clamp,
  roomLabel,
  guardName,
  getRuntimePort,
  getRuntimeHost,
  normalizeServerHost,
  getAppRoot,
  findFfmpegPath,
  getAppVersion,
  requestUrlBuffer,
  requestUrlBufferOnce,
  requestUrlDirect,
  isTransientNetworkError,
  delay,
  withTimeout,
  requestFfmpegStop,
  forceKillProcess,
  killChildDirectly,
  getFileSize,
  isRecordingFileLikelyPlayable,
  hasReachedSegmentLimit,
  cloneRecordingState,
  isCurrentRecordingSession,
  formatBytes,
  discoverRecordingFiles,
  countDanmakuLines,
  requestUrlViaHttpProxy,
  collectUrlResponse,
  getProxyForUrl,
  shouldBypassProxy,
  getWindowsProxyForUrl,
  getWinInetProxyServer,
  getWinHttpProxyServer,
  parseRegistryValue,
  selectProxyServer,
  normalizeProxyUrl,
  proxyAuthorizationHeader,
  readTextSource,
  isDefaultUpdateSource,
  normalizeUpdateManifest,
  normalizeVersion,
  normalizeUpdatePackageType,
  isInstallerFileName,
  isInstallerUpdatePackage,
  normalizeInstallerArgs,
  buildInstallerArgs,
  portableInstallerArgPath,
  createElevatedInstallerLaunchScript,
  splitCommandLineArgs,
  updatePackageLabel,
  updatePackageFileName,
  packageFileNameFromUrl,
  compareVersions,
  downloadFile,
  fileSha256,
  isStartupEnabled,
  setStartupEnabled,
  createStartupCommand,
  showWindowsToast,
  base64Utf8,
  openUrl,
  openPath,
  mimeType
} = require('../shared/helpers.cjs');



let ffmpegStatic = null;
try {
  ffmpegStatic = require('ffmpeg-static');
} catch {
  ffmpegStatic = null;
}

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

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
const DEFAULT_HOST = '127.0.0.1';
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
const QUALITY_UPGRADE_CHECK_MS = 90 * 1000;
const BURN_CODEC_CANDIDATES = [
  { value: 'libx265', label: 'H.265 软件编码', kind: 'software' },
  { value: 'libx264', label: 'H.264 软件编码', kind: 'software' },
  { value: 'hevc_nvenc', label: 'NVIDIA H.265 硬件编码', kind: 'hardware', vendor: 'nvidia' },
  { value: 'h264_nvenc', label: 'NVIDIA H.264 硬件编码', kind: 'hardware', vendor: 'nvidia' },
  { value: 'hevc_qsv', label: 'Intel H.265 硬件编码', kind: 'hardware', vendor: 'intel' },
  { value: 'h264_qsv', label: 'Intel H.264 硬件编码', kind: 'hardware', vendor: 'intel' },
  { value: 'hevc_amf', label: 'AMD H.265 硬件编码', kind: 'hardware', vendor: 'amd' },
  { value: 'h264_amf', label: 'AMD H.264 硬件编码', kind: 'hardware', vendor: 'amd' }
];
const BURN_CODEC_VALUES = new Set(BURN_CODEC_CANDIDATES.map((codec) => codec.value));

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
    this.burnCancelRequests = new Set();
    this.previewSessions = new Map();
    this.exportProgress = null;
    this.exportProgressClearTimer = null;
    this.exportProcess = null;
    this.exportCancelRequested = false;
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
    this.ffmpegCapabilities = detectFfmpegCapabilities(this.ffmpegPath);
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
      serverHost: DEFAULT_HOST,
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
    this.log('info', `可用弹幕版编码：${this.ffmpegCapabilities.burnCodecs.map((codec) => codec.label).join('、') || '未探测到'}`);
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
    let burnCodec = normalizeBurnCodec(settings.burnCodec);
    const availableBurnCodecs = this.getAvailableBurnCodecs();
    if (availableBurnCodecs.length && !availableBurnCodecs.includes(burnCodec)) {
      burnCodec = availableBurnCodecs[0];
    }
    return {
      ...this.createDefaultSettings(),
      ...settings,
      outputContainer: normalizeContainer(settings.outputContainer),
      burnCodec,
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
      serverHost: normalizeServerHost(settings.serverHost || DEFAULT_HOST),
      serverPort: clamp(Number(settings.serverPort || DEFAULT_PORT), 1, 65535)
    };
  }

  getAvailableBurnCodecs() {
    const codecs = (this.ffmpegCapabilities?.burnCodecs || []).map((codec) => codec.value).filter(Boolean);
    return codecs.length ? codecs : ['libx265', 'libx264'];
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

  getSegmentDurationSec() {
    const minutes = Number(this.settings.segmentMinutes || 0);
    return Number.isFinite(minutes) && minutes > 0 ? minutes * 60 : 0;
  }

  async resolveRecordingDuration(recording, mediaInfo = {}, fallbackDurationSec = 0) {
    const danmakuDurationSec = recording?.danmakuPath ? await readDanmakuDurationSec(recording.danmakuPath) : 0;
    return resolveReliableDurationSec({
      mediaDurationSec: mediaInfo.durationSec,
      elapsedSec: fallbackDurationSec,
      storedDurationSec: recording?.durationSec,
      danmakuDurationSec,
      segmentDurationSec: this.getSegmentDurationSec()
    });
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
      ffmpegCapabilities: this.ffmpegCapabilities,
      exportProgress: this.exportProgress ? { ...this.exportProgress } : null,
      startupEnabled: isStartupEnabled(),
      currentPort: this.currentPort || DEFAULT_PORT,
      currentHost: this.currentHost || DEFAULT_HOST,
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
      burnProgress: room.burnProgress ? { ...room.burnProgress } : undefined,
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
    const host = this.currentHost || DEFAULT_HOST;
    const uiHost = host === '0.0.0.0' || host === '::' ? '127.0.0.1' : host;
    const rooms = Array.from(this.rooms.values()).map((room) => this.getPublicRoomState(room));
    const monitoringCount = rooms.filter((room) => room.monitoring).length;
    const liveCount = rooms.filter((room) => room.liveStatus === 1).length;
    const recordingCount = rooms.filter((room) => room.recording).length;
    const burningCount = rooms.filter((room) => room.burning).length;
    const statusLabel = recordingCount ? '录制中' : burningCount ? '烧录中' : monitoringCount ? '监听中' : '空闲';
    const tooltip =
      `哔哩录播 2K | ${statusLabel} | ` +
      `监听 ${monitoringCount} / 直播 ${liveCount} / 录制 ${recordingCount} / 烧录 ${burningCount} | ` +
      `监听地址 ${host}:${port}`;

    const notification = this.notifications.find((item) => item.id > afterSeq);
    const seq = notification ? notification.id : this.notificationSeq;
    return [
      `seq=${seq}`,
      `url=${encodeURIComponent(`http://${uiHost}:${port}`)}`,
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
    const stream = await this.resolvePlayStream(room, { requireHls: true, purpose: '实时预览' });
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

  async resolvePlayStream(room, options = {}) {
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

    const selectableCandidates = options.requireHls ? candidates.filter(isHlsPreviewCandidate) : candidates;
    if (selectableCandidates.length === 0) {
      if (lastPlayError) {
        throw lastPlayError;
      }
      throw new Error(
        options.requireHls
          ? '没有拿到浏览器可播放的 HLS 直播流，请稍后刷新或确认直播间已开播。'
          : '没有拿到可用直播流，可能未登录、未开播或清晰度受限。'
      );
    }

    selectableCandidates.sort((a, b) => streamScore(b, this.settings) - streamScore(a, this.settings));
    room.stream = selectableCandidates[0];
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
      `${roomLabel(room)} ${options.purpose || '录制'}选中直播流：编码 ${displayCodecName(room.stream.codec)}，清晰度码 ${
        room.stream.qn
      }，请求 ${qnProbes.join('/')}, 协议 ${room.stream.protocol}/${room.stream.format}，接口可选 ${
        availableQn.join('/') || '未知'
      }`
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

      const explicitStream = options.stream?.url ? { ...options.stream } : null;
      const fallbackStream = options.fallbackStream?.url ? { ...options.fallbackStream } : null;
      let stream = explicitStream;
      if (stream) {
        room.stream = stream;
        this.log(
          'info',
          `${roomLabel(room)} 使用已选直播流：编码 ${displayCodecName(stream.codec)}，清晰度码 ${stream.qn}`
        );
      } else {
        try {
          stream = await this.resolvePlayStream(room);
        } catch (error) {
          if (!fallbackStream) {
            throw error;
          }
          stream = fallbackStream;
          room.stream = stream;
          this.log(
            'warn',
            `${roomLabel(room)} 重新选流失败，暂时沿用上一段直播流：编码 ${displayCodecName(stream.codec)}，清晰度码 ${
              stream.qn
            }。原因：${error.message}`
          );
        }
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
      const segmentDurationSec = this.getSegmentDurationSec();
      const args = createRecordingArgs({
        streamUrl: stream.url,
        streamProtocol: stream.protocol,
        streamFormat: stream.format,
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
        qualityWatchTimer: null,
        rotating: false,
        qualitySwitching: false,
        nextStream: null,
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
      this.armQualityUpgradeWatch(room, session);
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

  armQualityUpgradeWatch(room, session) {
    const targetQn = normalizeTargetQn(this.settings.targetQn);
    if (!Number.isFinite(targetQn) || targetQn <= 0) {
      return;
    }
    const schedule = () => {
      session.qualityWatchTimer = setTimeout(async () => {
        if (session.finished || session.stopping || this.recordingSessions.get(room.id) !== session) {
          return;
        }
        try {
          await this.checkRecordingQualityUpgrade(room, session, targetQn);
        } catch (error) {
          this.log('warn', `${roomLabel(room)} 清晰度升级检查失败：${error.message}`);
        }
        if (!session.finished && !session.stopping && this.recordingSessions.get(room.id) === session) {
          schedule();
        }
      }, QUALITY_UPGRADE_CHECK_MS);
      session.qualityWatchTimer.unref?.();
    };
    schedule();
  }

  async checkRecordingQualityUpgrade(room, session, targetQn) {
    if (session.rotating || session.qualitySwitching || room.liveStatus !== 1) {
      return;
    }
    const currentQn = Number(session.stream?.qn || 0);
    if (currentQn >= targetQn) {
      return;
    }
    const previousStream = session.stream ? { ...session.stream } : null;
    const nextStream = await this.resolvePlayStream(room, { purpose: '清晰度升级检查' });
    if (!nextStream?.url || !previousStream?.url) {
      return;
    }
    const betterQuality = Number(nextStream.qn || 0) > currentQn;
    const betterScore = streamScore(nextStream, this.settings) > streamScore(previousStream, this.settings);
    if (!betterQuality && !betterScore) {
      room.stream = previousStream;
      return;
    }
    session.nextStream = { ...nextStream };
    session.qualitySwitching = true;
    this.log(
      'success',
      `${roomLabel(room)} 检测到更合适的直播流：qn ${currentQn || '未知'} -> ${nextStream.qn || '未知'}，正在切换到新文件。`
    );
    requestFfmpegStop(session.ffmpeg, { graceful: true, timeoutMs: 5000 });
    this.emitState();
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
    clearTimeout(session.mediaWatchTimer);
    clearTimeout(session.qualityWatchTimer);
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
    clearTimeout(session.qualityWatchTimer);
    session.finished = true;
    session.danmakuClient?.close('录制结束');
    await new Promise((resolve) => session.eventStream.end(resolve));
    if (wasActiveSession) {
      room.recording = false;
    }
    const elapsedSec = Math.max(0, (Date.now() - session.startedAt) / 1000);
    const shouldContinueSegment =
      wasActiveSession &&
      (session.rotating || session.qualitySwitching || hasReachedSegmentLimit(session, elapsedSec)) &&
      !session.stopping;
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
    const mediaInfo = finalized ? probeMediaFileInfo(this.ffmpegPath, session.cleanPath) : { durationSec: 0, videoInfo: null };
    if (mediaInfo.videoInfo) {
      session.videoInfo = mediaInfo.videoInfo;
    }
    const actualDurationSec = resolveReliableDurationSec({
      mediaDurationSec: mediaInfo.durationSec,
      elapsedSec,
      segmentDurationSec: session.segmentDurationSec
    });
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
      durationSec: actualDurationSec,
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
      stream: session.nextStream || undefined,
      fallbackStream: session.stream,
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
    const discovered = await discoverRecordingFiles(this.settings.outputDir, {
      ffmpegPath: this.ffmpegPath,
      segmentDurationSec: this.getSegmentDurationSec()
    });
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
        durationSec: Number(recording.durationSec || current?.durationSec || 0),
        videoInfo: recording.videoInfo || current?.videoInfo
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
      this.burnCancelRequests.delete(room.id);
      const mediaInfo = probeMediaFileInfo(this.ffmpegPath, recording.cleanPath);
      const durationSec = await this.resolveRecordingDuration(recording, mediaInfo);
      if (durationSec > 0) {
        recording.durationSec = durationSec;
      }
      if (mediaInfo.videoInfo) {
        recording.videoInfo = mediaInfo.videoInfo;
      }
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
      const progress = createFfmpegJobProgress({
        kind: 'burn',
        label: `生成弹幕版：${path.basename(burnedPath)}`,
        outputPath: burnedPath,
        durationSec: recording.durationSec,
        roomId: room.id
      });
      room.burning = true;
      room.burnProgress = progress;
      this.burnSessions.set(room.id, ffmpeg);
      this.log('info', `${roomLabel(room)} 正在生成有弹幕版：${path.basename(burnedPath)}（${overlayModeLabel(overlayMode)}）`);
      if (this.settings.notifyBurnStarted) {
        this.notify('开始烧录弹幕版', `${roomLabel(room)} 正在生成 ${path.basename(burnedPath)}`);
      }

      ffmpeg.stderr.on('data', (chunk) => {
        const text = chunk.toString('utf8');
        if (updateFfmpegJobProgress(room.burnProgress, text)) {
          this.emitState();
        }
        if (/error|failed|invalid/i.test(text)) {
          this.log('warn', `${roomLabel(room)} 烧录：${compactLogLine(text)}`);
        }
      });
      ffmpeg.on('error', (error) => {
        finishFfmpegJobProgress(room.burnProgress, 'error', `启动失败：${error.message}`);
        this.log('error', `${roomLabel(room)} 烧录进程启动失败：${error.message}`);
        this.emitState();
      });
      ffmpeg.on('close', (code, signal) => {
        const progressId = room.burnProgress?.id;
        const cancelled = this.burnCancelRequests.delete(room.id);
        if (this.burnSessions.get(room.id) === ffmpeg) {
          room.burning = false;
          this.burnSessions.delete(room.id);
        }
        if (cancelled) {
          finishFfmpegJobProgress(room.burnProgress, 'cancelled', '弹幕视频生成已取消');
          fsp.rm(burnedPath, { force: true }).catch(() => {});
          this.log('info', `${roomLabel(room)} 已取消生成弹幕视频：${path.basename(burnedPath)}`);
        } else if (code === 0) {
          finishFfmpegJobProgress(room.burnProgress, 'completed', '弹幕版已生成');
          this.log('success', `${roomLabel(room)} 有弹幕版已生成：${path.basename(burnedPath)}`);
          if (this.settings.notifyBurnEnded) {
            this.notify('弹幕版已生成', `${roomLabel(room)} ${path.basename(burnedPath)}`);
          }
        } else {
          finishFfmpegJobProgress(room.burnProgress, 'error', `烧录失败：退出码 ${code}`);
          this.log('error', `${roomLabel(room)} 烧录失败：退出码 ${code}，信号 ${signal || '-'}`);
          if (this.settings.notifyBurnEnded) {
            this.notify('弹幕版烧录失败', `${roomLabel(room)} 退出码 ${code}`);
          }
        }
        this.emitState();
        setTimeout(() => {
          if (room.burnProgress?.id === progressId) {
            delete room.burnProgress;
            this.emitState();
          }
        }, 5000).unref?.();
        this.scheduleQueuedUpdateCheck();
      });
    } catch (error) {
      room.burning = false;
      finishFfmpegJobProgress(room.burnProgress, 'error', `生成失败：${error.message}`);
      this.log('error', `${roomLabel(room)} 生成弹幕版失败：${error.message}`);
      this.emitState();
      return false;
    }
    this.emitState();
    return true;
  }

  async cancelBurnDanmaku(roomId) {
    const room = this.getRoom(roomId);
    const ffmpeg = this.burnSessions.get(room.id);
    if (!ffmpeg) {
      return this.getState();
    }
    this.burnCancelRequests.add(room.id);
    if (room.burnProgress?.status === 'running') {
      room.burnProgress.message = '正在中断弹幕视频生成';
      room.burnProgress.updatedAt = Date.now();
    }
    this.log('info', `${roomLabel(room)} 正在取消弹幕视频生成。`);
    requestFfmpegStop(ffmpeg, { graceful: false, timeoutMs: 1500 });
    this.emitState();
    return this.getState();
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
    let endTime = parseTimeInput(options.endTime ?? options.end);
    const mediaInfo = probeMediaFileInfo(this.ffmpegPath, recording.cleanPath);
    const durationSec = await this.resolveRecordingDuration(recording, mediaInfo);
    if (durationSec > 0) {
      recording.durationSec = durationSec;
      if (Number.isFinite(endTime) && endTime > durationSec) {
        endTime = durationSec;
      }
    }
    if (mediaInfo.videoInfo) {
      recording.videoInfo = mediaInfo.videoInfo;
    }
    if (!Number.isFinite(startTime) || startTime < 0) {
      throw new Error('开始时间无效，请输入 00:00:00 或秒数。');
    }
    if (!Number.isFinite(endTime) || endTime <= startTime) {
      throw new Error('结束时间必须大于开始时间。');
    }
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
    let endTime = parseTimeInput(options.endTime ?? options.end);
    const mediaInfo = probeMediaFileInfo(this.ffmpegPath, recording.cleanPath);
    const durationSec = await this.resolveRecordingDuration(recording, mediaInfo);
    if (durationSec > 0) {
      recording.durationSec = durationSec;
      if (Number.isFinite(endTime) && endTime > durationSec) {
        endTime = durationSec;
      }
    }
    if (mediaInfo.videoInfo) {
      recording.videoInfo = mediaInfo.videoInfo;
    }
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

    const progress = createFfmpegJobProgress({
      kind: 'export',
      label: `导出${mode === 'clean' ? '纯净' : '烧录'}片段：${path.basename(outputPath)}`,
      outputPath,
      durationSec: duration
    });
    clearTimeout(this.exportProgressClearTimer);
    this.exportProgress = progress;
    this.exportProcess = null;
    this.exportCancelRequested = false;
    this.emitState();

    this.log('info', `开始导出${mode === 'clean' ? '纯净' : '烧录'}片段：${path.basename(outputPath)}`);
    let cancelled = false;
    try {
      await runFfmpegJob(this.ffmpegPath, args, (line) => {
        if (this.exportProgress?.id === progress.id && updateFfmpegJobProgress(this.exportProgress, line)) {
          this.emitState();
        }
        if (/error|failed|invalid/i.test(line)) {
          this.log('warn', `剪辑导出：${compactLogLine(line)}`);
        }
      }, {
        onChild: (child) => {
          this.exportProcess = child;
        }
      });
      if (this.exportProgress?.id === progress.id) {
        finishFfmpegJobProgress(this.exportProgress, 'completed', '片段已导出');
        this.emitState();
      }
      this.log('success', `片段已导出：${path.basename(outputPath)}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      cancelled = this.exportCancelRequested;
      if (cancelled) {
        if (this.exportProgress?.id === progress.id) {
          finishFfmpegJobProgress(this.exportProgress, 'cancelled', '导出已取消');
          this.emitState();
        }
        await fsp.rm(outputPath, { force: true }).catch(() => {});
        this.log('info', `已取消导出片段：${path.basename(outputPath)}`);
      } else if (this.exportProgress?.id === progress.id) {
        finishFfmpegJobProgress(this.exportProgress, 'error', `导出失败：${message}`);
        this.emitState();
      }
      if (!cancelled) {
        throw error;
      }
    } finally {
      if (this.exportProgress?.id === progress.id) {
        this.exportProcess = null;
        this.exportCancelRequested = false;
      }
      const progressId = progress.id;
      this.exportProgressClearTimer = setTimeout(() => {
        if (this.exportProgress?.id === progressId) {
          this.exportProgress = null;
          this.emitState();
        }
      }, 5000);
      this.exportProgressClearTimer.unref?.();
    }
    if (cancelled) {
      return {
        ok: false,
        mode,
        cleanPath: recording.cleanPath,
        cssPath,
        assPath: mode === 'burn' ? assPath : undefined
      };
    }
    return {
      ok: true,
      mode,
      outputPath,
      cleanPath: recording.cleanPath,
      cssPath,
      assPath: mode === 'burn' ? assPath : undefined
    };
  }

  async cancelExportClip() {
    if (!this.exportProcess) {
      return this.getState();
    }
    this.exportCancelRequested = true;
    if (this.exportProgress?.status === 'running') {
      this.exportProgress.message = '正在中断导出';
      this.exportProgress.updatedAt = Date.now();
    }
    this.log('info', '正在取消当前导出任务。');
    requestFfmpegStop(this.exportProcess, { graceful: false, timeoutMs: 1500 });
    this.emitState();
    return this.getState();
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
      if (!isDefaultUpdateSource(source, DEFAULT_UPDATE_MANIFEST_URL)) {
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
      Boolean(this.exportProcess) ||
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
      clearTimeout(session?.qualityWatchTimer);
      session?.danmakuClient?.close('服务退出');
      if (session?.ffmpeg) {
        requestFfmpegStop(session.ffmpeg, { graceful: true, timeoutMs: 1500 });
      }
    }
    for (const ffmpeg of this.burnSessions.values()) {
      requestFfmpegStop(ffmpeg, { graceful: false, timeoutMs: 1500 });
    }
    if (this.exportProcess) {
      requestFfmpegStop(this.exportProcess, { graceful: false, timeoutMs: 1500 });
    }
  }
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

function isHlsPreviewCandidate(stream) {
  const protocol = String(stream?.protocol || '').toLowerCase();
  const format = String(stream?.format || '').toLowerCase();
  const url = String(stream?.url || '').toLowerCase();
  return protocol.includes('hls') || format.includes('fmp4') || url.includes('.m3u8');
}

module.exports = {
  LiveRecordService,
  DEFAULT_HOST,
  DEV_MODE,
  OPEN_BROWSER,
  DIST_ROOT,
  writeJson,
  writeText,
  mimeType,
  getRuntimePort,
  getRuntimeHost,
  openUrl
};
