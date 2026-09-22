'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  detectDesktopCudaCapability,
  testFfmpegDesktopCudaPipeline
} = require('../src/server/shared/helpers.cjs');
const {
  fingerprintEnvironment
} = require('../src/server/danmaku/desktop-cuda-conformance.cjs');
const { canUseDesktopCudaSceneProduction } = require('../src/server/danmaku/gpu-scene-conformance.cjs');

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

test('desktop CUDA conformance cache is tied to the runtime fingerprint', () => {
  const capability = { available: true, backend: 'cuda-ffmpeg' };
  const environment = { platform: 'win32', arch: 'x64', ffmpegVersion: 'ffmpeg version 7', gpu: [{ name: 'RTX', driver: '1', pciBusId: '01:00.0' }] };
  const fingerprint = fingerprintEnvironment(environment);
  const report = {
    version: 'ass-compat-v1', backend: 'cuda-ffmpeg', passed: true,
    environmentFingerprint: fingerprint,
    cases: [
      ...['h5-card', 'bubble', 'minimal'].flatMap((preset) => [0, 1.019].map((leadingVideoPaddingSec) => ({
        preset, leadingVideoPaddingSec, passed: true,
        coverage: { danmaku: true, avatar: true, superchat: true, gift: true, roundedCorners: true, shadow: true, move: true, fade: true },
        metrics: { meanAbsRgb: 0, changedRatio: 0 }
      })))
    ]
  };
  assert.equal(canUseDesktopCudaSceneProduction(capability, report, { environmentFingerprint: fingerprint }).ok, true);
  assert.equal(canUseDesktopCudaSceneProduction(capability, report, { environmentFingerprint: fingerprintEnvironment({ ...environment, gpu: [{ ...environment.gpu[0], driver: '2' }] }) }).ok, false);
});
