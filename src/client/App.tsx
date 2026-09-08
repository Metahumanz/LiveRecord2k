import { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react';
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
import type { AppSettings, AppState, CleanupScanResult, ExportDraft, ExportResult, Page, RecordingState } from './types';
import { recorder, RecorderApiError } from './recorderClient';
import { Metric, ToastHost, type ToastItem } from './components/common';
import { LivePreviewModal, QrLoginPanel } from './components/rooms';
import { formatTimelineTime, getStats, hydrateExportDraft, isAppState } from './utils';

const pages: Array<{ id: Page; label: string; icon: React.ReactNode }> = [
  { id: 'overview', label: '总览', icon: <Home size={20} /> },
  { id: 'rooms', label: '直播间', icon: <ListVideo size={20} /> },
  { id: 'export', label: '剪辑导出', icon: <Scissors size={20} /> },
  { id: 'settings', label: '录制配置', icon: <Settings2 size={20} /> },
  { id: 'maintenance', label: '软件维护', icon: <Wrench size={20} /> },
  { id: 'logs', label: '日志', icon: <MessageSquareText size={20} /> }
];

const OverviewPage = lazy(async () => ({ default: (await import('./pages/OverviewPage')).OverviewPage }));
const RoomsPage = lazy(async () => ({ default: (await import('./pages/RoomsPage')).RoomsPage }));
const ExportPage = lazy(async () => ({ default: (await import('./pages/ExportPage')).ExportPage }));
const SettingsPage = lazy(async () => ({ default: (await import('./pages/SettingsPage')).SettingsPage }));
const MaintenancePage = lazy(async () => ({ default: (await import('./pages/MaintenancePage')).MaintenancePage }));
const LogsPage = lazy(async () => ({ default: (await import('./pages/LogsPage')).LogsPage }));

type SettingsSaveStatus = 'idle' | 'saving' | 'saved' | 'error';

export default function App() {
  const [page, setPage] = useState<Page>('overview');
  const [state, setState] = useState<AppState | null>(null);
  const [settingsDraft, setSettingsDraft] = useState<AppSettings | null>(null);
  const [roomInput, setRoomInput] = useState('');
  const [busy, setBusy] = useState<Set<string>>(() => new Set());
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
    avatarMode: 'high',
    outputDir: ''
  });
  const [exportResult, setExportResult] = useState<ExportResult | null>(null);
  const [previewRoomId, setPreviewRoomId] = useState<string | null>(null);
  const [initialLoadError, setInitialLoadError] = useState('');
  const [settingsSaveStatus, setSettingsSaveStatus] = useState<SettingsSaveStatus>('idle');
  const [settingsSaveError, setSettingsSaveError] = useState('');
  const [settingsDirtyFields, setSettingsDirtyFields] = useState<Set<keyof AppSettings>>(() => new Set());
  const settingsSaveQueueRef = useRef<Promise<boolean>>(Promise.resolve(true));
  const settingsDraftRef = useRef<AppSettings | null>(null);
  const settingsDirtyFieldsRef = useRef<Set<keyof AppSettings>>(new Set());
  const pendingSettingsPatchRef = useRef<Partial<AppSettings>>({});
  const pendingSettingsVersionRef = useRef(0);
  const failedSettingsPatchRef = useRef<{ patch: Partial<AppSettings>; version: number } | null>(null);
  const settingsAutoSaveTimerRef = useRef<number | null>(null);
  const settingsChangeVersionRef = useRef(0);

  function replaceDirtySettingsFields(nextFields: Set<keyof AppSettings>) {
    const next = new Set(nextFields);
    settingsDirtyFieldsRef.current = next;
    setSettingsDirtyFields(next);
  }

  function syncSettingsDraftFromServer(nextSettings: AppSettings, options: { resetDirty?: boolean } = {}) {
    if (options.resetDirty) {
      replaceDirtySettingsFields(new Set());
    }
    setSettingsDraft((current) => {
      const previous = current || settingsDraftRef.current;
      if (!previous || options.resetDirty) {
        settingsDraftRef.current = nextSettings;
        return nextSettings;
      }
      const merged = { ...nextSettings };
      for (const key of settingsDirtyFieldsRef.current) {
        Object.assign(merged, { [key]: previous[key] });
      }
      settingsDraftRef.current = merged;
      return merged;
    });
  }

  function updateSettingsDraft(nextSettings: Partial<AppSettings>, options: { autoSave?: boolean } = {}) {
    const keys = Object.keys(nextSettings) as Array<keyof AppSettings>;
    if (!keys.length) return;
    const changeVersion = ++settingsChangeVersionRef.current;
    setSettingsDraft((current) => {
      const previous = current || settingsDraftRef.current;
      if (!previous) return current;
      const next = { ...previous, ...nextSettings };
      settingsDraftRef.current = next;
      return next;
    });
    const dirty = new Set(settingsDirtyFieldsRef.current);
    for (const key of keys) dirty.add(key);
    replaceDirtySettingsFields(dirty);
    if (options.autoSave !== false) {
      queueSettingsAutoSave(nextSettings, changeVersion);
    }
  }

  function queueSettingsAutoSave(nextSettings: Partial<AppSettings>, changeVersion: number) {
    pendingSettingsPatchRef.current = { ...pendingSettingsPatchRef.current, ...nextSettings };
    pendingSettingsVersionRef.current = changeVersion;
    failedSettingsPatchRef.current = null;
    setSettingsSaveError('');
    setSettingsSaveStatus('saving');
    if (settingsAutoSaveTimerRef.current !== null) {
      window.clearTimeout(settingsAutoSaveTimerRef.current);
    }
    settingsAutoSaveTimerRef.current = window.setTimeout(() => {
      settingsAutoSaveTimerRef.current = null;
      const patch = pendingSettingsPatchRef.current;
      const patchVersion = pendingSettingsVersionRef.current;
      pendingSettingsPatchRef.current = {};
      void persistSettings(patch, '', patchVersion);
    }, 550);
  }

  function retryFailedSettingsSave() {
    const failed = failedSettingsPatchRef.current;
    if (!failed || !Object.keys(failed.patch).length) return;
    failedSettingsPatchRef.current = null;
    setSettingsSaveError('');
    setSettingsSaveStatus('saving');
    void persistSettings(failed.patch, '', failed.version);
  }

  useEffect(() => {
    let cancelled = false;
    const load = () => recorder.getInitialState().then((nextState) => {
      if (cancelled) return;
      setInitialLoadError('');
      setState(nextState);
      syncSettingsDraftFromServer(nextState.settings, { resetDirty: true });
      setExportDraft((current) => hydrateExportDraft(current, nextState));
    }).catch((error) => {
      if (!cancelled) setInitialLoadError(error instanceof Error ? error.message : '初始状态加载失败');
    });
    void load();
    const unsubscribe = recorder.onStateChanged((nextState) => {
      setInitialLoadError('');
      setState(nextState);
      syncSettingsDraftFromServer(nextState.settings);
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

  useEffect(
    () => () => {
      if (settingsAutoSaveTimerRef.current !== null) {
        window.clearTimeout(settingsAutoSaveTimerRef.current);
      }
    },
    []
  );

  const stats = useMemo(() => getStats(state?.rooms ?? []), [state?.rooms]);
  const previewRoom = previewRoomId ? state?.rooms.find((room) => room.id === previewRoomId) || null : null;

  function beginBusy(key: string) {
    setBusy((current) => {
      const next = new Set(current);
      next.add(key);
      return next;
    });
  }

  function endBusy(key: string) {
    setBusy((current) => {
      const next = new Set(current);
      next.delete(key);
      return next;
    });
  }

  function applyStateResult(result: unknown) {
    if (!isAppState(result)) {
      return;
    }
    setState(result);
    syncSettingsDraftFromServer(result.settings);
    if (result.operationNotice) {
      showToast(result.operationNotice);
    }
  }

  async function run<T>(key: string, action: () => Promise<T>): Promise<boolean> {
    beginBusy(key);
    try {
      const result = await action();
      applyStateResult(result);
      return true;
    } catch (error) {
      showToast({
        kind: 'error',
        title: '操作失败',
        message: error instanceof Error ? error.message : '请求未能完成，请稍后重试。'
      });
      return false;
    } finally {
      endBusy(key);
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

  function settingValueEquals(left: unknown, right: unknown) {
    return JSON.stringify(left) === JSON.stringify(right);
  }

  function reconcileSavedSettings(savedPatch: Partial<AppSettings>, serverSettings: AppSettings) {
    const current = settingsDraftRef.current;
    const savedKeys = Object.keys(savedPatch) as Array<keyof AppSettings>;
    if (current) {
      const dirty = new Set(settingsDirtyFieldsRef.current);
      for (const key of savedKeys) {
        // A newer keystroke may have landed while this request was queued.
        // Only clear the dirty marker when this response saved that exact value.
        if (settingValueEquals(current[key], savedPatch[key])) {
          dirty.delete(key);
        }
      }
      replaceDirtySettingsFields(dirty);
    }
    syncSettingsDraftFromServer(serverSettings);
  }

  async function persistSettings(
    settings: Partial<AppSettings>,
    successMessage = '',
    saveVersion = settingsChangeVersionRef.current
  ): Promise<boolean> {
    const save = async () => {
      beginBusy('save-settings');
      setSettingsSaveStatus('saving');
      try {
        const result = await recorder.saveSettings(settings);
        setState(result);
        reconcileSavedSettings(settings, result.settings);
        if (saveVersion === settingsChangeVersionRef.current) {
          failedSettingsPatchRef.current = null;
          setSettingsSaveError('');
          setSettingsSaveStatus('saved');
        }
        if (result.operationNotice) {
          showToast(result.operationNotice);
        }
        if (successMessage) {
          showToast({ title: '保存成功', message: successMessage });
        }
        return true;
      } catch (error) {
        const message = error instanceof Error ? error.message : '请求未能完成，请稍后重试。';
        if (saveVersion === settingsChangeVersionRef.current) {
          failedSettingsPatchRef.current = { patch: settings, version: saveVersion };
          setSettingsSaveError(message);
          setSettingsSaveStatus('error');
        }
        showToast({
          kind: 'error',
          title: '设置未保存',
          message
        });
        return false;
      } finally {
        endBusy('save-settings');
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
    updateSettingsDraft(settings, { autoSave: false });
    await persistSettings(settings, message, settingsChangeVersionRef.current);
  }

  async function applyImportedSettings(settings: Partial<AppSettings>) {
    updateSettingsDraft(settings, { autoSave: false });
    const saved = await persistSettings(settings);
    if (saved) {
      showToast({ title: '配置已导入', message: '已应用已确认的配置变更。' });
    }
    return saved;
  }

  async function scanMergedResiduals(): Promise<CleanupScanResult | null> {
    beginBusy('cleanup-scan');
    try {
      return await recorder.scanMergedResiduals();
    } catch (error) {
      showToast({
        kind: 'error',
        title: '清理扫描失败',
        message: error instanceof Error ? error.message : '无法扫描可清理文件。'
      });
      return null;
    } finally {
      endBusy('cleanup-scan');
    }
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

  async function removeRoomWithConfirmation(roomId: string) {
    const key = `remove-${roomId}`;
    beginBusy(key);
    try {
      let result: AppState;
      try {
        result = await recorder.removeRoom(roomId);
      } catch (error) {
        if (!(error instanceof RecorderApiError) || error.code !== 'ROOM_BUSY') {
          throw error;
        }
        const confirmed = window.confirm(
          `${error.message}\n\n强制删除会取消该直播间的录制、合并、烧录、导出和兼容预览任务，并等待资源释放。确定继续吗？`
        );
        if (!confirmed) {
          showToast({ kind: 'warning', title: '已保留直播间', message: '任务未取消，直播间没有被删除。' });
          return;
        }
        result = await recorder.removeRoom(roomId, { force: true });
      }
      applyStateResult(result);
    } catch (error) {
      showToast({
        kind: 'error',
        title: '移除直播间失败',
        message: error instanceof Error ? error.message : '请求未能完成，请稍后重试。'
      });
    } finally {
      endBusy(key);
    }
  }

  async function chooseOutputDir() {
    beginBusy('choose-output-dir');
    try {
      const selected = await recorder.chooseOutputDir(settingsDraft?.outputDir || '');
      if (selected && settingsDraft) {
        updateSettingsDraft({ outputDir: selected });
      }
    } catch (error) {
      window.alert(error instanceof Error ? error.message : '系统路径选择器打开失败。');
    } finally {
      endBusy('choose-output-dir');
    }
  }

  async function changeRoomImageMode(mode: AppSettings['roomImageMode']) {
    if (!state || state.settings.roomImageMode === mode) {
      return;
    }
    updateSettingsDraft({ roomImageMode: mode });
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
      avatarMode: state?.settings.burnAvatarMode || current.avatarMode,
      outputDir: current.outputDir || state?.settings.outputDir || ''
    }));
  }

  async function prepareExportSubtitles() {
    beginBusy('export-subtitles');
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
        avatarMode: exportDraft.avatarMode,
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
      endBusy('export-subtitles');
    }
  }

  async function exportClip() {
    beginBusy('export-clip');
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
        avatarMode: exportDraft.avatarMode,
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
      endBusy('export-clip');
    }
  }

  async function saveExportStyleAsDefault() {
    await saveSettingsWithToast(
      {
        burnDanmakuStylePreset: exportDraft.stylePreset,
        burnDanmakuStyleLayout: exportDraft.styleLayout,
        burnAvatarMode: exportDraft.avatarMode
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
        <Suspense
          fallback={
            <div className="empty-state" role="status">
              <Activity className="spin" size={28} />
              <span>正在加载页面</span>
            </div>
          }
        >
          {page === 'overview' ? (
            <OverviewPage
              state={state}
              stats={stats}
              busy={busy}
              setPage={setPage}
              run={run}
              removeRoom={removeRoomWithConfirmation}
              openPreview={setPreviewRoomId}
            />
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
              removeRoom={removeRoomWithConfirmation}
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
              chooseOutputDir={chooseOutputDir}
              updateSettingsDraft={updateSettingsDraft}
              settingsSaveStatus={settingsSaveStatus}
              settingsSaveError={settingsSaveError}
              retrySettingsSave={retryFailedSettingsSave}
              dirtyFields={settingsDirtyFields}
            />
          ) : null}
          {page === 'maintenance' ? (
            <MaintenancePage
              state={state}
              settingsDraft={settingsDraft}
              busy={busy}
              run={run}
              updateSettingsDraft={updateSettingsDraft}
              settingsSaveStatus={settingsSaveStatus}
              settingsSaveError={settingsSaveError}
              retrySettingsSave={retryFailedSettingsSave}
              dirtyFields={settingsDirtyFields}
              applyImportedSettings={applyImportedSettings}
              scanMergedResiduals={scanMergedResiduals}
            />
          ) : null}
          {page === 'logs' ? <LogsPage logs={state.logs} busy={busy} run={run} /> : null}
        </Suspense>
      </section>

      {state.login ? <QrLoginPanel login={state.login} busy={busy} run={run} /> : null}
      {previewRoom ? <LivePreviewModal room={previewRoom} onClose={() => setPreviewRoomId(null)} /> : null}
      <ToastHost toasts={toasts} onClose={closeToast} />
    </main>
  );
}
