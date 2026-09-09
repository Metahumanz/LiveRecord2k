const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const ts = require('typescript');

const appSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'client', 'App.tsx'), 'utf8');
const settingsSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'client', 'pages', 'SettingsPage.tsx'), 'utf8');
const maintenanceSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'client', 'pages', 'MaintenancePage.tsx'), 'utf8');
const queuePath = path.join(__dirname, '..', 'src', 'client', 'settings-save-queue.ts');

function loadSettingsSaveQueue() {
  const source = fs.readFileSync(queuePath, 'utf8');
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 }
  }).outputText;
  const module = { exports: {} };
  new Function('exports', 'module', compiled)(module.exports, module);
  return module.exports;
}

function createDraft() {
  return {
    outputDir: 'C:/recordings',
    webhookUrl: '',
    serverHost: '127.0.0.1',
    serverPort: 3263,
    accessUsername: 'admin',
    accessPassword: '',
    trustedProxies: []
  };
}

test('settings drafts retain dirty fields while server state is merged and autosaved', () => {
  assert.match(appSource, /settingsDirtyFieldsRef/);
  assert.match(appSource, /syncSettingsDraftFromServer/);
  assert.match(appSource, /SettingsSaveCoordinator/);
  assert.match(appSource, /queueSettingsAutoSave/);
  assert.match(appSource, /retryFailedSettingsSave/);
  assert.match(appSource, /settingsSaveStatus/);
});

test('A 保存中、B 修改后，A 失败和 B 成功不会把 A 伪装成已保存', () => {
  const { SettingsSaveCoordinator } = loadSettingsSaveQueue();
  const queue = new SettingsSaveCoordinator();
  const draft = createDraft();

  draft.outputDir = 'D:/recordings';
  queue.markChanged({ outputDir: draft.outputDir }, { queue: true });
  const saveA = queue.takePending();

  draft.webhookUrl = 'https://example.com/hook';
  queue.markChanged({ webhookUrl: draft.webhookUrl }, { queue: true });
  const saveB = queue.takePending();

  queue.settleFailure(saveA, draft);
  queue.settleSuccess(saveB);
  assert.equal(queue.isFullySaved(), false);
  assert.deepEqual([...queue.getDirtyFields()], ['outputDir']);

  const retryA = queue.takePending();
  assert.deepEqual(retryA.patch, { outputDir: 'D:/recordings' });
  queue.settleSuccess(retryA);
  assert.equal(queue.isFullySaved(), true);
});

test('首次保存失败会自动重新排队，重试成功后才清除 dirty', () => {
  const { SettingsSaveCoordinator } = loadSettingsSaveQueue();
  const queue = new SettingsSaveCoordinator();
  const draft = createDraft();

  draft.webhookUrl = 'https://example.com/retry';
  queue.markChanged({ webhookUrl: draft.webhookUrl }, { queue: true });
  const firstAttempt = queue.takePending();
  const failure = queue.settleFailure(firstAttempt, draft);
  assert.deepEqual(failure.autoRetryKeys, ['webhookUrl']);
  assert.equal(queue.isFullySaved(), false);

  const retryAttempt = queue.takePending();
  assert.deepEqual(retryAttempt.patch, { webhookUrl: 'https://example.com/retry' });
  queue.settleSuccess(retryAttempt);
  assert.equal(queue.isFullySaved(), true);
});

test('同一字段快速连续修改时，旧请求成功不能清除新版本的 dirty', () => {
  const { SettingsSaveCoordinator } = loadSettingsSaveQueue();
  const queue = new SettingsSaveCoordinator();
  const draft = createDraft();

  draft.accessUsername = 'first';
  queue.markChanged({ accessUsername: draft.accessUsername }, { queue: true });
  const firstAttempt = queue.takePending();
  draft.accessUsername = 'second';
  queue.markChanged({ accessUsername: draft.accessUsername }, { queue: true });

  queue.settleSuccess(firstAttempt);
  assert.deepEqual([...queue.getDirtyFields()], ['accessUsername']);
  const secondAttempt = queue.takePending();
  assert.deepEqual(secondAttempt.patch, { accessUsername: 'second' });
  queue.settleSuccess(secondAttempt);
  assert.equal(queue.isFullySaved(), true);
});

test('多字段保存只清除各自已确认版本，未确认字段继续保持 dirty', () => {
  const { SettingsSaveCoordinator } = loadSettingsSaveQueue();
  const queue = new SettingsSaveCoordinator();
  const draft = createDraft();

  draft.outputDir = 'D:/recordings';
  draft.webhookUrl = 'https://example.com/multi';
  queue.markChanged({ outputDir: draft.outputDir, webhookUrl: draft.webhookUrl }, { queue: true });
  const firstAttempt = queue.takePending();
  draft.webhookUrl = 'https://example.com/newer';
  queue.markChanged({ webhookUrl: draft.webhookUrl }, { queue: true });

  queue.settleSuccess(firstAttempt);
  assert.deepEqual([...queue.getDirtyFields()], ['webhookUrl']);
  const secondAttempt = queue.takePending();
  assert.deepEqual(secondAttempt.patch, { webhookUrl: 'https://example.com/newer' });
  queue.settleSuccess(secondAttempt);
  assert.equal(queue.isFullySaved(), true);
});

test('settings page uses automatic save feedback rather than duplicate save configuration buttons', () => {
  assert.match(settingsSource, /保存中/);
  assert.match(settingsSource, /已保存/);
  assert.match(settingsSource, /保存失败/);
  assert.doesNotMatch(settingsSource, /保存录制配置|保存开始配置|保存通知配置|保存监听与通知/);
  assert.doesNotMatch(settingsSource, /saveSettingsImmediately/);
});

test('普通设置按字段风险选择即时、延迟或失焦保存', () => {
  assert.match(settingsSource, /outputDir: event\.target\.value \}, 'commit'/);
  assert.match(settingsSource, /onBlur=\{\(\) => commitSetting\('outputDir'\)\}/);
  assert.match(settingsSource, /webhookUrl: event\.target\.value \}, 'debounced'/);
  assert.match(settingsSource, /cookie: event\.target\.value \}, 'commit'/);
  assert.match(maintenanceSource, /updateManifestUrl: event\.target\.value \}, 'debounced'/);
  assert.match(settingsSource, /onChange=\{\(checked\) => updateSetting\(\{ preferHevc: checked \}\)\}/);
});

test('远程运行配置在点击应用前只保留草稿，并作为一个原子 patch 提交', () => {
  const { SettingsSaveCoordinator } = loadSettingsSaveQueue();
  const queue = new SettingsSaveCoordinator();
  const draft = createDraft();
  const runtimeKeys = ['serverHost', 'serverPort', 'accessUsername', 'accessPassword', 'trustedProxies'];

  draft.serverHost = '0.0.0.0';
  draft.accessPassword = 'safe-password';
  queue.markChanged({ serverHost: draft.serverHost, accessPassword: draft.accessPassword }, { queue: false });
  assert.equal(queue.takePending(), null);

  queue.queueCurrent(runtimeKeys, draft);
  const attempt = queue.takePending();
  assert.deepEqual(attempt.patch, {
    serverHost: '0.0.0.0',
    accessPassword: 'safe-password'
  });

  assert.match(appSource, /RUNTIME_CONFIG_KEYS/);
  assert.match(maintenanceSource, /应用运行配置/);
  assert.match(appSource, /commitSettingsDraft\(RUNTIME_CONFIG_KEYS, '运行配置已应用。'\)/);
  assert.match(maintenanceSource, /applyRuntimeSettings/);
  assert.match(maintenanceSource, /accessPassword: event\.target\.value \}, 'commit'/);
  assert.doesNotMatch(maintenanceSource, /onBlur=\{\(\) => commitSetting\('serverHost'\)\}/);
  assert.doesNotMatch(maintenanceSource, /onBlur=\{\(\) => commitSetting\('accessPassword'\)\}/);
});
