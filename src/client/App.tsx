import { useEffect, useMemo, useState } from 'react';
import type React from 'react';
import { Activity, Gauge, Home, ListVideo, MessageSquareText, MonitorDot, Radio, Scissors, Settings2, Sparkles, Video } from 'lucide-react';
import type { AppSettings, AppState, ExportDraft, ExportResult, Page, RecordingState } from './types';
import { recorder } from './recorderClient';
import { Metric } from './components/common';
import { LivePreviewModal, QrLoginPanel } from './components/rooms';
import { OverviewPage } from './pages/OverviewPage';
import { RoomsPage } from './pages/RoomsPage';
import { ExportPage } from './pages/ExportPage';
import { SettingsPage } from './pages/SettingsPage';
import { LogsPage } from './pages/LogsPage';
import { formatTimelineTime, getStats, hydrateExportDraft, isAppState } from './utils';

const pages: Array<{ id: Page; label: string; icon: React.ReactNode }> = [
  { id: 'overview', label: '总览', icon: <Home size={20} /> },
  { id: 'rooms', label: '直播间', icon: <ListVideo size={20} /> },
  { id: 'export', label: '剪辑导出', icon: <Scissors size={20} /> },
  { id: 'settings', label: '设置', icon: <Settings2 size={20} /> },
  { id: 'logs', label: '日志', icon: <MessageSquareText size={20} /> }
];

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
  const [previewRoomId, setPreviewRoomId] = useState<string | null>(null);

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
  const previewRoom = previewRoomId ? state?.rooms.find((room) => room.id === previewRoomId) || null : null;

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
    const duration = Number(recording.durationSec || 0);
    setExportDraft((current) => ({
      ...current,
      cleanPath: recording.cleanPath,
      danmakuPath: recording.danmakuPath || '',
      cssPath: recording.cssPath || '',
      startTime: '00:00:00',
      endTime: duration > 0 ? formatTimelineTime(duration) : '',
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
          <OverviewPage state={state} stats={stats} busy={busy} setPage={setPage} run={run} openPreview={setPreviewRoomId} />
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
            openPreview={setPreviewRoomId}
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
      {previewRoom ? <LivePreviewModal room={previewRoom} onClose={() => setPreviewRoomId(null)} /> : null}
    </main>
  );
}
