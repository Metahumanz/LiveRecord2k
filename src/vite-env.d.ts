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
  startedAt: number;
  cleanPath: string;
  danmakuPath: string;
  assPath?: string;
  burnedPath?: string;
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

export type LogEntry = {
  id: string;
  time: number;
  level: 'info' | 'warn' | 'error' | 'success';
  message: string;
};

export type AppState = {
  settings: AppSettings;
  rooms: RoomState[];
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
  burnDanmaku: (roomId: string) => Promise<AppState>;
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
