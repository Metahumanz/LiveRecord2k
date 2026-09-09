const assert = require('node:assert/strict');
const test = require('node:test');

const { LiveRecordService } = require('../src/server/app/service.cjs');
const { SettingsService } = require('../src/server/app/settings-service.cjs');

test('LiveRecordService 将设置默认值、归一化、校验与保存委托给 SettingsService', async () => {
  const service = new LiveRecordService();
  assert.ok(service.settingsService instanceof SettingsService);

  const defaults = service.createDefaultSettings();
  const normalized = service.normalizeSettings({ ...defaults, pollIntervalSec: 999 });
  assert.equal(normalized.pollIntervalSec, 300);
  assert.throws(() => service.assertSettingsUpdate({ unknownSetting: true }), {
    code: 'INVALID_SETTINGS'
  });

  let saveArguments;
  service.settingsService.save = async (...args) => {
    saveArguments = args;
    return { delegated: true };
  };
  assert.deepEqual(await service.saveSettings({ preferHevc: false }, { preserveCookie: true }), { delegated: true });
  assert.deepEqual(saveArguments, [{ preferHevc: false }, { preserveCookie: true }]);
});

test('设置落盘失败时不会提交内存设置或触发凭据副作用', async () => {
  const service = new LiveRecordService();
  const originalSettings = service.settings;
  let clearSessionCalls = 0;
  let invalidateSseCalls = 0;
  let restartMonitorCalls = 0;
  let refreshDiskCalls = 0;
  let markSettingsDirtyCalls = 0;
  service.rooms.set('monitoring-room', { id: 'monitoring-room', monitoring: true });
  service.ensureRecordingOutputRootReady = async () => true;
  service.accessAuth.sessions.set('existing-session', { expiresAt: Date.now() + 60_000 });
  const clearSessions = service.accessAuth.clearSessions.bind(service.accessAuth);
  service.accessAuth.clearSessions = () => {
    clearSessionCalls += 1;
    clearSessions();
  };
  service.invalidateRemoteSseClients = () => {
    invalidateSseCalls += 1;
  };
  service.startMonitorTimer = () => {
    restartMonitorCalls += 1;
  };
  service.refreshOutputDiskSpace = async () => {
    refreshDiskCalls += 1;
  };
  service.markSettingsDirty = () => {
    markSettingsDirtyCalls += 1;
  };
  service.saveStore = async ({ settings } = {}) => {
    assert.equal(service.settings, originalSettings);
    assert.equal(settings.serverHost, '0.0.0.0');
    assert.ok(settings.accessPasswordHash);
    throw new Error('模拟落盘失败');
  };

  await assert.rejects(
    service.saveSettings({
      serverHost: '0.0.0.0',
      accessPassword: 'new-password',
      pollIntervalSec: originalSettings.pollIntervalSec + 1
    }),
    /模拟落盘失败/
  );

  assert.equal(service.settings, originalSettings);
  assert.equal(service.settings.serverHost, originalSettings.serverHost);
  assert.equal(service.settings.accessPasswordHash, originalSettings.accessPasswordHash);
  assert.equal(service.settings.pollIntervalSec, originalSettings.pollIntervalSec);
  assert.equal(service.accessAuth.sessions.has('existing-session'), true);
  assert.equal(clearSessionCalls, 0);
  assert.equal(invalidateSseCalls, 0);
  assert.equal(restartMonitorCalls, 0);
  assert.equal(refreshDiskCalls, 0);
  assert.equal(markSettingsDirtyCalls, 0);
});
