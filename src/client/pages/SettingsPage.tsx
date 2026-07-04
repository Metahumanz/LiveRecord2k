import { Bell, FileCode2, FolderOpen, HardDrive, LogIn, QrCode, Save, Video } from 'lucide-react';
import { recorder } from '../recorderClient';
import { PageHeader, SettingPanel, Toggle } from '../components/common';
import type { AppSettings, AppState } from '../types';
import { containerOptions, danmakuAreaOptions, overlayModeOptions, qnOptions } from '../ui/options';
import { burnCodecOptions, burnCodecSummary } from '../utils';

export function SettingsPage({
  state,
  settingsDraft,
  busy,
  run,
  saveSettings,
  chooseOutputDir,
  setSettingsDraft
}: {
  state: AppState;
  settingsDraft: AppSettings;
  busy: string | null;
  run: <T>(key: string, action: () => Promise<T>) => Promise<void>;
  saveSettings: (settings: Partial<AppSettings>, message?: string) => Promise<void>;
  chooseOutputDir: () => Promise<void>;
  setSettingsDraft: (settings: AppSettings) => void;
}) {
  const loggedIn = settingsDraft.cookie.includes('SESSDATA=');
  const codecOptions = burnCodecOptions(state.ffmpegCapabilities?.burnCodecs, settingsDraft.burnCodec);
  const selectedCodec = codecOptions.find((option) => option.value === settingsDraft.burnCodec);
  const unavailableHardware = (state.ffmpegCapabilities?.unavailableBurnCodecs || []).filter(
    (option) => option.kind === 'hardware'
  );
  const unavailableHardwareText = unavailableHardware
    .map((option) => `${option.label}：${option.reason || '不可用'}`)
    .join('；');

  return (
    <>
      <PageHeader
        title="录制配置"
        subtitle="先完成登录和输出目录；画质、弹幕视频和通知按需要再调整。"
        actions={
          <button
            className="wide-button primary"
            disabled={busy === 'save-settings'}
            onClick={() => saveSettings(settingsDraft)}
          >
            <Save size={18} />
            保存录制配置
          </button>
        }
      />

      <section className="settings-page-grid">
        <SettingPanel title="开始使用" icon={<LogIn size={18} />} className="settings-panel-start">
          <p className="panel-intro">第一次使用只需要完成扫码登录、选择输出目录，然后保存配置。</p>
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
              <button
                className="icon-button"
                title="打开目录"
                disabled={!settingsDraft.outputDir.trim() || busy === 'open-output-draft'}
                onClick={() => run('open-output-draft', () => recorder.openPathDir(settingsDraft.outputDir, { asDirectory: true }))}
              >
                <HardDrive size={18} />
              </button>
            </div>
          </label>
          <p className="field-help">建议选择空间充足的磁盘。原始录像、弹幕记录和弹幕视频都会保存在这里。</p>

          <button
            className="wide-button fill primary"
            type="button"
            disabled={busy === 'save-settings'}
            onClick={() => saveSettings(settingsDraft, '开始配置已保存')}
          >
            <Save size={18} />
            保存开始配置
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
              <span>默认显示区域</span>
              <select
                value={settingsDraft.burnDanmakuArea}
                onChange={(event) =>
                  setSettingsDraft({
                    ...settingsDraft,
                    burnDanmakuArea: event.target.value as AppSettings['burnDanmakuArea']
                  })
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
              label="总览页显示下一步提示"
              checked={!settingsDraft.hideOverviewNextStep}
              onChange={(checked) => setSettingsDraft({ ...settingsDraft, hideOverviewNextStep: !checked })}
            />
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
              disabled={busy === 'save-settings'}
              onClick={() => saveSettings(settingsDraft, '通知和启动配置已保存')}
            >
              <Save size={18} />
              保存通知配置
            </button>
          </div>
        </SettingPanel>
      </section>
    </>
  );
}
