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
