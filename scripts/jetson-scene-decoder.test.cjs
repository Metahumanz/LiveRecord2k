'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { selectJetsonSceneDecoder } = require('../src/server/danmaku/jetson-scene-decoder.cjs');
const native = { value: 'gstreamer-nvv4l2', kind: 'hardware' };
const merged = { mergedFrom: ['a.mp4', 'b.mp4'] };

test('sparse source timestamps still produce every raw frame through the requested boundary', t => {
  const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
  const { spawnSync } = require('node:child_process');
  const ffmpeg = require('ffmpeg-static');
  const { createBurnRawVideoArgs } = require('../src/server/recording/ffmpeg.cjs');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'br2k-sparse-clock-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const source = path.join(directory, 'sparse.mkv');
  const fixture = spawnSync(ffmpeg, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=160x90:rate=60:duration=3',
    '-vf', 'select=lt(t\\,0.9)+gt(t\\,2.8)', '-fps_mode', 'vfr', '-c:v', 'libx264', source], { timeout: 30_000 });
  assert.equal(fixture.status, 0, fixture.stderr?.toString());
  for (const leadingVideoPaddingSec of [0, 0.005]) {
    const args = createBurnRawVideoArgs({ cleanPath: source, fps: 60, duration: 2, startTime: 0,
      directRaw: true, normalizeFrameClock: true, leadingVideoPaddingSec, videoWidth: 160, videoHeight: 90 });
    const result = spawnSync(ffmpeg, args, { timeout: 30_000, maxBuffer: 4 * 1024 * 1024 });
    assert.equal(result.status, 0, result.stderr?.toString());
    assert.equal(result.stdout.length, 120 * 160 * 90 * 3 / 2);
  }
});

test('compact export requests recover canonical merge provenance before decoder selection', () => {
  const { LiveRecordService } = require('../src/server/app/service.cjs');
  const app = new LiveRecordService();
  const cleanPath = require('node:path').resolve('fixture.merged.mp4');
  app.recordings = [{ cleanPath, ...merged, videoInfo: { fps: 56.869816966823954, rFrameRate: '60/1' } }];
  const recording = app.hydrateRecordingFromLibrary(app.normalizeRecording({ cleanPath }));
  assert.equal(selectJetsonSceneDecoder(native, recording, recording.videoInfo).value, 'software');
  assert.equal(selectJetsonSceneDecoder(native, { timingInfo: { sourceSegments: [{}, {}] } }, recording.videoInfo).value, 'software');
});

test('merged mixed-rate inputs use a CPU clock while preserving a valid hardware encoding rate', () => {
  for (const fps of [56.869816966823954, 64.33]) {
    const decoder = selectJetsonSceneDecoder(native, merged, { fps, rFrameRate: '60/1' });
    assert.equal(decoder.value, 'software');
    assert.equal(decoder.normalizedFps, 60);
    assert.match(decoder.reason, /保留 CUDA 合成与硬件编码/);
  }
});

test('stable merged clocks, non-merged sources, unknown rates and other decoders retain their existing selection', () => {
  assert.equal(selectJetsonSceneDecoder(native, merged, { fps: 59.999928, rFrameRate: '60/1' }), native);
  assert.equal(selectJetsonSceneDecoder(native, merged, { fps: 29.97002997, rFrameRate: '30000/1001' }), native);
  assert.equal(selectJetsonSceneDecoder(native, {}, { fps: 30, rFrameRate: '60/1' }), native);
  assert.equal(selectJetsonSceneDecoder(native, merged, { fps: 30, rFrameRate: '0/0' }), native);
  const cuda = { value: 'cuda', kind: 'hardware' };
  assert.equal(selectJetsonSceneDecoder(cuda, merged, { fps: 30, rFrameRate: '60/1' }), cuda);
});
