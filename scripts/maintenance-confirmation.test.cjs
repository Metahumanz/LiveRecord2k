const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const serviceSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'server', 'app', 'service.cjs'), 'utf8');
const maintenanceServiceSource = fs.readFileSync(
  path.join(__dirname, '..', 'src', 'server', 'app', 'maintenance-service.cjs'),
  'utf8'
);
const maintenanceSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'client', 'pages', 'MaintenancePage.tsx'), 'utf8');

test('merged-residual cleanup scans into an expiring plan before a confirmation can delete', () => {
  assert.match(serviceSource, /maintenanceService/);
  assert.match(maintenanceServiceSource, /maintenanceCleanupPlans/);
  assert.match(maintenanceServiceSource, /options\.confirm/);
  assert.match(maintenanceServiceSource, /CLEANUP_SCAN_EXPIRED/);
  assert.match(maintenanceServiceSource, /preview: true/);
});

test('maintenance UI previews configuration changes and cleanup files before applying either action', () => {
  assert.match(maintenanceSource, /getSettingsImportChanges/);
  assert.match(maintenanceSource, /确认导入变更/);
  assert.match(maintenanceSource, /高风险/);
  assert.match(maintenanceSource, /scanMergedResiduals/);
  assert.match(maintenanceSource, /确认清理/);
  assert.doesNotMatch(maintenanceSource, /recorder\.saveSettings\(importedSettings\)/);
});
