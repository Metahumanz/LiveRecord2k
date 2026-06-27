import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Activity,
  Bell,
  CircleAlert,
  Clock3,
  Cpu,
  FileVideo,
  FolderOpen,
  Gauge,
  HardDrive,
  ListVideo,
  LogIn,
  MessageSquareText,
  MonitorDot,
  Play,
  Plus,
  QrCode,
  Radio,
  RefreshCw,
  Save,
  Settings2,
  Sparkles,
  Square,
  Trash2,
  Video,
  X
} from 'lucide-react';
import type { AppSettings, AppState, LogEntry, RoomState } from './vite-env';
import {
  recorder,
  requestBrowserNotificationPermission,
  showBrowserNotification
} from './recorderClient';

const qnOptions = [
  { label: '2K / 原画优先', value: 15000 },
  { label: '原画', value: 10000 },
  { label: '蓝光', value: 400 },
  { label: '超清', value: 250 },
  { label: '高清', value: 150 }
];

const codecOptions = [
  { label: 'H.265 软件编码', value: 'libx265' },
  { label: 'H.264 软件编码', value: 'libx264' },
  { label: 'NVIDIA H.265', value: 'hevc_nvenc' },
  { label: 'Intel H.265', value: 'hevc_qsv' },
  { label: 'AMD H.265', value: 'hevc_amf' }
];

const containerOptions = [
  { label: 'MP4', value: 'mp4' },
  { label: 'MKV', value: 'mkv' }
] as const;

export default function App() {
  const [state, setState] = useState<AppState | null>(null);
  const [settingsDraft, setSettingsDraft] = useState<AppSettings | null>(null);
  const [roomInput, setRoomInput] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const previousStateRef = useRef<AppState | null>(null);

  useEffect(() => {
    recorder.getInitialState().then((nextState) => {
      setState(nextState);
      setSettingsDraft(nextState.settings);
    });
    return recorder.onStateChanged((nextState) => {
      setState(nextState);
      setSettingsDraft((current) => {
        if (!current) {
          return nextState.settings;
        }
        if (nextState.login?.status === 'success') {
          return { ...current, cookie: nextState.settings.cookie };
        }
        return current;
      });
    });
  }, []);

  useEffect(() => {
    if (!state) {
      return;
    }
    const previous = previousStateRef.current;
    if (previous) {
      notifyStateTransitions(previous, state);
    }
    previousStateRef.current = state;
  }, [state]);

  const stats = useMemo(() => {
    const rooms = state?.rooms ?? [];
    return {
      rooms: rooms.length,
      live: rooms.filter((room) => room.liveStatus === 1).length,
      monitoring: rooms.filter((room) => room.monitoring).length,
      recording: rooms.filter((room) => room.recording).length,
      burning: rooms.filter((room) => room.burning).length,
      events: rooms.reduce((sum, room) => sum + (room.currentRecording?.eventCount ?? 0), 0)
    };
  }, [state?.rooms]);

  async function run<T>(key: string, action: () => Promise<T>) {
    setBusy(key);
    try {
      const result = await action();
      if (isAppState(result)) {
        setState(result);
        setSettingsDraft(result.settings);
      }
    } finally {
      setBusy(null);
    }
  }

  async function addRoom() {
    const value = roomInput.trim();
    if (!value) {
      return;
    }
    await run('add-room', () => recorder.addRoom(value));
    setRoomInput('');
  }

  async function chooseOutputDir() {
    const selected = await recorder.chooseOutputDir();
    if (selected && settingsDraft) {
      setSettingsDraft({ ...settingsDraft, outputDir: selected });
    }
  }

  if (!state || !settingsDraft) {
    return (
      <main className="loading-screen">
        <Activity className="spin" size={28} />
        <span>正在启动哔哩录播 2K</span>
      </main>
    );
  }

  return (
    <main className="app-shell">
      <aside className="nav-panel">
        <div className="brand">
          <img className="brand-logo" src="/app-icon.svg" alt="" />
          <div>
            <h1>哔哩录播 2K</h1>
            <p>直播监听 · 源流录制 · 弹幕烧录</p>
          </div>
        </div>

        <section className="nav-section">
          <div className="section-title">
            <Plus size={17} />
            <span>添加直播间</span>
          </div>
          <div className="add-room">
            <input
              value={roomInput}
              onChange={(event) => setRoomInput(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  addRoom();
                }
              }}
              inputMode="numeric"
              placeholder="输入房间号"
            />
            <button
              className="icon-button primary"
              title="添加直播间"
              disabled={busy === 'add-room'}
              onClick={addRoom}
            >
              <Plus size={18} />
            </button>
          </div>
        </section>

        <section className="nav-section">
          <div className="section-title">
            <Gauge size={17} />
            <span>总览</span>
          </div>
          <div className="side-metrics">
            <Metric icon={<ListVideo size={18} />} label="房间" value={stats.rooms} />
            <Metric icon={<Radio size={18} />} label="直播中" value={stats.live} />
            <Metric icon={<MonitorDot size={18} />} label="监听中" value={stats.monitoring} />
            <Metric icon={<Video size={18} />} label="录制中" value={stats.recording} />
          </div>
        </section>

        <section className="nav-section compact">
          <div className="section-title">
            <HardDrive size={17} />
            <span>输出目录</span>
          </div>
          <p className="path-preview" title={settingsDraft.outputDir}>
            {settingsDraft.outputDir}
          </p>
          <div className="split-buttons">
            <button className="wide-button" onClick={chooseOutputDir}>
              <FolderOpen size={17} />
              更改
            </button>
            <button
              className="wide-button"
              onClick={() => run('open-output', async () => recorder.openOutputDir())}
            >
              <HardDrive size={17} />
              打开
            </button>
          </div>
        </section>
      </aside>

      <section className="workspace-panel">
        <header className="workspace-header">
          <div>
            <h2>直播间工作台</h2>
            <p>
              {settingsDraft.outputContainer.toUpperCase()} ·{' '}
              {settingsDraft.preferHevc ? 'H.265 优先' : 'H.264 优先'} · 清晰度 {settingsDraft.targetQn}
            </p>
          </div>
          <div className="status-strip">
            <StatusChip tone="live" icon={<Radio size={16} />} label="直播" value={stats.live} />
            <StatusChip tone="recording" icon={<Video size={16} />} label="录制" value={stats.recording} />
            <StatusChip tone="burning" icon={<Sparkles size={16} />} label="烧录" value={stats.burning} />
            <StatusChip tone="events" icon={<MessageSquareText size={16} />} label="事件" value={stats.events} />
          </div>
        </header>

        <section className="room-grid">
          {state.rooms.length === 0 ? (
            <div className="empty-state">
              <Radio size={36} />
              <span>暂无直播间</span>
            </div>
          ) : (
            state.rooms.map((room) => (
              <RoomCard key={room.id} room={room} busy={busy} run={run} />
            ))
          )}
        </section>
      </section>

      <aside className="inspector-panel">
        <LoginCard
          state={state}
          settingsDraft={settingsDraft}
          busy={busy}
          run={run}
          setSettingsDraft={setSettingsDraft}
        />

        <SettingsCard
          settingsDraft={settingsDraft}
          busy={busy}
          run={run}
          chooseOutputDir={chooseOutputDir}
          setSettingsDraft={setSettingsDraft}
        />

        <LogPanel logs={state.logs} busy={busy} run={run} />
      </aside>

      {state.login ? <QrLoginPanel login={state.login} busy={busy} run={run} /> : null}
    </main>
  );
}

function LoginCard({
  state,
  settingsDraft,
  busy,
  run,
  setSettingsDraft
}: {
  state: AppState;
  settingsDraft: AppSettings;
  busy: string | null;
  run: <T>(key: string, action: () => Promise<T>) => Promise<void>;
  setSettingsDraft: (settings: AppSettings) => void;
}) {
  const loggedIn = settingsDraft.cookie.includes('SESSDATA=');

  return (
    <section className="inspector-card">
      <div className="card-heading">
        <div className="section-title">
          <LogIn size={17} />
          <span>账号登录</span>
        </div>
        <span className={loggedIn ? 'badge on' : 'badge'}>{loggedIn ? '已登录' : '未登录'}</span>
      </div>
      <button
        className="wide-button primary fill"
        disabled={busy === 'qr-login'}
        onClick={() => run('qr-login', recorder.startQrLogin)}
      >
        <QrCode size={17} />
        扫码登录
      </button>
      <label className="field">
        <span>登录凭证</span>
        <textarea
          rows={3}
          value={settingsDraft.cookie}
          onChange={(event) => setSettingsDraft({ ...settingsDraft, cookie: event.target.value })}
          placeholder="扫码成功后自动写入"
        />
      </label>
      {state.login ? <p className="inline-status">{state.login.message}</p> : null}
    </section>
  );
}

function SettingsCard({
  settingsDraft,
  busy,
  run,
  chooseOutputDir,
  setSettingsDraft
}: {
  settingsDraft: AppSettings;
  busy: string | null;
  run: <T>(key: string, action: () => Promise<T>) => Promise<void>;
  chooseOutputDir: () => Promise<void>;
  setSettingsDraft: (settings: AppSettings) => void;
}) {
  return (
    <section className="inspector-card settings-card">
      <div className="card-heading">
        <div className="section-title">
          <Settings2 size={17} />
          <span>录制参数</span>
        </div>
      </div>

      <label className="field">
        <span>输出目录</span>
        <div className="path-row">
          <input
            value={settingsDraft.outputDir}
            onChange={(event) => setSettingsDraft({ ...settingsDraft, outputDir: event.target.value })}
          />
          <button className="icon-button" title="选择目录" onClick={chooseOutputDir}>
            <FolderOpen size={17} />
          </button>
        </div>
      </label>

      <div className="settings-grid">
        <label className="field">
          <span>源流清晰度</span>
          <select
            value={settingsDraft.targetQn}
            onChange={(event) =>
              setSettingsDraft({ ...settingsDraft, targetQn: Number(event.target.value) })
            }
          >
            {qnOptions.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>

        <label className="field">
          <span>录像容器</span>
          <select
            value={settingsDraft.outputContainer}
            onChange={(event) =>
              setSettingsDraft({
                ...settingsDraft,
                outputContainer: event.target.value as AppSettings['outputContainer']
              })
            }
          >
            {containerOptions.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
      </div>

      <div className="settings-grid">
        <label className="field">
          <span>弹幕版编码</span>
          <select
            value={settingsDraft.burnCodec}
            onChange={(event) => setSettingsDraft({ ...settingsDraft, burnCodec: event.target.value })}
          >
            {codecOptions.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>

        <label className="field">
          <span>画质参数</span>
          <input
            type="number"
            min={16}
            max={35}
            value={settingsDraft.burnCrf}
            onChange={(event) =>
              setSettingsDraft({ ...settingsDraft, burnCrf: Number(event.target.value) })
            }
          />
        </label>
      </div>

      <label className="field compact-field">
        <span>监听间隔</span>
        <input
          type="number"
          min={5}
          max={300}
          value={settingsDraft.pollIntervalSec}
          onChange={(event) =>
            setSettingsDraft({ ...settingsDraft, pollIntervalSec: Number(event.target.value) })
          }
        />
      </label>

      <div className="toggle-list">
        <label className="toggle-row">
          <span>H.265 优先</span>
          <input
            type="checkbox"
            checked={settingsDraft.preferHevc}
            onChange={(event) => setSettingsDraft({ ...settingsDraft, preferHevc: event.target.checked })}
          />
        </label>
        <label className="toggle-row">
          <span>自动生成弹幕版</span>
          <input
            type="checkbox"
            checked={settingsDraft.autoBurnDanmaku}
            onChange={(event) =>
              setSettingsDraft({ ...settingsDraft, autoBurnDanmaku: event.target.checked })
            }
            />
        </label>
        <label className="toggle-row">
          <span>开播通知</span>
          <input
            type="checkbox"
            checked={settingsDraft.notifyLiveStarted}
            onChange={(event) =>
              setSettingsDraft({ ...settingsDraft, notifyLiveStarted: event.target.checked })
            }
          />
        </label>
        <label className="toggle-row">
          <span>下播通知</span>
          <input
            type="checkbox"
            checked={settingsDraft.notifyLiveEnded}
            onChange={(event) =>
              setSettingsDraft({ ...settingsDraft, notifyLiveEnded: event.target.checked })
            }
          />
        </label>
        <label className="toggle-row">
          <span>开始录制通知</span>
          <input
            type="checkbox"
            checked={settingsDraft.notifyRecordingStarted}
            onChange={(event) =>
              setSettingsDraft({ ...settingsDraft, notifyRecordingStarted: event.target.checked })
            }
          />
        </label>
        <label className="toggle-row">
          <span>结束录制通知</span>
          <input
            type="checkbox"
            checked={settingsDraft.notifyRecordingEnded}
            onChange={(event) =>
              setSettingsDraft({ ...settingsDraft, notifyRecordingEnded: event.target.checked })
            }
          />
        </label>
        <label className="toggle-row">
          <span>开始烧录通知</span>
          <input
            type="checkbox"
            checked={settingsDraft.notifyBurnStarted}
            onChange={(event) =>
              setSettingsDraft({ ...settingsDraft, notifyBurnStarted: event.target.checked })
            }
          />
        </label>
        <label className="toggle-row">
          <span>烧录完成通知</span>
          <input
            type="checkbox"
            checked={settingsDraft.notifyBurnEnded}
            onChange={(event) =>
              setSettingsDraft({ ...settingsDraft, notifyBurnEnded: event.target.checked })
            }
          />
        </label>
      </div>

      <button
        className="wide-button fill"
        type="button"
        onClick={async () => {
          const status = await requestBrowserNotificationPermission();
          if (status === 'granted') {
            showBrowserNotification('哔哩录播 2K', '浏览器通知已启用');
          }
        }}
      >
        <Bell size={17} />
        启用通知
      </button>

      <button
        className="wide-button primary fill"
        disabled={busy === 'save-settings'}
        onClick={() => run('save-settings', () => recorder.saveSettings(settingsDraft))}
      >
        <Save size={17} />
        保存参数
      </button>
    </section>
  );
}

function LogPanel({
  logs,
  busy,
  run
}: {
  logs: LogEntry[];
  busy: string | null;
  run: <T>(key: string, action: () => Promise<T>) => Promise<void>;
}) {
  return (
    <section className="inspector-card log-panel">
      <div className="log-header">
        <div className="section-title">
          <MessageSquareText size={17} />
          <span>运行日志</span>
        </div>
        <button
          className="text-button"
          disabled={busy === 'clear-logs'}
          onClick={() => run('clear-logs', recorder.clearLogs)}
        >
          清空
        </button>
      </div>
      <div className="log-list">
        {logs.length === 0 ? (
          <div className="empty-log">暂无日志</div>
        ) : (
          logs
            .slice()
            .reverse()
            .map((entry) => <LogRow key={entry.id} entry={entry} />)
        )}
      </div>
    </section>
  );
}

function QrLoginPanel({
  login,
  busy,
  run
}: {
  login: NonNullable<AppState['login']>;
  busy: string | null;
  run: <T>(key: string, action: () => Promise<T>) => Promise<void>;
}) {
  return (
    <div className="qr-backdrop">
      <div className="qr-panel">
        <div className="qr-header">
          <div>
            <h3>扫码登录</h3>
            <p>{login.message}</p>
          </div>
          <button
            className="icon-button"
            title="关闭"
            disabled={busy === 'cancel-login'}
            onClick={() => run('cancel-login', recorder.cancelQrLogin)}
          >
            <X size={17} />
          </button>
        </div>
        <div className={`qr-box ${login.status}`}>
          {login.qrImageDataUrl ? (
            <img src={login.qrImageDataUrl} alt="哔哩哔哩登录二维码" />
          ) : (
            <QrCode size={72} />
          )}
        </div>
        <div className="qr-footer">
          <span className={`login-status ${login.status}`}>{loginStatusLabel(login.status)}</span>
          {login.status === 'expired' || login.status === 'error' ? (
            <button
              className="wide-button primary"
              disabled={busy === 'qr-login'}
              onClick={() => run('qr-login', recorder.startQrLogin)}
            >
              <RefreshCw size={16} />
              重新生成
            </button>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function RoomCard({
  room,
  busy,
  run
}: {
  room: RoomState;
  busy: string | null;
  run: <T>(key: string, action: () => Promise<T>) => Promise<void>;
}) {
  const status = getRoomStatus(room);
  const roomKey = room.id;
  const streamText = room.stream
    ? `${displayCodec(room.stream.codec)} · 清晰度 ${room.stream.qn}`
    : '未选流';

  return (
    <article className={`room-card ${room.recording ? 'is-recording' : ''}`}>
      <div className="room-cover">
        {room.cover ? <img src={room.cover} alt="" /> : <Radio size={30} />}
        <span className={`status-pill ${status.kind}`}>{status.label}</span>
      </div>

      <div className="room-content">
        <div className="room-heading">
          <div>
            <h3>{room.title || `直播间 ${room.realRoomId || room.id}`}</h3>
            <p>{room.anchor || `房间 ${room.realRoomId || room.id}`}</p>
          </div>
          <button
            className="icon-button danger"
            title="移除直播间"
            disabled={room.recording || busy === `remove-${roomKey}`}
            onClick={() => run(`remove-${roomKey}`, () => recorder.removeRoom(room.id))}
          >
            <Trash2 size={17} />
          </button>
        </div>

        <div className="badge-row">
          <span className={room.monitoring ? 'badge on' : 'badge'}>监听</span>
          <span className={room.recording ? 'badge hot' : 'badge'}>录制</span>
          <span className={room.burning ? 'badge work' : 'badge'}>弹幕版</span>
        </div>

        <div className="room-meta">
          <span>
            <Clock3 size={14} />
            {room.lastCheckedAt ? formatClock(room.lastCheckedAt) : '未刷新'}
          </span>
          <span>
            <Cpu size={14} />
            {streamText}
          </span>
        </div>

        {room.currentRecording ? (
          <div className="recording-info">
            <span>
              <MessageSquareText size={14} />
              弹幕事件 {room.currentRecording.eventCount}
            </span>
            <span title={room.currentRecording.cleanPath}>
              <FileVideo size={14} />
              {filename(room.currentRecording.cleanPath)}
            </span>
          </div>
        ) : null}

        {room.lastError ? (
          <div className="error-line">
            <CircleAlert size={15} />
            <span>{room.lastError}</span>
          </div>
        ) : null}

        <div className="action-row">
          <button
            className="icon-button"
            title="刷新状态"
            disabled={busy === `refresh-${roomKey}`}
            onClick={() => run(`refresh-${roomKey}`, () => recorder.refreshRoom(room.id))}
          >
            <RefreshCw size={17} />
          </button>
          <button
            className={room.monitoring ? 'wide-button active' : 'wide-button'}
            disabled={busy === `monitor-${roomKey}`}
            onClick={() =>
              run(`monitor-${roomKey}`, () => recorder.setMonitoring(room.id, !room.monitoring))
            }
          >
            <MonitorDot size={17} />
            {room.monitoring ? '监听中' : '监听'}
          </button>
          {room.recording ? (
            <button
              className="wide-button danger"
              disabled={busy === `stop-${roomKey}`}
              onClick={() => run(`stop-${roomKey}`, () => recorder.stopRecording(room.id))}
            >
              <Square size={16} />
              停止
            </button>
          ) : (
            <button
              className="wide-button primary"
              disabled={busy === `record-${roomKey}`}
              onClick={() => run(`record-${roomKey}`, () => recorder.startRecording(room.id))}
            >
              <Play size={16} />
              录制
            </button>
          )}
          <button
            className="icon-button"
            title="生成弹幕版"
            disabled={!room.currentRecording || room.recording || room.burning}
            onClick={() => run(`burn-${roomKey}`, () => recorder.burnDanmaku(room.id))}
          >
            <Sparkles size={17} />
          </button>
        </div>
      </div>
    </article>
  );
}

function Metric({ icon, label, value }: { icon: React.ReactNode; label: string; value: number }) {
  return (
    <div className="metric">
      {icon}
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function StatusChip({
  icon,
  label,
  value,
  tone
}: {
  icon: React.ReactNode;
  label: string;
  value: number;
  tone: 'live' | 'recording' | 'burning' | 'events';
}) {
  return (
    <div className={`status-chip ${tone}`}>
      {icon}
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function LogRow({ entry }: { entry: LogEntry }) {
  return (
    <div className={`log-row ${entry.level}`}>
      <span>{formatClock(entry.time)}</span>
      <p>{entry.message}</p>
    </div>
  );
}

function getRoomStatus(room: RoomState) {
  if (room.recording) {
    return { label: '录制中', kind: 'recording' };
  }
  if (room.liveStatus === 1) {
    return { label: '直播中', kind: 'live' };
  }
  if (room.liveStatus === 2) {
    return { label: '轮播', kind: 'loop' };
  }
  return { label: '未开播', kind: 'offline' };
}

function formatClock(time: number) {
  return new Intl.DateTimeFormat('zh-CN', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  }).format(time);
}

function filename(filePath: string) {
  return filePath.split(/[\\/]/).pop() || filePath;
}

function displayCodec(codec: string) {
  const value = codec.toLowerCase();
  if (value.includes('hevc') || value.includes('h265')) {
    return 'H.265';
  }
  if (value.includes('avc') || value.includes('h264')) {
    return 'H.264';
  }
  return codec.toUpperCase();
}

function loginStatusLabel(status: NonNullable<AppState['login']>['status']) {
  if (status === 'waiting') {
    return '等待扫码';
  }
  if (status === 'scanned') {
    return '等待确认';
  }
  if (status === 'success') {
    return '登录成功';
  }
  if (status === 'expired') {
    return '已过期';
  }
  return '登录异常';
}

function notifyStateTransitions(previous: AppState, next: AppState) {
  const previousRooms = new Map(previous.rooms.map((room) => [room.id, room]));
  const settings = next.settings;

  for (const room of next.rooms) {
    const oldRoom = previousRooms.get(room.id);
    if (!oldRoom) {
      continue;
    }
    const name = room.title || room.anchor || `直播间 ${room.realRoomId || room.id}`;

    if (oldRoom.liveStatus !== 1 && room.liveStatus === 1 && settings.notifyLiveStarted) {
      showBrowserNotification('开播提醒', `${name} 已开播`);
    }
    if (oldRoom.liveStatus === 1 && room.liveStatus !== 1 && settings.notifyLiveEnded) {
      showBrowserNotification('下播提醒', `${name} 已下播`);
    }
    if (!oldRoom.recording && room.recording && settings.notifyRecordingStarted) {
      showBrowserNotification('开始录制', `${name} 已开始写入录像`);
    }
    if (oldRoom.recording && !room.recording && settings.notifyRecordingEnded) {
      showBrowserNotification('录制结束', `${name} 录像已停止`);
    }
    if (!oldRoom.burning && room.burning && settings.notifyBurnStarted) {
      showBrowserNotification('开始烧录', `${name} 正在生成弹幕版`);
    }
    if (oldRoom.burning && !room.burning && settings.notifyBurnEnded) {
      showBrowserNotification('烧录完成', `${name} 弹幕版已处理完成`);
    }
  }
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
