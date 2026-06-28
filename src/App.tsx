import { useEffect, useMemo, useState } from 'react';
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
  Home,
  ListVideo,
  LogIn,
  MessageSquareText,
  MonitorDot,
  Play,
  Plus,
  Power,
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
import { recorder } from './recorderClient';

type Page = 'overview' | 'rooms' | 'settings' | 'logs';

const pages: Array<{ id: Page; label: string; icon: React.ReactNode }> = [
  { id: 'overview', label: '总览', icon: <Home size={20} /> },
  { id: 'rooms', label: '直播间', icon: <ListVideo size={20} /> },
  { id: 'settings', label: '设置', icon: <Settings2 size={20} /> },
  { id: 'logs', label: '日志', icon: <MessageSquareText size={20} /> }
];

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
  const [page, setPage] = useState<Page>('overview');
  const [state, setState] = useState<AppState | null>(null);
  const [settingsDraft, setSettingsDraft] = useState<AppSettings | null>(null);
  const [roomInput, setRoomInput] = useState('');
  const [busy, setBusy] = useState<string | null>(null);

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

  const stats = useMemo(() => getStats(state?.rooms ?? []), [state?.rooms]);

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
    setPage('rooms');
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
        <Activity className="spin" size={30} />
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

        <nav className="page-nav">
          {pages.map((item) => (
            <button
              key={item.id}
              className={page === item.id ? 'nav-button active' : 'nav-button'}
              onClick={() => setPage(item.id)}
            >
              {item.icon}
              <span>{item.label}</span>
            </button>
          ))}
        </nav>

        <section className="nav-section compact">
          <div className="section-title">
            <Gauge size={18} />
            <span>当前状态</span>
          </div>
          <div className="side-metrics">
            <Metric icon={<Radio size={19} />} label="直播" value={stats.live} />
            <Metric icon={<Video size={19} />} label="录制" value={stats.recording} />
            <Metric icon={<MonitorDot size={19} />} label="监听" value={stats.monitoring} />
            <Metric icon={<Sparkles size={19} />} label="烧录" value={stats.burning} />
          </div>
        </section>
      </aside>

      <section className="workspace-panel">
        {page === 'overview' ? (
          <OverviewPage state={state} stats={stats} setPage={setPage} run={run} />
        ) : null}
        {page === 'rooms' ? (
          <RoomsPage
            rooms={state.rooms}
            roomInput={roomInput}
            setRoomInput={setRoomInput}
            addRoom={addRoom}
            busy={busy}
            run={run}
          />
        ) : null}
        {page === 'settings' ? (
          <SettingsPage
            state={state}
            settingsDraft={settingsDraft}
            busy={busy}
            run={run}
            chooseOutputDir={chooseOutputDir}
            setSettingsDraft={setSettingsDraft}
          />
        ) : null}
        {page === 'logs' ? <LogsPage logs={state.logs} busy={busy} run={run} /> : null}
      </section>

      {state.login ? <QrLoginPanel login={state.login} busy={busy} run={run} /> : null}
    </main>
  );
}

function OverviewPage({
  state,
  stats,
  setPage,
  run
}: {
  state: AppState;
  stats: ReturnType<typeof getStats>;
  setPage: (page: Page) => void;
  run: <T>(key: string, action: () => Promise<T>) => Promise<void>;
}) {
  const activeRooms = state.rooms.filter((room) => room.liveStatus === 1 || room.recording);

  return (
    <>
      <PageHeader
        title="总览"
        subtitle={`${state.settings.outputContainer.toUpperCase()} · ${
          state.settings.preferHevc ? 'H.265 优先' : 'H.264 优先'
        } · 清晰度 ${state.settings.targetQn}`}
        actions={
          <>
            <button className="wide-button" onClick={() => run('open-output', recorder.openOutputDir)}>
              <HardDrive size={18} />
              打开目录
            </button>
            <button className="wide-button primary" onClick={() => setPage('rooms')}>
              <Plus size={18} />
              添加直播间
            </button>
          </>
        }
      />

      <section className="overview-grid">
        <BigMetric icon={<ListVideo size={22} />} label="直播间" value={stats.rooms} />
        <BigMetric icon={<Radio size={22} />} label="直播中" value={stats.live} />
        <BigMetric icon={<Video size={22} />} label="录制中" value={stats.recording} />
        <BigMetric icon={<MessageSquareText size={22} />} label="弹幕事件" value={stats.events} />
      </section>

      <section className="panel-band">
        <div className="band-heading">
          <div className="section-title">
            <MonitorDot size={18} />
            <span>活动直播间</span>
          </div>
        </div>
        {activeRooms.length === 0 ? (
          <div className="empty-state compact-empty">暂无活动直播间</div>
        ) : (
          <div className="room-grid overview-rooms">
            {activeRooms.map((room) => (
              <RoomCard key={room.id} room={room} busy={null} run={run} />
            ))}
          </div>
        )}
      </section>
    </>
  );
}

function RoomsPage({
  rooms,
  roomInput,
  setRoomInput,
  addRoom,
  busy,
  run
}: {
  rooms: RoomState[];
  roomInput: string;
  setRoomInput: (value: string) => void;
  addRoom: () => Promise<void>;
  busy: string | null;
  run: <T>(key: string, action: () => Promise<T>) => Promise<void>;
}) {
  return (
    <>
      <PageHeader
        title="直播间"
        subtitle={`${rooms.length} 个房间`}
        actions={
          <div className="add-room page-add-room">
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
              className="wide-button primary"
              disabled={busy === 'add-room'}
              onClick={addRoom}
            >
              <Plus size={18} />
              添加
            </button>
          </div>
        }
      />

      <section className="room-grid">
        {rooms.length === 0 ? (
          <div className="empty-state">
            <Radio size={38} />
            <span>暂无直播间</span>
          </div>
        ) : (
          rooms.map((room) => <RoomCard key={room.id} room={room} busy={busy} run={run} />)
        )}
      </section>
    </>
  );
}

function SettingsPage({
  state,
  settingsDraft,
  busy,
  run,
  chooseOutputDir,
  setSettingsDraft
}: {
  state: AppState;
  settingsDraft: AppSettings;
  busy: string | null;
  run: <T>(key: string, action: () => Promise<T>) => Promise<void>;
  chooseOutputDir: () => Promise<void>;
  setSettingsDraft: (settings: AppSettings) => void;
}) {
  const loggedIn = settingsDraft.cookie.includes('SESSDATA=');
  const hasActiveJobs = state.rooms.some((room) => room.recording || room.burning);

  return (
    <>
      <PageHeader
        title="设置"
        subtitle={state.startupEnabled ? '开机自启已开启' : '开机自启未开启'}
        actions={
          <button
            className="wide-button primary"
            disabled={busy === 'save-settings'}
            onClick={() => run('save-settings', () => recorder.saveSettings(settingsDraft))}
          >
            <Save size={18} />
            保存设置
          </button>
        }
      />

      <section className="settings-page-grid">
        <SettingPanel title="账号登录" icon={<LogIn size={18} />}>
          <div className="setting-row">
            <span className={loggedIn ? 'badge on' : 'badge'}>{loggedIn ? '已登录' : '未登录'}</span>
            <button
              className="wide-button primary"
              disabled={busy === 'qr-login'}
              onClick={() => run('qr-login', recorder.startQrLogin)}
            >
              <QrCode size={18} />
              扫码登录
            </button>
          </div>
          <label className="field">
            <span>登录凭证</span>
            <textarea
              rows={4}
              value={settingsDraft.cookie}
              onChange={(event) => setSettingsDraft({ ...settingsDraft, cookie: event.target.value })}
              placeholder="扫码成功后自动写入"
            />
          </label>
          {state.login ? <p className="inline-status">{state.login.message}</p> : null}
        </SettingPanel>

        <SettingPanel title="录制参数" icon={<Video size={18} />}>
          <label className="field">
            <span>输出目录</span>
            <div className="path-row">
              <input
                value={settingsDraft.outputDir}
                onChange={(event) => setSettingsDraft({ ...settingsDraft, outputDir: event.target.value })}
              />
              <button className="icon-button" title="输入目录" onClick={chooseOutputDir}>
                <FolderOpen size={18} />
              </button>
              <button className="icon-button" title="打开目录" onClick={() => run('open-output', recorder.openOutputDir)}>
                <HardDrive size={18} />
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

          <div className="settings-grid">
            <label className="field">
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
            <div className="toggle-list inline-toggles">
              <Toggle
                label="H.265 优先"
                checked={settingsDraft.preferHevc}
                onChange={(checked) => setSettingsDraft({ ...settingsDraft, preferHevc: checked })}
              />
              <Toggle
                label="自动生成弹幕版"
                checked={settingsDraft.autoBurnDanmaku}
                onChange={(checked) => setSettingsDraft({ ...settingsDraft, autoBurnDanmaku: checked })}
              />
            </div>
          </div>
        </SettingPanel>

        <SettingPanel title="启动和通知" icon={<Bell size={18} />}>
          <div className="toggle-list">
            <Toggle
              label="开机自启"
              checked={state.startupEnabled}
              disabled={busy === 'startup'}
              onChange={(checked) => run('startup', () => recorder.setStartup(checked))}
            />
            <Toggle
              label="启动时打开浏览器"
              checked={settingsDraft.openBrowserOnStart}
              onChange={(checked) => setSettingsDraft({ ...settingsDraft, openBrowserOnStart: checked })}
            />
            <label className="field">
              <span>服务端口（重启生效）</span>
              <input
                type="number"
                min={1}
                max={65535}
                value={settingsDraft.serverPort}
                onChange={(event) =>
                  setSettingsDraft({ ...settingsDraft, serverPort: Number(event.target.value) })
                }
              />
            </label>
            <Toggle
              label="开播通知"
              checked={settingsDraft.notifyLiveStarted}
              onChange={(checked) => setSettingsDraft({ ...settingsDraft, notifyLiveStarted: checked })}
            />
            <Toggle
              label="下播通知"
              checked={settingsDraft.notifyLiveEnded}
              onChange={(checked) => setSettingsDraft({ ...settingsDraft, notifyLiveEnded: checked })}
            />
            <Toggle
              label="开始录制通知"
              checked={settingsDraft.notifyRecordingStarted}
              onChange={(checked) => setSettingsDraft({ ...settingsDraft, notifyRecordingStarted: checked })}
            />
            <Toggle
              label="结束录制通知"
              checked={settingsDraft.notifyRecordingEnded}
              onChange={(checked) => setSettingsDraft({ ...settingsDraft, notifyRecordingEnded: checked })}
            />
            <Toggle
              label="开始烧录通知"
              checked={settingsDraft.notifyBurnStarted}
              onChange={(checked) => setSettingsDraft({ ...settingsDraft, notifyBurnStarted: checked })}
            />
            <Toggle
              label="烧录完成通知"
              checked={settingsDraft.notifyBurnEnded}
              onChange={(checked) => setSettingsDraft({ ...settingsDraft, notifyBurnEnded: checked })}
            />
          </div>
          <div className="split-buttons">
            <button
              className="wide-button fill"
              type="button"
              onClick={() => run('test-notification', recorder.testNotification)}
            >
              <Bell size={18} />
              测试 Windows 通知
            </button>
            <button
              className="wide-button fill primary"
              type="button"
              onClick={() => run('save-settings', () => recorder.saveSettings(settingsDraft))}
            >
              <Save size={18} />
              保存通知设置
            </button>
          </div>
        </SettingPanel>

        <SettingPanel title="运行路径" icon={<HardDrive size={18} />}>
          <PathLine label="当前端口" value={String(state.currentPort || '')} />
          <PathLine label="应用目录" value={state.appRoot || ''} />
          <PathLine label="网页目录" value={state.distRoot || ''} />
          <PathLine label="ffmpeg" value={state.ffmpegPath || ''} />
          <button
            className="wide-button fill danger"
            type="button"
            disabled={busy === 'shutdown'}
            onClick={() => {
              const message = hasActiveJobs
                ? '当前有录制或烧录任务，确定退出后台服务？'
                : '确定退出后台服务？';
              if (window.confirm(message)) {
                run('shutdown', recorder.shutdown);
              }
            }}
          >
            <Power size={18} />
            退出后台服务
          </button>
        </SettingPanel>
      </section>
    </>
  );
}

function LogsPage({
  logs,
  busy,
  run
}: {
  logs: LogEntry[];
  busy: string | null;
  run: <T>(key: string, action: () => Promise<T>) => Promise<void>;
}) {
  return (
    <>
      <PageHeader
        title="日志"
        subtitle={`${logs.length} 条记录`}
        actions={
          <button
            className="wide-button"
            disabled={busy === 'clear-logs'}
            onClick={() => run('clear-logs', recorder.clearLogs)}
          >
            清空
          </button>
        }
      />
      <section className="log-panel full-log-panel">
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
    </>
  );
}

function PageHeader({
  title,
  subtitle,
  actions
}: {
  title: string;
  subtitle?: string;
  actions?: React.ReactNode;
}) {
  return (
    <header className="workspace-header">
      <div>
        <h2>{title}</h2>
        {subtitle ? <p>{subtitle}</p> : null}
      </div>
      {actions ? <div className="header-actions">{actions}</div> : null}
    </header>
  );
}

function SettingPanel({
  title,
  icon,
  children
}: {
  title: string;
  icon: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="inspector-card settings-panel">
      <div className="card-heading">
        <div className="section-title">
          {icon}
          <span>{title}</span>
        </div>
      </div>
      {children}
    </section>
  );
}

function Toggle({
  label,
  checked,
  disabled,
  onChange
}: {
  label: string;
  checked: boolean;
  disabled?: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label className="toggle-row">
      <span>{label}</span>
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.target.checked)}
      />
    </label>
  );
}

function PathLine({ label, value }: { label: string; value: string }) {
  return (
    <div className="path-line">
      <span>{label}</span>
      <p title={value}>{value || '-'}</p>
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
        {room.cover ? <img src={room.cover} alt="" /> : <Radio size={32} />}
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
            <Trash2 size={18} />
          </button>
        </div>

        <div className="badge-row">
          <span className={room.monitoring ? 'badge on' : 'badge'}>监听</span>
          <span className={room.recording ? 'badge hot' : 'badge'}>录制</span>
          <span className={room.burning ? 'badge work' : 'badge'}>弹幕版</span>
        </div>

        <div className="room-meta">
          <span>
            <Clock3 size={15} />
            {room.lastCheckedAt ? formatClock(room.lastCheckedAt) : '未刷新'}
          </span>
          <span>
            <Cpu size={15} />
            {streamText}
          </span>
        </div>

        {room.currentRecording ? (
          <div className="recording-info">
            <span>
              <MessageSquareText size={15} />
              弹幕事件 {room.currentRecording.eventCount}
            </span>
            <span title={room.currentRecording.cleanPath}>
              <FileVideo size={15} />
              {filename(room.currentRecording.cleanPath)}
            </span>
          </div>
        ) : null}

        {room.lastError ? (
          <div className="error-line">
            <CircleAlert size={16} />
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
            <RefreshCw size={18} />
          </button>
          <button
            className={room.monitoring ? 'wide-button active' : 'wide-button'}
            disabled={busy === `monitor-${roomKey}`}
            onClick={() =>
              run(`monitor-${roomKey}`, () => recorder.setMonitoring(room.id, !room.monitoring))
            }
          >
            <MonitorDot size={18} />
            {room.monitoring ? '监听中' : '监听'}
          </button>
          {room.recording ? (
            <button
              className="wide-button danger"
              disabled={busy === `stop-${roomKey}`}
              onClick={() => run(`stop-${roomKey}`, () => recorder.stopRecording(room.id))}
            >
              <Square size={17} />
              停止
            </button>
          ) : (
            <button
              className="wide-button primary"
              disabled={busy === `record-${roomKey}`}
              onClick={() => run(`record-${roomKey}`, () => recorder.startRecording(room.id))}
            >
              <Play size={17} />
              录制
            </button>
          )}
          <button
            className="icon-button"
            title="生成弹幕版"
            disabled={!room.currentRecording || room.recording || room.burning}
            onClick={() => run(`burn-${roomKey}`, () => recorder.burnDanmaku(room.id))}
          >
            <Sparkles size={18} />
          </button>
        </div>
      </div>
    </article>
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
            <X size={18} />
          </button>
        </div>
        <div className={`qr-box ${login.status}`}>
          {login.qrImageDataUrl ? (
            <img src={login.qrImageDataUrl} alt="哔哩哔哩登录二维码" />
          ) : (
            <QrCode size={74} />
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
              <RefreshCw size={17} />
              重新生成
            </button>
          ) : null}
        </div>
      </div>
    </div>
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

function BigMetric({ icon, label, value }: { icon: React.ReactNode; label: string; value: number }) {
  return (
    <div className="big-metric">
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

function getStats(rooms: RoomState[]) {
  return {
    rooms: rooms.length,
    live: rooms.filter((room) => room.liveStatus === 1).length,
    monitoring: rooms.filter((room) => room.monitoring).length,
    recording: rooms.filter((room) => room.recording).length,
    burning: rooms.filter((room) => room.burning).length,
    events: rooms.reduce((sum, room) => sum + (room.currentRecording?.eventCount ?? 0), 0)
  };
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

function isAppState(value: unknown): value is AppState {
  return Boolean(
    value &&
      typeof value === 'object' &&
      'settings' in value &&
      'rooms' in value &&
      'logs' in value
  );
}
