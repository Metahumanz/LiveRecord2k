import { useEffect, useState } from 'react';
import type React from 'react';
import { Bell, FileCode2, FolderOpen, HardDrive, LogIn, QrCode, Video } from 'lucide-react';
import { recorder } from '../recorderClient';
import { PageHeader, SettingPanel, Toggle } from '../components/common';
import type { AppSettings, AppState, DiskSpaceState } from '../types';
import {
  burnAvatarModeOptions,
  containerOptions,
  danmakuAreaOptions,
  danmakuStylePresetOptions,
  overlayModeOptions,
  qnOptions
} from '../ui/options';
import { burnCodecOptions, burnCodecSummary, formatFileSize, isBilibiliLoggedIn } from '../utils';

export function SettingsPage({
  state,
  settingsDraft,
  busy,
  run,
  chooseOutputDir,
  updateSettingsDraft,
  commitSettingsDraft,
  settingsSaveStatus,
  settingsSaveError,
  retrySettingsSave,
  dirtyFields
}: {
  state: AppState;
  settingsDraft: AppSettings;
  busy: Set<string>;
  run: <T>(key: string, action: () => Promise<T>) => Promise<boolean>;
  chooseOutputDir: () => Promise<void>;
  updateSettingsDraft: (
    settings: Partial<AppSettings>,
    options?: { saveMode?: 'immediate' | 'debounced' | 'commit' }
  ) => void;
  commitSettingsDraft: (keys: Array<keyof AppSettings>) => Promise<boolean>;
  settingsSaveStatus: 'idle' | 'dirty' | 'saving' | 'saved' | 'error';
  settingsSaveError: string;
  retrySettingsSave: () => void;
  dirtyFields: Set<keyof AppSettings>;
}) {
  const loggedIn = isBilibiliLoggedIn(state);
  const isLinux = state.platform === 'linux';
  const canPickServerPath = state.uiCapabilities?.nativePathPicker ?? !isLinux;
  const canOpenServerPath = state.uiCapabilities?.openServerPath ?? !isLinux;
  const canUseNativeNotifications = state.uiCapabilities?.nativeNotifications ?? !isLinux;
  const canControlStartup = state.uiCapabilities?.startupControl ?? !isLinux;
  const codecOptions = burnCodecOptions(state.ffmpegCapabilities?.burnCodecs, settingsDraft.burnCodec);
  const selectedCodec = codecOptions.find((option) => option.value === settingsDraft.burnCodec);
  const unavailableHardware = (state.ffmpegCapabilities?.unavailableBurnCodecs || []).filter(
    (option) => option.kind === 'hardware'
  );
  const unavailableHardwareText = unavailableHardware
    .map((option) => `${option.label}：${option.reason || '不可用'}`)
    .join('；');
  const [diskSpace, setDiskSpace] = useState<DiskSpaceState | null>(state.outputDiskSpace || null);

  function updateSetting(nextSettings: Partial<AppSettings>, saveMode: 'immediate' | 'debounced' | 'commit' = 'immediate') {
    updateSettingsDraft(nextSettings, { saveMode });
  }

  function commitSetting(...keys: Array<keyof AppSettings>) {
    void commitSettingsDraft(keys);
  }

  function commitOnEnter(event: React.KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>) {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    event.currentTarget.blur();
  }

  useEffect(() => {
    const targetPath = settingsDraft.outputDir.trim();
    if (!targetPath) {
      setDiskSpace(null);
      return;
    }
    let cancelled = false;
    const timer = window.setTimeout(() => {
      recorder
        .getDiskSpace(targetPath)
        .then((result) => {
          if (!cancelled) setDiskSpace(result);
        })
        .catch((error) => {
          if (!cancelled) {
            setDiskSpace({
              requestedPath: targetPath,
              checkedPath: '',
              totalBytes: 0,
              freeBytes: 0,
              usedBytes: 0,
              usedPercent: 0,
              checkedAt: Date.now(),
              error: error instanceof Error ? error.message : '磁盘空间检查失败'
            });
          }
        });
    }, 450);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [settingsDraft.outputDir]);

  return (
    <>
      <PageHeader
        title="录制配置"
        subtitle={isLinux
          ? '先完成登录和服务端录像目录；画质、弹幕视频和监听参数会自动保存。'
          : '先完成登录和输出目录；画质、弹幕视频和通知会自动保存。'}
        actions={
          <div className={`inline-status ${settingsSaveStatus === 'error' ? 'error' : ''}`} aria-live="polite">
            {settingsSaveStatus === 'error' ? (
              <button className="link-button" type="button" onClick={retrySettingsSave}>
                保存失败 · 重试{settingsSaveError ? `：${settingsSaveError}` : ''}
              </button>
            ) : settingsSaveStatus === 'saving' ? (
              `保存中${dirtyFields.size ? `（${dirtyFields.size} 项）` : ''}`
            ) : settingsSaveStatus === 'dirty' ? (
              `待保存${dirtyFields.size ? `（${dirtyFields.size} 项）` : ''}`
            ) : settingsSaveStatus === 'saved' ? (
              '已保存'
            ) : (
              '修改后自动保存'
            )}
          </div>
        }
      />

      <section className="settings-page-grid">
        <SettingPanel title="开始使用" icon={<LogIn size={18} />} className="settings-panel-start">
          <p className="panel-intro">
            {isLinux
              ? '第一次使用只需要完成扫码登录、填写服务端录像目录；修改会自动保存。'
              : '第一次使用只需要完成扫码登录、选择输出目录；修改会自动保存。'}
          </p>
          <div className="setting-row">
            <span className={loggedIn ? 'badge on' : 'badge'}>{loggedIn ? '已登录' : '未登录'}</span>
            <button
              className="wide-button primary"
              disabled={busy.has('qr-login')}
              onClick={() => run('qr-login', recorder.startQrLogin)}
            >
              <QrCode size={18} />
              扫码登录
            </button>
          </div>
          <p className="field-help">
            登录用于请求更高画质源流。
            {state.bilibiliCookieVisible === false
              ? '远程访问时凭证由服务端安全保存，页面只显示登录状态，不回传 Cookie 明文。'
              : '扫码成功后，登录凭证会自动写入下面的输入框。'}
          </p>
          {state.bilibiliCookieVisible === false ? (
            <p className="inline-status">
              {loggedIn
                ? '登录凭证已安全保存在服务端；需要更新凭证时请重新扫码。'
                : '服务端尚未保存登录凭证，请点击扫码登录。'}
            </p>
          ) : (
            <label className="field">
              <span>登录凭证 Cookie</span>
              <textarea
                rows={4}
                value={settingsDraft.cookie}
                onChange={(event) => updateSetting({ cookie: event.target.value }, 'commit')}
                onBlur={() => commitSetting('cookie')}
                onKeyDown={commitOnEnter}
                placeholder="扫码成功后自动写入"
              />
            </label>
          )}
          {state.login ? <p className="inline-status">{state.login.message}</p> : null}

          <label className="field">
            <span>录像保存目录</span>
            <div className="path-row">
              <input
                value={settingsDraft.outputDir}
                onChange={(event) => updateSetting({ outputDir: event.target.value }, 'commit')}
                onBlur={() => commitSetting('outputDir')}
                onKeyDown={commitOnEnter}
                placeholder={isLinux ? '/var/lib/bili-record-2k/recordings' : '例如 C:\\Users\\你的用户名\\Videos\\哔哩录播2K'}
              />
              {canPickServerPath ? (
                <button
                  className="icon-button"
                  title="选择目录"
                  disabled={busy.has('choose-output-dir')}
                  onClick={chooseOutputDir}
                >
                  <FolderOpen size={18} />
                </button>
              ) : null}
              {canOpenServerPath ? (
                <button
                  className="icon-button"
                  title="打开目录"
                  disabled={!settingsDraft.outputDir.trim() || busy.has('open-output-draft')}
                  onClick={() => run('open-output-draft', () => recorder.openPathDir(settingsDraft.outputDir, { asDirectory: true }))}
                >
                  <HardDrive size={18} />
                </button>
              ) : null}
            </div>
          </label>
          {isLinux ? <p className="field-help">请填写 Linux 服务端绝对路径；目录选择器不会操作你当前浏览器所在的电脑。</p> : null}
          <p className={diskSpace?.error ? 'field-help disk-space error' : 'field-help disk-space'}>
            {diskSpace?.error
              ? `剩余空间暂时无法读取：${diskSpace.error}`
              : diskSpace && diskSpace.totalBytes > 0
                ? `剩余 ${formatFileSize(diskSpace.freeBytes)} / 共 ${formatFileSize(diskSpace.totalBytes)}（已用 ${diskSpace.usedPercent.toFixed(1)}%）`
                : '正在读取剩余磁盘空间…'}
          </p>

        </SettingPanel>

        <SettingPanel title="录制质量" icon={<Video size={18} />} className="settings-panel-quality">
          <div className="settings-grid">
            <label className="field">
              <span>清晰度优先级</span>
              <select
                value={settingsDraft.targetQn}
                onChange={(event) => updateSetting({ targetQn: Number(event.target.value) })}
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
                onChange={(event) => updateSetting({ outputContainer: event.target.value as AppSettings['outputContainer'] })}
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
                onChange={(event) => updateSetting({ segmentMinutes: Number(event.target.value) }, 'commit')}
                onBlur={() => commitSetting('segmentMinutes')}
                onKeyDown={commitOnEnter}
              />
              <p className="field-help">长时间录制会按这个时长分段，便于保存和导出。</p>
            </label>
          </div>

          <div className="toggle-list inline-toggles">
            <Toggle
              label="H.265 优先"
              checked={settingsDraft.preferHevc}
              onChange={(checked) => updateSetting({ preferHevc: checked })}
            />
            <p className="field-help">开启后会优先选择 H.265 源流，但实际编码仍以平台返回为准。</p>
            <Toggle
              label="直播间卡片默认显示预览图"
              checked={settingsDraft.roomImageMode === 'keyframe'}
              onChange={(checked) => updateSetting({ roomImageMode: checked ? 'keyframe' : 'cover' })}
            />
          </div>
        </SettingPanel>

        <SettingPanel title="弹幕视频" icon={<FileCode2 size={18} />} className="settings-panel-danmaku">
          <div className="toggle-list">
            <Toggle
              label="录制结束后自动生成弹幕视频"
              checked={settingsDraft.autoBurnDanmaku}
              onChange={(checked) =>
                updateSetting({
                  autoBurnDanmaku: checked,
                  deleteSourceAfterBurn: checked ? settingsDraft.deleteSourceAfterBurn : false
                })
              }
            />
            <Toggle
              label="弹幕视频烧录完成后自动删除无弹幕源文件"
              checked={settingsDraft.deleteSourceAfterBurn}
              disabled={!settingsDraft.autoBurnDanmaku}
              onChange={(checked) => updateSetting({ deleteSourceAfterBurn: checked })}
            />
            <p className="field-help">
              仅自动烧录生效：有弹幕成片已验证、且续录分段清理完成后才删除无弹幕源视频；手动烧录、取消或失败都不会删除。
            </p>
          </div>

          <div className="settings-grid">
            <label className="field">
              <span>弹幕视频内容</span>
              <select
                value={settingsDraft.burnOverlayMode}
                onChange={(event) =>
                  updateSetting({ burnOverlayMode: event.target.value as AppSettings['burnOverlayMode'] })
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
              <span>默认显示区域</span>
              <select
                value={settingsDraft.burnDanmakuArea}
                onChange={(event) =>
                  updateSetting({ burnDanmakuArea: event.target.value as AppSettings['burnDanmakuArea'] })
                }
              >
                {danmakuAreaOptions.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
              <p className="field-help">与 B 站直播的显示区域选项一致；手动生成前也可以临时调整。</p>
            </label>

            <label className="field">
              <span>默认弹幕样式</span>
              <select
                value={settingsDraft.burnDanmakuStylePreset}
                onChange={(event) =>
                  updateSetting({
                    burnDanmakuStylePreset: event.target.value as AppSettings['burnDanmakuStylePreset'],
                    burnDanmakuStyleLayout: {}
                  })
                }
              >
                {danmakuStylePresetOptions.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </label>

            <label className="field">
              <span>真实头像</span>
              <select
                value={settingsDraft.burnAvatarMode}
                onChange={(event) =>
                  updateSetting({ burnAvatarMode: event.target.value as AppSettings['burnAvatarMode'] })
                }
              >
                {burnAvatarModeOptions.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
              <p className="field-help">
                仅“侧边互动流”和“侧边气泡流”使用。高质量使用整场录制到的全部真实头像，少量最多 6 个；NVIDIA 硬编会自动用 CUDA 合成。
              </p>
            </label>

            <label className="field">
              <span>弹幕视频编码</span>
              <select
                value={settingsDraft.burnCodec}
                onChange={(event) => updateSetting({ burnCodec: event.target.value })}
              >
                {codecOptions.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
              <p className="field-help">
                当前使用{selectedCodec?.kind === 'hardware' ? '硬件' : '软件'}编码 {settingsDraft.burnCodec}；{burnCodecSummary(codecOptions)}
              </p>
              {unavailableHardwareText ? <p className="field-help">不可用硬编：{unavailableHardwareText}</p> : null}
            </label>

            <label className="field">
              <span>画质参数 CRF</span>
              <input
                type="number"
                min={16}
                max={35}
                value={settingsDraft.burnCrf}
                onChange={(event) => updateSetting({ burnCrf: Number(event.target.value) }, 'commit')}
                onBlur={() => commitSetting('burnCrf')}
                onKeyDown={commitOnEnter}
              />
              <p className="field-help">数字越小画质越高、文件越大；常用范围是 18 到 28。</p>
            </label>
          </div>
        </SettingPanel>

        <SettingPanel
          title={isLinux ? '监听与 systemd' : '通知和启动'}
          icon={<Bell size={18} />}
          className="settings-panel-notifications"
        >
          <div className="setting-row startup-row">
            <span className={state.startupEnabled ? 'badge on' : 'badge'}>
              {state.platform === 'linux'
                ? state.startupEnabled
                  ? 'systemd 服务已启用'
                  : 'systemd 服务未启用'
                : state.startupEnabled
                  ? '开机自启已开启'
                  : '开机自启未开启'}
            </span>
          </div>
          {isLinux ? (
            <p className="panel-intro">
              Linux 安装版由 systemd 管理进程和开机启动；浏览器可以关闭，录制与监听仍会在服务端继续运行。
            </p>
          ) : null}
          <p className="panel-intro">
            通知事件可发送到通用 Webhook；Windows 桌面版还会同时显示系统通知。Webhook 由服务端直接发送，浏览器关闭后仍然有效。
          </p>
          <div className="toggle-list">
            {canControlStartup ? (
              <Toggle
                label="开机自启"
                checked={state.startupEnabled}
                disabled={busy.has('startup')}
                onChange={(checked) => run('startup', () => recorder.setStartup(checked))}
              />
            ) : null}
            {!isLinux ? (
              <Toggle
                label="启动时打开浏览器"
                checked={settingsDraft.openBrowserOnStart}
                onChange={(checked) => updateSetting({ openBrowserOnStart: checked })}
              />
            ) : null}
            <label className="field">
              <span>监听间隔（秒）</span>
              <input
                type="number"
                min={1}
                max={300}
                value={settingsDraft.pollIntervalSec}
                onChange={(event) => updateSetting({ pollIntervalSec: Number(event.target.value) }, 'commit')}
                onBlur={() => commitSetting('pollIntervalSec')}
                onKeyDown={commitOnEnter}
              />
              <p className="field-help">HTTP 轮询是推送断线时的兜底；正常情况下会由直播弹幕连接即时触发开播。</p>
            </label>
            <Toggle
              label="总览页显示下一步提示"
              checked={!settingsDraft.hideOverviewNextStep}
              onChange={(checked) => updateSetting({ hideOverviewNextStep: !checked })}
            />
            <Toggle
              label="启用通用 Webhook"
              checked={settingsDraft.webhookEnabled}
              onChange={(checked) => updateSetting({ webhookEnabled: checked })}
            />
            <label className="field">
              <span>Webhook 接收地址</span>
              <input
                type="url"
                inputMode="url"
                placeholder="https://example.com/webhook"
                value={settingsDraft.webhookUrl}
                onChange={(event) => updateSetting({ webhookUrl: event.target.value }, 'debounced')}
              />
              <p className="field-help">
                公网地址必须使用 HTTPS；DNS 和每一跳地址都会经过 SSRF 检查，重定向默认拒绝。
              </p>
            </label>
            <Toggle
              label="允许 Webhook 访问本机/私有网络"
              checked={settingsDraft.webhookAllowPrivateNetwork}
              onChange={(checked) => updateSetting({ webhookAllowPrivateNetwork: checked })}
            />
            <label className="field">
              <span>Bearer Token（可选）</span>
              <input
                type="password"
                autoComplete="new-password"
                disabled={settingsDraft.webhookBearerTokenClear}
                placeholder={
                  settingsDraft.webhookBearerTokenConfigured
                    ? '已安全保存在服务端；留空表示不修改'
                    : '接收端不需要鉴权时留空'
                }
                value={settingsDraft.webhookBearerToken}
                onChange={(event) =>
                  updateSetting({
                    webhookBearerToken: event.target.value,
                    webhookBearerTokenClear: false
                  }, 'commit')
                }
                onBlur={() => commitSetting('webhookBearerToken', 'webhookBearerTokenClear')}
                onKeyDown={commitOnEnter}
              />
              <p className="field-help">
                发送时使用 Authorization: Bearer &lt;Token&gt;；Token 不会回传到页面或写入设置导出文件。
              </p>
            </label>
            {settingsDraft.webhookBearerTokenConfigured ? (
              <Toggle
                label="保存时清除已配置的 Bearer Token"
                checked={settingsDraft.webhookBearerTokenClear}
                onChange={(checked) =>
                  updateSetting({
                    webhookBearerToken: '',
                    webhookBearerTokenClear: checked
                  })
                }
              />
            ) : null}
            <p className="field-help">
              事件类型：live.started / live.ended / recording.started / recording.completed / recording.failed /
              burn.started / burn.completed / burn.failed。
            </p>
            <Toggle
              label="开播通知"
              checked={settingsDraft.notifyLiveStarted}
              onChange={(checked) => updateSetting({ notifyLiveStarted: checked })}
            />
            <Toggle
              label="下播通知"
              checked={settingsDraft.notifyLiveEnded}
              onChange={(checked) => updateSetting({ notifyLiveEnded: checked })}
            />
            <Toggle
              label="开始录制通知"
              checked={settingsDraft.notifyRecordingStarted}
              onChange={(checked) => updateSetting({ notifyRecordingStarted: checked })}
            />
            <Toggle
              label="结束录制通知"
              checked={settingsDraft.notifyRecordingEnded}
              onChange={(checked) => updateSetting({ notifyRecordingEnded: checked })}
            />
            <Toggle
              label="开始生成弹幕视频通知"
              checked={settingsDraft.notifyBurnStarted}
              onChange={(checked) => updateSetting({ notifyBurnStarted: checked })}
            />
            <Toggle
              label="弹幕视频完成通知"
              checked={settingsDraft.notifyBurnEnded}
              onChange={(checked) => updateSetting({ notifyBurnEnded: checked })}
            />
          </div>
          <div className="split-buttons">
            {canUseNativeNotifications ? (
              <button
                className="wide-button fill"
                type="button"
                onClick={() => run('test-notification', recorder.testNotification)}
              >
                <Bell size={18} />
                测试 Windows 通知
              </button>
            ) : null}
            <button
              className="wide-button fill"
              type="button"
              disabled={busy.has('test-webhook') || !state.settings.webhookEnabled || !state.settings.webhookUrl}
              onClick={() => run('test-webhook', recorder.testWebhook)}
              title="测试使用已保存的 Webhook 配置；修改后请先保存"
            >
              <Bell size={18} />
              发送 Webhook 测试
            </button>
          </div>
        </SettingPanel>
      </section>
    </>
  );
}
