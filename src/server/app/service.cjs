const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const QRCode = require('qrcode');
const {
  DanmakuClient,
  requestBiliJsonWithCookies,
  fetchWithTimeout,
  getSetCookieHeaders,
  splitSetCookieHeader,
  mergeCookieString,
  cookieHeadersFromLoginUrl,
  danmakuCommandType,
  normalizeDanmakuEvent,
  normalizeDanmakuDisplayArea,
  danmakuDisplayAreaLabel,
  ensureDanmakuCss,
  createDefaultDanmakuCss,
  parseCssVariables,
  normalizeDanmakuStyle,
  prepareAssEvents,
  getDanmakuEventDuration,
  createRecordingArgs,
  createMp4FinalizeArgs,
  createBurnArgs,
  createPreviewHlsArgs,
  createClipCopyArgs,
  createConcatCopyArgs,
  createConcatTranscodeArgs,
  createAudioAlignArgs,
  selectHighestResolutionVideoInfo,
  shouldTranscodeConcat,
  assertSafeMergeTargetProfile,
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
  runCapturedProcess,
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
  probeMediaTimelineInfo,
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
  openUrl,
  openPath,
  mimeType
} = require('../shared/helpers.cjs');
const { AccessAuthManager, hashAccessPassword } = require('./auth.cjs');
const { AtomicJsonStore } = require('./atomic-store.cjs');
const { MediaJobManager } = require('./media-job-manager.cjs');
const { normalizeTrustedProxyList, validateRemoteUrl, redactSensitive } = require('../shared/security.cjs');
const { atomicReplaceFile, assertDiskSpace } = require('../recording/media-safety.cjs');
const { BufferedJsonlWriter } = require('../recording/jsonl-writer.cjs');



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
const RECORDING_LIBRARY_LIMIT = 160;
const DEFAULT_PORT = 3263;
const STREAM_QN_PROBES = [25000, 20000, 15000, 10000, 400, 250, 150];
const MIN_PLAYABLE_BYTES = 128 * 1024;
const NO_MEDIA_TIMEOUT_MS = 70 * 1000;
const MEDIA_STALL_CHECK_MS = 20 * 1000;
const MEDIA_STALL_TIMEOUT_MS = 75 * 1000;
const MIN_MEDIA_GROWTH_BYTES = 32 * 1024;
const WBI_MIXIN_KEY_TABLE = [
  46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49, 33, 9, 42, 19, 29, 28, 14,
  39, 12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40, 61, 26, 17, 0, 1, 60, 51, 30, 4, 22, 25, 54, 21, 56, 59,
  6, 63, 57, 62, 11, 36, 20, 34, 44, 52
];
const DEFAULT_HOST = '127.0.0.1';
const PROD_MODE = process.argv.includes('--prod');
const DEV_MODE = process.argv.includes('--dev') || !PROD_MODE;
const OPEN_BROWSER = !process.argv.includes('--no-open') && process.env.BILI_RECORD_NO_OPEN !== '1';
const DEV_PLATFORM_OVERRIDE = DEV_MODE ? String(process.env.BILI_RECORD_DEV_PLATFORM || '').trim().toLowerCase() : '';
const UI_PLATFORM = ['win32', 'linux', 'darwin'].includes(DEV_PLATFORM_OVERRIDE)
  ? DEV_PLATFORM_OVERRIDE
  : process.platform;
const APP_ROOT = getAppRoot();
const DIST_ROOT = path.join(APP_ROOT, 'dist');
const APP_VERSION = getAppVersion();
const DEFAULT_UPDATE_MANIFEST_URL =
  process.env.BILI_RECORD_UPDATE_URL ||
  'https://github.com/Metahumanz/LiveRecord2k/releases/latest/download/update.json';
const GITHUB_LATEST_RELEASE_API = 'https://api.github.com/repos/Metahumanz/LiveRecord2k/releases/latest';
const UPDATE_CHECK_TIMEOUT_MS = 12000;
const AUTO_UPDATE_INITIAL_DELAY_MS = 60 * 1000;
const AUTO_UPDATE_INTERVAL_MS = 6 * 60 * 60 * 1000;
const PATH_PROBE_TIMEOUT_MS = 2500;
const PATH_CREATE_TIMEOUT_MS = 8000;
const PATH_PICKER_TIMEOUT_MS = 5 * 60 * 1000;
const WEBHOOK_TIMEOUT_MS = 10 * 1000;
const WEBHOOK_MAX_QUEUE_SIZE = 100;
const WEBHOOK_RETRY_DELAYS_MS = [0, 1000, 3000];
const RUN_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';
const MAX_PROXY_IMAGE_BYTES = 15 * 1024 * 1024;
const MAX_JSON_BODY_BYTES = 1024 * 1024;
const SEGMENT_ROTATION_GRACE_MS = 10 * 1000;
const PREVIEW_SESSION_TTL_MS = 10 * 60 * 1000;
const MAX_PREVIEW_PLAYLIST_BYTES = 2 * 1024 * 1024;
const QUALITY_UPGRADE_CHECK_MS = 90 * 1000;
const RECORDING_MEDIA_FILE_PATTERN =
  /(?:\.(?:clean|merged|danmaku|danmaku-only)|\.clip_[^.]+\.(?:clean|danmaku|danmaku-only))\.(?:mp4|mkv)$/i;
const EXPORT_PREVIEW_EXTENSIONS = new Set(['.m3u8', '.ts']);
const CACHE_STATE_FILE = 'cache-state.json';
const CACHE_STATE_SCHEMA_VERSION = 1;
const PREVIEW_CACHE_VERSION = 'v1';
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

function isPublicServerHost(value) {
  const host = String(value || '').trim().toLowerCase();
  return host === '0.0.0.0' || host === '::';
}

function createUiCapabilities(platform = process.platform, environment = process.env, options = {}) {
  const normalizedPlatform = String(platform || '').trim().toLowerCase();
  const localConsole = options.localConsole !== false;
  const linuxDesktopSession =
    normalizedPlatform === 'linux' && Boolean(environment.DISPLAY || environment.WAYLAND_DISPLAY);
  const desktopPathIntegration =
    normalizedPlatform === 'win32' || normalizedPlatform === 'darwin' || linuxDesktopSession;
  const managedService = normalizedPlatform === 'linux' && environment.BILI_RECORD_SYSTEMD === '1';
  return {
    nativePathPicker: normalizedPlatform === 'win32' && localConsole,
    openServerPath: desktopPathIntegration && localConsole,
    nativeNotifications: normalizedPlatform === 'win32',
    startupControl: normalizedPlatform === 'win32',
    managedService,
    serviceShutdown: !managedService
  };
}

function isPrivateWebhookHostname(hostname) {
  const host = String(hostname || '').trim().toLowerCase().replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host === '::1' || host.startsWith('fc') || host.startsWith('fd')) {
    return true;
  }
  const octets = host.split('.').map(Number);
  if (octets.length !== 4 || octets.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return false;
  }
  return (
    octets[0] === 127 ||
    octets[0] === 10 ||
    (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) ||
    (octets[0] === 192 && octets[1] === 168)
  );
}

function normalizeWebhookUrl(value, options = {}) {
  const raw = String(value || '').trim();
  if (!raw) {
    if (options.required) {
      throw new Error('启用 Webhook 前请填写接收地址。');
    }
    return '';
  }
  if (raw.length > 2048) {
    throw new Error('Webhook 地址过长。');
  }
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error('Webhook 地址格式无效。');
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new Error('Webhook 地址只支持 HTTP 或 HTTPS。');
  }
  if (parsed.username || parsed.password) {
    throw new Error('Webhook 地址不能包含用户名或密码，请使用 Bearer Token。');
  }
  if (parsed.protocol === 'http:' && !isPrivateWebhookHostname(parsed.hostname)) {
    throw new Error('公网 Webhook 必须使用 HTTPS；HTTP 仅允许本机或私有 IP 地址。');
  }
  return parsed.toString();
}

function createWebhookPayload(notification) {
  const payload = {
    id: String(notification.webhookId || notification.id || crypto.randomUUID()),
    event: String(notification.event || 'notification'),
    title: String(notification.title || APP_NAME),
    message: String(notification.message || ''),
    occurredAt: new Date(Number(notification.time || Date.now())).toISOString(),
    source: {
      name: APP_NAME,
      version: APP_VERSION
    }
  };
  if (notification.data && Object.keys(notification.data).length) {
    payload.data = notification.data;
  }
  return payload;
}

function createDanmakuAssSuffix(overlayMode, danmakuArea) {
  const base = normalizeBurnOverlayMode(overlayMode) === 'danmaku' ? 'danmaku-only' : 'danmaku';
  return `${base}.${normalizeDanmakuDisplayArea(danmakuArea)}`;
}

function createClipDanmakuAssSuffix(startTime, endTime, overlayMode, danmakuArea) {
  return `${createClipSuffix(startTime, endTime, overlayMode)}.${normalizeDanmakuDisplayArea(danmakuArea)}`;
}

class LiveRecordService {
  constructor() {
    const appData =
      process.env.BILI_RECORD_CONFIG_DIR ||
      (process.platform === 'win32'
        ? process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming')
        : process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'));
    this.storePath = path.join(appData, 'BiliRecord2K', STORE_FILE);
    this.stateStore = new AtomicJsonStore(this.storePath);
    this.storeExists = false;
    this.previewCacheDir = path.join(appData, 'BiliRecord2K', 'preview-cache');
    this.legacyRepairCacheDir = path.join(appData, 'BiliRecord2K', 'repair-cache');
    this.settings = this.createDefaultSettings();
    this.rooms = new Map();
    this.logs = [];
    this.monitorTimers = new Map();
    this.livePushMonitors = new Map();
    this.roomTickLocks = new Set();
    this.recordingSessions = new Map();
    this.recordingStartLocks = new Set();
    this.reconnectPendingRooms = new Set();
    this.burnSessions = new Map();
    this.burnQueue = [];
    this.burnQueueRunning = false;
    this.activeBurnQueueItem = null;
    this.burnCancelRequests = new Set();
    this.pendingSegmentCleanups = new Map();
    this.mergeProcesses = new Map();
    this.mergeCancelRequests = new Set();
    this.mediaJobs = new MediaJobManager();
    this.draining = false;
    this.shutdownPromise = null;
    this.shutdownHandler = null;
    this.linuxCjkFontVerified = process.platform !== 'linux';
    this.previewSessions = new Map();
    this.exportPreviewProcess = null;
    this.exportPreviewProgress = null;
    this.exportPreview = null;
    this.exportPreviewClearTimer = null;
    this.exportProgress = null;
    this.exportProgressClearTimer = null;
    this.exportProcess = null;
    this.exportCancelRequested = false;
    this.exportQueue = [];
    this.exportQueueRunning = false;
    this.recordings = [];
    this.recordingScanPromise = null;
    this.clients = new Map();
    this.stateEmitTimer = null;
    this.notifications = [];
    this.notificationSeq = 0;
    this.webhookQueue = [];
    this.webhookQueueRunning = false;
    this.loginSession = null;
    this.wbiCache = null;
    this.pathPickerPromise = null;
    this.pathPickerProcess = null;
    this.pathPickerStarting = false;
    this.startupEnabled = false;
    this.outputDiskSpace = null;
    this.accessAuth = new AccessAuthManager();
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
    this.autoUpdateTimer = null;
    this.ffmpegPath = findFfmpegPath();
    this.ffmpegCapabilities = {
      burnCodecs: BURN_CODEC_CANDIDATES.filter((codec) => codec.kind === 'software'),
      unavailableBurnCodecs: [],
      hwaccels: [],
      videoAdapters: [],
      probedAt: 0,
      probeError: ''
    };
    this.settings = this.normalizeSettings(this.settings);
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
      burnDanmakuArea: 'half',
      burnCodec: 'libx265',
      burnCrf: 24,
      notifyLiveStarted: true,
      notifyLiveEnded: true,
      notifyRecordingStarted: true,
      notifyRecordingEnded: true,
      notifyBurnStarted: true,
      notifyBurnEnded: true,
      webhookEnabled: false,
      webhookUrl: '',
      webhookBearerToken: '',
      webhookAllowPrivateNetwork: false,
      openBrowserOnStart: true,
      hideOverviewNextStep: false,
      autoUpdateEnabled: false,
      updateManifestUrl: DEFAULT_UPDATE_MANIFEST_URL,
      serverHost: DEFAULT_HOST,
      serverPort: DEFAULT_PORT,
      accessUsername: 'admin',
      accessPasswordHash: '',
      trustedProxies: [],
      configBootstrapVersion: 0
    };
  }

  async init() {
    await this.loadStore();
    await this.bootstrapPersistentConfiguration();
    await this.loadLastUpdateStatus();
    try {
      await this.prepareVersionedCaches();
    } catch (error) {
      this.log('warn', `自动清理旧版本缓存失败，不影响本次启动：${error.message}`);
      await fsp.mkdir(this.previewCacheDir, { recursive: true });
    }
    this.settings = this.normalizeSettings(this.settings);
    for (const room of this.rooms.values()) {
      if (room.monitoring) {
        this.startMonitorTimer(room.id);
        setImmediate(() => {
          this.startLivePushMonitor(room.id).catch((error) => {
            this.log('warn', `${roomLabel(room)} 开播推送监听启动失败：${error.message}`);
          });
        });
      }
    }
    setImmediate(() => {
      this.refreshOutputDiskSpace().catch(() => {});
    });
    this.log('success', `WebUI 后端已启动，ffmpeg: ${this.ffmpegPath}`);
    this.log('info', '正在后台探测 ffmpeg、显卡能力和录像库。');
    setImmediate(() => {
      this.initializeRuntimeCapabilities().catch((error) => {
        this.log('warn', `后台能力探测失败：${error.message}`);
        this.emitState();
      });
    });
    setImmediate(() => {
      this.initializeRecordingLibrary().catch((error) => {
        this.log('warn', `后台扫描录像库失败：${error.message}`);
        this.emitState();
      });
    });
    setImmediate(() => {
      this.recoverPersistedSegmentCleanups().catch((error) => {
        this.log('warn', `恢复 0.4.0 分段清理任务失败：${error.message}`);
      });
    });
    this.scheduleAutomaticUpdateCheck(AUTO_UPDATE_INITIAL_DELAY_MS);
  }

  getCacheStatePath() {
    return path.join(path.dirname(this.storePath), CACHE_STATE_FILE);
  }

  async prepareVersionedCaches() {
    const configRoot = path.resolve(path.dirname(this.storePath));
    const previewCacheRoot = path.resolve(this.previewCacheDir);
    const legacyRepairCacheRoot = path.resolve(this.legacyRepairCacheDir);
    if (!isPathInsideDirectory(previewCacheRoot, configRoot)) {
      throw new Error(`兼容预览缓存目录不在配置目录内：${previewCacheRoot}`);
    }
    if (!isPathInsideDirectory(legacyRepairCacheRoot, configRoot)) {
      throw new Error(`旧版源流修复缓存目录不在配置目录内：${legacyRepairCacheRoot}`);
    }
    await fsp.mkdir(configRoot, { recursive: true });

    let previousState = null;
    try {
      const raw = await fsp.readFile(this.getCacheStatePath(), 'utf8');
      previousState = JSON.parse(raw);
    } catch (error) {
      if (error.code !== 'ENOENT') {
        previousState = null;
      }
    }

    const entries = await fsp.readdir(previewCacheRoot, { withFileTypes: true }).catch(() => []);
    const cacheStateMatches =
      previousState?.schemaVersion === CACHE_STATE_SCHEMA_VERSION &&
      previousState?.appVersion === APP_VERSION &&
      previousState?.previewCacheVersion === PREVIEW_CACHE_VERSION;
    const shouldClearPreviewCache = entries.length > 0 && !cacheStateMatches;
    const legacyRepairCacheStat = await fsp.lstat(legacyRepairCacheRoot).catch((error) => {
      if (error.code === 'ENOENT') {
        return null;
      }
      throw error;
    });
    const legacyRepairEntries = legacyRepairCacheStat?.isDirectory()
      ? await fsp.readdir(legacyRepairCacheRoot, { withFileTypes: true })
      : [];
    const shouldClearLegacyRepairCache = Boolean(legacyRepairCacheStat);

    if (shouldClearPreviewCache) {
      await fsp.rm(previewCacheRoot, { recursive: true, force: true });
    }
    if (shouldClearLegacyRepairCache) {
      await fsp.rm(legacyRepairCacheRoot, { recursive: true, force: true });
    }
    await fsp.mkdir(previewCacheRoot, { recursive: true });

    const nextState = {
      schemaVersion: CACHE_STATE_SCHEMA_VERSION,
      appVersion: APP_VERSION,
      previewCacheVersion: PREVIEW_CACHE_VERSION,
      updatedAt: new Date().toISOString()
    };
    await fsp.writeFile(this.getCacheStatePath(), `${JSON.stringify(nextState, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600
    });

    if (shouldClearPreviewCache || shouldClearLegacyRepairCache) {
      const previousVersion = String(previousState?.appVersion || '未标记版本')
        .replace(/[\r\n]/g, ' ')
        .slice(0, 64);
      const cleanedCaches = [];
      if (shouldClearPreviewCache) {
        cleanedCaches.push(`兼容预览缓存 ${entries.length} 项`);
      }
      if (shouldClearLegacyRepairCache) {
        cleanedCaches.push(`旧版源流修复缓存 ${legacyRepairEntries.length} 项`);
      }
      this.log(
        'info',
        `检测到旧版本缓存（${previousVersion} → ${APP_VERSION}），已自动清理${cleanedCaches.join('、')}。`
      );
    }
    return {
      cleared: shouldClearPreviewCache || shouldClearLegacyRepairCache,
      clearedPreviewCache: shouldClearPreviewCache,
      previewEntriesRemoved: shouldClearPreviewCache ? entries.length : 0,
      clearedLegacyRepairCache: shouldClearLegacyRepairCache,
      legacyRepairEntriesRemoved: shouldClearLegacyRepairCache ? legacyRepairEntries.length : 0,
      previousVersion: String(previousState?.appVersion || ''),
      currentVersion: APP_VERSION
    };
  }

  async initializeRecordingLibrary() {
    const outputReady = await this.ensureRecordingOutputRootReady(this.settings.outputDir, {
      label: '录像保存目录',
      allowUnavailable: true,
      permissionsRequired: false
    });
    if (!outputReady) {
      this.log('warn', `录像保存目录当前不可用，已跳过启动扫描：${this.settings.outputDir}`);
      return;
    }
    await this.refreshRecordingLibrary({ silent: true });
  }

  async initializeRuntimeCapabilities() {
    [this.ffmpegCapabilities, this.startupEnabled] = await Promise.all([
      detectFfmpegCapabilities(this.ffmpegPath),
      isStartupEnabled()
    ]);
    this.settings = this.normalizeSettings(this.settings);
    this.log('info', `可用弹幕版编码：${this.ffmpegCapabilities.burnCodecs.map((codec) => codec.label).join('、') || '未探测到'}`);
    this.log('info', `当前弹幕版编码：${this.getBurnCodecInfo(this.settings.burnCodec).label}（${this.settings.burnCodec}）`);
    this.emitState();
  }

  async loadStore() {
    try {
      const result = await this.stateStore.load();
      const store = result.store;
      this.storeExists = await fsp.stat(this.storePath).then((stat) => stat.isFile()).catch(() => false);
      this.settings = this.normalizeSettings({ ...this.settings, ...(store.settings || {}) });
      for (const savedRoom of store.rooms || []) {
        const room = this.normalizeRoom(savedRoom);
        this.rooms.set(room.id, room);
      }
      this.recordings = (store.recordings || []).map((recording) => this.normalizeRecording(recording)).filter(Boolean);
      this.pendingSegmentCleanups = new Map(
        (store.segmentCleanups || []).filter((item) => item?.cleanupId).map((item) => [item.cleanupId, item])
      );
      if (result.recoveredFromBackup) {
        this.log('warn', '主配置文件损坏，已从 settings.json.backup 恢复。');
        await this.saveStore();
      }
    } catch (error) {
      if (error.code !== 'ENOENT') {
        this.log('warn', `读取配置失败，将使用默认配置：${error.message}`);
      }
    }
  }

  async saveStore() {
    const rooms = Array.from(this.rooms.values()).map((room) => ({
      id: room.id,
      realRoomId: room.realRoomId,
      shortId: room.shortId,
      title: room.title,
      anchor: room.anchor,
      cover: room.cover,
      keyframe: room.keyframe,
      liveStatus: room.liveStatus,
      monitoring: room.monitoring,
      autoRecord: room.autoRecord !== false
    }));
    await this.stateStore.save({
      settings: this.settings,
      rooms,
      recordings: this.recordings,
      mediaJobs: [],
      segmentCleanups: Array.from(this.pendingSegmentCleanups.values())
    });
  }

  async recoverPersistedSegmentCleanups() {
    for (const cleanup of Array.from(this.pendingSegmentCleanups.values())) {
      if (!cleanup?.cleanupId || !cleanup?.mergedRecording?.cleanPath || !Array.isArray(cleanup.segments)) continue;
      const mergedExists = await isExistingFile(cleanup.mergedRecording.cleanPath);
      if (!mergedExists) {
        cleanup.status = 'error';
        cleanup.lastError = '合并产物不存在，源分段受保护且不会清理。';
        continue;
      }
      const room = this.rooms.get(String(cleanup.roomId)) || {
        id: String(cleanup.roomId || 'cleanup'),
        title: '分段清理',
        anchor: '恢复任务'
      };
      await this.cleanupMergedSegmentFiles(room, cleanup.segments, cleanup.mergedRecording, {
        cleanupId: cleanup.cleanupId
      });
    }
    await this.saveStore();
  }

  async bootstrapPersistentConfiguration() {
    const currentVersion = Number(this.settings.configBootstrapVersion || 0);
    const legacyPassword = String(this.settings.legacyAccessPassword || '');
    const environmentPassword = currentVersion < 1 ? String(process.env.BILI_RECORD_AUTH_PASSWORD || '') : '';
    let changed = false;
    if (!this.settings.accessPasswordHash && (legacyPassword || environmentPassword)) {
      const password = legacyPassword || environmentPassword;
      if (password.length < 8) {
        throw new Error('首次配置的远程访问密码至少需要 8 位。');
      }
      this.settings.accessPasswordHash = await hashAccessPassword(password);
      changed = true;
    }
    delete this.settings.legacyAccessPassword;
    if (currentVersion < 1) {
      const bootstrapHost = String(process.env.BILI_RECORD_HOST || '').trim();
      const bootstrapPort = Number(process.env.BILI_RECORD_PORT || 0);
      const bootstrapUsername = String(process.env.BILI_RECORD_AUTH_USERNAME || '').trim();
      const bootstrapOutputDir = String(process.env.BILI_RECORD_OUTPUT_DIR || '').trim();
      const bootstrapAutoUpdate = String(process.env.BILI_RECORD_AUTO_UPDATE || '').trim();
      if (bootstrapHost) this.settings.serverHost = normalizeServerHost(bootstrapHost);
      if (bootstrapPort >= 1 && bootstrapPort <= 65535) this.settings.serverPort = bootstrapPort;
      if (bootstrapUsername) this.settings.accessUsername = bootstrapUsername.slice(0, 64);
      if (bootstrapOutputDir) this.settings.outputDir = bootstrapOutputDir;
      if (bootstrapAutoUpdate) this.settings.autoUpdateEnabled = process.platform === 'linux' && bootstrapAutoUpdate === '1';
      this.settings.configBootstrapVersion = 1;
      changed = true;
    }
    this.settings = this.normalizeSettings(this.settings);
    if (changed) {
      await this.saveStore();
      this.log('info', '首次启动环境配置已迁移到持久化设置；后续运行不再读取 Host、Port、用户名和密码环境变量。');
    }
  }

  normalizeSettings(settings) {
    const burnCodec = this.ffmpegCapabilities
      ? this.chooseBurnCodec(settings.burnCodec)
      : normalizeBurnCodec(settings.burnCodec);
    return {
      ...this.createDefaultSettings(),
      ...settings,
      outputContainer: normalizeContainer(settings.outputContainer),
      burnCodec,
      pollIntervalSec: clamp(Number(settings.pollIntervalSec || 15), 1, 300),
      segmentMinutes: clamp(Number(settings.segmentMinutes || 60), 0.05, 1440),
      targetQn: normalizeTargetQn(settings.targetQn),
      burnCrf: clamp(Number(settings.burnCrf || 24), 16, 35),
      preferHevc: Boolean(settings.preferHevc),
      roomImageMode: normalizeRoomImageMode(settings.roomImageMode),
      autoBurnDanmaku: Boolean(settings.autoBurnDanmaku),
      burnOverlayMode: normalizeBurnOverlayMode(settings.burnOverlayMode),
      burnDanmakuArea: normalizeDanmakuDisplayArea(settings.burnDanmakuArea),
      notifyLiveStarted: settings.notifyLiveStarted !== false,
      notifyLiveEnded: settings.notifyLiveEnded !== false,
      notifyRecordingStarted: settings.notifyRecordingStarted !== false,
      notifyRecordingEnded: settings.notifyRecordingEnded !== false,
      notifyBurnStarted: settings.notifyBurnStarted !== false,
      notifyBurnEnded: settings.notifyBurnEnded !== false,
      webhookEnabled: Boolean(settings.webhookEnabled),
      webhookUrl: String(settings.webhookUrl || '').trim().slice(0, 2048),
      webhookBearerToken: String(settings.webhookBearerToken || '').trim().slice(0, 4096),
      webhookAllowPrivateNetwork: Boolean(settings.webhookAllowPrivateNetwork),
      openBrowserOnStart: settings.openBrowserOnStart !== false,
      hideOverviewNextStep: Boolean(settings.hideOverviewNextStep),
      autoUpdateEnabled: Boolean(settings.autoUpdateEnabled),
      updateManifestUrl: String(settings.updateManifestUrl || DEFAULT_UPDATE_MANIFEST_URL).trim(),
      serverHost: normalizeServerHost(settings.serverHost || DEFAULT_HOST),
      serverPort: clamp(Number(settings.serverPort || DEFAULT_PORT), 1, 65535),
      accessUsername: String(settings.accessUsername || 'admin').trim().slice(0, 64) || 'admin',
      accessPasswordHash: String(settings.accessPasswordHash || ''),
      trustedProxies: normalizeTrustedProxyList(settings.trustedProxies),
      configBootstrapVersion: Math.max(0, Number(settings.configBootstrapVersion || 0))
    };
  }

  getAvailableBurnCodecs() {
    const codecs = (this.ffmpegCapabilities?.burnCodecs || []).map((codec) => codec.value).filter(Boolean);
    return codecs.length ? codecs : ['libx265', 'libx264'];
  }

  chooseBurnCodec(value) {
    const rawCodec = String(value || '').trim();
    const burnCodec = normalizeBurnCodec(rawCodec);
    const availableBurnCodecs = this.getAvailableBurnCodecs();
    const availableSet = new Set(availableBurnCodecs);
    const preferredHardwareCodec = this.getPreferredHardwareBurnCodec();
    const stillDefaultSoftware = !rawCodec || burnCodec === 'libx265';
    if (preferredHardwareCodec && stillDefaultSoftware) {
      return preferredHardwareCodec;
    }
    if (availableBurnCodecs.length && !availableSet.has(burnCodec)) {
      return preferredHardwareCodec || availableBurnCodecs[0];
    }
    return burnCodec;
  }

  getPreferredHardwareBurnCodec() {
    const available = new Set(this.getAvailableBurnCodecs());
    return ['hevc_nvenc', 'h264_nvenc', 'hevc_qsv', 'h264_qsv', 'hevc_amf', 'h264_amf'].find((codec) =>
      available.has(codec)
    );
  }

  getBurnCodecInfo(codec) {
    const value = String(codec || '').trim();
    return (
      (this.ffmpegCapabilities?.burnCodecs || []).find((option) => option.value === value) ||
      (this.ffmpegCapabilities?.unavailableBurnCodecs || []).find((option) => option.value === value) ||
      BURN_CODEC_CANDIDATES.find((option) => option.value === value) ||
      { value, label: value || '未知编码', kind: 'software' }
    );
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
      autoRecord: room.autoRecord !== false,
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
      cleanupId: String(recording.cleanupId || ''),
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
      videoInfo: recording.videoInfo || null,
      timingInfo: recording.timingInfo || null
    };
  }

  getSegmentDurationSec(minutes = this.settings.segmentMinutes) {
    const value = Number(minutes || 0);
    return Number.isFinite(value) && value > 0 ? value * 60 : 0;
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

  getState(options = {}) {
    const settings = { ...this.settings };
    delete settings.accessPasswordHash;
    const webhookBearerTokenConfigured = Boolean(settings.webhookBearerToken);
    delete settings.webhookBearerToken;
    settings.accessPassword = '';
    settings.accessAuthConfigured = this.accessAuth.isConfigured(this.settings);
    settings.webhookBearerToken = '';
    settings.webhookBearerTokenConfigured = webhookBearerTokenConfigured;
    settings.webhookBearerTokenClear = false;
    if (options.redactCookie) {
      settings.cookie = '';
    }
    return {
      settings,
      rooms: Array.from(this.rooms.values()).map((room) => this.getPublicRoomState(room)),
      recordings: this.recordings,
      logs: this.logs,
      login: this.getPublicLoginState(),
      bilibiliLoggedIn: Boolean(getCookieValue(this.settings.cookie, 'SESSDATA')),
      bilibiliCookieVisible: !options.redactCookie,
      version: APP_VERSION,
      update: this.getPublicUpdateState(),
      ffmpegPath: this.ffmpegPath,
      ffmpegCapabilities: this.ffmpegCapabilities,
      exportProgress: this.exportProgress ? { ...this.exportProgress } : null,
      exportQueue: this.exportQueue.map((item) => this.getPublicExportQueueItem(item)),
      burnQueue: this.burnQueue.map((item) => this.getPublicBurnQueueItem(item)),
      previewProgress: this.exportPreviewProgress ? { ...this.exportPreviewProgress } : null,
      previewProxy: this.exportPreview ? { ...this.exportPreview } : null,
      mediaJobs: this.mediaJobs.snapshot(),
      startupEnabled: this.startupEnabled,
      outputDiskSpace: this.outputDiskSpace ? { ...this.outputDiskSpace } : null,
      access: {
        required: options.accessRequired ?? isPublicServerHost(this.currentHost || this.settings.serverHost),
        configured: this.accessAuth.isConfigured(this.settings),
        authenticated: Boolean(options.accessAuthenticated),
        username: this.settings.accessUsername
      },
      currentPort: this.currentPort || DEFAULT_PORT,
      currentHost: this.currentHost || DEFAULT_HOST,
      platform: UI_PLATFORM,
      uiCapabilities: createUiCapabilities(UI_PLATFORM, process.env, options),
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
      mergeProgress: room.mergeProgress ? { ...room.mergeProgress } : undefined,
      stream: room.stream ? { ...room.stream, url: '[hidden]' } : undefined
    };
  }

  getPublicExportQueueItem(item) {
    return {
      id: item.id,
      label: item.label,
      mode: item.mode,
      cleanPath: item.cleanPath,
      outputPath: item.outputPath,
      startTime: item.startTime,
      endTime: item.endTime,
      createdAt: item.createdAt
    };
  }

  getPublicBurnQueueItem(item) {
    return {
      id: item.id,
      roomId: item.roomId,
      label: item.label,
      cleanPath: item.recording?.cleanPath || '',
      createdAt: item.createdAt
    };
  }

  async loginAccess(username, password, remoteKey) {
    return this.accessAuth.login({
      username,
      password,
      settings: this.settings,
      remoteKey
    });
  }

  authenticateAccess(token) {
    return this.accessAuth.authenticate(token);
  }

  logoutAccess(token) {
    this.accessAuth.logout(token);
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
      activeJobs: this.hasActiveJobs(),
      autoApplySupported: this.supportsManagedLinuxUpdate()
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

  addClient(response, options = {}) {
    this.clients.set(response, {
      redactCookie: Boolean(options.redactCookie),
      localConsole: Boolean(options.localConsole),
      accessAuthenticated: Boolean(options.accessAuthenticated),
      accessRequired: Boolean(options.accessRequired)
    });
    this.writeSseState(response, options);
    response.on('close', () => this.clients.delete(response));
  }

  emitState() {
    if (this.stateEmitTimer) return;
    this.stateEmitTimer = setTimeout(() => {
      this.stateEmitTimer = null;
      this.flushState();
    }, 80);
    this.stateEmitTimer.unref?.();
  }

  flushState() {
    for (const [response, options] of this.clients) {
      this.writeSseState(response, options);
    }
  }

  writeSseState(response, options = {}) {
    try {
      response.write(`data: ${JSON.stringify(this.getState(options))}\n\n`);
    } catch {
      this.clients.delete(response);
    }
  }

  log(level, message) {
    this.logs.push({
      id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
      time: Date.now(),
      level,
      message: redactSensitive(message)
    });
    if (this.logs.length > 400) {
      this.logs.splice(0, this.logs.length - 400);
    }
    this.emitState();
  }

  notify(title, message, event = 'notification', data = {}, options = {}) {
    const notification = {
      id: ++this.notificationSeq,
      time: Date.now(),
      event: String(event || 'notification'),
      title: String(title || APP_NAME),
      message: String(message || ''),
      data: data && typeof data === 'object' ? data : {}
    };
    notification.webhookId = `${notification.time}-${notification.id}`;
    this.notifications.push(notification);
    if (this.notifications.length > 80) {
      this.notifications.splice(0, this.notifications.length - 80);
    }
    if (process.env.BILI_RECORD_TRAY !== '1') {
      showWindowsToast(notification.title, notification.message);
    }
    if (options.webhook !== false) {
      this.enqueueWebhookNotification(notification);
    }
  }

  enqueueWebhookNotification(notification) {
    if (!this.settings.webhookEnabled || !this.settings.webhookUrl) {
      return;
    }
    if (this.webhookQueue.length >= WEBHOOK_MAX_QUEUE_SIZE) {
      this.webhookQueue.shift();
      this.log('warn', 'Webhook 待发送队列已满，已丢弃最早的一条通知。');
    }
    this.webhookQueue.push({
      notification,
      config: {
        url: this.settings.webhookUrl,
        bearerToken: this.settings.webhookBearerToken,
        allowPrivateNetwork: this.settings.webhookAllowPrivateNetwork
      }
    });
    if (!this.webhookQueueRunning) {
      setImmediate(() => {
        this.processWebhookQueue().catch((error) => {
          this.log('warn', `Webhook 队列异常：${error.message}`);
        });
      });
    }
  }

  async processWebhookQueue() {
    if (this.webhookQueueRunning) {
      return;
    }
    this.webhookQueueRunning = true;
    try {
      while (this.webhookQueue.length) {
        const item = this.webhookQueue.shift();
        try {
          await this.sendWebhookNotification(item.notification, { config: item.config });
        } catch (error) {
          this.log('warn', `Webhook 通知发送失败（${item.notification.event}）：${error.message}`);
        }
      }
    } finally {
      this.webhookQueueRunning = false;
      if (this.webhookQueue.length) {
        setImmediate(() => this.processWebhookQueue().catch(() => {}));
      }
    }
  }

  async sendWebhookNotification(notification, options = {}) {
    const config = options.config || {
      url: this.settings.webhookUrl,
      bearerToken: this.settings.webhookBearerToken,
      allowPrivateNetwork: this.settings.webhookAllowPrivateNetwork
    };
    const url = normalizeWebhookUrl(config.url, { required: true });
    const bearerToken = String(config.bearerToken || '').trim();
    if (/\r|\n/.test(bearerToken)) {
      throw new Error('Webhook Bearer Token 不能包含换行。');
    }
    const payload = createWebhookPayload(notification);
    const body = JSON.stringify(payload);
    const headers = {
      'Content-Type': 'application/json',
      'User-Agent': `${APP_NAME}/${APP_VERSION}`,
      'X-BiliRecord2K-Event': payload.event
    };
    if (bearerToken) {
      headers.Authorization = `Bearer ${bearerToken}`;
    }
    const retryDelays = Array.isArray(options.retryDelays) ? options.retryDelays : WEBHOOK_RETRY_DELAYS_MS;
    let lastError;
    for (const retryDelay of retryDelays) {
      if (retryDelay > 0) {
        await delay(retryDelay);
      }
      try {
        await requestUrlBuffer(url, {
          method: 'POST',
          headers,
          body,
          retries: 1,
          timeoutMs: WEBHOOK_TIMEOUT_MS,
          maxRedirects: 0,
          maxBytes: 64 * 1024,
          allowProxy: false,
          validateUrl: (target) => validateRemoteUrl(target, { allowPrivate: Boolean(config.allowPrivateNetwork) })
        });
        return payload;
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError || new Error('Webhook 请求失败。');
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

  async chooseOutputDir(currentPath = '') {
    const result = await this.selectPath({ type: 'directory', currentPath: currentPath || this.settings.outputDir });
    return result.path ? { path: result.path } : result;
  }

  async getDiskSpace(targetPath = this.settings.outputDir) {
    const rawPath = String(targetPath || this.settings.outputDir || '').trim();
    if (!rawPath) {
      throw new Error('请先填写录像保存目录。');
    }
    let candidate = path.resolve(rawPath);
    let stat = await withTimeout(fsp.stat(candidate), PATH_PROBE_TIMEOUT_MS, '磁盘路径检查超时').catch(() => null);
    if (stat?.isFile()) {
      candidate = path.dirname(candidate);
    }
    while (!stat) {
      const parent = path.dirname(candidate);
      if (parent === candidate) {
        break;
      }
      candidate = parent;
      stat = await withTimeout(fsp.stat(candidate), PATH_PROBE_TIMEOUT_MS, '磁盘路径检查超时').catch(() => null);
    }
    if (!stat) {
      throw new Error(`找不到可用于检查磁盘空间的上级目录：${rawPath}`);
    }
    if (typeof fsp.statfs !== 'function') {
      throw new Error('当前 Node.js 版本不支持磁盘空间检查。');
    }
    const fsInfo = await withTimeout(
      fsp.statfs(candidate, { bigint: true }),
      PATH_PROBE_TIMEOUT_MS,
      '磁盘空间检查超时'
    );
    const blockSize = fsInfo.bsize || fsInfo.frsize || 0n;
    const totalBytes = blockSize * fsInfo.blocks;
    const freeBytes = blockSize * (fsInfo.bavail ?? fsInfo.bfree);
    const result = {
      requestedPath: rawPath,
      checkedPath: candidate,
      totalBytes: Number(totalBytes),
      freeBytes: Number(freeBytes),
      usedBytes: Number(totalBytes - freeBytes),
      usedPercent: totalBytes > 0n ? Number(((totalBytes - freeBytes) * 10000n) / totalBytes) / 100 : 0,
      checkedAt: Date.now()
    };
    if (path.resolve(rawPath).toLowerCase() === path.resolve(this.settings.outputDir).toLowerCase()) {
      this.outputDiskSpace = result;
    }
    return result;
  }

  async refreshOutputDiskSpace() {
    try {
      this.outputDiskSpace = await this.getDiskSpace(this.settings.outputDir);
    } catch (error) {
      this.outputDiskSpace = {
        requestedPath: String(this.settings.outputDir || ''),
        checkedPath: '',
        totalBytes: 0,
        freeBytes: 0,
        usedBytes: 0,
        usedPercent: 0,
        checkedAt: Date.now(),
        error: error.message
      };
    }
    this.emitState();
    return this.outputDiskSpace;
  }

  getLocalFallbackDirectory() {
    const systemDrive = String(process.env.SystemDrive || '').trim();
    if (/^[a-z]:$/i.test(systemDrive)) {
      return `${systemDrive}\\`;
    }
    return path.parse(process.execPath).root || path.parse(os.tmpdir()).root || os.tmpdir();
  }

  async probePathAvailability(targetPath, options = {}) {
    const rawPath = String(targetPath || '').trim();
    if (!rawPath) {
      return { kind: 'unavailable', path: '', existingPath: '' };
    }
    const resolved = path.resolve(rawPath);
    const timeoutMs = Math.max(250, Number(options.timeoutMs || PATH_PROBE_TIMEOUT_MS));
    if (process.platform !== 'win32') {
      try {
        const stat = await withTimeout(fsp.stat(resolved), timeoutMs, '路径检测超时');
        return { kind: stat.isDirectory() ? 'directory' : 'file', path: resolved, existingPath: resolved };
      } catch (error) {
        if (/超时/.test(error.message || '')) {
          return { kind: 'timeout', path: resolved, existingPath: '' };
        }
        let cursor = path.dirname(resolved);
        const root = path.parse(resolved).root;
        while (cursor) {
          try {
            const stat = await withTimeout(fsp.stat(cursor), timeoutMs, '路径检测超时');
            if (stat.isDirectory()) {
              return { kind: 'missing', path: resolved, existingPath: cursor };
            }
          } catch (ancestorError) {
            if (/超时/.test(ancestorError.message || '')) {
              return { kind: 'timeout', path: resolved, existingPath: '' };
            }
          }
          if (cursor === root) {
            break;
          }
          const parent = path.dirname(cursor);
          if (parent === cursor) {
            break;
          }
          cursor = parent;
        }
        return { kind: 'unavailable', path: resolved, existingPath: '' };
      }
    }

    const script = `
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::UTF8
$target = $env:BR2K_PATH_PROBE_TARGET
$result = [ordered]@{ kind = 'unavailable'; path = $target; existingPath = '' }
try {
  if ([System.IO.Directory]::Exists($target)) {
    $result.kind = 'directory'
    $result.existingPath = [System.IO.Path]::GetFullPath($target)
  } elseif ([System.IO.File]::Exists($target)) {
    $result.kind = 'file'
    $result.existingPath = [System.IO.Path]::GetFullPath($target)
  } else {
    $cursor = $target
    while ($cursor) {
      try { $parent = [System.IO.Directory]::GetParent($cursor) } catch { $parent = $null }
      if (-not $parent) { break }
      $cursor = $parent.FullName
      if ([System.IO.Directory]::Exists($cursor)) {
        $result.kind = 'missing'
        $result.existingPath = $cursor
        break
      }
    }
  }
} catch {}
$result | ConvertTo-Json -Compress
`;
    const result = await runCapturedProcess(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
      {
        timeoutMs,
        maxOutputBytes: 32 * 1024,
        env: { ...process.env, BR2K_PATH_PROBE_TARGET: resolved }
      }
    );
    if (result.timedOut) {
      return { kind: 'timeout', path: resolved, existingPath: '' };
    }
    if (result.status !== 0) {
      return { kind: 'unavailable', path: resolved, existingPath: '' };
    }
    try {
      const parsed = JSON.parse(String(result.stdout || '').trim());
      return {
        kind: ['directory', 'file', 'missing'].includes(parsed.kind) ? parsed.kind : 'unavailable',
        path: resolved,
        existingPath: String(parsed.existingPath || '')
      };
    } catch {
      return { kind: 'unavailable', path: resolved, existingPath: '' };
    }
  }

  async createDirectoryWithTimeout(directoryPath, options = {}) {
    const rawPath = String(directoryPath || '').trim();
    if (!rawPath) {
      throw new Error('要创建的目录为空。');
    }
    const resolved = path.resolve(rawPath);
    const timeoutMs = Math.max(500, Number(options.timeoutMs || PATH_CREATE_TIMEOUT_MS));
    if (process.platform !== 'win32') {
      await withTimeout(fsp.mkdir(resolved, { recursive: true }), timeoutMs, `创建目录超时：${resolved}`);
      return resolved;
    }
    const script = `
$ErrorActionPreference = 'Stop'
$target = $env:BR2K_CREATE_DIRECTORY_TARGET
[System.IO.Directory]::CreateDirectory($target) | Out-Null
`;
    const result = await runCapturedProcess(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
      {
        timeoutMs,
        maxOutputBytes: 32 * 1024,
        env: { ...process.env, BR2K_CREATE_DIRECTORY_TARGET: resolved }
      }
    );
    if (result.timedOut) {
      throw new Error(`创建目录超时，盘符可能已断开：${resolved}`);
    }
    if (result.status !== 0) {
      throw new Error(`无法创建目录 ${resolved}：${compactLogLine(result.stderr || result.stdout || '路径不可用')}`);
    }
    return resolved;
  }

  async ensureDirectoryReady(directoryPath, options = {}) {
    const rawPath = String(directoryPath || '').trim();
    if (!rawPath) {
      throw new Error(`${String(options.label || '目录')}为空。`);
    }
    const resolved = path.resolve(rawPath);
    const label = String(options.label || '目录');
    const probe = await this.probePathAvailability(resolved, options);
    if (probe.kind === 'directory') {
      return true;
    }
    if (probe.kind === 'file') {
      throw new Error(`${label}指向了文件而不是文件夹：${resolved}`);
    }
    if (probe.kind === 'missing' && options.create !== false) {
      await this.createDirectoryWithTimeout(resolved, options);
      return true;
    }
    if (options.allowUnavailable) {
      return false;
    }
    const reason = probe.kind === 'timeout' ? '检测超时，盘符可能已断开' : '盘符或上级目录不可用';
    throw new Error(`${label}${reason}：${resolved}`);
  }

  async normalizeLinuxRecordingRootPermissions(directoryPath, options = {}) {
    const runtimePlatform = String(options.platform || process.platform);
    if (runtimePlatform !== 'linux') {
      return false;
    }
    const fileSystem = options.fileSystem || fsp;
    const resolved = path.resolve(String(directoryPath || '').trim());
    const label = String(options.label || '录像保存根目录');
    const filesystemRoot = path.parse(resolved).root;
    if (resolved === filesystemRoot) {
      throw new Error(`${label}不能直接使用文件系统根目录，已拒绝修改其权限：${resolved}`);
    }
    const currentUid = Number.isInteger(options.currentUid)
      ? options.currentUid
      : typeof process.getuid === 'function'
        ? process.getuid()
        : null;
    const currentGid = Number.isInteger(options.currentGid)
      ? options.currentGid
      : typeof process.getgid === 'function'
        ? process.getgid()
        : null;
    const initialStat = await fileSystem.stat(resolved);
    if (!initialStat.isDirectory()) {
      throw new Error(`${label}指向了文件而不是文件夹：${resolved}`);
    }
    const initialMode = initialStat.mode & 0o7777;
    const groupMatches = currentGid === null || initialStat.gid === currentGid;
    if (initialMode === 0o2770 && groupMatches) {
      return false;
    }
    if (currentUid !== null && initialStat.uid !== currentUid) {
      throw new Error(
        `${label}不属于当前服务用户，无法安全规范为当前服务组的 2770：${resolved}。` +
          '请只修改该目录节点的属组和权限，不要递归处理历史录像。'
      );
    }
    try {
      if (currentGid !== null && initialStat.gid !== currentGid) {
        await fileSystem.chown(resolved, initialStat.uid, currentGid);
      }
      await fileSystem.chmod(resolved, 0o2770);
      const normalizedStat = await fileSystem.stat(resolved);
      const normalizedMode = normalizedStat.mode & 0o7777;
      if (normalizedMode !== 0o2770 || (currentGid !== null && normalizedStat.gid !== currentGid)) {
        throw new Error(`实际权限为 ${normalizedMode.toString(8)}，属组 ID 为 ${normalizedStat.gid}`);
      }
    } catch (error) {
      throw new Error(
        `${label}无法规范为当前服务组的 2770：${resolved}（${error.message}）。` +
          '请只修改该目录节点的属组和权限，不要递归处理历史录像。'
      );
    }
    this.log('info', `已将录像保存根目录规范为当前服务组的 2770（仅目录本身，不递归处理历史录像）：${resolved}`);
    return true;
  }

  async ensureRecordingOutputRootReady(directoryPath, options = {}) {
    const ready = await this.ensureDirectoryReady(directoryPath, options);
    if (!ready) {
      return false;
    }
    try {
      await this.normalizeLinuxRecordingRootPermissions(directoryPath, options);
    } catch (error) {
      if (options.permissionsRequired === false) {
        this.log('warn', error.message);
        return true;
      }
      throw error;
    }
    return true;
  }

  async resolveAvailableDirectory(targetPath, label = '目录') {
    const rawPath = String(targetPath || '').trim();
    if (!rawPath) {
      return {
        directory: this.getLocalFallbackDirectory(),
        fallback: true,
        reason: `${label}为空`
      };
    }
    const resolved = path.resolve(rawPath);
    const probe = await this.probePathAvailability(resolved);
    if (probe.kind === 'directory') {
      return { directory: resolved, fallback: false, reason: '' };
    }
    if (probe.kind === 'file') {
      return { directory: path.dirname(resolved), fallback: false, reason: '' };
    }
    if (probe.kind === 'missing' && probe.existingPath) {
      return {
        directory: probe.existingPath,
        fallback: true,
        reason: `${label}不存在，已回退到最近可用的上级目录`
      };
    }
    return {
      directory: this.getLocalFallbackDirectory(),
      fallback: true,
      reason: probe.kind === 'timeout' ? `${label}检测超时或盘符已断开` : `${label}所在盘符不可用`
    };
  }

  async resolvePathPickerInitialPath(currentPath, dialogType) {
    const current = String(currentPath || '').trim();
    if (!current) {
      return this.getLocalFallbackDirectory();
    }
    const isFileDialog = dialogType !== 'directory';
    const candidateDirectory = isFileDialog && path.extname(current) ? path.dirname(current) : current;
    const resolved = await this.resolveAvailableDirectory(candidateDirectory, '原始选择路径');
    if (resolved.fallback) {
      this.log('warn', `${resolved.reason}：${current} -> ${resolved.directory}`);
      return resolved.directory;
    }
    return isFileDialog && path.extname(current) ? current : resolved.directory;
  }

  async selectPath(options = {}) {
    const type = String(options.type || 'directory');
    const currentPath = String(options.currentPath || options.path || '').trim();
    const dialogType = ['video', 'danmaku', 'css'].includes(type) ? type : 'directory';
    if (process.platform !== 'win32') {
      return {
        ok: false,
        cancelled: false,
        message: '当前系统暂不支持原生路径选择，请直接在输入框中填写路径。'
      };
    }
    if (this.pathPickerPromise || this.pathPickerStarting) {
      return {
        ok: false,
        cancelled: false,
        message: '已有系统路径选择器打开，请先完成选择或取消。'
      };
    }
    this.pathPickerStarting = true;
    let safeCurrentPath;
    try {
      safeCurrentPath = await this.resolvePathPickerInitialPath(currentPath, dialogType);
    } catch (error) {
      this.pathPickerStarting = false;
      throw error;
    }
    const filters = {
      video: '视频文件 (*.mp4;*.mkv;*.mov;*.m4v;*.webm)|*.mp4;*.mkv;*.mov;*.m4v;*.webm|所有文件 (*.*)|*.*',
      danmaku: '弹幕记录 (*.jsonl)|*.jsonl|所有文件 (*.*)|*.*',
      css: '样式文件 (*.css)|*.css|所有文件 (*.*)|*.*'
    };
    const titles = {
      directory: '选择目录',
      video: '选择原始录像文件',
      danmaku: '选择弹幕记录文件',
      css: '选择弹幕样式文件'
    };
    const script = `
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::UTF8
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

public static class BiliRecordWindowTools
{
    private delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

    private static readonly IntPtr HWND_TOPMOST = new IntPtr(-1);
    private const uint SWP_NOSIZE = 0x0001;
    private const uint SWP_NOMOVE = 0x0002;
    private const uint SWP_SHOWWINDOW = 0x0040;
    private const int SW_SHOW = 5;

    [DllImport("user32.dll")]
    private static extern bool EnumWindows(EnumWindowsProc callback, IntPtr lParam);

    [DllImport("user32.dll")]
    private static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);

    [DllImport("user32.dll")]
    private static extern bool IsWindowVisible(IntPtr hWnd);

    [DllImport("user32.dll")]
    private static extern bool SetWindowPos(
        IntPtr hWnd,
        IntPtr hWndInsertAfter,
        int x,
        int y,
        int width,
        int height,
        uint flags
    );

    [DllImport("user32.dll")]
    private static extern bool BringWindowToTop(IntPtr hWnd);

    [DllImport("user32.dll")]
    private static extern bool SetForegroundWindow(IntPtr hWnd);

    [DllImport("user32.dll")]
    private static extern bool ShowWindow(IntPtr hWnd, int command);

    public static void PinOwner(IntPtr ownerHandle)
    {
        SetWindowPos(ownerHandle, HWND_TOPMOST, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_SHOWWINDOW);
        BringWindowToTop(ownerHandle);
        SetForegroundWindow(ownerHandle);
    }

    public static bool PinVisibleDialog(int processId, IntPtr ownerHandle)
    {
        bool found = false;
        EnumWindows(delegate(IntPtr hWnd, IntPtr lParam)
        {
            uint windowProcessId;
            GetWindowThreadProcessId(hWnd, out windowProcessId);
            if (
                windowProcessId == (uint)processId &&
                hWnd != ownerHandle &&
                IsWindowVisible(hWnd)
            )
            {
                ShowWindow(hWnd, SW_SHOW);
                SetWindowPos(hWnd, HWND_TOPMOST, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_SHOWWINDOW);
                BringWindowToTop(hWnd);
                SetForegroundWindow(hWnd);
                found = true;
            }
            return true;
        }, IntPtr.Zero);
        return found;
    }
}
'@
$type = $env:BR2K_DIALOG_TYPE
$current = $env:BR2K_CURRENT_PATH
$owner = New-Object System.Windows.Forms.Form
$owner.ShowInTaskbar = $false
$owner.ShowIcon = $false
$owner.Text = $env:BR2K_DIALOG_TITLE
$owner.FormBorderStyle = [System.Windows.Forms.FormBorderStyle]::None
$owner.StartPosition = [System.Windows.Forms.FormStartPosition]::Manual
$owner.Size = New-Object System.Drawing.Size(2, 2)
$owner.Location = [System.Windows.Forms.Cursor]::Position
$owner.Opacity = 0.01
$owner.TopMost = $true
$dialog = $null
$foregroundTimer = $null
try {
  $owner.Show()
  [BiliRecordWindowTools]::PinOwner($owner.Handle)
  $owner.BringToFront()
  $owner.Activate()
  $processId = [System.Diagnostics.Process]::GetCurrentProcess().Id
  $foregroundTimer = New-Object System.Windows.Forms.Timer
  $foregroundTimer.Interval = 100
  $foregroundTimer.Add_Tick({
    if ([BiliRecordWindowTools]::PinVisibleDialog($processId, $owner.Handle)) {
      $foregroundTimer.Stop()
    } else {
      [BiliRecordWindowTools]::PinOwner($owner.Handle)
    }
  })
  $foregroundTimer.Start()
  if ($type -eq 'directory') {
    $dialog = New-Object System.Windows.Forms.FolderBrowserDialog
    $dialog.Description = $env:BR2K_DIALOG_TITLE
    if ($current) {
      try { $dialog.SelectedPath = $current } catch {}
    }
    if ($dialog.ShowDialog($owner) -eq [System.Windows.Forms.DialogResult]::OK) {
      Write-Output $dialog.SelectedPath
      exit 0
    }
    exit 2
  }
  $dialog = New-Object System.Windows.Forms.OpenFileDialog
  $dialog.Title = $env:BR2K_DIALOG_TITLE
  $dialog.Filter = $env:BR2K_FILE_FILTER
  if ($current) {
    try {
      $extension = [System.IO.Path]::GetExtension($current)
      if ($extension) {
        $dialog.InitialDirectory = [System.IO.Path]::GetDirectoryName($current)
        $dialog.FileName = [System.IO.Path]::GetFileName($current)
      } else {
        $dialog.InitialDirectory = $current
      }
    } catch {}
  }
  if ($dialog.ShowDialog($owner) -eq [System.Windows.Forms.DialogResult]::OK) {
    Write-Output $dialog.FileName
    exit 0
  }
  exit 2
} finally {
  if ($foregroundTimer) {
    $foregroundTimer.Stop()
    $foregroundTimer.Dispose()
  }
  if ($dialog) { $dialog.Dispose() }
  $owner.Close()
  $owner.Dispose()
}
`;
    let pickerPromise;
    try {
      pickerPromise = this.runWindowsPathPicker(
        script,
        {
          BR2K_DIALOG_TYPE: dialogType,
          BR2K_CURRENT_PATH: safeCurrentPath,
          BR2K_DIALOG_TITLE: titles[dialogType],
          BR2K_FILE_FILTER: filters[dialogType] || ''
        },
        { timeoutMs: Number(options.timeoutMs || PATH_PICKER_TIMEOUT_MS) }
      );
    } catch (error) {
      this.pathPickerStarting = false;
      throw error;
    }
    this.pathPickerPromise = pickerPromise;
    this.pathPickerStarting = false;
    let result;
    try {
      result = await pickerPromise;
    } finally {
      if (this.pathPickerPromise === pickerPromise) {
        this.pathPickerPromise = null;
        this.pathPickerProcess = null;
      }
      this.pathPickerStarting = false;
    }
    if (result.status === 0) {
      const selectedPath = String(result.stdout || '').trim();
      if (selectedPath) {
        return { ok: true, path: selectedPath, cancelled: false };
      }
    }
    if (result.status === 2) {
      return { ok: false, cancelled: true };
    }
    return {
      ok: false,
      cancelled: false,
      message: String(result.error?.message || result.stderr || result.stdout || '系统路径选择器打开失败。').trim()
    };
  }

  runWindowsPathPicker(script, environment, options = {}) {
    return new Promise((resolve) => {
      let stdout = '';
      let stderr = '';
      let settled = false;
      let timer = null;
      const finish = (status, error = null) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        resolve({ status, stdout, stderr, error });
      };

      let child;
      try {
        child = spawn('powershell.exe', ['-NoProfile', '-STA', '-ExecutionPolicy', 'Bypass', '-Command', script], {
          windowsHide: true,
          stdio: ['ignore', 'pipe', 'pipe'],
          env: { ...process.env, ...environment }
        });
        this.pathPickerProcess = child;
      } catch (error) {
        finish(null, error);
        return;
      }

      child.stdout.on('data', (chunk) => {
        stdout = `${stdout}${chunk.toString('utf8')}`.slice(-64 * 1024);
      });
      child.stderr.on('data', (chunk) => {
        stderr = `${stderr}${chunk.toString('utf8')}`.slice(-64 * 1024);
      });
      child.on('error', (error) => finish(null, error));
      child.on('close', (status) => finish(status));
      const timeoutMs = Math.max(1000, Number(options.timeoutMs || PATH_PICKER_TIMEOUT_MS));
      timer = setTimeout(() => {
        const error = new Error(`系统路径选择器等待超过 ${Math.round(timeoutMs / 1000)} 秒，已自动关闭。`);
        error.code = 'PATH_PICKER_TIMEOUT';
        forceKillProcess(child);
        finish(null, error);
      }, timeoutMs);
      timer.unref?.();
    });
  }

  async openOutputDir() {
    return this.openDirectoryWithFallback(this.settings.outputDir, { label: '录像保存目录' });
  }

  async openPathDir(filePath, options = {}) {
    const targetPath = String(filePath || '').trim();
    if (!targetPath) {
      throw new Error('路径为空。');
    }
    const resolved = path.resolve(targetPath);
    return this.openDirectoryWithFallback(resolved, {
      label: options.asDirectory ? '指定目录' : '文件所在目录'
    });
  }

  openSystemPath(targetPath) {
    openPath(targetPath);
  }

  async openDirectoryWithFallback(targetPath, options = {}) {
    const resolved = await this.resolveAvailableDirectory(targetPath, options.label || '目录');
    this.openSystemPath(resolved.directory);
    if (!resolved.fallback) {
      this.log('info', `已打开目录：${resolved.directory}`);
      return this.getState();
    }
    const message = `${resolved.reason}，已打开 ${resolved.directory}。原路径：${path.resolve(String(targetPath || ''))}`;
    this.log('warn', message);
    return {
      ...this.getState(),
      operationNotice: {
        kind: 'warning',
        title: '原目录不可用，已回退',
        message
      }
    };
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
        const mergedCookie = mergeCookieString(this.settings.cookie, [
          ...cookies,
          ...cookieHeadersFromLoginUrl(data.url)
        ]);
        if (!getCookieValue(mergedCookie, 'SESSDATA')) {
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

  async saveSettings(nextSettings, options = {}) {
    const oldPollInterval = this.settings.pollIntervalSec;
    const oldOutputDir = this.settings.outputDir;
    const oldAccessUsername = this.settings.accessUsername;
    const oldAccessPasswordHash = this.settings.accessPasswordHash;
    const oldAutoUpdateEnabled = this.settings.autoUpdateEnabled;
    const settingsUpdate = { ...(nextSettings || {}) };
    if (options.preserveCookie) {
      delete settingsUpdate.cookie;
    }
    const accessPassword = String(settingsUpdate.accessPassword || '');
    const webhookBearerToken = String(settingsUpdate.webhookBearerToken || '').trim();
    const clearWebhookBearerToken = Boolean(settingsUpdate.webhookBearerTokenClear);
    delete settingsUpdate.accessPassword;
    delete settingsUpdate.accessAuthConfigured;
    delete settingsUpdate.accessPasswordHash;
    delete settingsUpdate.webhookBearerToken;
    delete settingsUpdate.webhookBearerTokenConfigured;
    delete settingsUpdate.webhookBearerTokenClear;
    if (accessPassword) {
      settingsUpdate.accessPasswordHash = await hashAccessPassword(accessPassword);
    }
    if (webhookBearerToken.length > 4096) {
      throw new Error('Webhook Bearer Token 不能超过 4096 个字符。');
    }
    if (/\r|\n/.test(webhookBearerToken)) {
      throw new Error('Webhook Bearer Token 不能包含换行。');
    }
    if (clearWebhookBearerToken) {
      settingsUpdate.webhookBearerToken = '';
    } else if (webhookBearerToken) {
      settingsUpdate.webhookBearerToken = webhookBearerToken;
    }
    const normalizedSettings = this.normalizeSettings({
      ...this.settings,
      ...settingsUpdate
    });
    normalizedSettings.webhookUrl = normalizeWebhookUrl(normalizedSettings.webhookUrl, {
      required: normalizedSettings.webhookEnabled
    });
    if (isPublicServerHost(normalizedSettings.serverHost) && !this.accessAuth.isConfigured(normalizedSettings)) {
      throw new Error('监听 0.0.0.0/:: 前必须先在持久化配置中设置至少 8 位远程访问密码。');
    }
    const outputDirChanged = oldOutputDir !== normalizedSettings.outputDir;
    const outputReady = await this.ensureRecordingOutputRootReady(normalizedSettings.outputDir, {
      label: '录像保存目录',
      allowUnavailable: !outputDirChanged,
      permissionsRequired: outputDirChanged
    });
    this.settings = normalizedSettings;
    if (
      oldAccessUsername !== this.settings.accessUsername ||
      oldAccessPasswordHash !== this.settings.accessPasswordHash
    ) {
      this.accessAuth.clearSessions();
      this.log('info', '远程访问凭据已更新，已有远程会话已退出。');
    }
    if (!outputReady) {
      this.log(
        'warn',
        `录像保存目录当前不可用，其他设置仍已保存；恢复挂载或改用新目录后才能开始新录制：${this.settings.outputDir}`
      );
    }
    if (outputDirChanged && !this.hasActiveJobs()) {
      setImmediate(() => {
        this.refreshRecordingLibrary({ silent: true }).catch((error) => {
          this.log('warn', `后台刷新录像库失败：${error.message}`);
          this.emitState();
        });
      });
    } else if (outputDirChanged) {
      this.log('info', '当前有录制或处理任务，已保留现有录像库；新保存目录会从下一次新录制开始使用。');
    }
    await this.saveStore();
    if (oldPollInterval !== this.settings.pollIntervalSec) {
      for (const room of this.rooms.values()) {
        if (room.monitoring) {
          this.startMonitorTimer(room.id);
        }
      }
    }
    await this.refreshOutputDiskSpace().catch(() => {});
    if (oldAutoUpdateEnabled !== this.settings.autoUpdateEnabled) {
      this.scheduleAutomaticUpdateCheck(this.settings.autoUpdateEnabled ? 5000 : 0);
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
    this.stopLivePushMonitor(room.id);
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
          this.notify('开播提醒', `${roomLabel(room)} 已开播`, 'live.started', {
            roomId: room.id,
            roomTitle: room.title || '',
            anchor: room.anchor || ''
          });
        }
        if (previousLiveStatus === 1 && room.liveStatus !== 1 && this.settings.notifyLiveEnded) {
          this.notify('下播提醒', `${roomLabel(room)} 已下播`, 'live.ended', {
            roomId: room.id,
            roomTitle: room.title || '',
            anchor: room.anchor || ''
          });
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
      this.startLivePushMonitor(room.id).catch((error) => {
        this.log('warn', `${roomLabel(room)} 开播推送监听启动失败：${error.message}`);
      });
      this.log('info', `${roomLabel(room)} 已开始监听。`);
      this.tickRoom(room.id);
    } else {
      this.stopMonitorTimer(room.id);
      this.stopLivePushMonitor(room.id);
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
    if (!room || !room.monitoring || this.roomTickLocks.has(roomId)) {
      return;
    }
    this.roomTickLocks.add(roomId);
    try {
      const status = await this.fetchRoomLiveStatus(room.id);
      room.realRoomId = status.realRoomId || room.realRoomId;
      await this.applyDetectedLiveStatus(room, status.liveStatus, '轮询');
      if (room.liveStatus === 1 && room.autoRecord && !this.isRoomRecording(room)) {
        await this.startRecording(room.id, true);
      }
    } catch (error) {
      this.log('error', `${roomLabel(room)} 监听异常：${error.message}`);
    } finally {
      this.roomTickLocks.delete(roomId);
    }
  }

  async fetchRoomLiveStatus(roomId) {
    const roomInit = await this.fetchBiliJson(
      `https://api.live.bilibili.com/room/v1/Room/room_init?id=${encodeURIComponent(roomId)}`
    );
    if (roomInit.code !== 0) {
      throw createBiliError('开播状态检查', roomInit);
    }
    return {
      realRoomId: Number(roomInit.data?.room_id || 0),
      liveStatus: Number(roomInit.data?.live_status || 0)
    };
  }

  async applyDetectedLiveStatus(room, liveStatus, source) {
    const previousLiveStatus = room.liveStatus;
    room.liveStatus = Number(liveStatus || 0);
    room.lastCheckedAt = Date.now();
    room.lastError = undefined;
    if (previousLiveStatus !== undefined && previousLiveStatus !== room.liveStatus) {
      this.log(
        room.liveStatus === 1 ? 'success' : 'info',
        `${roomLabel(room)}：${room.liveStatus === 1 ? '开播' : '下播'}（${source}）`
      );
      if (room.liveStatus === 1 && this.settings.notifyLiveStarted) {
        this.notify('开播提醒', `${roomLabel(room)} 已开播`, 'live.started', {
          roomId: room.id,
          roomTitle: room.title || '',
          anchor: room.anchor || ''
        });
      }
      if (previousLiveStatus === 1 && room.liveStatus !== 1 && this.settings.notifyLiveEnded) {
        this.notify('下播提醒', `${roomLabel(room)} 已下播`, 'live.ended', {
          roomId: room.id,
          roomTitle: room.title || '',
          anchor: room.anchor || ''
        });
      }
      this.saveStore().catch((error) => {
        this.log('warn', `${roomLabel(room)} 保存开播状态失败：${error.message}`);
      });
    }
    this.emitState();
  }

  async startLivePushMonitor(roomId) {
    const room = this.rooms.get(String(roomId));
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
    await this.connectLivePushMonitor(room, monitor);
  }

  async connectLivePushMonitor(room, monitor) {
    if (monitor.stopped || !room.monitoring || this.livePushMonitors.get(room.id) !== monitor) {
      return;
    }
    try {
      if (!room.realRoomId) {
        const status = await this.fetchRoomLiveStatus(room.id);
        room.realRoomId = status.realRoomId || room.realRoomId;
        await this.applyDetectedLiveStatus(room, status.liveStatus, '推送监听初始化');
      }
      const info = await this.fetchDanmuInfo(room.realRoomId || room.id);
      if (info.code !== 0) {
        throw createBiliError('开播推送服务器', info);
      }
      const client = new DanmakuClient({
        roomId: Number(room.realRoomId || room.id),
        uid: Number(getCookieValue(this.settings.cookie, 'DedeUserID') || 0),
        buvid: getCookieValue(this.settings.cookie, 'buvid3') || getCookieValue(this.settings.cookie, 'buvid4') || '',
        token: info.data?.token || '',
        hosts: info.data?.host_list || [],
        onAuthReply: (reply) => {
          if (Number(reply?.code || 0) === 0) {
            monitor.authenticated = true;
            monitor.retryDelayMs = 2000;
            this.log('info', `${roomLabel(room)} 开播推送监听已连接。`);
            return;
          }
          this.log('warn', `${roomLabel(room)} 开播推送认证失败：${reply?.message || reply?.code || '未知错误'}`);
          client.close('auth failed');
        },
        onCommand: (command) => {
          this.handleLivePushCommand(room, monitor, command).catch((error) => {
            this.log('warn', `${roomLabel(room)} 处理开播推送失败：${error.message}`);
          });
        },
        onError: (error) => {
          if (!monitor.stopped) {
            this.log('warn', `${roomLabel(room)} 开播推送连接错误：${error.message}`);
          }
        },
        onClose: (reason) => {
          if (monitor.client === client) {
            monitor.client = null;
          }
          monitor.authenticated = false;
          if (!monitor.stopped) {
            this.scheduleLivePushReconnect(room, monitor, reason);
          }
        }
      });
      monitor.client = client;
      client.connect();
    } catch (error) {
      this.scheduleLivePushReconnect(room, monitor, error.message);
    }
  }

  async handleLivePushCommand(room, monitor, command) {
    if (monitor.stopped || !room.monitoring) {
      return;
    }
    const commandType = String(command?.cmd || '').split(':')[0].toUpperCase();
    if (commandType === 'LIVE') {
      await this.applyDetectedLiveStatus(room, 1, '弹幕服务器推送');
      if (room.autoRecord && !this.isRoomRecording(room)) {
        await this.startRecording(room.id, true);
      }
      setImmediate(() => {
        this.refreshRoom(room.id, { silent: true }).catch(() => {});
      });
      return;
    }
    if (commandType === 'PREPARING') {
      await this.applyDetectedLiveStatus(room, 0, '弹幕服务器推送');
      return;
    }
    if (commandType === 'ROOM_CHANGE') {
      const data = command?.data || {};
      room.title = String(data.title || room.title || '');
      this.emitState();
    }
  }

  scheduleLivePushReconnect(room, monitor, reason) {
    if (monitor.stopped || monitor.retryTimer || !room.monitoring) {
      return;
    }
    const delayMs = Math.min(60000, Math.max(2000, monitor.retryDelayMs || 2000));
    monitor.retryDelayMs = Math.min(60000, delayMs * 2);
    if (monitor.authenticated || delayMs >= 10000) {
      this.log('warn', `${roomLabel(room)} 开播推送已断开，${Math.round(delayMs / 1000)} 秒后重连：${reason || '连接关闭'}`);
    }
    monitor.retryTimer = setTimeout(() => {
      monitor.retryTimer = null;
      this.connectLivePushMonitor(room, monitor).catch(() => {});
    }, delayMs);
    monitor.retryTimer.unref?.();
  }

  stopLivePushMonitor(roomId) {
    const monitor = this.livePushMonitors.get(String(roomId));
    if (!monitor) {
      return;
    }
    monitor.stopped = true;
    clearTimeout(monitor.retryTimer);
    monitor.client?.close('停止监听');
    this.livePushMonitors.delete(String(roomId));
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

    if (!isBilibiliHost(target.hostname)) {
      writeJson(response, 403, { error: '图片代理只允许访问 B 站图片域名' });
      return;
    }
    const asset = await requestUrlBuffer(target.toString(), {
      headersForUrl: (nextTarget) => createImageProxyHeaders(nextTarget, this.settings.cookie),
      validateUrl: (nextTarget) => validateRemoteUrl(nextTarget, { allowHost: isBilibiliHost }),
      allowProxy: false,
      retries: 2,
      timeoutMs: 15000,
      maxRedirects: 3,
      maxBytes: MAX_PROXY_IMAGE_BYTES,
      includeResponseMetadata: true
    });
    const contentType = String(asset.headers['content-type'] || 'image/jpeg');
    if (!contentType.toLowerCase().startsWith('image/')) {
      writeJson(response, 502, { error: '远端返回的不是图片' });
      return;
    }
    if (asset.body.length > MAX_PROXY_IMAGE_BYTES) {
      writeJson(response, 502, { error: '远端图片过大' });
      return;
    }
    response.writeHead(200, {
      'Content-Type': contentType,
      'Content-Length': String(asset.body.length),
      'Cache-Control': 'no-store'
    });
    response.end(asset.body);
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

  async startExportPreview(options = {}) {
    const sourcePath = path.resolve(String(options.cleanPath || options.path || '').trim());
    if (!sourcePath) {
      throw new Error('请选择要预览的视频文件。');
    }
    if (!this.isKnownMediaPath(sourcePath)) {
      throw new Error('视频路径不在录像库或输出目录内。');
    }
    const stat = await fsp.stat(sourcePath).catch(() => null);
    if (!stat?.isFile()) {
      throw new Error('视频文件不存在。');
    }
    const id = this.createFileCacheId(sourcePath, stat, PREVIEW_CACHE_VERSION);
    const previewDir = path.join(this.previewCacheDir, id);
    const playlistPath = path.join(previewDir, 'index.m3u8');
    const previewUrl = `/api/export/preview/${id}/index.m3u8`;
    if (await isExistingFile(playlistPath)) {
      this.exportPreview = {
        id,
        sourcePath,
        previewUrl,
        status: 'ready',
        ready: true,
        cached: true,
        updatedAt: Date.now()
      };
      this.log('info', `已复用兼容预览缓存：${path.basename(sourcePath)}`);
      this.emitState();
      return { ok: true, id, previewUrl, ready: true, cached: true };
    }
    if (this.exportPreviewProgress?.status === 'running' && this.exportPreview?.id === id) {
      return { ok: true, id, previewUrl, ready: false, cached: false, progress: { ...this.exportPreviewProgress } };
    }
    await this.cancelExportPreview({ silent: true });
    const workingPreviewDir = `${previewDir}.work-${crypto.randomBytes(6).toString('hex')}`;
    const workingPlaylistPath = path.join(workingPreviewDir, 'index.m3u8');
    await fsp.mkdir(workingPreviewDir, { recursive: true });

    const mediaInfo = await probeMediaFileInfo(this.ffmpegPath, sourcePath);
    const durationSec = await this.resolveRecordingDuration({ cleanPath: sourcePath }, mediaInfo).catch(() => mediaInfo.durationSec || 0);
    const progress = createFfmpegJobProgress({
      kind: 'preview',
      label: `生成兼容预览：${path.basename(sourcePath)}`,
      outputPath: sourcePath,
      durationSec
    });
    clearTimeout(this.exportPreviewClearTimer);
    this.exportPreviewProgress = progress;
    this.exportPreview = {
      id,
      sourcePath,
      previewUrl,
      status: 'running',
      ready: false,
      cached: false,
      updatedAt: Date.now()
    };
    this.emitState();
    this.log('info', `正在生成 H.264 兼容预览：${path.basename(sourcePath)}`);
    const previewLease = await this.mediaJobs.acquire({
      id: progress.id,
      type: 'preview',
      resource: 'cpu',
      cancel: () => this.cancelExportPreview({ silent: true }).catch(() => {})
    });

    runFfmpegJob(
      this.ffmpegPath,
      createPreviewHlsArgs({
        inputPath: sourcePath,
        playlistPath: workingPlaylistPath,
        segmentPattern: path.join(workingPreviewDir, 'segment_%05d.ts')
      }),
      (line) => {
        if (this.exportPreviewProgress?.id === progress.id && updateFfmpegJobProgress(this.exportPreviewProgress, line)) {
          this.emitState();
        }
        if (/error|failed|invalid/i.test(line)) {
          this.log('warn', `兼容预览：${compactLogLine(line)}`);
        }
      },
      {
        onChild: (child) => {
          this.exportPreviewProcess = child;
        }
      }
    )
      .then(async () => {
        if (this.exportPreviewProgress?.id !== progress.id) {
          return;
        }
        const generatedEntries = await fsp.readdir(workingPreviewDir);
        if (!generatedEntries.includes('index.m3u8') || !generatedEntries.some((name) => name.endsWith('.ts'))) {
          throw new Error('兼容预览没有生成可播放的 HLS 分片。');
        }
        await fsp.rm(previewDir, { recursive: true, force: true }).catch(() => {});
        await fsp.rename(workingPreviewDir, previewDir);
        if (this.exportPreviewProgress?.id === progress.id) {
          finishFfmpegJobProgress(this.exportPreviewProgress, 'completed', '兼容预览已生成');
        }
        this.exportPreview = {
          id,
          sourcePath,
          previewUrl,
          status: 'ready',
          ready: true,
          cached: false,
          updatedAt: Date.now()
        };
        this.log('success', `兼容预览已生成：${path.basename(sourcePath)}`);
      })
      .catch((error) => {
        if (this.exportPreviewProgress?.id !== progress.id) {
          return;
        }
        if (this.exportPreviewProgress?.id === progress.id) {
          finishFfmpegJobProgress(this.exportPreviewProgress, 'error', `兼容预览失败：${error.message}`);
        }
        this.exportPreview = {
          id,
          sourcePath,
          previewUrl,
          status: 'error',
          ready: false,
          cached: false,
          message: error.message,
          updatedAt: Date.now()
        };
        this.log('error', `生成兼容预览失败：${error.message}`);
      })
      .finally(() => {
        previewLease.release();
        fsp.rm(workingPreviewDir, { recursive: true, force: true }).catch(() => {});
        if (this.exportPreviewProgress?.id === progress.id) {
          this.exportPreviewProcess = null;
          this.exportPreviewClearTimer = setTimeout(() => {
            if (this.exportPreviewProgress?.id === progress.id && this.exportPreviewProgress.status !== 'running') {
              this.exportPreviewProgress = null;
              this.emitState();
            }
          }, 5000);
          this.exportPreviewClearTimer.unref?.();
        }
        this.emitState();
      });

    return { ok: true, id, previewUrl, ready: false, cached: false, progress: { ...progress } };
  }

  async cancelExportPreview(options = {}) {
    if (this.exportPreviewProcess) {
      requestFfmpegStop(this.exportPreviewProcess, { graceful: false, timeoutMs: 1500 });
      this.exportPreviewProcess = null;
    }
    if (this.exportPreviewProgress?.status === 'running') {
      finishFfmpegJobProgress(this.exportPreviewProgress, 'cancelled', '兼容预览已取消');
    }
    if (!options.silent && this.exportPreview?.status === 'running') {
      this.log('info', '已取消当前兼容预览生成。');
    }
    this.emitState();
    return this.getState();
  }

  async serveExportPreview(parsed, request, response) {
    const match = /^\/api\/export\/preview\/([a-f0-9]+)\/([^/?#]+)$/i.exec(parsed.pathname);
    if (!match) {
      writeJson(response, 404, { error: '兼容预览地址无效' });
      return;
    }
    const [, id, rawName] = match;
    const fileName = path.basename(decodeURIComponent(rawName));
    const ext = path.extname(fileName).toLowerCase();
    if (!EXPORT_PREVIEW_EXTENSIONS.has(ext)) {
      writeJson(response, 403, { error: '兼容预览文件类型不允许' });
      return;
    }
    const previewDir = path.join(this.previewCacheDir, id);
    const filePath = path.resolve(previewDir, fileName);
    const previewRoot = path.resolve(previewDir);
    if (filePath !== previewRoot && !filePath.startsWith(`${previewRoot}${path.sep}`)) {
      writeJson(response, 403, { error: '兼容预览路径无效' });
      return;
    }
    const stat = await fsp.stat(filePath).catch(() => null);
    if (!stat?.isFile()) {
      writeJson(response, 404, { error: '兼容预览尚未生成完成' });
      return;
    }
    response.writeHead(200, {
      'Content-Type': ext === '.m3u8' ? 'application/vnd.apple.mpegurl; charset=utf-8' : 'video/mp2t',
      'Content-Length': String(stat.size),
      'Cache-Control': 'no-store'
    });
    fs.createReadStream(filePath).pipe(response);
  }

  createFileCacheId(filePath, stat, version) {
    return crypto
      .createHash('sha1')
      .update(`${version}|${path.resolve(filePath).toLowerCase()}|${stat.size}|${Math.round(Number(stat.mtimeMs || 0))}`)
      .digest('hex')
      .slice(0, 32);
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
        headersForUrl: (nextTarget) => createPreviewProxyHeaders(nextTarget, this.settings.cookie, request.headers.range),
        validateUrl: (nextTarget) => validateRemoteUrl(nextTarget),
        allowProxy: false,
        retries: 2,
        timeoutMs: 20000,
        maxRedirects: 4,
        maxBytes: 256 * 1024 * 1024
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
    if (!this.isRecordingMediaFileName(normalized)) {
      return false;
    }
    if (this.isPathInRecordingLibrary(normalized)) {
      return true;
    }
    const knownRecordingPath = this.recordings.some((recording) =>
      [recording.cleanPath, recording.capturePath, recording.burnedPath].some(
        (candidate) => candidate && path.resolve(candidate).toLowerCase() === normalized
      )
    );
    if (knownRecordingPath) {
      return true;
    }
    for (const room of this.rooms.values()) {
      const recording = room.currentRecording;
      if (
        recording &&
        [recording.cleanPath, recording.capturePath, recording.burnedPath].some(
          (candidate) => candidate && path.resolve(candidate).toLowerCase() === normalized
        )
      ) {
        return true;
      }
    }
    return false;
  }

  isRecordingMediaFileName(filePath) {
    return RECORDING_MEDIA_FILE_PATTERN.test(path.basename(String(filePath || '')));
  }

  isPathInRecordingLibrary(filePath) {
    const targetPath = path.resolve(String(filePath || ''));
    const outputRoot = path.resolve(this.settings.outputDir);
    return targetPath === outputRoot || isPathInsideDirectory(targetPath, outputRoot);
  }

  assertExportSourcePath(filePath) {
    if (!this.isPathInRecordingLibrary(filePath) || !this.isRecordingMediaFileName(filePath)) {
      throw new Error('导出源文件必须位于录像库目录且符合录播文件名格式。');
    }
  }

  assertExportOutputPath(outputDir, outputPath) {
    if (!this.isPathInRecordingLibrary(outputDir) || !this.isPathInRecordingLibrary(outputPath)) {
      throw new Error('导出目录和输出文件必须位于录像库目录。');
    }
    if (!this.isRecordingMediaFileName(outputPath)) {
      throw new Error('导出文件名必须符合录播文件命名格式。');
    }
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
    const { response, text } = await fetchWithTimeout(
      url,
      {
        headers: {
          Accept: 'application/json, text/plain, */*',
          Referer: 'https://live.bilibili.com/',
          'User-Agent': USER_AGENT,
          Cookie: sanitizeHeaderValue(this.settings.cookie)
        }
      },
      15000,
      'B站接口请求',
      async (response) => ({ response, text: await response.text() })
    );
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
    const attemptedQns = [];
    const candidates = [];
    const seenUrls = new Set();
    let lastPlayError = null;
    for (const requestedQn of qnProbes) {
      attemptedQns.push(requestedQn);
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
      // A successful play-info response already includes the selected quality and accept_qn list.
      // Avoid repeating the same heavy request for every lower quality during the critical start path.
      if (candidates.length > 0) {
        break;
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
      }，请求 ${attemptedQns.join('/')}, 协议 ${room.stream.protocol}/${room.stream.format}，接口可选 ${
        availableQn.join('/') || '未知'
      }`
    );
    return room.stream;
  }

  async startRecording(roomId, autoStart = false, options = {}) {
    if (this.draining) {
      throw new Error('服务正在退出，不能开始新的录制。');
    }
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
      const timestamp = formatTimestamp(new Date());
      const outputRoot = String(this.settings.outputDir || '').trim() || this.settings.outputDir;
      await this.ensureRecordingOutputRootReady(outputRoot, { label: '录像保存根目录' });
      const roomFolder =
        sanitizeFilename(`${room.realRoomId || room.id}-${room.anchor || 'anchor'}`).slice(0, 48) || `room-${room.id}`;
      const liveFolder = sanitizeFilename(`${timestamp}-${room.title || 'live'}`).slice(0, 72) || timestamp;
      const outputDir = String(options.outputDir || path.join(outputRoot, roomFolder, liveFolder)).trim() || outputRoot;
      await this.ensureDirectoryReady(outputDir, { label: '本场录像保存目录' });
      await assertDiskSpace(outputDir);

      const baseName = sanitizeFilename(
        `${room.realRoomId || room.id}_${room.anchor || 'anchor'}_${timestamp}`
      ).slice(0, process.platform === 'win32' ? Math.max(24, 220 - path.resolve(outputDir).length) : 120);
      const container = normalizeContainer(options.outputContainer || this.settings.outputContainer);
      const cleanPath = path.join(outputDir, `${baseName}.clean.${container}`);
      const capturePath = container === 'mp4' ? path.join(outputDir, `${baseName}.recording.mkv`) : cleanPath;
      const danmakuPath = path.join(outputDir, `${baseName}.danmaku.jsonl`);
      const cssPath = path.join(outputDir, `${baseName}.danmaku.css`);
      const assPath = path.join(outputDir, `${baseName}.danmaku.ass`);
      const burnedPath = path.join(outputDir, `${baseName}.danmaku.${container}`);
      const mergeGroup = String(options.mergeGroup || baseName);
      const mergeSequence = Number(options.mergeSequence || 0);
      const mergeOutputPath =
        options.mergeOutputPath || path.join(outputDir, `${sanitizeFilename(mergeGroup)}.merged.${container}`);

      const segmentMinutes = Number(options.segmentMinutes ?? this.settings.segmentMinutes ?? 0);
      const optionSegmentDurationSec = Number(options.segmentDurationSec);
      const segmentDurationSec =
        Number.isFinite(optionSegmentDurationSec) && optionSegmentDurationSec > 0
          ? optionSegmentDurationSec
          : this.getSegmentDurationSec(segmentMinutes);
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

      let session = null;
      const eventStream = new BufferedJsonlWriter(danmakuPath, {
        onError: (error) => {
          if (!session) return;
          session.danmakuWriteFailed = true;
          this.updateDanmakuStatus(room, session, 'write-error', `弹幕写盘失败，视频录制仍会继续：${error.message}`, 'error');
        },
        onDrop: () => {}
      });
      session = {
        roomId: room.id,
        ffmpeg,
        stream,
        eventStream,
        danmakuClient: null,
        startedAt: Date.now(),
        outputDir,
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
        danmakuReconnectAttempt: 0,
        danmakuReconnectTimer: null,
        ignoredCommandCount: 0,
        lastIgnoredEmitAt: 0,
        ffmpegProbeBuffer: '',
        ffmpegLogBuffer: '',
        videoInfo: null,
        rotateTimer: null,
        mediaWatchTimer: null,
        qualityWatchTimer: null,
        lastMediaSize: 0,
        lastMediaGrowthAt: Date.now(),
        mediaStalled: false,
        rotating: false,
        qualitySwitching: false,
        nextStream: null,
        segmentMinutes,
        segmentDurationSec,
        finished: false,
        stopping: false,
        streamReconnectAttempt: Number(options.streamReconnectAttempt || 0)
      };
      session.completionPromise = new Promise((resolve) => {
        session.resolveCompletion = resolve;
      });

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
      session.releaseMediaJob = this.mediaJobs.registerExternal({
        id: `recording:${room.id}:${session.startedAt}`,
        type: 'recording',
        resource: 'recording',
        cancel: () => this.stopRecording(room.id).catch(() => {})
      });
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
        this.notify('开始录制', `${roomLabel(room)} 正在写入 ${path.basename(cleanPath)}`, 'recording.started', {
          roomId: room.id,
          roomTitle: room.title || '',
          anchor: room.anchor || '',
          fileName: path.basename(cleanPath)
        });
      }

      ffmpeg.stderr.on('data', (chunk) => {
        const text = chunk.toString('utf8');
        session.ffmpegLogBuffer = `${session.ffmpegLogBuffer}${text}`.slice(-12000);
        if (!session.videoInfo) {
          session.ffmpegProbeBuffer = `${session.ffmpegProbeBuffer}${text}`.slice(-6000);
          const videoInfo = parseFfmpegVideoInfo(session.ffmpegProbeBuffer);
          if (videoInfo) {
            session.videoInfo = videoInfo;
            clearTimeout(session.streamStableTimer);
            session.streamStableTimer = setTimeout(() => {
              session.streamReconnectAttempt = 0;
            }, 60000);
            session.streamStableTimer.unref?.();
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
        session.finishPromise = this.finishRecording(room.id, session, code, signal);
        try {
          await session.finishPromise;
        } catch (error) {
          this.log('error', `${roomLabel(room)} 录像收尾失败：${error.message}`);
        } finally {
          session.resolveCompletion?.();
        }
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
        this.scheduleDanmakuReconnect(room, session, error.message);
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
    clearTimeout(session.danmakuReconnectTimer);
    session.danmakuReconnectTimer = null;
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
          session.danmakuReconnectAttempt = 0;
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
        if (!session.finished && !session.stopping && session.danmakuClient === client) {
          this.updateDanmakuStatus(room, session, 'disconnected', `弹幕通道已断开：${reason}`, 'warn');
          this.scheduleDanmakuReconnect(room, session, reason);
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
        const written = session.eventStream.write(`${JSON.stringify(event)}\n`);
        if (!written) {
          session.danmakuWriteDropped = Number(session.danmakuWriteDropped || 0) + 1;
          const now = Date.now();
          if (now - Number(session.lastDanmakuWriteWarningAt || 0) > 5000) {
            session.lastDanmakuWriteWarningAt = now;
            this.updateDanmakuStatus(
              room,
              session,
              session.danmakuWriteFailed ? 'write-error' : 'backpressure',
              `弹幕写盘缓冲已达上限，已丢弃 ${session.danmakuWriteDropped} 条；视频录制不受影响`,
              'warn'
            );
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

  scheduleDanmakuReconnect(room, session, reason = '') {
    if (
      this.draining ||
      session.finished ||
      session.stopping ||
      this.recordingSessions.get(room.id) !== session ||
      session.danmakuReconnectTimer
    ) {
      return;
    }
    const attempt = Math.min(12, Number(session.danmakuReconnectAttempt || 0) + 1);
    session.danmakuReconnectAttempt = attempt;
    const baseDelay = Math.min(30000, 1000 * 2 ** Math.min(attempt - 1, 5));
    const delayMs = baseDelay + Math.floor(Math.random() * Math.min(1000, baseDelay * 0.2));
    this.updateDanmakuStatus(
      room,
      session,
      'reconnecting',
      `弹幕通道将在 ${(delayMs / 1000).toFixed(1)} 秒后进行第 ${attempt} 次重连${reason ? `：${reason}` : ''}`,
      'warn'
    );
    session.danmakuReconnectTimer = setTimeout(() => {
      session.danmakuReconnectTimer = null;
      this.startDanmakuCapture(room, session).catch((error) => {
        this.updateDanmakuStatus(room, session, 'error', `弹幕重连失败：${error.message}`, 'warn');
        this.scheduleDanmakuReconnect(room, session, error.message);
      });
    }, delayMs);
    session.danmakuReconnectTimer.unref?.();
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
    const check = async () => {
      if (session.finished || session.stopping || this.recordingSessions.get(room.id) !== session) {
        return;
      }
      const fileSize = await getFileSize(session.capturePath || session.cleanPath);
      const now = Date.now();
      if (now - Number(session.lastDiskSafetyCheckAt || 0) >= 30000) {
        session.lastDiskSafetyCheckAt = now;
        try {
          await assertDiskSpace(session.capturePath || session.cleanPath);
        } catch (error) {
          session.stopping = true;
          this.log('error', `${roomLabel(room)} ${error.message} 正在优雅停止当前录像。`);
          requestFfmpegStop(session.ffmpeg, { graceful: true, timeoutMs: 15000 });
          return;
        }
      }
      if (fileSize > Number(session.lastMediaSize || 0) + MIN_MEDIA_GROWTH_BYTES) {
        session.lastMediaSize = fileSize;
        session.lastMediaGrowthAt = now;
      }

      if (!session.videoInfo && now - Number(session.startedAt || now) >= NO_MEDIA_TIMEOUT_MS && fileSize >= MIN_PLAYABLE_BYTES) {
        this.log(
          'warn',
          `${roomLabel(room)} 录制已写入 ${formatBytes(fileSize)}，但还没解析到视频信息；继续观察。`
        );
      }

      if (!session.videoInfo && now - Number(session.startedAt || now) >= NO_MEDIA_TIMEOUT_MS && fileSize < MIN_PLAYABLE_BYTES) {
        session.noMediaDetected = true;
        this.log(
          'error',
          `${roomLabel(room)} 录制 ${Math.round(NO_MEDIA_TIMEOUT_MS / 1000)} 秒仍未写入有效视频数据，正在重连直播流。`
        );
        requestFfmpegStop(session.ffmpeg, { graceful: false, timeoutMs: 1500 });
        return;
      }

      if (
        fileSize >= MIN_PLAYABLE_BYTES &&
        now - Number(session.lastMediaGrowthAt || session.startedAt || now) >= MEDIA_STALL_TIMEOUT_MS
      ) {
        session.mediaStalled = true;
        this.log(
          'error',
          `${roomLabel(room)} 临时录像 ${Math.round(MEDIA_STALL_TIMEOUT_MS / 1000)} 秒没有继续增长，正在重连直播流。`
        );
        requestFfmpegStop(session.ffmpeg, { graceful: false, timeoutMs: 1500 });
        return;
      }

      session.mediaWatchTimer = setTimeout(check, MEDIA_STALL_CHECK_MS);
      session.mediaWatchTimer.unref?.();
    };
    session.mediaWatchTimer = setTimeout(check, Math.min(NO_MEDIA_TIMEOUT_MS, MEDIA_STALL_CHECK_MS));
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
    clearTimeout(session.danmakuReconnectTimer);
    clearTimeout(session.streamStableTimer);
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
    clearTimeout(session.danmakuReconnectTimer);
    clearTimeout(session.streamStableTimer);
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
      session.releaseMediaJob?.();
      this.recordingSessions.delete(roomId);
      await this.startNextSegmentNow(room, session);
    }
    const capturePath = session.capturePath || session.cleanPath;
    const capturePathExists = capturePath !== session.cleanPath && (await isExistingFile(capturePath));
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
    const mediaInfo = finalized
      ? await probeMediaFileInfo(this.ffmpegPath, session.cleanPath).catch((error) => {
          this.log('warn', `${roomLabel(room)} 最终文件媒体信息探测失败：${error.message}`);
          return { durationSec: 0, videoInfo: null };
        })
      : { durationSec: 0, videoInfo: null };
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
      await this.writeRecordingMetadata(finishedRecording).catch((error) => {
        this.log('warn', `${roomLabel(room)} 写入轻量录像元数据失败，不影响录像文件：${error.message}`);
      });
      await this.saveStore();
    } else {
      this.log(
        'error',
        `${roomLabel(room)} 当前录像文件过小或没有视频流，已跳过历史列表：${path.basename(
          session.cleanPath
        )}（最终 ${formatBytes(fileSize)}，临时 ${formatBytes(fileSizeBeforeFinalize)}）。${
          capturePathExists ? `可检查临时文件：${capturePath}` : ''
        }${session.validReason ? `原因：${session.validReason}` : ''}`
      );
    }
    const unexpectedStreamEnd = wasActiveSession && !session.stopping && !shouldContinueSegment;
    const shouldReconnectLiveStream = unexpectedStreamEnd && room.monitoring && room.liveStatus === 1;
    if (shouldReconnectLiveStream) {
      this.reconnectPendingRooms.add(roomId);
    }
    if (this.recordingSessions.get(roomId) === session) {
      session.releaseMediaJob?.();
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
        this.notify('录制结束', `${roomLabel(room)} 可烧录事件 ${session.eventCount} 条`, 'recording.completed', {
          roomId: room.id,
          roomTitle: room.title || '',
          anchor: room.anchor || '',
          fileName: path.basename(session.cleanPath),
          eventCount: session.eventCount
        });
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
        this.notify('录制异常结束', `${roomLabel(room)} 退出码 ${code}`, 'recording.failed', {
          roomId: room.id,
          roomTitle: room.title || '',
          anchor: room.anchor || '',
          fileName: path.basename(session.cleanPath),
          exitCode: code
        });
      }
    }

    this.emitState();

    if (shouldContinueSegment) {
      this.scheduleQueuedUpdateCheck();
    } else if (shouldReconnectLiveStream) {
      const reconnectAttempt = Math.min(10, Number(session.streamReconnectAttempt || 0) + 1);
      const reconnectDelayMs = Math.min(30000, 1200 * 2 ** Math.min(reconnectAttempt - 1, 5)) + Math.floor(Math.random() * 500);
      this.log('warn', `${roomLabel(room)} 将在 ${(reconnectDelayMs / 1000).toFixed(1)} 秒后进行第 ${reconnectAttempt} 次视频断流续录。`);
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
          streamReconnectAttempt: reconnectAttempt,
          silentNotify: true,
          outputDir: session.outputDir,
          outputContainer: session.outputContainer,
          segmentMinutes: session.segmentMinutes,
          segmentDurationSec: session.segmentDurationSec,
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
      }, reconnectDelayMs);
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
      outputDir: session.outputDir,
      outputContainer: session.outputContainer,
      segmentMinutes: session.segmentMinutes,
      segmentDurationSec: session.segmentDurationSec,
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
    if (!(await isExistingFile(sourcePath))) {
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
    this.recordings = [item, ...this.recordings.filter((saved) => saved.cleanPath !== item.cleanPath)].slice(
      0,
      RECORDING_LIBRARY_LIMIT
    );
  }

  async refreshRecordingLibrary(options = {}) {
    if (this.recordingScanPromise) {
      await this.recordingScanPromise;
      return this.getState();
    }
    const scanPromise = this.performRecordingLibraryRefresh(options);
    this.recordingScanPromise = scanPromise;
    try {
      return await scanPromise;
    } finally {
      if (this.recordingScanPromise === scanPromise) {
        this.recordingScanPromise = null;
      }
    }
  }

  async performRecordingLibraryRefresh(options = {}) {
    const outputProbe = await this.probePathAvailability(this.settings.outputDir);
    if (outputProbe.kind !== 'directory') {
      if (!options.silent) {
        const reason = outputProbe.kind === 'timeout' ? '检测超时或盘符已断开' : '目录不存在或不可用';
        this.log('warn', `录像库未扫描：保存目录${reason}，已保留现有录像列表。${this.settings.outputDir}`);
        this.emitState();
      }
      return this.getState();
    }
    const discovered = await discoverRecordingFiles(this.settings.outputDir, {
      ffmpegPath: this.ffmpegPath,
      segmentDurationSec: this.getSegmentDurationSec(),
      limit: RECORDING_LIBRARY_LIMIT,
      concurrency: 4
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
      .slice(0, RECORDING_LIBRARY_LIMIT);
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
        this.enqueueBurnRecording(room, recording, { automatic: true }).catch((error) => {
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
    const segmentCandidates = this.recordings
      .filter((recording) => recording.mergeGroup === groupId && !recording.mergedFrom?.length)
      .filter((recording) => recording.valid !== false)
      .filter((recording) => recording.cleanPath && recording.cleanPath !== recording.mergeOutputPath);
    const segmentExists = await Promise.all(segmentCandidates.map((recording) => isExistingFile(recording.cleanPath)));
    const segments = segmentCandidates
      .filter((_recording, index) => segmentExists[index])
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
    const syncTmpPath = replaceExtension(outputPath, `.sync.tmp.${container}`);
    const concatPath = replaceExtension(outputPath, '.concat.txt');
    const danmakuPath = deriveSiblingPath(outputPath, 'danmaku', 'jsonl');
    const cssPath = deriveSiblingPath(outputPath, 'danmaku', 'css');
    const danmakuTmpPath = `${danmakuPath}.${process.pid}.tmp`;
    const cssTmpPath = `${cssPath}.${process.pid}.tmp`;
    const assPath = deriveSiblingPath(outputPath, 'danmaku', 'ass');
    const burnedPath = deriveBurnedPath(outputPath, this.settings.burnOverlayMode);
    const mergeDurationSec = segments.reduce((sum, segment) => sum + Number(segment.durationSec || 0), 0);
    const segmentMediaInfos = [];
    const segmentTimelineInfos = [];
    for (let index = 0; index < segments.length; index += 1) {
      const segment = segments[index];
      const mediaInfo = await probeMediaFileInfo(this.ffmpegPath, segment.cleanPath, { timeoutMs: 15000 });
      if (!mediaInfo.videoInfo) {
        throw new Error(`无法读取分段视频信息：${path.basename(segment.cleanPath)}`);
      }
      segmentMediaInfos.push({
        ...mediaInfo,
        durationSec:
          Number(mediaInfo.durationSec) || Number(segment.durationSec) || getSegmentDurationForMerge(segment, segments[index + 1])
      });
      const quickDurationSec = Number(mediaInfo.durationSec || segment.durationSec || 0);
      segmentTimelineInfos.push({
        containerDurationSec: quickDurationSec,
        videoDurationSec: quickDurationSec,
        audioDurationSec: mediaInfo.audioInfo ? quickDurationSec : 0,
        avDeltaSec: 0,
        containerDeltaSec: 0,
        timingSafeForCopy: true,
        auditMode: 'metadata'
      });
    }
    const targetVideoInfo = selectHighestResolutionVideoInfo(segmentMediaInfos);
    if (!targetVideoInfo) {
      throw new Error('没有找到可用于合并的目标分辨率。');
    }
    const streamSpecsChanged = shouldTranscodeConcat(segmentMediaInfos);
    // Avoid two complete FFmpeg scans for every source segment on the healthy
    // path. The merged candidate is audited once; only a detected drift causes
    // a source-by-source deep audit for diagnosis and persisted metadata.
    const requiresTranscode = streamSpecsChanged;
    assertSafeMergeTargetProfile(segmentMediaInfos, targetVideoInfo, { requiresVideoTranscode: requiresTranscode });
    const mergeEncoderPlan = this.getMergeEncoderPlan(targetVideoInfo);
    const progress = createFfmpegJobProgress({
      kind: 'merge',
      label: `合并续录分段：${path.basename(outputPath)}`,
      outputPath,
      durationSec: mergeDurationSec,
      roomId: room.id
    });
    room.mergeProgress = progress;
    await assertDiskSpace(outputPath, {
      estimatedBytes: segments.reduce((sum, segment) => sum + Number(segment.fileSize || 0), 0)
    });
    const mergeLease = await this.mediaJobs.acquire({
      id: progress.id,
      type: 'merge',
      resource: mergeEncoderPlan.preferred.includes('libx') ? 'cpu' : 'gpu',
      cancel: () => this.cancelMerge(room.id).catch(() => {})
    });
    this.mergeCancelRequests.delete(room.id);

    this.log(
      'info',
      `${roomLabel(room)} 正在合并 ${segments.length} 个续录片段：${path.basename(outputPath)}。${
        requiresTranscode
          ? `检测到分辨率、帧率或编码规格变化，将重建各段时间轴并统一为 ${targetVideoInfo.width}x${targetVideoInfo.height} 后合并`
          : '各分段规格一致，使用快速无损合并'
      }`
    );
    this.emitState();
    try {
      await fsp.rm(tmpPath, { force: true });
      await fsp.rm(syncTmpPath, { force: true });
      await fsp.rm(danmakuTmpPath, { force: true });
      await fsp.rm(cssTmpPath, { force: true });
      const transcodeArgs = (videoCodec) =>
        createConcatTranscodeArgs({
          segments: segments.map((segment, index) => ({
            filePath: segment.cleanPath,
            durationSec:
              Number(segmentTimelineInfos[index]?.videoDurationSec) || Number(segmentMediaInfos[index].durationSec),
            hasAudio: Boolean(segmentMediaInfos[index].audioInfo)
          })),
          outputPath: tmpPath,
          container,
          targetVideoInfo,
          videoCodec,
          softwareThreads: Math.max(1, Math.min(4, Math.floor((os.cpus()?.length || 4) / 2)))
        });
      const runMergeFfmpeg = async (args) => {
        if (this.mergeCancelRequests.has(room.id)) throw new Error('合并已取消');
        await runFfmpegJob(this.ffmpegPath, args, (line) => {
          if (room.mergeProgress?.id === progress.id && updateFfmpegJobProgress(room.mergeProgress, line)) {
            this.emitState();
          }
          if (/error|failed|invalid/i.test(line)) {
            this.log('warn', `${roomLabel(room)} 合并：${compactLogLine(line)}`);
          }
        }, {
          onChild: (child) => this.mergeProcesses.set(room.id, child)
        });
        this.mergeProcesses.delete(room.id);
      };
      const runSafeTranscode = async () => {
        try {
          await runMergeFfmpeg(transcodeArgs(mergeEncoderPlan.preferred));
        } catch (error) {
          this.mergeProcesses.delete(room.id);
          if (!mergeEncoderPlan.fallback || this.mergeCancelRequests.has(room.id)) throw error;
          this.log(
            'warn',
            `${roomLabel(room)} ${mergeEncoderPlan.preferred} 合并失败，将仅回退一次 ${mergeEncoderPlan.fallback} 软件编码：${error.message}`
          );
          await fsp.rm(tmpPath, { force: true });
          await runMergeFfmpeg(transcodeArgs(mergeEncoderPlan.fallback));
        }
      };
      if (requiresTranscode) {
        await runSafeTranscode();
      } else {
        await writeConcatFile(concatPath, segments.map((segment) => segment.cleanPath));
        try {
          await runMergeFfmpeg(createConcatCopyArgs({ concatPath, outputPath: tmpPath, container }));
        } catch (error) {
          this.mergeProcesses.delete(room.id);
          if (this.mergeCancelRequests.has(room.id)) throw error;
          if (targetVideoInfo.hdr) {
            throw new Error(`HDR 无损 copy 合并失败；为避免丢失 HDR metadata，不会自动转码：${error.message}`);
          }
          this.log('warn', `${roomLabel(room)} 无损 copy 合并失败，自动切换安全统一转码：${error.message}`);
          await fsp.rm(tmpPath, { force: true });
          await runSafeTranscode();
        }
      }
      if (room.mergeProgress?.id === progress.id) {
        room.mergeProgress.message = '正在合并弹幕记录';
        room.mergeProgress.percent = 99.5;
        room.mergeProgress.updatedAt = Date.now();
        this.emitState();
      }
      let mergedMediaInfo = await probeMediaFileInfo(this.ffmpegPath, tmpPath, { timeoutMs: 15000 });
      if (!mergedMediaInfo.videoInfo) {
        throw new Error('合并文件生成后没有检测到视频流。');
      }
      let mergedTimingInfo = null;
      try {
        if (room.mergeProgress?.id === progress.id) {
          room.mergeProgress.message = '正在检查合并后的音画时间轴';
          room.mergeProgress.percent = 99.7;
          room.mergeProgress.updatedAt = Date.now();
          this.emitState();
        }
        mergedTimingInfo = await probeMediaTimelineInfo(this.ffmpegPath, tmpPath, mergedMediaInfo, {
          timeoutMs: 120000
        });
        this.log(
          Math.abs(mergedTimingInfo.avDeltaSec) > 0.08 ? 'warn' : 'success',
          `${roomLabel(room)} 合并后时轴检查：视频 ${mergedTimingInfo.videoDurationSec.toFixed(
            3
          )}s，音频 ${mergedTimingInfo.audioDurationSec.toFixed(3)}s，音频${mergedTimingInfo.avDeltaSec >= 0 ? '长' : '短'} ${Math.abs(
            mergedTimingInfo.avDeltaSec
          ).toFixed(3)}s。`
        );
        if (!mergedTimingInfo.timingSafeForCopy && mergedMediaInfo.audioInfo) {
          const driftMs = Math.round(Math.abs(mergedTimingInfo.avDeltaSec) * 1000);
          this.log('warn', `${roomLabel(room)} 合并候选音画相差 ${driftMs}ms，正在自动重采样、补齐或裁剪音频进行对齐。`);
          for (let index = 0; index < segments.length; index += 1) {
            try {
              const sourceTiming = await probeMediaTimelineInfo(
                this.ffmpegPath,
                segments[index].cleanPath,
                segmentMediaInfos[index],
                { timeoutMs: 120000 }
              );
              sourceTiming.auditMode = 'deep';
              segmentTimelineInfos[index] = sourceTiming;
              segments[index].timingInfo = sourceTiming;
              this.log(
                Math.abs(sourceTiming.avDeltaSec) > 0.08 ? 'warn' : 'info',
                `${roomLabel(room)} 漂移来源检查 #${index + 1}：音频${sourceTiming.avDeltaSec >= 0 ? '长' : '短'} ${Math.abs(
                  sourceTiming.avDeltaSec
                ).toFixed(3)}s。`
              );
            } catch (error) {
              segmentTimelineInfos[index] = { ...segmentTimelineInfos[index], auditMode: 'failed', error: error.message };
              this.log('warn', `${roomLabel(room)} 漂移来源检查 #${index + 1} 失败：${error.message}`);
            }
          }
          if (room.mergeProgress?.id === progress.id) {
            room.mergeProgress.message = `正在修复 ${driftMs}ms 音画偏差`;
            room.mergeProgress.percent = 99.8;
            room.mergeProgress.updatedAt = Date.now();
            this.emitState();
          }
          await runMergeFfmpeg(
            createAudioAlignArgs({
              inputPath: tmpPath,
              outputPath: syncTmpPath,
              container,
              videoDurationSec: mergedTimingInfo.videoDurationSec
            })
          );
          const repairedMediaInfo = await probeMediaFileInfo(this.ffmpegPath, syncTmpPath, { timeoutMs: 15000 });
          const repairedTimingInfo = await probeMediaTimelineInfo(this.ffmpegPath, syncTmpPath, repairedMediaInfo, {
            timeoutMs: 120000
          });
          if (!repairedMediaInfo.videoInfo || !repairedTimingInfo.timingSafeForCopy) {
            throw new Error(
              `自动音画对齐后仍相差 ${Math.round(Math.abs(repairedTimingInfo.avDeltaSec || 0) * 1000)}ms；所有源分段已保留`
            );
          }
          await atomicReplaceFile(syncTmpPath, tmpPath);
          mergedMediaInfo = repairedMediaInfo;
          mergedTimingInfo = repairedTimingInfo;
          this.log('success', `${roomLabel(room)} 音画偏差已修复到 ${Math.round(Math.abs(repairedTimingInfo.avDeltaSec) * 1000)}ms。`);
        }
      } catch (error) {
        this.log('warn', `${roomLabel(room)} 合并后时轴检查失败：${error.message}`);
        throw error;
      }
      await mergeDanmakuFiles(segments, danmakuTmpPath);
      await copyFirstExistingFile(
        segments.map((segment) => segment.cssPath).filter(Boolean),
        cssTmpPath,
        createDefaultDanmakuCss()
      );
      await Promise.all([fsp.stat(danmakuTmpPath), fsp.stat(cssTmpPath)]);
      await atomicReplaceFile(tmpPath, outputPath);
      await atomicReplaceFile(danmakuTmpPath, danmakuPath);
      await atomicReplaceFile(cssTmpPath, cssPath);
      await fsp.rm(concatPath, { force: true });

      const cleanupId = crypto.randomUUID();
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
        cleanupId,
        durationSec: Number(mergedMediaInfo.durationSec) || mergeDurationSec,
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
        videoInfo: mergedMediaInfo.videoInfo,
        timingInfo: mergedTimingInfo
          ? {
              ...mergedTimingInfo,
              sourceSegments: segmentTimelineInfos.map((timingInfo, index) => ({
                index: index + 1,
                videoDurationSec: Number(timingInfo.videoDurationSec || 0),
                audioDurationSec: Number(timingInfo.audioDurationSec || 0),
                avDeltaSec: Number(timingInfo.avDeltaSec || 0),
                timingSafeForCopy: Boolean(timingInfo.timingSafeForCopy),
                error: timingInfo.error || ''
              }))
            }
          : null
      });
      const outputPathKey = path.resolve(outputPath).toLowerCase();
      const segmentPathKeys = new Set(segments.map((segment) => path.resolve(segment.cleanPath).toLowerCase()));
      this.recordings = [
        mergedRecording,
        ...this.recordings.filter((recording) => {
          const recordingKey = path.resolve(recording.cleanPath).toLowerCase();
          return recordingKey !== outputPathKey && !segmentPathKeys.has(recordingKey);
        })
      ].slice(0, RECORDING_LIBRARY_LIMIT);
      await this.writeRecordingMetadata(mergedRecording).catch((error) => {
        this.log('warn', `${roomLabel(room)} 写入合并录像元数据失败：${error.message}`);
      });
      if (!this.isRoomRecording(room)) {
        room.currentRecording = mergedRecording;
      }
      this.pendingSegmentCleanups.set(cleanupId, {
        cleanupId,
        roomId: room.id,
        status: 'pending',
        attempts: 0,
        createdAt: new Date().toISOString(),
        segments: segments.map((segment) => cloneRecordingState(segment)),
        mergedRecording: cloneRecordingState(mergedRecording)
      });
      await this.saveStore();
      await this.cleanupMergedSegmentFiles(room, segments, mergedRecording, { cleanupId });
      if (room.mergeProgress?.id === progress.id) {
        finishFfmpegJobProgress(room.mergeProgress, 'completed', '续录分段已合并');
      }
      this.log(
        'success',
        `${roomLabel(room)} 续录片段已合并：${path.basename(outputPath)}，共 ${segments.length} 段，时长 ${formatDurationSeconds(
          mergedRecording.durationSec
        )}。`
      );
      this.emitState();
      setTimeout(() => {
        if (room.mergeProgress?.id === progress.id) {
          delete room.mergeProgress;
          this.emitState();
        }
      }, 5000).unref?.();
      return mergedRecording;
    } catch (error) {
      const cancelled = this.mergeCancelRequests.has(room.id);
      if (room.mergeProgress?.id === progress.id) {
        finishFfmpegJobProgress(
          room.mergeProgress,
          cancelled ? 'cancelled' : 'error',
          cancelled ? '合并已取消，所有源分段均已保留' : `合并失败：${error.message}；所有源分段均已保留`
        );
      }
      this.log(cancelled ? 'info' : 'error', `${roomLabel(room)} ${cancelled ? '合并已取消' : `合并失败：${error.message}`}；源分段未删除。`);
      this.emitState();
      if (cancelled) return fallbackRecording;
      throw error;
    } finally {
      mergeLease.release();
      this.mergeProcesses.delete(room.id);
      this.mergeCancelRequests.delete(room.id);
      await fsp.rm(concatPath, { force: true }).catch(() => {});
      await fsp.rm(tmpPath, { force: true }).catch(() => {});
      await fsp.rm(syncTmpPath, { force: true }).catch(() => {});
      await fsp.rm(danmakuTmpPath, { force: true }).catch(() => {});
      await fsp.rm(cssTmpPath, { force: true }).catch(() => {});
    }
  }

  async writeRecordingMetadata(recording) {
    const cleanPath = String(recording?.cleanPath || '');
    if (!cleanPath) return '';
    const stat = await fsp.stat(cleanPath);
    const metadataPath = `${cleanPath}.metadata.json`;
    const temporaryPath = `${metadataPath}.${process.pid}.tmp`;
    const payload = {
      schemaVersion: 1,
      createdByVersion: APP_VERSION,
      cleanPath: path.basename(cleanPath),
      fileSize: stat.size,
      fileMtimeMs: stat.mtimeMs,
      durationSec: Number(recording.durationSec || 0),
      danmakuDurationSec: Number(recording.durationSec || 0),
      eventCount: Number(recording.eventCount || 0),
      videoInfo: recording.videoInfo || null,
      updatedAt: new Date().toISOString()
    };
    await fsp.writeFile(temporaryPath, `${JSON.stringify(payload, null, 2)}\n`, { encoding: 'utf8', mode: 0o660 });
    await atomicReplaceFile(temporaryPath, metadataPath);
    return metadataPath;
  }

  async cancelMerge(roomId) {
    const room = this.getRoom(roomId);
    const child = this.mergeProcesses.get(room.id);
    if (!child && room.mergeProgress?.status !== 'running') return this.getState();
    this.mergeCancelRequests.add(room.id);
    if (child) requestFfmpegStop(child, { graceful: false, timeoutMs: 1500 });
    if (room.mergeProgress?.status === 'running') room.mergeProgress.message = '正在取消合并，源分段会全部保留';
    this.emitState();
    return this.getState();
  }

  async setAutoRecord(roomId, enabled) {
    const room = this.getRoom(roomId);
    room.autoRecord = Boolean(enabled);
    if (room.autoRecord && !room.monitoring) {
      await this.setMonitoring(room.id, true);
    } else {
      await this.saveStore();
    }
    this.log('info', `${roomLabel(room)} 自动录制已${room.autoRecord ? '开启' : '关闭'}；监听仍只负责状态和通知。`);
    this.emitState();
    return this.getState();
  }

  async cleanupMergedSegmentFiles(room, segments, mergedRecording, options = {}) {
    const cleanupId = String(options.cleanupId || mergedRecording?.cleanupId || '');
    const cleanupRoot = path.dirname(String(mergedRecording?.cleanPath || ''));
    if (!mergedRecording?.cleanPath || !isPathInsideDirectory(mergedRecording.cleanPath, this.settings.outputDir)) {
      throw new Error('合并产物不在当前录像库内，拒绝清理任何源分段。');
    }
    if (this.isRoomBurning(room)) {
      if (cleanupId) {
        const existing = this.pendingSegmentCleanups.get(cleanupId) || {};
        this.pendingSegmentCleanups.set(cleanupId, {
          ...existing,
          cleanupId,
          roomId: room.id,
          status: 'pending',
          segments: segments.map((segment) => cloneRecordingState(segment)),
          mergedRecording: cloneRecordingState(mergedRecording)
        });
        await this.saveStore();
      }
      this.log('info', `${roomLabel(room)} 当前仍有烧录任务，小分段文件会在烧录结束后清理。`);
      return;
    }

    const cleanupPaths = new Map();
    const protectedPaths = new Set();
    const pathKey = (filePath) => {
      const value = String(filePath || '').trim();
      return value ? path.resolve(value).toLowerCase() : '';
    };
    const addCleanupPath = (filePath) => {
      const key = pathKey(filePath);
      if (key) {
        cleanupPaths.set(key, String(filePath));
      }
    };
    const addProtectedPath = (filePath) => {
      const key = pathKey(filePath);
      if (key) {
        protectedPaths.add(key);
      }
    };
    const addRecordingArtifacts = (recording, add) => {
      if (!recording?.cleanPath) {
        return;
      }
      const addKnownSiblings = (filePath) => {
        const value = String(filePath || '').trim();
        if (!value) {
          return;
        }
        const parsed = path.parse(value);
        const base = parsed.name.replace(/\.(?:clean|recording|finalizing)$/i, '');
        const siblingNames = [
          `${base}.danmaku.jsonl`,
          `${base}.danmaku.css`,
          `${base}.danmaku.ass`,
          `${base}.danmaku-only.ass`,
          `${base}.danmaku.mp4`,
          `${base}.danmaku.mkv`,
          `${base}.danmaku-only.mp4`,
          `${base}.danmaku-only.mkv`,
          `${base}.recording.mkv`,
          `${base}.finalizing.mp4`
        ];
        for (const name of siblingNames) {
          add(path.join(parsed.dir, name));
        }
      };
      add(recording.cleanPath);
      add(`${recording.cleanPath}.metadata.json`);
      add(recording.capturePath);
      add(recording.danmakuPath);
      add(recording.cssPath);
      add(recording.assPath);
      add(recording.burnedPath);
      add(deriveSiblingPath(recording.cleanPath, 'danmaku', 'jsonl'));
      add(deriveSiblingPath(recording.cleanPath, 'danmaku', 'css'));
      add(deriveSiblingPath(recording.cleanPath, 'danmaku', 'ass'));
      add(deriveSiblingPath(recording.cleanPath, 'danmaku-only', 'ass'));
      add(deriveBurnedPath(recording.cleanPath, 'danmaku-gift'));
      add(deriveBurnedPath(recording.cleanPath, 'danmaku'));
      add(replaceExtension(recording.cleanPath, '.finalizing.mp4'));
      addKnownSiblings(recording.cleanPath);
      addKnownSiblings(recording.capturePath);
    };

    addRecordingArtifacts(mergedRecording, addProtectedPath);
    for (const session of this.recordingSessions.values()) {
      addRecordingArtifacts(session, addProtectedPath);
    }
    for (const segment of segments) {
      addRecordingArtifacts(segment, addCleanupPath);
    }

    let deletedCount = 0;
    let failedCount = 0;
    for (const [key, filePath] of cleanupPaths) {
      if (protectedPaths.has(key)) {
        continue;
      }
      if (!isPathInsideDirectory(filePath, cleanupRoot)) {
        failedCount += 1;
        this.log('warn', `${roomLabel(room)} 源分段不在本次合并目录内，已拒绝清理：${filePath}`);
        continue;
      }
      const stat = await fsp.stat(filePath).catch(() => null);
      if (!stat?.isFile()) {
        continue;
      }
      try {
        await fsp.rm(filePath, { force: true });
        deletedCount += 1;
      } catch (error) {
        failedCount += 1;
        this.log('warn', `${roomLabel(room)} 删除小分段文件失败：${filePath}，${error.message}`);
      }
    }

    let emptyDirectoryCount = 0;
    const mergedDirectoryKey = pathKey(path.dirname(mergedRecording.cleanPath));
    const activeDirectoryKeys = new Set(
      Array.from(this.recordingSessions.values()).map((session) =>
        pathKey(session.outputDir || path.dirname(session.cleanPath))
      )
    );
    const sourceDirectories = new Set(
      segments.map((segment) => path.dirname(String(segment.cleanPath || ''))).filter(Boolean)
    );
    for (const directory of sourceDirectories) {
      const directoryKey = pathKey(directory);
      if (
        !directoryKey ||
        directoryKey === mergedDirectoryKey ||
        activeDirectoryKeys.has(directoryKey) ||
        !isPathInsideDirectory(directory, this.settings.outputDir)
      ) {
        continue;
      }
      try {
        await fsp.rmdir(directory);
        emptyDirectoryCount += 1;
      } catch (error) {
        if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes(error.code)) {
          this.log('warn', `${roomLabel(room)} 清理安全空目录失败：${directory}，${error.message}`);
        }
      }
    }

    if (deletedCount > 0) {
      this.log(
        'success',
        `${roomLabel(room)} 已清理合并前的小分段文件 ${deletedCount} 个${emptyDirectoryCount ? `、安全空目录 ${emptyDirectoryCount} 个` : ''}。`
      );
    }
    if (failedCount > 0) {
      this.log('warn', `${roomLabel(room)} 有 ${failedCount} 个小分段文件未能删除，可稍后手动清理。`);
    }
    if (cleanupId) {
      const existing = this.pendingSegmentCleanups.get(cleanupId) || {};
      if (failedCount > 0) {
        this.pendingSegmentCleanups.set(cleanupId, {
          ...existing,
          cleanupId,
          roomId: room.id,
          status: 'error',
          attempts: Number(existing.attempts || 0) + 1,
          lastErrorAt: new Date().toISOString(),
          segments: segments.map((segment) => cloneRecordingState(segment)),
          mergedRecording: cloneRecordingState(mergedRecording)
        });
      } else {
        this.pendingSegmentCleanups.delete(cleanupId);
      }
      await this.saveStore();
    }
    return { deletedCount, failedCount };
  }

  async cleanupMergedSegmentResiduals() {
    const fakeRoom = { id: 'maintenance', title: '维护', anchor: '历史录像' };
    let deletedCount = 0;
    let failedCount = 0;
    let groupCount = 0;
    for (const recording of this.recordings) {
      if (!Array.isArray(recording.mergedFrom) || recording.mergedFrom.length === 0) {
        continue;
      }
      const segments = recording.mergedFrom
        .map((cleanPath) =>
          this.normalizeRecording({
            cleanPath,
            capturePath: replaceExtension(cleanPath, '.recording.mkv'),
            danmakuPath: deriveSiblingPath(cleanPath, 'danmaku', 'jsonl'),
            cssPath: deriveSiblingPath(cleanPath, 'danmaku', 'css'),
            assPath: deriveSiblingPath(cleanPath, 'danmaku', 'ass')
          })
        )
        .filter(Boolean);
      if (segments.length === 0) {
        continue;
      }
      const result = await this.cleanupMergedSegmentFiles(fakeRoom, segments, recording);
      deletedCount += result.deletedCount || 0;
      failedCount += result.failedCount || 0;
      groupCount += 1;
    }
    this.log(
      deletedCount > 0 ? 'success' : 'info',
      `已扫描 ${groupCount} 个 merged 记录，清理残留 ${deletedCount} 个${failedCount > 0 ? `，失败 ${failedCount} 个` : ''}。`
    );
    this.emitState();
    return this.getState();
  }

  async startBurnDanmaku(roomId, options = {}) {
    const room = this.getRoom(roomId);
    const recording = room.currentRecording;
    if (!recording?.cleanPath || !recording?.danmakuPath) {
      this.log('warn', `${roomLabel(room)} 没有可烧录的最近录像。`);
      return this.getState();
    }

    await this.enqueueBurnRecording(room, recording, options);
    return this.getState();
  }

  async enqueueBurnRecording(room, recording, options = {}) {
    if (!recording?.cleanPath || !recording?.danmakuPath || recording.valid === false) {
      throw new Error(`${roomLabel(room)} 没有可烧录的有效录像。`);
    }
    const cleanPathKey = path.resolve(recording.cleanPath).toLowerCase();
    const duplicate = [this.activeBurnQueueItem, ...this.burnQueue].filter(Boolean).find(
      (item) => item.roomId === room.id && path.resolve(item.recording.cleanPath).toLowerCase() === cleanPathKey
    );
    if (duplicate) {
      this.log('warn', `${roomLabel(room)} 这场录像已经在烧录队列中。`);
      return duplicate;
    }
    if (this.isRoomBurning(room)) {
      const activePath = path.resolve(room.currentRecording?.cleanPath || '').toLowerCase();
      if (activePath === cleanPathKey) {
        this.log('warn', `${roomLabel(room)} 这场录像已经在生成弹幕视频。`);
        return null;
      }
    }
    const item = {
      id: crypto.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`,
      roomId: room.id,
      room,
      recording: cloneRecordingState(recording),
      options: { ...options },
      label: `${roomLabel(room)}：${path.basename(recording.cleanPath)}`,
      createdAt: Date.now()
    };
    this.burnQueue.push(item);
    const position = this.burnQueue.length;
    this.log('info', `已加入烧录队列 #${position}：${item.label}`);
    this.emitState();
    this.pumpBurnQueue();
    return item;
  }

  pumpBurnQueue() {
    if (this.burnQueueRunning || this.burnSessions.size > 0) {
      return;
    }
    const item = this.burnQueue.shift();
    if (!item) {
      this.emitState();
      this.scheduleQueuedUpdateCheck();
      return;
    }
    this.burnQueueRunning = true;
    this.activeBurnQueueItem = item;
    this.emitState();
    setImmediate(async () => {
      let lease = null;
      try {
        const codec = this.chooseBurnCodec(item.options.codec || this.settings.burnCodec);
        lease = await this.mediaJobs.acquire({
          id: item.id,
          type: 'burn',
          resource: codec.includes('libx') ? 'cpu' : 'gpu',
          cancel: () => this.cancelBurnDanmaku(item.roomId).catch(() => {})
        });
        const started = await this.startBurnRecording(item.room, item.recording, item.options);
        if (started) {
          await this.waitForBurnIdle(item.roomId);
        }
      } catch (error) {
        this.log('error', `烧录队列任务失败：${item.label}，${error.message || String(error)}`);
      } finally {
        lease?.release();
        this.activeBurnQueueItem = null;
        this.burnQueueRunning = false;
        this.emitState();
        this.pumpBurnQueue();
      }
    });
  }

  waitForBurnIdle(roomId) {
    return new Promise((resolve) => {
      const check = () => {
        const room = this.rooms.get(String(roomId));
        if (!room || !this.isRoomBurning(room)) {
          resolve();
          return;
        }
        const timer = setTimeout(check, 500);
        timer.unref?.();
      };
      check();
    });
  }

  async prepareDanmakuForRoom(roomId, options = {}) {
    const room = this.getRoom(roomId);
    const recording = room.currentRecording;
    if (!recording?.cleanPath || !recording?.danmakuPath) {
      this.log('warn', `${roomLabel(room)} 没有可生成字幕的最近录像。`);
      return this.getState();
    }
    const assets = await this.generateSubtitleAssets(recording, {
      overlayMode: options.overlayMode || this.settings.burnOverlayMode,
      danmakuArea: options.danmakuArea || this.settings.burnDanmakuArea
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
      const danmakuArea = normalizeDanmakuDisplayArea(options.danmakuArea || this.settings.burnDanmakuArea);
      this.burnCancelRequests.delete(room.id);
      const mediaInfo = await probeMediaFileInfo(this.ffmpegPath, recording.cleanPath);
      const durationSec = await this.resolveRecordingDuration(recording, mediaInfo);
      if (durationSec > 0) {
        recording.durationSec = durationSec;
      }
      if (mediaInfo.videoInfo) {
        recording.videoInfo = mediaInfo.videoInfo;
      }
      const assets = await this.generateSubtitleAssets(recording, { overlayMode, danmakuArea });
      if (options.prepareOnly) {
        this.log('success', `${roomLabel(room)} 字幕文件已生成：${path.basename(assets.cssPath)} / ${path.basename(assets.assPath)}`);
        return true;
      }
      const burnedPath = options.outputPath || deriveBurnedPath(recording.cleanPath, overlayMode);
      const burnedTmpPath = replaceExtension(burnedPath, `.tmp.${getContainerFromPath(burnedPath)}`);
      recording.burnedPath = burnedPath;
      const codecInfo = this.getBurnCodecInfo(this.settings.burnCodec);
      const burnSourcePath = recording.cleanPath;

      await assertDiskSpace(burnedPath, { estimatedBytes: Number(recording.fileSize || 0) });
      await fsp.rm(burnedTmpPath, { force: true }).catch(() => {});
      const args = createBurnArgs({
        cleanPath: burnSourcePath,
        assPath: assets.assPath,
        burnedPath: burnedTmpPath,
        codec: this.settings.burnCodec,
        crf: this.settings.burnCrf,
        container: getContainerFromPath(burnedPath),
        fps: recording.videoInfo?.fps || mediaInfo.videoInfo?.fps
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
        roomId: room.id,
        codec: this.settings.burnCodec,
        codecKind: codecInfo.kind
      });
      room.burning = true;
      room.burnProgress = progress;
      this.burnSessions.set(room.id, ffmpeg);
      this.log(
        'info',
        `${roomLabel(room)} 正在生成有弹幕版：${path.basename(burnedPath)}（${overlayModeLabel(
          overlayMode
        )}，${danmakuDisplayAreaLabel(danmakuArea)}，${codecInfo.kind === 'hardware' ? '硬件' : '软件'}编码 ${
          codecInfo.label
        }）`
      );
      if (this.settings.notifyBurnStarted) {
        this.notify('开始烧录弹幕版', `${roomLabel(room)} 正在生成 ${path.basename(burnedPath)}`, 'burn.started', {
          roomId: room.id,
          roomTitle: room.title || '',
          anchor: room.anchor || '',
          fileName: path.basename(burnedPath)
        });
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
        if (this.burnSessions.get(room.id) === ffmpeg) {
          this.burnSessions.delete(room.id);
          room.burning = false;
        }
        finishFfmpegJobProgress(room.burnProgress, 'error', `启动失败：${error.message}`);
        fsp.rm(burnedTmpPath, { force: true }).catch(() => {});
        this.log('error', `${roomLabel(room)} 烧录进程启动失败：${error.message}`);
        this.emitState();
      });
      ffmpeg.on('close', async (code, signal) => {
        const progressId = room.burnProgress?.id;
        const cancelled = this.burnCancelRequests.delete(room.id);
        let validationError = null;
        if (!cancelled && code === 0) {
          try {
            const result = await probeMediaFileInfo(this.ffmpegPath, burnedTmpPath, { timeoutMs: 15000 });
            if (!result.videoInfo || (await getFileSize(burnedTmpPath)) < 32 * 1024) {
              throw new Error('烧录临时输出未通过视频流与文件大小验证。');
            }
            await atomicReplaceFile(burnedTmpPath, burnedPath);
          } catch (error) {
            validationError = error;
            code = -1;
          }
        }
        if (this.burnSessions.get(room.id) === ffmpeg) {
          room.burning = false;
          this.burnSessions.delete(room.id);
        }
        if (cancelled) {
          finishFfmpegJobProgress(room.burnProgress, 'cancelled', '弹幕视频生成已取消');
          fsp.rm(burnedTmpPath, { force: true }).catch(() => {});
          this.log('info', `${roomLabel(room)} 已取消生成弹幕视频：${path.basename(burnedPath)}`);
        } else if (code === 0) {
          finishFfmpegJobProgress(room.burnProgress, 'completed', '弹幕版已生成');
          this.log('success', `${roomLabel(room)} 有弹幕版已生成：${path.basename(burnedPath)}`);
          if (this.settings.notifyBurnEnded) {
            this.notify('弹幕版已生成', `${roomLabel(room)} ${path.basename(burnedPath)}`, 'burn.completed', {
              roomId: room.id,
              roomTitle: room.title || '',
              anchor: room.anchor || '',
              fileName: path.basename(burnedPath)
            });
          }
        } else {
          await fsp.rm(burnedTmpPath, { force: true }).catch(() => {});
          const failureDetail = validationError?.message || `退出码 ${code}`;
          finishFfmpegJobProgress(room.burnProgress, 'error', `烧录失败：${failureDetail}`);
          this.log('error', `${roomLabel(room)} 烧录失败：${failureDetail}，信号 ${signal || '-'}`);
          if (this.settings.notifyBurnEnded) {
            this.notify('弹幕版烧录失败', `${roomLabel(room)} 退出码 ${code}`, 'burn.failed', {
              roomId: room.id,
              roomTitle: room.title || '',
              anchor: room.anchor || '',
              fileName: path.basename(burnedPath),
              exitCode: code
            });
          }
        }
        this.emitState();
        setTimeout(() => {
          if (room.burnProgress?.id === progressId) {
            delete room.burnProgress;
            this.emitState();
          }
        }, 5000).unref?.();
        const pendingCleanup = Array.from(this.pendingSegmentCleanups.values()).find(
          (cleanup) => String(cleanup.roomId) === room.id
        );
        if (pendingCleanup && !this.isRoomBurning(room)) {
          this.cleanupMergedSegmentFiles(room, pendingCleanup.segments, pendingCleanup.mergedRecording, {
            cleanupId: pendingCleanup.cleanupId
          }).catch((error) => {
            this.log('warn', `${roomLabel(room)} 清理合并前小分段失败：${error.message}`);
          });
        }
        this.scheduleQueuedUpdateCheck();
      });
    } catch (error) {
      const cancelled = this.burnCancelRequests.delete(room.id);
      room.burning = false;
      this.burnSessions.delete(room.id);
      finishFfmpegJobProgress(
        room.burnProgress,
        cancelled ? 'cancelled' : 'error',
        cancelled ? '弹幕视频生成已取消' : `生成失败：${error.message}`
      );
      this.log(cancelled ? 'info' : 'error', `${roomLabel(room)} ${cancelled ? '已取消生成弹幕视频' : `生成弹幕版失败：${error.message}`}`);
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
    await this.ensurePlatformCjkFont();
    const overlayMode = normalizeBurnOverlayMode(options.overlayMode || this.settings.burnOverlayMode);
    const danmakuArea = normalizeDanmakuDisplayArea(options.danmakuArea || this.settings.burnDanmakuArea);
    const cssPath = options.cssPath || recording.cssPath || deriveSiblingPath(recording.cleanPath, 'danmaku', 'css');
    await ensureDanmakuCss(cssPath);
    const assPath =
      options.assPath ||
      deriveSiblingPath(recording.cleanPath, createDanmakuAssSuffix(overlayMode, danmakuArea), 'ass');
    const temporaryAssPath = `${assPath}.${process.pid}.${Date.now()}.tmp`;
    const result = await runAssWorkerJob({
      danmakuPath: recording.danmakuPath,
      cssPath,
      assPath: temporaryAssPath,
      overlayMode,
      danmakuArea,
      startTime: options.startTime,
      endTime: options.endTime,
      shiftTime: options.shiftTime
    });
    const generatedAss = await fsp.readFile(temporaryAssPath, 'utf8').catch(() => '');
    if (!generatedAss.includes('[Script Info]') || !generatedAss.includes('[Events]')) {
      await fsp.rm(temporaryAssPath, { force: true }).catch(() => {});
      throw new Error('生成的 ASS 字幕未通过结构验证。');
    }
    await atomicReplaceFile(temporaryAssPath, assPath);
    recording.cssPath = cssPath;
    recording.assPath = assPath;
    return { cssPath, assPath, eventCount: result.eventCount };
  }

  async prepareSubtitleExport(options = {}) {
    const recording = this.normalizeRecording(options.recording || options);
    if (!recording) {
      throw new Error('请选择录像文件。');
    }
    if (recording.valid === false) {
      throw new Error(`这个录像文件未通过完整性检查：${recording.validReason || '没有检测到可用视频流'}`);
    }
    this.assertExportSourcePath(recording.cleanPath);
    const startTime = parseTimeInput(options.startTime ?? options.start);
    let endTime = parseTimeInput(options.endTime ?? options.end);
    const mediaInfo = await probeMediaFileInfo(this.ffmpegPath, recording.cleanPath);
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
    const danmakuArea = normalizeDanmakuDisplayArea(options.danmakuArea || this.settings.burnDanmakuArea);
    const suffix = createClipDanmakuAssSuffix(startTime, endTime, overlayMode, danmakuArea);
    const assets = await this.generateSubtitleAssets(recording, {
      overlayMode,
      danmakuArea,
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

  async createExportQueueItem(options = {}) {
    const recording = this.normalizeRecording(options.recording || options);
    if (!recording) {
      throw new Error('请选择录像文件。');
    }
    if (recording.valid === false) {
      throw new Error(`这个录像文件未通过完整性检查：${recording.validReason || '没有检测到可用视频流'}`);
    }
    this.assertExportSourcePath(recording.cleanPath);
    if (!(await isExistingFile(recording.cleanPath))) {
      throw new Error(`源视频不存在：${recording.cleanPath}`);
    }
    const mode = normalizeExportMode(options.mode);
    const overlayMode = normalizeBurnOverlayMode(options.overlayMode || this.settings.burnOverlayMode);
    const danmakuArea = normalizeDanmakuDisplayArea(options.danmakuArea || this.settings.burnDanmakuArea);
    const startTime = parseTimeInput(options.startTime ?? options.start);
    let endTime = parseTimeInput(options.endTime ?? options.end);
    const durationSec = await this.resolveRecordingDuration(recording, {}, Number(recording.durationSec || 0));
    if (durationSec > 0 && Number.isFinite(endTime) && endTime > durationSec) {
      endTime = durationSec;
    }
    if (!Number.isFinite(startTime) || startTime < 0) {
      throw new Error('开始时间无效，请输入 00:00:00 或秒数。');
    }
    if (!Number.isFinite(endTime) || endTime <= startTime) {
      throw new Error('结束时间必须大于开始时间。');
    }
    const outputDir = path.resolve(String(options.outputDir || path.dirname(recording.cleanPath)));
    const outputPath = path.resolve(
      options.outputPath ||
        deriveClipPath(recording.cleanPath, outputDir, mode === 'clean' ? 'clean' : overlayMode, startTime, endTime)
    );
    this.assertExportOutputPath(outputDir, outputPath);
    await this.ensureDirectoryReady(outputDir, { label: '剪辑输出目录' });
    const id = crypto.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const startTimeText = formatFfmpegSeconds(startTime);
    const endTimeText = formatFfmpegSeconds(endTime);
    const item = {
      id,
      label: `${mode === 'clean' ? '纯净' : '烧录'}片段：${path.basename(recording.cleanPath)}`,
      mode,
      cleanPath: recording.cleanPath,
      outputPath,
      startTime: startTimeText,
      endTime: endTimeText,
      createdAt: Date.now(),
      request: {
        ...options,
        mode,
        cleanPath: recording.cleanPath,
        danmakuPath: options.danmakuPath || recording.danmakuPath,
        cssPath: options.cssPath || recording.cssPath,
        assPath: options.assPath || recording.assPath,
        startTime: startTimeText,
        endTime: endTimeText,
        overlayMode,
        danmakuArea,
        outputDir,
        outputPath
      }
    };
    return { item, recording, mode, outputPath };
  }

  async exportClip(options = {}) {
    const { item, recording, mode, outputPath } = await this.createExportQueueItem(options);
    this.exportQueue.push(item);
    const queuePosition = this.exportQueue.length;
    this.log('info', `已加入导出队列 #${queuePosition}：${item.label} -> ${path.basename(outputPath)}`);
    this.emitState();
    this.pumpExportQueue();
    return {
      ok: true,
      mode,
      queued: true,
      queueId: item.id,
      message: queuePosition > 1 || this.exportProgress?.status === 'running' ? '已加入导出队列' : '已加入队列并准备开始',
      outputPath,
      cleanPath: recording.cleanPath,
      cssPath: item.request.cssPath,
      assPath: undefined
    };
  }

  pumpExportQueue() {
    if (this.exportQueueRunning || this.exportProcess || this.exportProgress?.status === 'running') {
      return;
    }
    const item = this.exportQueue.shift();
    if (!item) {
      this.emitState();
      return;
    }
    this.exportQueueRunning = true;
    this.emitState();
    setImmediate(async () => {
      let lease = null;
      try {
        const codec = this.chooseBurnCodec(item.request.codec || this.settings.burnCodec);
        lease = await this.mediaJobs.acquire({
          id: item.id,
          type: 'export',
          resource: item.mode === 'clean' ? 'io' : codec.includes('libx') ? 'cpu' : 'gpu',
          cancel: () => this.cancelExportClip().catch(() => {})
        });
        await this.runExportClipNow(item.request);
      } catch (error) {
        this.log('error', `导出队列任务失败：${item.label}，${error.message || String(error)}`);
      } finally {
        lease?.release();
        this.exportQueueRunning = false;
        this.emitState();
        if (this.exportQueue.length > 0) {
          this.pumpExportQueue();
        }
      }
    });
  }

  async runExportClipNow(options = {}) {
    const recording = this.normalizeRecording(options.recording || options);
    if (!recording) {
      throw new Error('请选择录像文件。');
    }
    if (recording.valid === false) {
      throw new Error(`这个录像文件未通过完整性检查：${recording.validReason || '没有检测到可用视频流'}`);
    }
    this.assertExportSourcePath(recording.cleanPath);
    if (!(await isExistingFile(recording.cleanPath))) {
      throw new Error(`源视频不存在：${recording.cleanPath}`);
    }
    const mode = normalizeExportMode(options.mode);
    const overlayMode = normalizeBurnOverlayMode(options.overlayMode || this.settings.burnOverlayMode);
    const danmakuArea = normalizeDanmakuDisplayArea(options.danmakuArea || this.settings.burnDanmakuArea);
    const startTime = parseTimeInput(options.startTime ?? options.start);
    let endTime = parseTimeInput(options.endTime ?? options.end);
    const mediaInfo = await probeMediaFileInfo(this.ffmpegPath, recording.cleanPath);
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
    await this.ensureDirectoryReady(outputDir, { label: '剪辑输出目录' });
    const outputPath =
      options.outputPath ||
      deriveClipPath(recording.cleanPath, outputDir, mode === 'clean' ? 'clean' : overlayMode, startTime, endTime);
    const outputContainer = getContainerFromPath(outputPath);
    const temporaryOutputPath = replaceExtension(outputPath, `.tmp.${outputContainer}`);
    await assertDiskSpace(outputPath, { estimatedBytes: Math.ceil(Number(recording.fileSize || 0) * Math.min(1, duration / Math.max(1, durationSec || duration))) });
    await fsp.rm(temporaryOutputPath, { force: true }).catch(() => {});
    this.exportCancelRequested = false;

    let cssPath = recording.cssPath;
    let assPath = recording.assPath;
    let temporaryAssDir = '';
    let args;
    let codecInfo = null;
    if (mode === 'clean') {
      args = createClipCopyArgs({
        cleanPath: recording.cleanPath,
        outputPath: temporaryOutputPath,
        startTime,
        duration,
        container: outputContainer
      });
    } else {
      temporaryAssDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'br2k-export-ass-'));
      const temporaryAssPath = path.join(temporaryAssDir, 'subtitle.ass');
      const assets = await this.generateSubtitleAssets(recording, {
        overlayMode,
        danmakuArea,
        startTime,
        endTime,
        shiftTime: true,
        cssPath: options.cssPath || recording.cssPath,
        assPath: temporaryAssPath
      });
      cssPath = assets.cssPath;
      assPath = assets.assPath;
      codecInfo = this.getBurnCodecInfo(this.settings.burnCodec);
      args = createBurnArgs({
        cleanPath: recording.cleanPath,
        assPath,
        burnedPath: temporaryOutputPath,
        codec: this.settings.burnCodec,
        crf: this.settings.burnCrf,
        container: outputContainer,
        startTime,
        duration,
        fps: recording.videoInfo?.fps || mediaInfo.videoInfo?.fps
      });
    }

    const progress = createFfmpegJobProgress({
      kind: 'export',
      label: `导出${mode === 'clean' ? '纯净' : '烧录'}片段：${path.basename(outputPath)}`,
      outputPath,
      durationSec: duration,
      codec: codecInfo?.value,
      codecKind: codecInfo?.kind
    });
    clearTimeout(this.exportProgressClearTimer);
    this.exportProgress = progress;
    this.exportProcess = null;
    this.exportCancelRequested = false;
    this.emitState();

    this.log(
      'info',
      `开始导出${mode === 'clean' ? '纯净' : '烧录'}片段：${path.basename(outputPath)}${
        codecInfo ? `（${codecInfo.kind === 'hardware' ? '硬件' : '软件'}编码 ${codecInfo.label}）` : ''
      }`
    );
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
      const exportedMediaInfo = await probeMediaFileInfo(this.ffmpegPath, temporaryOutputPath, { timeoutMs: 15000 });
      if (!exportedMediaInfo.videoInfo || (await getFileSize(temporaryOutputPath)) < 32 * 1024) {
        throw new Error('导出临时输出未通过视频流与文件大小验证。');
      }
      await atomicReplaceFile(temporaryOutputPath, outputPath);
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
        await fsp.rm(temporaryOutputPath, { force: true }).catch(() => {});
        this.log('info', `已取消导出片段：${path.basename(outputPath)}`);
      } else if (this.exportProgress?.id === progress.id) {
        finishFfmpegJobProgress(this.exportProgress, 'error', `导出失败：${message}`);
        this.emitState();
      }
      if (!cancelled) {
        throw error;
      }
    } finally {
      await fsp.rm(temporaryOutputPath, { force: true }).catch(() => {});
      if (this.exportProgress?.id === progress.id) {
        this.exportProcess = null;
        this.exportCancelRequested = false;
      }
      if (temporaryAssDir) {
        await fsp.rm(temporaryAssDir, { recursive: true, force: true }).catch(() => {});
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
        cssPath
      };
    }
    return {
      ok: true,
      mode,
      outputPath,
      cleanPath: recording.cleanPath,
      cssPath,
      assPath: undefined
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
      message: this.supportsManagedLinuxUpdate()
        ? `已排队更新到 ${this.updateState.latestVersion}，全部媒体任务结束后将自动校验、安装并重启服务。`
        : `已排队更新到 ${this.updateState.latestVersion}，全部媒体任务结束后自动下载更新包。`
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
          ? this.createManualUpdateMessage(manifest, usablePackagePath)
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
        message: this.createManualUpdateMessage(manifest, packagePath),
        downloadProgress: 100,
        packagePath
      };
      this.log('success', this.updateState.message);
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
        message: '当前仍有录制或媒体处理任务，暂不安装更新；可以排队等待任务结束。'
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
          ? `正在准备已下载的 ${manifest.version} ${updatePackageLabel(manifest)}...`
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
      if (process.platform === 'linux' && this.supportsManagedLinuxUpdate()) {
        await this.requestManagedLinuxUpdate(manifest, packagePath);
        this.updateState = {
          ...this.updateState,
          status: 'applying',
          queued: false,
          message: `已验证 ${manifest.version} 更新包，systemd 更新服务将自动安装并重启后台服务。`,
          downloadProgress: 100,
          packagePath
        };
        this.log('success', this.updateState.message);
        this.emitState();
        return this.getState();
      }
      this.updateState = {
        ...this.updateState,
        status: 'available',
        queued: false,
        message: this.createManualUpdateMessage(manifest, packagePath),
        downloadProgress: 100,
        packagePath
      };
      this.log('success', this.updateState.message);
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

  createManualUpdateMessage(manifest, packagePath) {
    const label = updatePackageLabel(manifest);
    const action = label === '安装器' ? '手动运行安装器' : '手动更新';
    return `${label}已下载。安装会中断监听和录制，请确认空闲后打开下载目录${action}：${packagePath}`;
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
    manifest.officialSource = isDefaultUpdateSource(source, DEFAULT_UPDATE_MANIFEST_URL);
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
      } else if (updateStatus === 'pending' || updateStatus === 'processing') {
        this.updateState = {
          ...this.updateState,
          status: updateStatus === 'pending' ? 'queued' : 'applying',
          queued: updateStatus === 'pending',
          latestVersion: version,
          message:
            updateStatus === 'pending'
              ? `官方签名更新 ${version || ''} 已交给 root 更新服务，等待处理。`
              : `root 更新服务正在处理 ${version || '目标版本'}；若上次中断，将从 processing 状态恢复。`,
          checkedAt: Date.now(),
          statusPath,
          updateLogPath: status.logPath || this.getUpdateLogPath()
        };
        this.log('info', this.updateState.message);
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
    if (process.platform === 'linux' && process.env.BILI_RECORD_MANAGED_UPDATE === '1') {
      return path.resolve(process.env.BILI_RECORD_UPDATE_DIR || '/var/lib/bili-record-2k-updates');
    }
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
        (/^bili-record-2k[-_]/.test(name) && /\.(?:exe|zip|deb|tar\.gz|tgz)$/i.test(name))
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
          message: `自动下载更新失败：${error.message}`
        };
        this.log('error', this.updateState.message);
        this.emitState();
      });
    }, delayMs);
    this.queuedUpdateTimer.unref?.();
  }

  supportsManagedLinuxUpdate(manifest = this.updateState.manifest) {
    return (
      process.platform === 'linux' &&
      process.env.BILI_RECORD_MANAGED_UPDATE === '1' &&
      Boolean(manifest?.officialSource) &&
      manifest?.signatureAlgorithm === 'ed25519' &&
      Boolean(manifest?.signed && manifest?.signature)
    );
  }

  async ensurePlatformCjkFont() {
    if (this.linuxCjkFontVerified || process.platform !== 'linux') return;
    const result = await runCapturedProcess('fc-match', ['-f', '%{family}', 'Noto Sans CJK SC'], {
      timeoutMs: 5000,
      maxOutputBytes: 16 * 1024
    });
    if (result.status !== 0 || !/Noto Sans CJK SC/i.test(result.stdout)) {
      throw new Error('Linux 缺少已验证的 Noto Sans CJK SC 字体；请安装 fonts-noto-cjk 后再生成新字幕或烧录。');
    }
    this.linuxCjkFontVerified = true;
  }

  getMergeEncoderPlan(targetVideoInfo) {
    const hevc = isHevcCodec(targetVideoInfo?.codec);
    const bitDepth = Number(targetVideoInfo?.bitDepth || 8);
    const tenBit = bitDepth > 8 || Boolean(targetVideoInfo?.hdr);
    const highChroma = /(?:422|444)/.test(String(targetVideoInfo?.pixelFormat || ''));
    const available = new Set(this.getAvailableBurnCodecs());
    const hardwareCandidates = highChroma || bitDepth > 10
      ? []
      : hevc
      ? ['hevc_nvenc', 'hevc_qsv', 'hevc_amf']
      : tenBit
        ? []
        : ['h264_nvenc', 'h264_qsv', 'h264_amf'];
    const hardware = hardwareCandidates.find((codec) => available.has(codec)) || '';
    const software = hevc ? 'libx265' : 'libx264';
    return { preferred: hardware || software, fallback: hardware ? software : '', software, tenBit };
  }

  async requestManagedLinuxUpdate(manifest, packagePath) {
    if (!this.supportsManagedLinuxUpdate(manifest)) {
      throw new Error('Linux root 自动安装只接受官方 Ed25519 签名更新清单；自定义或未签名更新源只能手动安装。');
    }
    const resolvedPackagePath = path.resolve(packagePath);
    if (!isPathInsideDirectory(resolvedPackagePath, this.getUpdateDir())) {
      throw new Error('更新包不在受控下载目录中，拒绝交给系统更新服务。');
    }
    const requestPath = path.join(this.getUpdateDir(), 'apply-request.json');
    const tmpPath = `${requestPath}.${process.pid}.tmp`;
    const request = {
      schemaVersion: 2,
      app: 'bili-record-2k',
      packagePath: resolvedPackagePath,
      signed: manifest.signed,
      signatureAlgorithm: manifest.signatureAlgorithm,
      signature: manifest.signature,
      requestedAt: new Date().toISOString()
    };
    await fsp.mkdir(this.getUpdateDir(), { recursive: true });
    await fsp.writeFile(tmpPath, `${JSON.stringify(request, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    await fsp.rename(tmpPath, requestPath);
    const statusPath = this.getUpdateStatusPath();
    const statusTmpPath = `${statusPath}.${process.pid}.tmp`;
    await fsp.writeFile(
      statusTmpPath,
      `${JSON.stringify({ status: 'pending', version: normalizeVersion(manifest.version), packagePath: resolvedPackagePath, message: '官方签名更新已排队。', updatedAt: new Date().toISOString() }, null, 2)}\n`,
      { encoding: 'utf8', mode: 0o600 }
    );
    await fsp.rename(statusTmpPath, statusPath);
  }

  scheduleAutomaticUpdateCheck(delayMs = AUTO_UPDATE_INTERVAL_MS) {
    clearTimeout(this.autoUpdateTimer);
    this.autoUpdateTimer = null;
    if (!this.settings.autoUpdateEnabled || process.platform !== 'linux' || delayMs <= 0) {
      return;
    }
    this.autoUpdateTimer = setTimeout(async () => {
      try {
        await this.checkUpdate();
        if (this.updateState.manifest && compareVersions(this.updateState.latestVersion, APP_VERSION) > 0) {
          await this.queueUpdateAfterJobs();
        }
      } catch (error) {
        this.log('warn', `自动检查更新失败：${error.message}`);
      } finally {
        this.scheduleAutomaticUpdateCheck(AUTO_UPDATE_INTERVAL_MS);
      }
    }, delayMs);
    this.autoUpdateTimer.unref?.();
  }

  hasActiveJobs() {
    return (
      this.mediaJobs.hasActive() ||
      this.recordingSessions.size > 0 ||
      this.recordingStartLocks.size > 0 ||
      this.reconnectPendingRooms.size > 0 ||
      this.burnSessions.size > 0 ||
      this.burnQueueRunning ||
      this.burnQueue.length > 0 ||
      Boolean(this.exportProcess) ||
      Boolean(this.exportPreviewProcess) ||
      this.exportQueueRunning ||
      this.exportQueue.length > 0 ||
      Array.from(this.rooms.values()).some(
        (room) => room.recording || room.burning || room.mergeProgress?.status === 'running'
      )
    );
  }

  async setStartup(enabled) {
    if (process.platform !== 'win32') {
      throw new Error('开机自启目前只支持 Windows。');
    }
    await setStartupEnabled(Boolean(enabled));
    this.startupEnabled = Boolean(enabled);
    this.log(Boolean(enabled) ? 'success' : 'info', Boolean(enabled) ? '已开启开机自启。' : '已关闭开机自启。');
    this.emitState();
    return this.getState();
  }

  async testNotification() {
    if (process.platform !== 'win32') {
      throw new Error('系统通知测试目前只支持 Windows 桌面版。');
    }
    this.notify('测试通知', '哔哩录播 2K Windows 通知功能正常', 'test.windows', {}, { webhook: false });
    this.log('success', '已发送 Windows 测试通知。');
    this.emitState();
    return this.getState();
  }

  async testWebhook() {
    const payload = await this.sendWebhookNotification({
      id: `test-${Date.now()}`,
      event: 'test',
      title: 'Webhook 测试',
      message: '哔哩录播 2K Webhook 通知功能正常',
      time: Date.now(),
      data: { test: true }
    });
    this.log('success', 'Webhook 测试发送成功。');
    return {
      ...this.getState(),
      operationNotice: {
        kind: 'success',
        title: 'Webhook 可用',
        message: `接收端已返回成功状态，事件 ID：${payload.id}`
      }
    };
  }

  async requestShutdown() {
    if (this.draining) return { ok: true, draining: true };
    this.log('info', '后台服务即将进入 draining：停止接收新任务，完成录像收尾与状态保存后退出。');
    this.emitState();
    setTimeout(() => {
      if (this.shutdownHandler) this.shutdownHandler('webui');
      else this.beginShutdown('webui').catch(() => {});
    }, 250).unref();
    return { ok: true };
  }

  setShutdownHandler(handler) {
    this.shutdownHandler = typeof handler === 'function' ? handler : null;
  }

  getRoom(roomId) {
    const room = this.rooms.get(String(roomId));
    if (!room) {
      throw new Error(`找不到房间 ${roomId}`);
    }
    return room;
  }

  async beginShutdown(reason = 'signal') {
    if (this.shutdownPromise) return this.shutdownPromise;
    this.shutdownPromise = this.performShutdown(reason);
    return this.shutdownPromise;
  }

  async performShutdown(reason) {
    this.draining = true;
    this.log('info', `正在优雅退出（${reason}）：停止监听并收尾活动媒体任务。`);
    this.clearLoginTimer();
    clearTimeout(this.queuedUpdateTimer);
    clearTimeout(this.autoUpdateTimer);
    if (this.pathPickerProcess) {
      forceKillProcess(this.pathPickerProcess);
      this.pathPickerProcess = null;
      this.pathPickerPromise = null;
    }
    this.pathPickerStarting = false;
    for (const timer of this.monitorTimers.values()) {
      clearInterval(timer);
    }
    this.monitorTimers.clear();
    for (const roomId of Array.from(this.livePushMonitors.keys())) {
      this.stopLivePushMonitor(roomId);
    }
    const activeSessions = Array.from(this.recordingSessions.values());
    for (const session of activeSessions) {
      clearTimeout(session?.rotateTimer);
      clearTimeout(session?.mediaWatchTimer);
      clearTimeout(session?.qualityWatchTimer);
      session.stopping = true;
      session?.danmakuClient?.close('服务退出');
      if (session?.ffmpeg) {
        requestFfmpegStop(session.ffmpeg, { graceful: true, timeoutMs: 15000 });
      }
    }
    const cancelledBurnQueueCount = this.burnQueue.splice(0).length;
    const cancelledExportQueueCount = this.exportQueue.splice(0).length;
    if (cancelledBurnQueueCount || cancelledExportQueueCount) {
      this.log(
        'info',
        `退出前已取消尚未开始的媒体任务：烧录 ${cancelledBurnQueueCount} 个，导出 ${cancelledExportQueueCount} 个。`
      );
    }
    await this.mediaJobs.shutdown();
    for (const ffmpeg of this.burnSessions.values()) {
      requestFfmpegStop(ffmpeg, { graceful: false, timeoutMs: 5000 });
    }
    if (this.exportProcess) {
      requestFfmpegStop(this.exportProcess, { graceful: false, timeoutMs: 1500 });
    }
    const completion = Promise.all([
      Promise.allSettled(activeSessions.map((session) => session.completionPromise)),
      this.mediaJobs.waitForIdle(90_000)
    ]);
    await Promise.race([
      completion,
      new Promise((resolve) => setTimeout(resolve, 90000))
    ]);
    const webhookFlush = this.webhookQueueRunning
      ? new Promise((resolve) => {
          const check = () => (this.webhookQueueRunning ? setTimeout(check, 100) : resolve());
          check();
        })
      : Promise.resolve();
    await Promise.race([webhookFlush, new Promise((resolve) => setTimeout(resolve, 5000))]);
    await this.saveStore().catch((error) => this.log('error', `退出前保存状态失败：${error.message}`));
    await this.stateStore.flush();
    this.log('success', '录像、弹幕和配置状态已完成收尾，可以安全退出。');
  }

  shutdown() {
    return this.beginShutdown('legacy');
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

async function isExistingFile(filePath) {
  if (!filePath) {
    return false;
  }
  return fsp
    .stat(filePath)
    .then((stat) => stat.isFile())
    .catch(() => false);
}

async function runAssWorkerJob(payload) {
  const managedServerEntry = String(process.env.BILI_RECORD_SERVER_ENTRY || '').trim();
  const args = isSingleExecutableRuntime()
    ? ['--ass-worker']
    : [managedServerEntry || path.join(APP_ROOT, 'src', 'server', 'index.cjs'), '--ass-worker'];
  const result = await runCapturedProcess(process.execPath, args, {
    input: JSON.stringify(payload),
    timeoutMs: 180000,
    maxOutputBytes: 256 * 1024
  });
  if (result.timedOut) {
    throw new Error('字幕生成超时，已终止后台字幕任务。');
  }
  if (result.error) {
    throw new Error(`字幕任务启动失败：${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new Error(`字幕生成失败：${compactLogLine(result.stderr || result.stdout) || `退出码 ${result.status}`}`);
  }
  try {
    const response = JSON.parse(String(result.stdout || '').trim());
    if (!response.ok) {
      throw new Error(response.message || '字幕任务未成功完成。');
    }
    return response;
  } catch (error) {
    throw new Error(`字幕任务返回无效：${error.message}`);
  }
}

function isSingleExecutableRuntime() {
  try {
    return Boolean(require('node:sea').isSea());
  } catch {
    return Boolean(process.pkg);
  }
}

module.exports = {
  LiveRecordService,
  createUiCapabilities,
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
