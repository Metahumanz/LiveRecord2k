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
        subtitle="先完成登录和输出目录；画质、弹幕视频、通知和维护设置可以按需要再调整。"
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
        <SettingPanel title="开始使用" icon={<LogIn size={18} />} className="settings-panel-start">
          <p className="panel-intro">第一次使用只需要完成扫码登录、选择输出目录，然后保存设置。</p>
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
          <p className="field-help">登录用于请求更高画质源流。扫码成功后，登录凭证会自动写入下面的输入框。</p>
          <label className="field">
            <span>登录凭证 Cookie</span>
            <textarea
              rows={4}
              value={settingsDraft.cookie}
              onChange={(event) => setSettingsDraft({ ...settingsDraft, cookie: event.target.value })}
              placeholder="扫码成功后自动写入"
            />
          </label>
          {state.login ? <p className="inline-status">{state.login.message}</p> : null}

          <label className="field">
            <span>录像保存目录</span>
            <div className="path-row">
              <input
                value={settingsDraft.outputDir}
                onChange={(event) => setSettingsDraft({ ...settingsDraft, outputDir: event.target.value })}
                placeholder="例如 C:\Users\你的用户名\Videos\哔哩录播2K"
              />
              <button className="icon-button" title="选择目录" onClick={chooseOutputDir}>
                <FolderOpen size={18} />
              </button>
              <button className="icon-button" title="打开目录" onClick={() => run('open-output', recorder.openOutputDir)}>
                <HardDrive size={18} />
              </button>
            </div>
          </label>
          <p className="field-help">建议选择空间充足的磁盘。原始录像、弹幕记录和弹幕视频都会保存在这里。</p>

          <button
            className="wide-button fill primary"
            type="button"
            disabled={busy === 'save-settings'}
            onClick={() => run('save-settings', () => recorder.saveSettings(settingsDraft))}
          >
            <Save size={18} />
            保存开始设置
          </button>
        </SettingPanel>

        <SettingPanel title="录制质量" icon={<Video size={18} />} className="settings-panel-quality">
          <div className="settings-grid">
            <label className="field">
              <span>清晰度优先级</span>
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
              <p className="field-help">这是请求优先级，不保证平台一定返回该清晰度。</p>
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
              <p className="field-help">推荐 MP4。遇到个别源流无法封装时，再切换为 MKV。</p>
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
              <p className="field-help">长时间录制会按这个时长分段，便于保存和导出。</p>
            </label>
          </div>

          <div className="toggle-list inline-toggles">
            <Toggle
              label="H.265 优先"
              checked={settingsDraft.preferHevc}
              onChange={(checked) => setSettingsDraft({ ...settingsDraft, preferHevc: checked })}
            />
            <p className="field-help">开启后会优先选择 H.265 源流，但实际编码仍以平台返回为准。</p>
            <Toggle
              label="直播间卡片默认显示预览图"
              checked={settingsDraft.roomImageMode === 'keyframe'}
              onChange={(checked) =>
                setSettingsDraft({ ...settingsDraft, roomImageMode: checked ? 'keyframe' : 'cover' })
              }
            />
          </div>
        </SettingPanel>

        <SettingPanel title="弹幕视频" icon={<FileCode2 size={18} />} className="settings-panel-danmaku">
          <div className="toggle-list">
            <Toggle
              label="录制结束后自动生成弹幕视频"
              checked={settingsDraft.autoBurnDanmaku}
              onChange={(checked) => setSettingsDraft({ ...settingsDraft, autoBurnDanmaku: checked })}
            />
          </div>

          <div className="settings-grid">
            <label className="field">
              <span>弹幕视频内容</span>
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
              <p className="field-help">选择是否把礼物、舰长等互动也画进弹幕视频。</p>
            </label>

            <label className="field">
              <span>弹幕视频编码</span>
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
              <p className="field-help">{burnCodecSummary(codecOptions)}</p>
            </label>

            <label className="field">
              <span>画质参数 CRF</span>
              <input
                type="number"
                min={16}
                max={35}
                value={settingsDraft.burnCrf}
                onChange={(event) =>
                  setSettingsDraft({ ...settingsDraft, burnCrf: Number(event.target.value) })
                }
              />
              <p className="field-help">数字越小画质越高、文件越大；常用范围是 18 到 28。</p>
            </label>
          </div>
        </SettingPanel>

        <SettingPanel title="通知和启动" icon={<Bell size={18} />} className="settings-panel-notifications">
          <div className="setting-row startup-row">
            <span className={state.startupEnabled ? 'badge on' : 'badge'}>
              {state.startupEnabled ? '开机自启已开启' : '开机自启未开启'}
            </span>
          </div>
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
              <span>监听间隔（秒）</span>
              <input
                type="number"
                min={5}
                max={300}
                value={settingsDraft.pollIntervalSec}
                onChange={(event) =>
                  setSettingsDraft({ ...settingsDraft, pollIntervalSec: Number(event.target.value) })
                }
              />
              <p className="field-help">开启监听后，应用会按这个间隔刷新直播间状态。</p>
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
              label="开始生成弹幕视频通知"
              checked={settingsDraft.notifyBurnStarted}
              onChange={(checked) => setSettingsDraft({ ...settingsDraft, notifyBurnStarted: checked })}
            />
            <Toggle
              label="弹幕视频完成通知"
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

        <SettingPanel title="高级维护" icon={<HardDrive size={18} />} className="settings-panel-advanced">
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

          <div className="maintenance-section">
            <h3>设置备份</h3>
            <p className="field-help">导出文件会包含登录凭证 Cookie，只建议保存在自己的电脑里。</p>
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
          </div>

          <div className="maintenance-section">
            <h3>版本更新</h3>
            <PathLine label="当前版本" value={state.version || '-'} />
            <PathLine label="最新版本" value={state.update.latestVersion || '尚未检查'} />
            <PathLine label="更新状态" value={state.update.message || '尚未检查更新'} />
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
              {(state.update.status === 'available' || state.update.status === 'blocked') && hasActiveJobs ? (
                <button
                  className="wide-button fill active"
                  type="button"
                  disabled={busy === 'update-queue'}
                  onClick={() => run('update-queue', recorder.queueUpdate)}
                >
                  <Clock3 size={18} />
                  结束后下载
                </button>
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
          </div>

          <div className="maintenance-section">
            <h3>运行信息</h3>
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
                  <option value="0.0.0.0">局域网 0.0.0.0</option>
                </select>
                <p className="field-help">选择 0.0.0.0 后，其它电脑可用本机局域网 IP 加端口访问；可能需要放行 Windows 防火墙。</p>
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
                <span>更新源</span>
                <input
                  value={settingsDraft.updateManifestUrl}
                  onChange={(event) => setSettingsDraft({ ...settingsDraft, updateManifestUrl: event.target.value })}
                />
              </label>
            </div>
            <PathLine label="当前监听" value={`${state.currentHost || '127.0.0.1'}:${state.currentPort || ''}`} />
            <PathLine label="当前端口" value={String(state.currentPort || '')} />
            <PathLine label="配置文件" value={state.storePath || ''} />
            <PathLine label="应用目录" value={state.appRoot || ''} />
            <PathLine label="网页目录" value={state.distRoot || ''} />
            <PathLine label="ffmpeg" value={state.ffmpegPath || ''} />
            <PathLine label="显卡" value={videoAdapterSummary(state)} />
            <PathLine label="可用编码" value={ffmpegCodecSummary(state)} />
            <PathLine label="更新日志" value={state.update.updateLogPath || ''} />
            <PathLine label="状态文件" value={state.update.statusPath || ''} />
            <PathLine label="下载文件" value={state.update.packagePath || ''} />
            <div className="split-buttons">
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
            </div>
          </div>
        </SettingPanel>
      </section>
    </>
  );
}
