'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

test('Linux installer prints server-provided acceleration summary without installing JetPack', () => {
  const source = fs.readFileSync(path.join(__dirname, 'install-linux.sh'), 'utf8');
  assert.match(source, /STATE_JSON=/);
  assert.match(source, /accelerationDiagnostics/);
  assert.match(source, /diagnostics\.acceleration/);
  assert.doesNotMatch(source, /apt-get install[^\n]*nvidia-l4t|apt install[^\n]*nvidia-l4t/);
});
