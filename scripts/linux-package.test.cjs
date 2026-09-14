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
  updatePackageFileName,
  shouldTestHardwareEncoder,
  runCapturedProcess
} = require('../src/server/shared/helpers.cjs');
const {
  isJetsonGstreamerCodec,
  getNativeSoftwareDecoder,
  createBurnArgs,
  createBurnVideoFilter,
  createBurnRawVideoArgs,
  createJetsonBurnLeadingVideoFilterGraph,
  createAvatarOverlayFilterScript,
  createJetsonGstreamerEncodeArgs,
  createBurnEncodedVideoMuxArgs,
  createNormalizeRawVideoArgs,
  createNormalizeEncodedVideoMuxArgs,
  createNormalizeSegmentArgs,
  runFfmpegToGstreamerJob
} = require('../src/server/recording/ffmpeg.cjs');
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

function resolveJetPackR35FfmpegPath() {
  const configured = String(process.env.BILI_RECORD_JETPACK_R35_FFMPEG || '').trim();
  if (configured) return configured;
  if (process.platform !== 'linux') return '';
  try {
    const release = fs.readFileSync('/etc/nv_tegra_release', 'utf8');
    return /\bR35\b/i.test(release) ? '/usr/bin/ffmpeg' : '';
  } catch {
    return '';
  }
}

const jetPackR35FfmpegPath = resolveJetPackR35FfmpegPath();

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

test('GitHub API asset fallback on ARM picks arm64 deb and never treats update.json as a package', () => {
  const armAssets = [
    {
      name: 'bili-record-2k_1.2.3_amd64.deb',
      browser_download_url: 'https://example.test/bili-record-2k_1.2.3_amd64.deb',
      digest: 'sha256:' + 'a'.repeat(64)
    },
    {
      name: 'bili-record-2k_1.2.3_arm64.deb',
      browser_download_url: 'https://example.test/bili-record-2k_1.2.3_arm64.deb',
      digest: 'sha256:' + 'b'.repeat(64)
    },
    {
      name: 'bili-record-2k_1.2.3_linux_x64.tar.gz',
      browser_download_url: 'https://example.test/bili-record-2k_1.2.3_linux_x64.tar.gz',
      digest: 'sha256:' + 'c'.repeat(64)
    },
    {
      name: 'bili-record-2k_1.2.3_linux_arm64.tar.gz',
      browser_download_url: 'https://example.test/bili-record-2k_1.2.3_linux_arm64.tar.gz',
      digest: 'sha256:' + 'd'.repeat(64)
    },
    {
      name: 'update.json',
      browser_download_url: 'https://example.test/update.json',
      digest: ''
    }
  ];
  const manifest = normalizeUpdateManifest(
    { tag_name: 'v1.2.3', assets: armAssets },
    { platform: 'linux', arch: 'arm64', packageType: 'deb' }
  );
  assert.equal(manifest.packageType, 'deb');
  assert.equal(manifest.packageName, 'bili-record-2k_1.2.3_arm64.deb');
  assert.match(manifest.packageUrl, /_arm64\.deb$/);
  assert.equal(manifest.sha256, 'b'.repeat(64));
  assert.notEqual(manifest.packageName, 'update.json');
});

test('official update manifest can fall back to gh-proxy like release packages', () => {
  const manifestUrl = 'https://github.com/Metahumanz/LiveRecord2k/releases/latest/download/update.json';
  assert.deepEqual(createUpdateDownloadSources(manifestUrl, { officialSource: true }), [
    { url: manifestUrl, label: 'GitHub 官方源' },
    { url: `https://gh-proxy.com/${manifestUrl}`, label: 'GitHub 镜像' }
  ]);
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

  const installerReset = await migrateBootstrapStore(
    {
      settings: {
        configBootstrapVersion: 1,
        outputDir: '/mnt/recordings',
        serverHost: '127.0.0.1',
        serverPort: 3263,
        accessUsername: 'old-admin',
        accessPasswordHash: 'scrypt$old'
      }
    },
    {
      BILI_RECORD_APPLY_BOOTSTRAP: '1',
      BILI_RECORD_OUTPUT_DIR: '/mnt/smb-recordings',
      BILI_RECORD_HOST: '0.0.0.0',
      BILI_RECORD_PORT: '4321',
      BILI_RECORD_AUTH_USERNAME: 'new-admin',
      BILI_RECORD_AUTH_PASSWORD: 'new-password',
      BILI_RECORD_AUTO_UPDATE: '0'
    }
  );
  assert.equal(installerReset.settings.outputDir, '/mnt/smb-recordings');
  assert.equal(installerReset.settings.serverHost, '0.0.0.0');
  assert.equal(installerReset.settings.serverPort, 4321);
  assert.equal(installerReset.settings.accessUsername, 'new-admin');
  assert.equal(installerReset.settings.autoUpdateEnabled, false);
  assert.match(installerReset.settings.accessPasswordHash, /^scrypt\$/);
  assert.notEqual(installerReset.settings.accessPasswordHash, 'scrypt$old');
});

test('Jetson GStreamer bridge uses rawvideoparse and keeps the final mux in FFmpeg', () => {
  assert.equal(isJetsonGstreamerCodec('h264_nvv4l2'), true);
  assert.equal(isJetsonGstreamerCodec('hevc_nvv4l2'), true);
  assert.equal(isJetsonGstreamerCodec('h264_v4l2m2m'), false);
  assert.equal(
    shouldTestHardwareEncoder({ value: 'h264_nvv4l2', platform: 'linux' }, [], 'win32'),
    false
  );
  assert.equal(
    shouldTestHardwareEncoder({ value: 'h264_nvv4l2', platform: 'linux' }, [], 'linux'),
    true
  );

  const rawArgs = createBurnRawVideoArgs({
    cleanPath: '/recordings/source.mkv',
    assPath: '/recordings/danmaku.ass',
    fps: 30,
    duration: 12
  });
  assert.ok(rawArgs.includes('rawvideo'));
  assert.ok(rawArgs.includes('pipe:1'));
  assert.ok(rawArgs.includes('-an'));
  assert.ok(rawArgs.includes('-r'));

  const gstreamerArgs = createJetsonGstreamerEncodeArgs({
    codec: 'h264_nvv4l2',
    width: 1920,
    height: 1080,
    fps: 29.97,
    quality: 24,
    outputPath: '/recordings/temporary.h264'
  });
  assert.ok(gstreamerArgs.includes('rawvideoparse'));
  assert.ok(gstreamerArgs.includes('nvv4l2h264enc'));
  assert.ok(gstreamerArgs.includes('nvvidconv'));
  assert.ok(gstreamerArgs.includes('framerate=2997/100'));

  const newerStackGstreamerArgs = createJetsonGstreamerEncodeArgs({
    codec: 'hevc_nvv4l2',
    width: 1920,
    height: 1080,
    fps: 30,
    quality: 24,
    outputPath: '/recordings/temporary.h265',
    converter: 'nvvideoconvert'
  });
  assert.ok(newerStackGstreamerArgs.includes('nvvideoconvert'));
  assert.ok(newerStackGstreamerArgs.includes('nvv4l2h265enc'));

  const muxArgs = createBurnEncodedVideoMuxArgs({
    encodedVideoPath: '/recordings/temporary.h264',
    cleanPath: '/recordings/source.mkv',
    outputPath: '/recordings/final.mp4',
    codec: 'h264_nvv4l2',
    fps: 30,
    duration: 12,
    container: 'mp4'
  });
  assert.ok(muxArgs.includes('copy'));
  assert.ok(muxArgs.includes('/recordings/final.mp4'));

  const jetsonDecodeArgs = createNormalizeRawVideoArgs({
    inputPath: '/recordings/source.mkv',
    durationSec: 12,
    targetVideoInfo: { width: 1920, height: 1080, fps: 30, codec: 'h264', pixelFormat: 'yuv420p' },
    decoder: 'h264_nvv4l2dec'
  });
  assert.equal(jetsonDecodeArgs[jetsonDecodeArgs.indexOf('-c:v') + 1], 'h264_nvv4l2dec');
  assert.equal(jetsonDecodeArgs.includes('-hwaccel'), false);

  const m2mDecodeArgs = createNormalizeRawVideoArgs({
    inputPath: '/recordings/source.mkv',
    durationSec: 12,
    targetVideoInfo: { width: 1920, height: 1080, fps: 30 },
    decoder: 'h264_v4l2m2m'
  });
  assert.equal(m2mDecodeArgs[m2mDecodeArgs.indexOf('-c:v') + 1], 'h264_v4l2m2m');
  assert.ok(m2mDecodeArgs.includes('rawvideo'));

  const normalizeMuxArgs = createNormalizeEncodedVideoMuxArgs({
    encodedVideoPath: '/recordings/temporary.h264',
    inputPath: '/recordings/source.mkv',
    outputPath: '/recordings/normalized.mkv',
    codec: 'h264_nvv4l2',
    fps: 30,
    container: 'mkv',
    durationSec: 12,
    hasAudio: true
  });
  assert.ok(normalizeMuxArgs.includes('[aout]'));
  assert.ok(normalizeMuxArgs.includes('/recordings/normalized.mkv'));
});

test('software decode explicitly selects native H.264/HEVC and skipped seek guard emits no select filter', () => {
  assert.equal(getNativeSoftwareDecoder('h264 (High)'), 'h264');
  assert.equal(getNativeSoftwareDecoder('H.265 / HEVC Main'), 'hevc');
  assert.equal(getNativeSoftwareDecoder('vp9'), '');

  const h264Args = createBurnArgs({
    cleanPath: '/recordings/source-h264.mkv',
    assPath: '/recordings/danmaku.ass',
    burnedPath: '/recordings/output.mp4',
    codec: 'libx264',
    crf: 24,
    container: 'mp4',
    fps: 30,
    decoder: 'software',
    sourceCodec: 'h264 (High)'
  });
  const h264DecoderIndex = h264Args.indexOf('-c:v');
  assert.equal(h264Args[h264DecoderIndex + 1], 'h264');
  assert.ok(h264DecoderIndex < h264Args.indexOf('-i'));

  const hevcArgs = createBurnRawVideoArgs({
    cleanPath: '/recordings/source-hevc.mkv',
    assPath: '/recordings/danmaku.ass',
    fps: 30,
    duration: 12,
    decoder: 'software',
    sourceCodec: 'hevc (Main)'
  });
  const hevcDecoderIndex = hevcArgs.indexOf('-c:v');
  assert.equal(hevcArgs[hevcDecoderIndex + 1], 'hevc');
  assert.ok(hevcDecoderIndex < hevcArgs.indexOf('-i'));

  const jetsonDecodeArgs = createBurnRawVideoArgs({
    cleanPath: '/recordings/source-hevc.mkv',
    assPath: '/recordings/danmaku.ass',
    fps: 30,
    duration: 12,
    decoder: 'hevc_nvv4l2dec',
    sourceCodec: 'hevc'
  });
  assert.equal(jetsonDecodeArgs[jetsonDecodeArgs.indexOf('-c:v') + 1], 'hevc_nvv4l2dec');

  const guarded = createBurnVideoFilter('/recordings/danmaku.ass', 30, { inputSeek: false });
  const skipped = createBurnVideoFilter('/recordings/danmaku.ass', 30, {
    skipInitialKeyframeGuard: true,
    inputTrimStartSec: 2,
    inputTrimEndSec: 12
  });
  assert.match(guarded, /select='if\(isnan\(prev_selected_t\)/);
  assert.doesNotMatch(skipped, /select=/);
  assert.match(skipped, /trim=start=2:end=12,setpts=PTS-STARTPTS,ass=filename=/);
});

test('JetPack R35-compatible raw burn uses explicit black-frame concat for the full 1.019-second lead-in', () => {
  const graph = createJetsonBurnLeadingVideoFilterGraph({
    assPath: '/recordings/danmaku.ass',
    fps: 30,
    timelineOffset: 1.019,
    leadingVideoPaddingSec: 1.019,
    outputDuration: 2102,
    skipInitialKeyframeGuard: true,
    inputTrimStartSec: 2,
    inputTrimEndSec: 2102,
    videoWidth: 1920,
    videoHeight: 1080
  });
  assert.match(graph, /color=c=black:s=1920x1080:r=30:d=1\.019/);
  assert.match(graph, /concat=n=2:v=1:a=0,trim=duration=2102,setpts=PTS-STARTPTS/);
  assert.match(graph, /trim=start=2:end=2102,setpts=PTS-STARTPTS/);
  assert.doesNotMatch(graph, /(?:\btpad=|select=)/);

  const rawArgs = createBurnRawVideoArgs({
    cleanPath: '/recordings/source-hevc.mkv',
    assPath: '/recordings/danmaku.ass',
    fps: 30,
    duration: 2102,
    inputSeek: true,
    timelineOffset: 1.019,
    leadingVideoPaddingSec: 1.019,
    inputTrimStartSec: 2,
    inputTrimEndSec: 2102,
    decoder: 'software',
    sourceCodec: 'hevc',
    videoWidth: 1920,
    videoHeight: 1080
  });
  const filterGraph = rawArgs[rawArgs.indexOf('-filter_complex') + 1];
  assert.equal(rawArgs[rawArgs.indexOf('-c:v') + 1], 'hevc');
  assert.match(filterGraph, /color=c=black:s=1920x1080:r=30:d=1\.019/);
  assert.doesNotMatch(filterGraph, /(?:\btpad=|select=)/);
});

test(
  'JetPack R35 FFmpeg 4.x executes the 1.019-second explicit burn lead-in',
  { skip: !jetPackR35FfmpegPath },
  async () => {
    const ffmpegPath = jetPackR35FfmpegPath;
    assert.equal(fs.existsSync(ffmpegPath), true, `找不到 JetPack R35 FFmpeg：${ffmpegPath}`);
    const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'br2k-r35-filter-'));
    const sourcePath = path.join(tempDir, 'source.mp4');
    const assPath = path.join(tempDir, 'subtitle.ass');
    try {
      const version = await runCapturedProcess(ffmpegPath, ['-version'], { timeoutMs: 15_000 });
      assert.equal(version.status, 0, version.stderr);
      assert.match(`${version.stdout}\n${version.stderr}`, /ffmpeg version 4\./i);
      await fsp.writeFile(
        assPath,
        '[Script Info]\nScriptType: v4.00+\nPlayResX: 320\nPlayResY: 180\n' +
          '[V4+ Styles]\nFormat: Name,Fontname,Fontsize,PrimaryColour,SecondaryColour,OutlineColour,BackColour,' +
          'Bold,Italic,Underline,StrikeOut,ScaleX,ScaleY,Spacing,Angle,BorderStyle,Outline,Shadow,Alignment,' +
          'MarginL,MarginR,MarginV,Encoding\n' +
          'Style: Default,Arial,20,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,1,0,2,10,10,10,1\n' +
          '[Events]\nFormat: Layer,Start,End,Style,Name,MarginL,MarginR,MarginV,Effect,Text\n' +
          'Dialogue: 0,0:00:00.00,0:00:02.00,Default,,0,0,0,,R35 lead-in\n',
        'utf8'
      );
      const source = await runCapturedProcess(
        ffmpegPath,
        [
          '-hide_banner',
          '-y',
          '-f',
          'lavfi',
          '-i',
          'testsrc2=size=320x180:rate=25:duration=2',
          '-an',
          '-c:v',
          'mpeg4',
          sourcePath
        ],
        { timeoutMs: 30_000 }
      );
      assert.equal(source.status, 0, source.stderr);
      await runFfmpegToGstreamerJob({
        ffmpegPath,
        ffmpegArgs: createBurnRawVideoArgs({
          cleanPath: sourcePath,
          assPath,
          fps: 25,
          duration: 2,
          inputSeek: true,
          timelineOffset: 1.019,
          leadingVideoPaddingSec: 1.019,
          decoder: 'software',
          sourceCodec: 'mpeg4',
          videoWidth: 320,
          videoHeight: 180
        }),
        gstreamerPath: process.execPath,
        gstreamerArgs: [
          '-e',
          "let bytes = 0; process.stdin.on('data', (chunk) => { bytes += chunk.length; }); process.stdin.on('end', () => process.exit(bytes > 0 ? 0 : 1));"
        ],
        timeoutMs: 45_000
      });
    } finally {
      await fsp.rm(tempDir, { recursive: true, force: true });
    }
  }
);

test('Jetson GStreamer keeps CUDA avatar composition independent from the video encoder', () => {
  const avatarOverlay = {
    panel: { left: 10, width: 120, height: 180 },
    filterScriptPath: '/recordings/avatar-layer.ffscript',
    gpuComposite: true,
    gpuOutputToCpu: true,
    entries: [
      {
        imagePath: '/recordings/avatar.png',
        segments: [{ start: 0, end: 2, x1: 18, x2: 18, y1: 28, y2: 28 }]
      }
    ]
  };
  const script = createAvatarOverlayFilterScript({
    assPath: '/recordings/danmaku.ass',
    fps: 30,
    avatarOverlay,
    gpuComposite: true,
    gpuOutputToCpu: true
  });
  const rawArgs = createBurnRawVideoArgs({
    cleanPath: '/recordings/source.mkv',
    assPath: '/recordings/danmaku.ass',
    fps: 30,
    avatarOverlay,
    duration: 2,
    decoder: 'cuda'
  });
  const softwareEncodeArgs = createBurnArgs({
    cleanPath: '/recordings/source.mkv',
    assPath: '/recordings/danmaku.ass',
    burnedPath: '/recordings/output.mkv',
    codec: 'libx265',
    crf: 24,
    container: 'mkv',
    fps: 30,
    avatarOverlay
  });

  assert.match(script, /overlay_cuda=/);
  assert.match(script, /scale_cuda=format=yuv420p,hwdownload,format=yuv420p\[vout\]/);
  assert.equal(rawArgs[rawArgs.indexOf('-init_hw_device') + 1], 'cuda=br2k_avatar:0');
  assert.equal(rawArgs[rawArgs.indexOf('-filter_hw_device') + 1], 'br2k_avatar');
  assert.equal(softwareEncodeArgs[softwareEncodeArgs.indexOf('-init_hw_device') + 1], 'cuda=br2k_avatar:0');
});

test('non-CUDA GPU final blend keeps avatar motion in a capped CPU side panel', () => {
  const avatarOverlay = {
    panel: { left: 10, width: 120, height: 180 },
    filterScriptPath: '/recordings/avatar-layer.ffscript',
    gpuComposite: true,
    gpuCompositeBackend: 'vulkan',
    gpuOutputToCpu: true,
    compositeFps: 24,
    entries: [
      {
        imagePath: '/recordings/avatar.png',
        segments: [{ start: 0, end: 2, x1: 18, x2: 42, y1: 28, y2: 28 }]
      }
    ]
  };
  const script = createAvatarOverlayFilterScript({
    assPath: '/recordings/danmaku.ass',
    fps: 60,
    avatarOverlay,
    gpuComposite: true,
    gpuCompositeBackend: 'vulkan',
    gpuOutputToCpu: true
  });
  const vulkanArgs = createBurnArgs({
    cleanPath: '/recordings/source.mkv',
    assPath: '/recordings/danmaku.ass',
    burnedPath: '/recordings/output.mkv',
    codec: 'libx265',
    crf: 24,
    container: 'mkv',
    fps: 60,
    avatarOverlay
  });
  const vaapiArgs = createBurnArgs({
    cleanPath: '/recordings/source.mkv',
    assPath: '/recordings/danmaku.ass',
    burnedPath: '/recordings/output-vaapi.mkv',
    codec: 'libx265',
    crf: 24,
    container: 'mkv',
    fps: 60,
    avatarOverlay: {
      ...avatarOverlay,
      gpuCompositeBackend: 'vaapi',
      gpuCompositeDevice: '/dev/dri/renderD128'
    }
  });

  assert.match(script, /color=c=black@0\.0:s=120x180:r=24/);
  assert.match(script, /overlay=x='if\(between\(t/);
  assert.match(script, /overlay_vulkan=x=10:y=0,hwdownload,format=yuva420p,format=yuv420p\[vout\]/);
  assert.equal(vulkanArgs[vulkanArgs.indexOf('-init_hw_device') + 1], 'vulkan=br2k_avatar:0');
  assert.equal(vaapiArgs[vaapiArgs.indexOf('-init_hw_device') + 1], 'vaapi=br2k_avatar:/dev/dri/renderD128');
});

test('FFmpeg-to-GStreamer bridge streams stdout into stdin and clears its cancellable child', async () => {
  const children = [];
  await runFfmpegToGstreamerJob({
    ffmpegPath: process.execPath,
    ffmpegArgs: ['-e', "process.stdout.write('raw-i420-frame')"],
    gstreamerPath: process.execPath,
    gstreamerArgs: [
      '-e',
      "let size=0; process.stdin.on('data', (chunk) => { size += chunk.length; }); process.stdin.on('end', () => process.exit(size ? 0 : 1));"
    ],
    onChild: (child) => children.push(child)
  });
  assert.ok(children.some(Boolean));
  assert.equal(children.at(-1), null);
});

test('FFmpeg-to-GStreamer bridge keeps FFmpeg stderr as root cause and Argus as an attachment', async () => {
  let captured = null;
  try {
    await runFfmpegToGstreamerJob({
      ffmpegPath: process.execPath,
      ffmpegArgs: [
        '-e',
        "process.stdout.write('raw-i420-frame'); process.stderr.write('FFMPEG ROOT: native HEVC decoder failed\\n'); setTimeout(() => process.exit(7), 150);"
      ],
      gstreamerPath: process.execPath,
      gstreamerArgs: [
        '-e',
        "process.stderr.write('(Argus) Error FileOperationFailed: Connecting to nvargus-daemon failed\\n'); process.stdin.resume(); setInterval(() => {}, 1000);"
      ]
    });
    assert.fail('预期 FFmpeg 非零退出会导致桥接失败。');
  } catch (error) {
    captured = error;
  }
  assert.equal(captured?.primaryProcess, 'ffmpeg');
  assert.equal(captured?.gstreamerStoppedByPipeline, true);
  assert.match(captured?.message || '', /FFmpeg：FFMPEG ROOT: native HEVC decoder failed/);
  assert.match(captured?.message || '', /Argus 附加诊断/);
  assert.match(captured?.argusDiagnostics || '', /nvargus-daemon/);
});

test('FFmpeg-to-GStreamer bridge never presents an Argus-only GStreamer message as the root cause', async () => {
  let captured = null;
  try {
    await runFfmpegToGstreamerJob({
      ffmpegPath: process.execPath,
      ffmpegArgs: ['-e', "process.stdout.write('raw-i420-frame'); setInterval(() => {}, 1000);"],
      gstreamerPath: process.execPath,
      gstreamerArgs: [
        '-e',
        "process.stderr.write('(Argus) Error FileOperationFailed: Connecting to nvargus-daemon failed\\n'); process.exit(8);"
      ]
    });
    assert.fail('预期 GStreamer 非零退出会导致桥接失败。');
  } catch (error) {
    captured = error;
  }
  assert.equal(captured?.primaryProcess, 'gstreamer');
  assert.match(captured?.message || '', /GStreamer：管线异常（仅收到 Argus 附加诊断）/);
  assert.match(captured?.message || '', /Argus 附加诊断/);
  assert.doesNotMatch(captured?.message || '', /GStreamer：[^；]*nvargus-daemon/);
});

test('FFmpeg-to-GStreamer bridge aborts an FFmpeg that produces no I420 data', async () => {
  let captured = null;
  try {
    await runFfmpegToGstreamerJob({
      ffmpegPath: process.execPath,
      ffmpegArgs: ['-e', "setInterval(() => {}, 1000);"],
      gstreamerPath: process.execPath,
      gstreamerArgs: ['-e', "process.stdin.resume(); setInterval(() => {}, 1000);"],
      noProgressTimeoutMs: 300
    });
    assert.fail('预期没有 I420 数据会触发 FFmpeg 卡死保护。');
  } catch (error) {
    captured = error;
  }
  assert.equal(captured?.code, 'BR2K_JETSON_FFMPEG_STALL');
  assert.equal(captured?.primaryProcess, 'ffmpeg');
  assert.match(captured?.message || '', /FFmpeg 未输出 I420 视频数据/);
});

test('FFmpeg-to-GStreamer bridge points to GStreamer when raw data flows but encoded output stops growing', async () => {
  const outputPath = path.join(os.tmpdir(), `br2k-bridge-stall-${process.pid}-${Date.now()}.h264`);
  let captured = null;
  try {
    await runFfmpegToGstreamerJob({
      ffmpegPath: process.execPath,
      ffmpegArgs: ['-e', "setInterval(() => process.stdout.write('raw-i420-frame'), 20);"],
      gstreamerPath: process.execPath,
      gstreamerArgs: ['-e', "process.stdin.resume(); setInterval(() => {}, 1000);"],
      gstreamerOutputPath: outputPath,
      noProgressTimeoutMs: 300
    });
    assert.fail('预期没有编码输出会触发 GStreamer 卡死保护。');
  } catch (error) {
    captured = error;
  } finally {
    await fsp.rm(outputPath, { force: true }).catch(() => {});
  }
  assert.equal(captured?.code, 'BR2K_JETSON_GSTREAMER_STALL');
  assert.equal(captured?.primaryProcess, 'gstreamer');
  assert.match(captured?.message || '', /GStreamer 未生成编码视频数据/);
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
  assert.match(source, /BILI_RECORD_APPLY_BOOTSTRAP=1/);
  assert.match(source, /BILI_RECORD_OUTPUT_DIR/);
  assert.match(source, /SERVER_HOST=\$\{BILI_RECORD_HOST:-127\.0\.0\.1\}/);
  assert.match(source, /choose_listen_host/);
  assert.match(source, /LISTEN_CHOICE/);
  assert.match(source, /SERVER_HOST=0\.0\.0\.0/);
  assert.match(source, /inherit_existing_settings/);
  assert.match(source, /EVP_DigestVerifyInit/);
  assert.match(source, /EVP_DigestVerify/);
  assert.match(source, /python3/);
  assert.match(source, /gstreamer1\.0-plugins-base/);
  assert.match(source, /gstreamer1\.0-plugins-good/);
  assert.match(source, /gst-inspect-1\.0 nvv4l2h264enc/);
  assert.doesNotMatch(source, /pkeyutl -verify/);
  assert.doesNotMatch(source, /-rawin/);
  assert.match(source, /BILI_RECORD_DOWNLOAD_MIRROR/);
  assert.match(source, /https:\/\/gh-proxy\.com\//);
  assert.match(source, /download_manifest\(\)/);
  assert.match(source, /MIRROR_MANIFEST_URL=.*\$MANIFEST_URL/);
  assert.match(source, /download_manifest "GitHub 镜像 \$DOWNLOAD_MIRROR"/);
  assert.match(source, /--retry 1 --connect-timeout 10 --max-time 30/);
  assert.match(source, /正在验证官方 Ed25519 签名/);
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
  assert.match(provision, /usermod -a -G "\$hardware_group" "\$SERVICE_USER"/);
  assert.match(provision, /runuser -u "\$SERVICE_USER"/);
  assert.match(provision, /服务用户身份切换或身份校验失败/);
  assert.match(provision, /这不是录像目录或 SMB 权限错误/);
  assert.match(provision, /BILI_RECORD_UPDATE_APPLYING:-0.*= "1"/);
  assert.match(provision, /受控更新：跳过外部录像目录权限探针/);
  assert.match(provision, /read_recording_output_dir/);
  assert.match(provision, /bili-record-2k-permission-check/);
  assert.match(provision, /write-test/);
  assert.match(provision, /cat "\$probe_dir\/write-test"/);
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
