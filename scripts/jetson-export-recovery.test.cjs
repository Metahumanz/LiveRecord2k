'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const helpers = require('../src/server/shared/helpers.cjs');
const conformance = require('../src/server/danmaku/gpu-scene-conformance.cjs');
let probeCalls = 0;
let capturedRun;
let capturedVerification;
const verifierModule = require.cache[require.resolve('../src/server/danmaku/scene-output-verifier.cjs')] ||
  (require('../src/server/danmaku/scene-output-verifier.cjs'), require.cache[require.resolve('../src/server/danmaku/scene-output-verifier.cjs')]);
const verifier = verifierModule.exports;
verifierModule.exports = { ...verifier, verifySceneOutputFrame: opts => capturedVerification(opts) };
const helpersModule = require.cache[require.resolve('../src/server/shared/helpers.cjs')];
helpersModule.exports = {
  ...helpers,
  runFfmpegJob: async () => {},
  probeMediaFileInfo: async () => { probeCalls++; return { videoInfo: { rFrameRate: '60/1' } }; },
  runCapturedProcess: (...args) => capturedRun(...args)
};
const { LiveRecordService } = require('../src/server/app/service.cjs');
helpersModule.exports = helpers;
verifierModule.exports = verifier;

function service() {
  const value = new LiveRecordService();
  value.ffmpegCapabilities.sceneGpuRenderer = {
    available: true, backend: 'cuda-gstreamer', helper: '/fake/helper', nativeNvmmScene: true
  };
  value.ffmpegCapabilities.sceneGpuVisualConformance = {
    version: conformance.CUDA_SCENE_CONFORMANCE_VERSION, passed: true,
    cases: conformance.CUDA_SCENE_CONFORMANCE_PRESETS.flatMap(preset =>
      conformance.CUDA_SCENE_CONFORMANCE_LEADS.map(leadingVideoPaddingSec => ({
        preset, leadingVideoPaddingSec, passed: true,
        coverage: Object.fromEntries(conformance.CUDA_SCENE_CONFORMANCE_COVERAGE.map(key => [key, true])),
        metrics: { meanAbsRgb: 0, changedRatio: 0 }
      })))
  };
  value.log = () => {};
  value.probeJetsonNativeSceneForSource = async () => ({ ok: true, durationSec: 5, metrics: {} });
  value.writeLegacySceneCompatibilityAss = async () => '';
  return value;
}

function options(temporaryDir) {
  const graph = helpers.buildSceneGraph([], { videoInfo: { width: 640, height: 360, fps: 60 } });
  graph.timeline.end = 65;
  return {
    graph, cleanPath: '/fake/source.mp4', outputPath: path.join(temporaryDir, 'out.mp4'),
    codec: 'hevc_nvv4l2', crf: 23, quality: 23, fps: 60, width: 640, height: 360,
    sourceCodec: 'hevc', sourceFrameRate: '60/1', startTime: 0, duration: 65,
    temporaryDir, outputContainer: 'mp4', includeAudio: true, copyAudio: true,
    decoder: { value: 'gstreamer-nvv4l2' }, label: 'test'
  };
}

test('early native failure rebuilds bounded CPU windows and preserves hardware decode', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'br2k-recovery-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const app = service();
  const failure = new Error('媒体信息探测超时');
  let nativeCalls = 0;
  const windows = [], diagnostics = [];
  app.runJetsonCudaSceneGraphTranscode = async () => { nativeCalls++; throw failure; };
  app.persistExportDiagnosticFailure = async (context, error) => diagnostics.push({ context, error });
  app.runJetsonGstreamerTranscode = async opts => {
    assert.equal(opts.nativeDecode.sourceFrameRate, '60/1');
    assert.equal(opts.nativeDecode.decoderPath, '/fake/helper');
    assert.ok((await fs.readFile(opts.nativeDecode.filterScriptPath, 'utf8')).length);
    windows.push(opts.nativeDecode.duration);
    await fs.writeFile(opts.createMuxArgs().at(-1), Buffer.alloc(2048));
  };
  await app.runChunkedJetsonSceneGraphExport(options(dir));
  assert.equal(nativeCalls, 1);
  assert.deepEqual(windows, [20, 20, 20, 5]);
  assert.equal(diagnostics[0].error, failure);
  assert.equal(diagnostics[0].context.fallback.decision, 'early-cpu-fallback');
});

test('committed native late failure never runs a CPU window and retains its cause', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'br2k-late-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const app = service();
  const failure = Object.assign(new Error('PTS bridge 未通过'), { nativeFailure: { exitCode: 1 } });
  app.runJetsonCudaSceneGraphTranscode = async opts => { opts.onProgress(8); throw failure; };
  app.runJetsonGstreamerTranscode = async () => assert.fail('late failure retried on CPU');
  await assert.rejects(app.runChunkedJetsonSceneGraphExport(options(dir)), error => {
    assert.equal(error.code, 'BR2K_NATIVE_RUNTIME_FAILED_AFTER_COMMIT');
    assert.equal(error.cause, failure);
    assert.equal(error.nativeFailure.exitCode, 1);
    return true;
  });
});

test('native run reuses the source frame clock and does not generate unused CPU filters', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'br2k-frame-clock-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const app = service();
  probeCalls = 0;
  capturedRun = async (command, args) => {
    const request = JSON.parse(await fs.readFile(args[1], 'utf8'));
    assert.equal(request.input.sourceFrameRate, '60/1');
    return { status: 0, stdout: JSON.stringify({ nativeNvmmMetrics: { ptsBridge: { ok: true } } }) };
  };
  await app.runJetsonCudaSceneGraphTranscode({
    ...options(dir), encodedVideoPath: path.join(dir, 'video.mkv'),
    nativeDecode: { decoderPath: '/fake/helper', sourceCodec: 'hevc', sourceFrameRate: '60/1', duration: 65 },
    createRawArgs: () => assert.fail('CPU source unexpectedly selected'), createMuxArgs: () => []
  });
  assert.equal(probeCalls, 0);
  assert.deepEqual(await fs.readdir(dir), []);
});

test('native scene requests and texture scratch stay local when encoded media goes to a separate volume', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'br2k-split-storage-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const cache = path.join(dir, 'cache'), media = path.join(dir, 'media'); await fs.mkdir(cache); await fs.mkdir(media);
  const app = service();
  capturedRun = async (_command, args, opts) => {
    assert.equal(path.dirname(args[1]), cache); assert.equal(opts.env.TMPDIR, cache);
    const request = JSON.parse(await fs.readFile(args[1], 'utf8'));
    assert.equal(path.dirname(request.output.path), media);
    return { status: 0, stdout: JSON.stringify({ nativeNvmmMetrics: { ptsBridge: { ok: true } } }) };
  };
  await app.runJetsonCudaSceneGraphTranscode({ ...options(cache), sceneTemporaryDir: cache,
    encodedVideoPath: path.join(media, 'encoded.mkv'), nativeDecode: { decoderPath: '/fake/helper',
      sourceCodec: 'hevc', sourceFrameRate: '60/1', duration: 65 }, createRawArgs: () => [], createMuxArgs: () => [] });
  assert.deepEqual(await fs.readdir(cache), []); assert.deepEqual(await fs.readdir(media), []);
});

test('compatibility chunks separate local filter scripts from media files and clean both directories', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'br2k-chunk-storage-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const cache = path.join(dir, 'cache'), media = path.join(dir, 'media'); await fs.mkdir(cache); await fs.mkdir(media);
  const app = service(); app.probeJetsonNativeSceneForSource = async () => ({ ok: false, reason: 'use compatibility' });
  let chunks = 0;
  app.runJetsonGstreamerTranscode = async opts => {
    chunks++; assert.equal(path.dirname(opts.encodedVideoPath), media);
    assert.equal(path.dirname(opts.nativeDecode.filterScriptPath), cache);
    assert.equal(opts.sceneTemporaryDir, cache);
    await fs.writeFile(opts.createMuxArgs().at(-1), Buffer.alloc(2048));
  };
  await app.runChunkedJetsonSceneGraphExport({ ...options(cache), mediaTemporaryDir: media });
  assert.equal(chunks, 4); assert.deepEqual(await fs.readdir(cache), []); assert.deepEqual(await fs.readdir(media), []);
});

test('Argus warning with late media progress never restarts native helper and keeps stderr tail', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'br2k-native-tail-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const app = service();
  let calls = 0;
  capturedRun = async (command, args, opts) => {
    calls++;
    opts.onStdout(JSON.stringify({ nativeNvmmProgress: { mediaSeconds: 8 } }));
    return { status: 1, stderr: '(Argus) Connecting to daemon failed\n' + 'libass warning\n'.repeat(100) + '实际末尾错误: source PTS mismatch' };
  };
  await assert.rejects(app.runJetsonCudaSceneGraphTranscode({
    ...options(dir), encodedVideoPath: path.join(dir, 'video.mkv'),
    nativeDecode: { decoderPath: '/fake/helper', sourceFrameRate: '60/1', duration: 65 },
    createRawArgs: () => [], createMuxArgs: () => []
  }), error => {
    assert.equal(error.code, 'BR2K_JETSON_NATIVE_SCENE_FAILED');
    assert.equal(error.nativeFailure.processedMediaSeconds, 8);
    assert.match(error.message, /实际末尾错误/);
    assert.match(error.nativeFailure.stderrTail, /source PTS mismatch/);
    return true;
  });
  assert.equal(calls, 1);
});

test('native cancellation exposes the child and stops without retry or mux', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'br2k-native-cancel-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const app = service();
  let cancelled = false, calls = 0;
  const child = { pid: 123 };
  capturedRun = async (_command, _args, opts) => {
    calls++;
    assert.equal(typeof opts.onChild, 'function');
    opts.onChild(child);
    return { status: null, signal: 'SIGKILL', stderr: 'failed to initialize context' };
  };
  await assert.rejects(app.runJetsonCudaSceneGraphTranscode({
    ...options(dir), encodedVideoPath: path.join(dir, 'video.mkv'),
    nativeDecode: { decoderPath: '/fake/helper', sourceFrameRate: '60/1', duration: 65 },
    onChild: value => { assert.equal(value, child); cancelled = true; }, isCancelled: () => cancelled,
    createRawArgs: () => assert.fail('cancelled export started CPU rendering'),
    createMuxArgs: () => assert.fail('cancelled export started muxing')
  }), error => error.code === 'BR2K_MEDIA_CANCELLED');
  assert.equal(calls, 1);
});

test('preflight selects visible text later in the clip and rejects a blank sample before full rendering', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'br2k-native-text-gate-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const app = service();
  app.probeJetsonNativeSceneForSource = LiveRecordService.prototype.probeJetsonNativeSceneForSource;
  app.writeLegacySceneCompatibilityAss = async name => { await fs.writeFile(name, '[Script Info]\n'); return name; };
  const events = [{ type: 'danmaku', time: 12, text: '预期中文弹幕', uid: 1 }];
  const graph = helpers.buildSceneGraph(events, { stylePreset: 'minimal', videoInfo: { width: 640, height: 360, fps: 60 }, durationSec: 40 });
  let start = null;
  capturedRun = async (_command, args) => {
    const request = JSON.parse(await fs.readFile(args[1], 'utf8'));
    start = request.input.startTime;
    assert.ok(start > 5, 'preflight must not always inspect an empty opening');
    assert.equal(request.input.duration, 10);
    await fs.writeFile(request.output.path, Buffer.alloc(2048));
    return { status: 0, stdout: JSON.stringify({ nativeNvmmMetrics: { pipelineFps: 100, ptsBridge: { ok: true } } }) };
  };
  capturedVerification = async opts => {
    assert.equal(opts.sourceStart, start);
    assert.equal(opts.textMask, true);
    throw Object.assign(new Error('expected glyph missing'), { code: 'BR2K_SCENE_TEXT_VERIFICATION_FAILED' });
  };
  await assert.rejects(app.probeJetsonNativeSceneForSource({ ...options(dir), duration: 40, graph,
    textVerification: { events, options: { stylePreset: 'minimal' } }
  }), error => error.code === 'BR2K_SCENE_TEXT_VERIFICATION_FAILED' && error.diagnosticDirectory === dir);
  assert.ok((await fs.readdir(dir)).includes('native-preflight.mkv'), 'failed sample and request must remain available for diagnosis');
});
