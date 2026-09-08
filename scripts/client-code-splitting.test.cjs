const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const appSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'client', 'App.tsx'), 'utf8');
const roomsComponent = fs.readFileSync(
  path.join(__dirname, '..', 'src', 'client', 'components', 'rooms.tsx'),
  'utf8'
);
const exportPage = fs.readFileSync(path.join(__dirname, '..', 'src', 'client', 'pages', 'ExportPage.tsx'), 'utf8');

test('client defers page modules and HLS playback code until they are needed', () => {
  assert.match(appSource, /\blazy\(/);
  assert.match(appSource, /<Suspense\b/);
  assert.match(appSource, /import\('\.\/pages\/OverviewPage'\)/);
  assert.doesNotMatch(appSource, /import \{ OverviewPage \} from '\.\/pages\/OverviewPage';/);

  assert.match(roomsComponent, /import type Hls from 'hls\.js';/);
  assert.match(roomsComponent, /await import\('hls\.js'\)/);
  assert.doesNotMatch(roomsComponent, /import Hls from 'hls\.js';/);

  assert.match(exportPage, /import type Hls from 'hls\.js';/);
  assert.match(exportPage, /import\('hls\.js'\)/);
  assert.doesNotMatch(exportPage, /import Hls from 'hls\.js';/);
});
