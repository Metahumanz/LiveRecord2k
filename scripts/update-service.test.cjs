'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { LiveRecordService } = require('../src/server/app/service.cjs');
const { UpdateService } = require('../src/server/app/update-service.cjs');

class FakeSseResponse extends EventEmitter {
  constructor() {
    super();
    this.writes = [];
  }

  write(value) {
    this.writes.push(String(value));
    return true;
  }

  end() {
    this.emit('close');
  }
}

function createManifest(version = '99.0.0') {
  return {
    version,
    packageType: 'zip',
    packageUrl: 'https://example.com/bili-record-2k.zip'
  };
}

function setAvailableUpdate(service, manifest = createManifest()) {
  service.updateState = {
    ...service.updateState,
    status: 'available',
    latestVersion: manifest.version,
    manifest
  };
  return manifest;
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function withPlatform(platform, callback) {
  if (process.platform === platform) {
    return callback();
  }
  const descriptor = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { ...descriptor, value: platform });
  try {
    return await callback();
  } finally {
    Object.defineProperty(process, 'platform', descriptor);
  }
}

test('LiveRecordService 将更新状态与操作入口委托给 UpdateService', async () => {
  const service = new LiveRecordService();
  assert.ok(service.updateService instanceof UpdateService);
  const calls = [];
  service.updateService.getPublicUpdateState = () => {
    calls.push('state');
    return { status: 'available' };
  };
  service.updateService.checkUpdate = async () => {
    calls.push('check');
    return { checked: true };
  };
  service.updateService.scheduleAutomaticUpdateCheck = (delayMs) => {
    calls.push(['schedule', delayMs]);
  };

  assert.deepEqual(service.getPublicUpdateState(), { status: 'available' });
  assert.deepEqual(await service.checkUpdate(), { checked: true });
  service.scheduleAutomaticUpdateCheck(5_000);
  assert.deepEqual(calls, ['state', 'check', ['schedule', 5_000]]);
});

test('UpdateService 保留检查流程对 LiveRecordService 可替换入口的调用', async () => {
  const service = new LiveRecordService();
  service.fetchUpdateManifest = async () => ({
    version: service.updateState.currentVersion,
    packageUrl: 'https://example.com/bili-record-2k.zip'
  });
  service.log = () => {};
  service.markSystemDirty = () => {};

  const state = await service.checkUpdate();

  assert.equal(state.update.status, 'up-to-date');
  assert.equal(state.update.latestVersion, service.updateState.currentVersion);
});

test('更新状态只发送 system SSE 增量，不重建无关状态', async () => {
  const service = new LiveRecordService();
  const response = new FakeSseResponse();
  service.addClient(response);
  response.writes.length = 0;
  service.log = () => {};
  service.fetchUpdateManifest = async () => ({
    version: service.updateState.currentVersion,
    packageUrl: 'https://example.com/bili-record-2k.zip'
  });

  await service.checkUpdate();
  service.flushState();

  const delta = response.writes.join('');
  assert.match(delta, /event: system/);
  assert.doesNotMatch(delta, /event: state/);
  for (const eventName of ['room', 'recording', 'settings', 'mediaJob', 'diskSpace']) {
    assert.doesNotMatch(delta, new RegExp(`event: ${eventName}`));
  }
  const updateSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'server', 'app', 'update-service.cjs'), 'utf8');
  assert.doesNotMatch(updateSource, /this\.emitState\(/, '下载进度和所有更新状态均不得退回全量状态推送');

  response.end();
});

test('有活动任务时更新可以排队，直接应用会明确 blocked', async () => {
  const service = new LiveRecordService();
  const systemChanges = [];
  service.log = () => {};
  service.markSystemDirty = () => systemChanges.push('system');
  service.usesMsixAppInstallerUpdate = () => false;
  service.hasActiveJobs = () => true;
  setAvailableUpdate(service);

  const queued = await service.queueUpdateAfterJobs();
  assert.equal(queued.update.status, 'queued');
  assert.equal(queued.update.queued, true);

  const blocked = await service.applyUpdate();
  assert.equal(blocked.update.status, 'blocked');
  assert.equal(blocked.update.queued, false);
  assert.match(blocked.update.message, /仍有录制或媒体处理任务/);
  assert.deepEqual(systemChanges, ['system', 'system']);
});

test('SHA256 不匹配会删除已下载的坏更新包', async () => {
  const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'br2k-update-sha-'));
  const packagePath = path.join(tempDir, 'bili-record-2k.zip');
  try {
    await fsp.writeFile(packagePath, 'corrupted update package');
    const service = new LiveRecordService();
    service.log = () => {};
    service.updateState = { ...service.updateState, packagePath };

    assert.equal(await service.getUsableDownloadedPackage({ sha256: '0'.repeat(64) }), '');
    assert.equal(await fsp.stat(packagePath).then(() => true).catch(() => false), false);
  } finally {
    await fsp.rm(tempDir, { recursive: true, force: true });
  }
});

test('更新包下载失败会收敛为 error 状态', async () => {
  const service = new LiveRecordService();
  service.log = () => {};
  service.markSystemDirty = () => {};
  service.usesMsixAppInstallerUpdate = () => false;
  service.getUsableDownloadedPackage = async () => '';
  service.downloadUpdatePackage = async () => {
    throw new Error('测试网络中断');
  };
  setAvailableUpdate(service);

  const state = await service.downloadUpdateOnly();
  assert.equal(state.update.status, 'error');
  assert.equal(state.update.queued, false);
  assert.match(state.update.message, /手动下载更新失败：测试网络中断/);
});

test('Linux 受控更新重复请求复用队列，陈旧 processing 请求不阻塞新请求', async () => {
  const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'br2k-managed-update-'));
  const packagePath = path.join(tempDir, 'bili-record-2k_1.2.4_amd64.deb');
  const requestPath = path.join(tempDir, 'apply-request.json');
  const processingPath = path.join(tempDir, 'apply-request.processing.json');
  const manifest = {
    version: '1.2.4',
    packageType: 'deb',
    signed: { schemaVersion: 1 },
    signatureAlgorithm: 'ed25519',
    signature: 'signature'
  };
  try {
    await fsp.writeFile(packagePath, 'package');
    const service = new LiveRecordService();
    service.getUpdateDir = () => tempDir;
    service.supportsManagedLinuxUpdate = () => true;

    const first = await service.requestManagedLinuxUpdate(manifest, packagePath);
    const duplicate = await service.requestManagedLinuxUpdate(manifest, packagePath);
    assert.equal(first.existing, false);
    assert.equal(duplicate.existing, true);
    assert.equal(duplicate.requestId, first.requestId);

    await fsp.rm(requestPath);
    await fsp.writeFile(
      processingPath,
      JSON.stringify({ requestId: 'stale-request-123', version: '1.2.3', packagePath })
    );
    const staleTime = new Date(Date.now() - 18 * 60 * 1000);
    await fsp.utimes(processingPath, staleTime, staleTime);

    const replacement = await service.requestManagedLinuxUpdate({ ...manifest, version: '1.2.5' }, packagePath);
    assert.equal(replacement.existing, false);
    assert.equal(JSON.parse(await fsp.readFile(requestPath, 'utf8')).version, '1.2.5');
    assert.equal(await fsp.stat(processingPath).then(() => true).catch(() => false), true);
  } finally {
    await fsp.rm(tempDir, { recursive: true, force: true });
  }
});

test('自动更新定时器会执行一次检查，并在关闭后彻底释放', async () => {
  await withPlatform('linux', async () => {
    const service = new LiveRecordService();
    let checkCount = 0;
    service.settings.autoUpdateEnabled = true;
    service.log = () => {};
    service.checkUpdate = async () => {
      checkCount += 1;
    };

    service.scheduleAutomaticUpdateCheck(15);
    assert.ok(service.autoUpdateTimer);
    await delay(45);
    assert.equal(checkCount, 1);

    service.settings.autoUpdateEnabled = false;
    service.scheduleAutomaticUpdateCheck(15);
    assert.equal(service.autoUpdateTimer, null);
    await delay(25);
    assert.equal(checkCount, 1);
  });
});
