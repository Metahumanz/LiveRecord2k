'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { reuseVerifiedNativeVideo } = require('../src/server/danmaku/native-video-output.cjs');
const { createSceneChunkProgress } = require('../src/server/danmaku/scene-chunk-progress.cjs');
const { createFfmpegJobProgress, setFfmpegJobPhase, updateFfmpegJobProgress } = require('../src/server/shared/helpers.cjs');

test('native video reuse requires storage and PTS admission, preserves bytes and honours cancellation', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'br2k-native-output-test-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const source = path.join(dir, 'native.mkv'), target = path.join(dir, 'chunk.mkv');
  const bytes = Buffer.alloc(2048, 17); await fs.writeFile(source, bytes);
  const verified = { ptsBridge: { ok: true }, outputStorageVerified: true };
  for (const metrics of [{}, { ...verified, outputStorageVerified: false }, { ...verified, ptsBridge: { ok: false } }]) {
    await assert.rejects(reuseVerifiedNativeVideo(source, target, metrics), /未通过/);
    assert.deepEqual(await fs.readFile(source), bytes);
  }
  await assert.rejects(reuseVerifiedNativeVideo(source, target, verified, { isCancelled: () => true }), { code: 'BR2K_MEDIA_CANCELLED' });
  await assert.rejects(reuseVerifiedNativeVideo(source, path.join(dir, 'other', 'chunk.mkv'), verified), /同一工作目录/);
  await assert.rejects(reuseVerifiedNativeVideo(source, path.join(dir, 'chunk.mp4'), verified), /独立 MKV/);
  await fs.writeFile(target, 'previous');
  await reuseVerifiedNativeVideo(source, target, verified);
  assert.deepEqual(await fs.readFile(target), bytes);
  await assert.rejects(fs.stat(source), { code: 'ENOENT' });
});

test('remux stderr cannot restart the render clock or lower completed media progress', () => {
  const progress = createFfmpegJobProgress({ kind: 'export', durationSec: 30 });
  setFfmpegJobPhase(progress, 'render');
  let renderReports = 0;
  const callbacks = createSceneChunkProgress({
    onStderr: text => updateFfmpegJobProgress(progress, text),
    onPhase: (phase, options) => setFfmpegJobPhase(progress, phase, options),
    onProgress: seconds => { renderReports++; setFfmpegJobPhase(progress, 'render'); updateFfmpegJobProgress(progress, `out_time_us=${seconds * 1e6}`); }
  });
  callbacks.onStderr('out_time_us=29000000'); assert.equal(renderReports, 1);
  progress.renderFps = 300; progress.realtimeFactor = 5;
  progress.stageFps = { pipelineFps: 170.9, scene: 170.9 };
  callbacks.onPhase('mux', { stageLabel: '正在封装输出' }); callbacks.onStderr('out_time_us=1000000');
  assert.equal(renderReports, 1); assert.equal(progress.phase, 'mux');
  assert.equal(progress.currentTimeSec, 30); assert.equal(progress.percent, 100);
  assert.equal(progress.phaseCurrentTimeSec, 1);
  assert.equal(progress.renderFps, null); assert.equal(progress.realtimeFactor, null);
  assert.equal(progress.stageFps, undefined);
  assert.match(progress.message, /封装/);
  callbacks.onPhase('render', { force: true }); callbacks.onStderr('out_time_us=2000000');
  assert.equal(renderReports, 2); assert.equal(progress.phase, 'render');
});
