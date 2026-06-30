import { useRef } from 'react';
import { Bell, Clock3, Download, FileCode2, FolderOpen, HardDrive, LogIn, Power, QrCode, RefreshCw, Save, Upload, Video } from 'lucide-react';
import { recorder } from '../recorderClient';
import { PageHeader, PathLine, SettingPanel, Toggle, UpdateProgress } from '../components/common';
import type { AppSettings, AppState } from '../types';
import { containerOptions, overlayModeOptions, qnOptions } from '../ui/options';
import {
  burnCodecOptions,
  burnCodecSummary,
  ffmpegCodecSummary,
  parseChangelog,
  parseSettingsImport,
  pickSettings,
  settingsExportStamp,
  videoAdapterSummary
} from '../utils';
import changelogText from '../../../CHANGELOG.md?raw';

const changelogEntries = parseChangelog(changelogText);

export function SettingsPage({
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
  const importInputRef = useRef<HTMLInputElement | null>(null);
  const codecOptions = burnCodecOptions(state.ffmpegCapabilities?.burnCodecs, settingsDraft.burnCodec);

  function exportSettings() {
    if (
      settingsDraft.cookie.trim() &&
      !window.confirm('导出的设置包含登录凭证 Cookie，请妥善保管。继续导出？')
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
      window.alert(error instanceof Error ? error.message : '导入设置失败。');
    }
  }

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
        <SettingPanel title="设置备份" icon={<FileCode2 size={18} />} className="settings-panel-backup">
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
          <div className="split-buttons">
            <button className="wide-button fill" type="button" onClick={exportSettings}>
              <Download size={18} />
              导出设置
            </button>
            <button
              className="wide-button fill primary"
              type="button"
              disabled={busy === 'import-settings'}
              onClick={() => importInputRef.current?.click()}
            >
              <Upload size={18} />
              导入设置
            </button>
          </div>
        </SettingPanel>

        <SettingPanel title="账号登录" icon={<LogIn size={18} />} className="settings-panel-account">
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

        <SettingPanel title="录制参数" icon={<Video size={18} />} className="settings-panel-recording">
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
              <span>源流清晰度优先级</span>
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
              <span>最终输出容器</span>
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
              <p className="inline-status">{burnCodecSummary(codecOptions)}</p>
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
                label="默认预览图"
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

        <SettingPanel title="启动和通知" icon={<Bell size={18} />} className="settings-panel-notifications">
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

        <SettingPanel title="版本更新" icon={<Download size={18} />} className="settings-panel-update">
          <PathLine label="当前版本" value={state.version || '-'} />
          <PathLine label="最新版本" value={state.update.latestVersion || '尚未检查'} />
          <PathLine label="更新状态" value={state.update.message || '尚未检查更新'} />
          <PathLine label="更新日志" value={state.update.updateLogPath || ''} />
          <PathLine label="状态文件" value={state.update.statusPath || ''} />
          <PathLine label="下载文件" value={state.update.packagePath || ''} />
          <UpdateProgress update={state.update} />
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
                busy === 'update-download' ||
                ['checking', 'queued', 'downloading', 'ready', 'applying'].includes(state.update.status)
              }
              onClick={() => run('update-download', recorder.downloadUpdate)}
            >
              <Download size={18} />
              下载安装器
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
                  录制结束后安装
                </button>
              ) : (
                <button
                  className="wide-button fill primary"
                  type="button"
                  disabled={busy === 'update-apply'}
                  onClick={() => run('update-apply', recorder.applyUpdate)}
                >
                  <Download size={18} />
                  启动安装器
                </button>
              )
            ) : null}
          </div>
          {state.update.packagePath ? (
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

        <SettingPanel title="运行路径" icon={<HardDrive size={18} />} className="settings-panel-runtime">
          <PathLine label="当前版本" value={state.version || ''} />
          <PathLine label="当前端口" value={String(state.currentPort || '')} />
          <PathLine label="配置文件" value={state.storePath || ''} />
          <PathLine label="应用目录" value={state.appRoot || ''} />
          <PathLine label="网页目录" value={state.distRoot || ''} />
          <PathLine label="ffmpeg" value={state.ffmpegPath || ''} />
          <PathLine label="显卡" value={videoAdapterSummary(state)} />
          <PathLine label="可用编码" value={ffmpegCodecSummary(state)} />
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
