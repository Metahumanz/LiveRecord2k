export type RoomState = {
  id: string;
  realRoomId?: number;
  shortId?: number;
  title?: string;
  anchor?: string;
  cover?: string;
  keyframe?: string;
  liveStatus?: number;
  monitoring: boolean;
  autoRecord: boolean;
  recording: boolean;
  burning: boolean;
  lastCheckedAt?: number;
  lastError?: string;
  qualityWarning?: string;
  stream?: StreamChoice;
  currentRecording?: RecordingState;
  burnProgress?: FfmpegJobProgress;
  mergeProgress?: FfmpegJobProgress;
};

export type StreamChoice = {
  url: string;
  codec: string;
  qn: number;
  requestedQn?: number;
  acceptQn?: number[];
  protocol: string;
  format: string;
  host: string;
};

export type RecordingState = {
  id?: string;
  roomId?: string;
  roomTitle?: string;
  anchor?: string;
  startedAt: number;
  cleanPath: string;
  capturePath?: string;
  danmakuPath: string;
  cssPath?: string;
  assPath?: string;
  burnedPath?: string;
  containerStage?: 'capturing' | 'finalizing' | 'ready' | 'failed';
  validReason?: string;
  mergeGroup?: string;
  mergeSequence?: number;
  mergeOutputPath?: string;
  mergedFrom?: string[];
  durationSec?: number;
  fileSize?: number;
  valid?: boolean;
  eventCount: number;
  rawDanmakuCount?: number;
  capturedDanmakuCount?: number;
  ignoredDanmakuCount?: number;
  danmakuCommandCounts?: Record<string, number>;
  danmakuStatus?: 'connecting' | 'connected' | 'disconnected' | 'error';
  danmakuMessage?: string;
  danmakuPopularity?: number;
  videoInfo?: {
    codec?: string;
    width: number;
    height: number;
    fps?: number;
  } | null;
  timingInfo?: {
    containerDurationSec?: number;
    videoDurationSec: number;
    audioDurationSec: number;
    avDeltaSec: number;
    measuredAvDeltaSec?: number;
    videoReorderAllowanceSec?: number;
    containerDeltaSec?: number;
    timingSafeForCopy?: boolean;
    error?: string;
    sourceSegments?: Array<{
      index: number;
      videoDurationSec: number;
      audioDurationSec: number;
      avDeltaSec: number;
      timingSafeForCopy?: boolean;
      error?: string;
    }>;
  } | null;
};

export type DanmakuArea = 'quarter' | 'half' | 'three-quarter' | 'no-overlap' | 'unlimited';

export type DanmakuStylePreset = 'current' | 'h5-card' | 'bubble' | 'minimal';

export type DanmakuStyleLayout = {
  panelLeft?: number;
  superChatBottom?: number;
  superChatWidth?: number;
  boxFontSize?: number;
  danmakuTop?: number;
  danmakuFontSize?: number;
  danmakuLineHeight?: number;
};

export type AppSettings = {
  outputDir: string;
  cookie: string;
  pollIntervalSec: number;
  targetQn: number;
  preferHevc: boolean;
  roomImageMode: 'cover' | 'keyframe';
  outputContainer: 'mp4' | 'mkv';
  segmentMinutes: number;
  autoBurnDanmaku: boolean;
  deleteSourceAfterBurn: boolean;
  burnOverlayMode: 'danmaku' | 'danmaku-gift';
  burnDanmakuArea: DanmakuArea;
  burnDanmakuStylePreset: DanmakuStylePreset;
  burnDanmakuStyleLayout: DanmakuStyleLayout;
  burnCodec: string;
  burnCrf: number;
  notifyLiveStarted: boolean;
  notifyLiveEnded: boolean;
  notifyRecordingStarted: boolean;
  notifyRecordingEnded: boolean;
  notifyBurnStarted: boolean;
  notifyBurnEnded: boolean;
  webhookEnabled: boolean;
  webhookUrl: string;
  webhookBearerToken: string;
  webhookBearerTokenConfigured: boolean;
  webhookBearerTokenClear: boolean;
  webhookAllowPrivateNetwork: boolean;
  openBrowserOnStart: boolean;
  hideOverviewNextStep: boolean;
  autoUpdateEnabled: boolean;
  updateManifestUrl: string;
  serverHost: '127.0.0.1' | '0.0.0.0' | 'localhost' | '::';
  serverPort: number;
  accessUsername: string;
  accessPassword: string;
  accessAuthConfigured: boolean;
  trustedProxies: string[];
};

export type UpdateState = {
  status:
    | 'idle'
    | 'checking'
    | 'available'
    | 'up-to-date'
    | 'blocked'
    | 'queued'
    | 'downloading'
    | 'ready'
    | 'applying'
    | 'error';
  currentVersion: string;
  latestVersion?: string;
  message: string;
  checkedAt?: number;
  downloadReceivedBytes?: number;
  downloadTotalBytes?: number;
  downloadProgress?: number | null;
  updateLogPath?: string;
  statusPath?: string;
  packagePath?: string;
  queued?: boolean;
  activeJobs?: boolean;
  autoApplySupported?: boolean;
  msixManaged?: boolean;
  manifest?: {
    version: string;
    tagName?: string;
    packageType?: 'installer' | 'portable' | 'msix' | 'deb' | 'tarball';
    packageUrl: string;
    sha256?: string;
    installerArgs?: string[] | string;
    releaseUrl?: string;
    notes?: string;
  } | null;
};

export type LoginState = {
  status: 'waiting' | 'scanned' | 'success' | 'expired' | 'error';
  message: string;
  qrImageDataUrl?: string;
  expiresAt?: number;
};

export type ExportResult = {
  ok: boolean;
  mode: 'clean' | 'burn' | 'subtitles';
  queued?: boolean;
  queueId?: string;
  message?: string;
  outputPath?: string;
  cleanPath?: string;
  cssPath?: string;
  assPath?: string;
  eventCount?: number;
};

export type PreviewStartResult = {
  previewUrl: string;
  expiresAt: number;
  stream: Omit<StreamChoice, 'url'> & { url: string };
};

export type ExportPreviewResult = {
  ok: boolean;
  id: string;
  previewUrl: string;
  ready: boolean;
  cached: boolean;
  progress?: FfmpegJobProgress;
};

export type PreviewProxyState = {
  id: string;
  sourcePath: string;
  previewUrl: string;
  status: 'running' | 'ready' | 'error';
  ready: boolean;
  cached: boolean;
  message?: string;
  updatedAt: number;
};

export type SelectPathRequest = {
  type: 'directory' | 'video' | 'danmaku' | 'css';
  currentPath?: string;
};

export type SelectPathResult = {
  ok: boolean;
  path?: string;
  cancelled?: boolean;
  message?: string;
};

export type FfmpegCodecOption = {
  value: string;
  label: string;
  kind: 'software' | 'hardware';
  vendor?: 'nvidia' | 'intel' | 'amd';
  reason?: string;
};

export type FfmpegCapabilities = {
  burnCodecs: FfmpegCodecOption[];
  unavailableBurnCodecs: FfmpegCodecOption[];
  hwaccels: string[];
  videoAdapters: Array<{
    name: string;
    vendor: 'nvidia' | 'intel' | 'amd' | 'unknown';
  }>;
  probedAt: number;
  probeError?: string;
};

export type FfmpegJobProgress = {
  id: string;
  kind: 'burn' | 'export' | 'merge' | 'preview' | 'repair';
  status: 'running' | 'completed' | 'error' | 'cancelled';
  label: string;
  outputPath?: string;
  roomId?: string;
  codec?: string;
  codecKind?: 'software' | 'hardware';
  startedAt: number;
  updatedAt: number;
  currentTimeSec?: number;
  durationSec?: number;
  estimatedRemainingSec?: number | null;
  percent?: number | null;
  message?: string;
};

export type ExportQueueItem = {
  id: string;
  label: string;
  mode: 'clean' | 'burn';
  cleanPath: string;
  outputPath?: string;
  startTime: string;
  endTime: string;
  createdAt: number;
};

export type BurnQueueItem = {
  id: string;
  roomId: string;
  label: string;
  cleanPath: string;
  createdAt: number;
};

export type DiskSpaceState = {
  requestedPath: string;
  checkedPath: string;
  totalBytes: number;
  freeBytes: number;
  usedBytes: number;
  usedPercent: number;
  checkedAt: number;
  error?: string;
};

export type ExportClipRequest = {
  mode: 'clean' | 'burn';
  cleanPath: string;
  danmakuPath?: string;
  cssPath?: string;
  startTime: string;
  endTime: string;
  overlayMode?: 'danmaku' | 'danmaku-gift';
  danmakuArea?: DanmakuArea;
  stylePreset?: DanmakuStylePreset;
  styleLayout?: DanmakuStyleLayout;
  outputDir?: string;
  outputPath?: string;
};

export type SubtitleRequest = Omit<ExportClipRequest, 'mode'> & {
  overlayMode?: 'danmaku' | 'danmaku-gift';
  danmakuArea?: DanmakuArea;
};

export type LogEntry = {
  id: string;
  time: number;
  level: 'info' | 'warn' | 'error' | 'success';
  message: string;
};

export type AppState = {
  settings: AppSettings;
  rooms: RoomState[];
  recordings: RecordingState[];
  logs: LogEntry[];
  login?: LoginState;
  bilibiliLoggedIn?: boolean;
  bilibiliCookieVisible?: boolean;
  version: string;
  platform?: string;
  uiCapabilities?: {
    nativePathPicker: boolean;
    openServerPath: boolean;
    nativeNotifications: boolean;
    startupControl: boolean;
    managedService: boolean;
    serviceShutdown: boolean;
  };
  update: UpdateState;
  ffmpegPath?: string;
  ffmpegCapabilities?: FfmpegCapabilities;
  exportProgress?: FfmpegJobProgress | null;
  exportQueue?: ExportQueueItem[];
  burnQueue?: BurnQueueItem[];
  previewProgress?: FfmpegJobProgress | null;
  previewProxy?: PreviewProxyState | null;
  startupEnabled: boolean;
  outputDiskSpace?: DiskSpaceState | null;
  access?: {
    required: boolean;
    configured: boolean;
    authenticated: boolean;
    username: string;
  };
  currentHost: string;
  currentPort: number;
  storePath?: string;
  appRoot?: string;
  distRoot?: string;
  operationNotice?: {
    kind: 'success' | 'warning' | 'error';
    title: string;
    message?: string;
  };
};

export type RecorderApi = {
  getInitialState: () => Promise<AppState>;
  startQrLogin: () => Promise<AppState>;
  cancelQrLogin: () => Promise<AppState>;
  chooseOutputDir: (currentPath?: string) => Promise<string | undefined>;
  selectPath: (request: SelectPathRequest) => Promise<SelectPathResult>;
  getDiskSpace: (path?: string) => Promise<DiskSpaceState>;
  saveSettings: (settings: Partial<AppSettings>) => Promise<AppState>;
  addRoom: (roomId: string) => Promise<AppState>;
  removeRoom: (roomId: string) => Promise<AppState>;
  refreshRoom: (roomId: string, options?: { silent?: boolean }) => Promise<AppState>;
  setMonitoring: (roomId: string, enabled: boolean) => Promise<AppState>;
  setAutoRecord: (roomId: string, enabled: boolean) => Promise<AppState>;
  startRecording: (roomId: string) => Promise<AppState>;
  stopRecording: (roomId: string) => Promise<AppState>;
  startPreview: (roomId: string) => Promise<PreviewStartResult>;
  startExportPreview: (request: { cleanPath: string }) => Promise<ExportPreviewResult>;
  cancelExportPreview: () => Promise<AppState>;
  burnDanmaku: (
    roomId: string,
    options?: {
      overlayMode?: AppSettings['burnOverlayMode'];
      danmakuArea?: DanmakuArea;
      stylePreset?: DanmakuStylePreset;
      styleLayout?: DanmakuStyleLayout;
      prepareOnly?: boolean;
    }
  ) => Promise<AppState>;
  cancelBurnDanmaku: (roomId: string) => Promise<AppState>;
  prepareDanmaku: (
    roomId: string,
    options?: {
      overlayMode?: AppSettings['burnOverlayMode'];
      danmakuArea?: DanmakuArea;
      stylePreset?: DanmakuStylePreset;
      styleLayout?: DanmakuStyleLayout;
    }
  ) => Promise<AppState>;
  prepareSubtitleAssets: (request: SubtitleRequest) => Promise<ExportResult>;
  exportClip: (request: ExportClipRequest) => Promise<ExportResult>;
  cancelExport: () => Promise<AppState>;
  scanRecordings: () => Promise<AppState>;
  cleanupMergedResiduals: () => Promise<AppState>;
  clearLogs: () => Promise<AppState>;
  openOutputDir: () => Promise<AppState>;
  openPathDir: (path: string, options?: { asDirectory?: boolean }) => Promise<AppState>;
  openConfigDir: () => Promise<AppState>;
  checkUpdate: () => Promise<AppState>;
  downloadUpdate: () => Promise<AppState>;
  applyUpdate: () => Promise<AppState>;
  queueUpdate: () => Promise<AppState>;
  setStartup: (enabled: boolean) => Promise<AppState>;
  testNotification: () => Promise<AppState>;
  testWebhook: () => Promise<AppState>;
  shutdown: () => Promise<void>;
  onStateChanged: (callback: (state: AppState) => void) => () => void;
};

export type Page = 'overview' | 'rooms' | 'export' | 'settings' | 'maintenance' | 'logs';

export type ExportDraft = {
  cleanPath: string;
  danmakuPath: string;
  cssPath: string;
  startTime: string;
  endTime: string;
  mode: 'clean' | 'burn';
  overlayMode: AppSettings['burnOverlayMode'];
  danmakuArea: DanmakuArea;
  stylePreset: DanmakuStylePreset;
  styleLayout: DanmakuStyleLayout;
  outputDir: string;
};
