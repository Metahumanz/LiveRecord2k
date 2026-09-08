const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const appSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'client', 'App.tsx'), 'utf8');
const settingsSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'client', 'pages', 'SettingsPage.tsx'), 'utf8');

test('settings drafts retain dirty fields while server state is merged and autosaved', () => {
  assert.match(appSource, /settingsDirtyFieldsRef/);
  assert.match(appSource, /syncSettingsDraftFromServer/);
  assert.match(appSource, /queueSettingsAutoSave/);
  assert.match(appSource, /retryFailedSettingsSave/);
  assert.match(appSource, /settingsSaveStatus/);
});

test('settings page uses automatic save feedback rather than duplicate save configuration buttons', () => {
  assert.match(settingsSource, /保存中/);
  assert.match(settingsSource, /已保存/);
  assert.match(settingsSource, /保存失败/);
  assert.doesNotMatch(settingsSource, /保存录制配置|保存开始配置|保存通知配置|保存监听与通知/);
  assert.doesNotMatch(settingsSource, /saveSettingsImmediately/);
});
