const assert = require('node:assert/strict');
const path = require('node:path');
const Module = require('node:module');
const test = require('node:test');
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');
const { buildSync } = require('esbuild');
const filename = path.join(__dirname, 'manual-merge-ui.compiled.cjs');
const compiled = new Module(filename, module);
compiled.filename = filename;
compiled.paths = module.paths;
compiled._compile(buildSync({ entryPoints: [path.join(__dirname, '../src/client/components/ManualMergeControls.tsx')],
  bundle: true, platform: 'node', format: 'cjs', jsx: 'automatic', external: ['react', 'react/jsx-runtime', 'lucide-react'], write: false
}).outputFiles[0].text, filename);
const { getManualMergeSelection, ManualMergeControls } = compiled.exports;
const rooms = [{ id: '883263', realRoomId: 883263, shortId: 123, recording: false }];
const rows = [{ cleanPath: 'later', roomId: '883263', startedAt: 2, valid: true },
  { cleanPath: 'earlier', roomId: 883263, startedAt: 1, valid: true }];

const progressModule = new Module(filename, module);
progressModule.filename = filename; progressModule.paths = module.paths;
progressModule._compile(buildSync({ entryPoints: [path.join(__dirname, '../src/client/components/common.tsx')],
  bundle: true, platform: 'node', format: 'cjs', jsx: 'automatic', external: ['react', 'react/jsx-runtime', 'lucide-react'], write: false
}).outputFiles[0].text, filename);
const { JobProgress } = progressModule.exports;

test('merge progress renders its true media progress with the existing visual classes', () => {
  const progress = { kind: 'merge', status: 'running', id: 'job', label: 'very-long-uuid.merged.mp4', manual: true,
    sourcePaths: ['a', 'b', 'c'], workStartedAt: 1, phase: 'prepare', phasePercent: 0, phaseDurationSec: 0,
    phaseCurrentTimeSec: 180, durationSec: 3600, stageLabel: '规范化分段 1/3 · 本段3分/1小时',
    message: '等待首个媒体时间戳' };
  const html = renderToStaticMarkup(React.createElement(JobProgress, { progress }));
  assert.match(html, /手动合并 3 段录像/); assert.match(html, /5%/); assert.match(html, /整体已处理/);
  assert.match(html, /class="job-progress running"/);
  assert.doesNotMatch(html, /预渲染纹理|实际管线启动中|等待首个媒体时间戳|very-long-uuid/);
  const copy = renderToStaticMarkup(React.createElement(JobProgress, { progress: { ...progress,
    phase: 'mux', phaseCurrentTimeSec: 600, phaseDurationSec: 3600, phasePercent: 16.7,
    mergeMode: 'copy', mergeReason: '分段规格一致，直接无损拼接', stageLabel: '无损拼接', message: '正在无损拼接' } }));
  assert.match(copy, /拼接 17%/); assert.match(copy, /分段规格一致，直接无损拼接/);
  assert.doesNotMatch(copy, /预渲染纹理|正在渲染/);
  const cancelled = renderToStaticMarkup(React.createElement(JobProgress, { progress: { ...progress,
    status: 'cancelled', message: '合并已取消，源分段已保留' } }));
  assert.match(cancelled, /合并已取消，源分段已保留/);
});

test('same-room selection enables the actual rendered primary button and submits once', () => {
  const selection = getManualMergeSelection(rows, ['later', 'earlier'], rooms);
  assert.equal(selection.reason, '');
  assert.deepEqual(selection.selected.map(row => row.cleanPath), ['earlier', 'later']);
  let submissions = 0;
  const props = { selecting: true, count: 2, reason: selection.reason, busy: false,
    onToggle() {}, onMerge() { submissions++; } };
  const html = renderToStaticMarkup(React.createElement(ManualMergeControls, props));
  assert.match(html, /class="wide-button primary"/);
  assert.doesNotMatch(html, /disabled=/);
  assert.match(html, /合并所选 2 段/);
  const button = ManualMergeControls(props).props.children[0].props.children[1];
  assert.equal(button.props.disabled, false);
  button.props.onClick();
  assert.equal(submissions, 1);
});

test('short IDs and real IDs identify the same configured room', () => {
  assert.equal(getManualMergeSelection([rows[0], { ...rows[1], roomId: '123' }], ['later', 'earlier'], rooms).reason, '');
});

test('cross-room, missing ownership, active tasks and unfinished sources remain blocked with visible reasons', () => {
  const cases = [
    [[rows[0], { ...rows[1], roomId: '7953876' }], rooms],
    [[rows[0], { ...rows[1], roomId: '' }], rooms],
    [rows, [{ ...rooms[0], recording: true }]],
    [rows, [{ ...rooms[0], mergeProgress: { status: 'retrying' } }]],
    [[rows[0], { ...rows[1], containerStage: 'capturing' }], rooms]
  ];
  for (const [recordings, configuredRooms] of cases) {
    const { reason } = getManualMergeSelection(recordings, ['later', 'earlier'], configuredRooms);
    assert.ok(reason);
    const html = renderToStaticMarkup(React.createElement(ManualMergeControls, { selecting: true, count: 2, reason,
      busy: false, onToggle() {}, onMerge() {} }));
    assert.match(html, /disabled=""/);
    assert.match(html, /role="status"/);
    assert.ok(html.includes(reason));
  }
});
