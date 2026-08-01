const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  normalizeUpdateManifest,
  updatePackageFileName
} = require('../src/server/shared/helpers.cjs');
const {
  getPaths,
  validateRequestShape,
  assertUpgradeVersion,
  compareVersions
} = require('../packaging/linux/linux-update.cjs');

const files = [
  {
    name: 'bili-record-2k-setup.exe',
    kind: 'installer',
    platform: 'win32',
    arch: 'x64',
    url: 'https://example.test/bili-record-2k-setup.exe',
    sha256: '1'.repeat(64)
  },
  {
    name: 'bili-record-2k-webui.zip',
    kind: 'portable',
    platform: 'win32',
    arch: 'x64',
    url: 'https://example.test/bili-record-2k-webui.zip',
    sha256: '2'.repeat(64)
  },
  {
    name: 'bili-record-2k_1.2.3_amd64.deb',
    kind: 'deb',
    platform: 'linux',
    arch: 'x64',
    url: 'https://example.test/bili-record-2k_1.2.3_amd64.deb',
    sha256: '3'.repeat(64)
  },
  {
    name: 'bili-record-2k_1.2.3_linux_x64.tar.gz',
    kind: 'tarball',
    platform: 'linux',
    arch: 'x64',
    url: 'https://example.test/bili-record-2k_1.2.3_linux_x64.tar.gz',
    sha256: '4'.repeat(64)
  }
];

test('update manifest selects the package matching platform, architecture, and install type', () => {
  const payload = {
    version: '1.2.3',
    packageUrl: files[0].url,
    sha256: files[0].sha256,
    files
  };
  const deb = normalizeUpdateManifest(payload, { platform: 'linux', arch: 'x64', packageType: 'deb' });
  assert.equal(deb.packageType, 'deb');
  assert.equal(deb.packageUrl, files[2].url);
  assert.equal(deb.sha256, files[2].sha256);

  const tarball = normalizeUpdateManifest(payload, { platform: 'linux', arch: 'x64', packageType: 'tarball' });
  assert.equal(tarball.packageType, 'tarball');
  assert.equal(tarball.packageUrl, files[3].url);

  const windows = normalizeUpdateManifest(payload, { platform: 'win32', arch: 'x64', packageType: 'installer' });
  assert.equal(windows.packageType, 'installer');
  assert.equal(windows.packageUrl, files[0].url);
});

test('GitHub API asset fallback does not mistake Windows zip for a Linux package', () => {
  const manifest = normalizeUpdateManifest(
    {
      tag_name: 'v1.2.3',
      assets: files.map((file) => ({ name: file.name, browser_download_url: file.url, digest: `sha256:${file.sha256}` }))
    },
    { platform: 'linux', arch: 'x64', packageType: 'deb' }
  );
  assert.equal(manifest.packageType, 'deb');
  assert.match(manifest.packageUrl, /\.deb$/);
  assert.equal(manifest.sha256, '3'.repeat(64));
});

test('Linux update package filenames keep their complete package extension', () => {
  assert.equal(
    updatePackageFileName({ version: '1.2.3', packageType: 'deb', packageUrl: files[2].url }),
    'bili-record-2k_1.2.3_all.deb'
  );
  assert.equal(
    updatePackageFileName({ version: '1.2.3', packageType: 'tarball', packageUrl: files[3].url }),
    'bili-record-2k_1.2.3_linux_all.tar.gz'
  );
});

test('root updater only accepts direct files in its controlled update directory', () => {
  const paths = getPaths({ BILI_RECORD_CONFIG_DIR: path.join(path.sep, 'var', 'lib', 'bili-record-2k-test') });
  const valid = {
    schemaVersion: 1,
    app: 'bili-record-2k',
    version: '1.2.3',
    packageType: 'deb',
    packagePath: path.join(paths.updateDir, 'bili-record-2k_1.2.3_all.deb'),
    sha256: 'a'.repeat(64)
  };
  assert.doesNotThrow(() => validateRequestShape(valid, paths));
  assert.throws(
    () => validateRequestShape({ ...valid, packagePath: path.join(paths.updateDir, 'nested', 'package.deb') }, paths),
    /子目录/
  );
  assert.throws(
    () => validateRequestShape({ ...valid, packagePath: path.join(paths.updateDir, '..', 'package.deb') }, paths),
    /受控更新目录/
  );
});

test('root updater rejects downgrade and repeated installation requests', () => {
  assert.equal(compareVersions('1.2.4', '1.2.3'), 1);
  assert.doesNotThrow(() => assertUpgradeVersion('1.2.4', '1.2.3'));
  assert.throws(() => assertUpgradeVersion('1.2.3', '1.2.3'), /拒绝降级/);
  assert.throws(() => assertUpgradeVersion('1.1.9', '1.2.3'), /拒绝降级/);
});

test('one-click Linux installer prompts through the terminal and verifies release packages before root installation', () => {
  const source = fs.readFileSync(path.join(__dirname, 'install-linux.sh'), 'utf8');
  assert.match(source, /read -r ADMIN_PASSWORD <\/dev\/tty/);
  assert.match(source, /ADMIN_PASSWORD_CONFIRM/);
  assert.match(source, /\.platform == "linux"/);
  assert.match(source, /sha256sum "\$PACKAGE_PATH"/);
  assert.match(source, /BILI_RECORD_AUTH_PASSWORD/);
  assert.match(source, /BILI_RECORD_DOWNLOAD_MIRROR/);
  assert.match(source, /https:\/\/gh-proxy\.com\//);
  assert.match(source, /MIRROR_PACKAGE_URL=.*\$PACKAGE_URL/);
  assert.match(source, /download_and_verify "GitHub 官方源"/);
  assert.match(source, /systemctl restart bili-record-2k\.service/);
  assert.match(source, /api\/state/);
  assert.doesNotMatch(source, /\beval\b/);
});
