import type React from 'react';
import { CheckCircle2, Clock3, Download, FolderOpen, RefreshCw } from 'lucide-react';
import { recorder } from '../recorderClient';
import type { AppState, FfmpegJobProgress, LogEntry } from '../types';
import { clampNumber, filename, formatClock, formatFileSize, getStats } from '../utils';

export function UpdateNotice({
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
          <UpdateProgress update={update} />
          {update.status === 'error' && (update.updateLogPath || update.statusPath) ? (
            <small className="update-diagnostic">
              {update.updateLogPath ? `日志 ${update.updateLogPath}` : ''}
              {update.statusPath ? `${update.updateLogPath ? ' · ' : ''}状态 ${update.statusPath}` : ''}
            </small>
          ) : null}
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
            录制结束后安装
          </button>
        ) : null}
        {canInstall ? (
          <button
            className="wide-button"
            disabled={busy === 'update-download' || update.status === 'downloading'}
            onClick={() => run('update-download', recorder.downloadUpdate)}
          >
            <Download size={18} />
            下载安装器
          </button>
        ) : null}
        {canInstall && !activeJobs ? (
          <button
            className="wide-button primary"
            disabled={busy === 'update-apply'}
            onClick={() => run('update-apply', recorder.applyUpdate)}
          >
            <Download size={18} />
            启动安装器
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
        {update.status === 'error' ? (
          <button className="wide-button" onClick={() => run('open-config', recorder.openConfigDir)}>
            <FolderOpen size={18} />
            配置目录
          </button>
        ) : null}
        {update.status === 'queued' ? <span className="update-waiting">等待任务结束</span> : null}
        {busyUpdating ? <span className="update-waiting">处理中</span> : null}
      </div>
    </section>
  );
}

export function UpdateProgress({ update }: { update: AppState['update'] }) {
  const active = ['downloading', 'ready', 'applying'].includes(update.status);
  const received = Number(update.downloadReceivedBytes || 0);
  const total = Number(update.downloadTotalBytes || 0);
  const rawProgress = typeof update.downloadProgress === 'number' ? update.downloadProgress : Number.NaN;
  const percent = Number.isFinite(rawProgress) ? clampNumber(rawProgress, 0, 100) : Number.NaN;
  if (!active && !received && !Number.isFinite(percent)) {
    return null;
  }
  const hasPercent = Number.isFinite(percent);
  const label = hasPercent
    ? `${Math.round(percent)}%${total ? ` · ${formatFileSize(received)} / ${formatFileSize(total)}` : ''}`
    : `已下载 ${formatFileSize(received)}`;
  return (
    <div className="update-progress">
      <div className={hasPercent ? 'update-progress-track' : 'update-progress-track indeterminate'}>
        <span style={hasPercent ? { width: `${percent}%` } : undefined} />
      </div>
      <small>{label}</small>
    </div>
  );
}

export function JobProgress({ progress }: { progress: FfmpegJobProgress }) {
  const hasPercent = typeof progress.percent === 'number' && Number.isFinite(progress.percent);
  const percent = hasPercent ? clampNumber(progress.percent || 0, 0, 100) : 0;
  const statusLabel =
    progress.status === 'completed'
      ? '完成'
      : progress.status === 'error'
        ? '失败'
        : hasPercent
          ? `${Math.round(percent)}%`
          : '处理中';
  return (
    <div className={`job-progress ${progress.status}`}>
      <div className="job-progress-heading">
        <span>{progress.label}</span>
        <strong>{statusLabel}</strong>
      </div>
      <div className={hasPercent ? 'job-progress-track' : 'job-progress-track indeterminate'}>
        <span style={hasPercent ? { width: `${percent}%` } : undefined} />
      </div>
      <small title={progress.outputPath || ''}>
        {progress.message || (progress.outputPath ? filename(progress.outputPath) : '等待进度')}
      </small>
    </div>
  );
}

export function updateTitle(status: AppState['update']['status']) {
  if (status === 'available') return '有新版本';
  if (status === 'queued') return '更新已排队';
  if (status === 'checking') return '正在检查更新';
  if (status === 'downloading') return '正在下载更新';
  if (status === 'ready') return '安装器已就绪';
  if (status === 'applying') return '安装器已启动';
  if (status === 'up-to-date') return '已是最新';
  if (status === 'blocked') return '暂不更新';
  if (status === 'error') return '更新失败';
  return '更新';
}

export function PageHeader({
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

export function SettingPanel({
  title,
  icon,
  className = '',
  children
}: {
  title: string;
  icon: React.ReactNode;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <section className={`inspector-card settings-panel ${className}`}>
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

export function Toggle({
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

export function PathLine({ label, value }: { label: string; value: string }) {
  return (
    <div className="path-line">
      <span>{label}</span>
      <p title={value}>{value || '-'}</p>
    </div>
  );
}

export function Metric({ icon, label, value }: { icon: React.ReactNode; label: string; value: number }) {
  return (
    <div className="metric">
      {icon}
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

export function BigMetric({ icon, label, value }: { icon: React.ReactNode; label: string; value: number }) {
  return (
    <div className="big-metric">
      {icon}
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

export function LogRow({ entry }: { entry: LogEntry }) {
  return (
    <div className={`log-row ${entry.level}`}>
      <span>{formatClock(entry.time)}</span>
      <p>{entry.message}</p>
    </div>
  );
}
