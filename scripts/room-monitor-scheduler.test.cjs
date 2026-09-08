const assert = require('node:assert/strict');
const test = require('node:test');

const { getMonitorPollDelayMs, jitterMonitorPollDelay } = require('../src/server/app/room-monitor-scheduler.cjs');

test('room monitor scheduler uses push fallback, disconnect fallback, and bounded jitter', () => {
  const now = 1_000_000;
  assert.equal(getMonitorPollDelayMs({}, { pollIntervalSec: 15 }, true, now), 30_000);
  assert.equal(getMonitorPollDelayMs({}, { pollIntervalSec: 15 }, false, now), 15_000);
  assert.equal(getMonitorPollDelayMs({ monitorFastPollUntil: now + 1 }, {}, true, now), 3_000);
  assert.equal(jitterMonitorPollDelay(10_000, () => 0), 9_000);
  assert.equal(jitterMonitorPollDelay(10_000, () => 1), 11_000);
});
