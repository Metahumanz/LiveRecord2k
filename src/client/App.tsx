import { useEffect, useMemo, useRef, useState } from 'react';
import type React from 'react';
import {
  Activity,
  CircleAlert,
  Gauge,
  Home,
  ListVideo,
  MessageSquareText,
  MonitorDot,
  PanelLeftClose,
  PanelLeftOpen,
  Radio,
  Scissors,
  Settings2,
  Sparkles,
  Video,
  Wrench
} from 'lucide-react';
import type { AppSettings, AppState, ExportDraft, ExportResult, Page, RecordingState } from './types';
import { recorder } from './recorderClient';
import { Metric, ToastHost, type ToastItem } from './components/common';
import { LivePreviewModal, QrLoginPanel } from './components/rooms';
import { OverviewPage } from './pages/OverviewPage';
import { RoomsPage } from './pages/RoomsPage';
import { ExportPage } from './pages/ExportPage';
import { SettingsPage } from './pages/SettingsPage';
import { MaintenancePage } from './pages/MaintenancePage';
import { LogsPage } from './pages/LogsPage';
import { formatTimelineTime, getStats, hydrateExportDraft, isAppState } from './utils';

const pages: Array<{ id: Page; label: string; icon: React.ReactNode }> = [
  { id: 'overview', label: '总览', icon: <Home size={20} /> },
  { id: 'rooms', label: '直播间', icon: <ListVideo size={20} /> },
  { id: 'export', label: '剪辑导出', icon: <Scissors size={20} /> },
  { id: 'settings', label: '录制配置', icon: <Settings2 size={20} /> },
  { id: 'maintenance', label: '软件维护', icon: <Wrench size={20} /> },
  { id: 'logs', label: '日志', icon: <MessageSquareText size={20} /> }
];

export default function App() {
  const [page, setPage] = useState<Page>('overview');
  const [state, setState] = useState<AppState | null>(null);
  const [settingsDraft, setSettingsDraft] = useState<AppSettings | null>(null);
  const [roomInput, setRoomInput] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [navCollapsed, setNavCollapsed] = useState(() => window.localStorage.getItem('br2k-nav-collapsed') === '1');
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const [exportDraft, setExportDraft] = useState<ExportDraft>({
    cleanPath: '',
    danmakuPath: '',
    cssPath: '',
    startTime: '00:00:00',
    endTime: '',
    mode: 'clean',
    overlayMode: 'danmaku-gift',
    danmakuArea: 'half',
    stylePreset: 'current',
    styleLayout: {},
    outputDir: ''
  });
  const [exportResult, setExportResult] = useState<ExportResult | null>(null);
  const [previewRoomId, setPreviewRoomId] = useState<string | null>(null);
  const [initialLoadError, setInitialLoadError] = useState('');
  const settingsSaveQueueRef = useRef<Promise<boolean>>(Promise.resolve(true));

  useEffect(() => {
    let cancelled = false;
    const load = () => recorder.getInitialState().then((nextState) => {
      if (cancelled) return;
      setInitialLoadError('');
      setState(nextState);
      setSettingsDraft(nextState.settings);
      setExportDraft((current) => hydrateExportDraft(current, nextState));
    }).catch((error) => {
      if (!cancelled) setInitialLoadError(error instanceof Error ? error.message : '初始状态加载失败');
    });
    void load();
    const unsubscribe = recorder.onStateChanged((nextState) => {
      setInitialLoadError('');
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
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, []);

  useEffect(() => {
    window.localStorage.setItem('br2k-nav-collapsed', navCollapsed ? '1' : '0');
  }, [navCollapsed]);

  const stats = useMemo(() => getStats(state?.rooms ?? []), [state?.rooms]);
  const previewRoom = previewRoomId ? state?.rooms.find((room) => room.id === previewRoomId) || null : null;

  async function run<T>(key: string, action: () => Promise<T>): Promise<boolean> {
    setBusy(key);
    try {
      const result = await action();
      if (isAppState(result)) {
        setState(result);
        setSettingsDraft(result.settings);
        if (result.operationNotice) {
          showToast(result.operationNotice);
        }
      }
      return true;
    } catch (error) {
      showToast({
        kind: 'error',
        title: '操作失败',
        message: error instanceof Error ? error.message : '请求未能完成，请稍后重试。'
      });
      return false;
    } finally {
      setBusy(null);
    }
  }

  function closeToast(id: number) {
    setToasts((current) => current.filter((toast) => toast.id !== id));
  }

  function showToast(toast: Omit<ToastItem, 'id'>) {
    const id = Date.now() + Math.floor(Math.random() * 1000);
    setToasts((current) => [...current.slice(-2), { id, kind: 'success', ...toast }]);
    window.setTimeout(() => closeToast(id), 4200);
  }

  async function persistSettings(settings: Partial<AppSettings>, successMessage = ''): Promise<boolean> {
    const save = async () => {
      setBusy('save-settings');
      try {
        const result = await recorder.saveSettings(settings);
        setState(result);
        setSettingsDraft((current) => {
          if (!current) {
            return result.settings;
          }
          const savedPatch = Object.fromEntries(
            (Object.keys(settings) as Array<keyof AppSettings>).map((key) => [key, result.settings[key]])
          ) as Partial<AppSettings>;
          return { ...current, ...savedPatch };
        });
        if (result.operationNotice) {
          showToast(result.operationNotice);
        }
        if (successMessage) {
          showToast({ title: '保存成功', message: successMessage });
        }
        return true;
      } catch (error) {
        showToast({
          kind: 'error',
          title: '设置未保存',
          message: error instanceof Error ? error.message : '请求未能完成，请稍后重试。'
        });
        return false;
      } finally {
        setBusy(null);
      }
    };
    const queued = settingsSaveQueueRef.current.then(save, save);
    settingsSaveQueueRef.current = queued.then(
      () => true,
      () => true
    );
    return queued;
  }

  async function saveSettingsWithToast(settings: Partial<AppSettings>, message = '录制配置已保存') {
    await persistSettings(settings, message);
  }

  async function saveSettingsImmediately(settings: Partial<AppSettings>) {
    await persistSettings(settings);
  }

  async function addRoom() {
    const value = roomInput.trim();
    if (!value) {
      return;
    }
    const succeeded = await run('add-room', () => recorder.addRoom(value));
    if (!succeeded) {
      return;
    }
    setRoomInput('');
    setPage('rooms');
  }

  async function chooseOutputDir() {
    setBusy('choose-output-dir');
    try {
      const selected = await recorder.chooseOutputDir(settingsDraft?.outputDir || '');
      if (selected && settingsDraft) {
        setSettingsDraft({ ...settingsDraft, outputDir: selected });
        void saveSettingsImmediately({ outputDir: selected });
      }
    } catch (error) {
      window.alert(error instanceof Error ? error.message : '系统路径选择器打开失败。');
    } finally {
      setBusy(null);
    }
  }

  async function changeRoomImageMode(mode: AppSettings['roomImageMode']) {
    if (!state || state.settings.roomImageMode === mode) {
      return;
    }
    setSettingsDraft((current) => (current ? { ...current, roomImageMode: mode } : current));
    await saveSettingsImmediately({ roomImageMode: mode });
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
      danmakuArea: state?.settings.burnDanmakuArea || current.danmakuArea,
      stylePreset: state?.settings.burnDanmakuStylePreset || current.stylePreset,
      styleLayout: { ...(state?.settings.burnDanmakuStyleLayout || current.styleLayout) },
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
        danmakuArea: exportDraft.danmakuArea,
        stylePreset: exportDraft.stylePreset,
        styleLayout: exportDraft.styleLayout,
        outputDir: exportDraft.outputDir
      });
      setExportResult(result);
    } catch (error) {
      showToast({
        kind: 'error',
        title: '字幕生成失败',
        message: error instanceof Error ? error.message : '字幕生成未能完成。'
      });
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
        danmakuArea: exportDraft.danmakuArea,
        stylePreset: exportDraft.stylePreset,
        styleLayout: exportDraft.styleLayout,
        outputDir: exportDraft.outputDir
      });
      setExportResult(result);
    } catch (error) {
      showToast({
        kind: 'error',
        title: '导出失败',
        message: error instanceof Error ? error.message : '导出请求未能完成。'
      });
    } finally {
      setBusy(null);
    }
  }

  async function saveExportStyleAsDefault() {
    await saveSettingsWithToast(
      {
        burnDanmakuStylePreset: exportDraft.stylePreset,
        burnDanmakuStyleLayout: exportDraft.styleLayout
      },
      '已设为默认烧录样式；自动烧录和下次导出会使用这组参数'
    );
  }

  if (!state || !settingsDraft) {
    return (
      <main className="loading-screen">
        {initialLoadError ? <CircleAlert size={30} /> : <Activity className="spin" size={30} />}
        <span>{initialLoadError || '正在启动哔哩录播 2K'}</span>
        {initialLoadError ? <button onClick={() => window.location.reload()}>重新连接</button> : null}
      </main>
    );
  }

  return (
    <main className={navCollapsed ? 'app-shell nav-collapsed' : 'app-shell'}>
      <aside className="nav-panel">
        <div className="brand">
          <img className="brand-logo" src="/app-icon.svg" alt="" />
          <div>
            <h1>哔哩录播 2K</h1>
          </div>
          <button
            className="icon-button nav-toggle"
            type="button"
            title={navCollapsed ? '展开导航栏' : '收起导航栏'}
            aria-label={navCollapsed ? '展开导航栏' : '收起导航栏'}
            onClick={() => setNavCollapsed((current) => !current)}
          >
            {navCollapsed ? <PanelLeftOpen size={18} /> : <PanelLeftClose size={18} />}
          </button>
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
            saveStyleAsDefault={saveExportStyleAsDefault}
            run={run}
          />
        ) : null}
        {page === 'settings' ? (
          <SettingsPage
            state={state}
            settingsDraft={settingsDraft}
            busy={busy}
            run={run}
            saveSettings={saveSettingsWithToast}
            saveSettingsImmediately={saveSettingsImmediately}
            chooseOutputDir={chooseOutputDir}
            setSettingsDraft={setSettingsDraft}
          />
        ) : null}
        {page === 'maintenance' ? (
          <MaintenancePage
            state={state}
            settingsDraft={settingsDraft}
            busy={busy}
            run={run}
            saveSettings={saveSettingsWithToast}
            saveSettingsImmediately={saveSettingsImmediately}
            setSettingsDraft={setSettingsDraft}
          />
        ) : null}
        {page === 'logs' ? <LogsPage logs={state.logs} busy={busy} run={run} /> : null}
      </section>

      {state.login ? <QrLoginPanel login={state.login} busy={busy} run={run} /> : null}
      {previewRoom ? <LivePreviewModal room={previewRoom} onClose={() => setPreviewRoomId(null)} /> : null}
      <ToastHost toasts={toasts} onClose={closeToast} />
    </main>
  );
}
