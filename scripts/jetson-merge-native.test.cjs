'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const helpers = require('../src/server/shared/helpers.cjs');
const moduleEntry = require.cache[require.resolve('../src/server/shared/helpers.cjs')];
let captured = async () => ({ status: 0, stderr: '' });
moduleEntry.exports = { ...helpers, assertDiskSpace: async () => {}, getFileSize: async () => 1000,
  runCapturedProcess: (...args) => captured(...args) };
const { LiveRecordService } = require('../src/server/app/service.cjs');
moduleEntry.exports = helpers;

async function setup(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'br2k-merge-native-test-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const app = new LiveRecordService(); app.log = () => {};
  app.ffmpegCapabilities.sceneGpuRenderer = { available: true, backend: 'cuda-gstreamer', nativeNvmmScene: true, helper: '/helper' };
  const video = { codec: 'h264', width: 1920, height: 1080, bitDepth: 8, rFrameRate: '60/1', fps: 60 };
  return { app, options: { cleanPath: '/source.mp4', encodedVideoPath: path.join(dir, 'video.mkv'),
    sourceVideo: video, targetVideo: { ...video, width: 3840, height: 2160 }, duration: 144, codec: 'h264_nvv4l2',
    width: 3840, height: 2160, fps: 60, quality: 20, label: 'normalize', createRawArgs: () => [], createMuxArgs: () => [], isCancelled: () => false } };
}

test('merge admits a 30 second real source and runs native from the canonical input with the selected bitrate', async t => {
  const { app, options } = await setup(t); let canonicalArgs, probe, run; const phases = [];
  captured = async (_, args) => { canonicalArgs = args; return { status: 0, stderr: '' }; };
  app.probeJetsonNativeSceneForSource = async opts => { probe = opts; return { ok: true, durationSec: 30, metrics: { pipelineFps: 90 } }; };
  app.runJetsonCudaSceneGraphTranscode = async opts => { run = opts; return 'native'; };
  app.runJetsonGstreamerTranscode = () => { throw new Error('unexpected CPU'); };
  options.onPhase = phase => phases.push(phase);
  assert.equal(await app.runMergeJetsonNormalize(options), 'native');
  assert.equal(probe.sampleDurationSec, 30); assert.equal(probe.cleanPath, canonicalArgs.at(-1));
  assert(path.basename(probe.temporaryDir).startsWith('br2k-nvdec-job-'));
  assert.notEqual(probe.temporaryDir, path.dirname(options.encodedVideoPath));
  assert.equal(run.cleanPath, probe.cleanPath); assert.equal(run.decoder, 'gstreamer-nvv4l2');
  assert.equal(run.bitrate, 25000000); assert.equal(run.nativeTimestampedOutput, true);
  assert.deepEqual(phases, ['prepare']); assert.equal(await fs.stat(canonicalArgs.at(-1)).catch(() => null), null);
  assert.equal(await fs.stat(probe.temporaryDir).catch(() => null), null);
});

test('formatted HEVC metadata selects h265parse without the H.264 rewrite', async t => {
  const { app, options } = await setup(t);
  options.sourceVideo.codec = 'hevc (hvc1 / 0x31637668)';
  captured = () => { throw new Error('HEVC must not enter the H.264 BSF'); };
  app.probeJetsonNativeSceneForSource = async opts => { assert.equal(opts.sourceCodec, 'hevc'); return { ok: true, durationSec: 30 }; };
  app.runJetsonCudaSceneGraphTranscode = async opts => { assert.equal(opts.nativeDecode.sourceCodec, 'hevc'); return 'native-hevc'; };
  assert.equal(await app.runMergeJetsonNormalize(options), 'native-hevc');
});

test('sparse frame clocks inspect a bounded larger interval instead of requiring frames inside a source PTS hole', async t => {
  const { app, options } = await setup(t); options.sourceVideo.fps = 24.8;
  captured = async () => ({ status: 0, stderr: '' });
  app.probeJetsonNativeSceneForSource = async opts => { assert.equal(opts.sampleDurationSec, 120); return { ok: true, durationSec: 65 }; };
  app.runJetsonCudaSceneGraphTranscode = async () => 'native-sparse';
  assert.equal(await app.runMergeJetsonNormalize(options), 'native-sparse');
});

test('a bitstream filter diagnostic is fatal to admission even if FFmpeg exited 0', async t => {
  const { app, options } = await setup(t); let cpu = 0;
  captured = async () => ({ status: 0, stderr: 'Error applying bitstream filters to packet' });
  app.probeJetsonNativeSceneForSource = () => { throw new Error('bad input must not be admitted'); };
  app.runJetsonGstreamerTranscode = async opts => { cpu++; assert.equal(opts.decoder, 'software'); return 'compatibility'; };
  assert.equal(await app.runMergeJetsonNormalize(options), 'compatibility'); assert.equal(cpu, 1);
});

test('admitted native failure stops without CPU or outer encoder restart, and cancellation stays cancellation', async t => {
  const { app, options } = await setup(t); captured = async () => ({ status: 0, stderr: '' });
  app.probeJetsonNativeSceneForSource = async () => ({ ok: true, durationSec: 30 });
  app.runJetsonCudaSceneGraphTranscode = async opts => { opts.onProgress(90); throw new Error('NVDEC runtime failed'); };
  app.runJetsonGstreamerTranscode = () => { throw new Error('unexpected CPU restart'); };
  await assert.rejects(app.runMergeJetsonNormalize(options), e => e.code === 'BR2K_NATIVE_RUNTIME_FAILED_AFTER_COMMIT' && e.processedMediaSeconds === 90);
  options.isCancelled = () => true;
  await assert.rejects(app.runMergeJetsonNormalize(options), e => e.code === 'BR2K_MEDIA_CANCELLED');
});
