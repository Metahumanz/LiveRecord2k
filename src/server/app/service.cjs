const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const QRCode = require('qrcode');
const {
  createGpuSceneProbeArgs,
  createGpuSceneRenderRequest,
  parseGpuSceneRendererProbe,
  resolveGpuSceneRenderer,
  JETSON_GL_REQUIRED_ELEMENTS,
  JETSON_CUDA_NVMM_REQUIRED_ELEMENTS
} = require('../danmaku/gpu-scene-renderer.cjs');
const {
  createCudaSceneConformanceUnavailable,
  canUseCudaSceneProduction,
  canUseDesktopCudaSceneProduction
} = require('../danmaku/gpu-scene-conformance.cjs');
const {
  collectDesktopCudaEnvironment,
  runDesktopCudaSceneConformance
} = require('../danmaku/desktop-cuda-conformance.cjs');
const {
  buildAccelerationDiagnostics,
  buildExportDiagnosticReport,
  sanitizeDiagnosticReport
} = require('./diagnostics.cjs');
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
  classifyDanmakuEventIgnore,
  monotonicNowMs,
  SessionEventDeduper,
  normalizeDanmakuDisplayArea,
  danmakuDisplayAreaLabel,
  ensureDanmakuCss,
  createDefaultDanmakuCss,
  parseCssVariables,
  normalizeDanmakuStyle,
  normalizeDanmakuStylePreset,
  normalizeDanmakuStyleLayout,
  prepareAssEvents,
  readDanmakuEvents,
  sceneCacheRecord,
  stableId,
  readSceneCacheEvents,
  buildSceneGraph,
  writeSceneGraph,
  clipSceneGraph,
  compileSceneToAss,
  writeSceneFilterScript,
  createSceneAssRemuxArgs,
  SCENE_STYLE_PRESETS,
  getDanmakuEventDuration,
  createRecordingArgs,
  createMp4FinalizeArgs,
  createBurnArgs,
  createBurnRawVideoArgs,
  createJetsonNativeDecodeArgs,
  createBurnRawSceneFromPipeArgs,
  createJetsonGstreamerEncodeArgs,
  createBurnEncodedVideoMuxArgs,
  createBurnAudioMuxArgs,
  createAvatarOverlayFilterScript,
  createAvatarOverlayChunkFilterScript,
  clipAvatarOverlayEntries,
  createPreviewHlsArgs,
  runFfmpegToGstreamerJob,
  runJetsonNativeDecodeSceneEncodeJob,
  runJetsonNativeDecodeCudaSceneJob,
  createClipCopyArgs,
  createConcatCopyArgs,
  createNormalizeSegmentArgs,
  createNormalizeRawVideoArgs,
  createNormalizeEncodedVideoMuxArgs,
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
  detectJetsonRuntimeIdentity,
  hasVideoAdapterVendor,
  testFfmpegEncoder,
  testFfmpegAvatarCompositeBackend,
  normalizeBurnCodec,
  normalizeRoomImageMode,
  normalizeBurnOverlayMode,
  normalizeBurnAvatarMode,
  normalizeExportMode,
  overlayModeLabel,
  basenameWithoutExt,
  normalizeTargetQn,
  createQnProbeList,
  getContainerFromPath,
  deriveSiblingPath,
  deriveAvatarManifestPath,
  deriveAvatarDirectory,
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
  resetFfmpegJobProgressRate,
  setFfmpegJobPhase,
  updateFfmpegJobPrepareProgress,
  updateFfmpegJobProgress,
  setFfmpegJobStageFps,
  finishFfmpegJobProgress,
  parseFfmpegProgressTime,
  parseFfmpegTime,
  probeMediaFileInfo,
  probeMediaClipTimelineInfo,
  probeMediaTimelineInfo,
  probeMediaTimelineHealth,
  resolveReliableDurationSec,
  readDanmakuDurationSec,
  isHevcCodec,
  isJetsonGstreamerCodec,
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
  preferSceneGraphCapableFfmpeg,
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
const { MediaJobManager, normalizeResourceSlots } = require('./media-job-manager.cjs');
const { RoomMonitorService, getMonitorPollDelayMs } = require('./room-monitor-service.cjs');
const { SettingsService } = require('./settings-service.cjs');
const { MaintenanceService } = require('./maintenance-service.cjs');
const { UpdateService, AUTO_UPDATE_INITIAL_DELAY_MS, AUTO_UPDATE_INTERVAL_MS } = require('./update-service.cjs');
const { StatePublisher } = require('./state-publisher.cjs');
const {
  normalizeTrustedProxyList,
  isValidTrustedProxyRule,
  validateRemoteUrl,
  redactSensitive
} = require('../shared/security.cjs');
const { atomicReplaceFile, assertDiskSpace } = require('../recording/media-safety.cjs');
const { BufferedJsonlWriter } = require('../recording/jsonl-writer.cjs');
const { runJetsonEndToEndSelfTest: runJetsonBurnEndToEndSelfTest } = require('../recording/jetson-self-test.cjs');
const { createAss } = require('../danmaku/ass.cjs');
const {
  NATIVE_EARLY_FALLBACK_SEC,
  shouldAbortCommittedJetsonNativeFallback,
  createCommittedJetsonNativeRuntimeError,
  decideJetsonNativeFailure
} = require('../recording/jetson-policy.cjs');

const LEGACY_ASS_SCENE_PRESETS = new Set(['h5-card', 'bubble', 'minimal']);
class BusinessError extends Error {
  constructor(code, message, statusCode = 400) {
    super(message);
    this.name = 'BusinessError';
    this.code = String(code || 'BUSINESS_ERROR');
    this.statusCode = Number(statusCode) || 400;
    this.isBusinessError = true;
  }
}

function isBusinessError(error) {
  return Boolean(error?.isBusinessError && error?.code && error?.statusCode);
}

function businessError(code, message, statusCode) {
  return new BusinessError(code, message, statusCode);
}

function parseRoomInput(value) {
  const raw = String(value || '').trim();
  if (/^\d+$/.test(raw)) {
    return raw;
  }
  if (!raw) {
    throw businessError('INVALID_ROOM_ID', '请输入直播间房间号或 B 站直播间链接。', 400);
  }

  const urlText = /^(?:https?:)?\/\//i.test(raw) ? raw : `https://${raw}`;
  let parsed;
  try {
    parsed = new URL(urlText);
  } catch {
    throw businessError('INVALID_ROOM_ID', '请输入有效的直播间房间号或 B 站直播间链接。', 400);
  }
  const hostname = parsed.hostname.toLowerCase();
  if (hostname !== 'live.bilibili.com' && !hostname.endsWith('.live.bilibili.com')) {
    throw businessError('INVALID_ROOM_ID', '仅支持 B 站直播间链接（live.bilibili.com）。', 400);
  }
  const pathParts = parsed.pathname.split('/').filter(Boolean);
  const roomId = pathParts.find((part) => /^\d+$/.test(part));
  if (!roomId) {
    throw businessError('INVALID_ROOM_ID', '链接中没有找到有效的直播间房间号。', 400);
  }
  return roomId;
}



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
const MIN_MEDIA_GROWTH_BYTES = 32 * 1024;
const STARTUP_CORRUPTION_GUARD_MS = 12 * 1000;
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
const PATH_PROBE_TIMEOUT_MS = 2500;
const PATH_CREATE_TIMEOUT_MS = 8000;
const PATH_PICKER_TIMEOUT_MS = 5 * 60 * 1000;
const WEBHOOK_TIMEOUT_MS = 10 * 1000;
const WEBHOOK_MAX_QUEUE_SIZE = 100;
const WEBHOOK_RETRY_DELAYS_MS = [0, 1000, 3000];
const RUN_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';
const MAX_PROXY_IMAGE_BYTES = 15 * 1024 * 1024;
const MAX_AVATAR_OVERLAY_IMAGE_BYTES = 2 * 1024 * 1024;
const JETSON_SELF_TEST_AVATAR_UID = 1;
const LIMITED_AVATAR_OVERLAY_ENTRIES = 6;
const UNLIMITED_AVATAR_OVERLAY_ENTRIES = Number.MAX_SAFE_INTEGER;
// FFmpeg's expression evaluator has a practical nesting limit.  Keep each
// motion expression small; this is an internal layer split and does not limit
// the number of avatars retained by high-quality mode.
const MAX_AVATAR_OVERLAY_SEGMENTS_PER_ENTRY = 32;
// overlay_cuda allocates a full filter surface for every chained layer. Keep
// each CUDA chunk bounded and shorten dense chunks before falling back to CPU,
// otherwise a busy minute can either exhaust VRAM or unnecessarily lose the
// hardware path for the whole minute.
const MAX_CUDA_AVATAR_OVERLAY_ENTRIES = 48;
const AVATAR_OVERLAY_CHUNK_SECONDS = 60;
const MIN_CUDA_AVATAR_CHUNK_SECONDS = 5;
// Seek a little before each independent avatar chunk, then discard accurately
// to its true source-time boundary.  This prevents a long-GOP keyframe before
// the requested position from leaking into the next concatenated chunk.
const AVATAR_CHUNK_SEEK_PREROLL_SECONDS = 2;
const MAX_AVATAR_OVERLAY_CONCURRENCY = 3;
const RECORDED_AVATAR_MANIFEST_SCHEMA_VERSION = 1;
const RECORDED_AVATAR_CAPTURE_CONCURRENCY = 3;
const RECORDED_AVATAR_FLUSH_TIMEOUT_MS = 12 * 1000;
const MAX_JSON_BODY_BYTES = 1024 * 1024;
const SEGMENT_ROTATION_GRACE_MS = 10 * 1000;
const PREVIEW_SESSION_TTL_MS = 10 * 60 * 1000;
const MAX_PREVIEW_PLAYLIST_BYTES = 2 * 1024 * 1024;
const QUALITY_UPGRADE_CHECK_MS = 90 * 1000;
const QUALITY_UPGRADE_CONFIRMATIONS = 2;
const QUALITY_SWITCH_COOLDOWN_MS = 3 * 60 * 1000;
const MEDIA_PROGRESS_STALL_TIMEOUT_MS = 75 * 1000;
const MEDIA_PROGRESS_JUMP_TOLERANCE_SEC = 8;
const MEDIA_PROGRESS_BACKWARD_TOLERANCE_SEC = 0.75;
// A decode error can leave FFmpeg alive while it repeatedly prints errors but
// never advances its media clock.  Merge jobs are deliberately watched more
// patiently than live recording, then retried from the preserved source files.
const MERGE_PROGRESS_STALL_TIMEOUT_MS = 2 * 60 * 1000;
const MERGE_FIRST_MEDIA_TIMEOUT_MS = 30 * 1000;
const MERGE_REPEATED_DECODE_ERROR_GRACE_MS = 6 * 1000;
const MERGE_REPEATED_DECODE_ERROR_LIMIT = 12;
const MERGE_CORRUPT_PREFIX_RECOVERY_SEEK_SEC = 5;
const MERGE_RETRY_DELAYS_MS = [30 * 1000, 2 * 60 * 1000, 10 * 60 * 1000];
const MERGE_STARTUP_RETRY_DELAY_MS = 15 * 1000;
const MERGE_STAGE_HEARTBEAT_MS = 1000;
const MERGE_AV_DURATION_TOLERANCE_SEC = 0.08;
const MERGE_AV_BOUNDARY_TOLERANCE_SEC = 0.12;
function avatarOverlayEntryLimit(mode) {
  switch (normalizeBurnAvatarMode(mode)) {
    case 'off':
      return 0;
    case 'limited':
      return LIMITED_AVATAR_OVERLAY_ENTRIES;
    default:
      return UNLIMITED_AVATAR_OVERLAY_ENTRIES;
  }
}

function burnAvatarModeLabel(mode) {
  switch (normalizeBurnAvatarMode(mode)) {
    case 'off':
      return '关闭';
    case 'limited':
      return `少量（最多 ${LIMITED_AVATAR_OVERLAY_ENTRIES} 个）`;
    default:
      return '高质量（全部真实头像）';
  }
}

function normalizeBiliAvatarUrl(value) {
  const raw = typeof value === 'string' ? value.trim() : '';
  if (!raw || raw.length > 2048) return '';
  try {
    const target = new URL(raw.startsWith('//') ? `https:${raw}` : raw);
    const host = target.hostname.toLowerCase();
    const isAvatarHost =
      host === 'hdslb.com' || host.endsWith('.hdslb.com') || host === 'biliimg.com' || host.endsWith('.biliimg.com');
    if (!['http:', 'https:'].includes(target.protocol) || !isAvatarHost) return '';
    target.protocol = 'https:';
    return target.toString();
  } catch {
    return '';
  }
}

function avatarImageExtension(contentType) {
  const type = String(contentType || '').split(';', 1)[0].trim().toLowerCase();
  return (
    {
      'image/jpeg': '.jpg',
      'image/jpg': '.jpg',
      'image/png': '.png',
      'image/webp': '.webp',
      'image/gif': '.gif'
    }[type] || ''
  );
}

function createAvatarCircleFilter(size) {
  const edge = Math.round(clamp(size, 8, 512));
  return (
    `scale=${edge}:${edge}:force_original_aspect_ratio=increase,crop=${edge}:${edge},format=rgba,` +
    "geq=r='r(X,Y)':g='g(X,Y)':b='b(X,Y)':a='if(lte((X-W/2)*(X-W/2)+(Y-H/2)*(Y-H/2),(W/2)*(W/2)),255,0)'"
  );
}

async function mapWithConcurrency(values, concurrency, mapper) {
  const output = Array(values.length).fill(null);
  let nextIndex = 0;
  const workerCount = Math.min(values.length, Math.max(1, Math.floor(Number(concurrency) || 1)));
  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (nextIndex < values.length) {
        const index = nextIndex;
        nextIndex += 1;
        output[index] = await mapper(values[index], index);
      }
    })
  );
  return output;
}

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
  { value: 'h264_amf', label: 'AMD H.264 硬件编码', kind: 'hardware', vendor: 'amd' },
  { value: 'hevc_v4l2m2m', label: 'V4L2 M2M H.265 硬件编码', kind: 'hardware', vendor: 'nvidia', platform: 'linux', backend: 'v4l2m2m' },
  { value: 'h264_v4l2m2m', label: 'V4L2 M2M H.264 硬件编码', kind: 'hardware', vendor: 'nvidia', platform: 'linux', backend: 'v4l2m2m' },
  { value: 'hevc_nvv4l2', label: 'Jetson V4L2 H.265 硬件编码', kind: 'hardware', vendor: 'nvidia', platform: 'linux', backend: 'gstreamer', element: 'nvv4l2h265enc' },
  { value: 'h264_nvv4l2', label: 'Jetson V4L2 H.264 硬件编码', kind: 'hardware', vendor: 'nvidia', platform: 'linux', backend: 'gstreamer', element: 'nvv4l2h264enc' }
];
const BURN_CODEC_VALUES = new Set(BURN_CODEC_CANDIDATES.map((codec) => codec.value));
// Ownership and mode bits on network and FUSE filesystems are often a view
// synthesized by their mount driver.  A successful chmod(2) is not a useful
// signal there (and CIFS commonly rejects it altogether), so those mounts use
// the service-account read/write probe as their authority instead.
const NON_POSIX_RECORDING_FILESYSTEM_TYPES = new Set([
  'cifs',
  'smbfs',
  'smb3',
  'nfs',
  'nfs4',
  '9p',
  'afpfs',
  'ceph',
  'glusterfs',
  'lustre',
  'davfs',
  'sshfs',
  'fuseblk'
]);

function decodeLinuxMountInfoPath(value) {
  return String(value || '').replace(/\\([0-7]{3})/g, (_match, octal) => String.fromCharCode(Number.parseInt(octal, 8)));
}

function normalizeLinuxMountPath(value) {
  const normalized = path.posix.normalize(String(value || '/').replace(/\\/g, '/'));
  return normalized === '.' ? '/' : normalized;
}

function findLinuxMountForPath(mountInfo, targetPath) {
  const target = normalizeLinuxMountPath(targetPath);
  const candidates = [];
  for (const rawLine of String(mountInfo || '').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const fields = line.split(' ');
    const separator = fields.indexOf('-');
    if (separator < 6 || !fields[4] || !fields[separator + 1]) continue;
    const mountPoint = normalizeLinuxMountPath(decodeLinuxMountInfoPath(fields[4]));
    const matches = mountPoint === '/' || target === mountPoint || target.startsWith(`${mountPoint.replace(/\/$/, '')}/`);
    if (!matches) continue;
    candidates.push({
      mountPoint,
      fsType: String(fields[separator + 1] || '').toLowerCase(),
      source: decodeLinuxMountInfoPath(fields[separator + 2] || '')
    });
  }
  return candidates.sort((left, right) => right.mountPoint.length - left.mountPoint.length)[0] || null;
}

function isNonPosixRecordingMount(mount) {
  const type = String(mount?.fsType || '').toLowerCase();
  return NON_POSIX_RECORDING_FILESYSTEM_TYPES.has(type) || type === 'fuse' || type.startsWith('fuse.');
}
const SETTINGS_UPDATE_KEYS = new Set([
  'outputDir',
  'cookie',
  'pollIntervalSec',
  'targetQn',
  'preferHevc',
  'roomImageMode',
  'outputContainer',
  'segmentMinutes',
  'autoBurnDanmaku',
  'deleteSourceAfterBurn',
  'sceneGraphCaptureMode',
  'sceneGraphDefaultStyle',
  'burnOverlayMode',
  'burnDanmakuArea',
  'burnDanmakuStylePreset',
  'burnDanmakuStyleLayout',
  'burnAvatarMode',
  'burnCodec',
  'burnCrf',
  'notifyLiveStarted',
  'notifyLiveEnded',
  'notifyRecordingStarted',
  'notifyRecordingEnded',
  'notifyBurnStarted',
  'notifyBurnEnded',
  'webhookEnabled',
  'webhookUrl',
  'webhookBearerToken',
  'webhookBearerTokenConfigured',
  'webhookBearerTokenClear',
  'webhookAllowPrivateNetwork',
  'openBrowserOnStart',
  'hideOverviewNextStep',
  'autoUpdateEnabled',
  'updateManifestUrl',
  'serverHost',
  'serverPort',
  'accessUsername',
  'accessPassword',
  'accessAuthConfigured',
  'trustedProxies'
]);
const BOOLEAN_SETTINGS_UPDATE_KEYS = new Set([
  'preferHevc',
  'autoBurnDanmaku',
  'deleteSourceAfterBurn',
  'notifyLiveStarted',
  'notifyLiveEnded',
  'notifyRecordingStarted',
  'notifyRecordingEnded',
  'notifyBurnStarted',
  'notifyBurnEnded',
  'webhookEnabled',
  'webhookBearerTokenConfigured',
  'webhookBearerTokenClear',
  'webhookAllowPrivateNetwork',
  'openBrowserOnStart',
  'hideOverviewNextStep',
  'autoUpdateEnabled',
  'accessAuthConfigured'
]);
const STRING_SETTINGS_UPDATE_LIMITS = {
  outputDir: 4096,
  cookie: 16 * 1024,
  burnCodec: 128,
  webhookUrl: 2048,
  webhookBearerToken: 4096,
  updateManifestUrl: 2048,
  accessUsername: 64,
  accessPassword: 1024
};

function isWindowsSystemDrivePath(targetPath) {
  if (process.platform !== 'win32') return false;
  const systemDrive = String(process.env.SystemDrive || '').trim();
  if (!/^[a-z]:$/i.test(systemDrive)) return false;
  const targetRoot = path.parse(path.resolve(String(targetPath || ''))).root;
  return targetRoot.toLowerCase() === `${systemDrive}\\`.toLowerCase();
}

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

function deriveSceneCachePath(cleanPath) {
  return deriveSiblingPath(cleanPath, 'scene', 'jsonl');
}

function deriveSceneGraphPath(cleanPath) {
  return deriveSiblingPath(cleanPath, 'scene', 'json');
}

function deriveSceneAssPath(cleanPath, stylePreset) {
  const preset = SCENE_STYLE_PRESETS.includes(String(stylePreset || '')) ? String(stylePreset) : 'current';
  return deriveSiblingPath(cleanPath, 'scene.' + preset, 'ass');
}

function deriveSceneMkvPath(cleanPath, stylePreset) {
  const preset = SCENE_STYLE_PRESETS.includes(String(stylePreset || '')) ? String(stylePreset) : 'current';
  return deriveSiblingPath(cleanPath, 'scene.' + preset, 'mkv');
}

function deriveCapturePath(cleanPath) {
  const parsed = path.parse(String(cleanPath || ''));
  const base = parsed.name.replace(/\.clean$/i, '');
  return base ? path.join(parsed.dir, `${base}.recording.mkv`) : '';
}

async function getCleanupPreviewSize(filePath, stat, depth = 0) {
  if (!stat?.isDirectory()) {
    return Math.max(0, Number(stat?.size || 0));
  }
  if (depth >= 12) {
    return 0;
  }
  const entries = await fsp.readdir(filePath, { withFileTypes: true }).catch(() => []);
  let totalBytes = 0;
  for (const entry of entries) {
    const childPath = path.join(filePath, entry.name);
    const childStat = await fsp.lstat(childPath).catch(() => null);
    if (!childStat || childStat.isSymbolicLink()) continue;
    if (childStat.isFile() || childStat.isDirectory()) {
      totalBytes += await getCleanupPreviewSize(childPath, childStat, depth + 1);
    }
  }
  return totalBytes;
}

function getCleanupArtifactType(filePath, stat) {
  if (stat?.isDirectory()) return '关联目录';
  const name = path.basename(String(filePath || '')).toLowerCase();
  if (/\.clean\.(?:mp4|mkv)$/i.test(name)) return '合并前视频分段';
  if (/\.metadata\.json$/i.test(name)) return '录像元数据';
  if (/\.danmaku\.(?:jsonl|css|ass)$/i.test(name)) return '弹幕侧车文件';
  if (/\.(?:recording\.mkv|finalizing\.mp4)$/i.test(name)) return '临时录像文件';
  if (/\.danmaku(?:-only)?\.(?:mp4|mkv)$/i.test(name)) return '关联弹幕视频';
  return '关联生成文件';
}

function isFfmpegMemoryPressureError(error) {
  const signal = String(error?.ffmpegSignal || '').toUpperCase();
  // Linux's OOM killer reports SIGKILL.  Windows may instead expose the
  // STATUS_NO_MEMORY process status (signed or unsigned), or FFmpeg may exit
  // normally after printing an allocation failure.  Keep this platform-neutral
  // so a fallback encoder does not immediately recreate the same pressure.
  if (signal === 'SIGKILL') {
    return true;
  }
  const exitCode = Number(error?.ffmpegExitCode);
  if (exitCode === 3221225495 || exitCode === -1073741801) {
    return true;
  }
  const detail = `${error?.ffmpegStderr || ''}\n${error?.message || ''}`;
  return /(?:out of memory|cannot allocate memory|not enough memory|insufficient memory|memory allocation (?:failed|error)|could not allocate .*memory|std::bad_alloc|av_malloc)/i.test(
    detail
  );
}

function countRepeatedVideoDecodeErrors(text) {
  return (
    String(text || '').match(
      /(?:duplicate poc in a sequence|error parsing nal unit|invalid nal unit|error submitting packet to decoder)/gi
    ) || []
  ).length;
}

function isFfmpegVideoDecodeError(error) {
  if (error?.code === 'FFMPEG_DECODE_STALL' || error?.code === 'FFMPEG_NO_PROGRESS') return true;
  const detail = `${error?.ffmpegStderr || ''}\n${error?.message || ''}`;
  return /(?:duplicate poc in a sequence|error parsing nal unit|invalid nal unit|error submitting packet to decoder)/i.test(
    detail
  );
}

function isFfmpegHardwareDecodeError(error) {
  const detail = `${error?.ffmpegStderr || ''}\n${error?.message || ''}`;
  return /(?:hwaccel|hardware accelerator|hardware decoding|no device available for decoder|device setup failed|failed setup for format|failed to initialise|failed to initialize|error while decoding|failed to decode|decoder.*(?:failed|error)|cuvid|nvdec|nvv4l2|v4l2m2m|d3d11va|dxva2|qsv.*(?:decode|device|session)|vaapi.*(?:decode|device|display)|cannot load nvcuda|cuda_error|unsupported.*(?:surface|pixel format))/i.test(
    detail
  );
}

function isFfmpegAvatarCompositeError(error) {
  const detail = `${error?.ffmpegStderr || ''}\n${error?.message || ''}`;
  // A GPU blend failure is distinct from decoder/encoder failures. Retry
  // the same job with the prewritten CPU panel graph instead of losing an
  // otherwise healthy hardware encoder.
  return /(?:(?:overlay_(?:cuda|vaapi|vulkan|opencl)|hwupload(?:_cuda)?|hwdownload|scale_cuda|init_hw_device|filter_hw_device)[^\n]*(?:can't|cannot|failed|error)|(?:can't|cannot) overlay\s+\w+\s+on\s+\w+)/i.test(
    detail
  );
}

function createCpuAvatarCompositeFallbackLayer(layer) {
  const cpuFilterScriptPath = String(layer?.cpuFilterScriptPath || '').trim();
  if (!layer?.gpuComposite || !cpuFilterScriptPath) return null;
  return {
    ...layer,
    gpuComposite: false,
    gpuCompositeBackend: '',
    gpuCompositeMode: '',
    gpuCompositeDevice: '',
    gpuOutputToCpu: false,
    filterScriptPath: cpuFilterScriptPath,
    chunked: false,
    chunkDuration: 0
  };
}

function finiteTimelineValue(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function deriveTimelineBoundaryDelta(timeline, boundary) {
  const explicit = finiteTimelineValue(boundary === 'Start' ? timeline?.avStartDeltaSec : timeline?.avEndDeltaSec);
  if (explicit !== null) return explicit;
  const audio = finiteTimelineValue(boundary === 'Start' ? timeline?.firstAudioPts : timeline?.lastAudioPts);
  const video = finiteTimelineValue(boundary === 'Start' ? timeline?.firstVideoPts : timeline?.lastVideoPts);
  return audio !== null && video !== null ? audio - video : null;
}

// A clean recording already has one media clock.  The first decodable video
// packet may start after the first audio packet because of keyframe/reorder
// metadata; that difference is not proof that playback is out of sync.  Keep
// the probe values for diagnostics, but never synthesize black/silence from
// firstVideoPts-firstAudioPts.  Clip callers reset both tracks from the same
// source origin (clipStart), so the renderer receives a zero-based clock.
function getBurnTimelineAlignment(recording, startTime = 0, duration = 0, actualTimeline = null) {
  const clipStart = Math.max(0, Number(startTime) || 0);
  // Once an export has attempted the authoritative clean-file clip probe,
  // its result is the complete source of truth.  In particular, a failed or
  // incomplete probe must not fall back to stale sidecar PTS and synthesize a
  // black/silence lead that the current clip never had.
  const hasAuthoritativeClipProbe = actualTimeline?.actualClipProbe === true;
  const candidates = (hasAuthoritativeClipProbe
    ? [actualTimeline]
    : [actualTimeline, recording?.timelineHealth, recording?.timingInfo, recording?.streamMetadata]
  ).filter(
    (value) => value && typeof value === 'object'
  );
  const firstFinite = (field) => {
    for (const candidate of candidates) {
      const value = finiteTimelineValue(candidate?.[field]);
      if (value !== null) return value;
    }
    return null;
  };
  const firstVideoPts = firstFinite('firstVideoPts');
  const firstAudioPts = firstFinite('firstAudioPts');
  return {
    videoPaddingSec: 0,
    audioPaddingSec: 0,
    sourceClockOriginSec: clipStart,
    videoClockStartSec: 0,
    audioClockStartSec: 0,
    firstVideoPts,
    firstAudioPts
  };
}

// AAC is natively valid in both MP4 and MKV. For a whole-recording burn, keep
// it packet-for-packet instead of decoding/re-encoding it: the source audio
// clock is already known-good and this also saves a large CPU-only pass.
function canCopyWholeSourceAudio(mediaInfo, startTime, duration, timelineAlignment) {
  const sourceDuration = Math.max(0, Number(mediaInfo?.durationSec) || 0);
  const audioCodec = String(mediaInfo?.audioInfo?.codec || '').toLowerCase();
  const firstAudioPts = Number(timelineAlignment?.firstAudioPts);
  const firstVideoPts = Number(timelineAlignment?.firstVideoPts);
  return Boolean(
    sourceDuration > 0 &&
      /(?:^|\W)aac(?:\W|$)/.test(audioCodec) &&
      Math.max(0, Number(startTime) || 0) <= 0.001 &&
      Number(duration) >= sourceDuration - 0.1 &&
      Number.isFinite(firstAudioPts) &&
      Number.isFinite(firstVideoPts) &&
      Math.abs(firstAudioPts) <= 0.001 &&
      Math.abs(firstVideoPts) <= 0.001 &&
      Math.max(0, Number(timelineAlignment?.audioPaddingSec) || 0) <= 0.0005
  );
}

// Deciding whether copy-concat is safe must use timing as well as codec,
// resolution and frame rate. A source can have identical stream specs while
// only its own audio starts late, then appear to recover at the next segment.
function getMergeSegmentTimingAssessment(recording, hasAudio) {
  if (!hasAudio) {
    return { known: true, requiresNormalization: false, reason: '' };
  }
  const health = recording?.timelineHealth;
  const timingInfo = recording?.timingInfo;
  const timeline =
    health && typeof health === 'object'
      ? { ...(timingInfo && typeof timingInfo === 'object' ? timingInfo : {}), ...health }
      : timingInfo && typeof timingInfo === 'object'
        ? timingInfo
        : null;
  const status = String(timeline?.timelineHealth || recording?.timelineHealthStatus || health || '').toLowerCase();
  if (!timeline) {
    return { known: false, requiresNormalization: true, reason: '缺少已验证的音画时间轴' };
  }
  if (status === 'broken') {
    return { known: true, requiresNormalization: true, reason: '分段时间轴已标记为异常' };
  }
  const durationDelta = finiteTimelineValue(timeline.avDeltaSec);
  const startDelta = deriveTimelineBoundaryDelta(timeline, 'Start');
  const endDelta = deriveTimelineBoundaryDelta(timeline, 'End');
  const warnings = Array.isArray(timeline.warnings) ? timeline.warnings.join('；') : String(timeline.warnings || '');
  const hardPacketRisk =
    timeline.videoDtsMonotonic === false ||
    timeline.audioDtsMonotonic === false ||
    Number(timeline.corruptPacketCount || 0) > 0 ||
    /(?:PTS 大幅回退|DTS 回退|损坏|时间戳异常|non[- ]?monoton)/i.test(warnings);
  if (hardPacketRisk) {
    return { known: true, requiresNormalization: true, reason: '分段存在损坏包或非单调时间戳' };
  }
  if (durationDelta !== null && Math.abs(durationDelta) > MERGE_AV_DURATION_TOLERANCE_SEC) {
    return { known: true, requiresNormalization: true, reason: '音画时长相差 ' + durationDelta.toFixed(3) + 's' };
  }
  if (durationDelta === null) {
    return { known: false, requiresNormalization: true, reason: '缺少可验证的音画时长信息' };
  }
  // A start/end PTS origin difference is retained for burn filters, but is
  // not proof of a user-visible A/V drift. Older versions persisted it as
  // timingSafeForCopy=false, so explicitly treat this shape as advisory and
  // verify the final copy-concat once instead of eagerly normalizing hours of
  // otherwise synchronous media.
  const hasBoundaryOffset =
    (startDelta !== null && Math.abs(startDelta) > MERGE_AV_BOUNDARY_TOLERANCE_SEC) ||
    (endDelta !== null && Math.abs(endDelta) > MERGE_AV_BOUNDARY_TOLERANCE_SEC);
  const advisoryReason = hasBoundaryOffset
    ? `保留源 PTS 起点/终点偏移（起始 ${startDelta === null ? '-' : startDelta.toFixed(3)}s，末尾 ${
        endDelta === null ? '-' : endDelta.toFixed(3)
      }s），将无损拼接后复验`
    : status === 'warning' || timeline.timingSafeForCopy === false
      ? '时间轴存在非致命提示，将无损拼接后复验'
      : '';
  return {
    known: true,
    requiresNormalization: false,
    requiresPostMergeVerification: Boolean(advisoryReason),
    reason: advisoryReason
  };
}

function getMergeSegmentVideoDurationSec(timingInfo, mediaInfo, segment, nextSegment) {
  const containerDurationSec = Math.max(
    0,
    Number(timingInfo?.containerDurationSec || mediaInfo?.durationSec || segment?.durationSec || 0)
  );
  const rawVideoDurationSec = Math.max(0, Number(timingInfo?.videoDurationSec || 0));
  const presentationDurationSec = Math.max(
    0,
    Number(timingInfo?.videoPresentationDurationSec || rawVideoDurationSec + Number(timingInfo?.videoReorderAllowanceSec || 0))
  );
  if (presentationDurationSec > 0) {
    // The stream-copy probe reports video DTS. Restore its small B-frame
    // reorder tail, but never extend beyond the container's known duration.
    return containerDurationSec > 0 ? Math.min(presentationDurationSec, containerDurationSec) : presentationDurationSec;
  }
  return containerDurationSec || Number(getSegmentDurationForMerge(segment, nextSegment) || 0);
}

function sourceArtifactStem(cleanPath) {
  const parsed = path.parse(String(cleanPath || ''));
  return parsed.name.replace(/\.(?:clean|recording|finalizing)$/i, '');
}

function isGeneratedSegmentArtifactName(fileName, cleanPath) {
  const name = String(fileName || '');
  const stem = sourceArtifactStem(cleanPath);
  if (!name || !stem || !name.toLowerCase().startsWith(stem.toLowerCase() + '.')) return false;
  const suffix = name.slice(stem.length + 1).toLowerCase();
  return (
    /^clean\.(?:mp4|mkv)(?:\.metadata\.json(?:\.[^.]+)*)?$/.test(suffix) ||
    /^clean\.(?:finalizing|tmp|recovered\.tmp)\.(?:mp4|mkv)(?:\.[^.]+)*$/.test(suffix) ||
    /^(?:recording\.mkv|finalizing\.(?:mp4|mkv))(?:\.[^.]+)*$/.test(suffix) ||
    /^danmaku(?:-only)?(?:\.[^.]+)*\.(?:jsonl|css|ass|mp4|mkv)(?:\.[^.]+)*$/.test(suffix)
  );
}

class LiveRecordService {
  constructor() {
    const appData =
      process.env.BILI_RECORD_CONFIG_DIR ||
      (process.platform === 'win32'
        ? process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming')
        : process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'));
    this.storePath = path.join(appData, 'BiliRecord2K', STORE_FILE);
    // The Jetson runner persists a real ASS-vs-CUDA fixture report here.
    // Runtime probing alone never grants CUDA production eligibility.
    this.cudaSceneConformanceReportPath = String(process.env.BILI_RECORD_CUDA_SCENE_CONFORMANCE_REPORT || '').trim() ||
      path.join(appData, 'BiliRecord2K', 'cuda-scene-conformance.json');
    this.lastExportDiagnosticPath = String(process.env.BILI_RECORD_LAST_EXPORT_DIAGNOSTIC || '').trim() ||
      path.join(appData, 'BiliRecord2K', 'last-export-diagnostic.json');
    this.stateStore = new AtomicJsonStore(this.storePath);
    this.storeExists = false;
    this.previewCacheDir = path.join(appData, 'BiliRecord2K', 'preview-cache');
    this.legacyRepairCacheDir = path.join(appData, 'BiliRecord2K', 'repair-cache');
    this.settingsService = new SettingsService(this, {
      DEFAULT_UPDATE_MANIFEST_URL,
      DEFAULT_HOST,
      DEFAULT_PORT,
      BURN_CODEC_VALUES,
      SETTINGS_UPDATE_KEYS,
      BOOLEAN_SETTINGS_UPDATE_KEYS,
      STRING_SETTINGS_UPDATE_LIMITS,
      normalizeContainer,
      normalizeBurnCodec,
      normalizeTargetQn,
      normalizeRoomImageMode,
      normalizeBurnOverlayMode,
      normalizeDanmakuDisplayArea,
      normalizeDanmakuStylePreset,
      normalizeDanmakuStyleLayout,
      normalizeBurnAvatarMode,
      normalizeServerHost,
      normalizeTrustedProxyList,
      isValidTrustedProxyRule,
      normalizeWebhookUrl,
      isPublicServerHost,
      clamp,
      hashAccessPassword,
      businessError
    });
    this.maintenanceService = new MaintenanceService(this, {
      APP_VERSION,
      CACHE_STATE_FILE,
      CACHE_STATE_SCHEMA_VERSION,
      PREVIEW_CACHE_VERSION,
      PATH_PROBE_TIMEOUT_MS,
      businessError,
      deriveCapturePath,
      isExistingFile
    });
    this.settings = this.createDefaultSettings();
    this.rooms = new Map();
    this.removingRoomIds = new Set();
    this.logs = [];
    this.roomMonitor = new RoomMonitorService(this, {
      roomLabel,
      getCookieValue,
      createBiliError,
      DanmakuClient
    });
    // Keep the existing fields available to shutdown, diagnostics, and
    // integrations while their lifecycle moves into RoomMonitorService.
    this.monitorTimers = this.roomMonitor.monitorTimers;
    this.livePushMonitors = this.roomMonitor.livePushMonitors;
    this.roomTickLocks = this.roomMonitor.roomTickLocks;
    this.recordingSessions = new Map();
    this.recordingStartLocks = new Set();
    this.reconnectPendingRooms = new Set();
    this.streamStartRetryRooms = new Set();
    this.streamStartRetryTimers = new Map();
    this.liveStreamHealth = new Map();
    this.liveDiagnostics = new Map();
    this.liveDanmakuDedupers = new Map();
    this.burnSessions = new Map();
    this.burnQueue = [];
    this.burnQueueRunning = false;
    this.activeBurnQueueItem = null;
    this.burnCancelRequests = new Set();
    this.pendingSegmentCleanups = new Map();
    this.maintenanceCleanupPlans = new Map();
    this.mergeProcesses = new Map();
    this.mergeCancelRequests = new Set();
    this.mergeInFlightGroups = new Map();
    this.mergeRetryStates = new Map();
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
    this.activeExportQueueItem = null;
    this.cancelledExportQueueIds = new Set();
    this.recordings = [];
    this.recordingScanPromise = null;
    this.notifications = [];
    this.diagnostics = { acceleration: null, lastExportFailure: null };
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
    this.hardwareSelfTest = {
      status: 'idle',
      message: '尚未运行硬件加速自检。',
      startedAt: 0,
      completedAt: 0,
      codec: '',
      encoderBackend: '',
      decoderBackend: '',
      avatarCompositeBackend: '',
      fallbackReason: ''
    };
    this.hardwareSelfTestPromise = null;
    this.jetsonAvatarSelfTestAssetPromise = null;
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
    this.updateApplyPromise = null;
    this.managedLinuxUpdateRequestPromise = null;
    this.updateService = new UpdateService(this);
    this.ffmpegPath = findFfmpegPath();
    this.ffmpegCapabilities = {
      burnCodecs: BURN_CODEC_CANDIDATES.filter((codec) => codec.kind === 'software'),
      unavailableBurnCodecs: [],
      hwaccels: [],
      hardwareDecoders: [],
      videoAdapters: [],
      gstreamerEncoders: [],
      jetsonBurnTests: {},
      sceneGpuRenderer: null,
      sceneGpuVisualConformance: createCudaSceneConformanceUnavailable(),
      avatarComposite: null,
      avatarCompositeReason: '',
      cudaAvatarComposite: false,
      cudaAvatarCompositeReason: '',
      desktopCuda: {
        available: false,
        conformanceStatus: 'pending',
        conformanceCached: false,
        reason: '尚未执行桌面 CUDA 合成/NVENC 自检。'
      },
      probedAt: 0,
      probeError: ''
    };
    this.runtimeCapabilitiesPromise = null;
    this.desktopCudaConformancePromise = null;
    this.settings = this.normalizeSettings(this.settings);
    this.statePublisher = new StatePublisher({
      getFullState: (options) => this.getState(options),
      getRoomIds: () => Array.from(this.rooms.keys()),
      getDeltaPayload: (type, detail, client) => this.getSseDeltaPayload(type, detail, client)
    });
    this.mediaJobs.on('change', () => this.markMediaJobDirty());
    // Keep the old public field available for diagnostics and test helpers.
    this.clients = this.statePublisher.clients;
  }

  createDefaultSettings() {
    return this.settingsService.createDefaultSettings();
  }

  async init() {
    await this.loadStore();
    await this.loadLastExportDiagnostic();
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
    // 启动时的录像库扫描会读取大量 JSONL 和媒体元数据。它与 Jetson
    // GStreamer 实机自检并行时会抢占事件循环，导致刚加入的导出请求在
    // 浏览器超时后才真正进入内存队列。先完成能力探测；已落盘录像列表
    // 仍可立刻展示，随后再在空闲时刷新整个库。
    this.startRuntimeCapabilitiesProbe().finally(() => {
      setImmediate(() => {
        this.initializeRecordingLibrary().catch((error) => {
          this.log('warn', `后台扫描录像库失败：${error.message}`);
          this.emitState();
        });
      });
    });
    setImmediate(() => {
      this.recoverPersistedSegmentCleanups().catch((error) => {
        this.log('warn', `恢复 0.4.0 分段清理任务失败：${error.message}`);
      });
    });
    setImmediate(() => {
      this.recoverInterruptedRecordings().catch((error) => {
        this.log('warn', `恢复异常中断录像失败：${error.message}`);
      });
    });
    this.scheduleAutomaticUpdateCheck(AUTO_UPDATE_INITIAL_DELAY_MS);
  }

  getCacheStatePath() {
    return this.maintenanceService.getCacheStatePath();
  }

  async prepareVersionedCaches() {
    return this.maintenanceService.prepareVersionedCaches();
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
    await this.resumePendingMergeRetries();
  }

  async initializeRuntimeCapabilities() {
    const ffmpegSelection = await preferSceneGraphCapableFfmpeg(this.ffmpegPath);
    if (ffmpegSelection.path !== this.ffmpegPath) {
      this.ffmpegPath = ffmpegSelection.path;
      this.log('warn', ffmpegSelection.fallbackReason);
    }
    [this.ffmpegCapabilities, this.startupEnabled] = await Promise.all([
      detectFfmpegCapabilities(this.ffmpegPath, {
        testJetsonEndToEnd: (codecInfo) => this.runJetsonGstreamerEndToEndSelfTest(codecInfo)
      }),
      isStartupEnabled()
    ]);
    this.ffmpegCapabilities.sceneGpuRenderer = await this.probeGpuSceneRenderer();
    this.ffmpegCapabilities.sceneGpuVisualConformance = this.ffmpegCapabilities.sceneGpuRenderer.visualConformance ||
      createCudaSceneConformanceUnavailable();
    await this.initializeDesktopCudaConformance();
    await this.refreshAccelerationDiagnostics();
    this.settings = this.normalizeSettings(this.settings);
    this.log('info', `可用弹幕版编码：${this.ffmpegCapabilities.burnCodecs.map((codec) => codec.label).join('、') || '未探测到'}`);
    const selectedCodec = this.getBurnCodecInfo(this.settings.burnCodec);
    this.log(
      'info',
      `当前弹幕版编码：${selectedCodec.label}（选中的编码器 ${this.settings.burnCodec}，实际后端 ${this.getEncoderBackendLabel(selectedCodec)}）`
    );
    const hardwareDecoderSummary = ['h264', 'hevc']
      .map((codec) => {
        const labels = [
          ...new Set(
            (this.ffmpegCapabilities.hardwareDecoders || [])
              .filter((decoder) => decoder.codec === codec)
              .map((decoder) => decoder.label)
          )
        ];
        return `${codec.toUpperCase()} ${labels.join('、') || '不可用'}`;
      })
      .join('；');
    this.log(
      (this.ffmpegCapabilities.hardwareDecoders || []).length ? 'info' : 'warn',
      `可用硬件解码：${hardwareDecoderSummary}`
    );
    for (const probe of Object.values(this.ffmpegCapabilities.jetsonBurnTests || {})) {
      this.log(
        probe?.ok ? 'success' : 'warn',
        `Jetson ${probe?.codec || 'nvv4l2'} 端到端烧录自检${probe?.ok ? '通过，可用于烧录。' : '未通过，不会标记为可用。'}${
          probe?.reason ? ` 原因：${probe.reason}` : ''
        }`
      );
    }
    const gpuScene = this.ffmpegCapabilities.sceneGpuRenderer;
    const cudaSceneProduction = canUseCudaSceneProduction(gpuScene, this.ffmpegCapabilities.sceneGpuVisualConformance);
    this.log(
      gpuScene?.available ? 'success' : 'info',
      gpuScene?.available
        ? gpuScene.backend === 'cuda-gstreamer'
          ? `Jetson GPU Scene renderer 已通过运行时 probe：${gpuScene.backend}（${gpuScene.helper}）。${cudaSceneProduction.ok ? '视觉一致性自检通过，可用于生产 CUDA Scene。' : `尚未取得生产资格：${cudaSceneProduction.reason}`}`
          : `Jetson GPU Scene renderer 已通过运行时 probe：${gpuScene.backend}（${gpuScene.helper}）。视觉一致性验证未通过，当前保持 CPU Scene 导出。`
        : `Jetson GPU Scene renderer 当前不可用，将保持 CPU Scene 导出：${gpuScene?.reason || '未安装 helper。'}`
    );
    const avatarComposite = this.getAvatarCompositeCapability();
    this.log(
      avatarComposite ? 'info' : 'warn',
      avatarComposite
        ? avatarComposite.value === 'cuda'
          ? '已验证 NVIDIA CUDA 真实头像合成链路；它独立于视频编码后端，Jetson GStreamer 编码同样可使用。'
          : `已验证 ${avatarComposite.label}；头像动画在 CPU 小面板生成，最终全画面透明叠加由 GPU 完成。`
        : `真实头像透明图层将使用 CPU 合成${
            this.ffmpegCapabilities.avatarCompositeReason || this.ffmpegCapabilities.cudaAvatarCompositeReason
              ? `：${this.ffmpegCapabilities.avatarCompositeReason || this.ffmpegCapabilities.cudaAvatarCompositeReason}`
              : ''
          }`
    );
    const desktopCuda = this.ffmpegCapabilities.desktopCuda;
    if (desktopCuda?.available) {
      const desktopCudaSceneProduction = canUseDesktopCudaSceneProduction(
        desktopCuda,
        desktopCuda.visualConformance,
        { environmentFingerprint: desktopCuda.environmentFingerprint }
      );
      this.log(
        'success',
        `桌面 NVIDIA CUDA 已通过真实自检：${desktopCuda.decoder ? 'CUDA 硬解、' : ''}${desktopCuda.compositor || 'overlay_cuda'} 合成、${desktopCuda.encoder}。${desktopCudaSceneProduction.ok ? 'ASS 金标准视觉门禁通过，三套旧样式将使用完整 CUDA Scene。' : `完整 CUDA Scene 尚未准入：${desktopCudaSceneProduction.reason}`}`
      );
    } else if (process.platform !== 'linux' || process.arch !== 'arm64') {
      this.log('info', `桌面 NVIDIA CUDA 合成链未启用：${desktopCuda?.reason || '尚未完成自检。'}`);
    }
    this.emitState();
  }

  async initializeDesktopCudaConformance() {
    const desktopCuda = this.ffmpegCapabilities?.desktopCuda;
    if (!desktopCuda?.available) return;
    let environment;
    try {
      environment = await collectDesktopCudaEnvironment({
        ffmpegPath: this.ffmpegPath,
        appVersion: APP_VERSION,
        videoAdapters: this.ffmpegCapabilities.videoAdapters
      });
    } catch (error) {
      desktopCuda.conformanceStatus = 'failed';
      desktopCuda.conformanceReason = `无法读取桌面 CUDA 自检环境：${compactLogLine(error.message || error)}`;
      desktopCuda.reason = desktopCuda.conformanceReason;
      return;
    }
    desktopCuda.environment = environment;
    desktopCuda.environmentFingerprint = environment.fingerprint;
    const report = await this.readCudaSceneConformanceReport();
    this.applyDesktopCudaConformanceReport(report, { cached: false });
    const admission = canUseDesktopCudaSceneProduction(
      desktopCuda,
      report,
      { environmentFingerprint: environment.fingerprint }
    );
    if (admission.ok) {
      this.applyDesktopCudaConformanceReport(report, { cached: true });
      return;
    }
    this.ensureDesktopCudaConformance().catch((error) => {
      this.log('warn', `桌面 CUDA Scene 视觉门禁失败：${error.message}`);
    });
  }

  applyDesktopCudaConformanceReport(report, options = {}) {
    const desktopCuda = this.ffmpegCapabilities?.desktopCuda;
    if (!desktopCuda) return { ok: false, reason: '桌面 CUDA runtime 不可用。' };
    desktopCuda.visualConformance = report;
    const admission = canUseDesktopCudaSceneProduction(
      desktopCuda,
      report,
      { environmentFingerprint: desktopCuda.environmentFingerprint }
    );
    desktopCuda.fullSceneProduction = admission.ok;
    desktopCuda.conformanceCached = Boolean(options.cached && admission.ok);
    desktopCuda.conformanceReason = admission.reason || '';
    if (admission.ok) desktopCuda.conformanceStatus = 'passed';
    else if (!report?.executedAt) desktopCuda.conformanceStatus = 'pending';
    else if (report?.passed !== true) desktopCuda.conformanceStatus = 'failed';
    else desktopCuda.conformanceStatus = 'stale';
    return admission;
  }

  ensureDesktopCudaConformance() {
    if (this.desktopCudaConformancePromise) return this.desktopCudaConformancePromise;
    const desktopCuda = this.ffmpegCapabilities?.desktopCuda;
    if (!desktopCuda?.available || desktopCuda.fullSceneProduction) return Promise.resolve(null);
    this.desktopCudaConformancePromise = this.startDesktopCudaConformance()
      .finally(() => { this.desktopCudaConformancePromise = null; });
    return this.desktopCudaConformancePromise;
  }

  async startDesktopCudaConformance() {
    const desktopCuda = this.ffmpegCapabilities?.desktopCuda;
    if (!desktopCuda?.available) return null;
    if (this.exportProgress || this.burnQueue.some((item) => ['queued', 'running'].includes(item.status))) {
      desktopCuda.conformanceStatus = 'pending';
      desktopCuda.conformanceReason = '当前有媒体任务，桌面 CUDA 视觉门禁将在空闲时执行。';
      return null;
    }
    desktopCuda.conformanceStatus = 'running';
    desktopCuda.conformanceCached = false;
    this.emitState();
    const report = await runDesktopCudaSceneConformance({
      ffmpegPath: this.ffmpegPath,
      environment: desktopCuda.environment,
      environmentFingerprint: desktopCuda.environmentFingerprint
    });
    await fsp.mkdir(path.dirname(this.cudaSceneConformanceReportPath), { recursive: true });
    const temporaryPath = `${this.cudaSceneConformanceReportPath}.${process.pid}.${Date.now()}.tmp`;
    await fsp.writeFile(temporaryPath, JSON.stringify(report, null, 2), 'utf8');
    await fsp.rename(temporaryPath, this.cudaSceneConformanceReportPath);
    this.applyDesktopCudaConformanceReport(report, { cached: false });
    this.emitState();
    return report;
  }

  async refreshAccelerationDiagnostics() {
    const isJetson = process.platform === 'linux' && process.arch === 'arm64';
    const renderer = this.ffmpegCapabilities?.sceneGpuRenderer || {};
    const availableElements = new Set(renderer.gstreamerElements || []);
    const jetsonRuntime = isJetson
      ? await detectJetsonRuntimeIdentity({
          elements: {
            nvv4l2decoder: availableElements.has('nvv4l2decoder'),
            nvv4l2h264enc: availableElements.has('nvv4l2h264enc'),
            nvv4l2h265enc: availableElements.has('nvv4l2h265enc'),
            nvvidconv: availableElements.has('nvvidconv') || availableElements.has('nvvideoconvert'),
            nvivafilter: availableElements.has('nvivafilter')
          }
        })
      : {};
    this.diagnostics.acceleration = buildAccelerationDiagnostics({
      appVersion: APP_VERSION,
      platform: process.platform,
      arch: process.arch,
      ffmpegCapabilities: this.ffmpegCapabilities,
      jetsonRuntime
    });
    return this.diagnostics.acceleration;
  }

  async loadLastExportDiagnostic() {
    try {
      this.diagnostics.lastExportFailure = sanitizeDiagnosticReport(
        JSON.parse(await fsp.readFile(this.lastExportDiagnosticPath, 'utf8'))
      );
    } catch {
      this.diagnostics.lastExportFailure = null;
    }
  }

  async persistExportDiagnosticFailure(context, error) {
    const report = buildExportDiagnosticReport({
      appVersion: APP_VERSION,
      platform: process.platform,
      arch: process.arch,
      ...context
    }, error);
    await fsp.mkdir(path.dirname(this.lastExportDiagnosticPath), { recursive: true });
    const temporaryPath = `${this.lastExportDiagnosticPath}.${process.pid}.${Date.now()}.tmp`;
    await fsp.writeFile(temporaryPath, JSON.stringify(report, null, 2), 'utf8');
    await fsp.rename(temporaryPath, this.lastExportDiagnosticPath);
    this.diagnostics.lastExportFailure = report;
    return report;
  }

  startRuntimeCapabilitiesProbe() {
    if (this.runtimeCapabilitiesPromise) return this.runtimeCapabilitiesPromise;
    this.runtimeCapabilitiesPromise = this.initializeRuntimeCapabilities().catch((error) => {
      this.log('warn', `后台能力探测失败，将使用软件兼容路径：${error.message}`);
      this.emitState();
      return this.ffmpegCapabilities;
    });
    return this.runtimeCapabilitiesPromise;
  }

  async waitForRuntimeCapabilities() {
    if (this.runtimeCapabilitiesPromise) {
      await this.runtimeCapabilitiesPromise;
    }
    return this.ffmpegCapabilities;
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

  async saveStore(options = {}) {
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
      settings: options.settings ?? this.settings,
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
        cleanupId: cleanup.cleanupId,
        preserveSourceInputs: true
      });
    }
    await this.saveStore();
  }

  async cleanupPendingSegmentCleanupsForRoom(room) {
    const roomId = String(room?.id || '');
    if (!roomId || this.isRoomBurning(room)) return;
    const pendingCleanups = Array.from(this.pendingSegmentCleanups.values()).filter(
      (cleanup) => String(cleanup.roomId) === roomId
    );
    for (const pendingCleanup of pendingCleanups) {
      if (this.isRoomBurning(room)) break;
      try {
        await this.cleanupMergedSegmentFiles(room, pendingCleanup.segments, pendingCleanup.mergedRecording, {
          cleanupId: pendingCleanup.cleanupId,
          preserveSourceInputs: true
        });
      } catch (error) {
        this.log('warn', `${roomLabel(room)} 清理合并前小分段失败：${error.message}`);
      }
    }
  }

  async deleteBurnSourceAfterSuccess(room, recording, burnedPath) {
    // Kept as a compatibility no-op for legacy queue items. Raw clean media,
    // JSONL and avatar snapshots are source inputs and must never be deleted
    // as a side effect of a derived export.
    void recording;
    void burnedPath;
    this.log('info', roomLabel(room) + ' 已保留 clean 视频、JSONL 与头像源资源。');
    return { deleted: false, retained: true };
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
    return this.settingsService.normalizeSettings(settings);
  }

  resolveSceneGraphStylePreset(value) {
    const requested = String(value || '').trim();
    if (SCENE_STYLE_PRESETS.includes(requested)) return requested;
    const configured = String(this.settings.sceneGraphDefaultStyle || '').trim();
  return SCENE_STYLE_PRESETS.includes(configured) ? configured : 'current';
  }

  getAvailableBurnCodecs() {
    return (this.ffmpegCapabilities?.burnCodecs || []).map((codec) => codec.value).filter(Boolean);
  }

  chooseBurnCodec(value) {
    const rawCodec = String(value || '').trim();
    const burnCodec = normalizeBurnCodec(rawCodec);
    const availableBurnCodecs = this.getAvailableBurnCodecs();
    const availableSet = new Set(availableBurnCodecs);
    if (burnCodec && availableSet.has(burnCodec)) return burnCodec;
    // An empty selection may choose only from the already-probed set. A
    // stale/manual selection is never silently replaced by a fallback codec.
    if (!rawCodec) return this.getPreferredHardwareBurnCodec() || availableBurnCodecs[0] || '';
    return '';
  }

  requireAvailableBurnCodec(codec, action = '烧录') {
    const value = String(codec || '').trim();
    if (this.getAvailableBurnCodecs().includes(value)) return value;
    const unavailable = (this.ffmpegCapabilities?.unavailableBurnCodecs || []).find((item) => item.value === value);
    const detail = unavailable?.reason ? `：${unavailable.reason}` : '';
    throw businessError(
      'BURN_CODEC_UNAVAILABLE',
      `${action}没有可用的、已通过能力探测的编码器${value ? `（${value}）` : ''}${detail}。请在维护页完成探测后选择可用编码器。`,
      409
    );
  }

  getPreferredHardwareBurnCodec() {
    const available = new Set(this.getAvailableBurnCodecs());
    return [
      'hevc_nvenc',
      'h264_nvenc',
      'hevc_nvv4l2',
      'h264_nvv4l2',
      'hevc_v4l2m2m',
      'h264_v4l2m2m',
      'hevc_qsv',
      'h264_qsv',
      'hevc_amf',
      'h264_amf'
    ].find((codec) => available.has(codec));
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

  getEncoderBackendLabel(codecInfo) {
    const codec = String(codecInfo?.value || '').trim();
    const encoderLabel = String(codecInfo?.element || '').trim();
    const converter = String(codecInfo?.converter || '').trim();
    if (codecInfo?.backend === 'gstreamer') {
      return `Jetson ${isHevcCodec(codec) ? 'H.265' : 'H.264'} 硬编（GStreamer ${encoderLabel || codec}${
        converter ? ` + ${converter}` : ''
      }）`;
    }
    if (codecInfo?.backend === 'v4l2m2m') {
      return `V4L2 M2M ${isHevcCodec(codec) ? 'H.265' : 'H.264'} 硬编（FFmpeg ${codec}）`;
    }
    if (codec.includes('nvenc')) return `NVIDIA NVENC（FFmpeg ${codec}）`;
    if (codec.includes('qsv')) return `Intel QSV（FFmpeg ${codec}）`;
    if (codec.includes('amf')) return `AMD AMF（FFmpeg ${codec}）`;
    return codecInfo?.kind === 'hardware' ? `硬件编码（FFmpeg ${codec || '未知'}）` : `软件编码（FFmpeg ${codec || '未知'}）`;
  }

  getAvatarCompositeBackendLabel(avatarLayer, avatarMode) {
    const backend = String(
      avatarLayer?.gpuCompositeBackend || (avatarLayer?.gpuComposite ? 'cuda' : '')
    ).trim().toLowerCase();
    const backendCapability = this.getAvatarCompositeCapability();
    const backendLabel =
      backendCapability?.value === backend
        ? backendCapability.label
        : backend === 'cuda'
          ? 'NVIDIA CUDA 真实头像合成'
          : backend === 'vaapi'
            ? 'VA-API 透明图层最终合成'
            : backend === 'vulkan'
              ? 'Vulkan 透明图层最终合成'
              : backend === 'opencl'
                ? 'OpenCL 透明图层最终合成'
                : '';
    const panelFps = Math.max(0, Math.round(Number(avatarLayer?.compositeFps) || 0));
    if (avatarLayer?.gpuComposite) {
      if (backend === 'cuda') {
        return avatarLayer.gpuOutputToCpu ? 'CUDA 头像合成（回传 CPU 编码链路）' : 'CUDA 头像合成';
      }
      return `${backendLabel || 'GPU 透明图层最终合成'}（头像面板 CPU ${panelFps || 30} fps）`;
    }
    if (avatarLayer?.chunked && backend) {
      if (backend === 'cuda') {
        return avatarLayer.gpuOutputToCpu ? 'CUDA/CPU 分段头像合成（回传 CPU 编码链路）' : 'CUDA/CPU 分段头像合成';
      }
      return `${backendLabel || 'GPU'}/CPU 分段头像合成（头像面板 ${panelFps || 30} fps）`;
    }
    if (Array.isArray(avatarLayer?.entries) && avatarLayer.entries.length) {
      return panelFps ? `CPU 头像合成（小面板 ${panelFps} fps）` : 'CPU 头像合成';
    }
    return avatarMode === 'off' ? '真实头像关闭' : '通用头像';
  }

  setProgressFallback(progress, reason, options = {}) {
    if (!progress) return;
    progress.fallbackReason = String(reason || '').trim() || undefined;
    if (options.avatarCompositeBackend) progress.avatarCompositeBackend = options.avatarCompositeBackend;
    if (options.reset) {
      const now = Date.now();
      progress.workStartedAt = now;
      setFfmpegJobPhase(progress, 'render', { now });
      progress.currentTimeSec = 0;
      progress.percent = Number(progress.durationSec || 0) > 0 ? 0 : null;
      progress.estimatedRemainingSec = null;
      resetFfmpegJobProgressRate(progress, 'render');
    }
    if (options.message) progress.message = options.message;
    progress.updatedAt = Date.now();
  }

  getPreviewCodec() {
    const available = new Set(this.getAvailableBurnCodecs());
    // The Jetson GStreamer bridge is used for burn/export jobs, where it can
    // preserve the source-size render graph.  The lightweight HLS preview
    // remains an FFmpeg pipeline, so do not hand it an encoder name that
    // belongs exclusively to gst-launch.
    return ['h264_nvenc', 'h264_v4l2m2m', 'h264_qsv', 'h264_amf', 'libx264'].find((codec) => available.has(codec)) || '';
  }

  getHardwareDecoder(videoInfo, encoderCodec = '') {
    const sourceCodec = isHevcCodec(videoInfo?.codec)
      ? 'hevc'
      : /(?:^|[^a-z])(?:h264|avc)(?:[^a-z]|$)/i.test(String(videoInfo?.codec || ''))
        ? 'h264'
        : '';
    const software = { value: 'software', label: 'CPU', kind: 'software', codec: sourceCodec };
    if (!sourceCodec) return software;
    const available = (this.ffmpegCapabilities?.hardwareDecoders || []).filter(
      (decoder) => decoder.codec === sourceCodec
    );
    if (!available.length) return software;
    const codec = String(encoderCodec || '');
    const preference = codec.includes('nvv4l2')
      ? [
          'gstreamer-nvv4l2',
          'cuda',
          'qsv',
          'vaapi',
          'd3d11va',
          'dxva2'
        ]
      : codec.includes('nvenc')
      ? ['cuda', 'd3d11va', 'dxva2', 'qsv', 'vaapi']
      : codec.includes('qsv')
        ? ['qsv', 'd3d11va', 'dxva2', 'vaapi', 'cuda']
        : codec.includes('amf')
          ? ['d3d11va', 'dxva2', 'vaapi', 'cuda', 'qsv']
          : [
              'cuda',
              'qsv',
              'vaapi',
              'd3d11va',
              'dxva2',
              sourceCodec === 'hevc' ? 'hevc_nvv4l2dec' : 'h264_nvv4l2dec',
              sourceCodec === 'hevc' ? 'hevc_v4l2m2m' : 'h264_v4l2m2m'
            ];
    const selected = preference.map((value) => available.find((decoder) => decoder.value === value)).find(Boolean);
    return selected ? { ...selected, kind: 'hardware' } : software;
  }

  getRecordingMediaResourcePlan() {
    return {
      resources: ['recording', 'network', 'diskWrite'],
      resourceCosts: { diskWrite: 1 }
    };
  }

  getTranscodeResourcePlan(codec, videoInfo, options = {}) {
    const encoder = String(codec || '').trim();
    const hardwareEncoder = Boolean(encoder) && !encoder.includes('libx');
    const lightweight = Boolean(options.lightweight);
    const resources = ['diskRead', 'diskWrite', hardwareEncoder ? 'gpuEncode' : 'cpuEncode'];
    // Burn-in/compositing is deliberately a separate GPU budget.  It remains
    // paused while a copy recording is active; a plain GPU transcode can run.
    if (options.gpuComposite) {
      resources.push('gpuComposite');
    }
    return {
      resources,
      resourceCosts: {
        diskRead: lightweight ? 1 : 2,
        diskWrite: lightweight ? 1 : 2
      }
    };
  }

  getTranscodeResources(codec, videoInfo, options = {}) {
    return this.getTranscodeResourcePlan(codec, videoInfo, options).resources;
  }

  setProgressDecoder(progress, decoder, options = {}) {
    if (!progress || !decoder) return;
    progress.decoder = decoder.value;
    progress.decoderKind = decoder.kind;
    progress.decoderLabel = decoder.label;
    if (options.reset) {
      progress.workStartedAt = Date.now();
      progress.currentTimeSec = 0;
      progress.percent = Number(progress.durationSec || 0) > 0 ? 0 : null;
      progress.estimatedRemainingSec = null;
      resetFfmpegJobProgressRate(progress);
      if (options.message) progress.message = options.message;
    }
    progress.updatedAt = Date.now();
  }

  setProgressPipeline(progress, pipeline = {}) {
    if (!progress) return;
    const decoder = pipeline.decoder && typeof pipeline.decoder === 'object' ? pipeline.decoder : null;
    const activePipeline = {
      decoder: String(decoder?.label || pipeline.decoder || '').trim(),
      sceneRenderer: String(pipeline.sceneRenderer || '').trim(),
      encoder: String(pipeline.encoder || '').trim()
    };
    if (!activePipeline.decoder || !activePipeline.sceneRenderer || !activePipeline.encoder) return;
    progress.activePipeline = activePipeline;
    this.setProgressDecoder(progress, decoder || { value: 'software', label: activePipeline.decoder, kind: 'software' });
    // Keep legacy fields in sync; the UI prioritizes activePipeline.
    progress.avatarCompositeBackend = activePipeline.sceneRenderer;
    progress.encoderBackend = activePipeline.encoder;
    progress.updatedAt = Date.now();
  }

  shouldUseCudaAvatarComposite(_codec, avatarPlan) {
    const entryCount = Array.isArray(avatarPlan?.entries) ? avatarPlan.entries.length : 0;
    return Boolean(
      entryCount > 0 &&
        entryCount <= MAX_CUDA_AVATAR_OVERLAY_ENTRIES &&
        this.getAvatarCompositeCapability()?.value === 'cuda'
    );
  }

  logCudaSceneAdmission(admission, renderer) {
    const runtime = renderer || null;
    const status = [
      `runtime available=${runtime?.available === true ? 'true' : 'false'}`,
      `backend=${String(runtime?.backend || '-')}`,
      `reason=${String(admission?.reason || runtime?.reason || '-')}`,
      `nativeNvmmScene=${runtime?.nativeNvmmScene === true ? 'true' : 'false'}`,
      `nativeNvmmReason=${String(runtime?.nativeNvmmReason || '-')}`
    ].join(' ');
    this.log(admission?.ok ? 'info' : 'warn', `CUDA Scene准入${admission?.ok ? '通过' : '失败'}：${status}`);
  }

  async probeGpuSceneRenderer() {
    const visualConformance = await this.readCudaSceneConformanceReport();
    const helper = resolveGpuSceneRenderer();
    if (!helper) {
      return {
        available: false,
        reason: '未安装 Jetson GPU Scene helper。',
        visualConformance
      };
    }
    const result = await runCapturedProcess(helper, createGpuSceneProbeArgs(), {
      timeoutMs: 12_000,
      maxOutputBytes: 32 * 1024
    });
    if (result.status !== 0 || result.error || result.timedOut) {
      return {
        available: false,
        helper,
        visualConformance,
        reason: result.timedOut
          ? 'GPU Scene helper probe 超时。'
          : compactLogLine(result.stderr || result.stdout || result.error?.message || 'GPU Scene helper probe 失败。')
      };
    }
    const probe = parseGpuSceneRendererProbe(result.stdout || result.stderr);
    if (!probe.ok) {
      return {
        available: false,
        helper,
        reason: probe.reason,
        visualConformance
      };
    }
    const required = probe.backend === 'gl-gstreamer'
      ? JETSON_GL_REQUIRED_ELEMENTS
      : probe.backend === 'cuda-gstreamer'
        ? JETSON_CUDA_NVMM_REQUIRED_ELEMENTS
        : [];
    const available = new Set(probe.gstreamerElements || []);
    const missing = required.filter((element) => !available.has(element));
    if (missing.length) {
      return {
        available: false,
        helper,
        reason: 'GPU Scene helper 缺少 GStreamer 元件：' + missing.join('、') + '。',
        visualConformance
      };
    }
    const capability = Object.assign({ available: true, helper, visualConformance }, probe);
    // Element discovery only proves that GStreamer can construct the bins.
    // Exercise both real Jetson decoder paths before allowing the fully NVMM
    // route; the I420 CUDA bridge remains a valid fallback when this fails.
    if (!capability.nativeNvmmScene || capability.backend !== 'cuda-gstreamer') return capability;
    const nativeTest = await runCapturedProcess(helper, ['--native-nvmm-self-test'], {
      timeoutMs: 30_000,
      maxOutputBytes: 64 * 1024
    });
    let nativeReport = null;
    for (const line of String(nativeTest.stdout || '').trim().split(/\r?\n/).reverse()) {
      try {
        const parsed = JSON.parse(line);
        if (parsed?.nativeNvmmMetrics || parsed?.nativeNvmmFailures) {
          nativeReport = parsed;
          break;
        }
      } catch {
        // Native GStreamer may log non-JSON lines before its final report.
      }
    }
    if (nativeTest.status === 0 && !nativeTest.error && !nativeTest.timedOut && nativeReport?.ok === true && nativeReport.nativeNvmmMetrics) {
      return { ...capability, nativeNvmmSelfTest: nativeReport };
    }
    const nativeFailureSummary = nativeReport?.nativeNvmmFailures && typeof nativeReport.nativeNvmmFailures === 'object'
      ? Object.entries(nativeReport.nativeNvmmFailures)
        .map(([codec, reason]) => `${String(codec).toUpperCase()}：${compactLogLine(reason)}`)
        .join('；')
      : '';
    return {
      ...capability,
      nativeNvmmScene: false,
      nativeNvmmReason: nativeTest.timedOut
        ? '原生 NVMM 双编码自检超时。'
        : nativeFailureSummary || compactLogLine(nativeTest.stderr || nativeTest.stdout || nativeTest.error?.message || '原生 NVMM 双编码自检失败。')
    };
  }

  async readCudaSceneConformanceReport() {
    try {
      const report = JSON.parse(await fsp.readFile(this.cudaSceneConformanceReportPath, 'utf8'));
      if (!report || typeof report !== 'object') throw new Error('报告不是 JSON 对象。');
      return report;
    } catch (error) {
      const reason = error?.code === 'ENOENT'
        ? '尚未执行 CUDA Scene 像素一致性自检。'
        : `CUDA Scene 像素一致性报告不可读取：${compactLogLine(error.message || error)}`;
      return createCudaSceneConformanceUnavailable(reason);
    }
  }

  getAvatarCompositeCapability() {
    const capability = this.ffmpegCapabilities?.avatarComposite;
    if (capability?.value && ['cuda', 'vaapi', 'vulkan', 'opencl'].includes(capability.value)) {
      return capability;
    }
    // 0.6.6 and older persisted only this boolean. Preserve the usable CUDA
    // route when an application process is upgraded without a restart.
    if (this.ffmpegCapabilities?.cudaAvatarComposite) {
      return { value: 'cuda', label: 'NVIDIA CUDA 真实头像合成', mode: 'full' };
    }
    return null;
  }

  selectAvatarCompositeBackend(avatarPlan) {
    const entryCount = Array.isArray(avatarPlan?.entries) ? avatarPlan.entries.length : 0;
    const capability = this.getAvatarCompositeCapability();
    if (!capability || entryCount <= 0) return null;
    // Full CUDA keeps every portrait as a GPU surface. Let the existing
    // bounded chunk path handle dense timelines rather than risking VRAM.
    if (capability.value === 'cuda' && entryCount > MAX_CUDA_AVATAR_OVERLAY_ENTRIES) return null;
    return capability;
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
      recordingState: undefined,
      currentRecording: undefined
    };
  }

  normalizeRecording(recording) {
    const cleanPath = String(recording?.cleanPath || '').trim();
    if (!cleanPath) {
      return null;
    }
    const timelineHealth =
      typeof recording.timelineHealth === 'string'
        ? { timelineHealth: recording.timelineHealth, warnings: [] }
        : recording.timelineHealth || recording.timelineDetails || null;
    return {
      id: String(recording.id || cleanPath),
      roomId: recording.roomId ? String(recording.roomId) : '',
      roomTitle: String(recording.roomTitle || ''),
      anchor: String(recording.anchor || ''),
      liveSessionId: String(recording.liveSessionId || ''),
      startedAt: Number(recording.startedAt || Date.now()),
      cleanPath,
      danmakuPath: String(recording.danmakuPath || deriveSiblingPath(cleanPath, 'danmaku', 'jsonl')),
      avatarManifestPath: String(recording.avatarManifestPath || deriveAvatarManifestPath(cleanPath)),
      sceneCachePath: String(recording.sceneCachePath || deriveSceneCachePath(cleanPath)),
      scenePath: String(recording.scenePath || deriveSceneGraphPath(cleanPath)),
      sceneStatus: String(recording.sceneStatus || ''),
      cssPath: String(recording.cssPath || deriveSiblingPath(cleanPath, 'danmaku', 'css')),
      assPath: String(recording.assPath || deriveSiblingPath(cleanPath, 'danmaku', 'ass')),
      burnedPath: String(recording.burnedPath || deriveBurnedPath(cleanPath, 'danmaku-gift')),
      capturePath: String(recording.capturePath || ''),
      containerStage: normalizeContainerStage(recording.containerStage),
      validReason: String(recording.validReason || ''),
      mergeGroup: String(recording.mergeGroup || ''),
      mergeSequence: Number(recording.mergeSequence || 0),
      mergeOutputPath: String(recording.mergeOutputPath || ''),
      segmentTargetDurationSec: Number(
        recording.segmentTargetDurationSec ||
          recording.streamMetadata?.configuredSegmentDurationSec ||
          recording.streamMetadata?.segmentTargetDurationSec ||
          0
      ),
      segmentReason: String(recording.segmentReason || 'initial'),
      diagnosticsPath: String(recording.diagnosticsPath || ''),
      mergedFrom: Array.isArray(recording.mergedFrom) ? recording.mergedFrom.map(String) : undefined,
      cleanupId: String(recording.cleanupId || ''),
      durationSec: Number(recording.durationSec || 0),
      fileSize: Number(recording.fileSize || 0),
      valid: recording.valid !== false,
      eventCount: Number(recording.eventCount || 0),
      sceneEventCount: Number(recording.sceneEventCount || 0),
      rawDanmakuCount: Number(recording.rawDanmakuCount || 0),
      capturedDanmakuCount: Number(recording.capturedDanmakuCount ?? recording.eventCount ?? 0),
      ignoredDanmakuCount: Number(recording.ignoredDanmakuCount || 0),
      danmakuCommandCounts: normalizeCommandCounts(recording.danmakuCommandCounts),
      danmakuDropCounts: normalizeCommandCounts(recording.danmakuDropCounts),
      danmakuStatus: recording.danmakuStatus,
      danmakuMessage: recording.danmakuMessage,
      danmakuPopularity: Number(recording.danmakuPopularity || 0),
      videoInfo: recording.videoInfo || null,
      timingInfo: recording.timingInfo || null,
      timelineHealth,
      timelineHealthStatus: String(timelineHealth?.timelineHealth || recording.timelineHealthStatus || ''),
      streamMetadata: recording.streamMetadata || null,
      recordingState: String(recording.recordingState || ''),
      recovery: recording.recovery || null
    };
  }

  // The export page intentionally submits a compact request (paths plus
  // options), while the recording library owns the expensive packet audit.
  // Reattach those canonical timing fields before queueing so a browser cannot
  // accidentally turn a known source A/V boundary offset into an uncorrected
  // burn job.
  hydrateRecordingFromLibrary(recording) {
    if (!recording?.cleanPath) return recording;
    const targetPath = path.resolve(recording.cleanPath).toLowerCase();
    const saved = this.recordings.find((candidate) => {
      try {
        return candidate?.cleanPath && path.resolve(candidate.cleanPath).toLowerCase() === targetPath;
      } catch {
        return false;
      }
    });
    if (!saved) return recording;
    return {
      ...recording,
      durationSec: Number(recording.durationSec || 0) > 0 ? recording.durationSec : Number(saved.durationSec || 0),
      fileSize: Number(recording.fileSize || 0) > 0 ? recording.fileSize : Number(saved.fileSize || 0),
      valid: saved.valid === false ? false : recording.valid,
      validReason: recording.validReason || saved.validReason || '',
      videoInfo: recording.videoInfo || saved.videoInfo || null,
      avatarManifestPath: recording.avatarManifestPath || saved.avatarManifestPath || '',
      sceneCachePath: recording.sceneCachePath || saved.sceneCachePath || '',
      scenePath: recording.scenePath || saved.scenePath || '',
      sceneStatus: recording.sceneStatus || saved.sceneStatus || '',
      sceneEventCount: Number(recording.sceneEventCount || saved.sceneEventCount || 0),
      timingInfo: recording.timingInfo || saved.timingInfo || null,
      timelineHealth: recording.timelineHealth || saved.timelineHealth || null,
      timelineHealthStatus: recording.timelineHealthStatus || saved.timelineHealthStatus || '',
      streamMetadata: recording.streamMetadata || saved.streamMetadata || null
    };
  }

  // A clip can be opened directly from disk instead of from the in-memory
  // recording library.  Its sidecar is still the authoritative record of an
  // HLS reconnect boundary (notably audio at 0 with video beginning at
  // 1.019s).  Without it a burn loses the physical black lead-in and audio
  // gets progressively early after chunk concatenation.
  async hydrateRecordingTimingFromSidecar(recording) {
    const cleanPath = String(recording?.cleanPath || '').trim();
    if (!cleanPath) return recording;
    const initialPts = (field) => {
      for (const candidate of [recording?.timelineHealth, recording?.timingInfo, recording?.streamMetadata]) {
        const value = finiteTimelineValue(candidate?.[field]);
        if (value !== null) return value;
      }
      return null;
    };
    const needsTimeline = initialPts('firstVideoPts') === null || initialPts('firstAudioPts') === null;
    if (!needsTimeline) return recording;
    try {
      const raw = await fsp.readFile(`${cleanPath}.metadata.json`, 'utf8');
      const metadata = JSON.parse(raw);
      if (!metadata || typeof metadata !== 'object') return recording;
      return {
        ...recording,
        // Sidecar data belongs to this exact media file, so its packet-boundary
        // fields take precedence over an older in-memory library entry.
        timingInfo: { ...(recording.timingInfo || {}), ...(metadata.timingInfo || {}) },
        timelineHealth: metadata.timelineHealth || metadata.timelineDetails || recording.timelineHealth || null,
        timelineHealthStatus: metadata.timelineHealthStatus || recording.timelineHealthStatus || '',
        streamMetadata: { ...(recording.streamMetadata || {}), ...(metadata.streamMetadata || {}) }
      };
    } catch {
      return recording;
    }
  }

  getSegmentDurationSec(minutes = this.settings.segmentMinutes) {
    const value = Number(minutes || 0);
    return Number.isFinite(value) && value > 0 ? value * 60 : 0;
  }

  getRecordingSegmentTargetDurationSec(recording) {
    const candidates = [
      recording?.segmentTargetDurationSec,
      recording?.streamMetadata?.configuredSegmentDurationSec,
      recording?.streamMetadata?.segmentTargetDurationSec
    ];
    for (const value of candidates) {
      const duration = Number(value || 0);
      if (Number.isFinite(duration) && duration > 0) return duration;
    }
    // Older sidecars did not persist the configured target. Fall back to the
    // current setting so existing one-hour segments immediately become hard
    // boundaries after upgrading.
    return this.getSegmentDurationSec();
  }

  isRecordingAtSegmentBoundary(recording) {
    const targetDurationSec = this.getRecordingSegmentTargetDurationSec(recording);
    const recordedDurationSec = Math.max(
      0,
      Number(getSegmentDurationForMerge(recording) || recording?.durationSec || 0)
    );
    if (!targetDurationSec || !recordedDurationSec) return false;
    // A graceful rotate can land a few seconds before the nominal limit.
    // Do not merge it merely because FFmpeg closed on the keyframe just ahead
    // of the exact 60-minute timestamp.
    const toleranceSec = Math.max(2, Math.min(10, targetDurationSec * 0.01));
    return recordedDurationSec >= targetDurationSec - toleranceSec;
  }

  getPartialReconnectClusters(segments) {
    const clusters = [];
    let current = [];
    for (const segment of segments || []) {
      if (this.isRecordingAtSegmentBoundary(segment)) {
        if (current.length) clusters.push(current);
        current = [];
        continue;
      }
      current.push(segment);
    }
    if (current.length) clusters.push(current);
    return clusters.filter((cluster) => cluster.length >= 2);
  }

  selectPartialReconnectCluster(segments, fallbackRecording) {
    const clusters = this.getPartialReconnectClusters(segments);
    if (!clusters.length) return [];
    const fallbackPath = String(fallbackRecording?.cleanPath || '');
    if (fallbackPath) {
      const matching = clusters.find((cluster) => cluster.some((segment) => segment.cleanPath === fallbackPath));
      return matching || [];
    }
    return clusters.at(-1) || [];
  }

  getReconnectMergeOutputPath(allSegments, mergeSegments) {
    const first = mergeSegments?.[0];
    if (!first) return '';
    // A group may contain multiple reconnect clusters separated by ordinary
    // completed segments. Only the first cluster owns the legacy group output;
    // later clusters receive an output next to their own first source.
    if (first === allSegments?.[0]) {
      return first.mergeOutputPath || deriveSiblingPath(first.cleanPath, 'merged');
    }
    return deriveSiblingPath(first.cleanPath, 'merged');
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

  getPublicSettings(options = {}) {
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
    return settings;
  }

  getPublicAccessState(options = {}) {
    return {
      required: options.accessRequired ?? isPublicServerHost(this.currentHost || this.settings.serverHost),
      configured: this.accessAuth.isConfigured(this.settings),
      authenticated: Boolean(options.accessAuthenticated),
      username: this.settings.accessUsername
    };
  }

  getState(options = {}) {
    const settings = this.getPublicSettings(options);
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
      hardwareSelfTest: { ...this.hardwareSelfTest },
      exportProgress: this.exportProgress ? { ...this.exportProgress } : null,
      exportQueue: this.exportQueue.map((item) => this.getPublicExportQueueItem(item)),
      burnQueue: this.burnQueue.map((item) => this.getPublicBurnQueueItem(item)),
      previewProgress: this.exportPreviewProgress ? { ...this.exportPreviewProgress } : null,
      previewProxy: this.exportPreview ? { ...this.exportPreview } : null,
      mediaJobs: this.mediaJobs.snapshot(),
      startupEnabled: this.startupEnabled,
      outputDiskSpace: this.outputDiskSpace ? { ...this.outputDiskSpace } : null,
      access: this.getPublicAccessState(options),
      currentPort: this.currentPort || DEFAULT_PORT,
      currentHost: this.currentHost || DEFAULT_HOST,
      platform: UI_PLATFORM,
      uiCapabilities: createUiCapabilities(UI_PLATFORM, process.env, options),
      diagnostics: this.diagnostics,
      accelerationDiagnostics: this.diagnostics.acceleration,
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
      liveSessionId: session.liveSessionId,
      cleanPath: session.cleanPath,
      danmakuPath: session.danmakuPath,
      avatarManifestPath: session.avatarManifestPath,
      sceneCachePath: session.sceneCachePath,
      scenePath: session.scenePath,
      sceneStatus: session.sceneStatus || '',
      cssPath: session.cssPath,
      assPath: session.assPath,
      burnedPath: session.burnedPath,
      capturePath: session.capturePath,
      containerStage: session.containerStage || 'capturing',
      validReason: session.validReason || '',
      mergeGroup: session.mergeGroup,
      mergeSequence: session.mergeSequence,
      mergeOutputPath: session.mergeOutputPath,
      segmentTargetDurationSec: Number(session.segmentDurationSec || 0),
      segmentReason: session.segmentReason || 'initial',
      diagnosticsPath: session.diagnosticsPath || '',
      recordingState: session.state || 'connecting',
      durationSec: this.getSessionMediaDurationSec(session),
      eventCount: Number(session.eventCount || 0),
      sceneEventCount: Number(session.sceneEventCount || 0),
      rawDanmakuCount: Number(session.rawDanmakuCount || 0),
      capturedDanmakuCount: Number(session.capturedDanmakuCount ?? session.eventCount ?? 0),
      ignoredDanmakuCount: Number(session.ignoredCommandCount || 0),
      danmakuCommandCounts: { ...(session.danmakuCommandCounts || {}) },
      danmakuDropCounts: { ...(session.danmakuDropCounts || {}) },
      danmakuStatus: session.danmakuStatus,
      danmakuMessage: session.danmakuMessage,
      danmakuPopularity: Number(session.danmakuPopularity || 0),
      videoInfo: session.videoInfo || null,
      streamMetadata: session.streamMetadata ? { ...session.streamMetadata } : null
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
    return Boolean(
      room?.id &&
        (this.recordingStartLocks.has(room.id) ||
          this.reconnectPendingRooms.has(room.id) ||
          this.streamStartRetryRooms.has(room.id))
    );
  }

  isRoomBurning(room) {
    return Boolean(room?.burning || (room?.id && this.burnSessions.has(room.id)));
  }

  getRoomRelatedMediaPaths(room) {
    const roomId = String(room?.id || '');
    const paths = new Set();
    const addRecordingPaths = (recording) => {
      if (!recording) return;
      for (const candidate of [recording.cleanPath, recording.capturePath, recording.burnedPath]) {
        if (candidate) paths.add(path.resolve(String(candidate)).toLowerCase());
      }
    };
    addRecordingPaths(room?.currentRecording);
    for (const recording of this.recordings) {
      if (String(recording?.roomId || '') === roomId) {
        addRecordingPaths(recording);
      }
    }
    return paths;
  }

  isRoomRelatedMediaPath(room, candidate) {
    if (!candidate) return false;
    return this.getRoomRelatedMediaPaths(room).has(path.resolve(String(candidate)).toLowerCase());
  }

  isRoomRelatedExportItem(room, item) {
    const roomId = String(room?.id || '');
    const request = item?.request || {};
    if (
      String(item?.roomId || '') === roomId ||
      String(request.roomId || '') === roomId ||
      String(request.recording?.roomId || '') === roomId
    ) {
      return true;
    }
    return this.isRoomRelatedMediaPath(room, item?.cleanPath || request.cleanPath || request.recording?.cleanPath);
  }

  isRoomRelatedPreview(room) {
    if (!this.exportPreviewProgress || !['queued', 'running'].includes(this.exportPreviewProgress.status)) {
      return false;
    }
    return this.isRoomRelatedMediaPath(room, this.exportPreview?.sourcePath || this.exportPreviewProgress.outputPath);
  }

  getRoomActiveTaskKinds(room) {
    const roomId = String(room?.id || '');
    const tasks = [];
    const mergeActive =
      this.mergeProcesses.has(roomId) ||
      [...this.mergeInFlightGroups.keys()].some((key) => key.startsWith(`${roomId}\u0000`)) ||
      this.mergeRetryStates.size > 0 && [...this.mergeRetryStates.keys()].some((key) => key.startsWith(`${roomId}\u0000`)) ||
      ['queued', 'running', 'retrying'].includes(room?.mergeProgress?.status);
    const burnQueued =
      this.burnQueue.some((item) => String(item?.roomId || '') === roomId) ||
      (this.activeBurnQueueItem && String(this.activeBurnQueueItem.roomId || '') === roomId);
    const exportQueued =
      this.exportQueue.some((item) => this.isRoomRelatedExportItem(room, item)) ||
      this.isRoomRelatedExportItem(room, this.activeExportQueueItem) ||
      (String(this.exportProgress?.roomId || '') === roomId && ['queued', 'running'].includes(this.exportProgress?.status));
    if (this.isRoomRecording(room)) tasks.push('录制');
    if (mergeActive) tasks.push('合并');
    if (this.isRoomBurning(room) || burnQueued) tasks.push('烧录');
    if (exportQueued) tasks.push('导出');
    if (this.isRoomRelatedPreview(room)) tasks.push('兼容预览');
    return tasks;
  }

  async cancelRoomBurnTasks(room) {
    const roomId = String(room.id);
    const cancelledItems = this.burnQueue.filter((item) => String(item?.roomId || '') === roomId);
    for (const item of cancelledItems) {
      this.burnCancelRequests.add(roomId);
      this.mediaJobs.cancel(item.id);
    }
    if (cancelledItems.length) {
      this.burnQueue = this.burnQueue.filter((item) => String(item?.roomId || '') !== roomId);
    }
    if (this.activeBurnQueueItem && String(this.activeBurnQueueItem.roomId || '') === roomId) {
      this.burnCancelRequests.add(roomId);
      this.mediaJobs.cancel(this.activeBurnQueueItem.id);
    }
    if (this.isRoomBurning(room)) {
      await this.cancelBurnDanmaku(roomId);
    }
  }

  async cancelRoomExportTasks(room) {
    const relatedItems = this.exportQueue.filter((item) => this.isRoomRelatedExportItem(room, item));
    for (const item of relatedItems) {
      this.cancelledExportQueueIds.add(item.id);
      this.mediaJobs.cancel(item.id);
    }
    if (relatedItems.length) {
      this.exportQueue = this.exportQueue.filter((item) => !this.isRoomRelatedExportItem(room, item));
    }
    if (this.isRoomRelatedExportItem(room, this.activeExportQueueItem)) {
      this.cancelledExportQueueIds.add(this.activeExportQueueItem.id);
      this.mediaJobs.cancel(this.activeExportQueueItem.id);
      await this.cancelExportClip();
    } else if (String(this.exportProgress?.roomId || '') === String(room.id)) {
      await this.cancelExportClip();
    }
  }

  async waitForRoomTasksReleased(room, timeoutMs = 90_000) {
    const deadline = Date.now() + Math.max(1_000, Number(timeoutMs) || 90_000);
    let activeTasks = this.getRoomActiveTaskKinds(room);
    while (activeTasks.length && Date.now() < deadline) {
      await delay(100);
      activeTasks = this.getRoomActiveTaskKinds(room);
    }
    if (activeTasks.length) {
      throw businessError(
        'ROOM_TASK_CANCEL_TIMEOUT',
        `${roomLabel(room)} 的${activeTasks.join('、')}任务仍在释放资源，请稍后再次确认强制删除。`,
        409
      );
    }
  }

  getPublicUpdateState() {
    return this.updateService.getPublicUpdateState();
  }

  usesMsixAppInstallerUpdate() {
    return this.updateService.usesMsixAppInstallerUpdate();
  }

  createMsixUpdateMessage(version = this.updateState.latestVersion) {
    return this.updateService.createMsixUpdateMessage(version);
  }

  async deferMsixUpdateToAppInstaller() {
    return this.updateService.deferMsixUpdateToAppInstaller();
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
    this.statePublisher.addClient(response, options);
  }

  invalidateRemoteSseClients() {
    return this.statePublisher.invalidateAccessClients({
      code: 'ACCESS_AUTH_INVALIDATED',
      message: '远程访问凭据已更新，请重新登录。'
    });
  }

  emitState(types) {
    if (types === undefined || types === null) {
      this.statePublisher.markAllDirty();
    } else {
      this.statePublisher.markDirty(types);
    }
  }

  markRoomDirty(roomId) {
    this.statePublisher.markRoomDirty(roomId);
  }

  markRoomDeleted(roomId) {
    this.statePublisher.markRoomDeleted(roomId);
  }

  markRecordingsDirty() {
    this.statePublisher.markDirty('recording');
  }

  markMediaJobDirty() {
    this.statePublisher.markDirty('mediaJob');
  }

  markLogsDirty() {
    this.statePublisher.markDirty('log');
  }

  markSettingsDirty() {
    this.statePublisher.markDirty('settings');
  }

  markDiskSpaceDirty() {
    this.statePublisher.markDirty('diskSpace');
  }

  markSystemDirty() {
    this.statePublisher.markDirty('system');
  }

  flushState() {
    this.statePublisher.flush();
  }

  getSseSettingsPayload(options = {}) {
    return {
      settings: this.getPublicSettings(options),
      login: this.getPublicLoginState(),
      bilibiliLoggedIn: Boolean(getCookieValue(this.settings.cookie, 'SESSDATA')),
      bilibiliCookieVisible: !options.redactCookie,
      access: this.getPublicAccessState(options),
      startupEnabled: this.startupEnabled
    };
  }

  getSseMediaJobPayload() {
    return {
      mediaJobs: this.mediaJobs.snapshot(),
      exportProgress: this.exportProgress ? { ...this.exportProgress } : null,
      exportQueue: this.exportQueue.map((item) => this.getPublicExportQueueItem(item)),
      burnQueue: this.burnQueue.map((item) => this.getPublicBurnQueueItem(item)),
      previewProgress: this.exportPreviewProgress ? { ...this.exportPreviewProgress } : null,
      previewProxy: this.exportPreview ? { ...this.exportPreview } : null
    };
  }

  getSseSystemPayload(options = {}) {
    return {
      version: APP_VERSION,
      update: this.getPublicUpdateState(),
      ffmpegPath: this.ffmpegPath,
      ffmpegCapabilities: this.ffmpegCapabilities,
      hardwareSelfTest: { ...this.hardwareSelfTest },
      currentPort: this.currentPort || DEFAULT_PORT,
      currentHost: this.currentHost || DEFAULT_HOST,
      platform: UI_PLATFORM,
      uiCapabilities: createUiCapabilities(UI_PLATFORM, process.env, options),
      storePath: this.storePath,
      appRoot: APP_ROOT,
      distRoot: DIST_ROOT
    };
  }

  getSseDeltaPayload(type, detail = {}, client = {}) {
    if (type === 'room') {
      const roomId = String(detail.roomId || '');
      if (detail.deleted) return { id: roomId, deleted: true };
      const room = this.rooms.get(roomId);
      return room ? this.getPublicRoomState(room) : { id: roomId, deleted: true };
    }
    if (type === 'recording') return { recordings: this.recordings };
    if (type === 'log') return { replace: this.logs };
    if (type === 'settings') return this.getSseSettingsPayload(client);
    if (type === 'mediaJob') return this.getSseMediaJobPayload();
    if (type === 'diskSpace') return { outputDiskSpace: this.outputDiskSpace ? { ...this.outputDiskSpace } : null };
    if (type === 'system') return this.getSseSystemPayload(client);
    return undefined;
  }

  log(level, message) {
    const entry = {
      id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
      time: Date.now(),
      level,
      message: redactSensitive(message)
    };
    this.logs.push(entry);
    if (this.logs.length > 400) {
      this.logs.splice(0, this.logs.length - 400);
    }
    this.statePublisher.markLog(entry);
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
    return this.maintenanceService.getDiskSpace(targetPath);
  }

  async refreshOutputDiskSpace() {
    return this.maintenanceService.refreshOutputDiskSpace();
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
    // The system drive is never a disconnected mapped volume. Use Node's
    // filesystem API there so a slow PowerShell process launch cannot turn a
    // normal local directory into a false "drive disconnected" result.
    if (process.platform !== 'win32' || isWindowsSystemDrivePath(resolved)) {
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

  async probeRecordingOutputDirectoryAccess(directoryPath, options = {}) {
    const fileSystem = options.fileSystem || fsp;
    const resolved = path.resolve(String(directoryPath || '').trim());
    const label = String(options.label || '录像保存根目录');
    const filesystemRoot = path.parse(resolved).root;
    if (resolved === filesystemRoot) {
      throw new Error(`${label}不能直接使用文件系统根目录：${resolved}`);
    }
    const randomBytes = options.randomBytes || crypto.randomBytes;
    const probeName = `.bili-record-2k-permission-check-${process.pid}-${Buffer.from(randomBytes(12)).toString('hex')}.tmp`;
    const probePath = path.join(resolved, probeName);
    const renamedProbePath = path.join(resolved, `${probeName}.renamed`);
    const payload = Buffer.from('BiliRecord2K write access probe\n', 'utf8');
    let handle = null;
    let probeCreated = false;
    let probeRenamed = false;
    try {
      // A mount can report free space while denying the service account write
      // access. The service-account probe is the final admission criterion;
      // local POSIX 2770 normalization is only a recommendation, while
      // CIFS/NFS/FUSE and other network mounts rely on this probe exclusively.
      handle = await fileSystem.open(probePath, 'wx', 0o600);
      probeCreated = true;
      await handle.writeFile(payload);
      if (typeof handle.sync === 'function') {
        await handle.sync();
      }
      await handle.close();
      handle = null;
      const actualPayload = Buffer.from(await fileSystem.readFile(probePath));
      if (!actualPayload.equals(payload)) {
        throw new Error('写入后读取到的测试内容不一致');
      }
      await fileSystem.rename(probePath, renamedProbePath);
      probeRenamed = true;
      const renamedPayload = Buffer.from(await fileSystem.readFile(renamedProbePath));
      if (!renamedPayload.equals(payload)) {
        throw new Error('重命名后读取到的测试内容不一致');
      }
      await fileSystem.unlink(renamedProbePath);
      probeCreated = false;
      return true;
    } catch (error) {
      throw new Error(
        `${label}无法由当前服务用户创建、写入、读取、重命名和删除测试文件：${resolved}` +
          `（${compactLogLine(error?.message || String(error))}）。` +
          '请检查 SMB 挂载的 uid/gid、dir_mode/file_mode，确保运行 BiliRecord2K 的服务用户具有读写权限。'
      );
    } finally {
      if (handle) {
        await handle.close().catch(() => {});
      }
      if (probeCreated) {
        await fileSystem.unlink(probeRenamed ? renamedProbePath : probePath).catch(() => {});
      }
    }
  }

  async getLinuxRecordingRootMount(directoryPath, options = {}) {
    const runtimePlatform = String(options.platform || process.platform);
    if (runtimePlatform !== 'linux') return null;
    if (options.mount && typeof options.mount === 'object') {
      return {
        mountPoint: String(options.mount.mountPoint || ''),
        fsType: String(options.mount.fsType || '').toLowerCase(),
        source: String(options.mount.source || '')
      };
    }
    let mountInfo = options.mountInfo;
    if (mountInfo === undefined) {
      try {
        mountInfo = await fsp.readFile('/proc/self/mountinfo', 'utf8');
      } catch {
        return null;
      }
    }
    return findLinuxMountForPath(mountInfo, path.resolve(String(directoryPath || '').trim()));
  }

  async normalizeLinuxRecordingRootPermissions(directoryPath, options = {}) {
    const runtimePlatform = String(options.platform || process.platform);
    if (runtimePlatform !== 'linux') return false;
    const fileSystem = options.fileSystem || fsp;
    const resolved = path.resolve(String(directoryPath || '').trim());
    const label = String(options.label || '录像保存根目录');
    const filesystemRoot = path.parse(resolved).root;
    if (resolved === filesystemRoot) {
      throw new Error(`${label}不能直接使用文件系统根目录，已拒绝修改其权限：${resolved}`);
    }

    const mount = await this.getLinuxRecordingRootMount(resolved, options);
    if (!mount) {
      // Failing safe is important here: an unrecognised mount can be a remote
      // filesystem, and the access probe below still validates the only thing
      // that matters to the service account.
      this.log('warn', `${label}无法识别 Linux 挂载类型，未修改属主或模式，将以实际读写探针为准：${resolved}`);
      return false;
    }
    if (isNonPosixRecordingMount(mount)) {
      this.log(
        'info',
        `${label}位于 ${mount.fsType || '未知'} 挂载（${mount.mountPoint || resolved}），跳过 POSIX 2770 规范化，以实际读写探针为准。`
      );
      return false;
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
    try {
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
        this.log(
          'warn',
          `${label}的属主不是当前服务用户，跳过本地 POSIX 2770 推荐规范；将以实际创建、写入、读取、重命名和删除探针为准：${resolved}`
        );
        return false;
      }
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
      this.log(
        'warn',
        `${label}未能应用本地 POSIX 2770 推荐规范：${resolved}（${compactLogLine(error?.message || String(error))}）。` +
          '将以实际创建、写入、读取、重命名和删除探针为最终准入条件。'
      );
      return false;
    }
    this.log('info', `已将本地 POSIX 录像保存根目录建议规范为当前服务组的 2770（仅目录本身，不递归处理历史录像）：${resolved}`);
    return true;
  }

  async ensureRecordingOutputRootReady(directoryPath, options = {}) {
    const ready = await this.ensureDirectoryReady(directoryPath, options);
    if (!ready) {
      return false;
    }
    let normalizationError = null;
    try {
      await this.normalizeLinuxRecordingRootPermissions(directoryPath, options);
    } catch (error) {
      normalizationError = error;
    }
    try {
      await this.probeRecordingOutputDirectoryAccess(directoryPath, options);
    } catch (error) {
      if (options.permissionsRequired === false) {
        this.log('warn', error.message);
        return true;
      }
      throw error;
    }
    if (normalizationError) {
      this.log(
        'warn',
        `${compactLogLine(normalizationError?.message || String(normalizationError))}；实际服务用户读写探针已通过，不阻止保存。`
      );
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
    return this.settingsService.save(nextSettings, options);
  }

  assertSettingsUpdate(nextSettings) {
    return this.settingsService.assertSettingsUpdate(nextSettings);
  }

  async addRoom(roomId) {
    const id = parseRoomInput(roomId);
    if (this.rooms.has(id)) {
      throw businessError('ROOM_ALREADY_EXISTS', '该直播间已经添加。', 409);
    }
    const info = await this.fetchRoomInfo(id);
    const realRoomId = String(info.realRoomId || '');
    const duplicate = Array.from(this.rooms.values()).find(
      (room) =>
        (realRoomId && String(room.realRoomId || '') === realRoomId) ||
        (room.shortId && String(room.shortId) === id)
    );
    if (duplicate) {
      throw businessError('ROOM_ALREADY_EXISTS', '该直播间已经添加。', 409);
    }
    const room = this.normalizeRoom({
      id,
      ...info,
      monitoring: false,
      autoRecord: false,
      lastCheckedAt: Date.now()
    });
    this.rooms.set(id, room);
    await this.saveStore();
    this.log('info', `已添加房间 ${roomLabel(room)}；默认未开启监听和自动录制。`);
    this.markRoomDirty(room.id);
    return this.getState();
  }

  async removeRoom(roomId, options = {}) {
    const room = this.getRoom(roomId);
    if (this.removingRoomIds.has(room.id)) {
      throw businessError('ROOM_REMOVAL_IN_PROGRESS', `${roomLabel(room)} 正在取消任务并删除，请稍候。`, 409);
    }
    const activeTasks = this.getRoomActiveTaskKinds(room);
    if (activeTasks.length && !options.force) {
      throw businessError(
        'ROOM_BUSY',
        `${roomLabel(room)} 仍有${activeTasks.join('、')}任务。请先完成或取消任务；如确认继续，可选择强制删除。`,
        409
      );
    }
    if (options.force) {
      this.removingRoomIds.add(room.id);
      try {
        room.monitoring = false;
        this.stopMonitorTimer(room.id);
        this.stopLivePushMonitor(room.id);
        const retryTimer = this.streamStartRetryTimers.get(room.id);
        if (retryTimer) clearTimeout(retryTimer);
        this.streamStartRetryTimers.delete(room.id);
        this.streamStartRetryRooms.delete(room.id);
        this.reconnectPendingRooms.delete(room.id);
        if (this.isRoomRecording(room)) {
          await this.stopRecording(room.id);
        }
        const mergeActive = this.getRoomActiveTaskKinds(room).includes('合并');
        if (mergeActive) {
          await this.cancelMerge(room.id);
        }
        this.clearMergeRetryStatesForRoom(room.id);
        await this.cancelRoomBurnTasks(room);
        await this.cancelRoomExportTasks(room);
        if (this.isRoomRelatedPreview(room)) {
          await this.cancelExportPreview({ silent: true });
        }
        for (const [cleanupId, cleanup] of this.pendingSegmentCleanups) {
          if (String(cleanup?.roomId || '') === room.id) {
            this.pendingSegmentCleanups.delete(cleanupId);
          }
        }
        await this.waitForRoomTasksReleased(room);
      } catch (error) {
        this.removingRoomIds.delete(room.id);
        throw error;
      }
    }
    this.clearMergeRetryStatesForRoom(room.id);
    this.stopMonitorTimer(room.id);
    this.stopLivePushMonitor(room.id);
    this.rooms.delete(room.id);
    this.removingRoomIds.delete(room.id);
    await this.saveStore();
    this.log('info', `已${options.force ? '强制' : ''}移除房间 ${room.id}。`);
    this.markRoomDeleted(room.id);
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
    return this.roomMonitor.setMonitoring(roomId, enabled);
  }

  applyMonitorPollJitter(delayMs) {
    return this.roomMonitor.applyMonitorPollJitter(delayMs);
  }

  isLivePushConnected(roomId) {
    return this.roomMonitor.isLivePushConnected(roomId);
  }

  startMonitorTimer(roomId, options = {}) {
    return this.roomMonitor.startMonitorTimer(roomId, options);
  }

  stopMonitorTimer(roomId) {
    return this.roomMonitor.stopMonitorTimer(roomId);
  }

  async tickRoom(roomId) {
    return this.roomMonitor.tickRoom(roomId);
  }

  async fetchRoomLiveStatus(roomId) {
    return this.roomMonitor.fetchRoomLiveStatus(roomId);
  }

  async applyDetectedLiveStatus(room, liveStatus, source) {
    return this.roomMonitor.applyDetectedLiveStatus(room, liveStatus, source);
  }

  async startLivePushMonitor(roomId) {
    return this.roomMonitor.startLivePushMonitor(roomId);
  }

  async connectLivePushMonitor(room, monitor) {
    return this.roomMonitor.connectLivePushMonitor(room, monitor);
  }

  async handleLivePushCommand(room, monitor, command) {
    return this.roomMonitor.handleLivePushCommand(room, monitor, command);
  }

  scheduleLivePushReconnect(room, monitor, reason) {
    return this.roomMonitor.scheduleLivePushReconnect(room, monitor, reason);
  }

  stopLivePushMonitor(roomId) {
    return this.roomMonitor.stopLivePushMonitor(roomId);
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
      throw businessError('ROOM_NOT_LIVE', `${roomLabel(room)} 当前未开播，无法打开实时预览。`, 409);
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
    const requestedPath = String(options.cleanPath || options.path || '').trim();
    if (!requestedPath) {
      throw businessError('INVALID_PREVIEW_REQUEST', '请选择要预览的视频文件。', 400);
    }
    const sourcePath = path.resolve(requestedPath);
    if (!this.isKnownMediaPath(sourcePath)) {
      throw businessError('INVALID_PREVIEW_REQUEST', '视频路径不在录像库或输出目录内。', 400);
    }
    const stat = await fsp.stat(sourcePath).catch(() => null);
    if (!stat?.isFile()) {
      throw businessError('RECORDING_NOT_FOUND', '视频文件不存在。', 404);
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
    if (
      ['queued', 'running'].includes(this.exportPreviewProgress?.status) &&
      this.exportPreview?.id === id
    ) {
      return {
        ok: true,
        id,
        jobId: this.exportPreviewProgress.id,
        previewUrl,
        ready: false,
        cached: false,
        progress: { ...this.exportPreviewProgress }
      };
    }
    await this.cancelExportPreview({ silent: true });
    const workingPreviewDir = `${previewDir}.work-${crypto.randomBytes(6).toString('hex')}`;
    const workingPlaylistPath = path.join(workingPreviewDir, 'index.m3u8');
    await fsp.mkdir(workingPreviewDir, { recursive: true });

    const mediaInfo = await probeMediaFileInfo(this.ffmpegPath, sourcePath);
    const durationSec = await this.resolveRecordingDuration({ cleanPath: sourcePath }, mediaInfo).catch(() => mediaInfo.durationSec || 0);
    await this.waitForRuntimeCapabilities();
    const previewCodec = this.getPreviewCodec();
    this.requireAvailableBurnCodec(previewCodec, '兼容预览');
    const previewCodecInfo = this.getBurnCodecInfo(previewCodec);
    const previewDecoder = this.getHardwareDecoder(mediaInfo.videoInfo, previewCodec);
    const progress = createFfmpegJobProgress({
      kind: 'preview',
      label: `生成兼容预览：${path.basename(sourcePath)}`,
      outputPath: sourcePath,
      durationSec,
      codec: previewCodec,
      codecKind: previewCodecInfo.kind,
      decoder: previewDecoder.value,
      decoderKind: previewDecoder.kind,
      decoderLabel: previewDecoder.label
    });
    progress.status = 'queued';
    progress.message = '兼容预览已排队，等待媒体资源';
    clearTimeout(this.exportPreviewClearTimer);
    this.exportPreviewProgress = progress;
    this.exportPreview = {
      id,
      sourcePath,
      previewUrl,
      status: 'queued',
      ready: false,
      cached: false,
      updatedAt: Date.now()
    };
    this.emitState('mediaJob');
    this.log(
      'info',
      `兼容预览已加入队列：${path.basename(sourcePath)}（${
        previewCodecInfo.kind === 'hardware' ? '硬件' : '软件'
      }编码 ${previewCodec}，${previewDecoder.kind === 'hardware' ? `${previewDecoder.label} 硬件解码` : 'CPU 解码'}）`
    );
    const previewLeasePromise = this.mediaJobs.acquire({
      id: progress.id,
      type: 'preview',
      ...this.getTranscodeResourcePlan(previewCodec, mediaInfo.videoInfo, { lightweight: true }),
      cancel: () => this.cancelExportPreview({ silent: true }).catch(() => {})
    });

    void previewLeasePromise
      .then((previewLease) => {
        if (
          this.exportPreviewProgress?.id !== progress.id ||
          this.exportPreviewProgress.status === 'cancelled'
        ) {
          previewLease.release();
          fsp.rm(workingPreviewDir, { recursive: true, force: true }).catch(() => {});
          return;
        }
        progress.status = 'running';
        progress.workStartedAt = Date.now();
        progress.updatedAt = progress.workStartedAt;
        progress.message = '正在生成兼容预览';
        if (this.exportPreview?.id === id) {
          this.exportPreview.status = 'running';
          this.exportPreview.updatedAt = Date.now();
        }
        this.emitState('mediaJob');

    const handlePreviewStderr = (line) => {
      if (this.exportPreviewProgress?.id === progress.id && updateFfmpegJobProgress(this.exportPreviewProgress, line)) {
        this.emitState('mediaJob');
      }
      if (/error|failed|invalid/i.test(line)) {
        this.log('warn', `兼容预览：${compactLogLine(line)}`);
      }
    };
    const runPreviewWithFallback = async () => {
      let activeCodec = previewCodec;
      let activeDecoder = previewDecoder;
      for (;;) {
        try {
          await runFfmpegJob(
            this.ffmpegPath,
            createPreviewHlsArgs({
              inputPath: sourcePath,
              playlistPath: workingPlaylistPath,
              segmentPattern: path.join(workingPreviewDir, 'segment_%05d.ts'),
              codec: activeCodec,
              decoder: activeDecoder.value,
              sourceCodec: previewDecoder.codec
            }),
            handlePreviewStderr,
            {
              onChild: (child) => {
                this.exportPreviewProcess = child;
              }
            }
          );
          return;
        } catch (error) {
          if (this.exportPreviewProgress?.id !== progress.id || this.exportPreviewProgress.status !== 'running') {
            throw error;
          }
          if (activeDecoder.kind === 'hardware' && isFfmpegHardwareDecodeError(error)) {
            this.log(
              'warn',
              `兼容预览的 ${activeDecoder.label} 硬件解码不支持当前视频，立即改用 CPU 解码：${compactLogLine(error.message)}`
            );
            activeDecoder = { value: 'software', label: 'CPU', kind: 'software' };
          } else {
            throw error;
          }
          progress.codec = activeCodec;
          progress.codecKind = activeCodec.includes('libx') ? 'software' : 'hardware';
          this.setProgressDecoder(progress, activeDecoder);
          progress.currentTimeSec = 0;
          progress.percent = durationSec > 0 ? 0 : null;
          progress.estimatedRemainingSec = null;
          progress.message = '正在使用兼容路径重新生成预览';
          this.emitState('mediaJob');
          await fsp.rm(workingPreviewDir, { recursive: true, force: true }).catch(() => {});
          await fsp.mkdir(workingPreviewDir, { recursive: true });
        }
      }
    };

    runPreviewWithFallback()
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
        if (this.exportPreviewProgress.status === 'cancelled') {
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
              this.emitState('mediaJob');
            }
          }, 5000);
          this.exportPreviewClearTimer.unref?.();
        }
        this.emitState('mediaJob');
      });
      })
      .catch((error) => {
        if (this.exportPreviewProgress?.id !== progress.id) {
          fsp.rm(workingPreviewDir, { recursive: true, force: true }).catch(() => {});
          return;
        }
        if (this.exportPreviewProgress.status === 'cancelled') {
          fsp.rm(workingPreviewDir, { recursive: true, force: true }).catch(() => {});
          return;
        }
        finishFfmpegJobProgress(this.exportPreviewProgress, 'error', `兼容预览失败：${error.message}`);
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
        fsp.rm(workingPreviewDir, { recursive: true, force: true }).catch(() => {});
        this.emitState('mediaJob');
      });

    return { ok: true, id, jobId: progress.id, previewUrl, ready: false, cached: false, progress: { ...progress } };
  }

  async cancelExportPreview(options = {}) {
    const progress = this.exportPreviewProgress;
    const queued = progress?.status === 'queued';
    if (this.exportPreviewProcess) {
      requestFfmpegStop(this.exportPreviewProcess, { graceful: false, timeoutMs: 1500 });
      this.exportPreviewProcess = null;
    }
    if (queued && progress?.id) {
      this.mediaJobs.cancel(progress.id);
    }
    if (progress?.status === 'running' || queued) {
      finishFfmpegJobProgress(progress, 'cancelled', queued ? '已取消排队中的兼容预览' : '兼容预览已取消');
    }
    if (this.exportPreview && ['queued', 'running'].includes(this.exportPreview.status)) {
      this.exportPreview = {
        ...this.exportPreview,
        status: 'cancelled',
        ready: false,
        message: queued ? '已取消排队中的兼容预览' : '兼容预览已取消',
        updatedAt: Date.now()
      };
    }
    if (!options.silent && (queued || this.exportPreview?.status === 'running' || this.exportPreview?.status === 'cancelled')) {
      this.log('info', queued ? '已取消排队中的兼容预览。' : '已取消当前兼容预览生成。');
    }
    this.emitState('mediaJob');
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
    pipeLocalFileToResponse(filePath, request, response);
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
      pipeLocalFileToResponse(filePath, request, response);
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
    pipeLocalFileToResponse(filePath, request, response, { start, end });
  }

  async getSceneGraphForPreview(options = {}) {
    const cleanPath = String(options.cleanPath || '').trim();
    if (!cleanPath) throw new Error('Scene Graph 预览缺少录像路径。');
    this.assertExportSourcePath(cleanPath);
    let recording = this.normalizeRecording({ cleanPath });
    recording = this.hydrateRecordingFromLibrary(recording);
    const stylePreset = this.resolveSceneGraphStylePreset(options.stylePreset || this.settings.sceneGraphDefaultStyle);
    const result = await this.buildSceneGraphForRecording(recording, {
      stylePreset,
      overlayMode: normalizeBurnOverlayMode(options.overlayMode || this.settings.burnOverlayMode),
      danmakuArea: normalizeDanmakuDisplayArea(options.danmakuArea || this.settings.burnDanmakuArea),
      styleLayout: normalizeDanmakuStyleLayout(options.styleLayout || this.settings.burnDanmakuStyleLayout),
      durationSec: Number(recording.durationSec || 0)
    });
    return Object.assign({}, result.graph, {
      assets: result.graph.assets.map((asset) => {
        const params = new URLSearchParams({
          cleanPath: recording.cleanPath,
          assetId: String(asset.id || '')
        });
        const fallbackParams = new URLSearchParams({ url: String(asset.url || '') });
        return {
          id: asset.id,
          type: asset.type,
          uid: asset.uid,
          url: asset.url,
          src: '/api/scene/avatar?' + params.toString(),
          fallbackSrc: asset.url ? '/api/image?' + fallbackParams.toString() : ''
        };
      })
    });
  }

  async serveSceneAvatar(rawCleanPath, rawAssetId, request, response) {
    const cleanPath = String(rawCleanPath || '').trim();
    const assetId = String(rawAssetId || '').trim();
    if (!cleanPath || !assetId || assetId.length > 128) {
      writeJson(response, 400, { error: 'Scene 头像参数无效' });
      return;
    }
    try {
      this.assertExportSourcePath(cleanPath);
      const recording = this.hydrateRecordingFromLibrary(this.normalizeRecording({ cleanPath }));
      const manifest = await this.loadAvatarManifestForRecording(recording);
      const avatarDirectory = deriveAvatarDirectory(recording.cleanPath);
      const entry = (manifest.entries || []).find((candidate) => {
        const key = Number(candidate.uid || 0) > 0
          ? 'uid:' + Number(candidate.uid)
          : candidate.avatarUrl
            ? 'url:' + candidate.avatarUrl
            : '';
        return key && stableId('avatar', key) === assetId;
      });
      const filePath = String(entry?.filePath || '');
      if (!filePath || !isPathInsideDirectory(path.resolve(filePath), path.resolve(avatarDirectory)) || !(await isExistingFile(filePath))) {
        writeJson(response, 404, { error: '原始头像资源不存在' });
        return;
      }
      response.writeHead(200, {
        'Content-Type': mimeType(filePath),
        'Cache-Control': 'private, max-age=300',
        'Content-Length': String((await fsp.stat(filePath)).size)
      });
      pipeLocalFileToResponse(filePath, request, response);
    } catch (error) {
      writeJson(response, 403, { error: error.message || '无法读取 Scene 头像资源' });
    }
  }

  isKnownMediaPath(filePath) {
    const normalized = path.resolve(filePath);
    const comparablePath = process.platform === 'win32' ? normalized.toLowerCase() : normalized;
    const matchesPath = (candidate) => {
      if (!candidate) return false;
      const resolved = path.resolve(candidate);
      return (process.platform === 'win32' ? resolved.toLowerCase() : resolved) === comparablePath;
    };
    if (!this.isRecordingMediaFileName(normalized)) {
      return false;
    }
    if (this.isPathInRecordingLibrary(normalized)) {
      return true;
    }
    const knownRecordingPath = this.recordings.some((recording) =>
      [recording.cleanPath, recording.capturePath, recording.burnedPath].some(matchesPath)
    );
    if (knownRecordingPath) {
      return true;
    }
    for (const room of this.rooms.values()) {
      const recording = room.currentRecording;
      if (
        recording &&
        [recording.cleanPath, recording.capturePath, recording.burnedPath].some(matchesPath)
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

  getStreamHealthKey(stream) {
    const host = String(stream?.host || '').trim().toLowerCase();
    if (host) return host;
    try {
      return new URL(String(stream?.url || '')).host.toLowerCase();
    } catch {
      return String(stream?.url || '').slice(0, 160).toLowerCase();
    }
  }

  getLiveDanmakuDeduper(liveSessionId) {
    const sessionId = String(liveSessionId || '');
    if (!sessionId) return new SessionEventDeduper();
    let deduper = this.liveDanmakuDedupers.get(sessionId);
    if (!deduper) {
      deduper = new SessionEventDeduper();
      this.liveDanmakuDedupers.set(sessionId, deduper);
    }
    return deduper;
  }

  getStreamHealthPenalty(liveSessionId, stream) {
    const sessionId = String(liveSessionId || '');
    if (!sessionId) return 0;
    const health = this.liveStreamHealth.get(sessionId)?.get(this.getStreamHealthKey(stream));
    return Math.max(0, Number(health?.penalty || 0));
  }

  recordStreamHealth(liveSessionId, stream, reason) {
    const sessionId = String(liveSessionId || '');
    const key = this.getStreamHealthKey(stream);
    if (!sessionId || !key) return;
    let bucket = this.liveStreamHealth.get(sessionId);
    if (!bucket) {
      bucket = new Map();
      this.liveStreamHealth.set(sessionId, bucket);
    }
    const current = bucket.get(key) || { failureCount: 0, eofCount: 0, ptsDiscontinuityCount: 0, penalty: 0 };
    current.failureCount += 1;
    if (reason === 'stream-eof' || reason === 'network-error' || reason === 'no-media-progress') current.eofCount += 1;
    if (reason === 'pts-discontinuity') current.ptsDiscontinuityCount += 1;
    current.penalty = Math.min(900_000, Number(current.penalty || 0) + (reason === 'pts-discontinuity' ? 160_000 : 90_000));
    current.lastFailureAt = Date.now();
    current.lastReason = reason || 'unknown';
    bucket.set(key, current);
  }

  createStreamMetadata(stream) {
    const rawUrl = String(stream?.url || '');
    let urlIdentifier = '';
    try {
      const parsed = new URL(rawUrl);
      urlIdentifier = `${parsed.protocol}//${parsed.host}${parsed.pathname}`;
    } catch {
      urlIdentifier = rawUrl.replace(/[?&](?:token|sign|expires|wsTime)=[^&]+/gi, '');
    }
    return {
      protocol: String(stream?.protocol || ''),
      format: String(stream?.format || ''),
      codec: String(stream?.codec || ''),
      qn: Number(stream?.qn || 0),
      host: this.getStreamHealthKey(stream),
      streamUrlId: crypto.createHash('sha256').update(urlIdentifier).digest('hex').slice(0, 16)
    };
  }

  getOrCreateLiveDiagnostics(room, session) {
    const liveSessionId = String(session?.liveSessionId || '');
    if (!liveSessionId) return null;
    let diagnostics = this.liveDiagnostics.get(liveSessionId);
    if (!diagnostics) {
      diagnostics = {
        schemaVersion: 1,
        liveSessionId,
        roomId: String(room?.id || ''),
        roomTitle: String(room?.title || ''),
        anchor: String(room?.anchor || ''),
        startedAt: Number(session.startedAt || Date.now()),
        diagnosticsPath: session.diagnosticsPath,
        start: {
          livePushReceivedAt: Number(session.livePushReceivedAt || 0) || undefined,
          liveDetectedAt: Number(session.liveDetectedAt || 0) || undefined,
          liveDetectionSource: String(session.liveDetectionSource || '') || undefined,
          startRecordingCalledAt: Number(session.startRecordingCalledAt || session.startedAt || Date.now()),
          streamResolvedAt: Number(session.streamResolvedAt || 0) || undefined,
          ffmpegSpawnAt: Number(session.ffmpegSpawnAt || 0) || undefined,
          firstMediaProgressAt: undefined,
          firstVideoAt: undefined,
          firstAudioAt: undefined,
          danmakuWsConnectedAt: undefined,
          firstDanmakuAt: undefined
        },
        video: {
          segmentCount: 0,
          segments: [],
          disconnectCount: 0,
          reconnectCount: 0,
          qualitySwitchCount: 0,
          ptsDiscontinuityCount: 0,
          timelineHealth: 'healthy'
        },
        danmaku: {
          websocketPackets: 0,
          commandsReceived: 0,
          eventsCaptured: 0,
          duplicateDropped: 0,
          unsupportedDropped: 0,
          decodeErrors: 0,
          writeDropped: 0,
          reconnectCount: 0,
          maxQueueLagMs: 0,
          avgQueueLagMs: 0
        },
        final: { mergeResult: 'pending', warnings: [] },
        updatedAt: new Date().toISOString()
      };
      this.liveDiagnostics.set(liveSessionId, diagnostics);
    }
    if (session?.diagnosticsPath && !diagnostics.diagnosticsPath) diagnostics.diagnosticsPath = session.diagnosticsPath;
    return diagnostics;
  }

  updateLiveDiagnosticsFromSession(room, session) {
    const diagnostics = this.getOrCreateLiveDiagnostics(room, session);
    if (!diagnostics) return null;
    const queue = session.danmakuQueueMetrics || {};
    diagnostics.start.firstMediaProgressAt ||= session.firstMediaProgressAt || undefined;
    diagnostics.start.firstVideoAt ||= session.firstVideoAt || undefined;
    diagnostics.start.firstAudioAt ||= session.firstAudioAt || undefined;
    diagnostics.start.danmakuWsConnectedAt ||= session.danmakuWsConnectedAt || undefined;
    diagnostics.start.firstDanmakuAt ||= session.firstDanmakuAt || undefined;
    diagnostics.danmaku.websocketPackets = Number(session.websocketPackets || 0);
    diagnostics.danmaku.commandsReceived = Number(session.rawDanmakuCount || 0);
    diagnostics.danmaku.eventsCaptured = Number(session.eventCount || 0);
    diagnostics.danmaku.duplicateDropped = Number(session.danmakuDropCounts?.duplicateDropped || 0);
    diagnostics.danmaku.unsupportedDropped = Number(session.danmakuDropCounts?.unsupportedCommand || 0);
    diagnostics.danmaku.decodeErrors = Number(session.danmakuDropCounts?.decodeFailed || 0);
    diagnostics.danmaku.writeDropped = Number(session.danmakuDropCounts?.writeDropped || 0);
    diagnostics.danmaku.reconnectCount = Number(session.danmakuReconnectCount || 0);
    diagnostics.danmaku.maxQueueLagMs = Number(queue.maxQueueLagMs || 0);
    diagnostics.danmaku.avgQueueLagMs = Number(queue.averageQueueLagMs || 0);
    diagnostics.updatedAt = new Date().toISOString();
    return diagnostics;
  }

  queueDiagnosticsWrite(diagnostics) {
    if (!diagnostics?.diagnosticsPath) return Promise.resolve();
    diagnostics.writePromise = (diagnostics.writePromise || Promise.resolve())
      .catch(() => {})
      .then(async () => {
        const payload = { ...diagnostics, writePromise: undefined, diagnosticsPath: path.basename(diagnostics.diagnosticsPath) };
        const temporaryPath = `${diagnostics.diagnosticsPath}.${process.pid}.${Date.now()}.tmp`;
        await fsp.writeFile(temporaryPath, `${JSON.stringify(payload, null, 2)}\n`, { encoding: 'utf8', mode: 0o660 });
        await atomicReplaceFile(temporaryPath, diagnostics.diagnosticsPath);
      });
    return diagnostics.writePromise;
  }

  appendSegmentDiagnostics(room, session, recording) {
    const diagnostics = this.updateLiveDiagnosticsFromSession(room, session);
    if (!diagnostics) return Promise.resolve();
    const health = recording.timelineHealth || {};
    diagnostics.video.segments.push({
      sequence: Number(recording.mergeSequence || 0),
      fileName: path.basename(recording.cleanPath || ''),
      reason: recording.segmentReason || 'initial',
      durationSec: Number(recording.durationSec || 0),
      danmakuDurationSec: Number(recording.danmakuDurationSec || 0),
      protocol: recording.streamMetadata?.protocol || '',
      format: recording.streamMetadata?.format || '',
      codec: recording.videoInfo?.codec || recording.streamMetadata?.codec || '',
      qn: Number(recording.streamMetadata?.qn || 0),
      host: recording.streamMetadata?.host || '',
      resolution: recording.videoInfo ? `${recording.videoInfo.width || 0}x${recording.videoInfo.height || 0}` : '',
      timelineHealth: health.timelineHealth || 'warning',
      firstVideoPts: health.firstVideoPts ?? null,
      firstAudioPts: health.firstAudioPts ?? null
    });
    diagnostics.video.segmentCount = diagnostics.video.segments.length;
    diagnostics.video.disconnectCount = diagnostics.video.segments.filter((item) => /stream-eof|network-error|no-media-progress/i.test(item.reason)).length;
    diagnostics.video.reconnectCount = Math.max(0, diagnostics.video.segmentCount - 1);
    diagnostics.video.qualitySwitchCount = diagnostics.video.segments.filter((item) => item.reason === 'quality-upgrade').length;
    diagnostics.video.ptsDiscontinuityCount = diagnostics.video.segments.filter((item) => item.reason === 'pts-discontinuity').length;
    diagnostics.video.timelineHealth = diagnostics.video.segments.some((item) => item.timelineHealth === 'broken')
      ? 'broken'
      : diagnostics.video.segments.some((item) => item.timelineHealth === 'warning')
        ? 'warning'
        : 'healthy';
    diagnostics.updatedAt = new Date().toISOString();
    return this.queueDiagnosticsWrite(diagnostics);
  }

  finalizeLiveDiagnostics(room, recording, mergeResult = 'completed') {
    const sessionLike = { liveSessionId: recording?.liveSessionId, diagnosticsPath: recording?.diagnosticsPath, startedAt: recording?.startedAt };
    const diagnostics = this.getOrCreateLiveDiagnostics(room, sessionLike);
    if (!diagnostics) return Promise.resolve();
    diagnostics.final = {
      finalVideoDuration: Number(recording?.timelineHealth?.videoDurationSec || recording?.durationSec || 0),
      finalAudioDuration: Number(recording?.timelineHealth?.audioDurationSec || 0),
      finalDanmakuEndTime: Number(recording?.danmakuDurationSec || 0),
      audioVideoDelta: Number(recording?.timelineHealth?.avDeltaSec || recording?.timingInfo?.avDeltaSec || 0),
      danmakuVideoDelta: Number(recording?.danmakuDurationSec || 0) - Number(recording?.durationSec || 0),
      mergeResult,
      warnings: Array.from(new Set([...(recording?.timelineHealth?.warnings || []), ...(diagnostics.final?.warnings || [])]))
    };
    diagnostics.updatedAt = new Date().toISOString();
    return this.queueDiagnosticsWrite(diagnostics);
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

    const streamPurpose = options.requireHls ? 'preview' : 'recording';
    selectableCandidates.sort(
      (a, b) =>
        streamScore(b, this.settings, {
          purpose: streamPurpose,
          healthPenalty: this.getStreamHealthPenalty(options.liveSessionId, b)
        }) -
        streamScore(a, this.settings, {
          purpose: streamPurpose,
          healthPenalty: this.getStreamHealthPenalty(options.liveSessionId, a)
        })
    );
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
      throw businessError('SERVICE_DRAINING', '服务正在退出，不能开始新的录制。', 409);
    }
    const room = this.getRoom(roomId);
    if (this.removingRoomIds.has(room.id)) {
      throw businessError('ROOM_REMOVAL_IN_PROGRESS', `${roomLabel(room)} 正在删除，不能开始新的录制。`, 409);
    }
    const liveSessionId = String(options.liveSessionId || crypto.randomUUID());
    const startRecordingCalledAt = Date.now();
    const startRecordingMono = monotonicNowMs();
    if (this.hasActiveRecordingSession(room) || (this.reconnectPendingRooms.has(room.id) && !options.streamReconnect)) {
      if (!autoStart) {
        throw businessError('RECORDING_ALREADY_ACTIVE', `${roomLabel(room)} 已有录制任务正在进行。`, 409);
      }
      return this.getState();
    }
    this.recordingStartLocks.add(room.id);
    room.recordingState = 'waiting-stream';
    this.emitState();
    let streamResolved = false;

    try {
      if (!room.realRoomId || room.liveStatus !== 1) {
        Object.assign(room, await this.fetchRoomInfo(room.id));
      }
      if (room.liveStatus !== 1) {
        const error = businessError('ROOM_NOT_LIVE', `${roomLabel(room)} 当前未开播，无法开始录制。`, 409);
        this.log('warn', error.message);
        this.emitState();
        if (!autoStart) {
          throw error;
        }
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
          stream = await this.resolvePlayStream(room, { liveSessionId, purpose: '正式录像' });
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
      streamResolved = Boolean(stream?.url);
      const streamResolvedAt = Date.now();
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
      const avatarManifestPath = deriveAvatarManifestPath(cleanPath);
      const avatarDirectory = deriveAvatarDirectory(cleanPath);
      const sceneCachePath = deriveSceneCachePath(cleanPath);
      const scenePath = deriveSceneGraphPath(cleanPath);
      const cssPath = path.join(outputDir, `${baseName}.danmaku.css`);
      const assPath = path.join(outputDir, `${baseName}.danmaku.ass`);
      const burnedPath = path.join(outputDir, `${baseName}.danmaku.${container}`);
      const mergeGroup = String(options.mergeGroup || baseName);
      const mergeSequence = Number(options.mergeSequence || 0);
      const mergeOutputPath =
        options.mergeOutputPath || path.join(outputDir, `${sanitizeFilename(mergeGroup)}.merged.${container}`);
      const segmentReason = String(
        options.segmentReason ||
          (options.streamReconnect ? 'stream-eof' : options.segmentContinue ? 'duration-limit' : 'initial')
      );
      const diagnosticsPath = String(options.diagnosticsPath || path.join(outputDir, 'diagnostics.json'));

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

      const ffmpegSpawnAt = Date.now();
      const ffmpegSpawnMono = monotonicNowMs();
      room.recordingState = 'connecting';
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
        onDrop: () => {
          if (!session) return;
          this.incrementDanmakuDrop(session, 'writeDropped');
        }
      });
      const sceneStream = new BufferedJsonlWriter(sceneCachePath, {
        onError: (error) => {
          if (!session) return;
          session.sceneWriteFailed = true;
          session.sceneStatus = 'degraded';
          this.log('warn', roomLabel(room) + ' Scene Graph 缓存写盘失败，原始 JSONL 与视频录制仍会继续：' + error.message);
        },
        onDrop: () => {
          if (!session) return;
          session.sceneWriteDropped = Number(session.sceneWriteDropped || 0) + 1;
        }
      });
      session = {
        roomId: room.id,
        liveSessionId,
        ffmpeg,
        stream,
        streamMetadata: this.createStreamMetadata(stream),
        eventStream,
        sceneStream,
        danmakuClient: null,
        startedAt: startRecordingCalledAt,
        startedMono: startRecordingMono,
        startRecordingCalledAt,
        livePushReceivedAt: Number(options.livePushReceivedAt || 0),
        liveDetectedAt: Number(options.liveDetectedAt || 0),
        liveDetectionSource: String(options.liveDetectionSource || ''),
        streamResolvedAt,
        ffmpegSpawnAt,
        ffmpegSpawnMono,
        state: 'waiting-first-frame',
        outputDir,
        outputContainer: container,
        cleanPath,
        capturePath,
        danmakuPath,
        avatarManifestPath,
        avatarDirectory,
        sceneCachePath,
        scenePath,
        sceneStatus: 'capturing',
        cssPath,
        assPath,
        burnedPath,
        containerStage: 'capturing',
        validReason: '',
        mergeGroup,
        mergeSequence,
        mergeOutputPath,
        segmentTargetDurationSec: segmentDurationSec,
        segmentReason,
        diagnosticsPath,
        eventCount: 0,
        sceneEventCount: 0,
        rawDanmakuCount: 0,
        capturedDanmakuCount: 0,
        danmakuCommandCounts: {},
        lastEventEmitAt: 0,
        danmakuStatus: 'connecting',
        danmakuMessage: '弹幕通道连接中',
        danmakuPopularity: 0,
        danmakuReconnectAttempt: 0,
        danmakuReconnectTimer: null,
        danmakuReconnectCount: 0,
        ignoredCommandCount: 0,
        danmakuDropCounts: {
          unsupportedCommand: 0,
          deliberatelyIgnored: 0,
          duplicateDropped: 0,
          decodeFailed: 0,
          malformedEvent: 0,
          writeDropped: 0,
          filteredEvent: 0
        },
        avatarCapture: {
          manifestPath: avatarManifestPath,
          directory: avatarDirectory,
          entries: new Map(),
          knownKeys: new Set(),
          queue: [],
          pending: new Set(),
          active: 0,
          totalBytes: 0,
          truncated: false,
          failures: 0,
          manifestWriteChain: Promise.resolve(),
          idleWaiters: new Set()
        },
        deduper: this.getLiveDanmakuDeduper(liveSessionId),
        danmakuQueueMetrics: {
          queueLength: 0,
          oldestPacketWaitMs: 0,
          maxQueueLagMs: 0,
          averageQueueLagMs: 0
        },
        websocketPackets: 0,
        lastIgnoredEmitAt: 0,
        ffmpegProbeBuffer: '',
        ffmpegLogBuffer: '',
        videoInfo: null,
        rotateTimer: null,
        mediaWatchTimer: null,
        qualityWatchTimer: null,
        lastMediaSize: 0,
        lastMediaGrowthAt: Date.now(),
        lastMediaProgressAt: 0,
        lastMediaProgressMono: 0,
        lastMediaOutTimeSec: 0,
        firstMediaOutTimeSec: null,
        mediaClock: null,
        firstMediaProgressAt: 0,
        firstMediaProgressMono: 0,
        firstVideoAt: 0,
        firstAudioAt: 0,
        firstVideoPts: null,
        firstAudioPts: null,
        ptsDiscontinuityCount: 0,
        mediaStalled: false,
        rotating: false,
        qualitySwitching: false,
        nextStream: null,
        lastStreamSwitchMono: Number(options.lastStreamSwitchMono || 0),
        qualityCandidate: null,
        qualityCandidateConfirmations: 0,
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
      room.recordingState = session.state;
      room.currentRecording = {
        startedAt: session.startedAt,
        liveSessionId,
        cleanPath,
        danmakuPath,
        avatarManifestPath,
        sceneCachePath,
        scenePath,
        sceneStatus: 'capturing',
        cssPath,
        assPath,
        burnedPath,
        capturePath,
        containerStage: 'capturing',
        validReason: '',
        mergeGroup,
        mergeSequence,
        mergeOutputPath,
        segmentTargetDurationSec: segmentDurationSec,
        segmentReason,
        diagnosticsPath,
        recordingState: session.state,
        eventCount: 0,
        sceneEventCount: 0,
        rawDanmakuCount: 0,
        capturedDanmakuCount: 0,
        danmakuStatus: 'connecting',
        danmakuMessage: '弹幕通道连接中',
        danmakuPopularity: 0,
        ignoredDanmakuCount: 0,
        danmakuCommandCounts: {},
        danmakuDropCounts: { ...session.danmakuDropCounts },
        streamMetadata: { ...session.streamMetadata },
        videoInfo: null
      };
      this.recordingSessions.set(room.id, session);
      session.releaseMediaJob = this.mediaJobs.registerExternal({
        id: `recording:${room.id}:${session.startedAt}`,
        type: 'recording',
        ...this.getRecordingMediaResourcePlan(),
        cancel: () => this.stopRecording(room.id).catch(() => {})
      });
      this.reconnectPendingRooms.delete(room.id);
      this.getOrCreateLiveDiagnostics(room, session);
      if (session.liveDetectedAt) {
        const streamLookupMs = Math.max(0, Number(session.streamResolvedAt || ffmpegSpawnAt) - session.liveDetectedAt);
        const spawnDelayMs = Math.max(0, ffmpegSpawnAt - session.liveDetectedAt);
        this.log(
          'info',
          `${roomLabel(room)} 开播链路：${session.liveDetectionSource || '检测'} -> 选流 ${(streamLookupMs / 1000).toFixed(
            2
          )} 秒，-> FFmpeg ${(spawnDelayMs / 1000).toFixed(2)} 秒。`
        );
      }
      this.writeActiveSegmentMetadata(room, session).catch((error) => {
        this.log('warn', `${roomLabel(room)} 写入断电恢复标记失败：${error.message}`);
      });
      this.scheduleAvatarManifestWrite(session, 'recording').catch((error) => {
        this.log('warn', `${roomLabel(room)} 写入头像记录清单失败：${error.message}`);
      });
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
        this.processRecordingFfmpegOutput(room, session, text);
        if (!session.videoInfo) {
          session.ffmpegProbeBuffer = `${session.ffmpegProbeBuffer}${text}`.slice(-6000);
          const videoInfo = parseFfmpegVideoInfo(session.ffmpegProbeBuffer);
          if (videoInfo) {
            session.videoInfo = videoInfo;
            this.maybeEnterRecordingState(room, session);
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
      room.recordingState = 'failed';
      this.reconnectPendingRooms.delete(room.id);
      this.log('error', `${roomLabel(room)} 开始录制失败：${error.message}`);
      if (autoStart && !streamResolved && room.monitoring && room.liveStatus === 1) {
        this.scheduleInitialStreamRetry(room, options, error.message);
      }
      this.emitState();
      if (!autoStart) {
        throw error;
      }
    } finally {
      this.recordingStartLocks.delete(room.id);
      if (!this.recordingSessions.has(room.id)) {
        this.reconnectPendingRooms.delete(room.id);
      }
      this.emitState();
    }
    return this.getState();
  }

  scheduleInitialStreamRetry(room, previousOptions = {}, reason = '') {
    if (!room?.id || this.draining || this.streamStartRetryTimers.has(room.id) || !room.monitoring || room.liveStatus !== 1) {
      return;
    }
    const attempt = Math.min(8, Number(previousOptions.streamStartRetryAttempt || 0) + 1);
    const delayMs = Math.min(20_000, 1_000 * 2 ** Math.min(attempt - 1, 4));
    this.streamStartRetryRooms.add(room.id);
    room.recordingState = 'waiting-stream';
    this.log(
      'info',
      `${roomLabel(room)} 直播流尚未稳定，${(delayMs / 1000).toFixed(1)} 秒后重试第 ${attempt} 次${reason ? `：${reason}` : ''}`
    );
    const timer = setTimeout(() => {
      this.streamStartRetryTimers.delete(room.id);
      this.streamStartRetryRooms.delete(room.id);
      if (!room.monitoring || room.liveStatus !== 1 || this.hasActiveRecordingSession(room)) {
        this.emitState();
        return;
      }
      this.startRecording(room.id, true, {
        ...previousOptions,
        streamStartRetryAttempt: attempt,
        silentNotify: true
      }).catch((error) => {
        this.log('warn', `${roomLabel(room)} 等待稳定流重试失败：${error.message}`);
      });
    }, delayMs);
    timer.unref?.();
    this.streamStartRetryTimers.set(room.id, timer);
    this.emitState();
  }

  incrementDanmakuDrop(session, reason, count = 1) {
    if (!session) return;
    const key = String(reason || 'unsupportedCommand');
    session.danmakuDropCounts ||= {};
    session.danmakuDropCounts[key] = Number(session.danmakuDropCounts[key] || 0) + Math.max(1, Number(count || 1));
    session.ignoredCommandCount = Object.values(session.danmakuDropCounts).reduce((sum, value) => sum + Number(value || 0), 0);
  }

  resolveSessionVideoTime(session, receivedMono) {
    const eventMono = Number(receivedMono || monotonicNowMs());
    const originMono = Number(session?.mediaClock?.originMono);
    if (!Number.isFinite(originMono)) {
      // Events received before the first frame belong at the beginning of the
      // media timeline; do not add FFmpeg connection/startup wait.
      return 0;
    }
    return Math.max(0, (eventMono - originMono) / 1000);
  }

  getSessionMediaDurationSec(session) {
    const last = Number(session?.lastMediaOutTimeSec);
    const first = Number(session?.firstMediaOutTimeSec);
    if (!Number.isFinite(last) || !Number.isFinite(first)) return 0;
    return Math.max(0, last - first);
  }

  transitionRecordingState(room, session, state) {
    if (!session || session.state === state) return;
    session.state = state;
    if (this.shouldUpdateCurrentRecording(room, session)) {
      room.currentRecording.recordingState = state;
      room.recordingState = state;
    }
  }

  maybeEnterRecordingState(room, session) {
    if (
      session &&
      !session.finished &&
      !session.stopping &&
      session.mediaClock &&
      session.videoInfo &&
      session.firstVideoAt &&
      ['connecting', 'waiting-first-frame'].includes(session.state)
    ) {
      this.transitionRecordingState(room, session, 'recording');
      this.log('success', `${roomLabel(room)} 已确认首帧与媒体时间轴，正式进入录制。`);
      this.emitState();
    }
  }

  processRecordingMediaProgress(room, session, outTimeSec, observedMono = monotonicNowMs(), observedAt = Date.now()) {
    const outTime = Number(outTimeSec);
    if (!Number.isFinite(outTime) || outTime < 0 || session.finished || session.stopping) return;
    const previousTime = Number(session.lastMediaOutTimeSec || 0);
    const previousMono = Number(session.lastMediaProgressMono || 0);
    if (previousMono) {
      const mediaDelta = outTime - previousTime;
      const wallDelta = Math.max(0, (observedMono - previousMono) / 1000);
      const jumpedForward = mediaDelta > Math.max(15, wallDelta * 4 + MEDIA_PROGRESS_JUMP_TOLERANCE_SEC);
      const movedBackward = mediaDelta < -MEDIA_PROGRESS_BACKWARD_TOLERANCE_SEC;
      if (jumpedForward || movedBackward) {
        this.triggerTimelineDiscontinuity(
          room,
          session,
          jumpedForward
            ? `FFmpeg media progress 突然前跳 ${mediaDelta.toFixed(3)}s`
            : `FFmpeg media progress 回退 ${Math.abs(mediaDelta).toFixed(3)}s`
        );
        return;
      }
    }
    const mediaAdvanced = !previousMono || outTime > previousTime + 0.0005;
    if (!mediaAdvanced) return;
    session.lastMediaOutTimeSec = Math.max(0, outTime);
    if (!Number.isFinite(Number(session.firstMediaOutTimeSec))) {
      session.firstMediaOutTimeSec = outTime;
    }
    session.lastMediaProgressMono = observedMono;
    session.lastMediaProgressAt = observedAt;
    session.lastMediaGrowthAt = observedAt;
    if (!session.mediaClock) {
      session.mediaClock = {
        // Segment time zero is the first media timestamp, not FFmpeg spawn
        // time and not an arbitrary positive source PTS carried by a CDN.
        originMono: observedMono,
        firstProgressMono: observedMono,
        firstOutTimeSec: outTime
      };
      session.firstMediaProgressMono = observedMono;
      session.firstMediaProgressAt = observedAt;
    } else {
      session.mediaClock.originMono = observedMono - this.getSessionMediaDurationSec(session) * 1000;
    }
    this.maybeEnterRecordingState(room, session);
  }

  triggerTimelineDiscontinuity(room, session, detail) {
    this.triggerSegmentRotate(room, session, 'pts-discontinuity', detail);
  }

  triggerSegmentRotate(room, session, reason, detail) {
    if (!session || session.finished || session.stopping || session.rotating || session.timelineDiscontinuityPending) return;
    session.timelineDiscontinuityPending = true;
    if (reason === 'startup-corruption') {
      session.discardStartupSegment = true;
    }
    if (reason === 'pts-discontinuity') {
      session.ptsDiscontinuityCount = Number(session.ptsDiscontinuityCount || 0) + 1;
    }
    session.segmentReason = reason || 'network-error';
    session.rotating = true;
    this.recordStreamHealth(session.liveSessionId, session.stream, session.segmentReason);
    this.transitionRecordingState(room, session, 'rotating');
    const problemLabel =
      session.segmentReason === 'pts-discontinuity'
        ? '检测到时间轴不连续'
        : session.segmentReason === 'startup-corruption'
          ? '检测到起始关键帧异常，当前短分段将丢弃'
          : '检测到首包/流异常';
    this.log(
      'error',
      `${roomLabel(room)} ${problemLabel}：${detail}；将结束当前分段并新建文件。`
    );
    requestFfmpegStop(session.ffmpeg, { graceful: false, timeoutMs: 1500 });
    this.emitState();
  }

  processRecordingFfmpegOutput(room, session, text) {
    if (!session || session.finished) return;
    const nowMono = monotonicNowMs();
    const now = Date.now();
    const progressMatches = Array.from(String(text || '').matchAll(/out_time_us=(-?\d+)/g));
    if (progressMatches.length) {
      for (const match of progressMatches) {
        this.processRecordingMediaProgress(room, session, Number(match[1]) / 1_000_000, nowMono, now);
      }
    } else {
      const fallbackProgress = parseFfmpegProgressTime(text);
      if (Number.isFinite(fallbackProgress)) this.processRecordingMediaProgress(room, session, fallbackProgress, nowMono, now);
    }
    const frameMatches = Array.from(String(text || '').matchAll(/(?:^|\n)frame=\s*(\d+)/g));
    if (frameMatches.some((match) => Number(match[1]) > 0)) session.firstVideoAt ||= now;
    this.maybeEnterRecordingState(room, session);
    if (!session.firstAudioAt && /\bAudio:\s*/i.test(String(text || ''))) session.firstAudioAt = now;
    if (/(?:non[- ]monoton(?:ous|ically)|timestamp discontinuity|invalid.*(?:pts|dts)|pts.*(?:backward|regress)|dts.*(?:backward|regress))/i.test(String(text || ''))) {
      this.triggerTimelineDiscontinuity(room, session, compactLogLine(text));
    }
    const hasDecodeCorruption = /(?:corrupt|invalid nal|missing picture|error while decoding|could not find codec parameters)/i.test(
      String(text || '')
    );
    if (
      hasDecodeCorruption &&
      now - Number(session.ffmpegSpawnAt || now) <= STARTUP_CORRUPTION_GUARD_MS
    ) {
      session.startupCorruptionDetected = true;
      this.triggerSegmentRotate(room, session, 'startup-corruption', compactLogLine(text));
      return;
    }
    if (
      !session.mediaClock &&
      hasDecodeCorruption
    ) {
      this.triggerSegmentRotate(room, session, 'network-error', compactLogLine(text));
    }
  }

  ensureAvatarCaptureState(session) {
    if (session?.avatarCapture) return session.avatarCapture;
    if (!session) return null;
    const manifestPath = String(session.avatarManifestPath || deriveAvatarManifestPath(session.cleanPath || '')).trim();
    const directory = String(session.avatarDirectory || deriveAvatarDirectory(session.cleanPath || '')).trim();
    session.avatarManifestPath = manifestPath;
    session.avatarDirectory = directory;
    session.avatarCapture = {
      manifestPath,
      directory,
      entries: new Map(),
      knownKeys: new Set(),
      queue: [],
      pending: new Set(),
      active: 0,
      totalBytes: 0,
      truncated: false,
      failures: 0,
      manifestWriteChain: Promise.resolve(),
      idleWaiters: new Set()
    };
    return session.avatarCapture;
  }

  async fetchAvatarImageAsset(avatarUrl) {
    const asset = await requestUrlBuffer(avatarUrl, {
      headersForUrl: (target) => createImageProxyHeaders(target, this.settings.cookie),
      validateUrl: (target) => validateRemoteUrl(target, { allowHost: isBilibiliHost }),
      allowProxy: false,
      retries: 1,
      timeoutMs: 10000,
      maxRedirects: 3,
      maxBytes: MAX_AVATAR_OVERLAY_IMAGE_BYTES,
      includeResponseMetadata: true
    });
    const contentType = String(asset.headers?.['content-type'] || '').toLowerCase();
    if (!contentType.startsWith('image/')) {
      throw new Error('头像服务没有返回图片。');
    }
    if (!asset.body?.length || asset.body.length > MAX_AVATAR_OVERLAY_IMAGE_BYTES) {
      throw new Error('头像图片为空或过大。');
    }
    return { body: asset.body, contentType };
  }

  createAvatarManifestPayload(session, status = 'recording') {
    const capture = this.ensureAvatarCaptureState(session);
    const manifestDirectory = path.dirname(capture.manifestPath);
    const entries = Array.from(capture.entries.values()).map((entry) => {
      const filePath = String(entry.filePath || '').trim();
      const relativeFile = filePath
        ? path.relative(manifestDirectory, filePath).split(path.sep).join('/')
        : '';
      return {
        uid: Number(entry.uid || 0),
        avatarUrl: normalizeBiliAvatarUrl(entry.avatarUrl),
        file: relativeFile,
        status: String(entry.status || (relativeFile ? 'captured' : 'unavailable')),
        capturedAt: Number(entry.capturedAt || Date.now())
      };
    });
    return {
      schemaVersion: RECORDED_AVATAR_MANIFEST_SCHEMA_VERSION,
      createdByVersion: APP_VERSION,
      status: status === 'completed' ? 'completed' : 'recording',
      captureComplete: status === 'completed' && !capture.truncated,
      truncated: Boolean(capture.truncated),
      entryCount: entries.length,
      totalBytes: Number(capture.totalBytes || 0),
      entries,
      updatedAt: new Date().toISOString()
    };
  }

  scheduleAvatarManifestWrite(session, status = 'recording') {
    const capture = this.ensureAvatarCaptureState(session);
    const operation = capture.manifestWriteChain.then(async () => {
      const manifestPath = capture.manifestPath;
      const temporaryPath = `${manifestPath}.${process.pid}.${Date.now()}.tmp`;
      await fsp.mkdir(path.dirname(manifestPath), { recursive: true, mode: 0o770 });
      await fsp.writeFile(
        temporaryPath,
        `${JSON.stringify(this.createAvatarManifestPayload(session, status), null, 2)}\n`,
        { encoding: 'utf8', mode: 0o660 }
      );
      try {
        await atomicReplaceFile(temporaryPath, manifestPath);
      } finally {
        await fsp.rm(temporaryPath, { force: true }).catch(() => {});
      }
      return manifestPath;
    });
    capture.manifestWriteChain = operation.catch(() => {});
    return operation;
  }

  notifyAvatarCaptureIdle(capture) {
    if (!capture || capture.active || capture.queue.length || capture.pending.size) return;
    const waiters = Array.from(capture.idleWaiters || []);
    capture.idleWaiters?.clear();
    for (const resolve of waiters) resolve(true);
  }

  pumpAvatarCaptureQueue(session) {
    const capture = this.ensureAvatarCaptureState(session);
    if (!capture) return;
    while (capture.active < RECORDED_AVATAR_CAPTURE_CONCURRENCY && capture.queue.length) {
      const request = capture.queue.shift();
      capture.active += 1;
      let taskPromise;
      taskPromise = Promise.resolve()
        .then(() => this.captureAvatarSnapshot(session, request))
        .catch(() => {
          capture.failures += 1;
        })
        .finally(() => {
          capture.active = Math.max(0, capture.active - 1);
          capture.pending.delete(taskPromise);
          this.pumpAvatarCaptureQueue(session);
          this.notifyAvatarCaptureIdle(capture);
        });
      capture.pending.add(taskPromise);
    }
    this.notifyAvatarCaptureIdle(capture);
  }

  queueRecordingAvatarCapture(session, event) {
    const capture = this.ensureAvatarCaptureState(session);
    if (!capture || !event) return;
    const uid = Math.floor(Number(event.uid || 0));
    const avatarUrl = normalizeBiliAvatarUrl(event.avatarUrl);
    if (!avatarUrl && (!Number.isSafeInteger(uid) || uid <= 0)) return;
    const requestKey = avatarUrl || `uid:${uid}`;
    if (capture.knownKeys.has(requestKey)) return;
    capture.knownKeys.add(requestKey);
    capture.queue.push({ uid, avatarUrl, requestKey });
    this.pumpAvatarCaptureQueue(session);
  }

  async captureAvatarSnapshot(session, request) {
    const capture = this.ensureAvatarCaptureState(session);
    if (!capture) return;
    const uid = Math.floor(Number(request?.uid || 0));
    let avatarUrl = normalizeBiliAvatarUrl(request?.avatarUrl);
    if (!avatarUrl && Number.isSafeInteger(uid) && uid > 0) {
      avatarUrl = await this.lookupBiliAvatarForOverlay(uid).catch(() => '');
    }

    const existing = Array.from(capture.entries.values()).find((entry) =>
      avatarUrl
        ? normalizeBiliAvatarUrl(entry.avatarUrl) === avatarUrl
        : !normalizeBiliAvatarUrl(entry.avatarUrl) && Number(entry.uid || 0) === uid
    );
    if (existing) return;

    const entry = {
      uid,
      avatarUrl,
      filePath: '',
      status: avatarUrl ? 'url-only' : 'unavailable',
      capturedAt: Date.now()
    };
    if (avatarUrl) {
      try {
        const asset = await this.fetchAvatarImageAsset(avatarUrl);
        await fsp.mkdir(capture.directory, { recursive: true, mode: 0o770 });
        const extension = avatarImageExtension(asset.contentType) || '.img';
        const digest = crypto
          .createHash('sha256')
          .update(`${uid}|${avatarUrl}`)
          .digest('hex')
          .slice(0, 24);
        const fileName = `uid-${uid > 0 ? uid : 'unknown'}-${digest}${extension}`;
        const filePath = path.join(capture.directory, fileName);
        const temporaryPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
        await fsp.writeFile(temporaryPath, asset.body, { mode: 0o660 });
        try {
          await atomicReplaceFile(temporaryPath, filePath);
        } finally {
          await fsp.rm(temporaryPath, { force: true }).catch(() => {});
        }
        entry.filePath = filePath;
        entry.status = 'captured';
        capture.totalBytes += asset.body.length;
      } catch {
        capture.failures += 1;
      }
    }
    capture.entries.set(avatarUrl || request.requestKey, entry);
    await this.scheduleAvatarManifestWrite(session, session.finished ? 'completed' : 'recording');
  }

  async flushAvatarCapture(session) {
    const capture = this.ensureAvatarCaptureState(session);
    if (!capture) return true;
    this.pumpAvatarCaptureQueue(session);
    let drained = capture.active === 0 && capture.queue.length === 0 && capture.pending.size === 0;
    if (!drained) {
      drained = await new Promise((resolve) => {
        const timer = setTimeout(() => {
          capture.idleWaiters.delete(waiter);
          resolve(false);
        }, RECORDED_AVATAR_FLUSH_TIMEOUT_MS);
        const waiter = (result) => {
          clearTimeout(timer);
          resolve(result);
        };
        capture.idleWaiters.add(waiter);
      });
    }
    await capture.manifestWriteChain.catch(() => {});
    return drained;
  }

  async readAvatarManifestFile(manifestPath) {
    const resolvedPath = path.resolve(String(manifestPath || '').trim());
    if (!resolvedPath) return { present: false, entries: [], captureComplete: false };
    let payload;
    try {
      payload = JSON.parse(await fsp.readFile(resolvedPath, 'utf8'));
    } catch {
      return { present: false, entries: [], captureComplete: false };
    }
    if (!payload || typeof payload !== 'object' || !Array.isArray(payload.entries)) {
      return { present: false, entries: [], captureComplete: false };
    }
    const manifestDirectory = path.dirname(resolvedPath);
    const avatarDirectory = replaceExtension(resolvedPath, '');
    const entries = payload.entries
      .map((entry) => {
        const uid = Math.floor(Number(entry?.uid || 0));
        const avatarUrl = normalizeBiliAvatarUrl(entry?.avatarUrl);
        const file = String(entry?.file || '').trim();
        let filePath = '';
        if (file) {
          const candidate = path.resolve(manifestDirectory, file);
          if (isPathInsideDirectory(candidate, avatarDirectory)) filePath = candidate;
        }
        return {
          uid,
          avatarUrl,
          filePath,
          status: String(entry?.status || ''),
          capturedAt: Number(entry?.capturedAt || 0)
        };
      })
      .filter((entry) => entry.uid > 0 || entry.avatarUrl || entry.filePath);
    const byUrl = new Map();
    const byUid = new Map();
    for (const entry of entries) {
      if (entry.avatarUrl && !byUrl.has(entry.avatarUrl)) byUrl.set(entry.avatarUrl, entry);
      if (entry.uid > 0) {
        const previous = byUid.get(entry.uid);
        if (!previous || (!previous.filePath && entry.filePath) || entry.capturedAt >= previous.capturedAt) {
          byUid.set(entry.uid, entry);
        }
      }
    }
    return {
      present: true,
      entries,
      byUrl,
      byUid,
      captureComplete: payload.captureComplete === true,
      truncated: payload.truncated === true,
      manifestPath: resolvedPath
    };
  }

  async loadAvatarManifestForRecording(recording) {
    const manifestPath = String(recording?.avatarManifestPath || deriveAvatarManifestPath(recording?.cleanPath || '')).trim();
    return this.readAvatarManifestFile(manifestPath);
  }

  async getSceneAvatarAssets(recording) {
    const manifest = await this.loadAvatarManifestForRecording(recording);
    const assets = {};
    for (const entry of manifest.entries || []) {
      const asset = {
        filePath: String(entry.filePath || ''),
        url: String(entry.avatarUrl || '')
      };
      if (Number(entry.uid || 0) > 0) assets[entry.uid] = asset;
      if (entry.avatarUrl) assets[entry.avatarUrl] = asset;
    }
    return assets;
  }

  async readSceneEventsForRecording(recording) {
    const cachePath = String(recording?.sceneCachePath || deriveSceneCachePath(recording?.cleanPath || '')).trim();
    let events = cachePath ? await readSceneCacheEvents(cachePath).catch(() => []) : [];
    if (events.length) return events;
    return readDanmakuEvents(String(recording?.danmakuPath || '')).catch(() => []);
  }

  getSceneGraphOptions(recording, options = {}) {
    const stylePreset = this.resolveSceneGraphStylePreset(options.stylePreset || this.settings.sceneGraphDefaultStyle);
    return {
      stylePreset,
      styleLayout: options.styleLayout || this.settings.burnDanmakuStyleLayout,
      overlayMode: options.overlayMode || this.settings.burnOverlayMode,
      danmakuArea: options.danmakuArea || this.settings.burnDanmakuArea,
      videoInfo: options.videoInfo || recording?.videoInfo || null,
      avatarAssets: options.avatarAssets || null
    };
  }

  async buildSceneGraphForRecording(recording, options = {}) {
    const normalized = this.normalizeRecording(recording) || recording;
    if (!normalized?.cleanPath) throw new Error('Scene Graph 缺少录像源文件。');
    const [events, avatarAssets] = await Promise.all([
      this.readSceneEventsForRecording(normalized),
      options.avatarAssets ? Promise.resolve(options.avatarAssets) : this.getSceneAvatarAssets(normalized)
    ]);
    let graph = buildSceneGraph(events, this.getSceneGraphOptions(normalized, { ...options, avatarAssets }));
    const requestedDuration = Number(options.durationSec || normalized.durationSec || 0);
    if (Number.isFinite(requestedDuration) && requestedDuration > 0) {
      graph = clipSceneGraph(graph, 0, requestedDuration, { shiftTime: false });
    }
    graph.metadata = Object.assign({}, graph.metadata, {
      sourceCleanPath: normalized.cleanPath,
      sourceJsonlPath: normalized.danmakuPath,
      sourceAvatarManifestPath: normalized.avatarManifestPath || '',
      sourceCachePath: normalized.sceneCachePath || '',
      capturedEventCount: events.length
    });
    return {
      graph,
      // The legacy ASS compatibility renderer must consume the exact same
      // normalized event list as the graph.  Do not re-read JSONL later: a
      // recording may still receive a final buffered event while an export is
      // being prepared.
      events,
      eventCount: events.length,
      scenePath: normalized.scenePath || deriveSceneGraphPath(normalized.cleanPath)
    };
  }

  async writeLegacySceneCompatibilityAss(filePath, events, options = {}) {
    const stylePreset = this.resolveSceneGraphStylePreset(options.stylePreset || this.settings.sceneGraphDefaultStyle);
    if (!LEGACY_ASS_SCENE_PRESETS.has(stylePreset)) return '';
    // First apply the clip bounds in the recording clock.  The renderer then
    // offsets source PTS before libass when there is a video lead-in, exactly
    // as the pre-Scene-Graph ASS pipeline did.
    const prepared = prepareAssEvents(events, {
      overlayMode: options.overlayMode || this.settings.burnOverlayMode,
      startTime: options.startTime,
      endTime: options.endTime,
      shiftTime: options.shiftTime === true
    });
    const body = createAss(prepared, {
      stylePreset,
      styleLayout: options.styleLayout || this.settings.burnDanmakuStyleLayout,
      overlayMode: options.overlayMode || this.settings.burnOverlayMode,
      danmakuArea: options.danmakuArea || this.settings.burnDanmakuArea,
      videoInfo: options.videoInfo || null
    });
    await fsp.writeFile(filePath, body, { encoding: 'utf8', mode: 0o660 });
    return filePath;
  }

  async finalizeSceneGraphForRecording(recording, options = {}) {
    const result = await this.buildSceneGraphForRecording(recording, options);
    await writeSceneGraph(result.scenePath, result.graph);
    return result;
  }

  async mergeAvatarManifests(segments, targetManifestPath) {
    const sourceManifests = [];
    for (const segment of segments || []) {
      const manifestPath = String(segment?.avatarManifestPath || deriveAvatarManifestPath(segment?.cleanPath || '')).trim();
      const manifest = await this.readAvatarManifestFile(manifestPath);
      if (manifest.present) sourceManifests.push(manifest);
    }
    if (!sourceManifests.length) return false;

    const targetPath = path.resolve(String(targetManifestPath || '').trim());
    const targetDirectory = replaceExtension(targetPath, '');
    const targetManifestDirectory = path.dirname(targetPath);
    const mergedByKey = new Map();
    let captureComplete = true;
    let totalBytes = 0;
    await fsp.rm(targetDirectory, { recursive: true, force: true });
    await fsp.mkdir(targetDirectory, { recursive: true, mode: 0o770 });
    try {
      for (const manifest of sourceManifests) {
        captureComplete = captureComplete && manifest.captureComplete === true;
        for (const sourceEntry of manifest.entries) {
          const key = sourceEntry.avatarUrl || `uid:${sourceEntry.uid}`;
          const existing = mergedByKey.get(key);
          if (existing?.filePath && !sourceEntry.filePath) continue;
          const mergedEntry = {
            uid: sourceEntry.uid,
            avatarUrl: sourceEntry.avatarUrl,
            filePath: '',
            status: sourceEntry.status,
            capturedAt: sourceEntry.capturedAt
          };
          if (sourceEntry.filePath && (await isExistingFile(sourceEntry.filePath))) {
            const sourceBytes = await getFileSize(sourceEntry.filePath);
            const digest = crypto
              .createHash('sha256')
              .update(`${sourceEntry.uid}|${sourceEntry.avatarUrl}|${sourceEntry.filePath}`)
              .digest('hex')
              .slice(0, 24);
            const extension = path.extname(sourceEntry.filePath).toLowerCase() || '.img';
            const targetFile = path.join(
              targetDirectory,
              `uid-${sourceEntry.uid > 0 ? sourceEntry.uid : 'unknown'}-${digest}${extension}`
            );
            if (!(await isExistingFile(targetFile))) await fsp.copyFile(sourceEntry.filePath, targetFile);
            mergedEntry.filePath = targetFile;
            mergedEntry.status = 'captured';
            totalBytes += sourceBytes;
          }
          if (!existing || (!existing.filePath && mergedEntry.filePath)) mergedByKey.set(key, mergedEntry);
        }
      }
      const entries = Array.from(mergedByKey.values()).map((entry) => ({
        uid: Number(entry.uid || 0),
        avatarUrl: normalizeBiliAvatarUrl(entry.avatarUrl),
        file: entry.filePath ? path.relative(targetManifestDirectory, entry.filePath).split(path.sep).join('/') : '',
        status: entry.status || (entry.filePath ? 'captured' : 'unavailable'),
        capturedAt: Number(entry.capturedAt || Date.now())
      }));
      const payload = {
        schemaVersion: RECORDED_AVATAR_MANIFEST_SCHEMA_VERSION,
        createdByVersion: APP_VERSION,
        status: 'completed',
        captureComplete,
        truncated: !captureComplete,
        entryCount: entries.length,
        totalBytes,
        entries,
        updatedAt: new Date().toISOString()
      };
      const temporaryPath = `${targetPath}.${process.pid}.${Date.now()}.tmp`;
      await fsp.writeFile(temporaryPath, `${JSON.stringify(payload, null, 2)}\n`, { encoding: 'utf8', mode: 0o660 });
      try {
        await atomicReplaceFile(temporaryPath, targetPath);
      } finally {
        await fsp.rm(temporaryPath, { force: true }).catch(() => {});
      }
      return true;
    } catch (error) {
      await fsp.rm(targetDirectory, { recursive: true, force: true }).catch(() => {});
      await fsp.rm(targetPath, { force: true }).catch(() => {});
      throw error;
    }
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
          session.danmakuWsConnectedAt ||= Date.now();
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
        // Authentication failures do not recover on the same socket. Close it
        // so onClose enters the single reconnect path instead of leaving the
        // client in an authenticated-looking error state.
        client.close('auth failed');
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
      onPacketMetrics: (metrics) => {
        if (session.finished) return;
        if (metrics.phase === 'received') {
          session.websocketPackets = Number(session.websocketPackets || 0) + 1;
        }
        if (metrics.phase === 'processed') {
          session.queueLagTotalMs = Number(session.queueLagTotalMs || 0) + Number(metrics.latestQueueLagMs || 0);
          session.queueLagSampleCount = Number(session.queueLagSampleCount || 0) + 1;
        }
        session.danmakuQueueMetrics = {
          queueLength: Number(metrics.queueLength || 0),
          oldestPacketWaitMs: Number(metrics.oldestPacketWaitMs || 0),
          maxQueueLagMs: Math.max(Number(session.danmakuQueueMetrics?.maxQueueLagMs || 0), Number(metrics.maxQueueLagMs || 0)),
          averageQueueLagMs: Number(session.queueLagSampleCount || 0)
            ? Number(session.queueLagTotalMs || 0) / Number(session.queueLagSampleCount || 1)
            : 0
        };
        this.updateLiveDiagnosticsFromSession(room, session);
      },
      onDecodeError: (detail) => {
        if (session.finished) return;
        this.incrementDanmakuDrop(session, 'decodeFailed');
        const now = Date.now();
        if (now - Number(session.lastDanmakuDecodeWarningAt || 0) > 10_000) {
          session.lastDanmakuDecodeWarningAt = now;
          this.log(
            'warn',
            `${roomLabel(room)} 弹幕解码/JSON 失败（累计 ${session.danmakuDropCounts.decodeFailed}）：${
              detail?.context?.phase || 'unknown'
            } protocol=${detail?.context?.protocolVersion ?? '-'} cmd=${detail?.context?.operation ?? '-'}`
          );
        }
        this.updateLiveDiagnosticsFromSession(room, session);
      },
      onCommand: (command, receiveMeta = {}) => {
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
        const receivedMono = Number(receiveMeta.receivedMono || monotonicNowMs());
        const event = normalizeDanmakuEvent(command, {
          receivedAt: Number(receiveMeta.receivedAt || Date.now()),
          receivedMono,
          videoTime: this.resolveSessionVideoTime(session, receivedMono)
        });
        if (!event) {
          this.incrementDanmakuDrop(session, classifyDanmakuEventIgnore(command, event));
          if (this.shouldUpdateCurrentRecording(room, session)) {
            room.currentRecording.ignoredDanmakuCount = session.ignoredCommandCount;
            room.currentRecording.danmakuDropCounts = { ...session.danmakuDropCounts };
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
        const dedupe = session.deduper.checkAndRemember(event, command, event.receivedAt);
        if (dedupe.duplicate) {
          this.incrementDanmakuDrop(session, 'duplicateDropped');
          if (this.shouldUpdateCurrentRecording(room, session)) {
            room.currentRecording.ignoredDanmakuCount = session.ignoredCommandCount;
            room.currentRecording.danmakuDropCounts = { ...session.danmakuDropCounts };
          }
          this.updateLiveDiagnosticsFromSession(room, session);
          return;
        }
        this.queueRecordingAvatarCapture(session, event);
        const writeDroppedBefore = Number(session.danmakuDropCounts?.writeDropped || 0);
        const written = session.eventStream.write(`${JSON.stringify(event)}\n`);
        if (!written) {
          if (Number(session.danmakuDropCounts?.writeDropped || 0) === writeDroppedBefore) {
            this.incrementDanmakuDrop(session, 'writeDropped');
          }
          session.danmakuWriteDropped = Number(session.danmakuDropCounts.writeDropped || 0);
          if (this.shouldUpdateCurrentRecording(room, session)) {
            room.currentRecording.ignoredDanmakuCount = session.ignoredCommandCount;
            room.currentRecording.danmakuDropCounts = { ...session.danmakuDropCounts };
          }
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
        try {
          const sceneWritten = session.sceneStream?.write(
            JSON.stringify(sceneCacheRecord(event, { stylePreset: this.settings.sceneGraphDefaultStyle })) + '\\n'
          );
          if (sceneWritten) {
            session.sceneEventCount = Number(session.sceneEventCount || 0) + 1;
          } else if (session.sceneStream) {
            session.sceneStatus = 'degraded';
            const now = Date.now();
            if (now - Number(session.lastSceneWriteWarningAt || 0) > 5000) {
              session.lastSceneWriteWarningAt = now;
              this.log('warn', roomLabel(room) + ' Scene Graph 缓存缓冲已满；原始 JSONL 仍在继续写入。');
            }
          }
        } catch (error) {
          session.sceneWriteFailed = true;
          session.sceneStatus = 'degraded';
          this.log('warn', roomLabel(room) + ' 追加 Scene Graph 缓存失败；原始 JSONL 仍在继续写入：' + error.message);
        }
        session.eventCount += 1;
        session.capturedDanmakuCount = session.eventCount;
        session.firstDanmakuAt ||= event.receivedAt;
        if (this.shouldUpdateCurrentRecording(room, session)) {
          room.currentRecording.eventCount = session.eventCount;
          room.currentRecording.sceneEventCount = Number(session.sceneEventCount || 0);
          room.currentRecording.sceneStatus = session.sceneStatus || '';
          room.currentRecording.capturedDanmakuCount = session.capturedDanmakuCount;
          room.currentRecording.danmakuStatus = 'connected';
          room.currentRecording.danmakuMessage = `已捕获 ${session.eventCount} 条可烧录事件`;
          room.currentRecording.danmakuDropCounts = { ...session.danmakuDropCounts };
        }
        this.updateLiveDiagnosticsFromSession(room, session);
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
    session.danmakuReconnectCount = Number(session.danmakuReconnectCount || 0) + 1;
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

      if (!session.mediaClock && now - Number(session.ffmpegSpawnAt || session.startedAt || now) >= NO_MEDIA_TIMEOUT_MS) {
        session.noMediaDetected = true;
        session.segmentReason = 'no-media-progress';
        this.recordStreamHealth(session.liveSessionId, session.stream, session.segmentReason);
        this.log(
          'error',
          `${roomLabel(room)} 录制 ${Math.round(NO_MEDIA_TIMEOUT_MS / 1000)} 秒仍未产生可用媒体进度（当前 ${formatBytes(fileSize)}），正在重连直播流。`
        );
        requestFfmpegStop(session.ffmpeg, { graceful: false, timeoutMs: 1500 });
        return;
      }

      if (session.mediaClock && now - Number(session.lastMediaProgressAt || session.ffmpegSpawnAt || now) >= MEDIA_PROGRESS_STALL_TIMEOUT_MS) {
        session.mediaStalled = true;
        session.segmentReason = 'no-media-progress';
        this.recordStreamHealth(session.liveSessionId, session.stream, session.segmentReason);
        this.log(
          'error',
          `${roomLabel(room)} FFmpeg ${Math.round(MEDIA_PROGRESS_STALL_TIMEOUT_MS / 1000)} 秒没有媒体进度，正在重连直播流。`
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
    const nowMono = monotonicNowMs();
    if (Number(session.lastStreamSwitchMono || 0) && nowMono - Number(session.lastStreamSwitchMono) < QUALITY_SWITCH_COOLDOWN_MS) {
      return;
    }
    const previousStream = session.stream ? { ...session.stream } : null;
    const nextStream = await this.resolvePlayStream(room, {
      purpose: '清晰度升级检查',
      liveSessionId: session.liveSessionId
    });
    if (!nextStream?.url || !previousStream?.url) {
      return;
    }
    const betterQuality = Number(nextStream.qn || 0) > currentQn;
    if (!betterQuality) {
      room.stream = previousStream;
      session.qualityCandidate = null;
      session.qualityCandidateConfirmations = 0;
      return;
    }
    const candidateKey = `${nextStream.qn}|${nextStream.codec}|${nextStream.protocol}|${nextStream.format}|${this.getStreamHealthKey(nextStream)}`;
    if (session.qualityCandidate === candidateKey) {
      session.qualityCandidateConfirmations = Number(session.qualityCandidateConfirmations || 0) + 1;
    } else {
      session.qualityCandidate = candidateKey;
      session.qualityCandidateConfirmations = 1;
    }
    if (session.qualityCandidateConfirmations < QUALITY_UPGRADE_CONFIRMATIONS) {
      room.stream = previousStream;
      this.log(
        'info',
        `${roomLabel(room)} 发现更高 qn ${currentQn || '未知'} -> ${nextStream.qn || '未知'}，等待第 ${QUALITY_UPGRADE_CONFIRMATIONS} 次稳定确认。`
      );
      return;
    }
    session.nextStream = { ...nextStream };
    session.qualitySwitching = true;
    session.segmentReason = 'quality-upgrade';
    session.lastStreamSwitchMono = nowMono;
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
    session.segmentReason = 'duration-limit';
    this.transitionRecordingState(room, session, 'rotating');
    this.log('info', `${roomLabel(room)} 已达到 ${session.segmentMinutes} 分钟分段时长，正在切换到新文件。`);
    requestFfmpegStop(session.ffmpeg, { graceful: true, timeoutMs: 5000 });
    this.emitState();
    return this.getState();
  }

  async stopRecording(roomId) {
    const room = this.getRoom(roomId);
    const session = this.recordingSessions.get(room.id);
    if (!session) {
      const retryTimer = this.streamStartRetryTimers.get(room.id);
      if (retryTimer) clearTimeout(retryTimer);
      this.streamStartRetryTimers.delete(room.id);
      this.streamStartRetryRooms.delete(room.id);
      if (room.recordingState === 'waiting-stream') room.recordingState = 'completed';
      return this.getState();
    }
    session.stopping = true;
    this.transitionRecordingState(room, session, 'finalizing');
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
    this.transitionRecordingState(room, session, 'finalizing');
    session.danmakuClient?.close('录制结束');
    await Promise.all([
      new Promise((resolve) => session.eventStream.end(resolve)),
      new Promise((resolve) => session.sceneStream ? session.sceneStream.end(resolve) : resolve())
    ]);
    const avatarsDrained = await this.flushAvatarCapture(session);
    await this.scheduleAvatarManifestWrite(session, 'completed').catch((error) => {
      this.log('warn', `${roomLabel(room)} 写入最终头像记录清单失败：${error.message}`);
    });
    if (!avatarsDrained) {
      this.log('warn', `${roomLabel(room)} 头像记录仍有任务未完成，已保存已抓取的头像；未完成项将在烧录时使用回退图标。`);
    }
    if (wasActiveSession) {
      room.recording = false;
    }
    const wallElapsedSec = Math.max(0, (Date.now() - session.startedAt) / 1000);
    const elapsedSec = this.getSessionMediaDurationSec(session);
    const shouldContinueSegment =
      wasActiveSession &&
      (session.rotating || session.qualitySwitching || hasReachedSegmentLimit(session, elapsedSec)) &&
      !session.stopping;
    if (!shouldContinueSegment && wasActiveSession && !session.stopping) {
      if (!session.segmentReason || session.segmentReason === 'initial') {
        session.segmentReason = session.noMediaDetected || session.mediaStalled
          ? 'no-media-progress'
          : code === 0
            ? 'stream-eof'
            : 'network-error';
      }
      this.recordStreamHealth(session.liveSessionId, session.stream, session.segmentReason);
    }
    if (shouldContinueSegment) {
      session.releaseMediaJob?.();
      this.recordingSessions.delete(roomId);
      await this.startNextSegmentNow(room, session);
    }
    const capturePath = session.capturePath || session.cleanPath;
    const capturePathExists = capturePath !== session.cleanPath && (await isExistingFile(capturePath));
    const fileSizeBeforeFinalize = await getFileSize(capturePath);
    const discardStartupSegment = Boolean(session.discardStartupSegment);
    const validBeforeFinalize =
      !discardStartupSegment &&
      isRecordingFileLikelyPlayable({
        fileSize: fileSizeBeforeFinalize,
        elapsedSec: wallElapsedSec,
        videoInfo: session.videoInfo
      });
    if (!validBeforeFinalize) {
      session.containerStage = 'failed';
      session.validReason = discardStartupSegment
        ? '起始关键帧出现损坏包，已丢弃该分段并重新连接直播流。'
        : `临时文件过小或没有解析到视频流：${formatBytes(fileSizeBeforeFinalize)}`;
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
    let timelineHealth = null;
    if (finalized && mediaInfo.videoInfo) {
      try {
        timelineHealth = await probeMediaTimelineHealth(this.ffmpegPath, session.cleanPath, mediaInfo, { timeoutMs: 120000 });
        session.firstVideoPts = timelineHealth.firstVideoPts;
        session.firstAudioPts = timelineHealth.firstAudioPts;
        if (timelineHealth.timelineHealth !== 'healthy') {
          this.log(
            timelineHealth.timelineHealth === 'broken' ? 'error' : 'warn',
            `${roomLabel(room)} 分段时间轴检查为 ${timelineHealth.timelineHealth}：${timelineHealth.warnings.join('；') || '媒体时间轴异常'}`
          );
        }
      } catch (error) {
        timelineHealth = {
          timelineHealth: 'warning',
          warnings: [`时间轴检查失败：${error.message}`],
          videoDurationSec: Number(mediaInfo.durationSec || 0),
          audioDurationSec: 0,
          avDeltaSec: 0
        };
        this.log('warn', `${roomLabel(room)} 分段时间轴检查失败：${error.message}`);
      }
    }
    const actualDurationSec = resolveReliableDurationSec({
      mediaDurationSec: mediaInfo.durationSec,
      elapsedSec,
      segmentDurationSec: session.segmentDurationSec
    });
    const valid =
      !discardStartupSegment &&
      isRecordingFileLikelyPlayable({
        fileSize,
        elapsedSec: wallElapsedSec,
        videoInfo: session.videoInfo
      }) &&
      finalized;
    if (valid) {
      try {
        const sceneResult = await this.finalizeSceneGraphForRecording(
          {
            cleanPath: session.cleanPath,
            danmakuPath: session.danmakuPath,
            avatarManifestPath: session.avatarManifestPath,
            sceneCachePath: session.sceneCachePath,
            scenePath: session.scenePath,
            durationSec: actualDurationSec,
            videoInfo: session.videoInfo
          },
          { durationSec: actualDurationSec }
        );
        session.sceneStatus = 'ready';
        session.sceneEventCount = sceneResult.eventCount;
      } catch (error) {
        session.sceneStatus = 'degraded';
        this.log('warn', roomLabel(room) + ' Scene Graph 收尾失败；原始 clean 视频、JSONL 与头像资源均已保留：' + error.message);
      }
    }
    if (!valid && !session.validReason) {
      session.containerStage = 'failed';
      session.validReason = finalized
        ? `最终文件过小或没有视频流：${formatBytes(fileSize)}`
        : '最终 MP4 封装失败，已保留临时文件。';
    }
    session.streamMetadata = {
      ...session.streamMetadata,
      codec: String(session.videoInfo?.codec || session.streamMetadata?.codec || ''),
      width: Number(session.videoInfo?.width || 0),
      height: Number(session.videoInfo?.height || 0),
      fps: Number(session.videoInfo?.fps || 0),
      ffmpegStartTime: Number(session.ffmpegSpawnAt || 0),
      firstMediaProgressTime: Number(session.firstMediaProgressAt || 0),
      firstMediaOutTimeSec: Number(session.firstMediaOutTimeSec || 0),
      firstVideoPts: timelineHealth?.firstVideoPts ?? null,
      firstAudioPts: timelineHealth?.firstAudioPts ?? null,
      segmentDurationSec: actualDurationSec,
      configuredSegmentDurationSec: Number(session.segmentDurationSec || 0),
      segmentTargetDurationSec: Number(session.segmentDurationSec || 0),
      reconnectReason: session.segmentReason || 'initial'
    };
    const danmakuDurationSec = await readDanmakuDurationSec(session.danmakuPath).catch(() => 0);
    const finishedRecording = {
      startedAt: session.startedAt,
      liveSessionId: session.liveSessionId,
      cleanPath: session.cleanPath,
      danmakuPath: session.danmakuPath,
      avatarManifestPath: session.avatarManifestPath,
      sceneCachePath: session.sceneCachePath,
      scenePath: session.scenePath,
      sceneStatus: session.sceneStatus || '',
      cssPath: session.cssPath,
      assPath: session.assPath,
      burnedPath: session.burnedPath,
      capturePath: session.capturePath,
      containerStage: valid ? 'ready' : session.containerStage || 'failed',
      validReason: valid ? '' : session.validReason,
      mergeGroup: session.mergeGroup,
      mergeSequence: session.mergeSequence,
      mergeOutputPath: session.mergeOutputPath,
      segmentReason: session.segmentReason || 'initial',
      diagnosticsPath: session.diagnosticsPath,
      durationSec: actualDurationSec,
      danmakuDurationSec,
      fileSize,
      valid,
      eventCount: session.eventCount,
      sceneEventCount: Number(session.sceneEventCount || 0),
      rawDanmakuCount: session.rawDanmakuCount,
      capturedDanmakuCount: session.capturedDanmakuCount || session.eventCount,
      danmakuStatus: session.danmakuStatus,
      danmakuMessage: session.danmakuMessage,
      danmakuPopularity: session.danmakuPopularity,
      ignoredDanmakuCount: session.ignoredCommandCount,
      danmakuCommandCounts: session.danmakuCommandCounts,
      danmakuDropCounts: session.danmakuDropCounts,
      videoInfo: session.videoInfo,
      timingInfo: timelineHealth
        ? {
            videoDurationSec: Number(timelineHealth.videoDurationSec || 0),
            audioDurationSec: Number(timelineHealth.audioDurationSec || 0),
            avDeltaSec: Number(timelineHealth.avDeltaSec || 0),
            timingSafeForCopy: Boolean(timelineHealth.timingSafeForCopy)
          }
        : null,
      timelineHealth,
      timelineHealthStatus: String(timelineHealth?.timelineHealth || ''),
      streamMetadata: session.streamMetadata,
      recordingState: valid ? 'completed' : 'failed'
    };
    session.state = finishedRecording.recordingState;
    if (this.shouldUpdateCurrentRecording(room, session)) {
      Object.assign(room.currentRecording, finishedRecording);
      room.recordingState = session.state;
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
    await this.appendSegmentDiagnostics(room, session, finishedRecording).catch((error) => {
      this.log('warn', `${roomLabel(room)} 写入本场 diagnostics 失败：${error.message}`);
    });
    if (discardStartupSegment || fileSizeBeforeFinalize === 0) {
      const cleanupResult = await this.cleanupEmptyCaptureArtifacts(session, { force: discardStartupSegment });
      if (cleanupResult.deletedCount > 0) {
        this.log(
          'info',
          `${roomLabel(room)} 已清理${discardStartupSegment ? '起始损坏' : '未写入媒体的空'}临时录像及其 sidecar ${cleanupResult.deletedCount} 个。`
        );
      }
      if (cleanupResult.failedCount > 0) {
        this.log('warn', `${roomLabel(room)} 有 ${cleanupResult.failedCount} 个临时录像 sidecar 未能删除。`);
      }
    }
    const unexpectedStreamEnd = wasActiveSession && !session.stopping && !shouldContinueSegment;
    const shouldReconnectLiveStream = unexpectedStreamEnd && room.monitoring && room.liveStatus === 1;
    if (shouldReconnectLiveStream) {
      this.reconnectPendingRooms.add(roomId);
      room.recordingState = 'reconnecting';
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
          liveSessionId: session.liveSessionId,
          diagnosticsPath: session.diagnosticsPath,
          segmentReason: session.segmentReason || 'stream-eof',
          lastStreamSwitchMono: session.lastStreamSwitchMono,
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
      liveSessionId: session.liveSessionId,
      diagnosticsPath: session.diagnosticsPath,
      segmentReason: session.segmentReason || (session.qualitySwitching ? 'quality-upgrade' : 'duration-limit'),
      lastStreamSwitchMono: session.lastStreamSwitchMono,
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
  getMergeRetryKey(roomId, mergeGroup) {
    return `${String(roomId || '')}\u0000${String(mergeGroup || '').trim()}`;
  }

  getMergeRetryDelayMs(attempt) {
    return MERGE_RETRY_DELAYS_MS[Math.max(0, Number(attempt || 1) - 1)] || 0;
  }

  clearMergeRetryState(roomId, mergeGroup) {
    const key = this.getMergeRetryKey(roomId, mergeGroup);
    const state = this.mergeRetryStates.get(key);
    if (!state) return false;
    clearTimeout(state.timer);
    this.mergeRetryStates.delete(key);
    return true;
  }

  clearMergeRetryStatesForRoom(roomId) {
    const roomKey = String(roomId || '');
    let cleared = 0;
    for (const [key, state] of this.mergeRetryStates) {
      if (String(state.roomId || '') !== roomKey) continue;
      clearTimeout(state.timer);
      this.mergeRetryStates.delete(key);
      cleared += 1;
    }
    return cleared;
  }

  async getPendingMergeGroupForRoom(room) {
    if (!room?.id) return null;
    const roomId = String(room.id);
    const groups = new Map();
    for (const recording of this.recordings) {
      const groupId = String(recording?.mergeGroup || '').trim();
      if (
        !groupId ||
        String(recording?.roomId || '') !== roomId ||
        recording?.mergedFrom?.length ||
        recording?.valid === false ||
        !recording?.cleanPath ||
        recording.cleanPath === recording.mergeOutputPath
      ) {
        continue;
      }
      const group = groups.get(groupId) || [];
      group.push(recording);
      groups.set(groupId, group);
    }
    const candidates = [...groups.entries()]
      .flatMap(([mergeGroup, groupSegments]) => {
        const allSegments = groupSegments.sort((left, right) => {
          const sequenceDiff = Number(left.mergeSequence || 0) - Number(right.mergeSequence || 0);
          return sequenceDiff || Number(left.startedAt || 0) - Number(right.startedAt || 0);
        });
        return this.getPartialReconnectClusters(allSegments).map((segments) => ({ mergeGroup, allSegments, segments }));
      })
      .sort((left, right) => Number(right.segments.at(-1)?.startedAt || 0) - Number(left.segments.at(-1)?.startedAt || 0));
    for (const candidate of candidates) {
      const outputPath = this.getReconnectMergeOutputPath(candidate.allSegments, candidate.segments);
      if (await isExistingFile(outputPath)) continue;
      const exists = await Promise.all(candidate.segments.map((segment) => isExistingFile(segment.cleanPath)));
      if (!exists.every(Boolean)) continue;
      return {
        mergeGroup: candidate.mergeGroup,
        fallbackRecording: candidate.segments.at(-1)
      };
    }
    return null;
  }

  scheduleMergeRetry(room, mergeGroup, fallbackRecording, error, options = {}) {
    const groupId = String(mergeGroup || '').trim();
    if (
      !room?.id ||
      !groupId ||
      this.draining ||
      this.removingRoomIds.has(room?.id) ||
      this.mergeCancelRequests.has(room.id) ||
      isFfmpegMemoryPressureError(error) ||
      error?.code === 'MERGE_SEGMENT_UNDECODABLE'
    ) {
      if (room?.id && groupId) this.clearMergeRetryState(room.id, groupId);
      return false;
    }
    const key = this.getMergeRetryKey(room.id, groupId);
    const existing = this.mergeRetryStates.get(key);
    if (existing?.timer) return true;
    const attempts = Number(existing?.attempts || 0) + 1;
    if (attempts > MERGE_RETRY_DELAYS_MS.length) {
      this.clearMergeRetryState(room.id, groupId);
      if (room.mergeProgress?.kind === 'merge') {
        room.mergeProgress.status = 'error';
        room.mergeProgress.message = `合并自动重试 ${MERGE_RETRY_DELAYS_MS.length} 次后仍未完成；所有源分段均已保留，可手动重新尝试。`;
        room.mergeProgress.updatedAt = Date.now();
      }
      this.log('error', `${roomLabel(room)} 合并自动重试 ${MERGE_RETRY_DELAYS_MS.length} 次后仍未完成；源分段未删除。`);
      this.emitState();
      return false;
    }
    const delayMs = Math.max(0, Number(options.delayMs ?? this.getMergeRetryDelayMs(attempts)) || 0);
    const outputPath =
      room.mergeProgress?.outputPath || fallbackRecording?.mergeOutputPath || deriveSiblingPath(fallbackRecording?.cleanPath || '', 'merged');
    if (!room.mergeProgress || room.mergeProgress.kind !== 'merge') {
      room.mergeProgress = createFfmpegJobProgress({
        kind: 'merge',
        label: `合并续录分段：${path.basename(outputPath)}`,
        outputPath,
        durationSec: 0,
        roomId: room.id
      });
    }
    room.mergeProgress.status = 'retrying';
    room.mergeProgress.estimatedRemainingSec = Math.ceil(delayMs / 1000);
    room.mergeProgress.message = `合并失败，将在 ${formatDurationSeconds(Math.ceil(delayMs / 1000))}后自动重试（${attempts}/${MERGE_RETRY_DELAYS_MS.length}）；源分段已保留。`;
    room.mergeProgress.updatedAt = Date.now();
    const state = {
      roomId: room.id,
      mergeGroup: groupId,
      fallbackRecording,
      attempts,
      timer: null,
      lastError: compactLogLine(error?.message || '未知合并错误')
    };
    this.mergeRetryStates.set(key, state);
    this.log(
      'warn',
      `${roomLabel(room)} 合并失败，${formatDurationSeconds(Math.ceil(delayMs / 1000))}后自动重试（${attempts}/${MERGE_RETRY_DELAYS_MS.length}）；源分段已保留。`
    );
    this.emitState();
    state.timer = setTimeout(() => {
      if (this.mergeRetryStates.get(key) !== state || this.draining || this.mergeCancelRequests.has(room.id)) return;
      state.timer = null;
      this.log('info', `${roomLabel(room)} 正在自动重试合并续录分段（${attempts}/${MERGE_RETRY_DELAYS_MS.length}）。`);
      this.finalizeReconnectGroup(room, groupId, fallbackRecording).catch((retryError) => {
        this.log('warn', `${roomLabel(room)} 自动重试合并未立即完成：${retryError.message}`);
      });
    }, delayMs);
    state.timer.unref?.();
    return true;
  }

  async resumePendingMergeRetries() {
    if (this.draining) return 0;
    let scheduled = 0;
    for (const room of this.rooms.values()) {
      if (this.isRoomRecording(room) || this.mergeProcesses.has(room.id)) continue;
      const pending = await this.getPendingMergeGroupForRoom(room);
      if (!pending) continue;
      const didSchedule = this.scheduleMergeRetry(
        room,
        pending.mergeGroup,
        pending.fallbackRecording,
        new Error('启动后发现未完成的续录分段合并'),
        { delayMs: MERGE_STARTUP_RETRY_DELAY_MS }
      );
      if (didSchedule) scheduled += 1;
    }
    if (scheduled) {
      this.log('info', `已恢复 ${scheduled} 个未完成的续录分段合并任务，将自动重试。`);
    }
    return scheduled;
  }

  async retryMerge(roomId) {
    const room = this.getRoom(roomId);
    if (this.mergeProcesses.has(room.id) || [...this.mergeInFlightGroups.keys()].some((key) => key.startsWith(`${room.id}\u0000`))) {
      throw businessError('MERGE_ALREADY_RUNNING', '当前已有合并任务在运行，请稍候。', 409);
    }
    const pending = await this.getPendingMergeGroupForRoom(room);
    if (!pending) {
      throw businessError('MERGE_TASK_NOT_FOUND', '没有找到可重新合并的完整源分段。', 404);
    }
    this.clearMergeRetryState(room.id, pending.mergeGroup);
    if (room.mergeProgress?.kind === 'merge') {
      room.mergeProgress.status = 'running';
      room.mergeProgress.message = '正在手动重新尝试合并，源分段会继续保留到合并成功。';
      room.mergeProgress.updatedAt = Date.now();
    }
    this.log('info', `${roomLabel(room)} 已开始手动重新尝试合并续录分段。`);
    this.emitState();
    this.finalizeReconnectGroup(room, pending.mergeGroup, pending.fallbackRecording).catch(() => {
      // finalizeReconnectGroup has updated the visible failure/retry state.
    });
    return this.getState();
  }

  async finalizeReconnectGroup(room, mergeGroup, fallbackRecording) {
    if (!room?.id || this.removingRoomIds.has(room.id) || !this.rooms.has(room.id)) {
      return null;
    }
    let recording;
    try {
      recording = await this.mergeReconnectGroupIfNeeded(room, mergeGroup, fallbackRecording);
    } catch (error) {
      this.scheduleMergeRetry(room, mergeGroup, fallbackRecording, error);
      throw error;
    }
    this.clearMergeRetryState(room.id, mergeGroup);
    if (room.mergeProgress?.kind === 'merge' && room.mergeProgress.status === 'cancelled') {
      // A cancellation deliberately leaves the reconnect group untouched. In
      // particular, do not finalize the live-session diagnostics or enqueue a
      // burn for only the last source segment.
      return null;
    }
    if (recording) {
      await this.finalizeLiveDiagnostics(room, recording, recording.mergedFrom?.length ? 'merged' : 'completed').catch((error) => {
        this.log('warn', `${roomLabel(room)} 写入最终 diagnostics 失败：${error.message}`);
      });
    }
    if (
      this.settings.autoBurnDanmaku &&
      this.settings.sceneGraphCaptureMode !== 'cache-only' &&
      recording?.valid !== false &&
      Number(recording?.eventCount || 0) > 0
    ) {
      setTimeout(() => {
        this.enqueueBurnRecording(room, recording, {
          automatic: true,
          deleteSourceAfterSuccess: false
        }).catch((error) => {
          this.log('error', `${roomLabel(room)} 自动烧录失败：${error.message}`);
        });
      }, 500);
    } else {
      this.scheduleQueuedUpdateCheck();
    }
    const liveSessionId = String(recording?.liveSessionId || fallbackRecording?.liveSessionId || '');
    if (liveSessionId) {
      this.liveDanmakuDedupers.delete(liveSessionId);
      this.liveStreamHealth.delete(liveSessionId);
      this.liveDiagnostics.delete(liveSessionId);
    }
    if (recording?.mergedFrom?.length) {
      setImmediate(() => {
        this.resumePendingMergeRetries().catch((error) => {
          this.log('warn', `继续恢复遗留续录分段合并失败：${error.message}`);
        });
      });
    }
    return recording;
  }

  setMergeProgressStage(room, progress, stageLabel, startedAt = Date.now()) {
    if (room.mergeProgress?.id !== progress?.id) {
      return false;
    }
    const elapsedSec = Math.max(0, Math.floor((Date.now() - Number(startedAt || Date.now())) / 1000));
    progress.stageLabel = String(stageLabel || '').trim();
    progress.stageStartedAt = Number(startedAt || Date.now());
    if (!progress.workStartedAt && progress.status === 'running') {
      // Before a media lease is obtained this is preparation, not a measurable
      // encoding percentage. Showing a static 0% made a queued merge look hung.
      progress.percent = null;
      progress.estimatedRemainingSec = null;
    }
    progress.updatedAt = Date.now();
    progress.message =
      progress.stageLabel + (elapsedSec >= 2 ? '（已用' + formatDurationSeconds(elapsedSec) + '）' : '');
    this.markRoomDirty(room.id);
    return true;
  }

  getMediaJobRoomLabel(job) {
    const match = /^recording:([^:]+):/.exec(String(job?.id || ''));
    const room = match ? this.rooms.get(match[1]) : null;
    return room ? roomLabel(room) : '其他直播录制';
  }

  getMergeMediaWaitDetails(resources, progressId) {
    const jobs = this.mediaJobs.snapshot();
    const requiredSlots = normalizeResourceSlots(resources);
    const overlaps = (job) => {
      const jobSlots = Array.isArray(job.resources) ? job.resources : normalizeResourceSlots(job.resource);
      return requiredSlots.some((slot) => jobSlots.includes(slot));
    };
    const queued = jobs.filter((job) => job.status === 'queued' && overlaps(job));
    const ownIndex = queued.findIndex((job) => job.id === progressId);
    const recordingLabels =
      requiredSlots.includes('cpuEncode') || requiredSlots.includes('gpuComposite')
        ? [
            ...new Set(
              jobs
                .filter((job) => job.status === 'running' && job.type === 'recording')
                .map((job) => this.getMediaJobRoomLabel(job))
            )
          ]
        : [];
    const activeSameResource = jobs.filter(
      (job) =>
        job.status === 'running' && overlaps(job) && job.id !== progressId && job.type !== 'recording'
    );
    return {
      queuePosition: ownIndex >= 0 ? ownIndex + 1 : 1,
      recordingLabels,
      activeSameResource
    };
  }

  setMergeQueuedProgress(room, progress, resources, queuedAt) {
    if (room.mergeProgress?.id !== progress?.id) {
      return false;
    }
    const elapsedSec = Math.max(0, Math.floor((Date.now() - Number(queuedAt || Date.now())) / 1000));
    const details = this.getMergeMediaWaitDetails(resources, progress.id);
    const resourceLabel = normalizeResourceSlots(resources)
      .map((slot) =>
        ({
          network: '网络',
          disk: '磁盘',
          diskRead: '磁盘读取',
          diskWrite: '磁盘写入',
          cpuEncode: 'CPU 编码',
          gpuEncode: 'GPU 编码',
          gpuComposite: 'GPU 合成'
        })[slot] || slot
      )
      .join(' / ');
    const waits = [];
    if (details.recordingLabels.length) {
      waits.push(`录制优先：${details.recordingLabels.join('、')}`);
    }
    if (details.activeSameResource.length) {
      waits.push(`正在处理 ${details.activeSameResource.length} 个${resourceLabel}任务`);
    }
    waits.push(`合并队列第 ${details.queuePosition} 位`);
    progress.status = 'queued';
    progress.stageLabel = '正在等待可用媒体资源';
    progress.stageStartedAt = Number(queuedAt || Date.now());
    progress.updatedAt = Date.now();
    progress.message =
      `正在等待可用媒体资源（${waits.join('；')}）` +
      (elapsedSec >= 2 ? `（已等${formatDurationSeconds(elapsedSec)}）` : '');
    this.emitState(['room', 'mediaJob']);
    return true;
  }

  async acquireMergeMediaLease(room, progress, mergeEncoderPlan) {
    const resourcePlan = mergeEncoderPlan.requiresTranscode
      ? this.getTranscodeResourcePlan(mergeEncoderPlan.preferred, mergeEncoderPlan.videoInfo)
      : { resources: ['diskRead', 'diskWrite'], resourceCosts: { diskRead: 2, diskWrite: 2 } };
    const resources = resourcePlan.resources;
    const queuedAt = Date.now();
    const leasePromise = this.mediaJobs.acquire({
      id: progress.id,
      type: 'merge',
      ...resourcePlan,
      cancel: () => {
        this.mergeCancelRequests.add(room.id);
        const child = this.mergeProcesses.get(room.id);
        if (child) requestFfmpegStop(child, { graceful: false, timeoutMs: 1500 });
      }
    });
    this.setMergeQueuedProgress(room, progress, resources, queuedAt);
    const heartbeat = setInterval(() => {
      this.setMergeQueuedProgress(room, progress, resources, queuedAt);
    }, MERGE_STAGE_HEARTBEAT_MS);
    heartbeat.unref?.();
    try {
      const lease = await leasePromise;
      if (this.mergeCancelRequests.has(room.id)) {
        lease.release();
        return null;
      }
      if (room.mergeProgress?.id === progress.id) {
        const workStartedAt = Date.now();
        progress.status = 'running';
        progress.workStartedAt = workStartedAt;
        progress.currentTimeSec = 0;
        progress.percent = progress.durationSec > 0 ? 0 : null;
        progress.estimatedRemainingSec = null;
        progress.stageLabel = '已取得媒体资源，准备开始合并';
        progress.stageStartedAt = workStartedAt;
        progress.message = '已取得媒体资源，正在启动合并';
        progress.updatedAt = workStartedAt;
        this.emitState(['room', 'mediaJob']);
      }
      return lease;
    } finally {
      clearInterval(heartbeat);
    }
  }

  async runMergePreparationStage(room, progress, stageLabel, operation) {
    const startedAt = Date.now();
    this.setMergeProgressStage(room, progress, stageLabel, startedAt);
    const heartbeat = setInterval(() => {
      this.setMergeProgressStage(room, progress, stageLabel, startedAt);
    }, MERGE_STAGE_HEARTBEAT_MS);
    heartbeat.unref?.();
    try {
      return await operation();
    } finally {
      clearInterval(heartbeat);
    }
  }

  async mergeReconnectGroupIfNeeded(room, mergeGroup, fallbackRecording) {
    const groupId = String(mergeGroup || '').trim();
    if (!groupId) {
      return fallbackRecording;
    }
    const key = this.getMergeRetryKey(room?.id, groupId);
    const existing = this.mergeInFlightGroups.get(key);
    if (existing) {
      return existing;
    }
    const task = this.mergeReconnectGroupIfNeededInternal(room, groupId, fallbackRecording);
    this.mergeInFlightGroups.set(key, task);
    try {
      return await task;
    } finally {
      if (this.mergeInFlightGroups.get(key) === task) {
        this.mergeInFlightGroups.delete(key);
      }
    }
  }

  async mergeReconnectGroupIfNeededInternal(room, mergeGroup, fallbackRecording) {
    const groupId = String(mergeGroup || '').trim();
    if (!groupId) {
      return fallbackRecording;
    }
    const segmentCandidates = this.recordings
      .filter((recording) => recording.mergeGroup === groupId && !recording.mergedFrom?.length)
      .filter((recording) => recording.valid !== false)
      .filter((recording) => recording.cleanPath && recording.cleanPath !== recording.mergeOutputPath);
    const segmentExists = await Promise.all(segmentCandidates.map((recording) => isExistingFile(recording.cleanPath)));
    const allSegments = segmentCandidates
      .filter((_recording, index) => segmentExists[index])
      .sort((a, b) => {
        const sequenceDiff = Number(a.mergeSequence || 0) - Number(b.mergeSequence || 0);
        return sequenceDiff || Number(a.startedAt || 0) - Number(b.startedAt || 0);
      });
    const segments = this.selectPartialReconnectCluster(allSegments, fallbackRecording);
    if (segments.length < 2) {
      if (allSegments.length >= 2) {
        this.log(
          'info',
          `${roomLabel(room)} 分段规则：达到设定时长的录像将保留为独立文件；仅连续的未满时长续录片段才会自动合并。`
        );
      }
      return fallbackRecording;
    }

    room.recordingState = 'merging';

    const outputPath = this.getReconnectMergeOutputPath(allSegments, segments);
    const container = getContainerFromPath(outputPath);
    const tmpPath = replaceExtension(outputPath, `.tmp.${container}`);
    const concatPath = replaceExtension(outputPath, '.concat.txt');
    const danmakuPath = deriveSiblingPath(outputPath, 'danmaku', 'jsonl');
    const avatarManifestPath = deriveAvatarManifestPath(outputPath);
    const sceneCachePath = deriveSceneCachePath(outputPath);
    const scenePath = deriveSceneGraphPath(outputPath);
    const cssPath = deriveSiblingPath(outputPath, 'danmaku', 'css');
    const danmakuTmpPath = `${danmakuPath}.${process.pid}.tmp`;
    const cssTmpPath = `${cssPath}.${process.pid}.tmp`;
    const assPath = deriveSiblingPath(outputPath, 'danmaku', 'ass');
    const burnedPath = deriveBurnedPath(outputPath, this.settings.burnOverlayMode);
    const fallbackMergeDurationSec = segments.reduce((sum, segment) => sum + Number(segment.durationSec || 0), 0);
    const normalizeTempDir = path.join(
      path.dirname(outputPath),
      `.br2k-merge-${process.pid}-${crypto.randomUUID().slice(0, 8)}`
    );
    const progress = createFfmpegJobProgress({
      kind: 'merge',
      label: '合并续录分段：' + path.basename(outputPath),
      outputPath,
      durationSec: fallbackMergeDurationSec,
      roomId: room.id
    });
    room.mergeProgress = progress;
    this.emitState();
    const segmentMediaInfos = [];
    const segmentTimelineInfos = [];
    for (let index = 0; index < segments.length; index += 1) {
      const segment = segments[index];
      const mediaInfo = await this.runMergePreparationStage(
        room,
        progress,
        '正在读取分段 ' + (index + 1) + '/' + segments.length + ' 的媒体信息',
        () => probeMediaFileInfo(this.ffmpegPath, segment.cleanPath, { timeoutMs: 15000 })
      );
      if (!mediaInfo.videoInfo) {
        throw new Error(`无法读取分段视频信息：${path.basename(segment.cleanPath)}`);
      }
      segmentMediaInfos.push({
        ...mediaInfo,
        durationSec:
          Number(mediaInfo.durationSec) || Number(segment.durationSec) || getSegmentDurationForMerge(segment, segments[index + 1])
      });
      const quickDurationSec = Number(mediaInfo.durationSec || segment.durationSec || 0);
      const recordedTiming =
        segment.timelineHealth && typeof segment.timelineHealth === 'object'
          ? { ...(segment.timingInfo || {}), ...segment.timelineHealth }
          : segment.timingInfo || {};
      const recordedVideoDurationSec = getMergeSegmentVideoDurationSec(
        recordedTiming,
        mediaInfo,
        segment,
        segments[index + 1]
      );
      const recordedAudioDurationSec = Number(recordedTiming.audioDurationSec || 0);
      segmentTimelineInfos.push({
        ...recordedTiming,
        containerDurationSec: quickDurationSec,
        videoDurationSec: recordedVideoDurationSec || quickDurationSec,
        audioDurationSec: mediaInfo.audioInfo ? recordedAudioDurationSec || quickDurationSec : 0,
        avDeltaSec: Number(recordedTiming.avDeltaSec || 0),
        containerDeltaSec: 0,
        timingSafeForCopy: recordedTiming.timingSafeForCopy !== false,
        auditMode: recordedTiming.timelineHealth ? 'recorded' : 'metadata'
      });
    }
    let mergeDurationSec =
      segmentTimelineInfos.reduce(
        (sum, timingInfo, index) =>
          sum + getMergeSegmentVideoDurationSec(timingInfo, segmentMediaInfos[index], segments[index], segments[index + 1]),
        0
      ) ||
      fallbackMergeDurationSec;
    const targetVideoInfo = selectHighestResolutionVideoInfo(segmentMediaInfos);
    if (!targetVideoInfo) {
      throw new Error('没有找到可用于合并的目标分辨率。');
    }
    const timingAssessments = [];
    for (let index = 0; index < segments.length; index += 1) {
      let assessment = getMergeSegmentTimingAssessment(segments[index], Boolean(segmentMediaInfos[index].audioInfo));
      if (!assessment.known) {
        try {
          const auditedTiming = await this.runMergePreparationStage(
            room,
            progress,
            '正在检查分段 ' + (index + 1) + '/' + segments.length + ' 的音画时间轴',
            () => probeMediaTimelineHealth(this.ffmpegPath, segments[index].cleanPath, segmentMediaInfos[index], { timeoutMs: 120000 })
          );
          auditedTiming.auditMode = 'merge-preflight';
          segments[index].timelineHealth = auditedTiming;
          segments[index].timingInfo = {
            videoDurationSec: Number(auditedTiming.videoDurationSec || 0),
            audioDurationSec: Number(auditedTiming.audioDurationSec || 0),
            avDeltaSec: Number(auditedTiming.avDeltaSec || 0),
            timingSafeForCopy: Boolean(auditedTiming.timingSafeForCopy)
          };
          segmentTimelineInfos[index] = auditedTiming;
          assessment = getMergeSegmentTimingAssessment(segments[index], Boolean(segmentMediaInfos[index].audioInfo));
        } catch (error) {
          const failedTiming = {
            ...segmentTimelineInfos[index],
            timelineHealth: 'warning',
            timingSafeForCopy: false,
            auditMode: 'failed',
            error: error.message
          };
          segments[index].timelineHealth = failedTiming;
          segments[index].timingInfo = failedTiming;
          segmentTimelineInfos[index] = failedTiming;
          assessment = getMergeSegmentTimingAssessment(segments[index], Boolean(segmentMediaInfos[index].audioInfo));
          this.log('warn', roomLabel(room) + ' 分段 ' + (index + 1) + '/' + segments.length + ' 音画预检失败，将安全规范化：' + error.message);
        }
      }
      timingAssessments.push(assessment);
    }
    mergeDurationSec =
      segmentTimelineInfos.reduce(
        (sum, timingInfo, index) =>
          sum + getMergeSegmentVideoDurationSec(timingInfo, segmentMediaInfos[index], segments[index], segments[index + 1]),
        0
      ) ||
      fallbackMergeDurationSec;
    progress.durationSec = mergeDurationSec;
    progress.currentTimeSec = 0;
    progress.percent = mergeDurationSec > 0 ? 0 : null;
    this.setMergeProgressStage(room, progress, '分段预检完成，正在准备合并');
    const streamSpecsChanged = shouldTranscodeConcat(segmentMediaInfos);
    const timingRequiresNormalization = timingAssessments.some((assessment) => assessment.requiresNormalization);
    const timingIssueSummary = timingAssessments
      .map((assessment, index) => (assessment.requiresNormalization ? '#' + (index + 1) + ' ' + assessment.reason : ''))
      .filter(Boolean);
    const timingAdvisorySummary = timingAssessments
      .map((assessment, index) =>
        assessment.requiresPostMergeVerification ? '#' + (index + 1) + ' ' + assessment.reason : ''
      )
      .filter(Boolean);
    const requiresTranscode = streamSpecsChanged || timingRequiresNormalization;
    // Tracks whether this merge has already used the timestamp-preserving
    // normalizer. A copy concat that fails final timing validation gets one
    // safe retry; we never "fix" it later by warping the completed audio.
    let usedTimelinePreservingNormalization = requiresTranscode;
    const mergePlanReason = [
      streamSpecsChanged ? '分辨率、帧率或编码规格变化' : '',
      timingRequiresNormalization ? '单段音画时间轴风险（' + timingIssueSummary.join('；') + '）' : ''
    ]
      .filter(Boolean)
      .join('；');
    if (timingAdvisorySummary.length) {
      this.log(
        'info',
        `${roomLabel(room)} 分段时间轴提示：${timingAdvisorySummary.join('；')}。仅 PTS 起点偏移不会再触发规范化重编码。`
      );
    }
    assertSafeMergeTargetProfile(segmentMediaInfos, targetVideoInfo, { requiresVideoTranscode: requiresTranscode });
    await this.waitForRuntimeCapabilities();
    const mergeEncoderPlan = this.getMergeEncoderPlan(targetVideoInfo);
    mergeEncoderPlan.requiresTranscode = requiresTranscode;
    progress.codec = mergeEncoderPlan.preferred;
    progress.codecKind = mergeEncoderPlan.preferred.includes('libx') ? 'software' : 'hardware';
    progress.encoderBackend = this.getEncoderBackendLabel(this.getBurnCodecInfo(mergeEncoderPlan.preferred));
    const segmentFileSizes = await Promise.all(segments.map((segment) => getFileSize(segment.cleanPath)));
    const sourceBytes = segmentFileSizes.reduce((sum, fileSize) => sum + Number(fileSize || 0), 0);
    const targetPixels = Number(targetVideoInfo.width || 0) * Number(targetVideoInfo.height || 0);
    const normalizedBytesEstimate = segmentMediaInfos.reduce((sum, mediaInfo, index) => {
      const sourcePixels = Number(mediaInfo?.videoInfo?.width || 0) * Number(mediaInfo?.videoInfo?.height || 0);
      const scaleFactor = targetPixels > 0 && sourcePixels > 0 ? Math.max(1, targetPixels / sourcePixels) : 1;
      return sum + Math.ceil(Number(segmentFileSizes[index] || 0) * scaleFactor);
    }, 0);
    // A cross-spec merge first creates uniform intermediates and only then
    // concat-copies them.  Reserve both the intermediates and the final output
    // up front so a low-disk failure cannot leave a half-written merge behind.
    const boundedTranscodeTemporaryBytes = Math.max(sourceBytes, normalizedBytesEstimate) * 2;
    const estimatedTemporaryBytes = requiresTranscode ? boundedTranscodeTemporaryBytes : sourceBytes;
    await this.runMergePreparationStage(room, progress, '正在检查本次合并的磁盘空间', () =>
      assertDiskSpace(outputPath, { estimatedBytes: estimatedTemporaryBytes })
    );
    if (this.mergeCancelRequests.has(room.id)) {
      if (room.mergeProgress?.id === progress.id) {
        finishFfmpegJobProgress(room.mergeProgress, 'cancelled', '合并已取消，所有源分段均已保留');
      }
      this.mergeCancelRequests.delete(room.id);
      this.emitState(['room', 'mediaJob']);
      return null;
    }
    let mergeLease;
    try {
      mergeLease = await this.acquireMergeMediaLease(room, progress, mergeEncoderPlan);
    } catch (error) {
      if (this.mergeCancelRequests.has(room.id) || error?.code === 'MEDIA_JOB_CANCELLED') {
        if (room.mergeProgress?.id === progress.id) {
          finishFfmpegJobProgress(room.mergeProgress, 'cancelled', '已取消排队合并，所有源分段均已保留');
        }
        this.mergeCancelRequests.delete(room.id);
        this.emitState(['room', 'mediaJob']);
        return null;
      }
      throw error;
    }
    if (!mergeLease) {
      if (room.mergeProgress?.id === progress.id) {
        finishFfmpegJobProgress(room.mergeProgress, 'cancelled', '合并已取消，所有源分段均已保留');
      }
      this.mergeCancelRequests.delete(room.id);
      this.emitState(['room', 'mediaJob']);
      return null;
    }
    this.mergeCancelRequests.delete(room.id);

    this.log(
      'info',
      `${roomLabel(room)} 正在合并 ${segments.length} 个续录片段：${path.basename(outputPath)}。${
        requiresTranscode
          ? `检测到${mergePlanReason}，将逐段重建时间轴并统一为 ${targetVideoInfo.width}x${targetVideoInfo.height}，再无损拼接（临时工作区预留 ${formatBytes(estimatedTemporaryBytes)}）`
          : '各分段规格一致，使用快速无损合并'
      }`
    );
    this.emitState(['room', 'mediaJob']);
    try {
      await fsp.rm(tmpPath, { force: true });
      await fsp.rm(danmakuTmpPath, { force: true });
      await fsp.rm(cssTmpPath, { force: true });
      const mergeSoftwareThreads = Math.max(1, Math.min(2, Math.floor((os.cpus()?.length || 4) / 2)));
      const runMergeFfmpeg = async (args, options = {}) => {
        if (this.mergeCancelRequests.has(room.id)) throw new Error('合并已取消');
        const progressOffsetSec = Math.max(0, Number(options.progressOffsetSec || 0));
        const trackProgress = options.trackProgress !== false;
        const stageLabel = String(options.stageLabel || '合并处理');
        const segmentDurationSec = Math.max(0, Number(options.segmentDurationSec || 0));
        const stageStartedAt = Date.now();
        let child = null;
        let sawMediaProgress = false;
        let lastMediaProgressSec = Number.NEGATIVE_INFINITY;
        let lastMediaProgressAt = stageStartedAt;
        let repeatedDecodeErrorCount = 0;
        let firstRepeatedDecodeErrorAt = 0;
        let lastDecodeWarningAt = 0;
        let forcedFfmpegError = null;
        let lastStageProgressEmitAt = 0;
        const stopStalledAttempt = (code, message) => {
          if (forcedFfmpegError) return;
          forcedFfmpegError = new Error(message);
          forcedFfmpegError.code = code;
          forcedFfmpegError.ffmpegNoProgress = true;
          forcedFfmpegError.ffmpegLastProgressValue = Number.isFinite(lastMediaProgressSec)
            ? lastMediaProgressSec
            : null;
          if (room.mergeProgress?.id === progress.id) {
            room.mergeProgress.message = message;
            room.mergeProgress.updatedAt = Date.now();
          }
          this.log('error', `${roomLabel(room)} ${message}`);
          this.markRoomDirty(room.id);
          requestFfmpegStop(child, { graceful: false, timeoutMs: 1500 });
        };
        const updateWaitingForMedia = () => {
          if (sawMediaProgress || room.mergeProgress?.id !== progress.id) return;
          const now = Date.now();
          const elapsedMs = Math.max(0, now - stageStartedAt);
          const elapsedSec = Math.floor(elapsedMs / 1000);
          if (
            repeatedDecodeErrorCount >= MERGE_REPEATED_DECODE_ERROR_LIMIT &&
            now - Math.max(lastMediaProgressAt, firstRepeatedDecodeErrorAt || 0) >= MERGE_REPEATED_DECODE_ERROR_GRACE_MS
          ) {
            stopStalledAttempt(
              'FFMPEG_DECODE_STALL',
              `${stageLabel}连续遇到 ${repeatedDecodeErrorCount} 次视频解码错误且没有生成画面，已终止当前尝试，正在切换兼容解码。`
            );
            return;
          }
          if (elapsedMs >= MERGE_FIRST_MEDIA_TIMEOUT_MS) {
            stopStalledAttempt(
              'FFMPEG_NO_PROGRESS',
              `${stageLabel}等待 ${Math.ceil(MERGE_FIRST_MEDIA_TIMEOUT_MS / 1000)} 秒仍未生成首帧，已终止当前尝试。`
            );
            return;
          }
          if (forcedFfmpegError) return;
          room.mergeProgress.stageLabel = stageLabel;
          room.mergeProgress.stageStartedAt = stageStartedAt;
          room.mergeProgress.updatedAt = now;
          room.mergeProgress.message =
            stageLabel + '，等待首个媒体时间戳' + (elapsedSec >= 2 ? '（已用' + formatDurationSeconds(elapsedSec) + '）' : '');
          this.markRoomDirty(room.id);
        };
        updateWaitingForMedia();
        const firstProgressHeartbeat = setInterval(updateWaitingForMedia, MERGE_STAGE_HEARTBEAT_MS);
        firstProgressHeartbeat.unref?.();
        try {
          try {
            const onStderr = (line) => {
              const now = Date.now();
              const processedSec = parseFfmpegProgressTime(line);
              if (Number.isFinite(processedSec) && processedSec > lastMediaProgressSec + 0.0001) {
                lastMediaProgressSec = processedSec;
                lastMediaProgressAt = now;
                repeatedDecodeErrorCount = 0;
                firstRepeatedDecodeErrorAt = 0;
              }
              if (Number.isFinite(processedSec) && processedSec > 0.0001 && room.mergeProgress?.id === progress.id) {
                sawMediaProgress = true;
                const localProgressLabel =
                  segmentDurationSec > 0
                    ? `${stageLabel} · 本段 ${formatDurationSeconds(Math.min(segmentDurationSec, Math.max(0, processedSec)))} / ${formatDurationSeconds(segmentDurationSec)}`
                    : stageLabel;
                room.mergeProgress.stageLabel = localProgressLabel;
                room.mergeProgress.stageStartedAt = stageStartedAt;
              }
              if (trackProgress && room.mergeProgress?.id === progress.id) {
                const progressLine = Number.isFinite(processedSec)
                  ? `time=${formatFfmpegSeconds(progressOffsetSec + Math.max(0, processedSec))}`
                  : line;
                if (updateFfmpegJobProgress(room.mergeProgress, progressLine)) {
                  this.markRoomDirty(room.id);
                }
              } else if (Number.isFinite(processedSec) && room.mergeProgress?.id === progress.id) {
                if (now - lastStageProgressEmitAt >= 500) {
                  lastStageProgressEmitAt = now;
                  room.mergeProgress.message =
                    (segmentDurationSec > 0
                      ? `${stageLabel} · 本段 ${formatDurationSeconds(Math.min(segmentDurationSec, Math.max(0, processedSec)))} / ${formatDurationSeconds(segmentDurationSec)}`
                      : stageLabel) + ' · 已处理 ' + formatDurationSeconds(processedSec);
                  room.mergeProgress.updatedAt = now;
                  this.markRoomDirty(room.id);
                }
              }
              const decodeErrorCount = countRepeatedVideoDecodeErrors(line);
              if (decodeErrorCount > 0) {
                repeatedDecodeErrorCount += decodeErrorCount;
                firstRepeatedDecodeErrorAt ||= now;
                if (now - lastDecodeWarningAt >= 5000) {
                  lastDecodeWarningAt = now;
                  this.log(
                    'warn',
                    `${roomLabel(room)} ${stageLabel} 视频解码异常（累计 ${repeatedDecodeErrorCount} 次）：${compactLogLine(line)}`
                  );
                }
              } else if (/error|failed|invalid/i.test(line)) {
                this.log('warn', `${roomLabel(room)} 合并：${compactLogLine(line)}`);
              }
            };
            const onChild = (nextChild) => {
              child = nextChild;
              if (nextChild) this.mergeProcesses.set(room.id, nextChild);
            };
            if (typeof options.run === 'function') {
              await options.run(onStderr, onChild);
            } else {
              await runFfmpegJob(this.ffmpegPath, args, onStderr, {
                onChild,
                progressStallTimeoutMs: MERGE_PROGRESS_STALL_TIMEOUT_MS,
                progressValueFromText: parseFfmpegProgressTime,
                onNoProgress: (watchdogError) => {
                  const message = `${stageLabel}连续 ${Math.ceil(
                    MERGE_PROGRESS_STALL_TIMEOUT_MS / 1000
                  )} 秒没有媒体进度，已终止；源分段会保留并自动重试。`;
                  watchdogError.message = message;
                  if (room.mergeProgress?.id === progress.id) {
                    room.mergeProgress.message = message;
                    room.mergeProgress.updatedAt = Date.now();
                  }
                  this.log('error', `${roomLabel(room)} ${message}`);
                  this.markRoomDirty(room.id);
                }
              });
            }
          } catch (error) {
            throw forcedFfmpegError || error;
          }
          if (forcedFfmpegError) throw forcedFfmpegError;
        } finally {
          clearInterval(firstProgressHeartbeat);
          if (!child || this.mergeProcesses.get(room.id) === child) {
            this.mergeProcesses.delete(room.id);
          }
        }
      };
      const runBoundedTranscode = async (videoCodec) => {
        await fsp.rm(normalizeTempDir, { recursive: true, force: true });
        await fsp.mkdir(normalizeTempDir, { recursive: true });
        if (room.mergeProgress?.id === progress.id) {
          room.mergeProgress.codec = videoCodec;
          room.mergeProgress.codecKind = videoCodec.includes('libx') ? 'software' : 'hardware';
          room.mergeProgress.encoderBackend = this.getEncoderBackendLabel(this.getBurnCodecInfo(videoCodec));
          room.mergeProgress.updatedAt = Date.now();
          this.markRoomDirty(room.id);
        }
        const normalizedPaths = [];
        const normalizedDurations = [];
        let progressOffsetSec = 0;
        for (let index = 0; index < segments.length; index += 1) {
          if (this.mergeCancelRequests.has(room.id)) throw new Error('合并已取消');
          const sourceDurationSec = getMergeSegmentVideoDurationSec(
            segmentTimelineInfos[index],
            segmentMediaInfos[index],
            segments[index],
            segments[index + 1]
          );
          const timelineAlignment = getBurnTimelineAlignment(segments[index], 0, sourceDurationSec);
          const normalizedPath = path.join(normalizeTempDir, `${String(index + 1).padStart(3, '0')}.normalized.mkv`);
          const baseStageLabel = `规范化分段 ${index + 1}/${segments.length}`;
          if (timelineAlignment.videoPaddingSec > 0.05 || timelineAlignment.audioPaddingSec > 0.05) {
            this.log(
              'info',
              `${roomLabel(room)} ${baseStageLabel} 保留源音画起始差：视频前置 ${timelineAlignment.videoPaddingSec.toFixed(
                3
              )} 秒，音频前置 ${timelineAlignment.audioPaddingSec.toFixed(3)} 秒。`
            );
          }
          const preferredDecoder = this.getHardwareDecoder(segmentMediaInfos[index]?.videoInfo, videoCodec);
          const runNormalizeAttempt = async ({
            stageLabel = baseStageLabel,
            decoder = preferredDecoder.value,
            decoderThreads = 2,
            recoverySeekSec = 0
          } = {}) => {
            if (room.mergeProgress?.id === progress.id) {
              const decoderInfo =
                decoder === 'software'
                  ? { value: 'software', label: 'CPU', kind: 'software' }
                  : (this.ffmpegCapabilities?.hardwareDecoders || []).find(
                      (candidate) => candidate.value === decoder && candidate.codec === preferredDecoder.codec
                    ) || { value: decoder, label: decoder.toUpperCase(), kind: 'hardware' };
              this.setProgressDecoder(room.mergeProgress, {
                ...decoderInfo,
                kind: decoder === 'software' ? 'software' : 'hardware'
              });
              room.mergeProgress.stageLabel = stageLabel;
              room.mergeProgress.currentTimeSec = progressOffsetSec;
              room.mergeProgress.percent = mergeDurationSec > 0 ? (progressOffsetSec / mergeDurationSec) * 100 : null;
              room.mergeProgress.estimatedRemainingSec = null;
              room.mergeProgress.message = `${stageLabel}（本段共 ${formatDurationSeconds(sourceDurationSec)}）`;
              room.mergeProgress.updatedAt = Date.now();
              this.markRoomDirty(room.id);
            }
            await fsp.rm(normalizedPath, { force: true });
            const normalizeOptions = {
              progressOffsetSec,
              stageLabel,
              segmentDurationSec: sourceDurationSec
            };
            if (isJetsonGstreamerCodec(videoCodec)) {
              const encodedVideoPath = path.join(
                normalizeTempDir,
                `${String(index + 1).padStart(3, '0')}.normalized.mkv`
              );
              await runMergeFfmpeg(null, {
                ...normalizeOptions,
                run: (onStderr, onChild) =>
                  this.runJetsonGstreamerTranscode({
                    codec: videoCodec,
                    quality: isHevcCodec(videoCodec) ? 24 : 20,
                    width: targetVideoInfo.width,
                    height: targetVideoInfo.height,
                    fps: targetVideoInfo.fps || segmentMediaInfos[index]?.videoInfo?.fps || 30,
                    encodedVideoPath,
                    decoder,
                    createRawArgs: (nextDecoder) =>
                      createNormalizeRawVideoArgs({
                        inputPath: segments[index].cleanPath,
                        durationSec: sourceDurationSec,
                        targetVideoInfo,
                        decoder: nextDecoder,
                        sourceCodec: preferredDecoder.codec,
                        decoderThreads,
                        recoverySeekSec,
                        timelineAlignment
                      }),
                    createMuxArgs: () =>
                      createNormalizeEncodedVideoMuxArgs({
                        encodedVideoPath,
                        inputPath: segments[index].cleanPath,
                        outputPath: normalizedPath,
                        codec: videoCodec,
                        fps: targetVideoInfo.fps || segmentMediaInfos[index]?.videoInfo?.fps || 30,
                        container: 'mkv',
                        durationSec: sourceDurationSec,
                        hasAudio: Boolean(segmentMediaInfos[index].audioInfo),
                        timelineAlignment
                      }),
                    onStderr,
                    onChild,
                    onFallback: () => {
                      this.setProgressDecoder(room.mergeProgress, {
                        value: 'software',
                        label: 'CPU',
                        kind: 'software'
                      });
                    },
                    label: `${roomLabel(room)} ${stageLabel}`
                  })
              });
            } else {
              await runMergeFfmpeg(
                createNormalizeSegmentArgs({
                  inputPath: segments[index].cleanPath,
                  outputPath: normalizedPath,
                  container: 'mkv',
                  durationSec: sourceDurationSec,
                  hasAudio: Boolean(segmentMediaInfos[index].audioInfo),
                  targetVideoInfo,
                  videoCodec,
                  softwareThreads: mergeSoftwareThreads,
                  decoder,
                  sourceCodec: preferredDecoder.codec,
                  decoderThreads,
                  recoverySeekSec,
                  timelineAlignment
                }),
                normalizeOptions
              );
            }
          };
          try {
            await runNormalizeAttempt({
              stageLabel:
                preferredDecoder.kind === 'hardware'
                  ? `${baseStageLabel}（${preferredDecoder.label} 硬件解码）`
                  : baseStageLabel,
              decoderThreads: preferredDecoder.kind === 'hardware' ? 1 : 2
            });
          } catch (error) {
            if (this.mergeCancelRequests.has(room.id)) throw error;
            let recoveryError = error;
            if (
              preferredDecoder.kind === 'hardware' &&
              (isFfmpegHardwareDecodeError(error) || isFfmpegVideoDecodeError(error))
            ) {
              this.log(
                'warn',
                `${roomLabel(room)} ${baseStageLabel}的 ${preferredDecoder.label} 硬件解码未能生成画面，仅将当前分段改用 CPU 解码；已完成分段不会重做。`
              );
              try {
                await runNormalizeAttempt({
                  stageLabel: `${baseStageLabel}（CPU 兼容解码）`,
                  decoder: 'software',
                  decoderThreads: 2
                });
                recoveryError = null;
              } catch (softwareError) {
                recoveryError = softwareError;
              }
            }
            if (recoveryError && !isFfmpegVideoDecodeError(recoveryError)) throw recoveryError;
            const recoverySeekSec = Math.min(
              MERGE_CORRUPT_PREFIX_RECOVERY_SEEK_SEC,
              Math.max(0, sourceDurationSec - 0.1)
            );
            if (recoveryError && recoverySeekSec >= 0.5) {
              this.log(
                'warn',
                `${roomLabel(room)} ${baseStageLabel}兼容解码仍未恢复，将仅跳过当前分段开头 ${formatDurationSeconds(
                  recoverySeekSec
                )} 的损坏视频，补入等长黑场并保留原音频后继续；总时长及后续弹幕时间不变。`
              );
              try {
                await runNormalizeAttempt({
                  stageLabel: `${baseStageLabel}（修复损坏开头）`,
                  decoder: 'software',
                  decoderThreads: 1,
                  recoverySeekSec
                });
                recoveryError = null;
                this.log(
                  'success',
                  `${roomLabel(room)} ${baseStageLabel}已绕过损坏开头并恢复规范化，继续处理后续步骤。`
                );
              } catch (seekError) {
                recoveryError = seekError;
              }
            }
            if (recoveryError) {
              const segmentError = new Error(
                `${baseStageLabel}源视频持续无法解码：${path.basename(segments[index].cleanPath)}。已尝试兼容解码和损坏开头恢复；${compactLogLine(
                  recoveryError.message
                )}`
              );
              segmentError.code = 'MERGE_SEGMENT_UNDECODABLE';
              segmentError.ffmpegExitCode = recoveryError.ffmpegExitCode;
              segmentError.ffmpegSignal = recoveryError.ffmpegSignal;
              segmentError.ffmpegStderr = recoveryError.ffmpegStderr;
              throw segmentError;
            }
          }
          const normalizedInfo = await this.runMergePreparationStage(
            room,
            progress,
            '正在验证规范化分段 ' + (index + 1) + '/' + segments.length,
            () => probeMediaFileInfo(this.ffmpegPath, normalizedPath, { timeoutMs: 15000 })
          );
          if (!normalizedInfo.videoInfo) {
            throw new Error(`规范化分段后没有检测到视频流：${path.basename(segments[index].cleanPath)}`);
          }
          normalizedPaths.push(normalizedPath);
          // The concat demuxer must advance by the normalized presentation
          // length, not by trailing H.26x DTS. The quick container probe is
          // already required for validation and avoids another full scan.
          normalizedDurations.push(Math.max(0, Number(normalizedInfo.durationSec) || sourceDurationSec));
          progressOffsetSec += sourceDurationSec;
        }
        if (room.mergeProgress?.id === progress.id) {
          room.mergeProgress.message = '正在无损拼接已规范化分段';
          room.mergeProgress.currentTimeSec = mergeDurationSec;
          room.mergeProgress.percent = 99.4;
          room.mergeProgress.updatedAt = Date.now();
          this.markRoomDirty(room.id);
        }
        await writeConcatFile(concatPath, normalizedPaths, { durations: normalizedDurations });
        await fsp.rm(tmpPath, { force: true });
        await runMergeFfmpeg(
          createConcatCopyArgs({
            concatPath,
            outputPath: tmpPath,
            container,
            streamCodec: targetVideoInfo.codec
          }),
          { trackProgress: false, stageLabel: '无损拼接已规范化分段' }
        );
      };
      const runSafeTranscode = async () => {
        // A healthy-looking copy merge can still fail because of malformed
        // timestamps.  Its fallback uses the same bounded workspace, so make
        // the larger disk reservation immediately before starting it too.
        await assertDiskSpace(outputPath, { estimatedBytes: boundedTranscodeTemporaryBytes });
        try {
          await runBoundedTranscode(mergeEncoderPlan.preferred);
        } catch (error) {
          this.mergeProcesses.delete(room.id);
          // Retrying under known memory pressure with another encoder can
          // immediately recreate the pressure, so leave source segments intact
          // and report it.  This covers Linux OOM SIGKILL and Windows FFmpeg
          // allocation/status failures alike.
          if (
            !mergeEncoderPlan.fallback ||
            this.mergeCancelRequests.has(room.id) ||
            isFfmpegMemoryPressureError(error) ||
            error?.code === 'FFMPEG_NO_PROGRESS' ||
            error?.code === 'MERGE_SEGMENT_UNDECODABLE'
          ) {
            throw error;
          }
          this.log(
            'warn',
            `${roomLabel(room)} ${mergeEncoderPlan.preferred} 分段规范化失败，将仅回退一次 ${mergeEncoderPlan.fallback} 软件编码：${error.message}`
          );
          await fsp.rm(tmpPath, { force: true });
          await fsp.rm(normalizeTempDir, { recursive: true, force: true });
          await runBoundedTranscode(mergeEncoderPlan.fallback);
        }
      };
      if (requiresTranscode) {
        await runSafeTranscode();
      } else {
        await writeConcatFile(concatPath, segments.map((segment) => segment.cleanPath));
        try {
          await runMergeFfmpeg(
            createConcatCopyArgs({ concatPath, outputPath: tmpPath, container, streamCodec: targetVideoInfo.codec }),
            { stageLabel: '无损拼接续录分段' }
          );
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
        this.markRoomDirty(room.id);
      }
      let mergedMediaInfo = await this.runMergePreparationStage(
        room,
        progress,
        '正在验证合并媒体文件',
        () => probeMediaFileInfo(this.ffmpegPath, tmpPath, { timeoutMs: 15000 })
      );
      if (!mergedMediaInfo.videoInfo) {
        throw new Error('合并文件生成后没有检测到视频流。');
      }
      let mergedTimingInfo = null;
      try {
        if (room.mergeProgress?.id === progress.id) {
          room.mergeProgress.message = '正在检查合并后的音画时间轴';
          room.mergeProgress.percent = 99.7;
          room.mergeProgress.updatedAt = Date.now();
          this.markRoomDirty(room.id);
        }
        mergedTimingInfo = await this.runMergePreparationStage(
          room,
          progress,
          '正在检查合并后的音画时间轴',
          () => probeMediaTimelineInfo(this.ffmpegPath, tmpPath, mergedMediaInfo, { timeoutMs: 120000 })
        );
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
          if (!usedTimelinePreservingNormalization) {
            this.log(
              'warn',
              `${roomLabel(room)} 无损拼接后检测到 ${driftMs}ms 音画偏差，将逐段重建原始时间轴后重试；不会拉伸或加速音频。`
            );
            if (room.mergeProgress?.id === progress.id) {
              room.mergeProgress.message = `正在重建原始时间轴（检测到 ${driftMs}ms 偏差）`;
              room.mergeProgress.percent = 99.2;
              room.mergeProgress.updatedAt = Date.now();
              this.markRoomDirty(room.id);
            }
            await fsp.rm(tmpPath, { force: true });
            await runSafeTranscode();
            usedTimelinePreservingNormalization = true;
            mergedMediaInfo = await this.runMergePreparationStage(
              room,
              progress,
              '正在验证重建后的合并媒体文件',
              () => probeMediaFileInfo(this.ffmpegPath, tmpPath, { timeoutMs: 15000 })
            );
            if (!mergedMediaInfo.videoInfo) {
              throw new Error('重建后的合并文件没有检测到视频流。');
            }
            mergedTimingInfo = await this.runMergePreparationStage(
              room,
              progress,
              '正在复验重建后的音画时间轴',
              () => probeMediaTimelineInfo(this.ffmpegPath, tmpPath, mergedMediaInfo, { timeoutMs: 120000 })
            );
            this.log(
              Math.abs(mergedTimingInfo.avDeltaSec) > 0.08 ? 'warn' : 'success',
              `${roomLabel(room)} 重建后时轴检查：视频 ${mergedTimingInfo.videoDurationSec.toFixed(3)}s，音频 ${mergedTimingInfo.audioDurationSec.toFixed(
                3
              )}s，音频${mergedTimingInfo.avDeltaSec >= 0 ? '长' : '短'} ${Math.abs(mergedTimingInfo.avDeltaSec).toFixed(3)}s。`
            );
          }
          if (!mergedTimingInfo.timingSafeForCopy) {
            const verifiedDriftMs = Math.round(Math.abs(mergedTimingInfo.avDeltaSec || 0) * 1000);
            const error = new Error(
              `合并后音画仍相差 ${verifiedDriftMs}ms；已停止生成，避免用拉伸音频掩盖漂移，所有源分段已保留。`
            );
            error.code = 'MERGE_AV_TIMELINE_UNSAFE';
            throw error;
          }
        }
      } catch (error) {
        this.log('warn', `${roomLabel(room)} 合并后时轴检查失败：${error.message}`);
        throw error;
      }
      await this.runMergePreparationStage(room, progress, '正在合并弹幕记录', async () => {
        await mergeDanmakuFiles(segments, danmakuTmpPath);
        await copyFirstExistingFile(
          segments.map((segment) => segment.cssPath).filter(Boolean),
          cssTmpPath,
          createDefaultDanmakuCss()
        );
        await this.mergeAvatarManifests(segments, avatarManifestPath).catch((error) => {
          this.log('warn', `${roomLabel(room)} 合并头像记录失败，后续烧录将使用兼容回退：${error.message}`);
        });
        await Promise.all([fsp.stat(danmakuTmpPath), fsp.stat(cssTmpPath)]);
      });
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
        liveSessionId: segments[0].liveSessionId || '',
        cleanPath: outputPath,
        danmakuPath,
        avatarManifestPath,
        sceneCachePath,
        scenePath,
        sceneStatus: 'capturing',
        cssPath,
        assPath,
        burnedPath,
        mergeGroup: groupId,
        mergeSequence: 0,
        mergeOutputPath: outputPath,
        segmentTargetDurationSec: this.getRecordingSegmentTargetDurationSec(segments[0]),
        segmentReason: 'merged',
        diagnosticsPath: segments[0].diagnosticsPath || '',
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
        danmakuDropCounts: mergeCommandCounts(segments.map((segment) => segment.danmakuDropCounts)),
        videoInfo: mergedMediaInfo.videoInfo,
        danmakuDurationSec: await readDanmakuDurationSec(danmakuPath).catch(() => 0),
        timingInfo: mergedTimingInfo
          ? {
              ...mergedTimingInfo,
              sourceSegments: segmentTimelineInfos.map((timingInfo, index) => ({
                index: index + 1,
                videoDurationSec: getMergeSegmentVideoDurationSec(
                  timingInfo,
                  segmentMediaInfos[index],
                  segments[index],
                  segments[index + 1]
                ),
                audioDurationSec: Number(timingInfo.audioDurationSec || 0),
                avDeltaSec: Number(timingInfo.avDeltaSec || 0),
                timingSafeForCopy: Boolean(timingInfo.timingSafeForCopy),
                error: timingInfo.error || ''
              }))
            }
          : null,
        timelineHealth: mergedTimingInfo
          ? {
              ...mergedTimingInfo,
              timelineHealth: mergedTimingInfo.timingSafeForCopy ? 'healthy' : 'warning',
              warnings: mergedTimingInfo.timingSafeForCopy ? [] : ['合并后存在 A/V duration 差']
            }
          : null
      });
      try {
        const sceneResult = await this.finalizeSceneGraphForRecording(mergedRecording, {
          durationSec: mergedRecording.durationSec,
          videoInfo: mergedRecording.videoInfo
        });
        mergedRecording.sceneStatus = 'ready';
        mergedRecording.sceneEventCount = sceneResult.eventCount;
      } catch (error) {
        mergedRecording.sceneStatus = 'degraded';
        this.log('warn', roomLabel(room) + ' 合并录像 Scene Graph 收尾失败；原始分段和合并 JSONL 均已保留：' + error.message);
      }
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
        room.recordingState = 'completed';
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
      await this.cleanupMergedSegmentFiles(room, segments, mergedRecording, { cleanupId, preserveSourceInputs: true });
      if (room.mergeProgress?.id === progress.id) {
        finishFfmpegJobProgress(room.mergeProgress, 'completed', '续录分段已合并');
      }
      this.log(
        'success',
        `${roomLabel(room)} 续录片段已合并：${path.basename(outputPath)}，共 ${segments.length} 段，时长 ${formatDurationSeconds(
          mergedRecording.durationSec
        )}。`
      );
      this.emitState(['room', 'recording', 'mediaJob']);
      setTimeout(() => {
        if (room.mergeProgress?.id === progress.id) {
          delete room.mergeProgress;
          this.markRoomDirty(room.id);
        }
      }, 5000).unref?.();
      return mergedRecording;
    } catch (error) {
      const cancelled = this.mergeCancelRequests.has(room.id);
      const memoryPressure = !cancelled && isFfmpegMemoryPressureError(error);
      const failureMessage = memoryPressure
        ? `合并 FFmpeg 疑似因内存不足而中止（请检查系统内存/事件日志）：${error.message}`
        : `合并失败：${error.message}`;
      if (room.mergeProgress?.id === progress.id) {
        finishFfmpegJobProgress(
          room.mergeProgress,
          cancelled ? 'cancelled' : 'error',
          cancelled ? '合并已取消，所有源分段均已保留' : `${failureMessage}；所有源分段均已保留`
        );
      }
      this.log(cancelled ? 'info' : 'error', `${roomLabel(room)} ${cancelled ? '合并已取消' : failureMessage}；源分段未删除。`);
      this.emitState(['room', 'mediaJob']);
      if (cancelled) return null;
      throw error;
    } finally {
      mergeLease.release();
      this.mergeProcesses.delete(room.id);
      this.mergeCancelRequests.delete(room.id);
      await fsp.rm(concatPath, { force: true }).catch(() => {});
      await fsp.rm(tmpPath, { force: true }).catch(() => {});
      await fsp.rm(danmakuTmpPath, { force: true }).catch(() => {});
      await fsp.rm(cssTmpPath, { force: true }).catch(() => {});
      await fsp.rm(normalizeTempDir, { recursive: true, force: true }).catch(() => {});
    }
  }

  async writeRecordingMetadata(recording) {
    const cleanPath = String(recording?.cleanPath || '');
    if (!cleanPath) return '';
    const stat = await fsp.stat(cleanPath);
    const metadataPath = `${cleanPath}.metadata.json`;
    const temporaryPath = `${metadataPath}.${process.pid}.tmp`;
    const metadataDirectory = path.dirname(path.resolve(cleanPath));
    const toMetadataRelativePath = (filePath) => {
      const value = String(filePath || '').trim();
      if (!value) return '';
      const resolved = path.resolve(value);
      if (!isPathInsideDirectory(resolved, metadataDirectory)) return '';
      return path.relative(metadataDirectory, resolved).split(path.sep).join('/');
    };
    const mergedFrom = Array.isArray(recording.mergedFrom)
      ? [...new Set(recording.mergedFrom.map(toMetadataRelativePath).filter(Boolean))]
      : [];
    const payload = {
      schemaVersion: 2,
      createdByVersion: APP_VERSION,
      status: recording.recordingState === 'recording' ? 'recording' : 'completed',
      cleanPath: path.basename(cleanPath),
      fileSize: stat.size,
      fileMtimeMs: stat.mtimeMs,
      roomId: String(recording.roomId || ''),
      roomTitle: String(recording.roomTitle || ''),
      anchor: String(recording.anchor || ''),
      startedAt: Number(recording.startedAt || stat.mtimeMs),
      durationSec: Number(recording.durationSec || 0),
      danmakuDurationSec: Number(recording.danmakuDurationSec || 0),
      eventCount: Number(recording.eventCount || 0),
      sceneEventCount: Number(recording.sceneEventCount || 0),
      videoInfo: recording.videoInfo || null,
      liveSessionId: String(recording.liveSessionId || ''),
      mergeGroup: String(recording.mergeGroup || ''),
      mergeSequence: Number(recording.mergeSequence || 0),
      mergeOutputPath: toMetadataRelativePath(recording.mergeOutputPath),
      segmentTargetDurationSec: Number(recording.segmentTargetDurationSec || 0),
      avatarManifestPath: toMetadataRelativePath(
        recording.avatarManifestPath || deriveAvatarManifestPath(cleanPath)
      ),
      sceneCachePath: toMetadataRelativePath(recording.sceneCachePath || deriveSceneCachePath(cleanPath)),
      scenePath: toMetadataRelativePath(recording.scenePath || deriveSceneGraphPath(cleanPath)),
      sceneStatus: String(recording.sceneStatus || ''),
      mergedFrom,
      cleanupId: String(recording.cleanupId || ''),
      segmentReason: String(recording.segmentReason || 'initial'),
      streamMetadata: recording.streamMetadata || null,
      timelineHealth: String(recording.timelineHealth?.timelineHealth || recording.timelineHealthStatus || recording.timelineHealth || 'warning'),
      timelineDetails: typeof recording.timelineHealth === 'object' ? recording.timelineHealth : null,
      timingInfo: recording.timingInfo || null,
      danmakuDropCounts: recording.danmakuDropCounts || {},
      diagnosticsPath: recording.diagnosticsPath ? path.basename(recording.diagnosticsPath) : '',
      recovery: recording.recovery || null,
      updatedAt: new Date().toISOString()
    };
    await fsp.writeFile(temporaryPath, `${JSON.stringify(payload, null, 2)}\n`, { encoding: 'utf8', mode: 0o660 });
    await atomicReplaceFile(temporaryPath, metadataPath);
    return metadataPath;
  }

  async writeActiveSegmentMetadata(room, session) {
    if (!session?.cleanPath) return '';
    const metadataPath = `${session.cleanPath}.metadata.json`;
    const temporaryPath = `${metadataPath}.${process.pid}.${Date.now()}.tmp`;
    const payload = {
      schemaVersion: 2,
      createdByVersion: APP_VERSION,
      status: 'recording',
      liveSessionId: session.liveSessionId,
      roomId: String(room?.id || session.roomId || ''),
      roomTitle: String(room?.title || ''),
      anchor: String(room?.anchor || ''),
      startedAt: Number(session.startedAt || Date.now()),
      cleanPath: path.basename(session.cleanPath),
      capturePath: path.basename(session.capturePath || session.cleanPath),
      outputContainer: session.outputContainer,
      mergeGroup: session.mergeGroup,
      mergeSequence: Number(session.mergeSequence || 0),
      mergeOutputPath: path.basename(session.mergeOutputPath || ''),
      segmentTargetDurationSec: Number(session.segmentDurationSec || 0),
      segmentReason: session.segmentReason || 'initial',
      danmakuPath: path.basename(session.danmakuPath || ''),
      avatarManifestPath: path.basename(session.avatarManifestPath || deriveAvatarManifestPath(session.cleanPath)),
      sceneCachePath: path.basename(session.sceneCachePath || deriveSceneCachePath(session.cleanPath)),
      scenePath: path.basename(session.scenePath || deriveSceneGraphPath(session.cleanPath)),
      sceneStatus: String(session.sceneStatus || 'capturing'),
      diagnosticsPath: path.basename(session.diagnosticsPath || ''),
      streamMetadata: session.streamMetadata || null,
      updatedAt: new Date().toISOString()
    };
    await fsp.writeFile(temporaryPath, `${JSON.stringify(payload, null, 2)}\n`, { encoding: 'utf8', mode: 0o660 });
    await atomicReplaceFile(temporaryPath, metadataPath);
    return metadataPath;
  }

  async cleanupEmptyCaptureArtifacts(session, options = {}) {
    const cleanPath = String(session?.cleanPath || '').trim();
    const capturePath = String(session?.capturePath || cleanPath).trim();
    if (!cleanPath || !capturePath) {
      return { deletedCount: 0, failedCount: 0 };
    }
    const captureStat = await fsp.stat(capturePath).catch(() => null);
    if (!captureStat?.isFile() || (!options.force && Number(captureStat.size || 0) !== 0)) {
      return { deletedCount: 0, failedCount: 0 };
    }

    const outputDir = path.resolve(String(session?.outputDir || path.dirname(cleanPath)));
    const normalizedCleanPath = path.resolve(cleanPath);
    const normalizedCapturePath = path.resolve(capturePath);
    if (
      !isPathInsideDirectory(normalizedCleanPath, outputDir) ||
      !isPathInsideDirectory(normalizedCapturePath, outputDir)
    ) {
      return { deletedCount: 0, failedCount: 0 };
    }

    const cleanStat =
      normalizedCleanPath === normalizedCapturePath ? captureStat : await fsp.stat(normalizedCleanPath).catch(() => null);
    const hasSeparateCleanMedia =
      normalizedCleanPath !== normalizedCapturePath && cleanStat?.isFile() && Number(cleanStat.size || 0) > 0;
    const artifactPaths = hasSeparateCleanMedia
      ? [normalizedCapturePath]
      : [
          normalizedCapturePath,
          normalizedCleanPath,
          `${normalizedCleanPath}.metadata.json`,
          String(session?.avatarManifestPath || deriveAvatarManifestPath(normalizedCleanPath)),
          String(session?.avatarDirectory || deriveAvatarDirectory(normalizedCleanPath)),
          String(session?.danmakuPath || deriveSiblingPath(normalizedCleanPath, 'danmaku', 'jsonl')),
          String(session?.cssPath || deriveSiblingPath(normalizedCleanPath, 'danmaku', 'css')),
          String(session?.assPath || deriveSiblingPath(normalizedCleanPath, 'danmaku', 'ass')),
          deriveSiblingPath(normalizedCleanPath, 'danmaku-only', 'ass'),
          String(session?.burnedPath || deriveBurnedPath(normalizedCleanPath, 'danmaku-gift')),
          deriveBurnedPath(normalizedCleanPath, 'danmaku')
        ];
    const uniquePaths = [
      ...new Set(
        artifactPaths
          .map((filePath) => String(filePath || '').trim())
          .filter(Boolean)
          .map((filePath) => path.resolve(filePath))
      )
    ];
    let deletedCount = 0;
    let failedCount = 0;
    for (const filePath of uniquePaths) {
      if (!isPathInsideDirectory(filePath, outputDir)) continue;
      const stat = await fsp.stat(filePath).catch(() => null);
      if (!stat?.isFile() && !stat?.isDirectory()) continue;
      try {
        await fsp.rm(filePath, { recursive: stat.isDirectory(), force: true });
        deletedCount += 1;
      } catch {
        failedCount += 1;
      }
    }
    return { deletedCount, failedCount };
  }

  async findInterruptedCaptureFiles(rootDir, maxDepth = 4) {
    const root = path.resolve(String(rootDir || ''));
    const rootStat = await fsp.stat(root).catch(() => null);
    if (!rootStat?.isDirectory()) return [];
    const found = [];
    let directories = [{ directory: root, depth: 0 }];
    while (directories.length) {
      const current = directories;
      directories = [];
      for (const { directory, depth } of current) {
        const entries = await fsp.readdir(directory, { withFileTypes: true }).catch(() => []);
        for (const entry of entries) {
          const filePath = path.join(directory, entry.name);
          if (entry.isDirectory() && depth < maxDepth) {
            directories.push({ directory: filePath, depth: depth + 1 });
          } else if (entry.isFile() && /\.recording\.mkv$/i.test(entry.name)) {
            found.push(filePath);
          }
        }
      }
    }
    return found;
  }

  async recoverInterruptedRecordings() {
    const captures = await this.findInterruptedCaptureFiles(this.settings.outputDir);
    if (!captures.length) return [];
    const recovered = [];
    const resumableRooms = new Map();
    for (const capturePath of captures) {
      const directory = path.dirname(capturePath);
      const fallbackCleanPath = capturePath.replace(/\.recording\.mkv$/i, '.clean.mp4');
      const metadataPath = `${fallbackCleanPath}.metadata.json`;
      const metadata = await fsp.readFile(metadataPath, 'utf8').then(JSON.parse).catch(() => null);
      if (metadata?.status && metadata.status !== 'recording') continue;
      const declaredClean = String(metadata?.cleanPath || path.basename(fallbackCleanPath));
      const cleanPath = path.resolve(directory, path.basename(declaredClean));
      if (path.dirname(cleanPath) !== path.resolve(directory) || (await isExistingFile(cleanPath))) continue;
      const captureSize = await getFileSize(capturePath);
      const declaredCapture = String(metadata?.capturePath || path.basename(capturePath));
      const metadataOwnsCapture =
        String(metadata?.status || '') === 'recording' &&
        path.basename(declaredCapture) === path.basename(capturePath);
      if (captureSize === 0 && metadataOwnsCapture) {
        const danmakuPath = metadata?.danmakuPath
          ? path.resolve(directory, path.basename(metadata.danmakuPath))
          : deriveSiblingPath(cleanPath, 'danmaku', 'jsonl');
        const cleanupResult = await this.cleanupEmptyCaptureArtifacts({
          cleanPath,
          capturePath,
          danmakuPath,
          avatarManifestPath: metadata?.avatarManifestPath
            ? path.resolve(directory, path.basename(metadata.avatarManifestPath))
            : deriveAvatarManifestPath(cleanPath),
          cssPath: deriveSiblingPath(cleanPath, 'danmaku', 'css'),
          assPath: deriveSiblingPath(cleanPath, 'danmaku', 'ass'),
          burnedPath: deriveBurnedPath(cleanPath, 'danmaku-gift'),
          outputDir: directory
        });
        if (cleanupResult.deletedCount > 0) {
          this.log('info', `已清理崩溃后未写入媒体的空临时录像及其 sidecar ${cleanupResult.deletedCount} 个：${capturePath}`);
        }
        if (cleanupResult.failedCount > 0) {
          this.log('warn', `清理崩溃后的空临时录像残留失败 ${cleanupResult.failedCount} 个：${capturePath}`);
        }
        continue;
      }
      if (captureSize < MIN_PLAYABLE_BYTES) {
        this.log('warn', `发现未完成临时录像但文件过小，保留原文件待人工检查：${capturePath}`);
        continue;
      }
      try {
        const capturedInfo = await probeMediaFileInfo(this.ffmpegPath, capturePath, { timeoutMs: 20_000 });
        if (!capturedInfo.videoInfo) {
          this.log('warn', `发现未完成临时录像但无法探测视频流，保留原文件：${capturePath}`);
          continue;
        }
        const tmpPath = replaceExtension(cleanPath, '.recovered.tmp.mp4');
        await fsp.rm(tmpPath, { force: true });
        await runFfmpegJob(
          this.ffmpegPath,
          createMp4FinalizeArgs({ inputPath: capturePath, outputPath: tmpPath, streamCodec: capturedInfo.videoInfo.codec }),
          () => {}
        );
        const recoveredInfo = await probeMediaFileInfo(this.ffmpegPath, tmpPath, { timeoutMs: 20_000 });
        if (!recoveredInfo.videoInfo || (await getFileSize(tmpPath)) < MIN_PLAYABLE_BYTES) {
          throw new Error('恢复封装后没有可用视频流');
        }
        await atomicReplaceFile(tmpPath, cleanPath);
        // A process can die after the regular MP4 finalizer has produced its
        // temporary output but before it swaps it into place.  Once recovery has
        // independently produced a valid clean file, that stale temporary is no
        // longer needed and would otherwise be invisible to the recording library.
        await fsp.rm(replaceExtension(cleanPath, '.finalizing.mp4'), { force: true }).catch((error) => {
          this.log('warn', `恢复录像后清理遗留收尾临时文件失败：${error.message}`);
        });
        const timelineHealth = await probeMediaTimelineHealth(this.ffmpegPath, cleanPath, recoveredInfo, {
          timeoutMs: 120_000
        }).catch((error) => ({
          timelineHealth: 'warning',
          warnings: [`恢复后的时间轴检查失败：${error.message}`],
          videoDurationSec: Number(recoveredInfo.durationSec || 0),
          audioDurationSec: 0,
          avDeltaSec: 0
        }));
        const danmakuPath = metadata?.danmakuPath
          ? path.resolve(directory, path.basename(metadata.danmakuPath))
          : deriveSiblingPath(cleanPath, 'danmaku', 'jsonl');
        const recording = this.normalizeRecording({
          id: `${cleanPath}:recovered`,
          roomId: String(metadata?.roomId || ''),
          roomTitle: String(metadata?.roomTitle || ''),
          anchor: String(metadata?.anchor || ''),
          liveSessionId: String(metadata?.liveSessionId || crypto.randomUUID()),
          startedAt: Number(metadata?.startedAt || Date.now()),
          cleanPath,
          capturePath,
          danmakuPath,
          avatarManifestPath: metadata?.avatarManifestPath
            ? path.resolve(directory, path.basename(metadata.avatarManifestPath))
            : deriveAvatarManifestPath(cleanPath),
          cssPath: deriveSiblingPath(cleanPath, 'danmaku', 'css'),
          assPath: deriveSiblingPath(cleanPath, 'danmaku', 'ass'),
          burnedPath: deriveBurnedPath(cleanPath, 'danmaku-gift'),
          mergeGroup: String(metadata?.mergeGroup || path.basename(cleanPath)),
          mergeSequence: Number(metadata?.mergeSequence || 0),
          mergeOutputPath: metadata?.mergeOutputPath
            ? path.resolve(directory, path.basename(metadata.mergeOutputPath))
            : '',
          segmentTargetDurationSec: Number(
            metadata?.segmentTargetDurationSec ||
              metadata?.streamMetadata?.configuredSegmentDurationSec ||
              metadata?.streamMetadata?.segmentTargetDurationSec ||
              0
          ),
          segmentReason: 'crash-recovery',
          diagnosticsPath: metadata?.diagnosticsPath ? path.resolve(directory, path.basename(metadata.diagnosticsPath)) : path.join(directory, 'diagnostics.json'),
          durationSec: Number(recoveredInfo.durationSec || timelineHealth.videoDurationSec || 0),
          danmakuDurationSec: await readDanmakuDurationSec(danmakuPath).catch(() => 0),
          fileSize: await getFileSize(cleanPath),
          valid: true,
          eventCount: await countDanmakuLines(danmakuPath).catch(() => 0),
          videoInfo: recoveredInfo.videoInfo,
          timingInfo: timelineHealth,
          timelineHealth,
          streamMetadata: metadata?.streamMetadata || null,
          recovery: 'recovered-after-crash',
          recordingState: 'completed'
        });
        this.rememberRecording({ id: recording.roomId, title: recording.roomTitle, anchor: recording.anchor }, recording);
        await this.writeRecordingMetadata(recording);
        recovered.push(recording);
        this.log('success', `已恢复异常中断录像：${path.basename(cleanPath)}（原临时文件已保留）。`);
        if (recording.roomId) resumableRooms.set(recording.roomId, recording);
      } catch (error) {
        this.log('warn', `恢复临时录像失败，已保留原文件 ${capturePath}：${error.message}`);
      }
    }
    if (recovered.length) await this.saveStore();
    for (const [roomId, recording] of resumableRooms) {
      const room = this.rooms.get(String(roomId));
      if (!room?.monitoring || !room.autoRecord || this.hasActiveRecordingSession(room)) continue;
      try {
        const live = await this.fetchRoomLiveStatus(room.id);
        room.realRoomId = live.realRoomId || room.realRoomId;
        await this.applyDetectedLiveStatus(room, live.liveStatus, '崩溃恢复检查');
        if (live.liveStatus === 1 && !this.hasActiveRecordingSession(room)) {
          await this.startRecording(room.id, true, {
            streamReconnect: true,
            liveSessionId: recording.liveSessionId,
            diagnosticsPath: recording.diagnosticsPath,
            segmentReason: 'crash-recovery',
            outputDir: path.dirname(recording.cleanPath),
            outputContainer: getContainerFromPath(recording.cleanPath),
            segmentDurationSec: this.getRecordingSegmentTargetDurationSec(recording),
            mergeGroup: recording.mergeGroup,
            mergeSequence: Number(recording.mergeSequence || 0) + 1,
            mergeOutputPath: recording.mergeOutputPath
          });
        }
      } catch (error) {
        this.log('warn', `${roomLabel(room)} 崩溃恢复后检查续录失败：${error.message}`);
      }
    }
    return recovered;
  }

  async cancelMerge(roomId) {
    const room = this.getRoom(roomId);
    const child = this.mergeProcesses.get(room.id);
    const running = room.mergeProgress?.status === 'running';
    const queued = room.mergeProgress?.status === 'queued';
    const retrying = room.mergeProgress?.status === 'retrying';
    const queuedProgressId = queued ? room.mergeProgress?.id : '';
    if (queued) this.mergeCancelRequests.add(room.id);
    const cancelledQueuedJob = queuedProgressId ? this.mediaJobs.cancel(queuedProgressId) : false;
    const cancelledRetryCount = this.clearMergeRetryStatesForRoom(room.id);
    if (cancelledQueuedJob) {
      if (room.mergeProgress?.kind === 'merge') {
        finishFfmpegJobProgress(room.mergeProgress, 'cancelled', '已取消排队合并，所有源分段均已保留');
      }
      this.log('info', `${roomLabel(room)} 已取消排队合并；源分段未删除。`);
      this.emitState(['room', 'mediaJob']);
      return this.getState();
    }
    if (!child && !running && !queued && !retrying && !cancelledRetryCount) return this.getState();
    if (!child && !running && !queued) {
      if (room.mergeProgress?.kind === 'merge') {
        finishFfmpegJobProgress(room.mergeProgress, 'cancelled', '已取消自动合并重试，所有源分段均已保留');
      }
      this.log('info', `${roomLabel(room)} 已取消自动合并重试；源分段未删除。`);
      this.emitState(['room', 'mediaJob']);
      return this.getState();
    }
    this.mergeCancelRequests.add(room.id);
    if (child) requestFfmpegStop(child, { graceful: false, timeoutMs: 1500 });
    if (running || queued) room.mergeProgress.message = queued ? '正在取消排队合并，源分段会全部保留' : '正在取消合并，源分段会全部保留';
    this.emitState(['room', 'mediaJob']);
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
    if (!(await isExistingFile(mergedRecording.cleanPath))) {
      throw new Error('合并产物不存在，源分段受保护且不会清理。');
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
          `${base}.danmaku.avatars.json`,
          `${base}.danmaku.avatars`,
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
      add(recording.avatarManifestPath || deriveAvatarManifestPath(recording.cleanPath));
      add(deriveAvatarDirectory(recording.cleanPath));
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
      if (options.preserveSourceInputs) {
        // The automatic merge flow never consumes original capture inputs.
        // Explicit maintenance cleanup remains an independently confirmed
        // user action and follows its existing confirmation contract.
        addProtectedPath(segment.cleanPath);
        addProtectedPath(segment.danmakuPath || deriveSiblingPath(segment.cleanPath, 'danmaku', 'jsonl'));
        addProtectedPath(segment.avatarManifestPath || deriveAvatarManifestPath(segment.cleanPath));
        addProtectedPath(deriveAvatarDirectory(segment.cleanPath));
        addProtectedPath(segment.sceneCachePath || deriveSceneCachePath(segment.cleanPath));
        addProtectedPath(segment.scenePath || deriveSceneGraphPath(segment.cleanPath));
      }
    }
    // Burn/export can create area-specific ASS files and interrupted temporary
    // sidecars. They are not all present in an older recording object, so
    // enumerate only the exact source stem and only recognized generated
    // suffixes. User clips, diagnostics and the merged result do not match.
    for (const segment of segments) {
      const cleanPath = String(segment?.cleanPath || '').trim();
      if (!cleanPath || !isPathInsideDirectory(cleanPath, cleanupRoot)) continue;
      const directory = path.dirname(cleanPath);
      const entries = await fsp.readdir(directory, { withFileTypes: true }).catch(() => []);
      for (const entry of entries) {
        const avatarDirectoryName = path.basename(deriveAvatarDirectory(cleanPath));
        if (entry.isDirectory() && entry.name === avatarDirectoryName) {
          addCleanupPath(path.join(directory, entry.name));
          continue;
        }
        if (!entry.isFile() || !isGeneratedSegmentArtifactName(entry.name, cleanPath)) continue;
        addCleanupPath(path.join(directory, entry.name));
      }
    }

    if (options.preview) {
      const items = [];
      for (const [key, filePath] of cleanupPaths) {
        if (protectedPaths.has(key) || !isPathInsideDirectory(filePath, cleanupRoot)) continue;
        const stat = await fsp.stat(filePath).catch(() => null);
        if (!stat?.isFile() && !stat?.isDirectory()) continue;
        items.push({
          path: filePath,
          type: getCleanupArtifactType(filePath, stat),
          sizeBytes: await getCleanupPreviewSize(filePath, stat)
        });
      }
      return { preview: true, items };
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
      if (!stat?.isFile() && !stat?.isDirectory()) {
        continue;
      }
      try {
        await fsp.rm(filePath, { recursive: stat.isDirectory(), force: true });
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

  async findRecordingMetadataSidecars() {
    return this.maintenanceService.findRecordingMetadataSidecars();
  }

  pruneMaintenanceCleanupPlans() {
    return this.maintenanceService.pruneMaintenanceCleanupPlans();
  }

  clearMaintenanceCleanupPlans() {
    return this.maintenanceService.clearMaintenanceCleanupPlans();
  }

  async applyMaintenanceCleanupPlan(scanId) {
    return this.maintenanceService.applyMaintenanceCleanupPlan(scanId);
  }

  async cleanupMergedSegmentResiduals(options = {}) {
    return this.maintenanceService.cleanupMergedSegmentResiduals(options);
  }
  async startBurnDanmaku(roomId, options = {}) {
    const room = this.getRoom(roomId);
    const recording = room.currentRecording;
    if (!recording?.cleanPath || !recording?.danmakuPath) {
      throw businessError('RECORDING_NOT_FOUND', `${roomLabel(room)} 没有可烧录的最近录像。`, 404);
    }

    await this.enqueueBurnRecording(room, recording, options);
    return this.getState();
  }

  async enqueueBurnRecording(room, recording, options = {}) {
    if (!room?.id || this.removingRoomIds.has(room.id) || !this.rooms.has(room.id)) {
      return null;
    }
    if (!recording?.cleanPath || !recording?.danmakuPath || recording.valid === false) {
      throw new Error(`${roomLabel(room)} 没有可烧录的有效录像。`);
    }
    const requestedCodec = normalizeBurnCodec(options.codec || this.settings.burnCodec);
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
      options: {
        ...options,
        codec: requestedCodec,
        crf: clamp(Number(options.crf ?? this.settings.burnCrf), 16, 35)
      },
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
    const item = this.burnQueue[0];
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
      const removeWaitingItem = () => {
        const index = this.burnQueue.findIndex((candidate) => candidate.id === item.id);
        if (index >= 0) {
          this.burnQueue.splice(index, 1);
          this.emitState();
        }
      };
      try {
        await this.waitForRuntimeCapabilities();
        const codec = this.chooseBurnCodec(item.options.codec || this.settings.burnCodec);
        this.requireAvailableBurnCodec(codec, '弹幕烧录');
        lease = await this.mediaJobs.acquire({
          id: item.id,
          type: 'burn',
          ...this.getTranscodeResourcePlan(codec, item.recording?.videoInfo, { gpuComposite: true }),
          cancel: () => this.cancelBurnDanmaku(item.roomId).catch(() => {})
        });
        const started = await this.startBurnRecording(item.room, item.recording, {
          ...item.options,
          codec,
          onProgressCreated: removeWaitingItem
        });
        if (started) {
          await this.waitForBurnIdle(item.roomId);
        }
      } catch (error) {
        this.log('error', `烧录队列任务失败：${item.label}，${error.message || String(error)}`);
      } finally {
        removeWaitingItem();
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
      throw businessError('RECORDING_NOT_FOUND', `${roomLabel(room)} 没有可生成字幕的最近录像。`, 404);
    }
    const assets = await this.generateSubtitleAssets(recording, {
      overlayMode: options.overlayMode || this.settings.burnOverlayMode,
      danmakuArea: options.danmakuArea || this.settings.burnDanmakuArea,
      stylePreset: options.stylePreset,
      styleLayout: options.styleLayout,
      avatarMode: options.avatarMode ?? this.settings.burnAvatarMode
    });
    this.log('success', `${roomLabel(room)} 字幕文件已生成：${path.basename(assets.cssPath)} / ${path.basename(assets.assPath)}`);
    this.emitState();
    return this.getState();
  }

  async lookupBiliAvatarForOverlay(uid) {
    const safeUid = Math.floor(Number(uid || 0));
    if (!Number.isSafeInteger(safeUid) || safeUid <= 0) return '';
    const endpoint = `https://api.bilibili.com/x/web-interface/card?mid=${encodeURIComponent(String(safeUid))}`;
    const response = await requestUrlBuffer(endpoint, {
      headersForUrl: (target) => ({
        ...createImageProxyHeaders(target, this.settings.cookie),
        Accept: 'application/json, text/plain, */*'
      }),
      validateUrl: (target) => validateRemoteUrl(target, { allowHost: isBilibiliHost }),
      allowProxy: false,
      retries: 1,
      timeoutMs: 10000,
      maxRedirects: 2,
      maxBytes: 256 * 1024
    });
    let payload;
    try {
      payload = JSON.parse(response.toString('utf8'));
    } catch {
      return '';
    }
    if (Number(payload?.code) !== 0) return '';
    return normalizeBiliAvatarUrl(payload?.data?.card?.face || payload?.data?.face || '');
  }

  async prepareAvatarOverlayLayer(avatarPlan, options = {}) {
    const requestedEntries = Array.isArray(avatarPlan?.entries) ? avatarPlan.entries : [];
    const avatarDiagnostics = {
      requested: requestedEntries.length,
      prepared: 0,
      fallback: requestedEntries.length,
      noAvatarSource: 0,
      downloadFailed: 0,
      decodeFailed: 0,
      cropFailed: 0,
      firstError: null
    };
    const reportAvatarDiagnostics = () => {
      options.onDiagnostics?.({
        ...avatarDiagnostics,
        firstError: avatarDiagnostics.firstError ? { ...avatarDiagnostics.firstError } : undefined
      });
    };
    if (!requestedEntries.length || !options.assPath) {
      if (requestedEntries.length && !options.assPath) avatarDiagnostics.noAvatarSource = requestedEntries.length;
      reportAvatarDiagnostics();
      return null;
    }

    const label = String(options.label || '烧录');
    const isCancelled = typeof options.isCancelled === 'function' ? options.isCancelled : () => false;
    const cancellationError = () => {
      const error = new Error('媒体处理已取消。');
      error.code = 'BR2K_MEDIA_CANCELLED';
      return error;
    };
    const throwIfCancelled = () => {
      if (isCancelled()) throw cancellationError();
    };
    const avatarPreparationError = (stage, message, stderr = '') => {
      const error = new Error(message);
      error.avatarPreparationStage = stage;
      error.avatarPreparationStderr = compactLogLine(stderr || message);
      return error;
    };
    const recordAvatarFailure = (error, fallbackStage = 'decode') => {
      const stage = String(error?.avatarPreparationStage || fallbackStage);
      if (stage === 'source') avatarDiagnostics.noAvatarSource += 1;
      else if (stage === 'download') avatarDiagnostics.downloadFailed += 1;
      else if (stage === 'crop') avatarDiagnostics.cropFailed += 1;
      else avatarDiagnostics.decodeFailed += 1;
      const stderr = compactLogLine(error?.avatarPreparationStderr || error?.stderr || error?.message || '头像处理失败');
      if (!avatarDiagnostics.firstError) {
        avatarDiagnostics.firstError = { stage, message: compactLogLine(error?.message || stderr), stderr };
      }
    };
    const avatarDiagnosticsSummary = () =>
      `无头像源 ${avatarDiagnostics.noAvatarSource}，下载失败 ${avatarDiagnostics.downloadFailed}，格式或解码失败 ${
        avatarDiagnostics.decodeFailed
      }，裁切失败 ${avatarDiagnostics.cropFailed}${
        avatarDiagnostics.firstError ? `；首条 stderr：${avatarDiagnostics.firstError.stderr}` : ''
      }`;
    const runAvatarProcess = (args, processOptions) =>
      typeof options.runAvatarProcess === 'function'
        ? options.runAvatarProcess(args, processOptions)
        : runCapturedProcess(this.ffmpegPath, args, processOptions);
    throwIfCancelled();
    let workingDir = '';
    try {
      workingDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'br2k-avatar-layer-'));
    } catch (error) {
      recordAvatarFailure(error);
      reportAvatarDiagnostics();
      this.log('warn', `${label} 无法创建头像临时目录，继续使用通用头像（${avatarDiagnosticsSummary()}）。`);
      return null;
    }
    let avatarManifest;
    try {
      avatarManifest = await this.loadAvatarManifestForRecording(options.recording);
    } catch (error) {
      recordAvatarFailure(error);
      reportAvatarDiagnostics();
      await fsp.rm(workingDir, { recursive: true, force: true }).catch(() => {});
      this.log('warn', `${label} 无法读取头像清单，继续使用通用头像（${avatarDiagnosticsSummary()}）。`);
      return null;
    }
    const avatarUrlsByUid = new Map();
    const sourceFilesByUrl = new Map();
    const decodedAvatarBySource = new Map();
    const renderedAvatarBySource = new Map();
    const recordedSnapshotPaths = new Set();
    let failedCount = 0;
    let recordedCount = 0;
    const resolveAvatarSource = async (entry) => {
      const direct = normalizeBiliAvatarUrl(entry?.avatarUrl);
      const uid = Math.floor(Number(entry?.uid || 0));
      const snapshot = direct
        ? avatarManifest.byUrl?.get(direct)
        : Number.isSafeInteger(uid) && uid > 0
          ? avatarManifest.byUid?.get(uid)
          : null;
      if (snapshot?.filePath && (await isExistingFile(snapshot.filePath))) {
        if (!recordedSnapshotPaths.has(snapshot.filePath)) {
          recordedSnapshotPaths.add(snapshot.filePath);
          recordedCount += 1;
        }
        return { kind: 'file', path: snapshot.filePath };
      }
      if (snapshot?.avatarUrl) return { kind: 'url', url: snapshot.avatarUrl };
      if (direct) return { kind: 'url', url: direct };
      if (avatarManifest.present && avatarManifest.captureComplete) return null;
      if (!Number.isSafeInteger(uid) || uid <= 0) return null;
      if (!avatarUrlsByUid.has(uid)) {
        avatarUrlsByUid.set(uid, this.lookupBiliAvatarForOverlay(uid).catch(() => ''));
      }
      const avatarUrl = await avatarUrlsByUid.get(uid);
      return avatarUrl ? { kind: 'url', url: avatarUrl } : null;
    };
    const fetchAvatarSource = async (avatarUrl) => {
      if (!sourceFilesByUrl.has(avatarUrl)) {
        sourceFilesByUrl.set(
          avatarUrl,
          (async () => {
            try {
              const asset = await this.fetchAvatarImageAsset(avatarUrl);
              const extension = avatarImageExtension(asset.contentType) || '.img';
              const digest = crypto.createHash('sha256').update(avatarUrl).digest('hex').slice(0, 24);
              const sourcePath = path.join(workingDir, `source-${digest}${extension}`);
              await fsp.writeFile(sourcePath, asset.body);
              return sourcePath;
            } catch (error) {
              throw avatarPreparationError('download', `头像下载失败：${compactLogLine(error?.message || String(error))}`, error?.stderr || error?.message);
            }
          })()
        );
      }
      return sourceFilesByUrl.get(avatarUrl);
    };
    const decodeAvatar = (sourcePath) => {
      if (!decodedAvatarBySource.has(sourcePath)) {
        decodedAvatarBySource.set(
          sourcePath,
          (async () => {
            const decoded = await runAvatarProcess(
              ['-hide_banner', '-loglevel', 'error', '-i', sourcePath, '-frames:v', '1', '-f', 'null', '-'],
              { timeoutMs: 15000, maxOutputBytes: 32 * 1024 }
            );
            if (decoded.timedOut || decoded.status !== 0) {
              throw avatarPreparationError(
                'decode',
                `头像格式或解码失败：${compactLogLine(decoded.stderr || 'FFmpeg 无法读取头像。')}`,
                decoded.stderr
              );
            }
            return true;
          })()
        );
      }
      return decodedAvatarBySource.get(sourcePath);
    };
    const renderAvatar = (sourcePath, size) => {
      const renderKey = `${sourcePath}\u0000${size}`;
      if (!renderedAvatarBySource.has(renderKey)) {
        const digest = crypto.createHash('sha256').update(renderKey).digest('hex').slice(0, 24);
        const imagePath = path.join(workingDir, `avatar-${digest}-${size}.png`);
        renderedAvatarBySource.set(
          renderKey,
          (async () => {
            const rendered = await runAvatarProcess(
              [
                '-hide_banner',
                '-loglevel',
                'error',
                '-y',
                '-i',
                sourcePath,
                '-frames:v',
                '1',
                '-vf',
                createAvatarCircleFilter(size),
                '-pix_fmt',
                'rgba',
                imagePath
              ],
              { timeoutMs: 15000, maxOutputBytes: 32 * 1024 }
            );
            if (rendered.timedOut || rendered.status !== 0 || (await getFileSize(imagePath)) < 128) {
              throw avatarPreparationError(
                'crop',
                `头像圆形裁切失败：${compactLogLine(rendered.stderr || 'FFmpeg 没有生成 PNG。')}`,
                rendered.stderr
              );
            }
            return imagePath;
          })()
        );
      }
      return renderedAvatarBySource.get(renderKey);
    };

    try {
      this.log('info', `${label} 正在准备真实头像透明图层（${requestedEntries.length} 个）。`);
      const prepared = await mapWithConcurrency(requestedEntries, MAX_AVATAR_OVERLAY_CONCURRENCY, async (entry, index) => {
        try {
          throwIfCancelled();
          const source = await resolveAvatarSource(entry);
          if (!source) throw avatarPreparationError('source', '没有可用头像地址。');
          const sourcePath = source.kind === 'file' ? source.path : await fetchAvatarSource(source.url);
          await decodeAvatar(sourcePath);
          const size = Math.round(clamp(Number(entry?.size || 0), 8, 512));
          const imagePath = await renderAvatar(sourcePath, size);
          throwIfCancelled();
          return { ...entry, imagePath };
        } catch (error) {
          if (error?.code === 'BR2K_MEDIA_CANCELLED') throw error;
          failedCount += 1;
          recordAvatarFailure(error);
          return null;
        }
      });
      throwIfCancelled();
      const entries = prepared.filter(Boolean);
      avatarDiagnostics.prepared = entries.length;
      avatarDiagnostics.fallback = Math.max(0, requestedEntries.length - entries.length);
      if (!entries.length) {
        await fsp.rm(workingDir, { recursive: true, force: true }).catch(() => {});
        reportAvatarDiagnostics();
        this.log('warn', `${label} 未能准备真实头像，继续使用通用头像图标（${avatarDiagnosticsSummary()}）。`);
        return null;
      }
      const videoWidth = Math.floor(Math.max(0, Number(options.recording?.videoInfo?.width) || 0) / 2) * 2;
      const videoHeight = Math.floor(Math.max(0, Number(options.recording?.videoInfo?.height) || 0) / 2) * 2;
      const sourceFps = Math.max(1, Math.min(240, Number(options.fps) || 30));
      const panelFpsCap = entries.length > 48 ? 20 : entries.length > 20 ? 24 : 30;
      const compositeFps = Math.max(1, Math.min(sourceFps, panelFpsCap));
      const overlay = {
        panel: avatarPlan.panel,
        entries,
        videoWidth,
        videoHeight,
        compositeFps
      };
      const filterScriptPath = path.join(workingDir, 'avatar-layer.ffscript');
      const gpuComposite = Boolean(options.gpuComposite);
      const gpuCompositeBackend = String(options.gpuCompositeBackend || (gpuComposite ? 'cuda' : ''))
        .trim()
        .toLowerCase();
      const gpuCompositeMode = gpuComposite
        ? String(options.gpuCompositeMode || (gpuCompositeBackend === 'cuda' ? 'full' : 'final-blend')).trim()
        : '';
      const gpuCompositeDevice = gpuComposite ? String(options.gpuCompositeDevice || '').trim() : '';
      const fullCudaComposite = gpuComposite && gpuCompositeBackend === 'cuda';
      // CUDA can remain on-device before NVENC. Hybrid final-blend backends
      // must download their result because FFmpeg/GStreamer encode paths
      // consume system-memory frames.
      const gpuOutputToCpu = Boolean(options.gpuOutputToCpu) || (gpuComposite && !fullCudaComposite);
      const cpuFilterScriptPath = gpuComposite ? path.join(workingDir, 'avatar-layer.cpu.ffscript') : '';
      const chunkDuration =
        !fullCudaComposite && entries.length > MAX_CUDA_AVATAR_OVERLAY_ENTRIES ? AVATAR_OVERLAY_CHUNK_SECONDS : 0;
      if (!chunkDuration) {
        const createFilterScript = (useGpuComposite, backend = gpuCompositeBackend) =>
          createAvatarOverlayFilterScript({
            assPath: options.assPath,
            fps: options.fps,
            avatarOverlay: overlay,
            gpuComposite: useGpuComposite,
            gpuCompositeBackend: useGpuComposite ? backend : '',
            gpuOutputToCpu: useGpuComposite && gpuOutputToCpu,
            duration: options.duration,
            timelineOffset: options.timelineOffset,
            leadingVideoPaddingSec: options.leadingVideoPaddingSec,
            outputDuration: options.outputDuration,
            skipInitialKeyframeGuard: options.skipInitialKeyframeGuard
          });
        const script = createFilterScript(gpuComposite);
        if (!script) {
          recordAvatarFailure(avatarPreparationError('decode', '头像 overlay 滤镜未能生成。'));
          avatarDiagnostics.prepared = 0;
          avatarDiagnostics.fallback = requestedEntries.length;
          reportAvatarDiagnostics();
          await fsp.rm(workingDir, { recursive: true, force: true }).catch(() => {});
          return null;
        }
        await fsp.writeFile(filterScriptPath, script, 'utf8');
        // Keep a CPU graph next to every GPU graph. A production stream can
        // still expose an alpha/pixel-format pair that the short startup
        // probe did not cover.
        if (gpuComposite) {
          const cpuScript = createFilterScript(false);
          if (!cpuScript) {
            recordAvatarFailure(avatarPreparationError('decode', 'CPU 头像 overlay 回退滤镜未能生成。'));
            avatarDiagnostics.prepared = 0;
            avatarDiagnostics.fallback = requestedEntries.length;
            reportAvatarDiagnostics();
            await fsp.rm(workingDir, { recursive: true, force: true }).catch(() => {});
            return null;
          }
          await fsp.writeFile(cpuFilterScriptPath, cpuScript, 'utf8');
        }
      }
      const compositeCapability = this.getAvatarCompositeCapability();
      const compositeLabel =
        compositeCapability?.value === gpuCompositeBackend
          ? compositeCapability.label
          : gpuCompositeBackend.toUpperCase();
      const compositeSummary = gpuComposite
        ? gpuCompositeBackend === 'cuda'
          ? `，NVIDIA CUDA 合成${gpuOutputToCpu ? '后回传 CPU 编码链路' : ''}，已预置 CPU 回退。`
          : `，${compositeLabel}（头像面板 CPU ${Math.round(compositeFps)} fps，GPU 最终透明合成），已预置 CPU 回退。`
        : chunkDuration
          ? '，按时间分段合成（按段选择 CUDA/CPU）。'
          : `，CPU 小面板 ${Math.round(compositeFps)} fps。`;
      this.log(
        'info',
        `${label} 已准备独立透明头像图层：${entries.length}/${requestedEntries.length}${
         avatarPlan.truncated ? `（从 ${avatarPlan.candidateCount || requestedEntries.length} 处互动均匀取样）` : ''
          }${recordedCount ? `，本地快照 ${recordedCount} 个` : ''}${failedCount ? `，${failedCount} 个保留通用头像回退（${avatarDiagnosticsSummary()}）` : ''}${compositeSummary}`
      );
      reportAvatarDiagnostics();
      return {
        ...overlay,
        filterScriptPath: chunkDuration ? '' : filterScriptPath,
        cpuFilterScriptPath,
        temporaryDir: workingDir,
        gpuComposite,
        gpuCompositeBackend,
        gpuCompositeMode,
        gpuCompositeDevice,
        gpuOutputToCpu,
        chunked: Boolean(chunkDuration),
        chunkDuration,
        diagnostics: {
          ...avatarDiagnostics,
          firstError: avatarDiagnostics.firstError ? { ...avatarDiagnostics.firstError } : undefined
        }
      };
    } catch (error) {
      await fsp.rm(workingDir, { recursive: true, force: true }).catch(() => {});
      if (error?.code === 'BR2K_MEDIA_CANCELLED') throw error;
      recordAvatarFailure(error);
      avatarDiagnostics.prepared = 0;
      avatarDiagnostics.fallback = requestedEntries.length;
      reportAvatarDiagnostics();
      this.log('warn', `${label} 真实头像图层准备失败，继续使用通用头像（${avatarDiagnosticsSummary()}）。`);
      return null;
    }
  }

  async cleanupAvatarOverlayLayer(layer) {
    const temporaryDir = String(layer?.temporaryDir || '').trim();
    if (temporaryDir) {
      await fsp.rm(temporaryDir, { recursive: true, force: true }).catch(() => {});
    }
  }

  async runFfmpegWithHardwareDecodeFallback({
    decoder = 'software',
    createArgs,
    onStderr,
    onChild,
    beforeRetry,
    onFallback,
    label = '媒体处理'
  } = {}) {
    const preferredDecoder = String(decoder?.value || decoder || 'software');
    try {
      await runFfmpegJob(this.ffmpegPath, createArgs(preferredDecoder), onStderr, { onChild });
      return preferredDecoder;
    } catch (error) {
      if (
        preferredDecoder === 'software' ||
        error?.code === 'BR2K_MEDIA_CANCELLED' ||
        !(preferredDecoder === 'gstreamer-nvv4l2' || isFfmpegHardwareDecodeError(error))
      ) {
        throw error;
      }
      this.log(
        'warn',
        `${label} 的 ${decoder?.label || preferredDecoder} 硬件解码不可用于当前视频，立即改用 CPU 解码重试：${compactLogLine(
          error.message
        )}`
      );
      await beforeRetry?.();
      onFallback?.();
      await runFfmpegJob(this.ffmpegPath, createArgs('software'), onStderr, { onChild });
      return 'software';
    }
  }

  async runFfmpegWithCudaAvatarCompositeFallback({
    avatarLayer,
    decoder = 'software',
    createArgs,
    onStderr,
    onChild,
    beforeRetry,
    onDecoderFallback,
    onCudaFallback,
    label = '媒体处理'
  } = {}) {
    const run = (layer) =>
      this.runFfmpegWithHardwareDecodeFallback({
        decoder,
        createArgs: (activeDecoder) => createArgs(activeDecoder, layer),
        onStderr,
        onChild,
        beforeRetry,
        onFallback: onDecoderFallback,
        label
      });
    try {
      return await run(avatarLayer);
    } catch (error) {
      const cpuAvatarLayer = createCpuAvatarCompositeFallbackLayer(avatarLayer);
      if (error?.code === 'BR2K_MEDIA_CANCELLED' || !cpuAvatarLayer || !isFfmpegAvatarCompositeError(error)) {
        throw error;
      }
      this.log(
        'warn',
        `${label} 的 ${this.getAvatarCompositeBackendLabel(avatarLayer, 'high')} 不兼容当前 FFmpeg，保留当前编码器并改用 CPU 头像合成重试：${compactLogLine(
          error.message
        )}`
      );
      await beforeRetry?.();
      onCudaFallback?.();
      return run(cpuAvatarLayer);
    }
  }

  async runJetsonGstreamerWithCudaAvatarCompositeFallback({
    avatarLayer,
    createTranscode,
    beforeRetry,
    onCudaFallback,
    label = 'Jetson 媒体处理'
  } = {}) {
    if (typeof createTranscode !== 'function') {
      throw new Error('Jetson CUDA 头像回退缺少媒体处理参数。');
    }
    try {
      return await createTranscode(avatarLayer);
    } catch (error) {
      const cpuAvatarLayer = createCpuAvatarCompositeFallbackLayer(avatarLayer);
      if (error?.code === 'BR2K_MEDIA_CANCELLED' || !cpuAvatarLayer || !isFfmpegAvatarCompositeError(error)) {
        throw error;
      }
      this.log(
        'warn',
        `${label} 的 ${this.getAvatarCompositeBackendLabel(avatarLayer, 'high')} 不兼容当前 FFmpeg，保留 Jetson GStreamer 硬编并改用 CPU 头像合成重试：${compactLogLine(
          error.message
        )}`
      );
      await beforeRetry?.();
      onCudaFallback?.();
      return createTranscode(cpuAvatarLayer);
    }
  }

  // L4T R35 exposes the Jetson hardware encoder through GStreamer rather
  // than the stock FFmpeg binary. Keep FFmpeg for decoding/Scene rendering,
  // bridge raw I420 to nvv4l2{h264,h265}enc, and immediately matroska-mux the
  // video-only intermediate so its PTS survives the final audio mux.
  async runJetsonGstreamerTranscode({
    codec,
    quality,
    width,
    height,
    fps,
    encodedVideoPath,
    createRawArgs,
    createMuxArgs,
    decoder = 'software',
    nativeDecode = null,
    onStderr,
    onChild,
    onPipeline,
    onStageMetrics,
    onProgress,
    onPhase,
    beforeRetry,
    onFallback,
    label = 'Jetson 媒体处理',
    preview = false
  } = {}) {
    if (!isJetsonGstreamerCodec(codec)) {
      throw new Error(`不是受支持的 Jetson GStreamer 编码：${codec || '-'}`);
    }
    if (typeof createRawArgs !== 'function' || typeof createMuxArgs !== 'function') {
      throw new Error('Jetson GStreamer 编码缺少媒体处理参数。');
    }
    const outputPath = String(encodedVideoPath || '').trim();
    if (!outputPath) throw new Error('Jetson GStreamer 编码缺少临时视频文件路径。');
    const codecInfo = this.getBurnCodecInfo(codec);
    const gstreamerArgs = createJetsonGstreamerEncodeArgs({
      codec,
      width,
      height,
      fps,
      quality,
      outputPath,
      preview,
      converter: codecInfo.converter,
      // Keep the temporary Jetson video timestamped.  A raw .h264/.h265
      // elementary stream loses the decoder/renderer clock at every chunk.
      container: 'mkv'
    });
    this.log(
      'info',
      `${label}：已准备 Jetson ${gstreamerArgs.includes('nvv4l2h265enc') ? 'nvv4l2h265enc' : 'nvv4l2h264enc'} 编码；将在子进程实际启动后更新运行链路。`
    );
    const preferredDecoder = String(decoder?.value || decoder || 'software');
    const run = async (nextDecoder) => {
      onPhase?.('render');
      await fsp.rm(outputPath, { force: true }).catch(() => {});
      const useNativeDecode = nextDecoder === 'gstreamer-nvv4l2' && nativeDecode?.filterScriptPath;
      const activeDecoder = nextDecoder === 'gstreamer-nvv4l2' && !useNativeDecode ? 'software' : nextDecoder;
      if (useNativeDecode) {
        const encoderLabel = `Jetson ${gstreamerArgs.includes('nvv4l2h265enc') ? 'nvv4l2h265enc' : 'nvv4l2h264enc'}`;
        onPipeline?.({
          decoder: { value: 'gstreamer-nvv4l2', label: 'Jetson nvv4l2decoder', kind: 'hardware' },
          sceneRenderer: 'BiliRecord2K ffmpeg-full Scene Graph',
          encoder: encoderLabel
        });
        this.log('info', `${label}：解码 Jetson nvv4l2decoder → I420 pipe；渲染 BiliRecord2K ffmpeg-full Scene Graph → I420 pipe；编码 Jetson ${gstreamerArgs.includes('nvv4l2h265enc') ? 'nvv4l2h265enc' : 'nvv4l2h264enc'}。`);
        await runJetsonNativeDecodeSceneEncodeJob({
          decoderArgs: createJetsonNativeDecodeArgs({
            cleanPath: nativeDecode.cleanPath, sourceCodec: nativeDecode.sourceCodec, width, height, fps,
            converter: codecInfo.converter, helperMode: Boolean(nativeDecode.decoderPath),
            startTime: nativeDecode.startTime, duration: nativeDecode.duration
          }),
          decoderPath: nativeDecode.decoderPath || undefined,
          ffmpegPath: this.ffmpegPath,
          ffmpegArgs: createBurnRawSceneFromPipeArgs({ filterScriptPath: nativeDecode.filterScriptPath, fps, width, height, duration: nativeDecode.duration }),
          encoderArgs: gstreamerArgs,
          encodedVideoPath: outputPath,
          onDecoderStderr: (text) => onStderr?.(`GStreamer 解码: ${text}`),
          onFfmpegStderr: onStderr,
          onEncoderStderr: (text) => onStderr?.(`GStreamer 编码: ${text}`),
          onChild,
          frameSize: Math.max(1, Math.floor(Number(width) || 0) * Math.floor(Number(height) || 0) * 3 / 2),
          onStageMetrics
        });
      } else {
        onPipeline?.({
          decoder: activeDecoder === 'software'
            ? { value: 'software', label: 'BiliRecord2K ffmpeg-full CPU', kind: 'software' }
            : { value: activeDecoder, label: String(activeDecoder), kind: 'hardware' },
          sceneRenderer: 'BiliRecord2K ffmpeg-full Scene Graph',
          encoder: `Jetson ${gstreamerArgs.includes('nvv4l2h265enc') ? 'nvv4l2h265enc' : 'nvv4l2h264enc'}`
        });
        await runFfmpegToGstreamerJob({
          ffmpegPath: this.ffmpegPath,
          ffmpegArgs: createRawArgs(activeDecoder),
          gstreamerArgs,
          gstreamerOutputPath: outputPath,
          onFfmpegStderr: onStderr,
          onGstreamerStderr: (text) => onStderr?.(`GStreamer: ${text}`),
          onChild
        });
      }
      const encodedSize = await getFileSize(outputPath);
      if (encodedSize < 1024) {
        const error = new Error(`Jetson 编码中间 MKV 无效：文件大小 ${encodedSize} 字节。`);
        error.code = 'BR2K_JETSON_ENCODE_OUTPUT_INVALID';
        error.encodedSize = encodedSize;
        throw error;
      }
      let encodedInfo;
      try {
        encodedInfo = await probeMediaFileInfo(this.ffmpegPath, outputPath, { timeoutMs: 10_000 });
      } catch (cause) {
        const error = new Error(`Jetson 编码中间 MKV 无法读取：${compactLogLine(cause?.message || cause)}`);
        error.code = 'BR2K_JETSON_ENCODE_OUTPUT_INVALID';
        error.encodedSize = encodedSize;
        error.cause = cause;
        throw error;
      }
      if (!encodedInfo?.videoInfo) {
        const error = new Error('Jetson 编码中间 MKV 没有可读取的视频流。');
        error.code = 'BR2K_JETSON_ENCODE_OUTPUT_INVALID';
        error.encodedSize = encodedSize;
        throw error;
      }
      onPhase?.('mux');
      await runFfmpegJob(this.ffmpegPath, createMuxArgs(), onStderr, { onChild });
    };

    try {
      await run(preferredDecoder);
      return preferredDecoder;
    } catch (error) {
      if (
        preferredDecoder === 'software' ||
        error?.code === 'BR2K_MEDIA_CANCELLED' ||
        (error?.code !== 'BR2K_JETSON_NATIVE_DECODE_EMPTY' && !isFfmpegHardwareDecodeError(error))
      ) {
        throw error;
      }
      if (error?.code === 'BR2K_JETSON_NATIVE_DECODE_EMPTY') {
        this.log('warn', `${label} 的 Jetson nvv4l2decoder 未产生有效帧，已切换 CPU 解码重新执行当前分段。`);
      } else {
        this.log(
          'warn',
          `${label} 的 ${decoder?.label || preferredDecoder} 硬件解码不可用于当前视频，立即改用 CPU 解码重试：${compactLogLine(
            error.message
          )}`
        );
      }
      await fsp.rm(outputPath, { force: true }).catch(() => {});
      await beforeRetry?.();
      onFallback?.();
      onPhase?.('render', { force: true });
      await run('software');
      return 'software';
    } finally {
      await fsp.rm(outputPath, { force: true }).catch(() => {});
    }
  }

  async runChunkedAvatarBurn({
    cleanPath,
    assPath,
    burnedPath,
    codec,
    crf,
    startTime = 0,
    duration,
    fps,
    avatarLayer,
    decoder = 'software',
    sourceCodec = '',
    includeAudio = true,
    copyAudio = false,
    timelineAlignment,
    onChild,
    onStderr,
    onProgress,
    onStage,
    onDecoderFallback,
    onCudaAvatarFallback,
    label = '头像分段烧录',
    isCancelled
  } = {}) {
    const chunkDuration = Math.max(1, Number(avatarLayer?.chunkDuration || AVATAR_OVERLAY_CHUNK_SECONDS));
    const sourceStart = Math.max(0, Number(startTime) || 0);
    const totalDuration = Number(duration);
    const leadingVideoPaddingSec = Math.max(0, Number(timelineAlignment?.videoPaddingSec) || 0);
    const leadingAudioPaddingSec = Math.max(0, Number(timelineAlignment?.audioPaddingSec) || 0);
    if (!Number.isFinite(totalDuration) || totalDuration <= 0) {
      throw new Error('分段烧录时长无效。');
    }
    const temporaryDir = String(avatarLayer?.temporaryDir || '').trim();
    if (!temporaryDir) {
      throw new Error('分段烧录缺少头像临时目录。');
    }
    const chunkPaths = [];
    const chunkDurations = [];
    const scriptPaths = [];
    let activeDecoder = decoder;
    let avatarCompositeBackend = String(
      avatarLayer?.gpuCompositeBackend || this.getAvatarCompositeCapability()?.value || ''
    )
      .trim()
      .toLowerCase();
    let avatarCompositeEnabled = Boolean(avatarCompositeBackend);
    const concatPath = path.join(temporaryDir, 'avatar-chunks.ffconcat');
    let completedDuration = 0;
    const cancellationError = () => {
      const error = new Error('媒体处理已取消。');
      error.code = 'BR2K_MEDIA_CANCELLED';
      return error;
    };
    const reportStderr = (text) => {
      onStderr?.(text);
      const localTime = parseFfmpegProgressTime(text);
      if (Number.isFinite(localTime)) {
        onProgress?.(Math.min(totalDuration, completedDuration + Math.max(0, localTime)));
      }
    };

    try {
      let chunkIndex = 0;
      while (completedDuration < totalDuration - 0.001) {
        if (isCancelled?.()) throw cancellationError();
        const chunkStart = sourceStart + completedDuration;
        let chunkLength = Math.min(chunkDuration, totalDuration - completedDuration);
        let chunkEnd = chunkStart + chunkLength;
        let activeEntries = clipAvatarOverlayEntries(avatarLayer, chunkStart, chunkEnd);
        const canUseAvatarComposite = avatarCompositeEnabled;
        while (
          avatarCompositeBackend === 'cuda' &&
          canUseAvatarComposite &&
          activeEntries.length > MAX_CUDA_AVATAR_OVERLAY_ENTRIES &&
          chunkLength > MIN_CUDA_AVATAR_CHUNK_SECONDS + 0.001
        ) {
          chunkLength = Math.max(MIN_CUDA_AVATAR_CHUNK_SECONDS, chunkLength / 2);
          chunkEnd = chunkStart + chunkLength;
          activeEntries = clipAvatarOverlayEntries(avatarLayer, chunkStart, chunkEnd);
        }
        const initialChunk = chunkIndex === 0;
        const chunkVideoPaddingSec = initialChunk ? Math.min(leadingVideoPaddingSec, chunkLength) : 0;
        const chunkTimelineOffset = initialChunk ? chunkStart + chunkVideoPaddingSec : chunkStart;
        const chunkSeekPrerollSec = Math.min(AVATAR_CHUNK_SEEK_PREROLL_SECONDS, chunkStart);
        const chunkInputTrimEndSec = chunkSeekPrerollSec + chunkLength;
        const scriptPath = path.join(temporaryDir, `avatar-chunk-${String(chunkIndex).padStart(5, '0')}.ffscript`);
        const chunkPath = path.join(temporaryDir, `avatar-chunk-${String(chunkIndex).padStart(5, '0')}.mkv`);
        const encodedChunkPath = `${chunkPath}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.mkv`;
        const useGpuForChunk = Boolean(
          activeEntries.length > 0 &&
            canUseAvatarComposite &&
            (avatarCompositeBackend !== 'cuda' || activeEntries.length <= MAX_CUDA_AVATAR_OVERLAY_ENTRIES)
        );
        const activeCompositeBackend = useGpuForChunk ? avatarCompositeBackend : '';
        const activeCompositeLabel = useGpuForChunk
          ? this.getAvatarCompositeBackendLabel(
              { ...avatarLayer, gpuComposite: true, gpuCompositeBackend: activeCompositeBackend },
              'high'
            )
          : 'CPU 头像合成';
        onStage?.(
          `正在烧录头像分段 ${chunkIndex + 1}（${
            activeEntries.length ? activeCompositeLabel : '本段无真实头像'
          }）`
        );
        const script = createAvatarOverlayChunkFilterScript({
          assPath,
          fps,
          avatarOverlay: avatarLayer,
          chunkStart,
          chunkEnd,
          timelineOffset: chunkTimelineOffset,
          leadingVideoPaddingSec: chunkVideoPaddingSec,
          outputDuration: chunkLength,
          inputTrimStartSec: chunkSeekPrerollSec,
          inputTrimEndSec: chunkInputTrimEndSec,
          preserveSourceFrameTiming: true,
          gpuComposite: useGpuForChunk,
          gpuCompositeBackend: activeCompositeBackend,
          gpuOutputToCpu: useGpuForChunk && Boolean(avatarLayer?.gpuOutputToCpu)
        });
        if (!script) throw new Error(`头像分段 ${chunkIndex + 1} 没有生成有效滤镜。`);
        await fsp.writeFile(scriptPath, script, 'utf8');
        await fsp.rm(chunkPath, { force: true }).catch(() => {});
        scriptPaths.push(scriptPath);
        let chunkAvatarLayer = {
          ...avatarLayer,
          entries: activeEntries,
          filterScriptPath: scriptPath,
          gpuComposite: useGpuForChunk,
          gpuCompositeBackend: activeCompositeBackend
        };
        const createChunkBurnArgs = (nextDecoder) =>
          createBurnArgs({
            cleanPath,
            assPath,
            burnedPath: chunkPath,
            codec,
            crf,
            container: 'mkv',
            startTime: chunkStart,
            duration: chunkLength,
            fps,
            avatarOverlay: chunkAvatarLayer,
            inputSeek: true,
            inputSeekPrerollSec: chunkSeekPrerollSec,
            inputTrimStartSec: chunkSeekPrerollSec,
            inputTrimEndSec: chunkInputTrimEndSec,
            timelineOffset: chunkTimelineOffset,
            leadingVideoPaddingSec: chunkVideoPaddingSec,
            includeAudio: false,
            decoder: nextDecoder,
            sourceCodec
          });
        let usedDecoder;
        try {
          usedDecoder = isJetsonGstreamerCodec(codec)
            ? await this.runJetsonGstreamerTranscode({
                codec,
                quality: crf,
                width: avatarLayer?.videoWidth,
                height: avatarLayer?.videoHeight,
                fps,
                encodedVideoPath: encodedChunkPath,
                createRawArgs: (nextDecoder) =>
                  createBurnRawVideoArgs({
                    cleanPath,
                    assPath,
                    fps,
                    avatarOverlay: chunkAvatarLayer,
                    startTime: chunkStart,
                    duration: chunkLength,
                    inputSeek: true,
                    inputSeekPrerollSec: chunkSeekPrerollSec,
                    inputTrimStartSec: chunkSeekPrerollSec,
                    inputTrimEndSec: chunkInputTrimEndSec,
                    timelineOffset: chunkTimelineOffset,
                    leadingVideoPaddingSec: chunkVideoPaddingSec,
                    decoder: nextDecoder,
                    sourceCodec,
                    videoWidth: avatarLayer?.videoWidth,
                    videoHeight: avatarLayer?.videoHeight
                  }),
                createMuxArgs: () =>
                  createBurnEncodedVideoMuxArgs({
                    encodedVideoPath: encodedChunkPath,
                    cleanPath,
                    outputPath: chunkPath,
                    codec,
                    sourceCodec,
                    fps,
                    startTime: chunkStart,
                    duration: chunkLength,
                    container: 'mkv',
                    includeAudio: false
                  }),
                decoder: activeDecoder,
                onStderr: reportStderr,
                onChild,
                beforeRetry: () => fsp.rm(chunkPath, { force: true }).catch(() => {}),
                onFallback: onDecoderFallback,
                label: `${label} ${chunkIndex + 1}`
              })
            : await this.runFfmpegWithHardwareDecodeFallback({
                decoder: activeDecoder,
                createArgs: createChunkBurnArgs,
                onStderr: reportStderr,
                onChild,
                beforeRetry: () => fsp.rm(chunkPath, { force: true }).catch(() => {}),
                onFallback: onDecoderFallback,
                label: `${label} ${chunkIndex + 1}`
              });
        } catch (error) {
          if (!useGpuForChunk || error?.code === 'BR2K_MEDIA_CANCELLED' || !isFfmpegAvatarCompositeError(error)) {
            throw error;
          }
          const failedCompositeLabel = this.getAvatarCompositeBackendLabel(chunkAvatarLayer, 'high');
          avatarCompositeEnabled = false;
          this.log(
            'warn',
            `${label} 第 ${chunkIndex + 1} 段 ${failedCompositeLabel} 不兼容当前 FFmpeg，当前及后续分段改用 CPU 头像合成：${compactLogLine(
              error.message
            )}`
          );
          onCudaAvatarFallback?.();
          onStage?.(`正在烧录头像分段 ${chunkIndex + 1}（CPU 头像合成回退）`);
          const cpuScript = createAvatarOverlayChunkFilterScript({
            assPath,
            fps,
            avatarOverlay: avatarLayer,
            chunkStart,
            chunkEnd,
            timelineOffset: chunkTimelineOffset,
            leadingVideoPaddingSec: chunkVideoPaddingSec,
            outputDuration: chunkLength,
            inputTrimStartSec: chunkSeekPrerollSec,
            inputTrimEndSec: chunkInputTrimEndSec,
            preserveSourceFrameTiming: true,
            gpuComposite: false,
            gpuCompositeBackend: ''
          });
          if (!cpuScript) throw error;
          await fsp.writeFile(scriptPath, cpuScript, 'utf8');
          await fsp.rm(chunkPath, { force: true }).catch(() => {});
          chunkAvatarLayer = { ...chunkAvatarLayer, gpuComposite: false, gpuCompositeBackend: '', gpuOutputToCpu: false };
          usedDecoder = isJetsonGstreamerCodec(codec)
            ? await this.runJetsonGstreamerTranscode({
                codec,
                quality: crf,
                width: avatarLayer?.videoWidth,
                height: avatarLayer?.videoHeight,
                fps,
                encodedVideoPath: encodedChunkPath,
                createRawArgs: (nextDecoder) =>
                  createBurnRawVideoArgs({
                    cleanPath,
                    assPath,
                    fps,
                    avatarOverlay: chunkAvatarLayer,
                    startTime: chunkStart,
                    duration: chunkLength,
                    inputSeek: true,
                    inputSeekPrerollSec: chunkSeekPrerollSec,
                    inputTrimStartSec: chunkSeekPrerollSec,
                    inputTrimEndSec: chunkInputTrimEndSec,
                    timelineOffset: chunkTimelineOffset,
                    leadingVideoPaddingSec: chunkVideoPaddingSec,
                    decoder: nextDecoder,
                    sourceCodec,
                    videoWidth: avatarLayer?.videoWidth,
                    videoHeight: avatarLayer?.videoHeight
                  }),
                createMuxArgs: () =>
                  createBurnEncodedVideoMuxArgs({
                    encodedVideoPath: encodedChunkPath,
                    cleanPath,
                    outputPath: chunkPath,
                    codec,
                    sourceCodec,
                    fps,
                    startTime: chunkStart,
                    duration: chunkLength,
                    container: 'mkv',
                    includeAudio: false
                  }),
                decoder: activeDecoder,
                onStderr: reportStderr,
                onChild,
                beforeRetry: () => fsp.rm(chunkPath, { force: true }).catch(() => {}),
                onFallback: onDecoderFallback,
                label: `${label} ${chunkIndex + 1}（CPU 头像合成）`
              })
            : await this.runFfmpegWithHardwareDecodeFallback({
                decoder: activeDecoder,
                createArgs: createChunkBurnArgs,
                onStderr: reportStderr,
                onChild,
                beforeRetry: () => fsp.rm(chunkPath, { force: true }).catch(() => {}),
                onFallback: onDecoderFallback,
                label: `${label} ${chunkIndex + 1}（CPU 头像合成）`
              });
        }
        activeDecoder = usedDecoder;
        // A short, static chunk can legitimately be smaller than the final
        // output-size sanity threshold.  Only reject a missing/nearly-empty
        // intermediate container here; the final output gets the full media
        // stream and size validation below.
        if ((await getFileSize(chunkPath)) < 1024) {
          throw new Error(`头像分段 ${chunkIndex + 1} 输出未通过文件大小验证。`);
        }
        chunkPaths.push(chunkPath);
        chunkDurations.push(chunkLength);
        completedDuration += chunkLength;
        onProgress?.(Math.min(totalDuration, completedDuration));
        chunkIndex += 1;
      }

      if (isCancelled?.()) throw cancellationError();
      // Explicit source-time windows prevent the concat demuxer from using
      // each H.26x chunk's trailing DTS (typically a few B-frames early) as
      // the start of the next chunk. Without this, a long burn slowly pulls
      // video behind the separately muxed source audio.
      await writeConcatFile(concatPath, chunkPaths, { durations: chunkDurations });
      onStage?.('正在封装连续视频和源音频');
      await runFfmpegJob(
        this.ffmpegPath,
        includeAudio
          ? createBurnAudioMuxArgs({
              concatPath,
              cleanPath,
              outputPath: burnedPath,
              codec,
              sourceCodec,
              startTime: sourceStart,
              duration: totalDuration,
              container: getContainerFromPath(burnedPath),
              leadingAudioPaddingSec,
              includeAudio: true,
              copyAudio
            })
          : createConcatCopyArgs({
              concatPath,
              outputPath: burnedPath,
              container: getContainerFromPath(burnedPath),
              streamCodec: codec
            }),
        reportStderr,
        { onChild }
      );
      onProgress?.(totalDuration);
    } finally {
      await Promise.all(
        [...chunkPaths, concatPath, ...scriptPaths].map((filePath) => fsp.rm(filePath, { force: true }).catch(() => {}))
      );
    }
  }

  async startSceneGraphBurnRecording(room, recording, options, context) {
    const source = context || {};
    const burnCodec = source.burnCodec;
    const burnCrf = source.burnCrf;
    const overlayMode = source.overlayMode;
    const danmakuArea = source.danmakuArea;
    const stylePreset = source.stylePreset;
    const styleLayout = source.styleLayout;
    const mediaInfo = source.mediaInfo || {};
    const actualTimeline = source.actualTimeline || null;
    const durationSec = Math.max(0, Number(source.durationSec || recording.durationSec || 0));
    const codecInfo = this.getBurnCodecInfo(burnCodec);
    const decoderInfo = this.getHardwareDecoder(recording.videoInfo || mediaInfo.videoInfo, burnCodec);
    if (options.prepareOnly) {
      const tracks = await this.generateSceneAssTracks(recording, {
        overlayMode,
        danmakuArea,
        stylePreset,
        styleLayout,
        videoInfo: recording.videoInfo || mediaInfo.videoInfo,
        durationSec,
        presets: SCENE_STYLE_PRESETS,
        remux: false
      });
      this.log('success', roomLabel(room) + ' 已生成 Scene Graph 四套 ASS 轨：' + tracks.tracks.map((track) => path.basename(track.assPath)).join(' / '));
      return true;
    }
    const burnedPath = options.outputPath || deriveBurnedPath(recording.cleanPath, overlayMode);
    const burnedTmpPath = replaceExtension(burnedPath, '.tmp.' + getContainerFromPath(burnedPath));
    const burnFps = recording.videoInfo?.fps || mediaInfo.videoInfo?.fps || 30;
    const burnTimeline = getBurnTimelineAlignment(recording, 0, durationSec, actualTimeline);
    const copySourceAudio = canCopyWholeSourceAudio(mediaInfo, 0, durationSec, burnTimeline);
    let sceneDirectory = '';
    try {
      recording.burnedPath = burnedPath;
      await assertDiskSpace(burnedPath, {
        estimatedBytes: Number(recording.fileSize || 0) * (isJetsonGstreamerCodec(burnCodec) ? 2 : 1)
      });
      await fsp.rm(burnedTmpPath, { force: true }).catch(() => {});
      sceneDirectory = await fsp.mkdtemp(path.join(os.tmpdir(), 'br2k-burn-scene-'));
      const sceneResult = await this.buildSceneGraphForRecording(recording, {
        overlayMode,
        danmakuArea,
        stylePreset,
        styleLayout,
        videoInfo: recording.videoInfo || mediaInfo.videoInfo,
        durationSec
      });
      const graph = durationSec > 0 ? clipSceneGraph(sceneResult.graph, 0, durationSec, { shiftTime: false }) : sceneResult.graph;
      const legacyAssPath = await this.writeLegacySceneCompatibilityAss(
        path.join(sceneDirectory, 'scene.legacy.ass'),
        sceneResult.events,
        {
          overlayMode,
          danmakuArea,
          stylePreset,
          styleLayout,
          videoInfo: recording.videoInfo || mediaInfo.videoInfo,
          endTime: durationSec > 0 ? durationSec : undefined
        }
      );
      const target = isJetsonGstreamerCodec(burnCodec)
        ? 'jetson'
        : String(burnCodec || '').includes('nvenc')
          ? 'cuda'
          : 'software';
      const sceneLayer = await writeSceneFilterScript(path.join(sceneDirectory, 'scene.filter'), graph, {
        duration: durationSec || graph.timeline.end,
        outputDuration: durationSec || graph.timeline.end,
        leadingVideoPaddingSec: burnTimeline.videoPaddingSec,
        fps: burnFps,
        target,
        legacyAssPath
      });
      const progress = createFfmpegJobProgress({
        kind: 'burn',
        label: '生成 Scene Graph 弹幕版：' + path.basename(burnedPath),
        outputPath: burnedPath,
        durationSec,
        roomId: room.id,
        codec: burnCodec,
        codecKind: codecInfo.kind,
        decoder: decoderInfo.value,
        decoderKind: decoderInfo.kind,
        decoderLabel: decoderInfo.label,
        sourceFps: burnFps,
        encoderBackend: this.getEncoderBackendLabel(codecInfo),
        avatarCompositeBackend: 'Scene Graph 直接合成'
      });
      room.burning = true;
      room.burnProgress = progress;
      options.onProgressCreated?.(progress);
      this.burnSessions.set(room.id, null);
      this.log(
        'info',
        roomLabel(room) + ' 正在直接合成 Scene Graph 弹幕版：' + path.basename(burnedPath) +
          '（' + overlayModeLabel(overlayMode) + '，' + danmakuDisplayAreaLabel(danmakuArea) + '，样式 ' + stylePreset +
          '，编码器 ' + burnCodec + '）'
      );
      if (this.settings.notifyBurnStarted) {
        this.notify('开始烧录弹幕版', roomLabel(room) + ' 正在直接合成 ' + path.basename(burnedPath), 'burn.started', {
          roomId: room.id,
          roomTitle: room.title || '',
          anchor: room.anchor || '',
          fileName: path.basename(burnedPath)
        });
      }
      const onStderr = (line) => {
        if (updateFfmpegJobProgress(progress, line)) this.markRoomDirty(room.id);
        if (/error|failed|invalid/i.test(line)) this.log('warn', roomLabel(room) + ' Scene Graph 烧录：' + compactLogLine(line));
      };
      const onDecoderFallback = () => {
        this.setProgressDecoder(progress, { value: 'software', label: 'CPU', kind: 'software' });
        this.setProgressFallback(progress, '硬件解码不兼容，已回退到 CPU 解码；Scene Graph 几何未改变。');
        this.markRoomDirty(room.id);
      };
      const finish = async (processingError) => {
        const cancelled = this.burnCancelRequests.delete(room.id) || processingError?.code === 'BR2K_MEDIA_CANCELLED';
        let failure = processingError || null;
        if (!cancelled && !failure) {
          try {
            const result = await probeMediaFileInfo(this.ffmpegPath, burnedTmpPath, { timeoutMs: 15000 });
            if (!result.videoInfo || (await getFileSize(burnedTmpPath)) < 32 * 1024) {
              throw new Error('Scene Graph 烧录临时输出未通过视频流与文件大小验证。');
            }
            await atomicReplaceFile(burnedTmpPath, burnedPath);
          } catch (error) {
            failure = error;
          }
        }
        room.burning = false;
        this.burnSessions.delete(room.id);
        if (cancelled) {
          finishFfmpegJobProgress(progress, 'cancelled', 'Scene Graph 弹幕视频生成已取消');
          await fsp.rm(burnedTmpPath, { force: true }).catch(() => {});
        } else if (!failure) {
          finishFfmpegJobProgress(progress, 'completed', 'Scene Graph 弹幕版已生成');
          this.log('success', roomLabel(room) + ' Scene Graph 弹幕版已生成：' + path.basename(burnedPath));
          if (this.settings.notifyBurnEnded) {
            this.notify('弹幕版已生成', roomLabel(room) + ' ' + path.basename(burnedPath), 'burn.completed', {
              roomId: room.id,
              roomTitle: room.title || '',
              anchor: room.anchor || '',
              fileName: path.basename(burnedPath)
            });
          }
        } else {
          await fsp.rm(burnedTmpPath, { force: true }).catch(() => {});
          finishFfmpegJobProgress(progress, 'error', 'Scene Graph 烧录失败：' + failure.message);
          this.log('error', roomLabel(room) + ' Scene Graph 烧录失败：' + failure.message);
        }
        await this.cleanupPendingSegmentCleanupsForRoom(room);
        this.emitState(['room', 'recording', 'mediaJob']);
        setTimeout(() => {
          if (room.burnProgress?.id === progress.id) {
            delete room.burnProgress;
            this.markRoomDirty(room.id);
          }
        }, 5000).unref?.();
        this.scheduleQueuedUpdateCheck();
      };
      void (async () => {
        let processingError = null;
        try {
          const createArgs = (decoder) =>
            createBurnArgs({
              cleanPath: recording.cleanPath,
              assPath: '',
              burnedPath: burnedTmpPath,
              codec: burnCodec,
              crf: burnCrf,
              container: getContainerFromPath(burnedPath),
              startTime: 0,
              duration: durationSec,
              fps: burnFps,
              avatarOverlay: { filterScriptPath: sceneLayer.filterScriptPath },
              timelineOffset: 0,
              leadingVideoPaddingSec: 0,
              leadingAudioPaddingSec: 0,
              copyAudio: copySourceAudio,
              decoder,
              sourceCodec: decoderInfo.codec
            });
          if (isJetsonGstreamerCodec(burnCodec)) {
            const encodedVideoPath = burnedTmpPath + '.' + process.pid + '.' + crypto.randomBytes(6).toString('hex') + '.mkv';
            await this.runJetsonGstreamerTranscode({
              codec: burnCodec,
              quality: burnCrf,
              width: recording.videoInfo?.width || mediaInfo.videoInfo?.width,
              height: recording.videoInfo?.height || mediaInfo.videoInfo?.height,
              fps: burnFps,
              encodedVideoPath,
              createRawArgs: (decoder) =>
                createBurnRawVideoArgs({
                  cleanPath: recording.cleanPath,
                  assPath: '',
                  fps: burnFps,
                  avatarOverlay: { filterScriptPath: sceneLayer.filterScriptPath },
                  startTime: 0,
                  duration: durationSec,
                  timelineOffset: 0,
                  leadingVideoPaddingSec: 0,
                  decoder,
                  sourceCodec: decoderInfo.codec,
                  videoWidth: recording.videoInfo?.width || mediaInfo.videoInfo?.width,
                  videoHeight: recording.videoInfo?.height || mediaInfo.videoInfo?.height
                }),
              createMuxArgs: () =>
                createBurnEncodedVideoMuxArgs({
                  encodedVideoPath,
                  cleanPath: recording.cleanPath,
                  outputPath: burnedTmpPath,
                  codec: burnCodec,
                  sourceCodec: mediaInfo.videoInfo?.codec,
                  fps: burnFps,
                  startTime: 0,
                  duration: durationSec,
                  container: getContainerFromPath(burnedPath),
                  includeAudio: Boolean(mediaInfo.audioInfo),
                  copyAudio: copySourceAudio
                }),
              decoder: decoderInfo,
              onStderr,
              onChild: (child) => this.burnSessions.set(room.id, child),
              beforeRetry: () => fsp.rm(burnedTmpPath, { force: true }).catch(() => {}),
              onFallback: onDecoderFallback,
              label: roomLabel(room) + ' Jetson Scene Graph 烧录'
            });
          } else {
            await this.runFfmpegWithHardwareDecodeFallback({
              decoder: decoderInfo,
              createArgs,
              onStderr,
              onChild: (child) => this.burnSessions.set(room.id, child),
              beforeRetry: () => fsp.rm(burnedTmpPath, { force: true }).catch(() => {}),
              onFallback: onDecoderFallback,
              label: roomLabel(room) + ' Scene Graph 烧录'
            });
          }
        } catch (error) {
          processingError = error;
        }
        try {
          await finish(processingError);
        } finally {
          await fsp.rm(sceneDirectory, { recursive: true, force: true }).catch(() => {});
        }
      })();
      this.emitState(['room', 'recording', 'mediaJob']);
      return true;
    } catch (error) {
      this.burnSessions.delete(room.id);
      room.burning = false;
      await fsp.rm(burnedTmpPath, { force: true }).catch(() => {});
      if (sceneDirectory) await fsp.rm(sceneDirectory, { recursive: true, force: true }).catch(() => {});
      throw error;
    }
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
    await this.waitForRuntimeCapabilities();
    const burnCodec = this.chooseBurnCodec(options.codec || this.settings.burnCodec);
    this.requireAvailableBurnCodec(burnCodec, '自动弹幕烧录');
    const burnCrf = clamp(Number(options.crf ?? this.settings.burnCrf), 16, 35);

    let avatarLayer = null;
    try {
      const overlayMode = normalizeBurnOverlayMode(options.overlayMode || this.settings.burnOverlayMode);
      const danmakuArea = normalizeDanmakuDisplayArea(options.danmakuArea || this.settings.burnDanmakuArea);
      const requestedStylePreset = normalizeDanmakuStylePreset(options.stylePreset ?? this.settings.burnDanmakuStylePreset);
      const stylePreset = this.resolveSceneGraphStylePreset(requestedStylePreset);
      const styleLayout = normalizeDanmakuStyleLayout(options.styleLayout ?? this.settings.burnDanmakuStyleLayout);
      const avatarMode = normalizeBurnAvatarMode(options.avatarMode ?? this.settings.burnAvatarMode);
      this.burnCancelRequests.delete(room.id);
      const mediaInfo = await probeMediaFileInfo(this.ffmpegPath, recording.cleanPath);
      const durationSec = await this.resolveRecordingDuration(recording, mediaInfo);
      if (durationSec > 0) {
        recording.durationSec = durationSec;
      }
      if (mediaInfo.videoInfo) {
        recording.videoInfo = mediaInfo.videoInfo;
      }
      const actualTimeline = await probeMediaClipTimelineInfo(
        this.ffmpegPath,
        recording.cleanPath,
        0,
        durationSec,
        mediaInfo,
        { timeoutMs: 30_000, packetSampleDurationSec: Math.min(2, durationSec || 2) }
      ).catch((error) => {
        this.log('warn', `自动烧录实际 PTS 探测失败，按无起始 A/V 偏移继续：${compactLogLine(error.message)}`);
        return { actualClipProbe: true, firstVideoPts: null, firstAudioPts: null, avStartDeltaSec: null, avBoundaryToleranceSec: 0.08 };
      });
      if (SCENE_STYLE_PRESETS.includes(stylePreset)) {
        return this.startSceneGraphBurnRecording(room, recording, options, {
          burnCodec,
          burnCrf,
          overlayMode,
          danmakuArea,
          stylePreset,
          styleLayout,
          mediaInfo,
          actualTimeline,
          durationSec
        });
      }
      const burnTimeline = getBurnTimelineAlignment(recording, 0, durationSec, actualTimeline);
      const copySourceAudio = canCopyWholeSourceAudio(mediaInfo, 0, durationSec, burnTimeline);
      const assets = await this.generateSubtitleAssets(recording, { overlayMode, danmakuArea, stylePreset, styleLayout, avatarMode });
      if (options.prepareOnly) {
        this.log('success', `${roomLabel(room)} 字幕文件已生成：${path.basename(assets.cssPath)} / ${path.basename(assets.assPath)}`);
        return true;
      }
      const burnedPath = options.outputPath || deriveBurnedPath(recording.cleanPath, overlayMode);
      const burnedTmpPath = replaceExtension(burnedPath, `.tmp.${getContainerFromPath(burnedPath)}`);
      recording.burnedPath = burnedPath;
      const codecInfo = this.getBurnCodecInfo(burnCodec);
      const decoderInfo = this.getHardwareDecoder(recording.videoInfo || mediaInfo.videoInfo, burnCodec);
      const burnSourcePath = recording.cleanPath;
      const deleteSourceAfterSuccess = false;

      // The Jetson bridge retains one elementary encoded stream until FFmpeg
      // has muxed the final container, so reserve room for both temporary and
      // final files instead of assuming the direct-FFmpeg one-file workflow.
      await assertDiskSpace(burnedPath, {
        estimatedBytes: Number(recording.fileSize || 0) * (isJetsonGstreamerCodec(burnCodec) ? 2 : 1)
      });
      await fsp.rm(burnedTmpPath, { force: true }).catch(() => {});
      const burnFps = recording.videoInfo?.fps || mediaInfo.videoInfo?.fps;
      const avatarComposite = this.selectAvatarCompositeBackend(assets.avatarPlan);
      const requestedAvatarComposite = avatarComposite || this.getAvatarCompositeCapability();
      const gpuAvatarComposite = Boolean(avatarComposite);
      const gpuAvatarOutputToCpu =
        requestedAvatarComposite?.value !== 'cuda' || !String(burnCodec || '').includes('nvenc');
      let avatarDiagnostics = null;
      avatarLayer = await this.prepareAvatarOverlayLayer(assets.avatarPlan, {
        recording,
        assPath: assets.assPath,
        fps: burnFps,
        duration: durationSec,
        timelineOffset: burnTimeline.videoClockStartSec,
        leadingVideoPaddingSec: burnTimeline.videoPaddingSec,
        outputDuration: durationSec,
        label: `${roomLabel(room)} 烧录`,
        gpuComposite: gpuAvatarComposite,
        gpuCompositeBackend: requestedAvatarComposite?.value || '',
        gpuCompositeMode: requestedAvatarComposite?.mode || '',
        gpuCompositeDevice: requestedAvatarComposite?.device || '',
        gpuOutputToCpu: gpuAvatarOutputToCpu,
        onDiagnostics: (diagnostics) => {
          avatarDiagnostics = diagnostics;
        },
        isCancelled: () => this.burnCancelRequests.has(room.id)
      });
      const progress = createFfmpegJobProgress({
        kind: 'burn',
        label: `生成弹幕版：${path.basename(burnedPath)}`,
        outputPath: burnedPath,
        durationSec: recording.durationSec,
        roomId: room.id,
        codec: burnCodec,
        codecKind: codecInfo.kind,
        decoder: decoderInfo.value,
        decoderKind: decoderInfo.kind,
        decoderLabel: decoderInfo.label,
        sourceFps: burnFps,
        encoderBackend: this.getEncoderBackendLabel(codecInfo),
        avatarCompositeBackend: this.getAvatarCompositeBackendLabel(avatarLayer, avatarMode),
        avatarDiagnostics: avatarDiagnostics || avatarLayer?.diagnostics
      });
      room.burning = true;
      room.burnProgress = progress;
      options.onProgressCreated?.(progress);
      // A chunked burn has several short-lived FFmpeg children.  Keep a map
      // entry during the gaps between children so queue/cancel state remains
      // stable; onChild below replaces null with the current process.
      this.burnSessions.set(room.id, null);
      this.log(
        'info',
        `${roomLabel(room)} 正在生成有弹幕版：${path.basename(burnedPath)}（${overlayModeLabel(
          overlayMode
        )}，${danmakuDisplayAreaLabel(danmakuArea)}，样式 ${stylePreset}，选中的编码器 ${burnCodec}，实际后端 ${this.getEncoderBackendLabel(
          codecInfo
        )}，解码后端 ${decoderInfo.kind === 'hardware' ? decoderInfo.label : 'CPU'}，头像合成后端 ${this.getAvatarCompositeBackendLabel(
          avatarLayer,
          avatarMode
        )}${assets.playWidth > 0 && assets.playHeight > 0 ? `，${assets.playWidth}x${assets.playHeight}${assets.portrait ? ' 竖屏适配' : ''}` : ''}）`
      );
      if (this.settings.notifyBurnStarted) {
        this.notify('开始烧录弹幕版', `${roomLabel(room)} 正在生成 ${path.basename(burnedPath)}`, 'burn.started', {
          roomId: room.id,
          roomTitle: room.title || '',
          anchor: room.anchor || '',
          fileName: path.basename(burnedPath)
        });
      }

      const handleBurnStderr = (text) => {
        if (updateFfmpegJobProgress(progress, text)) {
          this.markRoomDirty(room.id);
        }
        handleBurnLog(text);
      };
      const handleBurnLog = (text) => {
        if (/error|failed|invalid/i.test(text)) {
          this.log('warn', `${roomLabel(room)} 烧录：${compactLogLine(text)}`);
        }
      };
      const handleBurnProgress = (currentTimeSec) => {
        const value = Math.max(0, Number(currentTimeSec) || 0);
        if (updateFfmpegJobProgress(progress, `out_time_us=${Math.round(value * 1_000_000)}`)) {
          this.markRoomDirty(room.id);
        }
      };
      const setBurnStage = (stage) => {
        if (room.burnProgress?.id !== progress.id || progress.status !== 'running') return;
        progress.stageLabel = stage;
        progress.message = stage;
        progress.updatedAt = Date.now();
        this.markRoomDirty(room.id);
      };
      const finishBurn = async (processingError = null) => {
        const cancelled = this.burnCancelRequests.delete(room.id) || processingError?.code === 'BR2K_MEDIA_CANCELLED';
        let validationError = processingError;
        let exitCode = Number.isFinite(Number(processingError?.ffmpegExitCode))
          ? Number(processingError.ffmpegExitCode)
          : processingError
            ? -1
            : 0;
        const signal = processingError?.ffmpegSignal || '';
        let burnedSuccessfully = false;
        if (!cancelled && !processingError && exitCode === 0) {
          try {
            const result = await probeMediaFileInfo(this.ffmpegPath, burnedTmpPath, { timeoutMs: 15000 });
            if (!result.videoInfo || (await getFileSize(burnedTmpPath)) < 32 * 1024) {
              throw new Error('烧录临时输出未通过视频流与文件大小验证。');
            }
            await atomicReplaceFile(burnedTmpPath, burnedPath);
          } catch (error) {
            validationError = error;
            exitCode = -1;
          }
        }
        room.burning = false;
        this.burnSessions.delete(room.id);
        await this.cleanupAvatarOverlayLayer(avatarLayer);
        if (cancelled) {
          finishFfmpegJobProgress(progress, 'cancelled', '弹幕视频生成已取消');
          await fsp.rm(burnedTmpPath, { force: true }).catch(() => {});
          this.log('info', `${roomLabel(room)} 已取消生成弹幕视频：${path.basename(burnedPath)}`);
        } else if (exitCode === 0 && !validationError) {
          burnedSuccessfully = true;
          finishFfmpegJobProgress(progress, 'completed', '弹幕版已生成');
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
          const failureDetail = validationError?.message || `退出码 ${exitCode}`;
          finishFfmpegJobProgress(progress, 'error', `烧录失败：${failureDetail}`);
          this.log('error', `${roomLabel(room)} 烧录失败：${failureDetail}，信号 ${signal || '-'}`);
          if (this.settings.notifyBurnEnded) {
            this.notify('弹幕版烧录失败', `${roomLabel(room)} 退出码 ${exitCode}`, 'burn.failed', {
              roomId: room.id,
              roomTitle: room.title || '',
              anchor: room.anchor || '',
              fileName: path.basename(burnedPath),
              exitCode
            });
          }
        }
        await this.cleanupPendingSegmentCleanupsForRoom(room);
        if (burnedSuccessfully && deleteSourceAfterSuccess) {
          try {
            await this.deleteBurnSourceAfterSuccess(room, recording, burnedPath);
          } catch (error) {
            this.log('warn', `${roomLabel(room)} 弹幕版已生成，但自动删除源文件失败：${error.message}`);
          }
        }
        this.emitState(['room', 'recording', 'mediaJob']);
        setTimeout(() => {
          if (room.burnProgress?.id === progress.id) {
            delete room.burnProgress;
            this.markRoomDirty(room.id);
          }
        }, 5000).unref?.();
        this.scheduleQueuedUpdateCheck();
      };
      void (async () => {
        let processingError = null;
        try {
          if (avatarLayer?.chunked) {
            await this.runChunkedAvatarBurn({
              cleanPath: burnSourcePath,
              assPath: assets.assPath,
              burnedPath: burnedTmpPath,
              codec: burnCodec,
              crf: burnCrf,
              duration: durationSec,
              fps: burnFps,
              avatarLayer,
              decoder: decoderInfo,
              sourceCodec: decoderInfo.codec,
              includeAudio: Boolean(mediaInfo.audioInfo),
              copyAudio: copySourceAudio,
              timelineAlignment: burnTimeline,
              onChild: (child) => this.burnSessions.set(room.id, child),
              onStderr: handleBurnLog,
              onProgress: handleBurnProgress,
              onStage: setBurnStage,
              onDecoderFallback: () => {
                this.setProgressDecoder(progress, { value: 'software', label: 'CPU', kind: 'software' });
                this.setProgressFallback(progress, '硬件解码不兼容，已回退到 CPU 解码。');
                this.markRoomDirty(room.id);
              },
              onCudaAvatarFallback: () => {
                this.setProgressFallback(progress, 'GPU 头像合成不兼容，已回退到 CPU 头像合成。', {
                  avatarCompositeBackend: 'CPU 头像合成'
                });
                this.markRoomDirty(room.id);
              },
              label: `${roomLabel(room)} 头像分段烧录`,
              isCancelled: () => this.burnCancelRequests.has(room.id)
            });
          } else {
            const createFullBurnArgs = (decoder, nextAvatarLayer = avatarLayer) =>
              createBurnArgs({
                cleanPath: burnSourcePath,
                assPath: assets.assPath,
                burnedPath: burnedTmpPath,
                codec: burnCodec,
                crf: burnCrf,
                container: getContainerFromPath(burnedPath),
                startTime: 0,
                duration: durationSec,
                fps: burnFps,
                avatarOverlay: nextAvatarLayer,
                timelineOffset: burnTimeline.videoClockStartSec,
                leadingVideoPaddingSec: burnTimeline.videoPaddingSec,
                leadingAudioPaddingSec: burnTimeline.audioPaddingSec,
                copyAudio: copySourceAudio,
                decoder,
                sourceCodec: decoderInfo.codec
              });
            const onDecoderFallback = () => {
              this.setProgressDecoder(
                progress,
                { value: 'software', label: 'CPU', kind: 'software' },
                { reset: true, message: '硬件解码不兼容，正在使用 CPU 解码重新烧录' }
              );
              this.setProgressFallback(progress, '硬件解码不兼容，已回退到 CPU 解码。');
              this.markRoomDirty(room.id);
            };
            const onCudaAvatarCompositeFallback = () => {
              if (room.burnProgress?.id === progress.id) {
                this.setProgressFallback(progress, 'GPU 头像合成不兼容，已回退到 CPU 头像合成。', {
                  reset: true,
                  message: 'GPU 头像合成不兼容，正在使用 CPU 头像合成重新烧录',
                  avatarCompositeBackend: 'CPU 头像合成'
                });
              }
              this.markRoomDirty(room.id);
            };
            if (isJetsonGstreamerCodec(burnCodec)) {
              const encodedVideoPath = `${burnedTmpPath}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.mkv`;
              await this.runJetsonGstreamerWithCudaAvatarCompositeFallback({
                avatarLayer,
                createTranscode: (nextAvatarLayer) =>
                  this.runJetsonGstreamerTranscode({
                    codec: burnCodec,
                    quality: burnCrf,
                    width: recording.videoInfo?.width || mediaInfo.videoInfo?.width,
                    height: recording.videoInfo?.height || mediaInfo.videoInfo?.height,
                    fps: burnFps,
                    encodedVideoPath,
                    createRawArgs: (decoder) =>
                      createBurnRawVideoArgs({
                        cleanPath: burnSourcePath,
                        assPath: assets.assPath,
                        fps: burnFps,
                        avatarOverlay: nextAvatarLayer,
                        startTime: 0,
                        duration: durationSec,
                        timelineOffset: burnTimeline.videoClockStartSec,
                        leadingVideoPaddingSec: burnTimeline.videoPaddingSec,
                        decoder,
                        sourceCodec: decoderInfo.codec,
                        videoWidth: recording.videoInfo?.width || mediaInfo.videoInfo?.width,
                        videoHeight: recording.videoInfo?.height || mediaInfo.videoInfo?.height
                      }),
                    createMuxArgs: () =>
                      createBurnEncodedVideoMuxArgs({
                        encodedVideoPath,
                        cleanPath: burnSourcePath,
                        outputPath: burnedTmpPath,
                        codec: burnCodec,
                        sourceCodec: mediaInfo.videoInfo?.codec,
                        fps: burnFps,
                        startTime: 0,
                        duration: durationSec,
                        container: getContainerFromPath(burnedPath),
                        leadingAudioPaddingSec: burnTimeline.audioPaddingSec,
                        includeAudio: Boolean(mediaInfo.audioInfo),
                        copyAudio: copySourceAudio
                      }),
                    decoder: decoderInfo,
                    onStderr: handleBurnStderr,
                    onChild: (child) => this.burnSessions.set(room.id, child),
                    beforeRetry: () => fsp.rm(burnedTmpPath, { force: true }).catch(() => {}),
                    onFallback: onDecoderFallback,
                    label: `${roomLabel(room)} Jetson 烧录`
                  }),
                beforeRetry: () => fsp.rm(burnedTmpPath, { force: true }).catch(() => {}),
                onCudaFallback: onCudaAvatarCompositeFallback,
                label: `${roomLabel(room)} Jetson 烧录`
              });
            } else {
              await this.runFfmpegWithCudaAvatarCompositeFallback({
                avatarLayer,
                decoder: decoderInfo,
                createArgs: createFullBurnArgs,
                onStderr: handleBurnStderr,
                onChild: (child) => this.burnSessions.set(room.id, child),
                beforeRetry: () => fsp.rm(burnedTmpPath, { force: true }).catch(() => {}),
                onDecoderFallback,
                onCudaFallback: onCudaAvatarCompositeFallback,
                label: `${roomLabel(room)} 烧录`
              });
            }
          }
        } catch (error) {
          processingError = error;
        }
        try {
          await finishBurn(processingError);
        } catch (error) {
          room.burning = false;
          this.burnSessions.delete(room.id);
          await this.cleanupAvatarOverlayLayer(avatarLayer);
          this.log('error', `${roomLabel(room)} 烧录收尾失败：${error.message}`);
          this.emitState(['room', 'recording', 'mediaJob']);
        }
      })();
      this.emitState(['room', 'recording', 'mediaJob']);
      return true;
    } catch (error) {
      await this.cleanupAvatarOverlayLayer(avatarLayer);
      const cancelled = this.burnCancelRequests.delete(room.id);
      room.burning = false;
      this.burnSessions.delete(room.id);
      finishFfmpegJobProgress(
        room.burnProgress,
        cancelled ? 'cancelled' : 'error',
        cancelled ? '弹幕视频生成已取消' : `生成失败：${error.message}`
      );
      this.log(cancelled ? 'info' : 'error', `${roomLabel(room)} ${cancelled ? '已取消生成弹幕视频' : `生成弹幕版失败：${error.message}`}`);
      this.emitState(['room', 'recording', 'mediaJob']);
      return false;
    }
    this.emitState(['room', 'recording', 'mediaJob']);
    return true;
  }

  async cancelBurnDanmaku(roomId) {
    const room = this.getRoom(roomId);
    this.burnCancelRequests.add(room.id);
    const ffmpeg = this.burnSessions.get(room.id);
    if (!ffmpeg) {
      if (room.burning) {
        this.log('info', `${roomLabel(room)} 已标记取消，当前分段结束后停止弹幕视频生成。`);
        this.emitState(['room', 'mediaJob']);
      }
      return this.getState();
    }
    if (room.burnProgress?.status === 'running') {
      room.burnProgress.message = '正在中断弹幕视频生成';
      room.burnProgress.updatedAt = Date.now();
    }
    this.log('info', `${roomLabel(room)} 正在取消弹幕视频生成。`);
    requestFfmpegStop(ffmpeg, { graceful: false, timeoutMs: 1500 });
    this.emitState(['room', 'mediaJob']);
    return this.getState();
  }

  async generateSceneAssTracks(recording, options = {}) {
    const normalized = this.normalizeRecording(recording) || recording;
    if (!normalized?.cleanPath) throw new Error('请选择录像文件。');
    await this.ensurePlatformCjkFont();
    const selectedStyle = this.resolveSceneGraphStylePreset(options.stylePreset || this.settings.sceneGraphDefaultStyle);
    const requestedPresets = Array.isArray(options.presets) && options.presets.length
      ? options.presets.map(String).filter((preset) => SCENE_STYLE_PRESETS.includes(preset))
      : SCENE_STYLE_PRESETS.slice();
    const presets = requestedPresets.length ? Array.from(new Set(requestedPresets)) : SCENE_STYLE_PRESETS.slice();
    const [events, avatarAssets] = await Promise.all([
      this.readSceneEventsForRecording(normalized),
      this.getSceneAvatarAssets(normalized)
    ]);
    let durationSec = Number(options.durationSec || normalized.durationSec || 0);
    if (!(durationSec > 0) && normalized.cleanPath) {
      const mediaInfo = await probeMediaFileInfo(this.ffmpegPath, normalized.cleanPath).catch(() => null);
      durationSec = await this.resolveRecordingDuration(normalized, mediaInfo || {}, 0);
      if (mediaInfo?.videoInfo) normalized.videoInfo = mediaInfo.videoInfo;
    }
    const startTime = Number.isFinite(Number(options.startTime)) ? Math.max(0, Number(options.startTime)) : 0;
    const endTime = Number.isFinite(Number(options.endTime)) && Number(options.endTime) > startTime
      ? Number(options.endTime)
      : durationSec > 0
        ? durationSec
        : 0;
    const tracks = [];
    let selectedGraph = null;
    for (const preset of presets) {
      let graph = buildSceneGraph(
        events,
        this.getSceneGraphOptions(normalized, {
          ...options,
          stylePreset: preset,
          avatarAssets,
          videoInfo: options.videoInfo || normalized.videoInfo
        })
      );
      if (endTime > startTime) {
        graph = clipSceneGraph(graph, startTime, endTime, { shiftTime: options.shiftTime === true });
      } else if (durationSec > 0) {
        graph = clipSceneGraph(graph, 0, durationSec, { shiftTime: false });
      }
      const compiled = compileSceneToAss(graph);
      const assPath = options.assPath && presets.length === 1
        ? String(options.assPath)
        : deriveSceneAssPath(normalized.cleanPath, preset);
      const temporaryAssPath = assPath + '.' + process.pid + '.' + Date.now() + '.tmp';
      await fsp.writeFile(temporaryAssPath, compiled.ass, { encoding: 'utf8', mode: 0o660 });
      await atomicReplaceFile(temporaryAssPath, assPath);
      tracks.push({
        preset,
        assPath,
        objectCount: compiled.objectCount,
        degradedEffects: compiled.degradedEffects
      });
      if (preset === selectedStyle) selectedGraph = graph;
    }
    if (!selectedGraph) {
      selectedGraph = buildSceneGraph(
        events,
        this.getSceneGraphOptions(normalized, {
          ...options,
          stylePreset: selectedStyle,
          avatarAssets,
          videoInfo: options.videoInfo || normalized.videoInfo
        })
      );
      if (durationSec > 0) selectedGraph = clipSceneGraph(selectedGraph, 0, durationSec, { shiftTime: false });
    }
    const scenePath = normalized.scenePath || deriveSceneGraphPath(normalized.cleanPath);
    if (options.persistSceneGraph !== false) {
      await writeSceneGraph(scenePath, selectedGraph);
      normalized.scenePath = scenePath;
      normalized.sceneStatus = 'ready';
      normalized.sceneEventCount = events.length;
    }

    let remuxPath = '';
    if (options.remux !== false) {
      const selectedTrack = tracks.find((track) => track.preset === selectedStyle) || tracks[0];
      if (selectedTrack) {
        remuxPath = String(options.remuxPath || deriveSceneMkvPath(normalized.cleanPath, selectedTrack.preset));
        const temporaryRemuxPath = remuxPath + '.' + process.pid + '.tmp.mkv';
        await fsp.rm(temporaryRemuxPath, { force: true });
        await runFfmpegJob(
          this.ffmpegPath,
          createSceneAssRemuxArgs({
            cleanPath: normalized.cleanPath,
            assPath: selectedTrack.assPath,
            outputPath: temporaryRemuxPath,
            title: 'BiliRecord2K Scene ' + selectedTrack.preset
          })
        );
        await atomicReplaceFile(temporaryRemuxPath, remuxPath);
      }
    }
    return {
      scenePath,
      sceneCachePath: normalized.sceneCachePath || deriveSceneCachePath(normalized.cleanPath),
      eventCount: events.length,
      selectedStyle,
      canvas: selectedGraph.canvas,
      graph: selectedGraph,
      tracks,
      remuxPath
    };
  }

  async generateSubtitleAssets(recording, options = {}) {
    await this.ensurePlatformCjkFont();
    const overlayMode = normalizeBurnOverlayMode(options.overlayMode || this.settings.burnOverlayMode);
    const danmakuArea = normalizeDanmakuDisplayArea(options.danmakuArea || this.settings.burnDanmakuArea);
    const stylePreset = normalizeDanmakuStylePreset(options.stylePreset ?? this.settings.burnDanmakuStylePreset);
    const styleLayout = normalizeDanmakuStyleLayout(options.styleLayout ?? this.settings.burnDanmakuStyleLayout);
    const avatarMode = normalizeBurnAvatarMode(options.avatarMode ?? this.settings.burnAvatarMode);
    let videoInfo = options.videoInfo || recording.videoInfo;
    if (recording.cleanPath) {
      const mediaInfo = await probeMediaFileInfo(this.ffmpegPath, recording.cleanPath).catch(() => null);
      if (hasUsableVideoCanvas(mediaInfo?.videoInfo)) {
        videoInfo = mediaInfo.videoInfo;
        recording.videoInfo = mediaInfo.videoInfo;
      }
    }
    const cssPath = options.cssPath || recording.cssPath || deriveSiblingPath(recording.cleanPath, 'danmaku', 'css');
    await ensureDanmakuCss(cssPath);
    const assPath =
      options.assPath ||
      deriveSiblingPath(recording.cleanPath, createDanmakuAssSuffix(overlayMode, danmakuArea), 'ass');
    const temporaryAssPath = `${assPath}.${process.pid}.${Date.now()}.tmp`;
    const avatarPlanPath = `${temporaryAssPath}.avatar-plan.json`;
    // This compatibility entry point is also consumed by the established
    // ASS-plus-real-avatar export path. New Scene Graph callers use
    // generateSceneAssTracks (or opt in explicitly), so keep the legacy
    // avatar motion plan intact for existing exports.
    if (options.sceneGraph === true && SCENE_STYLE_PRESETS.includes(stylePreset)) {
      const sceneResult = await this.generateSceneAssTracks(recording, {
        overlayMode,
        danmakuArea,
        stylePreset,
        styleLayout,
        avatarMode,
        videoInfo,
        durationSec: Number(recording.durationSec || 0),
        startTime: options.startTime,
        endTime: options.endTime,
        shiftTime: options.shiftTime,
        assPath,
        presets: [stylePreset],
        remux: false,
        persistSceneGraph: !Number.isFinite(Number(options.startTime))
      });
      const track = sceneResult.tracks[0];
      recording.cssPath = cssPath;
      recording.assPath = track.assPath;
      return {
        cssPath,
        assPath: track.assPath,
        eventCount: sceneResult.eventCount,
        stylePreset,
        styleLayout,
        avatarMode,
        playWidth: Number(sceneResult.canvas?.width || videoInfo?.width || 0),
        playHeight: Number(sceneResult.canvas?.height || videoInfo?.height || 0),
        portrait: Number(sceneResult.canvas?.height || 0) > Number(sceneResult.canvas?.width || 0),
        avatarPlan: null,
        scenePath: sceneResult.scenePath,
        degradedEffects: track.degradedEffects
      };
    }
    const result = await runAssWorkerJob({
      danmakuPath: recording.danmakuPath,
      cssPath,
      assPath: temporaryAssPath,
      avatarPlanPath,
      overlayMode,
      danmakuArea,
      stylePreset,
      styleLayout,
      videoInfo: hasUsableVideoCanvas(videoInfo)
        ? { width: Math.round(Number(videoInfo.width)), height: Math.round(Number(videoInfo.height)) }
        : undefined,
      startTime: options.startTime,
      endTime: options.endTime,
      shiftTime: options.shiftTime,
      avatarOverlayMaxEntries: avatarOverlayEntryLimit(avatarMode),
      avatarOverlayMaxSegmentsPerEntry: MAX_AVATAR_OVERLAY_SEGMENTS_PER_ENTRY
    });
    const generatedAss = await fsp.readFile(temporaryAssPath, 'utf8').catch(() => '');
    if (!generatedAss.includes('[Script Info]') || !generatedAss.includes('[Events]')) {
      await fsp.rm(temporaryAssPath, { force: true }).catch(() => {});
      throw new Error('生成的 ASS 字幕未通过结构验证。');
    }
    await atomicReplaceFile(temporaryAssPath, assPath);
    recording.cssPath = cssPath;
    recording.assPath = assPath;
    return {
      cssPath,
      assPath,
      eventCount: result.eventCount,
      stylePreset,
      styleLayout,
      avatarMode,
      playWidth: Number(result.playWidth || 0),
      playHeight: Number(result.playHeight || 0),
      portrait: result.portrait === true,
      avatarPlan: result.avatarPlan || null
    };
  }

  async prepareSubtitleExport(options = {}) {
    let recording = this.normalizeRecording(options.recording || options);
    if (!recording) {
      throw new Error('请选择录像文件。');
    }
    recording = this.hydrateRecordingFromLibrary(recording);
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
    const stylePreset = normalizeDanmakuStylePreset(options.stylePreset ?? this.settings.burnDanmakuStylePreset);
    const styleLayout = normalizeDanmakuStyleLayout(options.styleLayout ?? this.settings.burnDanmakuStyleLayout);
    const avatarMode = normalizeBurnAvatarMode(options.avatarMode ?? this.settings.burnAvatarMode);
    const suffix = createClipDanmakuAssSuffix(startTime, endTime, overlayMode, danmakuArea);
    const assets = await this.generateSubtitleAssets(recording, {
      overlayMode,
      danmakuArea,
      stylePreset,
      styleLayout,
      avatarMode,
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

  async prepareSceneTracks(options = {}) {
    let recording = this.normalizeRecording(options.recording || options);
    if (!recording) throw new Error('请选择录像文件。');
    recording = this.hydrateRecordingFromLibrary(recording);
    if (recording.valid === false) throw new Error('这个录像文件未通过完整性检查。');
    this.assertExportSourcePath(recording.cleanPath);
    if (!(await isExistingFile(recording.cleanPath))) throw new Error('源视频不存在：' + recording.cleanPath);
    const mediaInfo = await probeMediaFileInfo(this.ffmpegPath, recording.cleanPath);
    const durationSec = await this.resolveRecordingDuration(recording, mediaInfo);
    if (durationSec > 0) recording.durationSec = durationSec;
    if (mediaInfo.videoInfo) recording.videoInfo = mediaInfo.videoInfo;
    const stylePreset = this.resolveSceneGraphStylePreset(options.stylePreset || this.settings.sceneGraphDefaultStyle);
    const result = await this.generateSceneAssTracks(recording, {
      stylePreset,
      presets: SCENE_STYLE_PRESETS,
      overlayMode: normalizeBurnOverlayMode(options.overlayMode || this.settings.burnOverlayMode),
      danmakuArea: normalizeDanmakuDisplayArea(options.danmakuArea || this.settings.burnDanmakuArea),
      styleLayout: normalizeDanmakuStyleLayout(options.styleLayout || this.settings.burnDanmakuStyleLayout),
      videoInfo: recording.videoInfo,
      durationSec,
      remux: true,
      remuxPath: options.remuxPath
    });
    recording.scenePath = result.scenePath;
    recording.sceneStatus = 'ready';
    recording.sceneEventCount = result.eventCount;
    this.rememberRecording(
      { id: recording.roomId, title: recording.roomTitle, anchor: recording.anchor },
      recording
    );
    await this.writeRecordingMetadata(recording).catch(() => {});
    await this.saveStore();
    this.log('success', 'Scene Graph 已生成四套 ASS 轨，并已快速封装 MKV：' + path.basename(result.remuxPath || result.scenePath));
    return {
      ok: true,
      cleanPath: recording.cleanPath,
      scenePath: result.scenePath,
      sceneCachePath: result.sceneCachePath,
      selectedStyle: result.selectedStyle,
      tracks: result.tracks,
      remuxPath: result.remuxPath,
      eventCount: result.eventCount
    };
  }

  async createExportQueueItem(options = {}) {
    let recording = this.normalizeRecording(options.recording || options);
    if (!recording) {
      throw new Error('请选择录像文件。');
    }
    recording = this.hydrateRecordingFromLibrary(recording);
    recording = await this.hydrateRecordingTimingFromSidecar(recording);
    if (recording.valid === false) {
      throw new Error(`这个录像文件未通过完整性检查：${recording.validReason || '没有检测到可用视频流'}`);
    }
    this.assertExportSourcePath(recording.cleanPath);
    if (!(await isExistingFile(recording.cleanPath))) {
      throw new Error(`源视频不存在：${recording.cleanPath}`);
    }
    const mode = normalizeExportMode(options.mode);
    const requestedCodec = mode === 'burn' ? normalizeBurnCodec(options.codec || this.settings.burnCodec) : '';
    const overlayMode = normalizeBurnOverlayMode(options.overlayMode || this.settings.burnOverlayMode);
    const danmakuArea = normalizeDanmakuDisplayArea(options.danmakuArea || this.settings.burnDanmakuArea);
    const stylePreset = normalizeDanmakuStylePreset(options.stylePreset ?? this.settings.burnDanmakuStylePreset);
    const styleLayout = normalizeDanmakuStyleLayout(options.styleLayout ?? this.settings.burnDanmakuStyleLayout);
    const avatarMode = normalizeBurnAvatarMode(options.avatarMode ?? this.settings.burnAvatarMode);
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
        // Keep the canonical packet audit with queued work.  The UI normally
        // only posts file paths, but this data is needed much later when the
        // task is finally dequeued and rendered.
        recording,
        mode,
        cleanPath: recording.cleanPath,
        danmakuPath: options.danmakuPath || recording.danmakuPath,
        cssPath: options.cssPath || recording.cssPath,
        assPath: options.assPath || recording.assPath,
        startTime: startTimeText,
        endTime: endTimeText,
        overlayMode,
        danmakuArea,
        stylePreset,
        styleLayout,
        avatarMode,
        codec: requestedCodec,
        crf: clamp(Number(options.crf ?? this.settings.burnCrf), 16, 35),
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
    const item = this.exportQueue[0];
    if (!item) {
      this.emitState();
      return;
    }
    this.exportQueueRunning = true;
    this.activeExportQueueItem = item;
    const queuedStartTime = parseTimeInput(item.startTime);
    const queuedEndTime = parseTimeInput(item.endTime);
    const capabilityProgress = createFfmpegJobProgress({
      kind: 'export',
      label: item.label,
      outputPath: item.outputPath,
      durationSec: Number.isFinite(queuedStartTime) && Number.isFinite(queuedEndTime)
        ? Math.max(0, queuedEndTime - queuedStartTime)
        : 0
    });
    capabilityProgress.stageLabel = '正在完成启动硬件探测';
    capabilityProgress.message = '正在完成启动硬件探测，导出将在探测完成后自动开始';
    this.exportProgress = capabilityProgress;
    this.emitState();
    setImmediate(async () => {
      let lease = null;
      let exportStarted = false;
      const removeWaitingItem = () => {
        const index = this.exportQueue.findIndex((candidate) => candidate.id === item.id);
        if (index >= 0) {
          this.exportQueue.splice(index, 1);
          this.emitState();
        }
      };
      try {
        if (this.cancelledExportQueueIds.has(item.id)) {
          if (this.exportProgress?.id === capabilityProgress.id) {
            finishFfmpegJobProgress(this.exportProgress, 'cancelled', '已取消等待硬件探测的导出');
          }
          return;
        }
        await this.waitForRuntimeCapabilities();
        if (this.cancelledExportQueueIds.has(item.id)) {
          if (this.exportProgress?.id === capabilityProgress.id) {
            finishFfmpegJobProgress(this.exportProgress, 'cancelled', '已取消等待硬件探测的导出');
          }
          return;
        }
        const codec = this.chooseBurnCodec(item.request.codec || this.settings.burnCodec);
        if (item.mode === 'burn') this.requireAvailableBurnCodec(codec, '片段烧录');
        lease = await this.mediaJobs.acquire({
          id: item.id,
          type: 'export',
          ...(item.mode === 'clean'
            ? { resources: ['diskRead', 'diskWrite'], resourceCosts: { diskRead: 2, diskWrite: 2 } }
            : this.getTranscodeResourcePlan(codec, item.request.recording?.videoInfo, { gpuComposite: true })),
          cancel: () => this.cancelExportClip().catch(() => {})
        });
        if (this.cancelledExportQueueIds.has(item.id)) {
          lease.release();
          lease = null;
          return;
        }
        exportStarted = true;
        await this.runExportClipNow({ ...item.request, codec, onProgressCreated: removeWaitingItem });
      } catch (error) {
        this.log('error', `导出队列任务失败：${item.label}，${error.message || String(error)}`);
        if (this.exportProgress?.id === capabilityProgress.id) {
          finishFfmpegJobProgress(this.exportProgress, 'error', `导出启动失败：${error.message || String(error)}`);
        }
      } finally {
        removeWaitingItem();
        lease?.release();
        this.cancelledExportQueueIds.delete(item.id);
        if (this.activeExportQueueItem?.id === item.id) {
          this.activeExportQueueItem = null;
        }
        this.exportQueueRunning = false;
        if (!exportStarted && this.exportCancelRequested) {
          this.exportCancelRequested = false;
        }
        this.emitState();
        if (this.exportQueue.length > 0) {
          this.pumpExportQueue();
        }
      }
    });
  }

  async probeJetsonNativeSceneForSource({
    graph,
    cleanPath,
    codec,
    sourceCodec,
    crf,
    fps,
    width,
    height,
    startTime,
    duration,
    temporaryDir,
    decoder,
    label = 'Jetson CUDA Scene',
    onPreparing,
    onStage
  } = {}) {
    const probeDuration = Math.min(5, Math.max(0.001, Number(duration) || 0.001));
    const probeStart = Math.max(0, Number(startTime) || 0);
    const requestPath = path.join(temporaryDir, 'native-preflight.json');
    const outputPath = path.join(temporaryDir, 'native-preflight.mkv');
    let metrics = null;
    try {
      if (process.env.BR2K_FORCE_NATIVE_PREFLIGHT_FAIL === '1' && process.env.NODE_ENV === 'test') {
        return { ok: false, reason: 'BR2K_FORCE_NATIVE_PREFLIGHT_FAIL=1', metrics: null, durationSec: probeDuration };
      }
      const renderer = this.ffmpegCapabilities?.sceneGpuRenderer;
      if (!renderer?.available || renderer.backend !== 'cuda-gstreamer' || !renderer.helper) {
        return { ok: false, reason: 'GPU Scene helper 未通过 runtime probe。', metrics: null, durationSec: probeDuration };
      }
      if (!cleanPath || !isJetsonGstreamerCodec(codec)) {
        return { ok: false, reason: '缺少真实 clean 源或 Jetson 硬编参数。', metrics: null, durationSec: probeDuration };
      }
      const probeGraph = clipSceneGraph(graph, 0, probeDuration, { shiftTime: true });
      const request = createGpuSceneRenderRequest(probeGraph, {
        backend: 'cuda-gstreamer',
        inputPath: cleanPath,
        outputPath,
        codec,
        width,
        height,
        fps,
        duration: probeDuration,
        timelineOffsetSec: 0,
        decoder: String(decoder?.value || decoder || 'gstreamer-nvv4l2'),
        container: 'mkv'
      });
      request.input.startTime = probeStart;
      request.input.codec = String(sourceCodec || '').toLowerCase();
      await fsp.writeFile(requestPath, JSON.stringify(request), 'utf8');
      onStage?.('正在验证 Jetson CUDA Scene（5秒真实样本）');
      let stdoutRemainder = '';
      const consumeLine = (line) => {
        let parsed;
        try { parsed = JSON.parse(line); } catch { return; }
        if (parsed?.nativeNvmmPreparing && typeof parsed.nativeNvmmPreparing === 'object') {
          onPreparing?.(parsed.nativeNvmmPreparing);
        }
        if (parsed?.nativeNvmmProgress && typeof parsed.nativeNvmmProgress === 'object') {
          onStage?.('正在验证 Jetson CUDA Scene（5秒真实样本）');
        }
      };
      const result = await runCapturedProcess(renderer.helper, ['--native-scene-request', requestPath], {
        timeoutMs: Math.max(30_000, Math.ceil(probeDuration * 10_000)),
        maxOutputBytes: 256 * 1024,
        onStdout: (chunk) => {
          stdoutRemainder += chunk;
          const lines = stdoutRemainder.split(/\r?\n/);
          stdoutRemainder = lines.pop() || '';
          for (const line of lines) consumeLine(line);
        }
      });
      if (stdoutRemainder) consumeLine(stdoutRemainder);
      for (const line of String(result.stdout || '').trim().split(/\r?\n/).reverse()) {
        try {
          const parsed = JSON.parse(line);
          if (parsed?.nativeNvmmMetrics && typeof parsed.nativeNvmmMetrics === 'object') {
            metrics = parsed.nativeNvmmMetrics;
            break;
          }
        } catch {
          // Helper diagnostics are intentionally ignored until the structured
          // metrics line is available.
        }
      }
      if (result.status !== 0 || result.error || result.timedOut) {
        return {
          ok: false,
          reason: compactLogLine(result.stderr || result.stdout || result.error?.message || '真实源 CUDA Scene helper 失败。'),
          metrics,
          durationSec: probeDuration
        };
      }
      const bridge = metrics?.ptsBridge || {};
      const mismatches = [
        ['source→Scene', bridge.sourceToSceneMismatches],
        ['Scene→编码', bridge.sceneToEncodeMismatches],
        ['source→编码', bridge.sourceToEncodeMismatches]
      ].filter(([, value]) => Number(value || 0) > 0);
      if (!metrics || !Number.isFinite(Number(metrics.pipelineFps)) || Number(metrics.pipelineFps) <= 0) {
        return { ok: false, reason: '真实源预检没有返回有效 pipelineFps。', metrics, durationSec: probeDuration };
      }
      if (bridge.ok !== true || Number(bridge.pendingRemaining || 0) !== 0 || Number(bridge.unmatchedEncodeFrames || 0) !== 0 || mismatches.length) {
        return {
          ok: false,
          reason: `真实源 PTS bridge 未通过：${mismatches.map(([name, value]) => `${name} ${value} 个偏差`).join('；') || `bridge=${bridge.ok ? '通过' : '失败'}，pending=${bridge.pendingRemaining || 0}，unmatched=${bridge.unmatchedEncodeFrames || 0}`}`,
          metrics,
          durationSec: probeDuration
        };
      }
      const encodedSize = await getFileSize(outputPath);
      if (encodedSize < 1024) {
        return { ok: false, reason: `真实源预检 MKV 无效：文件仅 ${encodedSize} 字节。`, metrics, durationSec: probeDuration };
      }
      const encodedInfo = await probeMediaFileInfo(this.ffmpegPath, outputPath, { timeoutMs: 10_000 });
      if (!encodedInfo?.videoInfo) {
        return { ok: false, reason: '真实源预检 MKV 没有可读取的视频流。', metrics, durationSec: probeDuration };
      }
      return { ok: true, metrics, durationSec: probeDuration };
    } catch (error) {
      return {
        ok: false,
        reason: compactLogLine(error?.message || String(error) || '真实源 CUDA Scene 预检失败。'),
        metrics,
        durationSec: probeDuration
      };
    } finally {
      await Promise.all([requestPath, outputPath].map((file) => fsp.rm(file, { force: true }).catch(() => {})));
    }
  }

  async runChunkedJetsonSceneGraphExport({
    graph, cleanPath, outputPath, codec, crf, fps, width, height, sourceCodec,
    startTime, duration, outputContainer, includeAudio, copyAudio, leadingVideoPaddingSec = 0,
    leadingAudioPaddingSec = 0, decoder, temporaryDir, legacyEvents = [], legacySceneOptions = {},
    onStderr, onChild, onProgress, onPreparing, onPhase, onStage, onNativePreflight, isCancelled, label
  }) {
    const chunkPaths = [];
    const chunkDurations = [];
    const scriptPaths = [];
    const concatPath = path.join(temporaryDir, 'scene-chunks.ffconcat');
    const cudaSceneAdmission = canUseCudaSceneProduction(
      this.ffmpegCapabilities?.sceneGpuRenderer,
      this.ffmpegCapabilities?.sceneGpuVisualConformance
    );
    const gpuSceneRenderer = this.ffmpegCapabilities?.sceneGpuRenderer;
    this.logCudaSceneAdmission(cudaSceneAdmission, gpuSceneRenderer);
    const nativeCandidate = cudaSceneAdmission.ok && decoder?.value === 'gstreamer-nvv4l2' &&
      Boolean(gpuSceneRenderer?.nativeNvmmScene);
    let nativePreflight = null;
    if (nativeCandidate) {
      onPhase?.('prepare', { force: true });
      nativePreflight = await this.probeJetsonNativeSceneForSource({
        graph,
        cleanPath,
        codec,
        sourceCodec,
        crf,
        fps,
        width,
        height,
        startTime,
        duration,
        temporaryDir,
        decoder,
        label,
        onPreparing,
        onStage
      });
      onNativePreflight?.(nativePreflight);
      if (nativePreflight.ok) {
        this.log('info', `${label}真实源预检通过：${nativePreflight.durationSec.toFixed(2)}s，${Number(nativePreflight.metrics?.pipelineFps || 0).toFixed(1)}fps，PTS bridge通过；正式导出使用连续NVMM链路。`);
      } else {
        this.log('warn', `${label}真实源预检失败：${nativePreflight.reason}；本次导出从开始即使用兼容链。`);
      }
      onPhase?.('render', { force: true });
    }
    const nativeTimestampedAdmission = nativePreflight?.ok === true;
    const useCudaSceneRenderer = cudaSceneAdmission.ok && (!nativeCandidate || nativeTimestampedAdmission);
    const nativeDecoderPath = nativeTimestampedAdmission && gpuSceneRenderer?.available && gpuSceneRenderer.helper
      ? gpuSceneRenderer.helper
      : '';
    // A concat pass has one timestamp contract.  Native NVMM and I420
    // compatibility chunks are both Matroska streams now; each keeps the
    // renderer's frame clock instead of reconstructing it from a rounded fps.
    // Never alternate a timestamped pass with an elementary fallback within
    // one output, or later chunks will steadily pull audio ahead of video.
    // Native NVMM keeps one media clock for the entire export. The historical
    // 20s loop remains only for the CPU/I420 compatibility path; splitting a
    // timestamped NVDEC stream would make every concat boundary a new clock.
    const chunkSeconds = nativeTimestampedAdmission ? Math.max(0.001, Number(duration) || 0.001) : 20;
    let nativeTimestampedPass = nativeTimestampedAdmission;
    let completed = 0;
    try {
      while (completed < duration - 0.001) {
        if (isCancelled?.()) {
          const error = new Error('Scene Graph 导出已取消。');
          error.code = 'BR2K_MEDIA_CANCELLED';
          throw error;
        }
        const index = chunkPaths.length;
        const chunkStart = startTime + completed;
        const graphChunkStart = Math.max(0, Number(graph?.timeline?.start) || 0) + completed;
        const chunkDuration = Math.min(chunkSeconds, duration - completed);
        const chunkLeadingVideoPaddingSec = index === 0 ? Math.min(leadingVideoPaddingSec, chunkDuration) : 0;
        const chunkGraph = clipSceneGraph(graph, graphChunkStart, graphChunkStart + chunkDuration, { shiftTime: true });
        const scriptPath = path.join(temporaryDir, `scene-chunk-${String(index).padStart(4, '0')}.filter`);
        const chunkPath = path.join(temporaryDir, `scene-chunk-${String(index).padStart(4, '0')}.mkv`);
        // Native PTS chunks are admitted only when the CUDA/NVMM runtime
        // probe passed. A later per-chunk bridge or coverage failure aborts
        // this pass rather than mixing an elementary fallback chunk into the
        // timestamped concat timeline.
        let nativeTimestampedChunk = nativeTimestampedPass;
        // Every Jetson chunk now has a PTS-bearing container.  The native
        // NVMM path writes Matroska directly; the I420 compatibility path
        // uses the same matroskamux contract so concat never reconstructs a
        // clock from a rounded fps or a bare elementary stream.
        const encodedVideoPath = `${chunkPath}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.mkv`;
        const legacyAssPath = await this.writeLegacySceneCompatibilityAss(
          path.join(temporaryDir, `scene-chunk-${String(index).padStart(4, '0')}.legacy.ass`),
          legacyEvents,
          {
            ...legacySceneOptions,
            startTime: chunkStart,
            endTime: chunkStart + chunkDuration,
            shiftTime: true
          }
        );
        onStage?.(nativeTimestampedAdmission
          ? `正在连续合成 CUDA Scene Graph（${chunkGraph.objects.length} 个对象）`
          : `正在直接合成 Scene Graph 分段 ${index + 1}（${chunkGraph.objects.length} 个对象）`);
        const sceneLayer = await writeSceneFilterScript(scriptPath, chunkGraph, {
          duration: chunkDuration,
          outputDuration: chunkDuration,
          leadingVideoPaddingSec: chunkLeadingVideoPaddingSec,
          fps,
          target: 'jetson',
          legacyAssPath
        });
        scriptPaths.push(scriptPath);
        if (legacyAssPath) scriptPaths.push(legacyAssPath);
        await fsp.rm(chunkPath, { force: true }).catch(() => {});
        let nativeRenderingReported = false;
        let nativeMetrics = null;
        let formalNativeMediaSeconds = 0;
        const common = {
          codec,
          quality: crf,
          width,
          height,
          fps,
          encodedVideoPath,
          createMuxArgs: (options = {}) => createBurnEncodedVideoMuxArgs({
            encodedVideoPath, cleanPath, outputPath: chunkPath, codec, sourceCodec, fps, startTime: chunkStart,
            duration: chunkDuration, container: 'mkv', includeAudio: false,
            preserveVideoTimestamps: Boolean(options.preserveVideoTimestamps)
          }),
          decoder,
          nativeDecode: decoder?.value === 'gstreamer-nvv4l2' && nativeDecoderPath
            ? {
                cleanPath,
                sourceCodec,
                filterScriptPath: sceneLayer.filterScriptPath,
                startTime: chunkStart,
                duration: chunkDuration,
                decoderPath: nativeDecoderPath
              }
            : null,
          onStderr: (line) => {
            onStderr?.(line);
            const local = parseFfmpegProgressTime(line);
            if (Number.isFinite(local)) onProgress?.(Math.min(duration, completed + Math.max(0, local)));
          },
          // The native NVMM helper has no FFmpeg stderr progress stream. Its
          // PTS-derived callback is therefore the only authoritative live
          // position for a running chunk; without forwarding it here the UI
          // remains at the previous chunk boundary until concat begins.
          onProgress: (localSeconds) => {
            if (nativeTimestampedChunk) {
              formalNativeMediaSeconds = Math.max(formalNativeMediaSeconds, Number(localSeconds) || 0);
            }
            if (!nativeRenderingReported && Number(localSeconds) > 0.001) {
              nativeRenderingReported = true;
              onStage?.(nativeTimestampedAdmission
                ? `正在连续合成 CUDA Scene Graph（${chunkGraph.objects.length} 个对象）`
                : `正在直接合成 CUDA Scene Graph 分段 ${index + 1}（${chunkGraph.objects.length} 个对象）`);
            }
            onProgress?.(Math.min(duration, completed + Math.max(0, Number(localSeconds) || 0)));
          },
          onPreparing: (metrics) => {
            const prepared = Math.max(0, Number(metrics?.objectsPrepared) || 0);
            const total = Math.max(0, Number(metrics?.objectCount) || 0);
            const rows = Math.max(0, Number(metrics?.timelineRows) || 0);
            onStage?.(`正在预渲染 CUDA Scene 纹理：${prepared}/${total} 个对象${rows ? `（${rows} 个动画片段）` : ''}`);
            onPreparing?.(metrics);
          },
          onChild,
          onPipeline: (pipeline) => this.setProgressPipeline(this.exportProgress, pipeline),
          onPhase,
          onStageMetrics: (metrics) => {
            if (this.exportProgress?.status !== 'running') return;
            if (setFfmpegJobStageFps(this.exportProgress, metrics)) this.emitState('mediaJob');
            if (metrics?.final) {
              const rate = ['decode', 'scene', 'encode', 'total']
                .map((name) => `${name} ${Number(metrics[name] || 0).toFixed(2)}fps`).join(' / ');
              this.log('info', `${label} 分段 ${index + 1} 性能：${rate}`);
            }
          },
          beforeRetry: () => fsp.rm(chunkPath, { force: true }).catch(() => {}),
          label: `${label} 分段 ${index + 1}`
        };
        const createCpuRawArgs = (nextDecoder) => createBurnRawVideoArgs({
          cleanPath, assPath: '', fps, avatarOverlay: { filterScriptPath: sceneLayer.filterScriptPath },
          startTime: chunkStart, duration: chunkDuration, inputSeek: true, timelineOffset: 0,
          leadingVideoPaddingSec: 0, decoder: nextDecoder, sourceCodec, videoWidth: width, videoHeight: height
        });
        if (!useCudaSceneRenderer) {
            onPhase?.('render');
            await this.runJetsonGstreamerTranscode({ ...common, createRawArgs: createCpuRawArgs });
        } else {
          try {
            onPhase?.('render');
            const cudaResult = await this.runJetsonCudaSceneGraphTranscode({
              ...common,
              graph: chunkGraph,
              cleanPath,
              duration: chunkDuration,
              timelineOffsetSec: chunkLeadingVideoPaddingSec,
              nativeTimestampedOutput: nativeTimestampedChunk,
              createRawArgs: (nextDecoder) => createBurnRawVideoArgs({
                cleanPath, assPath: '', fps, startTime: chunkStart, duration: chunkDuration, inputSeek: true,
                timelineOffset: 0, leadingVideoPaddingSec: chunkLeadingVideoPaddingSec, decoder: nextDecoder,
                sourceCodec, videoWidth: width, videoHeight: height, directRaw: true
              })
            });
            if (nativeTimestampedChunk && !cudaResult?.nativeMetrics?.ptsBridge?.ok) {
              throw new Error('原生 NVMM PTS bridge 未通过逐帧覆盖校验。');
            }
            nativeMetrics = cudaResult?.nativeMetrics || null;
          } catch (error) {
            const decision = decideJetsonNativeFailure({
              committed: nativeTimestampedChunk,
              processedMediaSeconds: formalNativeMediaSeconds,
              cancelled: error?.code === 'BR2K_MEDIA_CANCELLED'
            });
            if (decision === 'cancel') throw error;
            if (decision === 'abort') {
              throw createCommittedJetsonNativeRuntimeError(formalNativeMediaSeconds, error);
            }
            onStderr?.(`CUDA Scene 分段 ${index + 1} 失败，回退兼容链：${compactLogLine(error.message)}`);
            // The fallback still uses the CPU/I420 renderer, but its GStreamer
            // output is also Matroska. It must not be judged by the native
            // NVMM PTS coverage gate below. This is only allowed during the
            // first five seconds of a preflight-committed native run.
            nativeTimestampedChunk = false;
            nativeTimestampedPass = false;
            onPhase?.('render', { force: true });
            await this.runJetsonGstreamerTranscode({ ...common, createRawArgs: createCpuRawArgs });
          }
        }
        if ((await getFileSize(chunkPath)) < 1024) throw new Error(`Scene Graph 分段 ${index + 1} 未产生有效视频。`);
        if (nativeTimestampedChunk) {
          const bridge = nativeMetrics?.ptsBridge || {};
          const sourceToSceneFrames = Number(bridge.sourceToSceneFrames);
          const sceneToEncodeFrames = Number(bridge.sceneToEncodeFrames);
          const sourceToEncodeFrames = Number(bridge.sourceToEncodeFrames);
          const sourceToSceneMismatches = Number(bridge.sourceToSceneMismatches || 0);
          const sceneToEncodeMismatches = Number(bridge.sceneToEncodeMismatches || 0);
          const sourceToEncodeMismatches = Number(bridge.sourceToEncodeMismatches || 0);
          if (!Number.isFinite(sourceToSceneFrames) || !Number.isFinite(sceneToEncodeFrames) || !Number.isFinite(sourceToEncodeFrames) ||
              sourceToSceneFrames <= 0 || sceneToEncodeFrames <= 0 || sourceToEncodeFrames <= 0 ||
              sourceToSceneMismatches > 0 || sceneToEncodeMismatches > 0 || sourceToEncodeMismatches > 0) {
            throw new Error(`原生 NVMM 分段 ${index + 1} PTS 映射不足：source→Scene ${Number.isFinite(sourceToSceneFrames) ? sourceToSceneFrames : '?'} 帧/${sourceToSceneMismatches} 个偏差，Scene→编码 ${Number.isFinite(sceneToEncodeFrames) ? sceneToEncodeFrames : '?'} 帧/${sceneToEncodeMismatches} 个偏差，source→编码 ${Number.isFinite(sourceToEncodeFrames) ? sourceToEncodeFrames : '?'} 帧/${sourceToEncodeMismatches} 个偏差。`);
          }
          // JetPack NVENC can omit packet duration metadata on the final
          // access units. Its FFprobe presentation duration is therefore a
          // useful diagnostic only; treating it as an admission gate falsely
          // rejects an already validated fixed-frame media interval.
          const chunkInfo = await probeMediaFileInfo(this.ffmpegPath, chunkPath, { timeoutMs: 30_000 });
          const timeline = await probeMediaTimelineInfo(this.ffmpegPath, chunkPath, chunkInfo, { timeoutMs: 30_000 });
          const coverage = Number(timeline.videoPresentationDurationSec || timeline.videoDurationSec || 0);
          this.log(
            'info',
            `${label} ${nativeTimestampedAdmission ? '连续链路' : `分段 ${index + 1}`} PTS 映射：source→Scene ${sourceToSceneFrames} 帧（最大 ${(Number(bridge.sourceToSceneMaxDeltaSec || 0) * 1000).toFixed(3)}ms），Scene→编码 ${sceneToEncodeFrames} 帧（最大 ${(Number(bridge.sceneToEncodeMaxDeltaSec || 0) * 1000).toFixed(3)}ms），source→编码 ${sourceToEncodeFrames} 帧（最大 ${(Number(bridge.sourceToEncodeMaxDeltaSec || 0) * 1000).toFixed(3)}ms）；封装诊断 ${coverage.toFixed(3)}s / ${chunkDuration.toFixed(3)}s。`
          );
        }
        chunkPaths.push(chunkPath);
        chunkDurations.push(chunkDuration);
        completed += chunkDuration;
        onProgress?.(completed);
      }
      await writeConcatFile(concatPath, chunkPaths, { durations: chunkDurations });
      onPhase?.('mux');
      onStage?.('正在无重编码拼接 Scene Graph 分段并封装源音频');
      await runFfmpegJob(this.ffmpegPath, createBurnAudioMuxArgs({
        concatPath, cleanPath, outputPath, codec, sourceCodec, startTime, duration, container: outputContainer,
        leadingAudioPaddingSec, includeAudio, copyAudio
      }), onStderr, { onChild });
    } finally {
      await Promise.all([...chunkPaths, ...scriptPaths, concatPath].map((file) => fsp.rm(file, { force: true }).catch(() => {})));
    }
  }

  // The CUDA Scene helper owns only NVMM composition and nvv4l2 encoding.
  // FFmpeg stays the decoder and final audio muxer, so this preserves the
  // established failure/PTS policy while removing the CPU scene.filter work
  // from the raw-I420 producer.
  async runJetsonCudaSceneGraphTranscode({
    graph,
    codec,
    quality,
    width,
    height,
    fps,
    duration,
    timelineOffsetSec = 0,
    nativeTimestampedOutput = false,
    cleanPath,
    encodedVideoPath,
    createRawArgs,
    createMuxArgs,
    decoder = 'software',
    nativeDecode = null,
    onStderr,
    onChild,
    onPipeline,
    onStageMetrics,
    onProgress,
    onPreparing,
    onPhase,
    beforeRetry,
    onFallback,
    label = 'Jetson CUDA Scene Graph 烧录'
  } = {}) {
    const renderer = this.ffmpegCapabilities?.sceneGpuRenderer;
    if (!renderer?.available || renderer.backend !== 'cuda-gstreamer' || !renderer.helper) {
      throw new Error('Jetson CUDA Scene renderer 未通过运行时自检。');
    }
    if (!isJetsonGstreamerCodec(codec) || typeof createRawArgs !== 'function' || typeof createMuxArgs !== 'function') {
      throw new Error('Jetson CUDA Scene Graph 编码缺少有效参数。');
    }
    const requestPath = `${encodedVideoPath}.scene-${process.pid}-${crypto.randomBytes(4).toString('hex')}.json`;
    const keepSceneRequestForDiagnostics = process.env.BR2K_KEEP_SCENE_REQUEST === '1';
    const request = createGpuSceneRenderRequest(graph, {
      backend: 'cuda-gstreamer',
      inputPath: cleanPath,
      outputPath: encodedVideoPath,
      codec,
      width,
      height,
      fps,
      duration,
      timelineOffsetSec,
      decoder: String(decoder?.value || decoder || 'software'),
      container: /\.mkv$/i.test(String(encodedVideoPath || '')) || (nativeTimestampedOutput && nativeDecode?.decoderPath)
        ? 'mkv'
        : ''
    });
    if (nativeDecode) {
      request.input.startTime = Math.max(0, Number(nativeDecode.startTime) || 0);
      request.input.codec = String(nativeDecode.sourceCodec || '').toLowerCase();
    }
    await fsp.writeFile(requestPath, JSON.stringify(request), 'utf8');
    this.log('info', `${label}：将在子进程实际启动后报告 CUDA Scene 运行链路。`);
    const preferredDecoder = String(decoder?.value || decoder || 'software');
    const committedNativeNvmmRun = Boolean(nativeDecode?.decoderPath);
    let completedNativeMetrics = null;
    const run = async (nextDecoder) => {
      onPhase?.('render');
      await fsp.rm(encodedVideoPath, { force: true }).catch(() => {});
      const useNativeDecode = nextDecoder === 'gstreamer-nvv4l2' && nativeDecode?.decoderPath;
      onPipeline?.({
        decoder: useNativeDecode
          ? { value: 'gstreamer-nvv4l2', label: 'Jetson nvv4l2decoder', kind: 'hardware' }
          : { value: 'software', label: 'BiliRecord2K ffmpeg-full CPU', kind: 'software' },
        sceneRenderer: useNativeDecode && renderer.nativeNvmmScene
          ? 'CUDA Scene（NVMM）'
          : 'Jetson CUDA Scene（I420 bridge）',
        encoder: `Jetson ${isHevcCodec(codec) ? 'nvv4l2h265enc' : 'nvv4l2h264enc'}`
      });
      if (useNativeDecode) {
        if (renderer.nativeNvmmScene) {
          let nativeStdoutRemainder = '';
          const consumeNativeReportLine = (line) => {
            let parsed;
            try {
              parsed = JSON.parse(line);
            } catch {
              return;
            }
            if (parsed?.nativeNvmmProgress && typeof parsed.nativeNvmmProgress === 'object') {
              const metrics = parsed.nativeNvmmProgress;
              onProgress?.(Math.max(0, Math.min(Number(nativeDecode?.duration || duration) || duration, Number(metrics.mediaSeconds) || 0)));
              onStageMetrics?.({
                decode: Number(metrics.decode), scene: Number(metrics.scene), encode: Number(metrics.encode), total: Number(metrics.total), pipelineFps: Number(metrics.pipelineFps),
                frames: Number(metrics.frames), mediaSeconds: Number(metrics.mediaSeconds), wallSeconds: Number(metrics.wallSeconds)
              });
            } else if (parsed?.nativeNvmmPreparing && typeof parsed.nativeNvmmPreparing === 'object') {
              onPreparing?.(parsed.nativeNvmmPreparing);
            }
          };
          const runNativeHelper = () => runCapturedProcess(renderer.helper, ['--native-scene-request', requestPath], {
            timeoutMs: Math.max(30_000, Math.ceil((nativeDecode.duration || duration) * 5_000)), maxOutputBytes: 64 * 1024,
            onStdout: (chunk) => {
              nativeStdoutRemainder += chunk;
              const lines = nativeStdoutRemainder.split(/\r?\n/);
              nativeStdoutRemainder = lines.pop() || '';
              for (const line of lines) consumeNativeReportLine(line);
            }
          });
          let nativeResult = await runNativeHelper();
          const nativeFailureText = String(nativeResult.stderr || nativeResult.stdout || nativeResult.error?.message || '');
          // JetPack occasionally refuses a fresh nvivafilter/NVENC context
          // after many short helper processes with an Argus connection error.
          // Retry the same timestamped chunk once; it is safe because no
          // concat state has been committed yet.  Do not downgrade this chunk
          // to a different timestamp contract after earlier native chunks.
          if ((nativeResult.status !== 0 || nativeResult.error || nativeResult.timedOut) &&
              /(?:\bArgus\b|NvBuf|resource busy|connecting to.*daemon)/i.test(nativeFailureText)) {
            this.log('warn', `${label} 的原生 NVMM 上下文启动异常，正在原链路重试一次。`);
            nativeStdoutRemainder = '';
            await fsp.rm(encodedVideoPath, { force: true }).catch(() => {});
            await new Promise((resolve) => setTimeout(resolve, 750));
            nativeResult = await runNativeHelper();
          }
          if (nativeStdoutRemainder) consumeNativeReportLine(nativeStdoutRemainder);
          if (nativeResult.status !== 0 || nativeResult.error || nativeResult.timedOut) {
            const nativeDiagnostic = compactLogLine(nativeResult.stderr || nativeResult.stdout || nativeResult.error?.message || '原生 NVMM CUDA Scene 失败。');
            onStderr?.(`原生 NVMM CUDA Scene helper 失败：${nativeDiagnostic}`);
            this.log('warn', `${label}：原生 NVMM CUDA Scene helper 失败：${nativeDiagnostic}`);
            throw new Error(nativeDiagnostic);
          }
          let metrics = null;
          for (const line of String(nativeResult.stdout || '').trim().split(/\r?\n/).reverse()) {
            try {
              const parsed = JSON.parse(line);
              if (parsed?.nativeNvmmMetrics && typeof parsed.nativeNvmmMetrics === 'object') {
                metrics = parsed.nativeNvmmMetrics;
                break;
              }
            } catch {
              // Ignore ordinary GStreamer diagnostics before the JSON report.
            }
          }
          if (!metrics) throw new Error('原生 NVMM CUDA Scene 未返回真实性能统计。');
          if (!metrics?.ptsBridge?.ok) throw new Error('原生 NVMM CUDA Scene PTS bridge 未通过逐帧覆盖校验。');
          if (Number(metrics?.ptsBridge?.leadingFrames) > 0) {
            this.log('info', `${label}：原生 NVMM 已生成 ${metrics.ptsBridge.leadingFrames} 帧黑帧前导。`);
          }
          completedNativeMetrics = metrics;
          onStageMetrics?.({
            decode: Number(metrics.decode), scene: Number(metrics.scene), encode: Number(metrics.encode), total: Number(metrics.total), pipelineFps: Number(metrics.pipelineFps),
            frames: Number(metrics.frames), mediaSeconds: Number(metrics.mediaSeconds), wallSeconds: Number(metrics.wallSeconds), final: true
          });
        } else await runJetsonNativeDecodeCudaSceneJob({
          decoderPath: nativeDecode.decoderPath,
          decoderArgs: createJetsonNativeDecodeArgs({
            cleanPath: nativeDecode.cleanPath, sourceCodec: nativeDecode.sourceCodec, width, height, fps,
            converter: this.getBurnCodecInfo(codec).converter, helperMode: true,
            startTime: nativeDecode.startTime, duration: nativeDecode.duration || duration
          }),
          helperPath: renderer.helper,
          helperArgs: ['--request', requestPath],
          onDecoderStderr: (text) => onStderr?.(`GStreamer 解码: ${text}`),
          onHelperStderr: (text) => onStderr?.(`CUDA Scene helper: ${text}`),
          onChild,
          frameSize: Math.max(1, Math.floor(Number(width) || 0) * Math.floor(Number(height) || 0) * 3 / 2),
          onStageMetrics
        });
      } else {
        await runFfmpegToGstreamerJob({
          ffmpegPath: this.ffmpegPath,
          ffmpegArgs: createRawArgs(nextDecoder),
          gstreamerPath: renderer.helper,
          gstreamerArgs: ['--request', requestPath],
          gstreamerOutputPath: encodedVideoPath,
          onFfmpegStderr: onStderr,
          onGstreamerStderr: (text) => onStderr?.(`CUDA Scene helper: ${text}`),
          onChild
        });
      }
      onPhase?.('mux');
      await runFfmpegJob(
        this.ffmpegPath,
        createMuxArgs({ preserveVideoTimestamps: Boolean(nativeTimestampedOutput && useNativeDecode && renderer.nativeNvmmScene) }),
        onStderr,
        { onChild }
      );
    };
    try {
      await run(preferredDecoder);
      return { decoder: preferredDecoder, nativeMetrics: completedNativeMetrics };
    } catch (error) {
      // A real-source-preflighted NVMM run must return to the caller here.
      // The caller owns the single five-second early-fallback window and the
      // post-commit stop policy; this helper must never start a full CPU rerun.
      if (committedNativeNvmmRun) throw error;
      if (preferredDecoder === 'software' || error?.code === 'BR2K_MEDIA_CANCELLED' || !isFfmpegHardwareDecodeError(error)) throw error;
      this.log('warn', `${label} 的 ${decoder?.label || preferredDecoder} 不可用，改用 CPU 解码并保留 CUDA Scene 合成：${compactLogLine(error.message)}`);
      await beforeRetry?.();
      onFallback?.();
      onPhase?.('render', { force: true });
      await run('software');
      return { decoder: 'software', nativeMetrics: null };
    } finally {
      if (keepSceneRequestForDiagnostics) {
        const preservedRequestPath = path.join('/tmp', `br2k-scene-request-${process.pid}-${crypto.randomBytes(4).toString('hex')}.json`);
        await fsp.copyFile(requestPath, preservedRequestPath).catch(() => {});
        this.log('warn', `${label}：保留原生 Scene 请求用于诊断：${preservedRequestPath}`);
      } else {
        await fsp.rm(requestPath, { force: true }).catch(() => {});
      }
      await fsp.rm(encodedVideoPath, { force: true }).catch(() => {});
    }
  }

  async runSceneGraphClipExport({
    recording,
    burnCodec,
    burnCrf,
    overlayMode,
    danmakuArea,
    stylePreset,
    styleLayout,
    startTime,
    endTime,
    duration,
    durationSec,
    outputPath,
    temporaryOutputPath,
    outputContainer,
    mediaInfo,
    actualTimeline,
    codecInfo,
    decoderInfo,
    progress,
    setExportStage,
    setExportPhase,
    throwIfExportCancelled
  }) {
    let sceneDirectory = '';
    const sceneFontFallbackWarnings = new Map();
    let flushSceneFontFallbackWarnings = () => {};
    const diagnosticContext = {
      decoder: decoderInfo,
      encoder: burnCodec,
      scene: { stylePreset, overlayMode, startTime, duration },
      pipeline: null,
      preflight: null,
      ptsBridge: null,
      fallback: null
    };
    let cancelled = false;
    try {
      const estimatedExportBytes = Math.ceil(
        Number(recording.fileSize || 0) * Math.min(1, duration / Math.max(1, durationSec || duration))
      );
      await assertDiskSpace(outputPath, {
        estimatedBytes: estimatedExportBytes * (isJetsonGstreamerCodec(burnCodec) ? 2 : 1)
      });
      await fsp.rm(temporaryOutputPath, { force: true }).catch(() => {});
      throwIfExportCancelled();
      sceneDirectory = await fsp.mkdtemp(path.join(os.tmpdir(), 'br2k-export-scene-'));
      setExportPhase?.('prepare', { stageLabel: '正在准备 Scene Graph' });
      setExportStage('正在从 Scene Graph 直接合成');
      const sceneResult = await this.buildSceneGraphForRecording(recording, {
        overlayMode,
        danmakuArea,
        stylePreset,
        styleLayout,
        videoInfo: recording.videoInfo || mediaInfo.videoInfo,
        durationSec
      });
      const graph = clipSceneGraph(sceneResult.graph, startTime, endTime, { shiftTime: true });
      const fps = recording.videoInfo?.fps || mediaInfo.videoInfo?.fps || 30;
      const burnTimeline = getBurnTimelineAlignment(recording, startTime, duration, actualTimeline);
      const legacyAssPath = await this.writeLegacySceneCompatibilityAss(
        path.join(sceneDirectory, 'scene.legacy.ass'),
        sceneResult.events,
        {
          overlayMode,
          danmakuArea,
          stylePreset,
          styleLayout,
          videoInfo: recording.videoInfo || mediaInfo.videoInfo,
          startTime,
          endTime,
          shiftTime: true
        }
      );
      const target = isJetsonGstreamerCodec(burnCodec)
        ? 'jetson'
        : String(burnCodec || '').includes('nvenc')
          ? 'cuda'
          : 'software';
      // A dense hour can otherwise expand to a 100MB+ filter script before
      // FFmpeg is able to emit its first I420 frame.  Keep each direct Scene
      // Graph composition bounded; every source frame is still composed and
      // hardware-encoded exactly once, then the encoded chunks are copied.
      const useChunkedJetsonScene = isJetsonGstreamerCodec(burnCodec) && graph.objects.length > 1200;
      const desktopCudaSceneProduction = canUseDesktopCudaSceneProduction(
        this.ffmpegCapabilities?.desktopCuda,
        this.ffmpegCapabilities?.desktopCuda?.visualConformance
      );
      const useDesktopCudaSceneRenderer = !useChunkedJetsonScene &&
        /^(?:h264|hevc)_nvenc$/i.test(String(burnCodec || '')) && desktopCudaSceneProduction.ok;
      const sceneLayer = useChunkedJetsonScene
        ? null
        : await writeSceneFilterScript(path.join(sceneDirectory, 'scene.filter'), graph, {
            duration,
            outputDuration: duration,
            leadingVideoPaddingSec: burnTimeline.videoPaddingSec,
            fps,
            target,
            legacyAssPath
          });
      // Do not put legacy ASS in this production graph. It remains the frozen
      // reference layer above, while the independently gated CUDA graph
      // rasterizes canonical Scene objects and uploads every layer once.
      const desktopCudaSceneLayer = useDesktopCudaSceneRenderer
        ? await writeSceneFilterScript(path.join(sceneDirectory, 'scene.desktop-cuda.filter'), graph, {
            duration,
            outputDuration: duration,
            leadingVideoPaddingSec: burnTimeline.videoPaddingSec,
            fps,
            target: 'cuda',
            cudaInput: decoderInfo.value === 'cuda',
            legacyAssPath
          })
        : null;
      const desktopCudaCpuFallbackSceneLayer = useDesktopCudaSceneRenderer && decoderInfo.value === 'cuda'
        ? await writeSceneFilterScript(path.join(sceneDirectory, 'scene.desktop-cuda-cpu-source.filter'), graph, {
            duration,
            outputDuration: duration,
            leadingVideoPaddingSec: burnTimeline.videoPaddingSec,
            fps,
            target: 'cuda',
            cudaInput: false,
            legacyAssPath
          })
        : desktopCudaSceneLayer;
      // CUDA Scene now receives an explicit black lead-in and shifts its
      // timeline by the same amount, so both ordinary and leading-keyframe
      // exports retain the established audio/video alignment.
      const cudaSceneAdmission = canUseCudaSceneProduction(
        this.ffmpegCapabilities?.sceneGpuRenderer,
        this.ffmpegCapabilities?.sceneGpuVisualConformance
      );
      const gpuSceneRenderer = this.ffmpegCapabilities?.sceneGpuRenderer;
      // Chunked Jetson exports perform the same admission check inside
      // runChunkedJetsonSceneGraphExport(), where the actual chunk pipeline
      // is selected. Keep one complete status line per export instead of
      // logging the identical result once in the wrapper and once in the
      // chunk runner.
      if (!useChunkedJetsonScene) {
        this.logCudaSceneAdmission(cudaSceneAdmission, gpuSceneRenderer);
      }
      const nativeCandidate = isJetsonGstreamerCodec(burnCodec) && !useChunkedJetsonScene &&
        cudaSceneAdmission.ok && decoderInfo.value === 'gstreamer-nvv4l2' &&
        Boolean(gpuSceneRenderer?.nativeNvmmScene);
      let nativePreflight = null;
      let useCudaSceneRenderer = !useChunkedJetsonScene && cudaSceneAdmission.ok;
      let nativeDecoderPath = '';
      let nonChunkedFormalNativeMediaSeconds = 0;
      const copySourceAudio = canCopyWholeSourceAudio(mediaInfo, startTime, duration, burnTimeline);
      progress.avatarCompositeBackend = 'Scene Graph 直接合成';
      progress.stageLabel = '正在一次合成 Scene Graph';
      progress.message = progress.stageLabel;
      progress.updatedAt = Date.now();
      this.emitState('mediaJob');
      const createArgs = (decoder) =>
        createBurnArgs({
          cleanPath: recording.cleanPath,
          assPath: '',
          burnedPath: temporaryOutputPath,
          codec: burnCodec,
          crf: burnCrf,
          container: outputContainer,
          startTime,
          duration,
          fps,
          avatarOverlay: { filterScriptPath: sceneLayer.filterScriptPath },
          inputSeek: true,
          timelineOffset: 0,
          leadingVideoPaddingSec: 0,
          leadingAudioPaddingSec: 0,
          copyAudio: copySourceAudio,
          decoder,
          sourceCodec: decoderInfo.codec
        });
      const createDesktopCudaArgs = (decoder) => {
        const usesCudaDecode = String(decoder?.value || decoder || '').toLowerCase() === 'cuda';
        const layer = usesCudaDecode ? desktopCudaSceneLayer : desktopCudaCpuFallbackSceneLayer;
        return createBurnArgs({
          cleanPath: recording.cleanPath,
          assPath: '',
          burnedPath: temporaryOutputPath,
          codec: burnCodec,
          crf: burnCrf,
          container: outputContainer,
          startTime,
          duration,
          fps,
          avatarOverlay: { filterScriptPath: layer.filterScriptPath },
          inputSeek: true,
          timelineOffset: 0,
          leadingVideoPaddingSec: 0,
          leadingAudioPaddingSec: 0,
          copyAudio: copySourceAudio,
          decoder,
          sourceCodec: decoderInfo.codec,
          sceneCuda: true
        });
      };
      let sceneFontFallbackLastSummaryAt = 0;
      flushSceneFontFallbackWarnings = (force = false) => {
        const entries = [...sceneFontFallbackWarnings.entries()].filter(([, count]) => count > 1);
        if (!entries.length) return;
        const now = Date.now();
        if (!force && now - sceneFontFallbackLastSummaryAt < 30_000) return;
        sceneFontFallbackLastSummaryAt = now;
        const summary = entries.map(([key, count]) => {
          const [glyph, font] = key.split('|');
          return `${glyph}${font ? `(${font})` : ''}字体fallback警告重复${count}次`;
        }).join('；');
        this.log('warn', `Scene Graph 导出：${summary}，已折叠。`);
      };
      const foldSceneFontFallbackWarning = (line) => {
        const normalized = String(line || '').replace(/\[[^\]]+@\s*0x[0-9a-f]+\]/ig, '');
        if (!/(?:glyph\s+0x[0-9a-f]+|fontselect:\s*failed to find any fallback with glyph)/i.test(normalized)) return false;
        const glyphMatch = normalized.match(/(?:glyph\s+|U\+)(0x[0-9a-f]+|[0-9a-f]+)/i);
        if (!glyphMatch) return false;
        const glyph = `U+${glyphMatch[1].replace(/^0x/i, '').toUpperCase()}`;
        const fontMatch = normalized.match(/for\s+font\s+['"]?([^'"\s,;]+)/i) || normalized.match(/fontselect:\s*\(([^)]+)\)/i);
        const font = fontMatch ? String(fontMatch[1]).trim() : '';
        const key = `${glyph}|${font}`;
        const count = (sceneFontFallbackWarnings.get(key) || 0) + 1;
        sceneFontFallbackWarnings.set(key, count);
        if (count === 1) this.log('warn', `Scene Graph 导出：缺少字体fallback：${glyph}${font ? `（${font}）` : ''}`);
        flushSceneFontFallbackWarnings(false);
        return true;
      };
      const onStderr = (line) => {
        if (this.exportProgress?.id === progress.id && updateFfmpegJobProgress(this.exportProgress, line)) {
          this.emitState('mediaJob');
        }
        if (foldSceneFontFallbackWarning(line)) return;
        if (/error|failed|invalid/i.test(line)) this.log('warn', 'Scene Graph 导出：' + compactLogLine(line));
      };
      const onChild = (child) => {
        this.exportProcess = child;
      };
      const onScenePhase = (phase, options = {}) => {
        if (this.exportProgress?.id !== progress.id || progress.status !== 'running') return;
        const labels = {
          prepare: '正在准备 Scene Graph',
          render: '正在渲染 Scene Graph',
          mux: '正在封装输出',
          verify: '正在验证输出'
        };
        setExportPhase?.(phase, { ...options, stageLabel: labels[phase] || progress.stageLabel });
      };
      const onScenePreparing = (metrics) => {
        if (this.exportProgress?.id !== progress.id || progress.status !== 'running') return;
        const prepared = Math.max(0, Number(metrics?.objectsPrepared) || 0);
        const total = Math.max(0, Number(metrics?.objectCount) || 0);
        const rows = Math.max(0, Number(metrics?.timelineRows) || 0);
        updateFfmpegJobPrepareProgress(progress, prepared, total);
        progress.stageLabel = `正在预渲染 CUDA Scene 纹理：${prepared}/${total} 个对象${rows ? `（${rows} 个动画片段）` : ''}`;
        progress.message = progress.stageLabel;
        progress.updatedAt = Date.now();
        this.emitState('mediaJob');
      };
      const onDecoderFallback = () => {
        this.setProgressDecoder(
          progress,
          { value: 'software', label: 'CPU', kind: 'software' },
          { reset: true, message: 'Scene Graph 硬件解码不兼容，正在使用 CPU 解码重新导出' }
        );
        this.setProgressFallback(progress, '硬件解码不兼容，已回退到 CPU 解码；Scene Graph 几何未改变。');
        this.emitState('mediaJob');
      };
      const recordNativePreflight = (result) => {
        nativePreflight = result || null;
        diagnosticContext.preflight = nativePreflight;
        progress.nativePreflight = nativePreflight
          ? {
              status: nativePreflight.ok ? 'passed' : 'failed',
              durationSec: nativePreflight.durationSec,
              pipelineFps: Number(nativePreflight.metrics?.pipelineFps || 0),
              ptsBridge: nativePreflight.metrics?.ptsBridge?.ok === true,
              reason: nativePreflight.reason || ''
            }
          : null;
        progress.updatedAt = Date.now();
        this.emitState('mediaJob');
      };
      if (nativeCandidate) {
        onScenePhase('prepare', { force: true });
        setExportStage('正在验证 Jetson CUDA Scene（5秒真实样本）');
        recordNativePreflight(await this.probeJetsonNativeSceneForSource({
          graph,
          cleanPath: recording.cleanPath,
          codec: burnCodec,
          sourceCodec: decoderInfo.codec,
          crf: burnCrf,
          fps,
          width: recording.videoInfo?.width || mediaInfo.videoInfo?.width,
          height: recording.videoInfo?.height || mediaInfo.videoInfo?.height,
          startTime,
          duration,
          temporaryDir: sceneDirectory,
          decoder: decoderInfo,
          label: 'Jetson CUDA Scene',
          onPreparing: onScenePreparing,
          onStage: setExportStage
        }));
        if (nativePreflight.ok) {
          this.log('info', `Jetson CUDA Scene真实源预检通过：${nativePreflight.durationSec.toFixed(2)}s，${Number(nativePreflight.metrics?.pipelineFps || 0).toFixed(1)}fps，PTS bridge通过；正式导出使用连续NVMM链路。`);
          nativeDecoderPath = gpuSceneRenderer.helper;
        } else {
          this.log('warn', `Jetson CUDA Scene真实源预检失败：${nativePreflight.reason}；本次导出从开始即使用兼容链。`);
          useCudaSceneRenderer = false;
        }
        onScenePhase('render', { force: true });
      }
      throwIfExportCancelled();
      if (isJetsonGstreamerCodec(burnCodec)) {
        if (useChunkedJetsonScene) {
          await this.runChunkedJetsonSceneGraphExport({
            graph, cleanPath: recording.cleanPath, outputPath: temporaryOutputPath, codec: burnCodec, crf: burnCrf,
            fps, width: recording.videoInfo?.width || mediaInfo.videoInfo?.width,
            height: recording.videoInfo?.height || mediaInfo.videoInfo?.height, sourceCodec: decoderInfo.codec,
            startTime, duration, outputContainer, includeAudio: Boolean(mediaInfo.audioInfo), copyAudio: copySourceAudio,
            leadingVideoPaddingSec: burnTimeline.videoPaddingSec, leadingAudioPaddingSec: burnTimeline.audioPaddingSec,
            decoder: decoderInfo, temporaryDir: sceneDirectory, onStderr, onChild,
            legacyEvents: sceneResult.events,
            legacySceneOptions: { overlayMode, danmakuArea, stylePreset, styleLayout, videoInfo: recording.videoInfo || mediaInfo.videoInfo },
            onProgress: (value) => {
              if (this.exportProgress?.id !== progress.id) return;
              if (Number(value) > 0.001) onScenePhase('render');
              // A late native helper report can arrive at a chunk boundary
              // after the completed-chunk marker. Never let it move the
              // displayed media clock backward or reset the whole-job ETA.
              const monotonicValue = Math.max(Number(this.exportProgress.currentTimeSec || 0), Number(value) || 0);
              if (updateFfmpegJobProgress(this.exportProgress, `out_time_us=${Math.round(monotonicValue * 1_000_000)}`)) this.emitState('mediaJob');
            },
            onPreparing: onScenePreparing,
            onPhase: onScenePhase,
            onStage: setExportStage,
            onNativePreflight: recordNativePreflight,
            isCancelled: () => this.exportCancelRequested,
            label: 'Jetson Scene Graph 烧录'
          });
        } else {
          // Jetson encoders always write a PTS-bearing video-only MKV here;
          // do not hand a bare H.26x elementary stream to the final mux.
          const encodedVideoPath = temporaryOutputPath + '.' + process.pid + '.' + crypto.randomBytes(6).toString('hex') + '.mkv';
          const common = {
            codec: burnCodec,
            quality: burnCrf,
            width: recording.videoInfo?.width || mediaInfo.videoInfo?.width,
            height: recording.videoInfo?.height || mediaInfo.videoInfo?.height,
            fps,
            encodedVideoPath,
            createMuxArgs: () =>
              createBurnEncodedVideoMuxArgs({
                encodedVideoPath,
                cleanPath: recording.cleanPath,
                outputPath: temporaryOutputPath,
                codec: burnCodec,
                sourceCodec: mediaInfo.videoInfo?.codec,
                fps,
                startTime,
                duration,
                container: outputContainer,
                includeAudio: Boolean(mediaInfo.audioInfo),
                copyAudio: copySourceAudio
              }),
            decoder: decoderInfo,
            nativeDecode: decoderInfo.value === 'gstreamer-nvv4l2' && nativeDecoderPath
              ? {
                  cleanPath: recording.cleanPath,
                  sourceCodec: decoderInfo.codec,
                  filterScriptPath: sceneLayer.filterScriptPath,
                  startTime,
                  duration,
                  decoderPath: nativeDecoderPath
                }
              : null,
            onStderr,
            onChild,
            onPipeline: (pipeline) => {
              diagnosticContext.pipeline = pipeline;
              this.setProgressPipeline(progress, pipeline);
            },
            onProgress: (value) => {
              const mediaSeconds = Math.max(0, Number(value) || 0);
              if (nativePreflight?.ok === true && nativeDecoderPath) {
                nonChunkedFormalNativeMediaSeconds = Math.max(
                  nonChunkedFormalNativeMediaSeconds,
                  mediaSeconds
                );
              }
              if (mediaSeconds > 0.001) onScenePhase('render');
              if (this.exportProgress?.id === progress.id && updateFfmpegJobProgress(this.exportProgress, `out_time_us=${Math.round(mediaSeconds * 1_000_000)}`)) {
                this.emitState('mediaJob');
              }
            },
            onPreparing: onScenePreparing,
            onPhase: onScenePhase,
            onStageMetrics: (metrics) => {
              diagnosticContext.ptsBridge = metrics?.ptsBridge || diagnosticContext.ptsBridge;
              if (this.exportProgress?.id === progress.id && setFfmpegJobStageFps(progress, metrics)) this.emitState('mediaJob');
            },
            beforeRetry: () => fsp.rm(temporaryOutputPath, { force: true }).catch(() => {}),
            onFallback: onDecoderFallback,
            label: 'Jetson Scene Graph 烧录'
          };
          const createCpuRawArgs = (decoder) =>
            createBurnRawVideoArgs({
              cleanPath: recording.cleanPath,
              assPath: '',
              fps,
              avatarOverlay: { filterScriptPath: sceneLayer.filterScriptPath },
              startTime,
              duration,
              inputSeek: true,
              timelineOffset: 0,
              leadingVideoPaddingSec: 0,
              decoder,
              sourceCodec: decoderInfo.codec,
              videoWidth: common.width,
              videoHeight: common.height
            });
          if (!useCudaSceneRenderer) {
            await this.runJetsonGstreamerTranscode({ ...common, createRawArgs: createCpuRawArgs });
          } else {
            try {
              progress.avatarCompositeBackend = 'CUDA Scene 纹理合成（nvivafilter）';
              setExportStage('正在 CUDA 合成 Scene Graph 纹理');
              await this.runJetsonCudaSceneGraphTranscode({
                ...common,
                graph,
                cleanPath: recording.cleanPath,
                duration,
                timelineOffsetSec: burnTimeline.videoPaddingSec,
                createRawArgs: (decoder) =>
                  createBurnRawVideoArgs({
                    cleanPath: recording.cleanPath,
                    assPath: '',
                    fps,
                    startTime,
                    duration,
                    inputSeek: true,
                    timelineOffset: 0,
                    leadingVideoPaddingSec: burnTimeline.videoPaddingSec,
                    decoder,
                    sourceCodec: decoderInfo.codec,
                    videoWidth: common.width,
                    videoHeight: common.height,
                    directRaw: true
                  })
              });
            } catch (error) {
              const committedNativeRun = nativePreflight?.ok === true && Boolean(nativeDecoderPath);
              const decision = decideJetsonNativeFailure({
                committed: committedNativeRun,
                processedMediaSeconds: nonChunkedFormalNativeMediaSeconds,
                cancelled: error?.code === 'BR2K_MEDIA_CANCELLED'
              });
              if (decision === 'cancel') throw error;
              if (decision === 'abort') {
                throw createCommittedJetsonNativeRuntimeError(nonChunkedFormalNativeMediaSeconds, error);
              }
              this.log(
                'warn',
                `CUDA Scene Graph 在正式处理 ${nonChunkedFormalNativeMediaSeconds.toFixed(1)}s 后失败，仍处于允许早期回退窗口，切换兼容 Scene filter：${compactLogLine(error.message)}`
              );
              progress.avatarCompositeBackend = 'Scene Graph 直接合成（CPU 回退）';
              setExportPhase?.('render', { force: true, stageLabel: '正在使用兼容 Scene filter 重新渲染' });
              await this.runJetsonGstreamerTranscode({ ...common, createRawArgs: createCpuRawArgs });
            }
          }
        }
      } else {
        if (useDesktopCudaSceneRenderer) {
          progress.avatarCompositeBackend = 'CUDA Scene（桌面 CUDA）';
          setExportStage('正在 CUDA 合成完整 Scene Graph');
          this.setProgressPipeline(progress, {
            decoder: decoderInfo,
            sceneRenderer: 'CUDA Scene（桌面 CUDA）',
            encoder: `NVIDIA ${isHevcCodec(burnCodec) ? 'hevc_nvenc' : 'h264_nvenc'}`
          });
          await this.runFfmpegWithHardwareDecodeFallback({
            decoder: decoderInfo,
            createArgs: createDesktopCudaArgs,
            onStderr,
            onChild,
            beforeRetry: () => fsp.rm(temporaryOutputPath, { force: true }).catch(() => {}),
            onFallback: onDecoderFallback,
            label: '桌面 CUDA Scene Graph 烧录'
          });
        } else {
          await this.runFfmpegWithHardwareDecodeFallback({
            decoder: decoderInfo,
            createArgs,
            onStderr,
            onChild,
            beforeRetry: () => fsp.rm(temporaryOutputPath, { force: true }).catch(() => {}),
            onFallback: onDecoderFallback,
            label: 'Scene Graph 烧录'
          });
        }
      }
      throwIfExportCancelled();
      setExportPhase?.('verify', { stageLabel: '正在验证输出' });
      setExportStage('正在验证并完成 Scene Graph 导出');
      const exportedMediaInfo = await probeMediaFileInfo(this.ffmpegPath, temporaryOutputPath, { timeoutMs: 15000 });
      if (!exportedMediaInfo.videoInfo || (await getFileSize(temporaryOutputPath)) < 32 * 1024) {
        throw new Error('Scene Graph 导出临时输出未通过视频流与文件大小验证。');
      }
      await atomicReplaceFile(temporaryOutputPath, outputPath);
      if (this.exportProgress?.id === progress.id) {
        finishFfmpegJobProgress(this.exportProgress, 'completed', 'Scene Graph 片段已导出');
        this.emitState('mediaJob');
      }
      this.log('success', 'Scene Graph 片段已导出：' + path.basename(outputPath));
      return {
        ok: true,
        mode: 'burn',
        outputPath,
        cleanPath: recording.cleanPath,
        scenePath: recording.scenePath || deriveSceneGraphPath(recording.cleanPath)
      };
    } catch (error) {
      cancelled = this.exportCancelRequested || error?.code === 'BR2K_MEDIA_CANCELLED';
      if (cancelled) {
        if (this.exportProgress?.id === progress.id) {
          finishFfmpegJobProgress(this.exportProgress, 'cancelled', '导出已取消');
          this.emitState('mediaJob');
        }
        this.log('info', '已取消 Scene Graph 导出片段：' + path.basename(outputPath));
      } else if (this.exportProgress?.id === progress.id) {
        finishFfmpegJobProgress(this.exportProgress, 'error', 'Scene Graph 导出失败：' + error.message);
        this.emitState('mediaJob');
        await this.persistExportDiagnosticFailure({
          ...diagnosticContext,
          pipeline: diagnosticContext.pipeline || progress.activePipeline,
          fallback: diagnosticContext.fallback || {
            decision: error.code === 'BR2K_NATIVE_RUNTIME_FAILED_AFTER_COMMIT'
              ? 'abort-after-commit'
              : 'native-failure'
          }
        }).catch((diagnosticError) => {
          this.log('warn', `保存导出失败诊断报告失败：${diagnosticError.message}`);
        });
      }
      if (!cancelled) throw error;
      return { ok: false, mode: 'burn', cleanPath: recording.cleanPath };
    } finally {
      flushSceneFontFallbackWarnings?.(true);
      await fsp.rm(temporaryOutputPath, { force: true }).catch(() => {});
      if (sceneDirectory) await fsp.rm(sceneDirectory, { recursive: true, force: true }).catch(() => {});
      if (this.exportProgress?.id === progress.id) {
        this.exportProcess = null;
        this.exportCancelRequested = false;
      }
      const progressId = progress.id;
      this.exportProgressClearTimer = setTimeout(() => {
        if (this.exportProgress?.id === progressId) {
          this.exportProgress = null;
          this.emitState('mediaJob');
        }
      }, 5000);
      this.exportProgressClearTimer.unref?.();
    }
  }

  async runExportClipNow(options = {}) {
    await this.waitForRuntimeCapabilities();
    let recording = this.normalizeRecording(options.recording || options);
    if (!recording) {
      throw new Error('请选择录像文件。');
    }
    recording = this.hydrateRecordingFromLibrary(recording);
    recording = await this.hydrateRecordingTimingFromSidecar(recording);
    if (recording.valid === false) {
      throw new Error(`这个录像文件未通过完整性检查：${recording.validReason || '没有检测到可用视频流'}`);
    }
    this.assertExportSourcePath(recording.cleanPath);
    if (!(await isExistingFile(recording.cleanPath))) {
      throw new Error(`源视频不存在：${recording.cleanPath}`);
    }
    const mode = normalizeExportMode(options.mode);
    const burnCodec = mode === 'burn' ? this.chooseBurnCodec(options.codec || this.settings.burnCodec) : '';
    if (mode === 'burn') this.requireAvailableBurnCodec(burnCodec, '片段烧录');
    const burnCrf = clamp(Number(options.crf ?? this.settings.burnCrf), 16, 35);
    const overlayMode = normalizeBurnOverlayMode(options.overlayMode || this.settings.burnOverlayMode);
    const danmakuArea = normalizeDanmakuDisplayArea(options.danmakuArea || this.settings.burnDanmakuArea);
    const requestedStylePreset = normalizeDanmakuStylePreset(options.stylePreset ?? this.settings.burnDanmakuStylePreset);
    const stylePreset = this.resolveSceneGraphStylePreset(requestedStylePreset);
    const styleLayout = normalizeDanmakuStyleLayout(options.styleLayout ?? this.settings.burnDanmakuStyleLayout);
    const avatarMode = normalizeBurnAvatarMode(options.avatarMode ?? this.settings.burnAvatarMode);
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
    // Re-read the packet boundary for this exact clip.  Recording sidecars
    // describe the original file and are not authoritative after a seek,
    // trim, merge, or replacement of the clean media.
    const actualTimeline = await probeMediaClipTimelineInfo(
      this.ffmpegPath,
      recording.cleanPath,
      startTime,
      duration,
      mediaInfo,
      { timeoutMs: 30_000, packetSampleDurationSec: Math.min(2, duration) }
    ).catch((error) => {
      this.log('warn', `导出片段实际 PTS 探测失败，按无起始 A/V 偏移继续：${compactLogLine(error.message)}`);
      return {
        clipStartSec: startTime,
        clipDurationSec: duration,
        actualClipProbe: true,
        firstVideoPts: null,
        firstAudioPts: null,
        avStartDeltaSec: null,
        avBoundaryToleranceSec: 0.08,
        hasConfirmedStartDelta: false
      };
    });
    this.log(
      'info',
      `导出片段实际 PTS：视频 ${Number.isFinite(actualTimeline.firstVideoPts) ? actualTimeline.firstVideoPts.toFixed(3) : '-'}s，音频 ${Number.isFinite(actualTimeline.firstAudioPts) ? actualTimeline.firstAudioPts.toFixed(3) : '-'}s，A/V 起点差 ${Number.isFinite(actualTimeline.avStartDeltaSec) ? actualTimeline.avStartDeltaSec.toFixed(3) : '-'}s。`
    );
    const outputDir = String(options.outputDir || path.dirname(recording.cleanPath));
    await this.ensureDirectoryReady(outputDir, { label: '剪辑输出目录' });
    const outputPath =
      options.outputPath ||
      deriveClipPath(recording.cleanPath, outputDir, mode === 'clean' ? 'clean' : overlayMode, startTime, endTime);
    const outputContainer = getContainerFromPath(outputPath);
    const temporaryOutputPath = replaceExtension(outputPath, `.tmp.${outputContainer}`);
    const codecInfo = mode === 'burn' ? this.getBurnCodecInfo(burnCodec) : null;
    const decoderInfo = mode === 'burn'
      ? this.getHardwareDecoder(recording.videoInfo || mediaInfo.videoInfo, burnCodec)
      : { value: 'software', label: 'CPU', kind: 'software' };
    const progress = createFfmpegJobProgress({
      kind: 'export',
      label: `导出${mode === 'clean' ? '纯净' : '烧录'}片段：${path.basename(outputPath)}`,
      outputPath,
      durationSec: duration,
      roomId: recording.roomId || undefined,
      codec: codecInfo?.value,
      codecKind: codecInfo?.kind,
        decoder: mode === 'burn' ? decoderInfo.value : undefined,
        decoderKind: mode === 'burn' ? decoderInfo.kind : undefined,
        decoderLabel: mode === 'burn' ? decoderInfo.label : undefined,
        sourceFps: recording.videoInfo?.fps || mediaInfo.videoInfo?.fps,
        encoderBackend: codecInfo ? this.getEncoderBackendLabel(codecInfo) : '直接封装',
        avatarCompositeBackend: mode === 'burn' ? '正在准备真实头像' : undefined
    });
    const setExportStage = (stage) => {
      if (this.exportProgress?.id !== progress.id || progress.status !== 'running') return;
      progress.stageLabel = stage;
      progress.message = stage;
      progress.updatedAt = Date.now();
      this.emitState('mediaJob');
    };
    const setExportPhase = (phase, options = {}) => {
      if (this.exportProgress?.id !== progress.id || progress.status !== 'running') return false;
      const now = Number(options.now) || Date.now();
      const stageLabel = options.stageLabel === undefined ? progress.stageLabel : options.stageLabel;
      const changed = setFfmpegJobPhase(progress, phase, {
        ...options,
        now,
        stageLabel
      });
      if (!changed) return false;
      progress.updatedAt = now;
      this.emitState('mediaJob');
      return true;
    };
    const throwIfExportCancelled = () => {
      if (!this.exportCancelRequested) return;
      const error = new Error('导出已取消。');
      error.code = 'BR2K_MEDIA_CANCELLED';
      throw error;
    };
    clearTimeout(this.exportProgressClearTimer);
    this.exportProgress = progress;
    this.exportProcess = null;
    this.exportCancelRequested = false;
    options.onProgressCreated?.(progress);
    if (mode === 'burn' && SCENE_STYLE_PRESETS.includes(stylePreset)) {
      return this.runSceneGraphClipExport({
        recording,
        burnCodec,
        burnCrf,
        overlayMode,
        danmakuArea,
        stylePreset,
        styleLayout,
        startTime,
        endTime,
        duration,
        durationSec,
        outputPath,
        temporaryOutputPath,
        outputContainer,
        mediaInfo,
        actualTimeline,
        codecInfo,
        decoderInfo,
        progress,
        setExportStage,
        setExportPhase,
        throwIfExportCancelled
      });
    }
    setExportPhase('prepare', { stageLabel: mode === 'burn' ? '正在准备字幕和真实头像' : '正在准备纯净片段' });
    setExportStage(mode === 'burn' ? '正在准备字幕和真实头像' : '正在准备纯净片段');

    let cssPath = recording.cssPath;
    let assPath = recording.assPath;
    let temporaryAssDir = '';
    let avatarLayer = null;
    let avatarDiagnostics = null;
    let args;
    let createBurnExportArgs = null;
    let burnTimeline = null;
    let copySourceAudio = false;
    let cancelled = false;
    try {
      const estimatedExportBytes = Math.ceil(
        Number(recording.fileSize || 0) * Math.min(1, duration / Math.max(1, durationSec || duration))
      );
      await assertDiskSpace(outputPath, {
        estimatedBytes: estimatedExportBytes * (isJetsonGstreamerCodec(burnCodec) ? 2 : 1)
      });
      await fsp.rm(temporaryOutputPath, { force: true }).catch(() => {});
      throwIfExportCancelled();
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
      setExportStage('正在生成字幕');
      const assets = await this.generateSubtitleAssets(recording, {
        overlayMode,
        danmakuArea,
        stylePreset,
        styleLayout,
        avatarMode,
        startTime,
        endTime,
        // A clip has one source media origin.  Shift ASS/avatar events by the
        // requested clip start so both the video filter and the audio muxer
        // begin at zero; do not retain an absolute recording-clock offset.
        shiftTime: true,
        cssPath: options.cssPath || recording.cssPath,
        assPath: temporaryAssPath
      });
      throwIfExportCancelled();
      cssPath = assets.cssPath;
      assPath = assets.assPath;
      const exportFps = recording.videoInfo?.fps || mediaInfo.videoInfo?.fps;
      const avatarComposite = this.selectAvatarCompositeBackend(assets.avatarPlan);
      const requestedAvatarComposite = avatarComposite || this.getAvatarCompositeCapability();
      const gpuAvatarComposite = Boolean(avatarComposite);
      const gpuAvatarOutputToCpu =
        requestedAvatarComposite?.value !== 'cuda' || !String(burnCodec || '').includes('nvenc');
      burnTimeline = getBurnTimelineAlignment(recording, startTime, duration, actualTimeline);
      copySourceAudio = canCopyWholeSourceAudio(mediaInfo, startTime, duration, burnTimeline);
      setExportStage('正在准备真实头像');
      avatarLayer = await this.prepareAvatarOverlayLayer(assets.avatarPlan, {
        recording,
        assPath,
        fps: exportFps,
        duration: startTime + duration,
        timelineOffset: 0,
        leadingVideoPaddingSec: burnTimeline.videoPaddingSec,
        outputDuration: duration,
        skipInitialKeyframeGuard: true,
        label: '烧录片段导出',
        gpuComposite: gpuAvatarComposite,
        gpuCompositeBackend: requestedAvatarComposite?.value || '',
        gpuCompositeMode: requestedAvatarComposite?.mode || '',
        gpuCompositeDevice: requestedAvatarComposite?.device || '',
        gpuOutputToCpu: gpuAvatarOutputToCpu,
        onDiagnostics: (diagnostics) => {
          avatarDiagnostics = diagnostics;
        },
        isCancelled: () => this.exportCancelRequested
      });
      progress.avatarCompositeBackend = this.getAvatarCompositeBackendLabel(avatarLayer, avatarMode);
      progress.avatarDiagnostics = avatarDiagnostics || avatarLayer?.diagnostics;
      progress.updatedAt = Date.now();
      throwIfExportCancelled();
      if (!avatarLayer?.chunked) {
        createBurnExportArgs = (decoder, nextAvatarLayer = avatarLayer) =>
          createBurnArgs({
            cleanPath: recording.cleanPath,
            assPath,
            burnedPath: temporaryOutputPath,
            codec: burnCodec,
            crf: burnCrf,
            container: outputContainer,
            startTime,
            duration,
            fps: exportFps,
            avatarOverlay: nextAvatarLayer,
            inputSeek: true,
            timelineOffset: 0,
            leadingVideoPaddingSec: burnTimeline.videoPaddingSec,
            leadingAudioPaddingSec: burnTimeline.audioPaddingSec,
            copyAudio: copySourceAudio,
            decoder,
            sourceCodec: decoderInfo.codec
          });
        args = createBurnExportArgs(decoderInfo.value);
      }
      if (burnTimeline.videoPaddingSec > 0.05 || burnTimeline.audioPaddingSec > 0.05) {
        this.log(
          'info',
          `烧录片段导出 将保留源录像起始时间轴：视频前置 ${burnTimeline.videoPaddingSec.toFixed(3)} 秒，音频前置 ${burnTimeline.audioPaddingSec.toFixed(3)} 秒。`
        );
      }
    }
    setExportPhase('render', { stageLabel: mode === 'burn' ? '正在烧录片段' : '正在导出纯净片段' });
    setExportStage(mode === 'burn' ? '正在烧录片段' : '正在导出纯净片段');
    this.log(
      'info',
      `开始导出${mode === 'clean' ? '纯净' : '烧录'}片段：${path.basename(outputPath)}${
        codecInfo ? `（选中的编码器 ${burnCodec}，实际后端 ${this.getEncoderBackendLabel(codecInfo)}）` : ''
      }${
        mode === 'burn'
          ? `，解码后端 ${decoderInfo.kind === 'hardware' ? decoderInfo.label : 'CPU'}，头像合成后端 ${this.getAvatarCompositeBackendLabel(
              avatarLayer,
              avatarMode
            )}`
          : ''
      }`
    );
      const handleExportStderr = (line) => {
        if (this.exportProgress?.id === progress.id && updateFfmpegJobProgress(this.exportProgress, line)) {
          this.emitState('mediaJob');
        }
        handleExportLog(line);
      };
      const handleExportLog = (line) => {
        if (/error|failed|invalid/i.test(line)) {
          this.log('warn', `剪辑导出：${compactLogLine(line)}`);
        }
      };
      const handleExportProgress = (currentTimeSec) => {
        const value = Math.max(0, Number(currentTimeSec) || 0);
        if (
          this.exportProgress?.id === progress.id &&
          updateFfmpegJobProgress(this.exportProgress, `out_time_us=${Math.round(value * 1_000_000)}`)
        ) {
          this.emitState('mediaJob');
        }
      };
      const onChild = (child) => {
        this.exportProcess = child;
      };
      if (avatarLayer?.chunked) {
        await this.runChunkedAvatarBurn({
          cleanPath: recording.cleanPath,
          assPath,
          burnedPath: temporaryOutputPath,
          codec: burnCodec,
          crf: burnCrf,
          startTime,
          duration,
          fps: recording.videoInfo?.fps || mediaInfo.videoInfo?.fps,
          avatarLayer,
          decoder: decoderInfo,
          sourceCodec: decoderInfo.codec,
          includeAudio: Boolean(mediaInfo.audioInfo),
          copyAudio: copySourceAudio,
          timelineAlignment: burnTimeline,
          onChild,
          onStderr: handleExportLog,
          onProgress: handleExportProgress,
          onStage: setExportStage,
          onDecoderFallback: () => {
            this.setProgressDecoder(progress, { value: 'software', label: 'CPU', kind: 'software' });
            this.setProgressFallback(progress, '硬件解码不兼容，已回退到 CPU 解码。');
            this.emitState('mediaJob');
          },
          onCudaAvatarFallback: () => {
            this.setProgressFallback(progress, 'GPU 头像合成不兼容，已回退到 CPU 头像合成。', {
              avatarCompositeBackend: 'CPU 头像合成'
            });
            this.emitState('mediaJob');
          },
          label: '烧录片段头像分段',
          isCancelled: () => this.exportCancelRequested
        });
      } else if (mode === 'burn') {
        const onDecoderFallback = () => {
          this.setProgressDecoder(
            progress,
            { value: 'software', label: 'CPU', kind: 'software' },
            { reset: true, message: '硬件解码不兼容，正在使用 CPU 解码重新导出' }
          );
          this.setProgressFallback(progress, '硬件解码不兼容，已回退到 CPU 解码。');
          this.emitState('mediaJob');
        };
        const onCudaAvatarCompositeFallback = () => {
          if (this.exportProgress?.id === progress.id) {
            this.setProgressFallback(progress, 'GPU 头像合成不兼容，已回退到 CPU 头像合成。', {
              reset: true,
              message: 'GPU 头像合成不兼容，正在使用 CPU 头像合成重新导出',
              avatarCompositeBackend: 'CPU 头像合成'
            });
          }
          this.emitState('mediaJob');
        };
        if (isJetsonGstreamerCodec(burnCodec)) {
          const encodedVideoPath = `${temporaryOutputPath}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.mkv`;
          await this.runJetsonGstreamerWithCudaAvatarCompositeFallback({
            avatarLayer,
            createTranscode: (nextAvatarLayer) =>
              this.runJetsonGstreamerTranscode({
                codec: burnCodec,
                quality: burnCrf,
                width: recording.videoInfo?.width || mediaInfo.videoInfo?.width,
                height: recording.videoInfo?.height || mediaInfo.videoInfo?.height,
                fps: recording.videoInfo?.fps || mediaInfo.videoInfo?.fps,
                encodedVideoPath,
                createRawArgs: (decoder) =>
                  createBurnRawVideoArgs({
                    cleanPath: recording.cleanPath,
                    assPath,
                    fps: recording.videoInfo?.fps || mediaInfo.videoInfo?.fps,
                    avatarOverlay: nextAvatarLayer,
                    startTime,
                    duration,
                    inputSeek: true,
                    timelineOffset: 0,
                    leadingVideoPaddingSec: burnTimeline.videoPaddingSec,
                    decoder,
                    sourceCodec: decoderInfo.codec,
                    videoWidth: recording.videoInfo?.width || mediaInfo.videoInfo?.width,
                    videoHeight: recording.videoInfo?.height || mediaInfo.videoInfo?.height
                  }),
                createMuxArgs: () =>
                  createBurnEncodedVideoMuxArgs({
                    encodedVideoPath,
                    cleanPath: recording.cleanPath,
                    outputPath: temporaryOutputPath,
                    codec: burnCodec,
                    sourceCodec: mediaInfo.videoInfo?.codec,
                    fps: recording.videoInfo?.fps || mediaInfo.videoInfo?.fps,
                    startTime,
                    duration,
                    container: outputContainer,
                    leadingAudioPaddingSec: burnTimeline.audioPaddingSec,
                    includeAudio: Boolean(mediaInfo.audioInfo),
                    copyAudio: copySourceAudio
                  }),
                decoder: decoderInfo,
                onStderr: handleExportStderr,
                onChild,
                beforeRetry: () => fsp.rm(temporaryOutputPath, { force: true }).catch(() => {}),
                onFallback: onDecoderFallback,
                label: 'Jetson 烧录片段导出'
              }),
            beforeRetry: () => fsp.rm(temporaryOutputPath, { force: true }).catch(() => {}),
            onCudaFallback: onCudaAvatarCompositeFallback,
            label: 'Jetson 烧录片段导出'
          });
        } else {
          await this.runFfmpegWithCudaAvatarCompositeFallback({
            avatarLayer,
            decoder: decoderInfo,
            createArgs: createBurnExportArgs,
            onStderr: handleExportStderr,
            onChild,
            beforeRetry: () => fsp.rm(temporaryOutputPath, { force: true }).catch(() => {}),
            onDecoderFallback,
            onCudaFallback: onCudaAvatarCompositeFallback,
            label: '烧录片段导出'
          });
        }
      } else {
        await runFfmpegJob(this.ffmpegPath, args, handleExportStderr, { onChild });
      }
      throwIfExportCancelled();
      setExportPhase('verify', { stageLabel: '正在验证输出' });
      setExportStage('正在验证并完成导出');
      const exportedMediaInfo = await probeMediaFileInfo(this.ffmpegPath, temporaryOutputPath, { timeoutMs: 15000 });
      if (!exportedMediaInfo.videoInfo || (await getFileSize(temporaryOutputPath)) < 32 * 1024) {
        throw new Error('导出临时输出未通过视频流与文件大小验证。');
      }
      await atomicReplaceFile(temporaryOutputPath, outputPath);
      if (this.exportProgress?.id === progress.id) {
        finishFfmpegJobProgress(this.exportProgress, 'completed', '片段已导出');
        this.emitState('mediaJob');
      }
      this.log('success', `片段已导出：${path.basename(outputPath)}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      cancelled = this.exportCancelRequested;
      if (cancelled) {
        if (this.exportProgress?.id === progress.id) {
          finishFfmpegJobProgress(this.exportProgress, 'cancelled', '导出已取消');
          this.emitState('mediaJob');
        }
        await fsp.rm(temporaryOutputPath, { force: true }).catch(() => {});
        this.log('info', `已取消导出片段：${path.basename(outputPath)}`);
      } else if (this.exportProgress?.id === progress.id) {
        finishFfmpegJobProgress(this.exportProgress, 'error', `导出失败：${message}`);
        this.emitState('mediaJob');
      }
      if (!cancelled) {
        throw error;
      }
    } finally {
      await fsp.rm(temporaryOutputPath, { force: true }).catch(() => {});
      await this.cleanupAvatarOverlayLayer(avatarLayer);
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
          this.emitState('mediaJob');
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
    this.exportCancelRequested = true;
    if (this.exportProgress?.status === 'running') {
      this.exportProgress.message = this.exportProcess ? '正在中断导出' : '正在取消准备中的导出';
      this.exportProgress.updatedAt = Date.now();
    }
    this.log('info', '正在取消当前导出任务。');
    this.emitState('mediaJob');
    if (!this.exportProcess) {
      return this.getState();
    }
    requestFfmpegStop(this.exportProcess, { graceful: false, timeoutMs: 1500 });
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
    this.statePublisher.markLogsCleared();
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
    return this.updateService.checkUpdate();
  }

  async queueUpdateAfterJobs() {
    return this.updateService.queueUpdateAfterJobs();
  }

  async downloadUpdateOnly() {
    return this.updateService.downloadUpdateOnly();
  }

  async applyUpdate() {
    return this.updateService.applyUpdate();
  }

  async applyUpdateInternal() {
    return this.updateService.applyUpdateInternal();
  }

  createManualUpdateMessage(manifest, packagePath) {
    return this.updateService.createManualUpdateMessage(manifest, packagePath);
  }

  async getUsableDownloadedPackage(manifest) {
    return this.updateService.getUsableDownloadedPackage(manifest);
  }

  async fetchUpdateManifest(onStatus) {
    return this.updateService.fetchUpdateManifest(onStatus);
  }

  async downloadUpdatePackage(manifest) {
    return this.updateService.downloadUpdatePackage(manifest);
  }

  async loadLastUpdateStatus() {
    return this.updateService.loadLastUpdateStatus();
  }

  getUpdateStatusPath() {
    return this.updateService.getUpdateStatusPath();
  }

  getUpdateLogPath() {
    return this.updateService.getUpdateLogPath();
  }

  getUpdateDir() {
    return this.updateService.getUpdateDir();
  }

  async cleanupUpdateDownloads(packagePath, attempt = 1) {
    return this.updateService.cleanupUpdateDownloads(packagePath, attempt);
  }

  scheduleQueuedUpdateCheck(delayMs = 1500) {
    return this.updateService.scheduleQueuedUpdateCheck(delayMs);
  }

  supportsManagedLinuxUpdate(manifest = this.updateState.manifest) {
    return this.updateService.supportsManagedLinuxUpdate(manifest);
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
      ? ['hevc_nvenc', 'hevc_nvv4l2', 'hevc_v4l2m2m', 'hevc_qsv', 'hevc_amf']
      : tenBit
        ? []
        : ['h264_nvenc', 'h264_nvv4l2', 'h264_v4l2m2m', 'h264_qsv', 'h264_amf'];
    const hardware = hardwareCandidates.find((codec) => available.has(codec)) || '';
    const software = hevc ? 'libx265' : 'libx264';
    const probedSoftware = available.has(software) ? software : '';
    const preferred = hardware || probedSoftware;
    if (!preferred) {
      throw businessError('BURN_CODEC_UNAVAILABLE', '合并需要重编码，但没有通过能力探测的可用编码器。', 409);
    }
    return { preferred, fallback: hardware && probedSoftware ? probedSoftware : '', software: probedSoftware, tenBit };
  }

  async requestManagedLinuxUpdate(manifest, packagePath) {
    return this.updateService.requestManagedLinuxUpdate(manifest, packagePath);
  }

  async requestManagedLinuxUpdateInternal(manifest, packagePath) {
    return this.updateService.requestManagedLinuxUpdateInternal(manifest, packagePath);
  }

  scheduleAutomaticUpdateCheck(delayMs = AUTO_UPDATE_INTERVAL_MS) {
    return this.updateService.scheduleAutomaticUpdateCheck(delayMs);
  }

  getJetsonSelfTestBuiltInAvatarPath() {
    const candidates = [
      path.join(APP_ROOT, 'assets', 'app-icon.png'),
      path.join(APP_ROOT, 'public', 'app-icon.png')
    ];
    return candidates.find((candidate) => {
      try {
        return fs.statSync(candidate).isFile();
      } catch {
        return false;
      }
    }) || '';
  }

  getJetsonSelfTestSamplePath(codec) {
    const family = isHevcCodec(codec) ? 'hevc' : 'h264';
    const fileName = family + '-sample.mp4';
    const candidates = [
      path.join(APP_ROOT, 'assets', 'jetson-self-test', fileName),
      path.join(APP_ROOT, 'public', 'jetson-self-test', fileName)
    ];
    return candidates.find((candidate) => {
      try {
        return fs.statSync(candidate).isFile() && fs.statSync(candidate).size >= 1024;
      } catch {
        return false;
      }
    }) || '';
  }

  async fetchJetsonSelfTestAvatar() {
    if (!this.jetsonAvatarSelfTestAssetPromise) {
      this.jetsonAvatarSelfTestAssetPromise = (async () => {
        const avatarUrl = await this.lookupBiliAvatarForOverlay(JETSON_SELF_TEST_AVATAR_UID).catch(() => '');
        if (!avatarUrl) {
          throw new Error(`未能获取 Bilibili UID ${JETSON_SELF_TEST_AVATAR_UID} 的实际头像地址。`);
        }
        return this.fetchAvatarImageAsset(avatarUrl);
      })();
    }
    try {
      return await this.jetsonAvatarSelfTestAssetPromise;
    } catch (error) {
      this.jetsonAvatarSelfTestAssetPromise = null;
      throw error;
    }
  }

  async runJetsonGstreamerEndToEndSelfTest(codecInfo) {
    return runJetsonBurnEndToEndSelfTest({
      codecInfo,
      ffmpegPath: this.ffmpegPath,
      converter: codecInfo?.converter,
      builtInAvatarPath: this.getJetsonSelfTestBuiltInAvatarPath(),
      samplePath: this.getJetsonSelfTestSamplePath(codecInfo?.value),
      remoteAvatarUrl: `bilibili:uid:${JETSON_SELF_TEST_AVATAR_UID}`,
      downloadAvatar: () => this.fetchJetsonSelfTestAvatar(),
      runProcess: runCapturedProcess
    });
  }

  async runJetsonGstreamerBridgeSelfTest(codecInfo) {
    return this.runJetsonGstreamerEndToEndSelfTest(codecInfo);
  }

  async runHardwareAccelerationSelfTest() {
    if (this.hardwareSelfTestPromise) {
      throw businessError('HARDWARE_SELF_TEST_RUNNING', '硬件加速自检正在运行，请稍候。', 409);
    }
    if (this.hasActiveJobs()) {
      throw businessError('HARDWARE_SELF_TEST_BUSY', '当前有录制或媒体任务，硬件加速自检不会抢占 GPU；请在任务结束后再试。', 409);
    }

    const run = async () => {
      await this.waitForRuntimeCapabilities();
      const codec = this.chooseBurnCodec(this.settings.burnCodec);
      this.requireAvailableBurnCodec(codec, '硬件自检');
      const codecInfo = this.getBurnCodecInfo(codec);
      const decoder = (this.ffmpegCapabilities.hardwareDecoders || [])[0];
      const avatarComposite = this.getAvatarCompositeCapability();
      const avatarCompositeLabel = avatarComposite?.label || 'GPU 头像合成';
      const startedAt = Date.now();
      this.hardwareSelfTest = {
        status: 'running',
        message: '正在执行约 5–10 秒的编码、合成链路自检…',
        startedAt,
        completedAt: 0,
        codec,
        encoderBackend: this.getEncoderBackendLabel(codecInfo),
        decoderBackend: decoder ? `${decoder.label}（能力已探测；真实解码取决于源视频）` : 'CPU（未探测到可用硬件解码）',
        avatarCompositeBackend: avatarComposite ? `正在测试 ${avatarCompositeLabel}` : 'CPU 头像合成（未检测到 GPU 合成）',
        fallbackReason: '',
        stages: {}
      };
      this.log(
        'info',
        `开始硬件加速自检：选中的编码器 ${codec}，实际后端 ${this.hardwareSelfTest.encoderBackend}，解码后端 ${this.hardwareSelfTest.decoderBackend}。`
      );
      this.markSystemDirty();

      if (codecInfo.kind !== 'hardware') {
        this.hardwareSelfTest = {
          ...this.hardwareSelfTest,
          status: 'unavailable',
          completedAt: Date.now(),
          avatarCompositeBackend: avatarComposite ? `${avatarCompositeLabel} 可用` : 'CPU 头像合成（GPU 合成不可用）',
          message: '当前没有选中可用的硬件编码器；请先在设置中选择已通过能力探测的硬编。',
          fallbackReason: '当前使用软件编码。'
        };
        this.log('warn', `硬件加速自检未执行编码：${this.hardwareSelfTest.message}`);
        this.markSystemDirty();
        return this.getState();
      }

      const encoderTest = codecInfo.backend === 'gstreamer'
        ? await this.runJetsonGstreamerBridgeSelfTest(codecInfo)
        : await testFfmpegEncoder(this.ffmpegPath, codec, {
            width: 320,
            height: 180,
            rate: 30,
            frames: 90,
            timeoutMs: 10000
          });
      const avatarTest = avatarComposite
        ? await testFfmpegAvatarCompositeBackend(this.ffmpegPath, avatarComposite, {
            renderDevice: avatarComposite.device
          })
        : {
            ok: false,
            reason:
              this.ffmpegCapabilities.avatarCompositeReason ||
              this.ffmpegCapabilities.cudaAvatarCompositeReason ||
              '未检测到可用的 GPU 透明图层合成链路'
          };
      const jetsonStages = encoderTest?.stages && typeof encoderTest.stages === 'object' ? encoderTest.stages : undefined;
      const fallbackReason = [
        encoderTest.ok ? '' : `编码自检失败：${encoderTest.reason || '未知原因'}`,
        avatarTest.ok ? '' : `GPU 头像合成不可用，运行时将使用 CPU：${avatarTest.reason || '未知原因'}`
      ].filter(Boolean).join('；');
      const encoderPassed = Boolean(encoderTest.ok);
      this.hardwareSelfTest = {
        ...this.hardwareSelfTest,
        status: encoderPassed ? (avatarTest.ok ? 'completed' : 'degraded') : 'failed',
        completedAt: Date.now(),
        avatarCompositeBackend: avatarTest.ok ? avatarCompositeLabel : 'CPU 头像合成（GPU 自检未通过）',
        ...(jetsonStages ? { stages: jetsonStages } : {}),
        fallbackReason,
        message: encoderPassed
          ? avatarTest.ok
            ? `硬件编码和 ${avatarCompositeLabel} 自检通过。`
            : '硬件编码自检通过；GPU 头像合成未通过，将自动使用 CPU 头像合成。'
          : '硬件编码自检未通过；不会将此结果伪装为可用硬编。'
      };
      this.log(
        encoderPassed ? (avatarTest.ok ? 'success' : 'warn') : 'error',
        `硬件加速自检结果：${this.hardwareSelfTest.message} 编码器 ${codec}；实际后端 ${this.hardwareSelfTest.encoderBackend}；头像合成 ${this.hardwareSelfTest.avatarCompositeBackend}${
          fallbackReason ? `；原因：${fallbackReason}` : ''
        }`
      );
      this.markSystemDirty();
      return this.getState();
    };

    this.hardwareSelfTestPromise = run();
    try {
      return await this.hardwareSelfTestPromise;
    } finally {
      this.hardwareSelfTestPromise = null;
    }
  }

  hasActiveJobs() {
    return (
      this.mediaJobs.hasActive() ||
      this.mergeRetryStates.size > 0 ||
      this.recordingSessions.size > 0 ||
      this.recordingStartLocks.size > 0 ||
      this.reconnectPendingRooms.size > 0 ||
      this.streamStartRetryRooms.size > 0 ||
      this.burnSessions.size > 0 ||
      this.burnQueueRunning ||
      this.burnQueue.length > 0 ||
      Boolean(this.exportProcess) ||
      Boolean(this.exportPreviewProcess) ||
      this.exportQueueRunning ||
      this.exportQueue.length > 0 ||
      Array.from(this.rooms.values()).some(
        (room) => room.recording || room.burning || room.mergeProgress?.status === 'running' || room.mergeProgress?.status === 'retrying'
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
      throw businessError('ROOM_NOT_FOUND', `找不到房间 ${roomId}。`, 404);
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
    this.roomMonitor.stopAll();
    this.clearMaintenanceCleanupPlans();
    for (const timer of this.streamStartRetryTimers.values()) {
      clearTimeout(timer);
    }
    this.streamStartRetryTimers.clear();
    this.streamStartRetryRooms.clear();
    for (const retryState of this.mergeRetryStates.values()) {
      clearTimeout(retryState.timer);
    }
    this.mergeRetryStates.clear();
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

// 统一的“本地文件 → HTTP 响应”文件流生命周期管理。
// 跨平台（Windows NTFS/SMB/UNC、Linux ext4/CIFS/NFS、macOS）共用同一条释放路径：
// 只要客户端断开（request.aborted / request.close / response.close），
// 立即 destroy ReadStream，并移除本方法注册的全部监听器；
// 正常播放完成（response.writableFinished/writableEnded）不会提前 destroy。
function pipeLocalFileToResponse(filePath, request, response, options = {}) {
  const start = Number(options.start);
  const end = Number(options.end);
  const hasRange = Number.isFinite(start) && Number.isFinite(end) && start >= 0 && end >= start;
  const stream = hasRange ? fs.createReadStream(filePath, { start, end }) : fs.createReadStream(filePath);
  let cleaned = false;

  const isResponseFinished = () =>
    Boolean(response && (response.writableFinished || response.writableEnded));

  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    if (request && typeof request.removeListener === 'function') {
      request.removeListener('aborted', onAborted);
      request.removeListener('close', onRequestClose);
    }
    if (response && typeof response.removeListener === 'function') {
      response.removeListener('close', onResponseClose);
    }
    stream.removeListener('error', onStreamError);
    stream.removeListener('close', onStreamClose);
  };

  const destroy = () => {
    if (cleaned) return;
    try {
      stream.unpipe(response);
    } catch {}
    if (!stream.destroyed) {
      stream.destroy();
    }
    cleanup();
  };

  const onAborted = () => destroy();
  const onRequestClose = () => {
    // request.close 在正常请求完成后也会触发；只有响应尚未写完才视为断开。
    if (!isResponseFinished()) destroy();
  };
  const onResponseClose = () => {
    if (!isResponseFinished()) destroy();
  };
  const onStreamError = () => {
    if (!isResponseFinished() && response && !response.destroyed) {
      response.destroy();
    }
    destroy();
  };
  const onStreamClose = () => cleanup();

  stream.on('error', onStreamError);
  stream.on('close', onStreamClose);
  if (request && typeof request.on === 'function') {
    request.on('aborted', onAborted);
    request.on('close', onRequestClose);
  }
  if (response && typeof response.on === 'function') {
    response.on('close', onResponseClose);
  }
  stream.pipe(response);
  return stream;
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

function hasUsableVideoCanvas(videoInfo) {
  const width = Math.round(Number(videoInfo?.width || 0));
  const height = Math.round(Number(videoInfo?.height || 0));
  return Number.isFinite(width) && Number.isFinite(height) && width >= 160 && height >= 160 && width <= 16384 && height <= 16384;
}

async function runAssWorkerJob(payload) {
  const avatarPlanPath = String(payload.avatarPlanPath || '').trim();
  const managedServerEntry = String(process.env.BILI_RECORD_SERVER_ENTRY || '').trim();
  try {
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
      if (response.avatarPlanStored) {
        if (!avatarPlanPath) {
          throw new Error('字幕任务返回了头像计划标记，但没有提供计划文件。');
        }
        response.avatarPlan = JSON.parse(await fsp.readFile(avatarPlanPath, 'utf8'));
      }
      return response;
    } catch (error) {
      throw new Error(`字幕任务返回无效：${error.message}`);
    }
  } finally {
    if (avatarPlanPath) {
      await fsp.rm(avatarPlanPath, { force: true }).catch(() => {});
    }
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
  BusinessError,
  isBusinessError,
  shouldAbortCommittedJetsonNativeFallback,
  createCommittedJetsonNativeRuntimeError,
  isFfmpegMemoryPressureError,
  getBurnTimelineAlignment,
  getMergeSegmentTimingAssessment,
  getMonitorPollDelayMs,
  createUiCapabilities,
  DEFAULT_HOST,
  DEV_MODE,
  OPEN_BROWSER,
  DIST_ROOT,
  writeJson,
  writeText,
  pipeLocalFileToResponse,
  mimeType,
  getRuntimePort,
  getRuntimeHost,
  openUrl
};
