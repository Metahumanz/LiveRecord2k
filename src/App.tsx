import { useEffect, useMemo, useState } from 'react';
import {
  Activity,
  Bell,
  CircleAlert,
  Clock3,
  Cpu,
  CheckCircle2,
  Download,
  FileVideo,
  FileCode2,
  FolderOpen,
  Gauge,
  HardDrive,
  Home,
  Image as ImageIcon,
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
  Scissors,
  Settings2,
  Sparkles,
  Square,
  Trash2,
  Video,
  X
} from 'lucide-react';
import type { AppSettings, AppState, ExportResult, LogEntry, RecordingState, RoomState } from './vite-env';
import { recorder } from './recorderClient';
import changelogText from '../CHANGELOG.md?raw';

type Page = 'overview' | 'rooms' | 'export' | 'settings' | 'logs';

type ExportDraft = {
  cleanPath: string;
  danmakuPath: string;
  cssPath: string;
  startTime: string;
  endTime: string;
  mode: 'clean' | 'burn';
  overlayMode: AppSettings['burnOverlayMode'];
  outputDir: string;
};

const pages: Array<{ id: Page; label: string; icon: React.ReactNode }> = [
  { id: 'overview', label: '总览', icon: <Home size={20} /> },
  { id: 'rooms', label: '直播间', icon: <ListVideo size={20} /> },
  { id: 'export', label: '剪辑', icon: <Scissors size={20} /> },
  { id: 'settings', label: '设置', icon: <Settings2 size={20} /> },
  { id: 'logs', label: '日志', icon: <MessageSquareText size={20} /> }
];

const qnOptions = [
  { label: '4K / 超高清优先', value: 25000 },
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

const overlayModeOptions = [
  { label: '仅弹幕', value: 'danmaku' },
  { label: '弹幕和礼物', value: 'danmaku-gift' }
] as const;

const exportModeOptions = [
  { label: '纯净片段', value: 'clean' },
  { label: '烧录片段', value: 'burn' }
] as const;

const changelogEntries = parseChangelog(changelogText);

export default function App() {
  const [page, setPage] = useState<Page>('overview');
  const [state, setState] = useState<AppState | null>(null);
  const [settingsDraft, setSettingsDraft] = useState<AppSettings | null>(null);
  const [roomInput, setRoomInput] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [exportDraft, setExportDraft] = useState<ExportDraft>({
    cleanPath: '',
    danmakuPath: '',
    cssPath: '',
    startTime: '00:00:00',
    endTime: '',
    mode: 'clean',
    overlayMode: 'danmaku-gift',
    outputDir: ''
  });
  const [exportResult, setExportResult] = useState<ExportResult | null>(null);

  useEffect(() => {
    recorder.getInitialState().then((nextState) => {
      setState(nextState);
      setSettingsDraft(nextState.settings);
      setExportDraft((current) => hydrateExportDraft(current, nextState));
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
      setExportDraft((current) => hydrateExportDraft(current, nextState));
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

  async function changeRoomImageMode(mode: AppSettings['roomImageMode']) {
    if (!state || state.settings.roomImageMode === mode) {
      return;
    }
    await run('image-mode', () => recorder.saveSettings({ roomImageMode: mode }));
  }

  function selectExportRecording(recording: RecordingState) {
    setExportResult(null);
    setExportDraft((current) => ({
      ...current,
      cleanPath: recording.cleanPath,
      danmakuPath: recording.danmakuPath || '',
      cssPath: recording.cssPath || '',
      overlayMode: state?.settings.burnOverlayMode || current.overlayMode,
      outputDir: current.outputDir || state?.settings.outputDir || ''
    }));
  }

  async function prepareExportSubtitles() {
    setBusy('export-subtitles');
    try {
      const result = await recorder.prepareSubtitleAssets({
        cleanPath: exportDraft.cleanPath,
        danmakuPath: exportDraft.danmakuPath,
        cssPath: exportDraft.cssPath,
        startTime: exportDraft.startTime,
        endTime: exportDraft.endTime,
        overlayMode: exportDraft.overlayMode,
        outputDir: exportDraft.outputDir
      });
      setExportResult(result);
    } finally {
      setBusy(null);
    }
  }

  async function exportClip() {
    setBusy('export-clip');
    try {
      const result = await recorder.exportClip({
        mode: exportDraft.mode,
        cleanPath: exportDraft.cleanPath,
        danmakuPath: exportDraft.danmakuPath,
        cssPath: exportDraft.cssPath,
        startTime: exportDraft.startTime,
        endTime: exportDraft.endTime,
        overlayMode: exportDraft.overlayMode,
        outputDir: exportDraft.outputDir
      });
      setExportResult(result);
    } finally {
      setBusy(null);
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
          <OverviewPage state={state} stats={stats} busy={busy} setPage={setPage} run={run} />
        ) : null}
        {page === 'rooms' ? (
          <RoomsPage
            rooms={state.rooms}
            roomImageMode={state.settings.roomImageMode}
            burnOverlayMode={state.settings.burnOverlayMode}
            onRoomImageModeChange={changeRoomImageMode}
            roomInput={roomInput}
            setRoomInput={setRoomInput}
            addRoom={addRoom}
            busy={busy}
            run={run}
          />
        ) : null}
        {page === 'export' ? (
          <ExportPage
            state={state}
            draft={exportDraft}
            result={exportResult}
            busy={busy}
            setDraft={setExportDraft}
            selectRecording={selectExportRecording}
            prepareSubtitles={prepareExportSubtitles}
            exportClip={exportClip}
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
  busy,
  setPage,
  run
}: {
  state: AppState;
  stats: ReturnType<typeof getStats>;
  busy: string | null;
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
        } · 清晰度 ${state.settings.targetQn} · ${state.settings.segmentMinutes} 分钟分段`}
        actions={
          <>
            <button
              className="wide-button"
              disabled={busy === 'update-check'}
              onClick={() => run('update-check', recorder.checkUpdate)}
            >
              <RefreshCw size={18} />
              检查更新
            </button>
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

      <UpdateNotice state={state} stats={stats} busy={busy} run={run} />

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
              <RoomCard
                key={room.id}
                room={room}
                roomImageMode={state.settings.roomImageMode}
                burnOverlayMode={state.settings.burnOverlayMode}
                busy={null}
                run={run}
              />
            ))}
          </div>
        )}
      </section>
    </>
  );
}

function UpdateNotice({
  state,
  stats,
  busy,
  run
}: {
  state: AppState;
  stats: ReturnType<typeof getStats>;
  busy: string | null;
  run: <T>(key: string, action: () => Promise<T>) => Promise<void>;
}) {
  const update = state.update;
  if (!update || update.status === 'idle') {
    return null;
  }

  const activeJobs = stats.recording > 0 || stats.burning > 0;
  const busyUpdating = ['checking', 'downloading', 'ready', 'applying'].includes(update.status);
  const canInstall = update.status === 'available' || update.status === 'blocked';
  const showQueue = canInstall && activeJobs;
  const kind =
    update.status === 'error' || update.status === 'blocked'
      ? 'error'
      : update.status === 'up-to-date'
        ? 'ok'
        : update.status === 'queued'
          ? 'queued'
          : 'available';

  return (
    <section className={`update-notice ${kind}`}>
      <div className="update-copy">
        {update.status === 'up-to-date' ? <CheckCircle2 size={20} /> : <Download size={20} />}
        <div>
          <strong>{updateTitle(update.status)}</strong>
          <p>
            {update.message}
            {update.latestVersion ? ` · 当前 ${update.currentVersion}` : ''}
          </p>
        </div>
      </div>
      <div className="update-actions">
        {showQueue ? (
          <button
            className="wide-button active"
            disabled={busy === 'update-queue'}
            onClick={() => run('update-queue', recorder.queueUpdate)}
          >
            <Clock3 size={18} />
            录制结束后更新
          </button>
        ) : null}
        {canInstall && !activeJobs ? (
          <button
            className="wide-button primary"
            disabled={busy === 'update-apply'}
            onClick={() => run('update-apply', recorder.applyUpdate)}
          >
            <Download size={18} />
            立即更新
          </button>
        ) : null}
        {update.status === 'error' ? (
          <button
            className="wide-button"
            disabled={busy === 'update-check'}
            onClick={() => run('update-check', recorder.checkUpdate)}
          >
            <RefreshCw size={18} />
            重试
          </button>
        ) : null}
        {update.status === 'queued' ? <span className="update-waiting">等待任务结束</span> : null}
        {busyUpdating ? <span className="update-waiting">处理中</span> : null}
      </div>
    </section>
  );
}

function updateTitle(status: AppState['update']['status']) {
  if (status === 'available') return '有新版本';
  if (status === 'queued') return '更新已排队';
  if (status === 'checking') return '正在检查更新';
  if (status === 'downloading') return '正在下载更新';
  if (status === 'ready' || status === 'applying') return '正在应用更新';
  if (status === 'up-to-date') return '已是最新';
  if (status === 'blocked') return '暂不更新';
  if (status === 'error') return '更新失败';
  return '更新';
}

function RoomsPage({
  rooms,
  roomImageMode,
  burnOverlayMode,
  onRoomImageModeChange,
  roomInput,
  setRoomInput,
  addRoom,
  busy,
  run
}: {
  rooms: RoomState[];
  roomImageMode: AppSettings['roomImageMode'];
  burnOverlayMode: AppSettings['burnOverlayMode'];
  onRoomImageModeChange: (mode: AppSettings['roomImageMode']) => Promise<void>;
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
          <div className="rooms-toolbar">
            <ImageModeSwitch
              value={roomImageMode}
              busy={busy === 'image-mode'}
              onChange={onRoomImageModeChange}
            />
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
          rooms.map((room) => (
            <RoomCard
              key={room.id}
              room={room}
              roomImageMode={roomImageMode}
              burnOverlayMode={burnOverlayMode}
              busy={busy}
              run={run}
            />
          ))
        )}
      </section>
    </>
  );
}

function ImageModeSwitch({
  value,
  busy,
  onChange
}: {
  value: AppSettings['roomImageMode'];
  busy: boolean;
  onChange: (mode: AppSettings['roomImageMode']) => Promise<void>;
}) {
  return (
    <div className="preview-switch" aria-label="卡片画面模式">
      <button
        className={value === 'cover' ? 'active' : ''}
        disabled={busy}
        onClick={() => onChange('cover')}
        title="卡片只显示直播间封面"
      >
        <ImageIcon size={17} />
        <span>封面</span>
      </button>
      <button
        className={value === 'keyframe' ? 'active' : ''}
        disabled={busy}
        onClick={() => onChange('keyframe')}
        title="卡片显示 B 站实时关键帧"
      >
        <MonitorDot size={17} />
        <span>实时画面</span>
      </button>
    </div>
  );
}

function ExportPage({
  state,
  draft,
  result,
  busy,
  setDraft,
  selectRecording,
  prepareSubtitles,
  exportClip,
  run
}: {
  state: AppState;
  draft: ExportDraft;
  result: ExportResult | null;
  busy: string | null;
  setDraft: (draft: ExportDraft) => void;
  selectRecording: (recording: RecordingState) => void;
  prepareSubtitles: () => Promise<void>;
  exportClip: () => Promise<void>;
  run: <T>(key: string, action: () => Promise<T>) => Promise<void>;
}) {
  const recordings = state.recordings.filter((recording) => recording.valid !== false && recording.cleanPath);
  const selectedRecording = recordings.find((recording) => recording.cleanPath === draft.cleanPath);
  const [mediaDuration, setMediaDuration] = useState(0);
  const draftStart = parseTimelineInput(draft.startTime);
  const draftEnd = parseTimelineInput(draft.endTime);
  const timelineDuration = Math.max(mediaDuration, Number(selectedRecording?.durationSec || 0));
  const timelineStart = Number.isFinite(draftStart) ? clampNumber(draftStart, 0, Math.max(timelineDuration, draftStart)) : 0;
  const timelineEnd = Number.isFinite(draftEnd)
    ? clampNumber(draftEnd, 0, Math.max(timelineDuration, draftEnd))
    : timelineDuration;
  const canUseTimeline = timelineDuration > 0;
  const canExport = Boolean(draft.cleanPath && Number.isFinite(draftStart) && Number.isFinite(draftEnd) && draftEnd > draftStart);
  const canPrepare = Boolean(draft.cleanPath && draft.danmakuPath);
  const mediaSource = draft.cleanPath ? mediaUrl(draft.cleanPath) : '';

  useEffect(() => {
    setMediaDuration(0);
  }, [draft.cleanPath]);

  function updateTimelineStart(value: number) {
    const next = clampNumber(value, 0, Math.max(0, timelineEnd - 0.1));
    setDraft({ ...draft, startTime: formatTimelineTime(next) });
  }

  function updateTimelineEnd(value: number) {
    const next = clampNumber(value, Math.min(timelineStart + 0.1, timelineDuration || value), timelineDuration || value);
    setDraft({ ...draft, endTime: formatTimelineTime(next) });
  }

  return (
    <>
      <PageHeader
        title="剪辑导出"
        subtitle="选择历史录像，拖动时间轴，导出纯净或烧录片段"
        actions={
          <>
            <button
              className="wide-button"
              disabled={busy === 'scan-recordings'}
              onClick={() => run('scan-recordings', recorder.scanRecordings)}
            >
              <RefreshCw size={18} />
              刷新历史
            </button>
            <button className="wide-button" onClick={() => run('open-output', recorder.openOutputDir)}>
              <FolderOpen size={18} />
              打开目录
            </button>
          </>
        }
      />

      <section className="export-layout">
        <section className="inspector-card export-panel">
          <div className="card-heading">
            <div className="section-title">
              <FileVideo size={18} />
              <span>源文件</span>
            </div>
          </div>

          <div className="recording-list">
            {recordings.length === 0 ? (
              <div className="empty-state compact-empty export-empty">输出目录里还没有可用源文件</div>
            ) : (
              recordings.map((recording) => (
                <button
                  key={recording.id || recording.cleanPath}
                  className={recording.cleanPath === draft.cleanPath ? 'recording-row active' : 'recording-row'}
                  type="button"
                  onClick={() => selectRecording(recording)}
                >
                  <span>{recordingLabel(recording)}</span>
                  <small>
                    {filename(recording.cleanPath)}
                    {recording.fileSize ? ` · ${formatFileSize(recording.fileSize)}` : ''}
                  </small>
                </button>
              ))
            )}
          </div>

          <label className="field">
            <span>纯净视频</span>
            <input
              value={draft.cleanPath}
              onChange={(event) => setDraft({ ...draft, cleanPath: event.target.value })}
              placeholder="C:\Videos\xxx.clean.mp4"
            />
          </label>

          <label className="field">
            <span>弹幕事件</span>
            <input
              value={draft.danmakuPath}
              onChange={(event) => setDraft({ ...draft, danmakuPath: event.target.value })}
              placeholder="C:\Videos\xxx.danmaku.jsonl"
            />
          </label>

          <label className="field">
            <span>样式 CSS</span>
            <input
              value={draft.cssPath}
              onChange={(event) => setDraft({ ...draft, cssPath: event.target.value })}
              placeholder="留空则自动生成 .danmaku.css"
            />
          </label>
        </section>

        <section className="inspector-card export-panel">
          <div className="card-heading">
            <div className="section-title">
              <Scissors size={18} />
              <span>片段</span>
            </div>
          </div>

          <div className="clip-preview">
            {mediaSource ? (
              <video
                key={draft.cleanPath}
                src={mediaSource}
                controls
                preload="metadata"
                onLoadedMetadata={(event) => {
                  const duration = event.currentTarget.duration;
                  if (!Number.isFinite(duration) || duration <= 0) {
                    return;
                  }
                  setMediaDuration(duration);
                  if (!draft.endTime || !Number.isFinite(parseTimelineInput(draft.endTime))) {
                    setDraft({ ...draft, endTime: formatTimelineTime(duration) });
                  }
                }}
              />
            ) : (
              <div className="clip-preview-empty">
                <FileVideo size={38} />
                <span>选择录像后预览</span>
              </div>
            )}
          </div>

          <div className="timeline-editor">
            <div className="timeline-labels">
              <span>{formatTimelineTime(timelineStart)}</span>
              <strong>{formatTimelineTime(Math.max(0, timelineEnd - timelineStart))}</strong>
              <span>{formatTimelineTime(timelineEnd)}</span>
            </div>
            <div className="range-stack">
              <input
                type="range"
                min={0}
                max={Math.max(1, timelineDuration)}
                step={0.1}
                value={Math.min(timelineStart, Math.max(1, timelineDuration))}
                disabled={!canUseTimeline}
                onChange={(event) => updateTimelineStart(Number(event.target.value))}
              />
              <input
                type="range"
                min={0}
                max={Math.max(1, timelineDuration)}
                step={0.1}
                value={Math.min(timelineEnd || timelineDuration, Math.max(1, timelineDuration))}
                disabled={!canUseTimeline}
                onChange={(event) => updateTimelineEnd(Number(event.target.value))}
              />
            </div>
          </div>

          <div className="time-grid">
            <label className="field">
              <span>开始时间</span>
              <input
                value={draft.startTime}
                onChange={(event) => setDraft({ ...draft, startTime: event.target.value })}
                placeholder="00:12:30.5"
              />
            </label>
            <label className="field">
              <span>结束时间</span>
              <input
                value={draft.endTime}
                onChange={(event) => setDraft({ ...draft, endTime: event.target.value })}
                placeholder="00:18:00"
              />
            </label>
          </div>

          <label className="field">
            <span>输出目录</span>
            <input
              value={draft.outputDir}
              onChange={(event) => setDraft({ ...draft, outputDir: event.target.value })}
              placeholder={state.settings.outputDir}
            />
          </label>

          <div className="settings-grid">
            <label className="field">
              <span>导出版本</span>
              <select
                value={draft.mode}
                onChange={(event) => setDraft({ ...draft, mode: event.target.value as ExportDraft['mode'] })}
              >
                {exportModeOptions.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </label>

            <label className="field">
              <span>烧录内容</span>
              <select
                value={draft.overlayMode}
                onChange={(event) =>
                  setDraft({ ...draft, overlayMode: event.target.value as AppSettings['burnOverlayMode'] })
                }
              >
                {overlayModeOptions.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </label>
          </div>

          <div className="split-buttons export-actions">
            <button
              className="wide-button fill"
              disabled={!canPrepare || busy === 'export-subtitles'}
              onClick={prepareSubtitles}
            >
              <FileCode2 size={18} />
              只生成字幕
            </button>
            <button
              className="wide-button fill primary"
              disabled={!canExport || busy === 'export-clip'}
              onClick={exportClip}
            >
              <Scissors size={18} />
              导出片段
            </button>
          </div>
        </section>

        <section className="inspector-card export-panel export-result-panel">
          <div className="card-heading">
            <div className="section-title">
              <CheckCircle2 size={18} />
              <span>结果</span>
            </div>
          </div>
          {result ? (
            <div className="result-lines">
              <PathLine label="输出视频" value={result.outputPath || ''} />
              <PathLine label="样式 CSS" value={result.cssPath || ''} />
              <PathLine label="字幕 ASS" value={result.assPath || ''} />
              {typeof result.eventCount === 'number' ? (
                <PathLine label="事件数量" value={String(result.eventCount)} />
              ) : null}
            </div>
          ) : (
            <div className="empty-state compact-empty">
              <Scissors size={36} />
              <span>选择录像和时间段后开始导出</span>
            </div>
          )}
        </section>
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

            <label className="field">
              <span>分段时长（分钟）</span>
              <input
                type="number"
                min={1}
                max={1440}
                value={settingsDraft.segmentMinutes}
                onChange={(event) =>
                  setSettingsDraft({ ...settingsDraft, segmentMinutes: Number(event.target.value) })
                }
              />
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

            <label className="field">
              <span>弹幕版内容</span>
              <select
                value={settingsDraft.burnOverlayMode}
                onChange={(event) =>
                  setSettingsDraft({
                    ...settingsDraft,
                    burnOverlayMode: event.target.value as AppSettings['burnOverlayMode']
                  })
                }
              >
                {overlayModeOptions.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
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
                label="默认实时画面"
                checked={settingsDraft.roomImageMode === 'keyframe'}
                onChange={(checked) =>
                  setSettingsDraft({ ...settingsDraft, roomImageMode: checked ? 'keyframe' : 'cover' })
                }
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

        <SettingPanel title="版本更新" icon={<Download size={18} />}>
          <PathLine label="当前版本" value={state.version || '-'} />
          <PathLine label="最新版本" value={state.update.latestVersion || '尚未检查'} />
          <PathLine label="更新状态" value={state.update.message || '尚未检查更新'} />
          <div className="split-buttons">
            <button
              className="wide-button fill"
              type="button"
              disabled={busy === 'update-check'}
              onClick={() => run('update-check', recorder.checkUpdate)}
            >
              <RefreshCw size={18} />
              检查更新
            </button>
            {state.update.status === 'available' || state.update.status === 'blocked' ? (
              hasActiveJobs ? (
                <button
                  className="wide-button fill active"
                  type="button"
                  disabled={busy === 'update-queue'}
                  onClick={() => run('update-queue', recorder.queueUpdate)}
                >
                  <Clock3 size={18} />
                  录制结束后更新
                </button>
              ) : (
                <button
                  className="wide-button fill primary"
                  type="button"
                  disabled={busy === 'update-apply'}
                  onClick={() => run('update-apply', recorder.applyUpdate)}
                >
                  <Download size={18} />
                  立即更新
                </button>
              )
            ) : null}
          </div>
          <details className="changelog-box">
            <summary>更新日志</summary>
            <div className="changelog-list">
              {changelogEntries.map((entry) => (
                <article key={entry.version}>
                  <h4>{entry.version}</h4>
                  <ul>
                    {entry.items.map((item, index) => (
                      <li key={`${entry.version}-${index}`}>{item}</li>
                    ))}
                  </ul>
                </article>
              ))}
            </div>
          </details>
        </SettingPanel>

        <SettingPanel title="运行路径" icon={<HardDrive size={18} />}>
          <PathLine label="当前版本" value={state.version || ''} />
          <PathLine label="当前端口" value={String(state.currentPort || '')} />
          <PathLine label="配置文件" value={state.storePath || ''} />
          <PathLine label="应用目录" value={state.appRoot || ''} />
          <PathLine label="网页目录" value={state.distRoot || ''} />
          <PathLine label="ffmpeg" value={state.ffmpegPath || ''} />
          <label className="field">
            <span>更新源</span>
            <input
              value={settingsDraft.updateManifestUrl}
              onChange={(event) => setSettingsDraft({ ...settingsDraft, updateManifestUrl: event.target.value })}
            />
          </label>
          <button
            className="wide-button fill"
            type="button"
            onClick={() => run('open-config', recorder.openConfigDir)}
          >
            <FolderOpen size={18} />
            打开配置目录
          </button>
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

function RoomPreview({
  room,
  roomImageMode,
  status
}: {
  room: RoomState;
  roomImageMode: AppSettings['roomImageMode'];
  status: ReturnType<typeof getRoomStatus>;
}) {
  const rawImageUrl = roomImageMode === 'cover' ? room.cover : room.keyframe;
  const [previewVersion, setPreviewVersion] = useState(Date.now());
  useEffect(() => {
    if (roomImageMode !== 'keyframe') {
      return;
    }
    setPreviewVersion(Date.now());
    const timer = window.setInterval(() => setPreviewVersion(Date.now()), 5000);
    return () => window.clearInterval(timer);
  }, [rawImageUrl, roomImageMode]);
  const imageVersion = roomImageMode === 'keyframe' ? previewVersion : room.lastCheckedAt;
  const imageUrl = rawImageUrl ? imageProxyUrl(rawImageUrl, imageVersion) : '';
  const imageKey = rawImageUrl ? `${rawImageUrl}:${imageVersion || 0}` : '';
  const [failedSrc, setFailedSrc] = useState('');
  const canShowImage = Boolean(rawImageUrl && imageUrl && failedSrc !== imageKey);

  return (
    <div className="room-cover">
      {canShowImage ? (
        <img src={imageUrl} alt="" onError={() => setFailedSrc(imageKey)} />
      ) : (
        <div className="cover-fallback">
          <Radio size={32} />
          <span>{roomImageMode === 'cover' ? '无封面' : '无实时画面'}</span>
        </div>
      )}
      <span className={`status-pill ${status.kind}`}>{status.label}</span>
      <span className="preview-mode">{roomImageMode === 'cover' ? '封面' : '实时'}</span>
    </div>
  );
}

function RoomCard({
  room,
  roomImageMode,
  burnOverlayMode,
  busy,
  run
}: {
  room: RoomState;
  roomImageMode: AppSettings['roomImageMode'];
  burnOverlayMode: AppSettings['burnOverlayMode'];
  busy: string | null;
  run: <T>(key: string, action: () => Promise<T>) => Promise<void>;
}) {
  const status = getRoomStatus(room);
  const roomKey = room.id;
  const streamText = room.currentRecording?.videoInfo
    ? formatVideoInfo(room.currentRecording.videoInfo, room.stream?.codec)
    : room.stream
      ? `${displayCodec(room.stream.codec)} · 清晰度 ${room.stream.qn}`
      : '未选流';
  const [cardOverlayMode, setCardOverlayMode] = useState<AppSettings['burnOverlayMode']>(burnOverlayMode);

  useEffect(() => {
    setCardOverlayMode(burnOverlayMode);
  }, [burnOverlayMode]);

  return (
    <article className={`room-card ${room.recording ? 'is-recording' : ''}`}>
      <RoomPreview room={room} roomImageMode={roomImageMode} status={status} />

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
            <span>
              <Radio size={15} />
              {room.currentRecording.danmakuMessage || '弹幕通道准备中'}
            </span>
            <span>
              <Activity size={15} />
              热度 {room.currentRecording.danmakuPopularity ?? 0} · 互动 {room.currentRecording.ignoredDanmakuCount ?? 0}
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
          <select
            className="action-select"
            value={cardOverlayMode}
            disabled={!room.currentRecording || room.recording || room.burning}
            title="弹幕版内容"
            onChange={(event) => setCardOverlayMode(event.target.value as AppSettings['burnOverlayMode'])}
          >
            {overlayModeOptions.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
          <button
            className="icon-button"
            title={`只生成字幕文件（${overlayModeLabel(cardOverlayMode)}）`}
            disabled={!room.currentRecording || room.recording || room.burning}
            onClick={() =>
              run(`subtitles-${roomKey}`, () => recorder.prepareDanmaku(room.id, { overlayMode: cardOverlayMode }))
            }
          >
            <FileCode2 size={18} />
          </button>
          <button
            className="icon-button"
            title={`生成弹幕版（${overlayModeLabel(cardOverlayMode)}）`}
            disabled={!room.currentRecording || room.recording || room.burning}
            onClick={() => run(`burn-${roomKey}`, () => recorder.burnDanmaku(room.id, { overlayMode: cardOverlayMode }))}
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

function hydrateExportDraft(current: ExportDraft, state: AppState): ExportDraft {
  if (current.cleanPath) {
    return {
      ...current,
      overlayMode: current.overlayMode || state.settings.burnOverlayMode,
      outputDir: current.outputDir || state.settings.outputDir
    };
  }
  const recording = state.recordings[0];
  if (!recording) {
    return {
      ...current,
      overlayMode: state.settings.burnOverlayMode,
      outputDir: current.outputDir || state.settings.outputDir
    };
  }
  return {
    ...current,
    cleanPath: recording.cleanPath,
    danmakuPath: recording.danmakuPath || '',
    cssPath: recording.cssPath || '',
    overlayMode: state.settings.burnOverlayMode,
    outputDir: current.outputDir || state.settings.outputDir
  };
}

function recordingLabel(recording: RecordingState) {
  const title = recording.roomTitle || recording.anchor || filename(recording.cleanPath);
  const merged = recording.mergedFrom?.length ? '合并' : '源流';
  return `${formatDateTime(recording.startedAt)} · ${merged} · ${title}`;
}

function overlayModeLabel(mode: AppSettings['burnOverlayMode']) {
  return mode === 'danmaku' ? '仅弹幕' : '弹幕和礼物';
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

function formatDateTime(time: number) {
  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit'
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

function formatVideoInfo(videoInfo: NonNullable<RoomState['currentRecording']>['videoInfo'], fallbackCodec?: string) {
  if (!videoInfo) {
    return fallbackCodec ? displayCodec(fallbackCodec) : '正在探测';
  }
  const codec = displayCodec(fallbackCodec || videoInfo.codec || '');
  const fps = videoInfo.fps ? ` · ${videoInfo.fps}fps` : '';
  return `${codec} · ${videoInfo.width}x${videoInfo.height}${fps}`;
}

function imageProxyUrl(url: string, version?: number) {
  let targetUrl = url;
  if (version) {
    try {
      const target = new URL(url);
      target.searchParams.set('_br2k_preview', String(version));
      targetUrl = target.toString();
    } catch {
      targetUrl = url;
    }
  }
  const params = new URLSearchParams({ url: targetUrl });
  if (version) {
    params.set('v', String(version));
  }
  return `/api/image?${params.toString()}`;
}

function mediaUrl(filePath: string) {
  return `/api/media?${new URLSearchParams({ path: filePath }).toString()}`;
}

function parseTimelineInput(value: string) {
  const text = String(value || '').trim();
  if (!text) {
    return Number.NaN;
  }
  if (/^\d+(?:\.\d+)?$/.test(text)) {
    return Number(text);
  }
  const parts = text.split(':').map((part) => Number(part));
  if (parts.length > 3 || parts.some((part) => !Number.isFinite(part) || part < 0)) {
    return Number.NaN;
  }
  while (parts.length < 3) {
    parts.unshift(0);
  }
  return parts[0] * 3600 + parts[1] * 60 + parts[2];
}

function formatTimelineTime(value: number) {
  const totalTenths = Math.max(0, Math.round((Number(value) || 0) * 10));
  const hours = Math.floor(totalTenths / 36000);
  const minutes = Math.floor((totalTenths % 36000) / 600);
  const seconds = Math.floor((totalTenths % 600) / 10);
  const tenths = totalTenths % 10;
  const secondText = `${String(seconds).padStart(2, '0')}${tenths ? `.${tenths}` : ''}`;
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${secondText}`;
}

function clampNumber(value: number, min: number, max: number) {
  const safeMax = Math.max(min, max);
  return Math.min(safeMax, Math.max(min, Number(value) || 0));
}

function formatFileSize(bytes: number) {
  const value = Number(bytes || 0);
  if (value >= 1024 * 1024 * 1024) {
    return `${(value / 1024 / 1024 / 1024).toFixed(2)} GB`;
  }
  if (value >= 1024 * 1024) {
    return `${(value / 1024 / 1024).toFixed(1)} MB`;
  }
  if (value >= 1024) {
    return `${Math.round(value / 1024)} KB`;
  }
  return `${Math.round(value)} B`;
}

function parseChangelog(markdown: string) {
  const entries: Array<{ version: string; items: string[] }> = [];
  let current: { version: string; items: string[] } | null = null;
  for (const line of markdown.split(/\r?\n/)) {
    const heading = /^##\s+(.+)$/.exec(line);
    if (heading) {
      current = { version: heading[1], items: [] };
      entries.push(current);
      continue;
    }
    const item = /^-\s+(.+)$/.exec(line);
    if (item && current) {
      current.items.push(item[1]);
    }
  }
  return entries.slice(0, 6);
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
