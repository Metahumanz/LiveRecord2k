'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { LiveRecordService } = require('../src/server/app/service.cjs');
const { MaintenanceService } = require('../src/server/app/maintenance-service.cjs');

function createService(outputDir) {
  const service = new LiveRecordService();
  service.settings.outputDir = outputDir;
  service.log = () => {};
  service.emitState = () => {};
  service.saveStore = async () => {};
  return service;
}

async function fileExists(filePath) {
  return Boolean(await fsp.stat(filePath).catch(() => null));
}

async function createMergedGroup(outputDir, name = 'session') {
  const sourcePath = path.join(outputDir, `${name}-part.clean.mp4`);
  const mergedPath = path.join(outputDir, `${name}.merged.mp4`);
  await Promise.all([fsp.writeFile(sourcePath, 'source'), fsp.writeFile(mergedPath, 'merged')]);
  return { sourcePath, mergedPath };
}

function addMergedRecording(service, sourcePath, mergedPath) {
  service.recordings = [
    service.normalizeRecording({
      cleanPath: mergedPath,
      mergeGroup: 'maintenance-test-group',
      mergeOutputPath: mergedPath,
      segmentReason: 'merged',
      mergedFrom: [sourcePath],
      cleanupId: 'maintenance-test-cleanup'
    })
  ];
}

test('LiveRecordService 将缓存、磁盘与确认清理入口委托给 MaintenanceService', async () => {
  const service = new LiveRecordService();
  assert.ok(service.maintenanceService instanceof MaintenanceService);
  const calls = [];
  service.maintenanceService.prepareVersionedCaches = async () => {
    calls.push('cache');
    return { cleared: false };
  };
  service.maintenanceService.getDiskSpace = async (targetPath) => {
    calls.push(['disk', targetPath]);
    return { checkedPath: targetPath };
  };
  service.maintenanceService.cleanupMergedSegmentResiduals = async (options) => {
    calls.push(['cleanup', options]);
    return { scanId: 'scan-1' };
  };
  service.maintenanceService.clearMaintenanceCleanupPlans = () => {
    calls.push('clear');
    return 1;
  };

  assert.deepEqual(await service.prepareVersionedCaches(), { cleared: false });
  assert.deepEqual(await service.getDiskSpace('D:\\recordings'), { checkedPath: 'D:\\recordings' });
  assert.deepEqual(
    await service.cleanupMergedSegmentResiduals({ confirm: true, scanId: 'scan-1' }),
    { scanId: 'scan-1' }
  );
  assert.equal(service.clearMaintenanceCleanupPlans(), 1);
  assert.deepEqual(calls, [
    'cache',
    ['disk', 'D:\\recordings'],
    ['cleanup', { confirm: true, scanId: 'scan-1' }],
    'clear'
  ]);
});

test('维护清理先扫描再确认，确认后只删除合并前源分段', async () => {
  const outputDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'br2k-maintenance-confirm-'));
  try {
    const { sourcePath, mergedPath } = await createMergedGroup(outputDir);
    const service = createService(outputDir);
    addMergedRecording(service, sourcePath, mergedPath);

    const scan = await service.cleanupMergedSegmentResiduals();
    assert.ok(scan.scanId);
    assert.equal(scan.fileCount, 1);
    assert.equal(await fileExists(sourcePath), true);

    await service.cleanupMergedSegmentResiduals({ confirm: true, scanId: scan.scanId });
    assert.equal(await fileExists(sourcePath), false);
    assert.equal(await fileExists(mergedPath), true);
    assert.equal(service.maintenanceCleanupPlans.has(scan.scanId), false);
  } finally {
    await fsp.rm(outputDir, { recursive: true, force: true });
  }
});

test('过期维护扫描拒绝确认，且不会删除源文件', async () => {
  const outputDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'br2k-maintenance-expired-'));
  try {
    const { sourcePath, mergedPath } = await createMergedGroup(outputDir);
    const service = createService(outputDir);
    addMergedRecording(service, sourcePath, mergedPath);

    const scan = await service.cleanupMergedSegmentResiduals();
    service.maintenanceCleanupPlans.get(scan.scanId).createdAt = Date.now() - 11 * 60 * 1000;

    await assert.rejects(
      () => service.cleanupMergedSegmentResiduals({ confirm: true, scanId: scan.scanId }),
      (error) => error?.code === 'CLEANUP_SCAN_EXPIRED'
    );
    assert.equal(await fileExists(sourcePath), true);
    assert.equal(service.maintenanceCleanupPlans.has(scan.scanId), false);
  } finally {
    await fsp.rm(outputDir, { recursive: true, force: true });
  }
});

test('清理计划中的输出目录外文件会被拒绝，失败后计划不会残留', async () => {
  const rootDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'br2k-maintenance-outside-'));
  const outputDir = path.join(rootDir, 'recordings');
  const outsideDir = path.join(rootDir, 'outside');
  try {
    await Promise.all([fsp.mkdir(outputDir), fsp.mkdir(outsideDir)]);
    const { sourcePath, mergedPath } = await createMergedGroup(outsideDir, 'outside');
    const service = createService(outputDir);
    const scanId = 'unsafe-plan';
    service.maintenanceCleanupPlans.set(scanId, {
      createdAt: Date.now(),
      candidates: [
        {
          mergedRecording: service.normalizeRecording({
            cleanPath: mergedPath,
            mergeGroup: 'outside-group',
            mergeOutputPath: mergedPath,
            segmentReason: 'merged'
          }),
          segments: [service.normalizeRecording({ cleanPath: sourcePath })],
          cleanupId: ''
        }
      ]
    });

    await service.cleanupMergedSegmentResiduals({ confirm: true, scanId });
    assert.equal(await fileExists(sourcePath), true);
    assert.equal(await fileExists(mergedPath), true);
    assert.equal(service.maintenanceCleanupPlans.has(scanId), false);
  } finally {
    await fsp.rm(rootDir, { recursive: true, force: true });
  }
});

test('损坏 metadata 不会阻断其他有效合并记录的扫描', async () => {
  const outputDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'br2k-maintenance-corrupt-metadata-'));
  try {
    const { sourcePath, mergedPath } = await createMergedGroup(outputDir, 'valid');
    await fsp.writeFile(path.join(outputDir, 'broken.merged.mp4.metadata.json'), '{not valid json');
    const service = createService(outputDir);
    addMergedRecording(service, sourcePath, mergedPath);

    const scan = await service.cleanupMergedSegmentResiduals();
    assert.ok(scan.scanId);
    assert.equal(scan.fileCount, 1);
    assert.equal(scan.skippedGroupCount, 0);
  } finally {
    await fsp.rm(outputDir, { recursive: true, force: true });
  }
});

test('确认失败和服务停止都不会保留未完成的维护清理计划', async () => {
  const service = createService(path.join(os.tmpdir(), 'br2k-maintenance-plan-state'));
  const failedScanId = 'failed-plan';
  service.maintenanceCleanupPlans.set(failedScanId, {
    createdAt: Date.now(),
    candidates: [{ mergedRecording: { cleanPath: 'missing.merged.mp4' }, segments: [], cleanupId: '' }]
  });
  service.cleanupMergedSegmentFiles = async () => {
    throw new Error('模拟删除失败');
  };

  await service.cleanupMergedSegmentResiduals({ confirm: true, scanId: failedScanId });
  assert.equal(service.maintenanceCleanupPlans.has(failedScanId), false);

  service.maintenanceCleanupPlans.set('shutdown-plan', { createdAt: Date.now(), candidates: [] });
  assert.equal(service.clearMaintenanceCleanupPlans(), 1);
  assert.equal(service.maintenanceCleanupPlans.size, 0);
  const serviceSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'server', 'app', 'service.cjs'), 'utf8');
  assert.match(serviceSource, /this\.clearMaintenanceCleanupPlans\(\);/);
});
