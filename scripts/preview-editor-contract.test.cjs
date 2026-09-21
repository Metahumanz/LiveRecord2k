'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const clientRoot = path.join(__dirname, '..', 'src', 'client');
const previewSource = fs.readFileSync(path.join(clientRoot, 'components', 'DanmakuStylePreview.tsx'), 'utf8');
const exportSource = fs.readFileSync(path.join(clientRoot, 'pages', 'ExportPage.tsx'), 'utf8');

test('interactive preview uses local examples instead of a Scene Graph guide', () => {
  assert.doesNotMatch(previewSource, /layoutGuideOnly|resolvedBounds|互动队列从这里向上|preview-layout-guide-label/);
  assert.doesNotMatch(exportSource, /layoutGuideOnly|resolvedBounds|SceneGraphOverlay|getSceneGraph/);
  assert.match(previewSource, /onPointerDown=\{\(event\) => beginInteraction\(event, 'move'\)\}/);
  assert.match(previewSource, /onPointerDown=\{\(event\) => beginInteraction\(event, 'resize'\)\}/);
});

test('interactive preview keeps user danmaku area bounds ahead of preset defaults', () => {
  assert.match(previewSource, /layout\.danmakuAreaTop \?\? style\.danmakuAreaTop/);
  assert.match(previewSource, /layout\.danmakuAreaBottom \?\? style\.danmakuAreaBottom/);
  assert.match(previewSource, /updated\.danmakuAreaBottom = nextBottom/);
});

