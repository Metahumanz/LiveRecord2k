const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const {
  compareVersions: compareAppVersions,
  getAppPackageType,
  normalizeUpdateManifest,
  updatePackageFileName
} = require('../src/server/shared/helpers.cjs');
const {
  getPaths,
  validateRequestShape,
  assertUpgradeVersion,
  compareVersions,
  appendLog,
  copyUntrustedPackage
} = require('../packaging/linux/linux-update.cjs');
const { migrateBootstrapStore } = require('../packaging/linux/bootstrap-config.cjs');

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

test('legacy Windows setup installs select the EXE while portable folders keep the ZIP', async () => {
  const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'br2k-windows-package-type-'));
  const payload = { version: '1.2.3', files };
  try {
    await fsp.writeFile(path.join(tempDir, 'version.json'), JSON.stringify({ version: '1.2.2' }));
    await fsp.writeFile(path.join(tempDir, 'install-type.json'), JSON.stringify({ packageType: 'installer' }));

    assert.equal(getAppPackageType({ platform: 'win32', appRoot: tempDir, configuredType: '' }), 'installer');
    await fsp.rm(path.join(tempDir, 'install-type.json'));
    await fsp.writeFile(path.join(tempDir, 'Uninstall.exe'), 'nsis-uninstaller');

    assert.equal(getAppPackageType({ platform: 'win32', appRoot: tempDir, configuredType: '' }), 'installer');
    const installedManifest = normalizeUpdateManifest(payload, {
      platform: 'win32',
      arch: 'x64',
      appRoot: tempDir,
      configuredType: ''
    });
    assert.equal(installedManifest.packageType, 'installer');
    assert.equal(installedManifest.packageUrl, files[0].url);

    await fsp.rm(path.join(tempDir, 'Uninstall.exe'));
    assert.equal(getAppPackageType({ platform: 'win32', appRoot: tempDir, configuredType: '' }), 'portable');
    const portableManifest = normalizeUpdateManifest(payload, {
      platform: 'win32',
      arch: 'x64',
      appRoot: tempDir,
      configuredType: ''
    });
    assert.equal(portableManifest.packageType, 'portable');
    assert.equal(portableManifest.packageUrl, files[1].url);
  } finally {
    await fsp.rm(tempDir, { recursive: true, force: true });
  }
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
  const debArch = process.arch === 'x64' ? 'amd64' : process.arch === 'arm64' ? 'arm64' : process.arch;
  assert.equal(
    updatePackageFileName({ version: '1.2.3', packageType: 'deb', packageUrl: files[2].url }),
    `bili-record-2k_1.2.3_${debArch}.deb`
  );
  assert.equal(
    updatePackageFileName({ version: '1.2.3', packageType: 'tarball', packageUrl: files[3].url }),
    `bili-record-2k_1.2.3_linux_${process.arch}.tar.gz`
  );
});

test('root updater only accepts direct files in its controlled update directory', () => {
  const paths = getPaths({ BILI_RECORD_UPDATE_DIR: path.join(path.sep, 'var', 'lib', 'bili-record-2k-test-updates') });
  const valid = {
    schemaVersion: 2,
    app: 'bili-record-2k',
    version: '1.2.3',
    packageType: 'deb',
    packagePath: path.join(paths.updateDir, 'bili-record-2k_1.2.3_all.deb'),
    sha256: 'a'.repeat(64),
    signed: { schemaVersion: 1, app: 'bili-record-2k', version: '1.2.3', files: [] },
    signatureAlgorithm: 'ed25519',
    signature: Buffer.alloc(64).toString('base64')
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
  assert.equal(compareVersions('1.2.3-rc.1', '1.2.3'), -1);
  assert.equal(compareAppVersions('1.2.3-rc.1', '1.2.3'), -1);
  assert.equal(compareAppVersions('1.2.3+build.2', '1.2.3+build.1'), 0);
});

test('Linux bootstrap hashes legacy plaintext and ignores credentials after the first migration', async () => {
  const legacy = await migrateBootstrapStore(
    { settings: { configBootstrapVersion: 1, accessPassword: 'legacy-password' } },
    { BILI_RECORD_AUTH_PASSWORD: 'environment-password' }
  );
  assert.match(legacy.settings.accessPasswordHash, /^scrypt\$/);
  assert.equal('accessPassword' in legacy.settings, false);

  const alreadyBootstrapped = await migrateBootstrapStore(
    { settings: { configBootstrapVersion: 1 } },
    { BILI_RECORD_AUTH_PASSWORD: 'must-not-return' }
  );
  assert.equal(alreadyBootstrapped.settings.accessPasswordHash, undefined);
});

test('root updater refuses to append through a symbolic-link log target', { skip: process.platform !== 'linux' }, async () => {
  const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'br2k-updater-log-'));
  const victimPath = path.join(tempDir, 'victim');
  const logPath = path.join(tempDir, 'apply-update.log');
  try {
    await fsp.writeFile(victimPath, 'protected', 'utf8');
    await fsp.symlink(victimPath, logPath);
    await assert.rejects(appendLog({ logPath }, 'must not append'), /ELOOP|symbolic link/i);
    assert.equal(await fsp.readFile(victimPath, 'utf8'), 'protected');
  } finally {
    await fsp.rm(tempDir, { recursive: true, force: true });
  }
});

test('root updater copies an already-open ordinary package into its private staging file', async () => {
  const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'br2k-updater-copy-'));
  const sourcePath = path.join(tempDir, 'source.deb');
  const targetPath = path.join(tempDir, 'target.deb');
  try {
    await fsp.writeFile(sourcePath, Buffer.alloc(256 * 1024, 0x5a));
    await copyUntrustedPackage(sourcePath, targetPath);
    assert.deepEqual(await fsp.readFile(targetPath), await fsp.readFile(sourcePath));
  } finally {
    await fsp.rm(tempDir, { recursive: true, force: true });
  }
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
  assert.match(source, /--proto '=https' --proto-redir '=https'/);
  assert.match(source, /systemctl restart bili-record-2k\.service/);
  assert.match(source, /api\/state/);
  assert.doesNotMatch(source, /\beval\b/);
  const provision = fs.readFileSync(path.join(__dirname, '..', 'packaging', 'linux', 'provision.sh'), 'utf8');
  assert.match(provision, /install -d -m 0770 -o root -g "\$SERVICE_GROUP" "\$UPDATE_ROOT"/);
  assert.match(provision, /install -d -m 2770 -o root -g "\$SERVICE_GROUP" "\$STATE_ROOT\/recordings"/);
  assert.match(provision, /runuser -u "\$SERVICE_USER"/);
  const updatePathUnit = fs.readFileSync(
    path.join(__dirname, '..', 'packaging', 'linux', 'bili-record-2k-update.path'),
    'utf8'
  );
  assert.match(updatePathUnit, /apply-request\.processing\.json/);
});
