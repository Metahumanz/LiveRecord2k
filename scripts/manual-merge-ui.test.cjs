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
const {
  getManualMergeSelection, getSameLiveMergeSuggestions, ManualMergeControls, ManualMergeProgress,
  MergeConfirmation, SameLiveMergeSuggestions
} = compiled.exports;
const rooms = [{ id: '883263', realRoomId: 883263, shortId: 123, recording: false }];
const rows = [{ cleanPath: 'later', roomId: '883263', startedAt: 2, valid: true },
  { cleanPath: 'earlier', roomId: 883263, startedAt: 1, valid: true }];

const progressModule = new Module(filename, module);
progressModule.filename = filename; progressModule.paths = module.paths;
progressModule._compile(buildSync({ entryPoints: [path.join(__dirname, '../src/client/components/common.tsx')],
  bundle: true, platform: 'node', format: 'cjs', jsx: 'automatic', external: ['react', 'react/jsx-runtime', 'lucide-react'], write: false
}).outputFiles[0].text, filename);
const { JobProgress } = progressModule.exports;

test('delete option is opt-in and validated cleanup no longer offers cancellation', () => {
  let checked;
  const props = { selecting: true, count: 2, reason: '', busy: false, onToggle() {}, onMerge() {},
    onDeleteSourcesChange(value) { checked = value; } };
  const tree = ManualMergeControls(props);
  const checkbox = tree.props.children[1].props.children[0];
  assert.equal(checkbox.props.checked, false);
  checkbox.props.onChange({ target: { checked: true } });
  assert.equal(checked, true);
  const html = renderToStaticMarkup(React.createElement(ManualMergeControls, { ...props, deleteSources: true }));
  assert.match(html, /checked=""/); assert.match(html, /配套弹幕、头像和 Scene/);
  const cleanup = renderToStaticMarkup(React.createElement(ManualMergeProgress, { rooms: [{ ...rooms[0], mergeProgress: {
    kind: 'merge', id: 'job', manual: true, status: 'running', cleanupStarted: true, message: '正在清理所选源文件'
  } }], busy: new Set(), onCancel() {}, onRetry() {} }));
  assert.doesNotMatch(cleanup, /中断合并/);
});

test('export merge panel retains live progress, completion and job-scoped cancellation in the existing style', () => {
  const progress = { kind: 'merge', id: 'current-job', manual: true, status: 'running', phase: 'verify',
    stageLabel: '正在合并弹幕记录', message: '正在合并弹幕记录', phasePercent: 50,
    stageProgress: { completed: 1048576, total: 2097152, unit: 'bytes', eventCount: 256 } };
  const props = { rooms: [{ ...rooms[0], mergeProgress: progress }], busy: new Set(), onCancel() {}, onRetry() {} };
  const html = renderToStaticMarkup(React.createElement(ManualMergeProgress, props));
  assert.match(html, /合并弹幕记录 50%/); assert.match(html, /1.00 \/ 2.00 MB/);
  assert.match(html, /256 条弹幕/); assert.match(html, /wide-button danger fill/);
  assert.doesNotMatch(html, /正在验证输出|indeterminate|检查合并结果与音画时间轴/);
  let cancelled;
  const card = ManualMergeProgress({ ...props, onCancel: (...args) => { cancelled = args; } }).props.children[0];
  card.props.children[2].props.onClick();
  assert.deepEqual(cancelled, ['883263', 'current-job']);
  const avatar = renderToStaticMarkup(React.createElement(JobProgress, { progress: { ...progress,
    stageLabel: '正在合并头像文件', stageProgress: { completed: 12, total: 24, unit: 'items' } } }));
  assert.match(avatar, /合并头像文件 50%/); assert.match(avatar, /12 \/ 24 条头像记录/);
  const done = renderToStaticMarkup(React.createElement(ManualMergeProgress, { ...props,
    rooms: [{ ...rooms[0], mergeProgress: { ...progress, status: 'completed' } }] }));
  assert.match(done, /完成/); assert.doesNotMatch(done, /中断合并/);
});

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

test('same-live suggestions require adjacent completed source recordings in one room', () => {
  const start = Date.parse('2026-09-12T20:00:00+08:00');
  const source = (name, minute, durationSec = 600, extra = {}) => ({
    cleanPath: name, roomId: '883263', startedAt: start + minute * 60_000,
    durationSec, valid: true, ...extra
  });
  const recordings = [
    source('part-2.mp4', 12), source('part-1.mp4', 0),
    source('part-3.mp4', 37), // exactly 15 minutes after part 2 ends
    source('next-live.mp4', 63), // 16 minutes later: separate broadcast
    source('other-room.mp4', 46, 600, { roomId: '7953876' }),
    source('unknown-duration.mp4', 48, 0),
    source('incomplete.mp4', 49, 600, { containerStage: 'capturing' }),
    source('merged.mp4', 0, 2220, { mergedFrom: ['part-1.mp4'] })
  ];
  const suggestions = getSameLiveMergeSuggestions(recordings, rooms);
  assert.deepEqual(suggestions.map(group => group.recordings.map(row => row.cleanPath)), [
    ['part-2.mp4', 'part-3.mp4']
  ]);
  assert.equal(suggestions[0].gapsSec[0], 900);
  const html = renderToStaticMarkup(React.createElement(SameLiveMergeSuggestions, {
    suggestions, recordings, rooms, busy: false, onChoose() {}
  }));
  assert.match(html, /疑似同场直播/);
  assert.match(html, /一键合并/);
  assert.match(html, /时间推测/);
});

test('overlapping duplicate ranges and a busy room are never silently submitted', () => {
  const start = Date.parse('2026-09-12T20:00:00+08:00');
  const recordings = [
    { cleanPath: 'a.mp4', roomId: '883263', startedAt: start, durationSec: 3600, valid: true },
    { cleanPath: 'b.mp4', roomId: '883263', startedAt: start + 5 * 60_000, durationSec: 600, valid: true },
    { cleanPath: 'c.mp4', roomId: '883263', startedAt: start + 17 * 60_000, durationSec: 600, valid: true }
  ];
  const suggestions = getSameLiveMergeSuggestions(recordings, rooms);
  assert.deepEqual(suggestions.map(group => group.recordings.map(row => row.cleanPath)), [['b.mp4', 'c.mp4']]);
  const busyRooms = [{ ...rooms[0], recording: true }];
  let chosen = 0;
  const suggestion = SameLiveMergeSuggestions({ suggestions, recordings, rooms: busyRooms, busy: false,
    onChoose() { chosen++; } });
  const button = suggestion.props.children[1][0].props.children[1];
  assert.equal(button.props.disabled, true);
  assert.equal(chosen, 0);
});

test('a validated merged recording can join later segments without suggesting its original sources again', () => {
  const start = Date.parse('2026-09-12T20:00:00+08:00');
  const recordings = [
    { cleanPath: 'part-1.mp4', roomId: '883263', startedAt: start, durationSec: 600, valid: true },
    { cleanPath: 'part-2.mp4', roomId: '883263', startedAt: start + 12 * 60_000, durationSec: 600, valid: true },
    { cleanPath: 'merged.mp4', roomId: '883263', startedAt: start, durationSec: 1320, valid: true,
      mergedFrom: ['part-1.mp4', 'part-2.mp4'] },
    { cleanPath: 'part-3.mp4', roomId: '883263', startedAt: start + 25 * 60_000, durationSec: 600, valid: true }
  ];
  assert.deepEqual(getSameLiveMergeSuggestions(recordings, rooms).map(group =>
    group.recordings.map(row => row.cleanPath)), [['merged.mp4', 'part-3.mp4']]);
});

test('nearby segments from different known live sessions stay in separate suggestions', () => {
  const start = Date.parse('2026-09-26T20:00:00+08:00');
  const recordings = [
    { cleanPath: 'first.mp4', roomId: '883263', startedAt: start, durationSec: 600,
      valid: true, liveSessionId: 'broadcast-a' },
    { cleanPath: 'second.mp4', roomId: '883263', startedAt: start + 11 * 60_000, durationSec: 600,
      valid: true, liveSessionId: 'broadcast-a' },
    { cleanPath: 'new-live.mp4', roomId: '883263', startedAt: start + 22 * 60_000, durationSec: 600,
      valid: true, liveSessionId: 'broadcast-b' },
    { cleanPath: 'new-live-2.mp4', roomId: '883263', startedAt: start + 33 * 60_000, durationSec: 600,
      valid: true, liveSessionId: 'broadcast-b' }
  ];
  assert.deepEqual(getSameLiveMergeSuggestions(recordings, rooms).map(group =>
    group.recordings.map(row => row.cleanPath)), [['new-live.mp4', 'new-live-2.mp4'], ['first.mp4', 'second.mp4']]);
});

test('a missing session id between two known broadcasts cannot bridge them', () => {
  const start = Date.parse('2026-09-26T20:00:00+08:00');
  const recordings = [
    { cleanPath: 'a.mp4', roomId: '883263', startedAt: start, durationSec: 600,
      valid: true, liveSessionId: 'broadcast-a' },
    { cleanPath: 'unknown.mp4', roomId: '883263', startedAt: start + 11 * 60_000, durationSec: 600, valid: true },
    { cleanPath: 'b.mp4', roomId: '883263', startedAt: start + 22 * 60_000, durationSec: 600,
      valid: true, liveSessionId: 'broadcast-b' }
  ];
  assert.deepEqual(getSameLiveMergeSuggestions(recordings, rooms).map(group =>
    group.recordings.map(row => row.cleanPath)), [['a.mp4', 'unknown.mp4']]);
});

test('overlapping manual outputs with shared source content are not suggested for another merge', () => {
  const start = Date.parse('2026-09-26T23:11:55+08:00');
  const recordings = [
    { cleanPath: 'first-manual.merged.mp4', roomId: '883263', startedAt: start, durationSec: 21.1,
      valid: true, liveSessionId: 'broadcast-a', mergedFrom: ['same.clean.mp4', 'later.clean.mp4'] },
    { cleanPath: 'second-manual.merged.mp4', roomId: '883263', startedAt: start, durationSec: 19.09,
      valid: true, liveSessionId: 'broadcast-a', mergedFrom: ['same.clean.mp4', 'middle.clean.mp4'] }
  ];
  assert.deepEqual(getSameLiveMergeSuggestions(recordings, rooms), []);
});

test('one-click and manual paths require a separate explicit confirmation of sources and deletion', () => {
  const start = Date.parse('2026-09-12T20:00:00+08:00');
  const selected = [
    { cleanPath: 'one.mp4', startedAt: start, durationSec: 600 },
    { cleanPath: 'two.mp4', startedAt: start + 12 * 60_000, durationSec: 600 }
  ];
  let submissions = 0;
  const props = { selected, reason: '', deleteSources: false, busy: false,
    onDeleteSourcesChange() {}, onCancel() {}, onConfirm() { submissions++; } };
  const html = renderToStaticMarkup(React.createElement(MergeConfirmation, props));
  assert.match(html, /确认合并 2 段录像/);
  assert.match(html, /one\.mp4/);
  assert.match(html, /two\.mp4/);
  assert.match(html, /与上一段间隔 00:02:00/);
  assert.doesNotMatch(html, /checked=""/);
  assert.equal(submissions, 0);
  const dialog = MergeConfirmation(props).props.children;
  dialog.props.children[5].props.children[1].props.onClick();
  assert.equal(submissions, 1);
  const blocked = renderToStaticMarkup(React.createElement(MergeConfirmation, { ...props, reason: '该房间正在录制' }));
  assert.match(blocked, /该房间正在录制/);
  assert.match(blocked, /disabled=""/);
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
