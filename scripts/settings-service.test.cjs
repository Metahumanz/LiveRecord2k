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
