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

