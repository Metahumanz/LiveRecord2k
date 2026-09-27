'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  buildAccelerationDiagnostics,
  buildExportDiagnosticReport,
  sanitizeDiagnosticReport
} = require('../src/server/app/diagnostics.cjs');

test('acceleration diagnostics keeps CPU decode separate from CUDA composition', () => {
  const report = buildAccelerationDiagnostics({
    platform: 'win32',
    arch: 'x64',
    ffmpegCapabilities: {
      hwaccels: ['cuda'],
      hardwareDecoders: [],
      videoAdapters: [{ name: 'RTX', vendor: 'nvidia' }],
      desktopCuda: { available: true, backend: 'cuda-ffmpeg', compositor: 'overlay_cuda', encoder: 'hevc_nvenc', fullSceneProduction: false }
    }
  });
  assert.equal(report.checks.nvdec.ok, false);
  assert.equal(report.checks.desktopCuda.ok, false);
  assert.equal(report.finalCapability.cpuDecodeCudaComposeNvenc, true);
});

test('diagnostic reports omit sensitive values and preserve useful failure code', () => {
  const error = Object.assign(new Error('encoder stopped at https://live.example/room?token=secret'), {
    code: 'BR2K_NATIVE_RUNTIME_FAILED_AFTER_COMMIT',
    processedMediaSeconds: 5.01
  });
  const report = buildExportDiagnosticReport({
    pipeline: { outputPath: 'C:\\recordings\\out.mkv', sourceUrl: 'https://live.example/room' },
    fallback: { cookie: 'SESSDATA=secret' }
  }, error);
  const serialized = JSON.stringify(report);
  assert.equal(report.lastError.code, 'BR2K_NATIVE_RUNTIME_FAILED_AFTER_COMMIT');
  assert.equal(report.lastError.processedMediaSeconds, 5.01);
  assert.doesNotMatch(serialized, /SESSDATA|live\.example|token=secret/);
  assert.equal(sanitizeDiagnosticReport({ password: 'secret' }).password, '[redacted]');
});

test('export diagnostic retains native exit details and the late error cause', () => {
  const cause = Object.assign(new Error('PTS coverage insufficient'), { code: 'BR2K_JETSON_NATIVE_SCENE_FAILED' });
  const report = buildExportDiagnosticReport({}, Object.assign(new Error('native stopped after 35s'), {
    cause, code: 'BR2K_NATIVE_RUNTIME_FAILED_AFTER_COMMIT', processedMediaSeconds: 35,
    nativeFailure: { exitCode: 1, timedOut: false, stderrTail: '实际末尾错误', password: 'secret' }
  }));
  assert.equal(report.lastError.nativeFailure.exitCode, 1);
  assert.equal(report.lastError.nativeFailure.stderrTail, '实际末尾错误');
  assert.equal(report.lastError.cause.code, cause.code);
  assert.doesNotMatch(JSON.stringify(report), /secret/);
});

