import { useRef } from 'react';
import { Clock3, Download, FolderOpen, HardDrive, Power, RefreshCw, Save, Trash2, Upload } from 'lucide-react';
import { recorder } from '../recorderClient';
import { PageHeader, PathLine, SettingPanel, Toggle, UpdateProgress } from '../components/common';
import type { AppSettings, AppState } from '../types';
import {
  ffmpegCodecSummary,
  parseChangelog,
  parseSettingsImport,
  pickSettings,
  settingsExportStamp,
  videoAdapterSummary
} from '../utils';
import changelogText from '../../../CHANGELOG.md?raw';

const changelogEntries = parseChangelog(changelogText);

export function MaintenancePage({
  state,
  settingsDraft,
  busy,
  run,
  saveSettings,
  setSettingsDraft
}: {
  state: AppState;
  settingsDraft: AppSettings;
  busy: string | null;
  run: <T>(key: string, action: () => Promise<T>) => Promise<boolean>;
  saveSettings: (settings: Partial<AppSettings>, message?: string) => Promise<void>;
  setSettingsDraft: (settings: AppSettings) => void;
}) {
  const importInputRef = useRef<HTMLInputElement | null>(null);
  const isLinux = state.platform === 'linux';
  const canOpenServerPath = state.uiCapabilities?.openServerPath ?? !isLinux;
  const canShutdownService = state.uiCapabilities?.serviceShutdown ?? !isLinux;
  const hasActiveJobs = Boolean(state.update.activeJobs);
  const currentCodec = state.ffmpegCapabilities?.burnCodecs.find((codec) => codec.value === state.settings.burnCodec);
  const unavailableCodecText = (state.ffmpegCapabilities?.unavailableBurnCodecs || [])
    .filter((codec) => codec.kind === 'hardware')
    .map((codec) => `${codec.label}：${codec.reason || '不可用'}`)
    .join('；');

  function exportSettings() {
    if (
      settingsDraft.cookie.trim() &&
      !window.confirm('导出的配置包含登录凭证 Cookie，请妥善保管。继续导出？')
    ) {
      return;
    }
    const payload = {
      app: 'BiliRecord2K',
      type: 'settings',
      version: state.version,
      exportedAt: new Date().toISOString(),
      settings: pickSettings(settingsDraft)
    };
    const blob = new Blob([`${JSON.stringify(payload, null, 2)}\n`], { type: 'application/json;charset=utf-8' });
    const url = window.URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `bili-record-2k-settings-${settingsExportStamp()}.json`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    window.setTimeout(() => window.URL.revokeObjectURL(url), 0);
  }

  async function importSettings(file?: File) {
    if (!file) {
      return;
    }
    try {
      const importedSettings = parseSettingsImport(await file.text());
      await run('import-settings', () => recorder.saveSettings(importedSettings));
    } catch (error) {
      window.alert(error instanceof Error ? error.message : '导入配置失败。');
    }
  }

  return (
    <>
      <PageHeader
        title="软件维护"
        subtitle={isLinux
          ? '备份配置、管理更新，并查看 Linux 服务、路径和编码信息。'
          : '备份配置、检查更新、查看运行信息，以及需要时重启或退出后台服务。'}
        actions={
          <button
            className="wide-button primary"
            disabled={busy === 'save-settings'}
            onClick={() => saveSettings(settingsDraft, '运行配置已保存')}
          >
            <Save size={18} />
            保存运行配置
          </button>
        }
      />

      <section className="maintenance-page-grid">
        <SettingPanel title="配置备份" icon={<HardDrive size={18} />} className="maintenance-panel-backup">
          <input
            ref={importInputRef}
            className="file-input-hidden"
            type="file"
            accept="application/json,.json"
            onChange={(event) => {
              const file = event.target.files?.[0];
              event.currentTarget.value = '';
              void importSettings(file);
            }}
          />
          <p className="panel-intro">导出文件会包含登录凭证 Cookie，只建议保存在自己的电脑里。</p>
          <div className="split-buttons">
            <button className="wide-button fill" type="button" onClick={exportSettings}>
              <Download size={18} />
              导出配置
            </button>
            <button
              className="wide-button fill primary"
              type="button"
              disabled={busy === 'import-settings'}
              onClick={() => importInputRef.current?.click()}
            >
              <Upload size={18} />
              导入配置
            </button>
          </div>
          <div className="maintenance-section">
            <h3>录像清理</h3>
            <button
              className="wide-button fill"
              type="button"
              disabled={busy === 'cleanup-merged'}
              onClick={() => run('cleanup-merged', recorder.cleanupMergedResiduals)}
            >
              <Trash2 size={18} />
              清理已合并分段残留
            </button>
          </div>
        </SettingPanel>

        <SettingPanel title="版本更新" icon={<RefreshCw size={18} />} className="maintenance-panel-update">
          <PathLine label="当前版本" value={state.version || '-'} />
          <PathLine label="最新版本" value={state.update.latestVersion || '尚未检查'} />
          <PathLine label="更新状态" value={state.update.message || '尚未检查更新'} />
          <UpdateProgress update={state.update} />
          {state.platform === 'linux' ? (
            <div className="toggle-list">
              <Toggle
                label="自动更新（每 6 小时检查，任务结束后安装）"
                checked={settingsDraft.autoUpdateEnabled}
                onChange={(checked) => setSettingsDraft({ ...settingsDraft, autoUpdateEnabled: checked })}
              />
            </div>
          ) : null}
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
            <button
              className="wide-button fill"
              type="button"
              disabled={
                busy === 'update-apply' ||
                ['checking', 'queued', 'downloading', 'ready', 'applying'].includes(state.update.status)
              }
              onClick={() => run('update-apply', recorder.applyUpdate)}
            >
              <Download size={18} />
              {state.update.autoApplySupported ? '自动安装更新' : '下载更新包'}
            </button>
            {(state.update.status === 'available' || state.update.status === 'blocked') && hasActiveJobs ? (
              <button
                className="wide-button fill active"
                type="button"
                disabled={busy === 'update-queue'}
                onClick={() => run('update-queue', recorder.queueUpdate)}
              >
                <Clock3 size={18} />
                结束后更新
              </button>
            ) : null}
          </div>
          {state.update.packagePath && canOpenServerPath ? (
            <button
              className="wide-button fill"
              type="button"
              onClick={() => run('open-update-package', () => recorder.openPathDir(state.update.packagePath || ''))}
            >
              <FolderOpen size={18} />
              打开下载目录
            </button>
          ) : null}
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

        <SettingPanel title="运行信息" icon={<HardDrive size={18} />} className="maintenance-panel-runtime">
          <div className="settings-grid">
            <label className="field">
              <span>监听地址（重启生效）</span>
              <select
                value={settingsDraft.serverHost}
                onChange={(event) =>
                  setSettingsDraft({
                    ...settingsDraft,
                    serverHost: event.target.value as AppSettings['serverHost']
                  })
                }
              >
                <option value="127.0.0.1">仅本机 127.0.0.1</option>
                <option value="0.0.0.0">外部网络 0.0.0.0</option>
              </select>
              <p className="field-help">选择 0.0.0.0 后，局域网或公网入口都会先要求登录；云服务器还应配合 HTTPS 反向代理。</p>
            </label>
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
              <p className="field-help">端口只在保存并重启后台服务后生效。</p>
            </label>
            <label className="field">
              <span>远程访问用户名</span>
              <input
                value={settingsDraft.accessUsername}
                maxLength={64}
                autoComplete="username"
                onChange={(event) => setSettingsDraft({ ...settingsDraft, accessUsername: event.target.value })}
              />
              <p className="field-help">默认 admin；只用于 WebUI 远程管理登录。</p>
            </label>
            <label className="field">
              <span>设置新的远程访问密码</span>
              <input
                type="password"
                minLength={8}
                value={settingsDraft.accessPassword}
                autoComplete="new-password"
                placeholder={settingsDraft.accessAuthConfigured ? '已配置；留空表示不修改' : '至少 8 个字符'}
                onChange={(event) => setSettingsDraft({ ...settingsDraft, accessPassword: event.target.value })}
              />
              <p className="field-help">密码只提交一次，服务端使用 scrypt 加盐哈希保存，不会回传明文。</p>
            </label>
            <label className="field">
              <span>更新源</span>
              <input
                value={settingsDraft.updateManifestUrl}
                onChange={(event) => setSettingsDraft({ ...settingsDraft, updateManifestUrl: event.target.value })}
              />
            </label>
          </div>
          <PathLine label="当前监听" value={`${state.currentHost || '127.0.0.1'}:${state.currentPort || ''}`} />
          <PathLine
            label="远程鉴权"
            value={state.access?.configured ? `已配置（用户 ${state.access.username}）` : '未配置'}
          />
          <PathLine label="当前端口" value={String(state.currentPort || '')} />
          <PathLine label="配置文件" value={state.storePath || ''} />
          <PathLine label="应用目录" value={state.appRoot || ''} />
          <PathLine label="网页目录" value={state.distRoot || ''} />
          <PathLine label="ffmpeg" value={state.ffmpegPath || ''} />
          <PathLine label="显卡" value={videoAdapterSummary(state)} />
          <PathLine label="可用编码" value={ffmpegCodecSummary(state)} />
          <PathLine
            label="当前弹幕编码"
            value={`${currentCodec?.kind === 'hardware' ? '硬件' : '软件'} ${state.settings.burnCodec}`}
          />
          <PathLine label="不可用硬编" value={unavailableCodecText || '无'} />
          <PathLine label="更新日志" value={state.update.updateLogPath || ''} />
          <PathLine label="状态文件" value={state.update.statusPath || ''} />
          <PathLine label="下载文件" value={state.update.packagePath || ''} />
          {isLinux ? (
            <p className="panel-intro">
              Linux 安装版由 systemd 管理。需要重启、停止或查看日志时，请在 SSH 中使用
              {' '}<code>sudo systemctl restart bili-record-2k</code>、
              {' '}<code>sudo systemctl stop bili-record-2k</code> 和
              {' '}<code>journalctl -u bili-record-2k -f</code>。
            </p>
          ) : null}
          <div className="split-buttons">
            {state.access?.required && state.access.authenticated ? (
              <form method="post" action="/api/access/logout">
                <button className="wide-button fill" type="submit">
                  退出远程登录
                </button>
              </form>
            ) : null}
            {canOpenServerPath ? (
              <button
                className="wide-button fill"
                type="button"
                onClick={() => run('open-config', recorder.openConfigDir)}
              >
                <FolderOpen size={18} />
                打开配置目录
              </button>
            ) : null}
            {canShutdownService ? (
              <button
                className="wide-button fill danger"
                type="button"
                disabled={busy === 'shutdown'}
                onClick={() => {
                  const message = hasActiveJobs
                    ? '当前有录制或生成弹幕视频任务，确定退出后台服务？'
                    : '确定退出后台服务？';
                  if (window.confirm(message)) {
                    run('shutdown', recorder.shutdown);
                  }
                }}
              >
                <Power size={18} />
                退出后台服务
              </button>
            ) : null}
          </div>
        </SettingPanel>
      </section>
    </>
  );
}
