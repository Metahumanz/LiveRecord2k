const test = require('node:test');
const assert = require('node:assert/strict');
const {
  toMsixVersion,
  normalizeHttpsBaseUrl,
  renderManifest,
  renderAppInstaller,
  samePublisher
} = require('./build-msix.cjs');

test('MSIX version conversion keeps stable SemVer releases monotonic', () => {
  assert.equal(toMsixVersion('0.4.7'), '0.4.7.0');
  assert.equal(toMsixVersion('1.2.3', '1.2.3.42'), '1.2.3.42');
  assert.throws(() => toMsixVersion('1.2.4-beta.1'), /MSIX_VERSION_QUAD/);
  assert.throws(() => toMsixVersion('1.2.3', '1.2.3.70000'), /0-65535/);
});

test('MSIX update feed requires a stable HTTPS directory URL', () => {
  assert.equal(normalizeHttpsBaseUrl('https://updates.example.test/bili-record-2k/'), 'https://updates.example.test/bili-record-2k');
  assert.throws(() => normalizeHttpsBaseUrl('http://updates.example.test/feed'), /HTTPS/);
  assert.throws(() => normalizeHttpsBaseUrl('https://updates.example.test/feed?channel=beta'), /查询参数/);
});

test('App Installer output enables prompt-free launch and background update checks', () => {
  const xml = renderAppInstaller({
    packageIdentityName: 'BiliRecord2K',
    publisher: 'CN=BiliRecord2K',
    versionQuad: '0.4.7.0',
    packageUrl: 'https://updates.example.test/bili-record-2k/bili-record-2k-0.4.7-x64.msix',
    appInstallerUrl: 'https://updates.example.test/bili-record-2k/BiliRecord2K.appinstaller'
  });

  assert.match(xml, /appinstaller\/2021/);
  assert.match(xml, /HoursBetweenUpdateChecks="0"/);
  assert.match(xml, /ShowPrompt="false"/);
  assert.match(xml, /UpdateBlocksActivation="false"/);
  assert.match(xml, /<AutomaticBackgroundTask \/>/);
});

test('MSIX manifest and certificate publisher comparison preserve package identity', () => {
  const manifest = renderManifest('<Identity Name="{{PACKAGE_IDENTITY_NAME}}" Publisher="{{PUBLISHER}}" Version="{{VERSION_QUAD}}" />', {
    packageIdentityName: 'BiliRecord2K',
    applicationId: 'BiliRecord2K',
    publisher: 'CN=Example & Co',
    publisherDisplayName: 'Example',
    versionQuad: '1.2.3.4',
    displayName: '哔哩录播 2K',
    description: '录制'
  });

  assert.match(manifest, /Publisher="CN=Example &amp; Co"/);
  assert.equal(samePublisher('CN=Example & Co, O=Recorder', 'cn=example&co,o=recorder'), true);
  assert.equal(samePublisher('CN=Example A', 'CN=Example B'), false);
});
