const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const {
  compareVersions: compareAppVersions,
  createUpdateDownloadSources,
  getAppPackageType,
  normalizeUpdateManifest,
  updatePackageFileName
} = require('../src/server/shared/helpers.cjs');
const {
  main: applyLinuxUpdate,
  getPaths,
  validateRequestShape,
  assertUpgradeVersion,
  compareVersions,
  queryDebPackageState,
  getServiceHealthTarget,
  appendLog,
  copyUntrustedPackage
} = require('../packaging/linux/linux-update.cjs');
const { migrateBootstrapStore } = require('../packaging/linux/bootstrap-config.cjs');
const { LiveRecordService } = require('../src/server/app/service.cjs');

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
  },
  {
    name: 'bili-record-2k-1.2.3-x64.msix',
    kind: 'msix',
    platform: 'win32',
    arch: 'x64',
    url: 'https://example.test/bili-record-2k-1.2.3-x64.msix',
    sha256: '5'.repeat(64)
  }
];

async function createSignedUpdateRequest(tempDir, options = {}) {
  const version = options.version || '1.2.4';
  const packageType = options.packageType || 'deb';
  const paths = getPaths({ BILI_RECORD_UPDATE_DIR: tempDir });
  const extension = packageType === 'deb' ? 'deb' : 'tar.gz';
  const packageName = `bili-record-2k_${version}_${process.arch}.${extension}`;
  const packagePath = path.join(tempDir, packageName);
  await fsp.mkdir(tempDir, { recursive: true });
  await fsp.writeFile(packagePath, `package-${version}`, 'utf8');
  const sha256 = crypto.createHash('sha256').update(await fsp.readFile(packagePath)).digest('hex');
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
  const signed = {
    schemaVersion: 1,
    app: 'bili-record-2k',
    version,
    files: [
      {
        name: packageName,
        platform: 'linux',
        kind: packageType,
        arch: process.arch,
        sha256
      }
    ]
  };
  const request = {
    schemaVersion: 2,
    app: 'bili-record-2k',
    requestId: crypto.randomUUID(),
    version,
    packageType,
    packagePath,
    signed,
    signatureAlgorithm: 'ed25519',
    signature: crypto.sign(null, Buffer.from(stableJson(signed)), privateKey).toString('base64')
  };
  await fsp.writeFile(paths.requestPath, `${JSON.stringify(request)}\n`, 'utf8');
  return { paths, request, publicKey, packagePath };
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function createUpdaterCommandRunner(options = {}) {
  const calls = [];
  let dpkgState = options.initialDpkgState || { status: 'install ok installed', version: '1.2.3' };
  const targetState = options.targetDpkgState || { status: 'install ok installed', version: options.version || '1.2.4' };
  const runner = async (command, args) => {
    calls.push([command, ...args]);
    if (command === 'dpkg-deb') {
      const arch = process.arch === 'x64' ? 'amd64' : process.arch;
      return { code: 0, stdout: `bili-record-2k\n${options.version || '1.2.4'}\n${arch}\n`, stderr: '' };
    }
    if (command === 'dpkg-query') {
      return { code: 0, stdout: `${dpkgState.status}\n${dpkgState.version}\n`, stderr: '' };
    }
    if (command === 'dpkg') {
      dpkgState = targetState;
      return { code: 0, stdout: '', stderr: '' };
    }
    if (command === 'systemctl' && args[0] === 'show') {
      return { code: 0, stdout: '4242\n', stderr: '' };
    }
    if (command === 'systemctl' && args[0] === 'is-active') {
      return { code: 0, stdout: 'active\n', stderr: '' };
    }
    return { code: 0, stdout: '', stderr: '' };
  };
  return { runner, calls };
}

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

    await fsp.writeFile(path.join(tempDir, 'install-type.json'), JSON.stringify({ packageType: 'msix' }));
    assert.equal(getAppPackageType({ platform: 'win32', appRoot: tempDir, configuredType: '' }), 'msix');
    const msixManifest = normalizeUpdateManifest(payload, {
      platform: 'win32',
      arch: 'x64',
      appRoot: tempDir,
      configuredType: ''
    });
    assert.equal(msixManifest.packageType, 'msix');
    assert.equal(msixManifest.packageUrl, files[4].url);
  } finally {
    await fsp.rm(tempDir, { recursive: true, force: true });
  }
});

test('official update packages can fall back to gh-proxy without leaking custom sources', () => {
  const officialUrl =
    'https://github.com/Metahumanz/LiveRecord2k/releases/download/v0.4.1/bili-record-2k-setup.exe';
  assert.deepEqual(createUpdateDownloadSources(officialUrl, { officialSource: true }), [
    { url: officialUrl, label: 'GitHub 官方源' },
    { url: `https://gh-proxy.com/${officialUrl}`, label: 'GitHub 镜像' }
  ]);
  assert.deepEqual(createUpdateDownloadSources(officialUrl, { officialSource: false }), [
    { url: officialUrl, label: '更新源' }
  ]);
  const customUrl = 'https://downloads.example.test/private/setup.exe';
  assert.deepEqual(createUpdateDownloadSources(customUrl, { officialSource: true }), [
    { url: customUrl, label: '更新源' }
  ]);
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

test('Deb success requires dpkg install ok installed instead of version.json alone', async () => {
  const state = await queryDebPackageState({
    runCommand: async () => ({ code: 0, stdout: 'install ok half-configured\n1.2.4\n', stderr: '' })
  });
  assert.equal(state.version, '1.2.4');
  assert.equal(state.configured, false);

  const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'br2k-updater-half-configured-'));
  try {
    const { paths, publicKey } = await createSignedUpdateRequest(tempDir);
    const { runner, calls } = createUpdaterCommandRunner({
      targetDpkgState: { status: 'install ok half-configured', version: '1.2.4' }
    });
    await assert.rejects(
      applyLinuxUpdate({
        paths,
        allowNonLinux: true,
        allowNonRoot: true,
        publicKey,
        runCommand: runner,
        probeService: async () => true,
        delay: async () => {}
      }),
      /Deb 安装未完成.*install ok installed/
    );
    const status = JSON.parse(await fsp.readFile(paths.statusPath, 'utf8'));
    assert.equal(status.status, 'error');
    assert.equal(calls.some((call) => call[0] === 'systemctl' && call[1] === 'show'), false);
  } finally {
    await fsp.rm(tempDir, { recursive: true, force: true });
  }
});

test('root updater writes success only after configured Deb and a real service health probe', async () => {
  const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'br2k-updater-success-'));
  try {
    const { paths, publicKey } = await createSignedUpdateRequest(tempDir);
    const { runner, calls } = createUpdaterCommandRunner();
    let probes = 0;
    const result = await applyLinuxUpdate({
      paths,
      allowNonLinux: true,
      allowNonRoot: true,
      publicKey,
      runCommand: runner,
      probeService: async () => {
        probes += 1;
        return true;
      },
      delay: async () => {}
    });
    assert.equal(result.status, 'success');
    assert.equal(probes, 1);
    const status = JSON.parse(await fsp.readFile(paths.statusPath, 'utf8'));
    assert.equal(status.status, 'success');
    assert.match(status.message, /主服务健康检查通过/);
    assert.equal(calls.some((call) => call[0] === 'dpkg-query'), true);
    assert.equal(calls.some((call) => call[0] === 'systemctl' && call[1] === 'show'), true);
    assert.equal(await fsp.stat(paths.processingPath).then(() => true).catch(() => false), false);
  } finally {
    await fsp.rm(tempDir, { recursive: true, force: true });
  }
});

test('root updater health probe uses persisted serverPort after bootstrap strips the environment port', async () => {
  const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'br2k-updater-health-port-'));
  try {
    const configRoot = path.join(tempDir, 'config');
    const environmentPath = path.join(tempDir, 'environment');
    const paths = getPaths({ BILI_RECORD_CONFIG_DIR: configRoot, BILI_RECORD_UPDATE_DIR: path.join(tempDir, 'updates') });
    const settingsPath = path.join(configRoot, 'BiliRecord2K', 'settings.json');
    await fsp.mkdir(path.dirname(settingsPath), { recursive: true });
    await fsp.writeFile(settingsPath, JSON.stringify({ settings: { serverHost: '127.0.0.1', serverPort: 47654 } }), 'utf8');
    await fsp.writeFile(environmentPath, 'BILI_RECORD_CONFIG_DIR=/var/lib/bili-record-2k\nBILI_RECORD_MANAGED_UPDATE=1\n', 'utf8');

    assert.deepEqual(await getServiceHealthTarget(paths, { environmentPath }), { host: '127.0.0.1', port: 47654 });
  } finally {
    await fsp.rm(tempDir, { recursive: true, force: true });
  }
});

test('orphaned processing requests are quarantined without restarting an install loop', async () => {
  const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'br2k-updater-orphan-'));
  try {
    const paths = getPaths({ BILI_RECORD_UPDATE_DIR: tempDir });
    await fsp.mkdir(tempDir, { recursive: true });
    await fsp.writeFile(paths.processingPath, '{not-json', 'utf8');
    const result = await applyLinuxUpdate({
      paths,
      allowNonLinux: true,
      allowNonRoot: true,
      runCommand: async () => {
        throw new Error('orphan processing must not execute an installer');
      }
    });
    assert.equal(result.status, 'recovered');
    assert.equal(await fsp.stat(paths.processingPath).then(() => true).catch(() => false), false);
    const entries = await fsp.readdir(tempDir);
    assert.equal(entries.some((entry) => /^apply-request\.error\./.test(entry)), true);
    const status = JSON.parse(await fsp.readFile(paths.statusPath, 'utf8'));
    assert.equal(status.status, 'error');
  } finally {
    await fsp.rm(tempDir, { recursive: true, force: true });
  }
});

test('managed Linux update requests are single-flight and never overwrite an existing queue item', async () => {
  const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'br2k-managed-request-'));
  const packagePath = path.join(tempDir, 'bili-record-2k_1.2.4_amd64.deb');
  const manifest = {
    version: '1.2.4',
    packageType: 'deb',
    signed: { schemaVersion: 1 },
    signatureAlgorithm: 'ed25519',
    signature: 'signature'
  };
  try {
    await fsp.writeFile(packagePath, 'package', 'utf8');
    const service = new LiveRecordService();
    service.getUpdateDir = () => tempDir;
    service.supportsManagedLinuxUpdate = () => true;
    const [first, second] = await Promise.all([
      service.requestManagedLinuxUpdate(manifest, packagePath),
      service.requestManagedLinuxUpdate(manifest, packagePath)
    ]);
    assert.equal(first.requestId, second.requestId);
    const requestPath = path.join(tempDir, 'apply-request.json');
    const request = JSON.parse(await fsp.readFile(requestPath, 'utf8'));
    assert.equal(request.version, '1.2.4');
    assert.equal(await fsp.stat(path.join(tempDir, 'last-update-status.json')).then(() => true).catch(() => false), false);

    const competing = new LiveRecordService();
    competing.getUpdateDir = () => tempDir;
    competing.supportsManagedLinuxUpdate = () => true;
    await assert.rejects(
      competing.requestManagedLinuxUpdate({ ...manifest, version: '1.2.5' }, path.join(tempDir, 'other.deb')),
      /不会覆盖/
    );
    assert.deepEqual(JSON.parse(await fsp.readFile(requestPath, 'utf8')), request);
  } finally {
    await fsp.rm(tempDir, { recursive: true, force: true });
  }
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
  assert.match(provision, /bootstrap-config\.cjs/);
  assert.doesNotMatch(provision, /\brunuser\b|\bsu -s\b/);
  assert.doesNotMatch(provision, /SANITIZED_ENV_FILE/);
  assert.match(provision, /BILI_RECORD_UPDATE_APPLYING/);
  const updatePathUnit = fs.readFileSync(
    path.join(__dirname, '..', 'packaging', 'linux', 'bili-record-2k-update.path'),
    'utf8'
  );
  assert.match(updatePathUnit, /apply-request\.json/);
  assert.doesNotMatch(updatePathUnit, /apply-request\.processing\.json/);
  const updateServiceUnit = fs.readFileSync(
    path.join(__dirname, '..', 'packaging', 'linux', 'bili-record-2k-update.service'),
    'utf8'
  );
  assert.match(updateServiceUnit, /Restart=no/);
  assert.doesNotMatch(updateServiceUnit, /Restart=on-failure/);
});
