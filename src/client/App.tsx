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
import { SettingsSaveCoordinator, type SettingsSaveKey } from './settings-save-queue';
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

type SettingsSaveStatus = 'idle' | 'dirty' | 'saving' | 'saved' | 'error';
type SettingsSaveMode = 'immediate' | 'debounced' | 'commit';
type SettingsDraftUpdateOptions = { autoSave?: boolean; saveMode?: SettingsSaveMode };

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
  const settingsSaveCoordinatorRef = useRef(new SettingsSaveCoordinator<AppSettings>());
  const settingsAutoSaveTimerRef = useRef<number | null>(null);
  const settingsAutoRetryTimerRef = useRef<number | null>(null);
  const settingsHaveSavedRef = useRef(false);

  function replaceDirtySettingsFields(nextFields: Set<keyof AppSettings>) {
    const next = new Set(nextFields);
    settingsDirtyFieldsRef.current = next;
    setSettingsDirtyFields(next);
  }

  function syncDirtySettingsFieldsFromCoordinator() {
    replaceDirtySettingsFields(settingsSaveCoordinatorRef.current.getDirtyFields());
  }

  function refreshSettingsSaveStatus() {
    const coordinator = settingsSaveCoordinatorRef.current;
    if (coordinator.hasFailures() && !coordinator.hasPending() && !coordinator.hasInFlight()) {
      setSettingsSaveStatus('error');
      return;
    }
    if (coordinator.hasPending() || coordinator.hasInFlight()) {
      setSettingsSaveStatus('saving');
      return;
    }
    if (coordinator.isFullySaved()) {
      setSettingsSaveStatus(settingsHaveSavedRef.current ? 'saved' : 'idle');
      return;
    }
    setSettingsSaveStatus('dirty');
  }

  function syncSettingsDraftFromServer(nextSettings: AppSettings, options: { resetDirty?: boolean } = {}) {
    if (options.resetDirty) {
      settingsSaveCoordinatorRef.current.reset();
      settingsHaveSavedRef.current = false;
      syncDirtySettingsFieldsFromCoordinator();
      setSettingsSaveError('');
      setSettingsSaveStatus('idle');
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

  function updateSettingsDraft(nextSettings: Partial<AppSettings>, options: SettingsDraftUpdateOptions = {}) {
    const keys = Object.keys(nextSettings) as Array<keyof AppSettings>;
    if (!keys.length) return;
    const saveMode = options.saveMode ?? (options.autoSave === false ? 'commit' : 'debounced');
    setSettingsDraft((current) => {
      const previous = current || settingsDraftRef.current;
      if (!previous) return current;
      const next = { ...previous, ...nextSettings };
      settingsDraftRef.current = next;
      return next;
    });
    settingsSaveCoordinatorRef.current.markChanged(nextSettings, { queue: saveMode !== 'commit' });
    syncDirtySettingsFieldsFromCoordinator();
    if (!settingsSaveCoordinatorRef.current.hasFailures()) {
      setSettingsSaveError('');
    }
    refreshSettingsSaveStatus();
    if (saveMode === 'immediate') {
      void persistSettings();
    } else if (saveMode === 'debounced') {
      queueSettingsAutoSave();
    }
  }

  function queueSettingsAutoSave() {
    if (settingsAutoSaveTimerRef.current !== null) {
      window.clearTimeout(settingsAutoSaveTimerRef.current);
    }
    settingsAutoSaveTimerRef.current = window.setTimeout(() => {
      settingsAutoSaveTimerRef.current = null;
      void persistSettings();
    }, 550);
  }

  function queueSettingsAutoRetry() {
    if (settingsAutoRetryTimerRef.current !== null) return;
    settingsAutoRetryTimerRef.current = window.setTimeout(() => {
      settingsAutoRetryTimerRef.current = null;
      void persistSettings();
    }, 900);
  }

  function commitSettingsDraft(keys: Array<SettingsSaveKey<AppSettings>>, successMessage = '') {
    const draft = settingsDraftRef.current;
    if (!draft) return Promise.resolve(false);
    settingsSaveCoordinatorRef.current.queueCurrent(keys, draft);
    syncDirtySettingsFieldsFromCoordinator();
    refreshSettingsSaveStatus();
    return persistSettings(successMessage);
  }

  function retryFailedSettingsSave() {
    const draft = settingsDraftRef.current;
    if (!draft) return;
    const retriedKeys = settingsSaveCoordinatorRef.current.retryFailed(draft);
    if (!retriedKeys.length) return;
    setSettingsSaveError('');
    syncDirtySettingsFieldsFromCoordinator();
    refreshSettingsSaveStatus();
    void persistSettings();
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
      if (settingsAutoRetryTimerRef.current !== null) {
        window.clearTimeout(settingsAutoRetryTimerRef.current);
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

  function persistSettings(successMessage = ''): Promise<boolean> {
    const save = async () => {
      const coordinator = settingsSaveCoordinatorRef.current;
      const attempt = coordinator.takePending();
      if (!attempt) {
        refreshSettingsSaveStatus();
        return true;
      }
      beginBusy('save-settings');
      refreshSettingsSaveStatus();
      try {
        const result = await recorder.saveSettings(attempt.patch);
        coordinator.settleSuccess(attempt);
        settingsHaveSavedRef.current = true;
        syncDirtySettingsFieldsFromCoordinator();
        setState(result);
        syncSettingsDraftFromServer(result.settings);
        if (!coordinator.hasFailures()) {
          setSettingsSaveError('');
        }
        refreshSettingsSaveStatus();
        if (result.operationNotice) {
          showToast(result.operationNotice);
        }
        if (successMessage) {
          showToast({ title: '保存成功', message: successMessage });
        }
        return true;
      } catch (error) {
        const message = error instanceof Error ? error.message : '请求未能完成，请稍后重试。';
        const draft = settingsDraftRef.current;
        const failure = draft ? coordinator.settleFailure(attempt, draft) : { autoRetryKeys: [], manualRetryKeys: [] };
        syncDirtySettingsFieldsFromCoordinator();
        setSettingsSaveError(message);
        if (failure.autoRetryKeys.length) {
          queueSettingsAutoRetry();
        }
        refreshSettingsSaveStatus();
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
    updateSettingsDraft(settings, { saveMode: 'commit' });
    await commitSettingsDraft(Object.keys(settings) as Array<SettingsSaveKey<AppSettings>>, message);
  }

  async function applyImportedSettings(settings: Partial<AppSettings>) {
    updateSettingsDraft(settings, { saveMode: 'commit' });
    const saved = await commitSettingsDraft(Object.keys(settings) as Array<SettingsSaveKey<AppSettings>>);
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

  function roomRemovalTaskLabels(message: string) {
    const labels = [];
    if (message.includes('录制')) labels.push('正在录制');
    if (message.includes('合并')) labels.push('正在合并');
    if (message.includes('烧录')) labels.push('正在烧录');
    if (message.includes('导出') || message.includes('预览')) labels.push('正在导出/预览');
    return labels;
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
        const taskLabels = roomRemovalTaskLabels(error.message);
        const taskSummary = taskLabels.length
          ? `当前关联任务：\n${taskLabels.map((label) => `- ${label}`).join('\n')}`
          : error.message;
        const confirmed = window.confirm(
          `${taskSummary}\n\n将停止相关任务并删除直播间，不会删除已经生成的录像文件。\n\n确定继续吗？`
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
        updateSettingsDraft({ outputDir: selected }, { saveMode: 'immediate' });
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
    updateSettingsDraft({ roomImageMode: mode }, { saveMode: 'immediate' });
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
              commitSettingsDraft={commitSettingsDraft}
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
              commitSettingsDraft={commitSettingsDraft}
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
