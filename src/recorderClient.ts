import type { AppSettings, AppState, RecorderApi } from './vite-env';

const listeners = new Set<(state: AppState) => void>();
let eventSource: EventSource | null = null;
let latestState: AppState | null = null;

export const recorder: RecorderApi = {
  async getInitialState() {
    const state = await api<AppState>('/api/state');
    latestState = state;
    return state;
  },
  startQrLogin: () => api<AppState>('/api/auth/qr/start', {}),
  cancelQrLogin: () => api<AppState>('/api/auth/qr/cancel', {}),
  async chooseOutputDir() {
    const current = latestState?.settings.outputDir || '';
    const next = window.prompt('输入录像输出目录路径', current);
    return next?.trim() || undefined;
  },
  saveSettings: (settings) => api<AppState>('/api/settings/save', { settings }),
  addRoom: (roomId) => api<AppState>('/api/rooms/add', { roomId }),
  removeRoom: (roomId) => api<AppState>('/api/rooms/remove', { roomId }),
  refreshRoom: (roomId) => api<AppState>('/api/rooms/refresh', { roomId }),
  setMonitoring: (roomId, enabled) => api<AppState>('/api/rooms/monitor', { roomId, enabled }),
  startRecording: (roomId) => api<AppState>('/api/rooms/record/start', { roomId }),
  stopRecording: (roomId) => api<AppState>('/api/rooms/record/stop', { roomId }),
  burnDanmaku: (roomId) => api<AppState>('/api/rooms/burn', { roomId }),
  clearLogs: () => api<AppState>('/api/logs/clear', {}),
  openOutputDir: () => api<AppState>('/api/shell/open-output', {}),
  openConfigDir: () => api<AppState>('/api/shell/open-config', {}),
  checkUpdate: () => api<AppState>('/api/update/check', {}),
  applyUpdate: () => api<AppState>('/api/update/apply', {}),
  queueUpdate: () => api<AppState>('/api/update/queue', {}),
  setStartup: (enabled) => api<AppState>('/api/system/startup', { enabled }),
  testNotification: () => api<AppState>('/api/system/test-notification', {}),
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

async function api<T = unknown>(url: string, body?: unknown): Promise<T> {
  const response = await fetch(url, {
    method: body === undefined ? 'GET' : 'POST',
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
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
    const state = JSON.parse(event.data) as AppState;
    latestState = state;
    for (const listener of listeners) {
      listener(state);
    }
  };
  eventSource.onerror = () => {
    eventSource?.close();
    eventSource = null;
    window.setTimeout(() => {
      if (listeners.size > 0) {
        ensureEventSource();
      }
    }, 1500);
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
