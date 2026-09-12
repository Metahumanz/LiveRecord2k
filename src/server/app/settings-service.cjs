'use strict';

const path = require('node:path');
const os = require('node:os');

/**
 * Owns settings defaults, normalization, validation and persistence flow.
 * LiveRecordService remains the host for persistence, disk preparation,
 * room-monitor rescheduling and state publication so this extraction does not
 * alter the public service contract.
 */
class SettingsService {
  constructor(owner, dependencies = {}) {
    this.owner = owner;
    Object.assign(this, dependencies);
  }

  createDefaultSettings() {
    return {
      outputDir: path.join(os.homedir(), 'Videos', '哔哩录播2K'),
      cookie: '',
      pollIntervalSec: 15,
      targetQn: 15000,
      preferHevc: true,
      roomImageMode: 'keyframe',
      outputContainer: 'mp4',
      segmentMinutes: 60,
      autoBurnDanmaku: true,
      deleteSourceAfterBurn: false,
      burnOverlayMode: 'danmaku-gift',
      burnDanmakuArea: 'half',
      burnDanmakuStylePreset: 'current',
      burnDanmakuStyleLayout: {},
      burnAvatarMode: 'high',
      burnCodec: 'libx265',
      burnCrf: 24,
      notifyLiveStarted: true,
      notifyLiveEnded: true,
      notifyRecordingStarted: true,
      notifyRecordingEnded: true,
      notifyBurnStarted: true,
      notifyBurnEnded: true,
      webhookEnabled: false,
      webhookUrl: '',
      webhookBearerToken: '',
      webhookAllowPrivateNetwork: false,
      openBrowserOnStart: true,
      hideOverviewNextStep: false,
      autoUpdateEnabled: false,
      updateManifestUrl: this.DEFAULT_UPDATE_MANIFEST_URL,
      serverHost: this.DEFAULT_HOST,
      serverPort: this.DEFAULT_PORT,
      accessUsername: 'admin',
      accessPasswordHash: '',
      trustedProxies: [],
      configBootstrapVersion: 0
    };
  }

  normalizeSettings(settings) {
    const burnCodec = Number(this.owner.ffmpegCapabilities?.probedAt || 0) > 0
      ? this.owner.chooseBurnCodec(settings.burnCodec)
      : this.normalizeBurnCodec(settings.burnCodec);
    return {
      ...this.createDefaultSettings(),
      ...settings,
      outputContainer: this.normalizeContainer(settings.outputContainer),
      burnCodec,
      pollIntervalSec: this.clamp(Number(settings.pollIntervalSec || 15), 1, 300),
      segmentMinutes: this.clamp(Number(settings.segmentMinutes || 60), 0.05, 1440),
      targetQn: this.normalizeTargetQn(settings.targetQn),
      burnCrf: this.clamp(Number(settings.burnCrf || 24), 16, 35),
      preferHevc: Boolean(settings.preferHevc),
      roomImageMode: this.normalizeRoomImageMode(settings.roomImageMode),
      autoBurnDanmaku: Boolean(settings.autoBurnDanmaku),
      deleteSourceAfterBurn: Boolean(settings.autoBurnDanmaku) && Boolean(settings.deleteSourceAfterBurn),
      burnOverlayMode: this.normalizeBurnOverlayMode(settings.burnOverlayMode),
      burnDanmakuArea: this.normalizeDanmakuDisplayArea(settings.burnDanmakuArea),
      burnDanmakuStylePreset: this.normalizeDanmakuStylePreset(settings.burnDanmakuStylePreset),
      burnDanmakuStyleLayout: this.normalizeDanmakuStyleLayout(settings.burnDanmakuStyleLayout),
      burnAvatarMode: this.normalizeBurnAvatarMode(settings.burnAvatarMode),
      notifyLiveStarted: settings.notifyLiveStarted !== false,
      notifyLiveEnded: settings.notifyLiveEnded !== false,
      notifyRecordingStarted: settings.notifyRecordingStarted !== false,
      notifyRecordingEnded: settings.notifyRecordingEnded !== false,
      notifyBurnStarted: settings.notifyBurnStarted !== false,
      notifyBurnEnded: settings.notifyBurnEnded !== false,
      webhookEnabled: Boolean(settings.webhookEnabled),
      webhookUrl: String(settings.webhookUrl || '').trim().slice(0, 2048),
      webhookBearerToken: String(settings.webhookBearerToken || '').trim().slice(0, 4096),
      webhookAllowPrivateNetwork: Boolean(settings.webhookAllowPrivateNetwork),
      openBrowserOnStart: settings.openBrowserOnStart !== false,
      hideOverviewNextStep: Boolean(settings.hideOverviewNextStep),
      autoUpdateEnabled: Boolean(settings.autoUpdateEnabled),
      updateManifestUrl: String(settings.updateManifestUrl || this.DEFAULT_UPDATE_MANIFEST_URL).trim(),
      serverHost: this.normalizeServerHost(settings.serverHost || this.DEFAULT_HOST),
      serverPort: this.clamp(Number(settings.serverPort || this.DEFAULT_PORT), 1, 65535),
      accessUsername: String(settings.accessUsername || 'admin').trim().slice(0, 64) || 'admin',
      accessPasswordHash: String(settings.accessPasswordHash || ''),
      trustedProxies: this.normalizeTrustedProxyList(settings.trustedProxies),
      configBootstrapVersion: Math.max(0, Number(settings.configBootstrapVersion || 0))
    };
  }

  async save(nextSettings, options = {}) {
    this.assertSettingsUpdate(nextSettings);
    const owner = this.owner;
    const oldPollInterval = owner.settings.pollIntervalSec;
    const oldOutputDir = owner.settings.outputDir;
    const oldAccessUsername = owner.settings.accessUsername;
    const oldAccessPasswordHash = owner.settings.accessPasswordHash;
    const oldAutoUpdateEnabled = owner.settings.autoUpdateEnabled;
    const settingsUpdate = { ...(nextSettings || {}) };
    if (options.preserveCookie) {
      delete settingsUpdate.cookie;
    }
    const accessPassword = String(settingsUpdate.accessPassword || '');
    const webhookBearerToken = String(settingsUpdate.webhookBearerToken || '').trim();
    const clearWebhookBearerToken = Boolean(settingsUpdate.webhookBearerTokenClear);
    delete settingsUpdate.accessPassword;
    delete settingsUpdate.accessAuthConfigured;
    delete settingsUpdate.accessPasswordHash;
    delete settingsUpdate.webhookBearerToken;
    delete settingsUpdate.webhookBearerTokenConfigured;
    delete settingsUpdate.webhookBearerTokenClear;
    if (accessPassword) {
      settingsUpdate.accessPasswordHash = await this.hashAccessPassword(accessPassword);
    }
    if (webhookBearerToken.length > 4096) {
      throw this.businessError('INVALID_SETTINGS', 'Webhook Bearer Token 不能超过 4096 个字符。', 400);
    }
    if (/\r|\n/.test(webhookBearerToken)) {
      throw this.businessError('INVALID_SETTINGS', 'Webhook Bearer Token 不能包含换行。', 400);
    }
    if (clearWebhookBearerToken) {
      settingsUpdate.webhookBearerToken = '';
    } else if (webhookBearerToken) {
      settingsUpdate.webhookBearerToken = webhookBearerToken;
    }
    const normalizedSettings = this.normalizeSettings({
      ...owner.settings,
      ...settingsUpdate
    });
    try {
      normalizedSettings.webhookUrl = this.normalizeWebhookUrl(normalizedSettings.webhookUrl, {
        required: normalizedSettings.webhookEnabled
      });
    } catch (error) {
      throw this.businessError('INVALID_SETTINGS', error.message || 'Webhook 配置无效。', 400);
    }
    if (this.isPublicServerHost(normalizedSettings.serverHost) && !owner.accessAuth.isConfigured(normalizedSettings)) {
      throw this.businessError('INVALID_SETTINGS', '监听 0.0.0.0/:: 前必须先在持久化配置中设置至少 8 位远程访问密码。', 400);
    }
    const outputDirChanged = oldOutputDir !== normalizedSettings.outputDir;
    let outputReady;
    try {
      outputReady = await owner.ensureRecordingOutputRootReady(normalizedSettings.outputDir, {
        label: '录像保存目录',
        allowUnavailable: !outputDirChanged,
        permissionsRequired: outputDirChanged
      });
    } catch (error) {
      throw this.businessError(
        'OUTPUT_DIR_NOT_WRITABLE',
        error?.message || '录像保存目录无法由当前服务用户读写。',
        400
      );
    }

    // Persist the candidate first.  Until this succeeds, the current settings
    // must remain the source of truth for authentication, SSE clients and room
    // monitors.  saveStore accepts the candidate specifically for this
    // prepare/commit boundary.
    await owner.saveStore({ settings: normalizedSettings });
    owner.settings = normalizedSettings;
    if (
      oldAccessUsername !== owner.settings.accessUsername ||
      oldAccessPasswordHash !== owner.settings.accessPasswordHash
    ) {
      owner.accessAuth.clearSessions();
      owner.invalidateRemoteSseClients();
      owner.log('info', '远程访问凭据已更新，已有远程会话已退出。');
    }
    if (!outputReady) {
      owner.log(
        'warn',
        `录像保存目录当前不可用，其他设置仍已保存；恢复挂载或改用新目录后才能开始新录制：${owner.settings.outputDir}`
      );
    }
    if (outputDirChanged && !owner.hasActiveJobs()) {
      setImmediate(() => {
        owner.refreshRecordingLibrary({ silent: true }).catch((error) => {
          owner.log('warn', `后台刷新录像库失败：${error.message}`);
          owner.emitState();
        });
      });
    } else if (outputDirChanged) {
      owner.log('info', '当前有录制或处理任务，已保留现有录像库；新保存目录会从下一次新录制开始使用。');
    }
    if (oldPollInterval !== owner.settings.pollIntervalSec) {
      for (const room of owner.rooms.values()) {
        if (room.monitoring) {
          owner.startMonitorTimer(room.id);
        }
      }
    }
    await owner.refreshOutputDiskSpace().catch(() => {});
    if (oldAutoUpdateEnabled !== owner.settings.autoUpdateEnabled) {
      owner.scheduleAutomaticUpdateCheck(owner.settings.autoUpdateEnabled ? 5000 : 0);
    }
    owner.log('success', '设置已保存。');
    owner.markSettingsDirty();
    return owner.getState();
  }

  assertSettingsUpdate(nextSettings) {
    if (!nextSettings || typeof nextSettings !== 'object' || Array.isArray(nextSettings)) {
      throw this.businessError('INVALID_SETTINGS', '设置内容必须是对象。', 400);
    }
    for (const key of Object.keys(nextSettings)) {
      if (!this.SETTINGS_UPDATE_KEYS.has(key)) {
        throw this.businessError('INVALID_SETTINGS', `未知设置项 ${key}。`, 400);
      }
    }
    for (const key of this.BOOLEAN_SETTINGS_UPDATE_KEYS) {
      if (key in nextSettings && typeof nextSettings[key] !== 'boolean') {
        throw this.businessError('INVALID_SETTINGS', `设置项 ${key} 必须是布尔值。`, 400);
      }
    }
    for (const [key, maxLength] of Object.entries(this.STRING_SETTINGS_UPDATE_LIMITS)) {
      if (!(key in nextSettings)) continue;
      if (typeof nextSettings[key] !== 'string') {
        throw this.businessError('INVALID_SETTINGS', `设置项 ${key} 必须是文本。`, 400);
      }
      if (nextSettings[key].length > maxLength) {
        throw this.businessError('INVALID_SETTINGS', `设置项 ${key} 不能超过 ${maxLength} 个字符。`, 400);
      }
    }
    const numericRanges = {
      pollIntervalSec: [1, 300, '监听轮询间隔必须在 1 到 300 秒之间。'],
      targetQn: [1, 100000, '目标画质必须是有效的正整数。'],
      segmentMinutes: [0.05, 1440, '分段时长必须在 0.05 到 1440 分钟之间。'],
      burnCrf: [16, 35, '烧录 CRF 必须在 16 到 35 之间。'],
      serverPort: [1, 65535, '服务端口必须在 1 到 65535 之间。']
    };
    for (const [key, [min, max, message]] of Object.entries(numericRanges)) {
      if (!(key in nextSettings)) continue;
      if (typeof nextSettings[key] !== 'number') {
        throw this.businessError('INVALID_SETTINGS', `设置项 ${key} 必须是数字。`, 400);
      }
      const value = nextSettings[key];
      if (!Number.isFinite(value) || value < min || value > max) {
        throw this.businessError('INVALID_SETTINGS', message, 400);
      }
    }
    const enumValues = {
      roomImageMode: ['cover', 'keyframe'],
      outputContainer: ['mp4', 'mkv'],
      burnOverlayMode: ['danmaku', 'danmaku-gift'],
      burnDanmakuArea: ['quarter', 'half', 'three-quarter', 'no-overlap', 'unlimited'],
      burnAvatarMode: ['off', 'limited', 'high'],
      serverHost: ['127.0.0.1', '0.0.0.0', 'localhost', '::']
    };
    for (const [key, values] of Object.entries(enumValues)) {
      if (key in nextSettings && !values.includes(nextSettings[key])) {
        throw this.businessError('INVALID_SETTINGS', `设置项 ${key} 的值无效。`, 400);
      }
    }
    if ('burnCodec' in nextSettings && !this.BURN_CODEC_VALUES.has(nextSettings.burnCodec)) {
      throw this.businessError('INVALID_SETTINGS', '烧录编码器的值无效。', 400);
    }
    if (
      'burnDanmakuStylePreset' in nextSettings &&
      this.normalizeDanmakuStylePreset(nextSettings.burnDanmakuStylePreset) !== nextSettings.burnDanmakuStylePreset
    ) {
      throw this.businessError('INVALID_SETTINGS', '弹幕样式预设的值无效。', 400);
    }
    if (
      'burnDanmakuStyleLayout' in nextSettings &&
      (!nextSettings.burnDanmakuStyleLayout ||
        typeof nextSettings.burnDanmakuStyleLayout !== 'object' ||
        Array.isArray(nextSettings.burnDanmakuStyleLayout))
    ) {
      throw this.businessError('INVALID_SETTINGS', '弹幕样式布局必须是对象。', 400);
    }
    if ('trustedProxies' in nextSettings) {
      const proxies = nextSettings.trustedProxies;
      if (
        !Array.isArray(proxies) ||
        proxies.length > 32 ||
        proxies.some((rule) => typeof rule !== 'string' || !this.isValidTrustedProxyRule(rule))
      ) {
        throw this.businessError('INVALID_SETTINGS', '可信反向代理必须是最多 32 个 IP、CIDR 或 loopback 规则。', 400);
      }
    }
    if ('outputDir' in nextSettings && !String(nextSettings.outputDir || '').trim()) {
      throw this.businessError('INVALID_SETTINGS', '录像保存目录不能为空。', 400);
    }
  }
}

module.exports = { SettingsService };
