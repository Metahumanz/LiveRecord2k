import type { AppSettings, AppState, RecorderApi } from './types';

const listeners = new Set<(state: AppState) => void>();
let eventSource: EventSource | null = null;
let latestState: AppState | null = null;
let eventSourceRetryCount = 0;

export const recorder: RecorderApi = {
  async getInitialState() {
    const state = await api<AppState>('/api/state');
    latestState = state;
    return state;
  },
  startQrLogin: () => api<AppState>('/api/auth/qr/start', {}),
  cancelQrLogin: () => api<AppState>('/api/auth/qr/cancel', {}),
  async chooseOutputDir(currentPath = '') {
    const current = currentPath.trim() || latestState?.settings.outputDir || '';
    const result = await api<{ path?: string; cancelled?: boolean; message?: string }>(
      '/api/settings/choose-output-dir',
      { currentPath: current },
      { timeoutMs: 0 }
    );
    if (result.message && !result.cancelled) {
      throw new Error(result.message);
    }
    return result.path?.trim() || undefined;
  },
  selectPath: (request) => api('/api/shell/select-path', request, { timeoutMs: 0 }),
  getDiskSpace: (path) => api('/api/system/disk-space', { path }),
  saveSettings: (settings) => api<AppState>('/api/settings/save', { settings }, { timeoutMs: 120000 }),
  addRoom: (roomId) => api<AppState>('/api/rooms/add', { roomId }, { timeoutMs: 75000 }),
  removeRoom: (roomId) => api<AppState>('/api/rooms/remove', { roomId }),
  refreshRoom: (roomId, options) => api<AppState>('/api/rooms/refresh', { roomId, ...options }, { timeoutMs: 75000 }),
  setMonitoring: (roomId, enabled) => api<AppState>('/api/rooms/monitor', { roomId, enabled }),
  setAutoRecord: (roomId, enabled) => api<AppState>('/api/rooms/auto-record', { roomId, enabled }),
  startRecording: (roomId) => api<AppState>('/api/rooms/record/start', { roomId }, { timeoutMs: 120000 }),
  stopRecording: (roomId) => api<AppState>('/api/rooms/record/stop', { roomId }),
  cancelMerge: (roomId) => api<AppState>('/api/rooms/merge/cancel', { roomId }),
  retryMerge: (roomId) => api<AppState>('/api/rooms/merge/retry', { roomId }),
  startPreview: (roomId) => api('/api/rooms/preview/start', { roomId }, { timeoutMs: 120000 }),
  startExportPreview: (request) => api('/api/export/preview/start', request),
  cancelExportPreview: () => api<AppState>('/api/export/preview/cancel', {}),
  burnDanmaku: (roomId, options) => api<AppState>('/api/rooms/burn', { roomId, options }, { timeoutMs: 180000 }),
  cancelBurnDanmaku: (roomId) => api<AppState>('/api/rooms/burn/cancel', { roomId }),
  prepareDanmaku: (roomId, options) => api<AppState>('/api/rooms/subtitles', { roomId, options }, { timeoutMs: 180000 }),
  prepareSubtitleAssets: (request) => api('/api/export/subtitles', request, { timeoutMs: 180000 }),
  exportClip: (request) => api('/api/export/clip', request),
  cancelExport: () => api<AppState>('/api/export/cancel', {}),
  scanRecordings: () => api<AppState>('/api/recordings/scan', {}, { timeoutMs: 180000 }),
  cleanupMergedResiduals: () => api<AppState>('/api/recordings/cleanup-merged', {}, { timeoutMs: 180000 }),
  clearLogs: () => api<AppState>('/api/logs/clear', {}),
  openOutputDir: () => api<AppState>('/api/shell/open-output', {}),
  openPathDir: (path, options) => api<AppState>('/api/shell/open-path-dir', { path, ...options }),
  openConfigDir: () => api<AppState>('/api/shell/open-config', {}),
  checkUpdate: () => api<AppState>('/api/update/check', {}, { timeoutMs: 52000 }),
  downloadUpdate: () => api<AppState>('/api/update/download', {}, { timeoutMs: 0 }),
  applyUpdate: () => api<AppState>('/api/update/apply', {}, { timeoutMs: 0 }),
  queueUpdate: () => api<AppState>('/api/update/queue', {}, { timeoutMs: 0 }),
  setStartup: (enabled) => api<AppState>('/api/system/startup', { enabled }),
  testNotification: () => api<AppState>('/api/system/test-notification', {}),
  testWebhook: () => api<AppState>('/api/system/test-webhook', {}, { timeoutMs: 45000 }),
  shutdown: () => api('/api/system/shutdown', {}),
  onStateChanged(callback) {
    listeners.add(callback);
    ensureEventSource();
    return () => {
      listeners.delete(callback);
      if (listeners.size === 0 && eventSource) {
        eventSource.close();
        eventSource = null;
      }
    };
  }
};

async function api<T = unknown>(url: string, body?: unknown, options: { timeoutMs?: number } = {}): Promise<T> {
  const timeoutMs = options.timeoutMs === undefined ? 30000 : Math.max(0, options.timeoutMs);
  const controller = timeoutMs ? new AbortController() : null;
  const timer = timeoutMs
    ? window.setTimeout(() => controller?.abort(), timeoutMs)
    : 0;
  let response: Response;
  try {
    response = await fetch(url, {
      method: body === undefined ? 'GET' : 'POST',
      headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller?.signal
    });
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw new Error('请求超时，请稍后重试。');
    }
    throw error;
  } finally {
    if (timer) {
      window.clearTimeout(timer);
    }
  }
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(payload?.error || `请求失败：HTTP ${response.status}`);
  }
  if (isAppState(payload)) {
    latestState = payload;
  }
  return payload as T;
}

function ensureEventSource() {
  if (eventSource) {
    return;
  }
  eventSource = new EventSource('/api/events');
  eventSource.onmessage = (event) => {
    try {
      const state = JSON.parse(event.data) as AppState;
      if (!isAppState(state)) return;
      eventSourceRetryCount = 0;
      latestState = state;
      for (const listener of listeners) listener(state);
    } catch {
      // Ignore one malformed event; EventSource remains connected for recovery.
    }
  };
  eventSource.onerror = () => {
    eventSource?.close();
    eventSource = null;
    eventSourceRetryCount += 1;
    window.setTimeout(() => {
      if (listeners.size > 0) {
        ensureEventSource();
      }
    }, Math.min(15000, 1000 * 2 ** Math.min(eventSourceRetryCount - 1, 4)));
  };
}

function isAppState(value: unknown): value is AppState {
  return Boolean(
    value &&
      typeof value === 'object' &&
      'settings' in value &&
      'rooms' in value &&
      'logs' in value
  );
}

export type { AppSettings, AppState };
