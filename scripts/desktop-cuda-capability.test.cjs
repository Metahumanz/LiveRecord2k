'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  detectDesktopCudaCapability,
  testFfmpegDesktopCudaPipeline
} = require('../src/server/shared/helpers.cjs');

const cudaFilters = new Set(['hwupload_cuda', 'overlay_cuda', 'scale_cuda']);
const nvenc = [{ value: 'hevc_nvenc', kind: 'hardware' }];

test('desktop CUDA capability requires a real CUDA blend and NVENC result', async () => {
  let receivedArgs = [];
  const capability = await detectDesktopCudaCapability('ffmpeg', {
    platform: 'win32',
    arch: 'x64',
    hwaccels: ['cuda'],
    filterNames: cudaFilters,
    burnCodecs: nvenc,
    hardwareDecoders: [{ value: 'cuda' }],
    runCapturedProcess: async (_command, args) => {
      receivedArgs = args;
      return { status: 0, stdout: '', stderr: '', error: null, timedOut: false };
    }
  });
  assert.equal(capability.available, true);
  assert.equal(capability.backend, 'cuda-ffmpeg');
  assert.equal(capability.decoder, 'cuda');
  assert.equal(capability.fullSceneProduction, false);
  assert.ok(receivedArgs.some((argument) => String(argument).includes('overlay_cuda')));
  assert.ok(receivedArgs.includes('hevc_nvenc'));
});

test('desktop CUDA capability does not misclassify Jetson as desktop CUDA', async () => {
  const capability = await detectDesktopCudaCapability('ffmpeg', {
    platform: 'linux', arch: 'arm64', hwaccels: ['cuda'], filterNames: cudaFilters, burnCodecs: nvenc
  });
  assert.equal(capability.available, false);
  assert.match(capability.reason, /Jetson/);
});

test('desktop CUDA probe surfaces a failed real pipeline', async () => {
  const result = await testFfmpegDesktopCudaPipeline('ffmpeg', {
    runCapturedProcess: async () => ({ status: 1, stdout: '', stderr: 'CUDA unavailable', error: null, timedOut: false })
  });
  assert.equal(result.ok, false);
  assert.match(result.reason, /CUDA unavailable/);
});
