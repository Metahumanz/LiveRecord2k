/// <reference types="vite/client" />

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
  recording: boolean;
  burning: boolean;
  lastCheckedAt?: number;
  lastError?: string;
  stream?: StreamChoice;
  currentRecording?: RecordingState;
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
  danmakuPath: string;
  cssPath?: string;
  assPath?: string;
  burnedPath?: string;
  mergeGroup?: string;
  mergeSequence?: number;
  mergeOutputPath?: string;
  mergedFrom?: string[];
  durationSec?: number;
  fileSize?: number;
  valid?: boolean;
  eventCount: number;
  danmakuStatus?: 'connecting' | 'connected' | 'disconnected' | 'error';
  danmakuMessage?: string;
  danmakuPopularity?: number;
  ignoredDanmakuCount?: number;
  videoInfo?: {
    codec?: string;
    width: number;
    height: number;
    fps?: number;
  } | null;
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
  burnOverlayMode: 'danmaku' | 'danmaku-gift';
  burnCodec: string;
  burnCrf: number;
  notifyLiveStarted: boolean;
  notifyLiveEnded: boolean;
  notifyRecordingStarted: boolean;
  notifyRecordingEnded: boolean;
  notifyBurnStarted: boolean;
  notifyBurnEnded: boolean;
  openBrowserOnStart: boolean;
  updateManifestUrl: string;
  serverPort: number;
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
  queued?: boolean;
  activeJobs?: boolean;
  manifest?: {
    version: string;
    tagName?: string;
    packageUrl: string;
    sha256?: string;
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
  outputPath?: string;
  cleanPath?: string;
  cssPath?: string;
  assPath?: string;
  eventCount?: number;
};

export type ExportClipRequest = {
  mode: 'clean' | 'burn';
  cleanPath: string;
  danmakuPath?: string;
  cssPath?: string;
  startTime: string;
  endTime: string;
  overlayMode?: 'danmaku' | 'danmaku-gift';
  outputDir?: string;
  outputPath?: string;
};

export type SubtitleRequest = Omit<ExportClipRequest, 'mode'> & {
  overlayMode?: 'danmaku' | 'danmaku-gift';
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
  version: string;
  update: UpdateState;
  ffmpegPath?: string;
  startupEnabled: boolean;
  currentPort: number;
  storePath?: string;
  appRoot?: string;
  distRoot?: string;
};

export type RecorderApi = {
  getInitialState: () => Promise<AppState>;
  startQrLogin: () => Promise<AppState>;
  cancelQrLogin: () => Promise<AppState>;
  chooseOutputDir: () => Promise<string | undefined>;
  saveSettings: (settings: Partial<AppSettings>) => Promise<AppState>;
  addRoom: (roomId: string) => Promise<AppState>;
  removeRoom: (roomId: string) => Promise<AppState>;
  refreshRoom: (roomId: string) => Promise<AppState>;
  setMonitoring: (roomId: string, enabled: boolean) => Promise<AppState>;
  startRecording: (roomId: string) => Promise<AppState>;
  stopRecording: (roomId: string) => Promise<AppState>;
  burnDanmaku: (roomId: string, options?: { overlayMode?: AppSettings['burnOverlayMode']; prepareOnly?: boolean }) => Promise<AppState>;
  prepareDanmaku: (roomId: string, options?: { overlayMode?: AppSettings['burnOverlayMode'] }) => Promise<AppState>;
  prepareSubtitleAssets: (request: SubtitleRequest) => Promise<ExportResult>;
  exportClip: (request: ExportClipRequest) => Promise<ExportResult>;
  scanRecordings: () => Promise<AppState>;
  clearLogs: () => Promise<AppState>;
  openOutputDir: () => Promise<AppState>;
  openConfigDir: () => Promise<AppState>;
  checkUpdate: () => Promise<AppState>;
  applyUpdate: () => Promise<AppState>;
  queueUpdate: () => Promise<AppState>;
  setStartup: (enabled: boolean) => Promise<AppState>;
  testNotification: () => Promise<AppState>;
  shutdown: () => Promise<void>;
  onStateChanged: (callback: (state: AppState) => void) => () => void;
};
