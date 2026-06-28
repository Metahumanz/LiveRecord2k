/// <reference types="vite/client" />

export type RoomState = {
  id: string;
  realRoomId?: number;
  shortId?: number;
  title?: string;
  anchor?: string;
  cover?: string;
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
};

export type AppSettings = {
  outputDir: string;
  cookie: string;
  pollIntervalSec: number;
  targetQn: number;
  preferHevc: boolean;
  outputContainer: 'mp4' | 'mkv';
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
  serverPort: number;
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
  ffmpegPath?: string;
  startupEnabled: boolean;
  currentPort: number;
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
  setStartup: (enabled: boolean) => Promise<AppState>;
  testNotification: () => Promise<AppState>;
  shutdown: () => Promise<void>;
  onStateChanged: (callback: (state: AppState) => void) => () => void;
};
