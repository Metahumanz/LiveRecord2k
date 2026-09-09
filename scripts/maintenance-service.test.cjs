'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { LiveRecordService } = require('../src/server/app/service.cjs');
const { MaintenanceService } = require('../src/server/app/maintenance-service.cjs');

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

  assert.deepEqual(await service.prepareVersionedCaches(), { cleared: false });
  assert.deepEqual(await service.getDiskSpace('D:\\recordings'), { checkedPath: 'D:\\recordings' });
  assert.deepEqual(
    await service.cleanupMergedSegmentResiduals({ confirm: true, scanId: 'scan-1' }),
    { scanId: 'scan-1' }
  );
  assert.deepEqual(calls, [
    'cache',
    ['disk', 'D:\\recordings'],
    ['cleanup', { confirm: true, scanId: 'scan-1' }]
  ]);
});
