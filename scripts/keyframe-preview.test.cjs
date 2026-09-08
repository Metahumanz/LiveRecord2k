const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const roomsComponent = fs.readFileSync(path.join(__dirname, '..', 'src', 'client', 'components', 'rooms.tsx'), 'utf8');

test('keyframe cards use one visibility-aware scheduler instead of per-card intervals', () => {
  assert.match(roomsComponent, /keyframeRefreshSubscribers/);
  assert.match(roomsComponent, /document\.visibilityState/);
  assert.match(roomsComponent, /IntersectionObserver/);
  assert.match(roomsComponent, /room\.liveStatus === 1 \|\| Boolean\(room\.recording\)/);
  assert.doesNotMatch(roomsComponent, /const timer = window\.setInterval\(\(\) => setPreviewVersion/);
});
