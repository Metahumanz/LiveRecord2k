'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { LiveRecordService } = require('../src/server/app/service.cjs');
const { UpdateService } = require('../src/server/app/update-service.cjs');

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
  service.emitState = () => {};
  service.log = () => {};

  const state = await service.checkUpdate();

  assert.equal(state.update.status, 'up-to-date');
  assert.equal(state.update.latestVersion, service.updateState.currentVersion);
});
