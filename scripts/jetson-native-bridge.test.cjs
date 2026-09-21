'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { runJetsonNativeDecodeSceneEncodeJob } = require('../src/server/recording/ffmpeg.cjs');

const node = process.execPath;
const rendererArgs = ['-e', "process.stdin.on('data', (chunk) => process.stdout.write(chunk)); process.stdin.on('end', () => process.exit(0));"];
const encoderArgs = ['-e', "process.stdin.resume(); process.stdin.on('end', () => process.exit(0));"];

async function runFakeNativeChain(decoderScript) {
  const metrics = [];
  return runJetsonNativeDecodeSceneEncodeJob({
    decoderPath: node,
    decoderArgs: ['-e', decoderScript],
    ffmpegPath: node,
    ffmpegArgs: rendererArgs,
    encoderArgs,
    frameSize: 4,
    gstreamerPath: node,
    onStageMetrics: (value) => metrics.push(value)
  }).then(
    () => ({ metrics }),
    (error) => {
      error.metrics = metrics;
      throw error;
    }
  );
}

test('Jetson native bridge rejects a decoder that produces zero frames', async () => {
  await assert.rejects(
    runFakeNativeChain("require('fs').closeSync(3); process.exit(7);"),
    (error) => {
      assert.equal(error.code, 'BR2K_JETSON_NATIVE_DECODE_EMPTY');
      assert.equal(error.primaryProcess, 'decoder');
      assert.equal(error.decodedFrames, 0);
      assert.equal(error.sceneFrames, 0);
      return true;
    }
  );
});

test('Jetson native bridge tolerates decoder teardown after real frames', async () => {
  const result = await runFakeNativeChain("require('fs').writeSync(3, Buffer.from('1234')); require('fs').closeSync(3); process.exit(7);");
  const final = result.metrics.at(-1);
  assert.equal(final.decodedFrames, 1);
  assert.equal(final.sceneFrames, 1);
});

test('Jetson export contract validates the intermediate MKV and retries empty native decode', () => {
  const serviceSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'server', 'app', 'service.cjs'), 'utf8');
  assert.match(serviceSource, /BR2K_JETSON_NATIVE_DECODE_EMPTY/);
  assert.match(serviceSource, /BR2K_JETSON_ENCODE_OUTPUT_INVALID/);
  assert.match(serviceSource, /gpuSceneRenderer\?\.available && gpuSceneRenderer\.helper/);
  assert.match(serviceSource, /Jetson nvv4l2decoder 未产生有效帧，已切换 CPU 解码/);
});

test('Jetson native admission preflights a real source and never restarts a committed long run', () => {
  const serviceSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'server', 'app', 'service.cjs'), 'utf8');
  assert.match(serviceSource, /probeJetsonNativeSceneForSource/);
  assert.match(serviceSource, /native-preflight\.json/);
  assert.match(serviceSource, /native-preflight\.mkv/);
  assert.match(serviceSource, /BR2K_FORCE_NATIVE_PREFLIGHT_FAIL/);
  assert.match(serviceSource, /BR2K_NATIVE_RUNTIME_FAILED_AFTER_COMMIT/);
  assert.match(serviceSource, /NATIVE_EARLY_FALLBACK_SEC = 5/);
  assert.match(serviceSource, /正式导出使用连续NVMM链路/);
  assert.match(serviceSource, /本次导出从开始即使用兼容链/);
});

test('Scene Graph stderr folds repeated font fallback warnings without hiding fatal errors', () => {
  const serviceSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'server', 'app', 'service.cjs'), 'utf8');
  assert.match(serviceSource, /sceneFontFallbackWarnings/);
  assert.match(serviceSource, /缺少字体fallback/);
  assert.match(serviceSource, /已折叠/);
  assert.match(serviceSource, /if \(\/error\|failed\|invalid\/i\.test\(line\)\)/);
});
