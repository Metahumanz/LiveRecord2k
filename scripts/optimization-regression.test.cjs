'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const ffmpeg = require('ffmpeg-static');
const { deleteManualMergeSources, snapshotManualMergeArtifacts } = require('../src/server/recording/manual-merge-cleanup.cjs');
const { estimateSceneScratchBytes } = require('../src/server/recording/scene-resources.cjs');
const { createMediaLogAggregator } = require('../src/server/shared/media-log-aggregator.cjs');
const { runBounded } = require('../src/server/shared/bounded-work.cjs');
const { probeMediaTimelineInfo, probeMediaTimelineHealth, runCapturedProcess } = require('../src/server/shared/helpers.cjs');
const { buildSceneGraphJob } = require('../src/server/danmaku/scene-build-job.cjs');
const { buildSceneGraph, clipSceneGraph } = require('../src/server/danmaku/scene-graph.cjs');
const { scanFullMedia } = require('../src/server/recording/media-full-scan.cjs');
const { writeGraph, readGraphLines } = require('../src/server/danmaku/scene-graph-io.cjs');
const { selectDistributedSceneSamples } = require('../src/server/danmaku/desktop-scene-policy.cjs');

test('long output text checks cover the middle and tail, skip empty intervals and reject textless output', () => {
  const objects = [1, 250, 500, 750, 990].map((start, id) => ({ id: String(id), type: 'Text', start, end: start + 5,
    props: { text: '中文' }, frame: { x: 10, y: 10, width: 100, height: 40 } }));
  const graph = { canvas: { width: 640, height: 360 }, objects };
  assert.deepEqual(selectDistributedSceneSamples(graph, 1000).map(sample => sample.objectId), ['0', '1', '2', '3', '4']);
  assert.equal(selectDistributedSceneSamples({ ...graph, objects: [objects[2]] }, 1000).length, 1);
  assert.equal(selectDistributedSceneSamples(graph, 300).length, 1);
  assert.throws(() => selectDistributedSceneSamples({ ...graph, objects: [] }, 1000),
    error => error.code === 'BR2K_SCENE_NO_VISIBLE_TEXT');
});

test('streamed Scene cache preserves unicode, animation history and JSON output without loading irrelevant objects', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'br2k-scene-stream-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const graph = buildSceneGraph(Array.from({ length: 400 }, (_, index) => ({
    type: 'danmaku', time: index, text: `中文测试😀${index}`, uid: String(index), username: '观众'
  })), { width: 640, height: 360, fps: 30, durationSec: 410, stylePreset: 'h5-card' });
  const cache = path.join(root, 'graph.jsonl');
  await writeGraph(cache, graph, true);
  const selected = await readGraphLines(cache, 350, 360);
  assert(selected.objects.length < graph.objects.length);
  assert.deepEqual(clipSceneGraph(selected, 350, 360, { shiftTime: false }),
    clipSceneGraph(graph, 350, 360, { shiftTime: false }));
  const output = path.join(root, 'graph.json');
  await writeGraph(output, selected);
  assert.deepEqual(JSON.parse(await fs.readFile(output, 'utf8')), selected);
  await fs.appendFile(cache, '{broken\n');
  await assert.rejects(readGraphLines(cache, 350, 360), SyntaxError);
});

test('corrupt MKV stops the scan immediately and retains the first cause even when later stderr overflows', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'br2k-corrupt-scan-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const source = path.join(root, 'corrupt.mkv'); await fs.writeFile(source, 'invalid');
  let stopped = false;
  await assert.rejects(scanFullMedia('test-ffmpeg', source, {}, async (_bin, _args, callbacks) => {
    callbacks.onChild({ kill(signal) { assert.equal(signal, 'SIGTERM'); stopped = true; } });
    callbacks.onStdout('#tb 0: 1/1000\n0, 0, 0, 1000, 1, 0\n');
    callbacks.onStderr('0x00 at pos 100 invalid as first byte of an EBML number');
    assert(stopped);
    callbacks.onStderr('closing\n'.repeat(30_000));
    return { status: 0 };
  }), error => error.code === 'BR2K_MEDIA_CORRUPT' && /EBML/.test(error.message));
});

test('manual merge deletion validates all selected sources and protects output and unselected recordings', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'br2k-manual-delete-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const segments = [], expected = {};
  for (let i = 0; i < 2; i++) {
    const dir = path.join(root, String(i)); await fs.mkdir(dir);
    const cleanPath = path.join(dir, 'source.mp4'); await fs.writeFile(cleanPath, 'source');
    await fs.writeFile(cleanPath + '.jsonl', 'event');
    const stat = await fs.stat(cleanPath); segments.push({ cleanPath }); expected[cleanPath] = stat;
  }
  const outputPath = path.join(root, 'merged.mp4'); await fs.writeFile(outputPath, 'merged');
  const unrelated = path.join(root, 'other.mp4'); await fs.writeFile(unrelated, 'other');
  const options = { root, outputPath, segments, expected, artifacts: s => [s.cleanPath, s.cleanPath + '.jsonl'] };
  await assert.rejects(deleteManualMergeSources({ ...options, isBusy: () => true }), /任务/);
  assert.equal(await fs.readFile(segments[0].cleanPath, 'utf8'), 'source');
  await fs.appendFile(segments[1].cleanPath, 'changed');
  await assert.rejects(deleteManualMergeSources(options), /发生变化/);
  assert.equal(await fs.readFile(segments[0].cleanPath, 'utf8'), 'source');
  expected[segments[1].cleanPath] = await fs.stat(segments[1].cleanPath);
  const artifactSnapshot = await snapshotManualMergeArtifacts(segments, options.artifacts);
  let busyChecks = 0, cleanupCommitted = false;
  await assert.rejects(deleteManualMergeSources({ ...options, artifactSnapshot,
    isBusy: () => ++busyChecks > segments.length, onValidated: () => { cleanupCommitted = true; } }), /其它任务/);
  assert.equal(cleanupCommitted, false);
  assert.equal(await fs.readFile(segments[0].cleanPath, 'utf8'), 'source');
  await assert.rejects(deleteManualMergeSources({ ...options, artifactSnapshot, onValidated: () => { throw new Error('取消'); } }), /取消/);
  assert.equal(await fs.readFile(segments[0].cleanPath, 'utf8'), 'source');
  await fs.appendFile(segments[1].cleanPath + '.jsonl', '新增弹幕');
  await assert.rejects(deleteManualMergeSources({ ...options, artifactSnapshot }), /配套文件.*发生变化/);
  assert.equal(await fs.readFile(segments[0].cleanPath, 'utf8'), 'source');
  let committed = false;
  assert.equal(await deleteManualMergeSources({ ...options, onValidated: () => { committed = true; } }), 4);
  assert(committed);
  assert.equal(await fs.readFile(outputPath, 'utf8'), 'merged');
  assert.equal(await fs.readFile(unrelated, 'utf8'), 'other');
});

test('manual merge cleanup ignores directory metadata drift while keeping file fingerprints', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'br2k-manual-avatar-dir-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const sourceDir = path.join(root, 'session');
  const avatarDir = path.join(sourceDir, 'avatars');
  await fs.mkdir(avatarDir, { recursive: true });
  const cleanPath = path.join(sourceDir, 'source.mp4');
  const avatarPath = path.join(avatarDir, 'avatar.jpg');
  const outputPath = path.join(root, 'merged.mp4');
  await Promise.all([fs.writeFile(cleanPath, 'source'), fs.writeFile(avatarPath, 'avatar'), fs.writeFile(outputPath, 'merged')]);
  const segments = [{ cleanPath }];
  const artifacts = () => [cleanPath, avatarDir];
  const expected = { [cleanPath]: await fs.stat(cleanPath) };
  const artifactSnapshot = await snapshotManualMergeArtifacts(segments, artifacts);
  const later = new Date(Date.now() + 10_000);
  await fs.utimes(avatarDir, later, later);
  assert.equal(await deleteManualMergeSources({ root, outputPath, segments, expected, artifacts, artifactSnapshot }), 2);
  assert.equal(await fs.readFile(outputPath, 'utf8'), 'merged');
});

test('scene budget counts pixel identities, grows beyond 1 GiB and keeps fractional text phases distinct', () => {
  const object = { type: 'Text', frame: { x: 0.25, y: 0, width: 1000, height: 1000 }, props: { text: '中文🙂' }, style: { fill: '#fff' } };
  const repeated = { objects: Array.from({ length: 400 }, (_, i) => ({ ...object, id: String(i), start: i })) };
  assert.equal(estimateSceneScratchBytes(repeated).uniqueTextures, 1);
  repeated.objects[1] = { ...object, frame: { ...object.frame, x: 0.5 } };
  assert.equal(estimateSceneScratchBytes(repeated).uniqueTextures, 2);
  const unique = { objects: repeated.objects.map((o, i) => ({ ...o, props: { text: String(i) } })) };
  assert(estimateSceneScratchBytes(unique).scratchBytes > 1024 ** 3);
});

test('unchanged media scan cache works with child tracking and releases the previous child reference', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'br2k-scan-cache-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const source = path.join(root, 'stable.mkv'); await fs.writeFile(source, 'stable');
  let runs = 0, current;
  const options = { onChild(child) { current = child; } };
  const run = async (_bin, _args, callbacks) => {
    runs++; callbacks.onChild({ pid: 1 });
    callbacks.onStdout('#tb 0: 1/1000\n0, 0, 0, 1000, 1, 0\n');
    callbacks.onChild(null); return { status: 0 };
  };
  await scanFullMedia('cache-test', source, options, run);
  current = { pid: 2 };
  await scanFullMedia('cache-test', source, options, run);
  assert.equal(runs, 1); assert.equal(current, null);
  await fs.appendFile(source, 'changed');
  await scanFullMedia('cache-test', source, options, run);
  assert.equal(runs, 2);
});

test('repeated EBML errors aggregate addresses and offsets without losing distinct errors or final counts', () => {
  const logs = []; const warnings = createMediaLogAggregator((level, text) => logs.push(text), '导出：', () => 0);
  for (let i = 0; i < 50; i++) warnings.write(`[matroska @ 0x${i.toString(16)}] 0x00 at pos ${i} invalid as first byte of an EBML number\n[matroska @ 0x999] 0x00 at pos ${i + 50} invalid as first byte of an EBML number`);
  warnings.write('CUDA out of memory'); warnings.flush();
  assert.equal(logs.length, 3); assert(logs.some(s => s.includes('100 次'))); assert(logs.some(s => s.includes('CUDA')));
});

test('bounded file work drains all in-flight operations before reporting failure', async () => {
  let active = 0, peak = 0;
  await assert.rejects(runBounded([1, 2, 3, 4, 5], 2, async value => {
    active++; peak = Math.max(peak, active);
    await new Promise(resolve => setTimeout(resolve, 10)); active--;
    if (value === 2) throw new Error('copy failed');
  }), /copy failed/);
  assert.equal(active, 0); assert.equal(peak, 2);
});

test('one-pass packet scan retains real A/V duration and cache invalidates when source changes', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'br2k-full-scan-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const source = path.join(root, 'test.mkv');
  const create = async duration => {
    const result = await runCapturedProcess(ffmpeg, ['-y', '-f', 'lavfi', '-i', `color=s=64x64:r=30:d=${duration}`,
      '-f', 'lavfi', '-i', `sine=duration=${duration}`, '-c:v', 'libx264', '-c:a', 'aac', source]);
    assert.equal(result.status, 0, result.stderr);
  };
  await create(2);
  const info = { videoInfo: { fps: 30 }, audioInfo: {}, durationSec: 2 };
  const timing = await probeMediaTimelineInfo(ffmpeg, source, info);
  assert(Math.abs(timing.videoPresentationDurationSec - 2) < 0.05, JSON.stringify(timing));
  assert(timing.timingSafeForCopy, JSON.stringify(timing));
  const health = await probeMediaTimelineHealth(ffmpeg, source, info);
  assert.equal(health.copyWarnings?.corruptPacketCount || 0, 0);
  await create(3);
  const changed = await probeMediaTimelineInfo(ffmpeg, source, info);
  assert(changed.videoPresentationDurationSec > 2.95);
});

test('background Scene layout and cached clip retain pre-clip active cards and exact visual objects', async () => {
  const events = Array.from({ length: 300 }, (_, i) => ({ type: 'danmaku', time: i / 10, text: '测试' + i, uid: i }));
  events.push({ type: 'superchat', time: 0, duration: 30, text: '跨剪辑留言', uid: 900, price: 30 });
  const options = { stylePreset: 'h5-card', videoInfo: { width: 640, height: 360 }, overlayMode: 'danmaku-gift' };
  const expected = clipSceneGraph(buildSceneGraph(events, options), 10, 12, { shiftTime: false });
  const runtime = { entry: path.resolve('src/server/index.cjs'), clipStart: 10, clipEnd: 12 };
  const first = await buildSceneGraphJob(events, options, runtime);
  const second = await buildSceneGraphJob(events, options, runtime);
  assert.deepEqual(first.objects, expected.objects);
  assert.deepEqual(second.objects, expected.objects);
});
