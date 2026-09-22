'use strict';

// Opt-in real desktop NVIDIA gate. The ASS output is the frozen oracle; the
// candidate graph uses only canonical Scene objects plus hwupload_cuda and
// overlay_cuda before NVENC.

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  CUDA_SCENE_CONFORMANCE_VERSION,
  validateCudaSceneConformance
} = require('../src/server/danmaku/gpu-scene-conformance.cjs');
const { runDesktopCudaSceneConformance } = require('../src/server/danmaku/desktop-cuda-conformance.cjs');

test('desktop CUDA Scene pixels conform to frozen ASS fixtures', async (t) => {
  if (process.env.BR2K_DESKTOP_CUDA_CONFORMANCE !== '1') return t.skip('仅在本机 NVIDIA CUDA/NVENC 环境显式执行');
  const ffmpeg = process.env.BR2K_DESKTOP_CUDA_FFMPEG || 'ffmpeg';
  const report = await runDesktopCudaSceneConformance({
    ffmpegPath: ffmpeg,
    keepArtifacts: process.env.BR2K_DESKTOP_CUDA_KEEP_ARTIFACTS === '1',
    onCase: (entry) => t.diagnostic(`${entry.preset}-${entry.leadingVideoPaddingSec}: mean ${entry.metrics.meanAbsRgb.toFixed(3)}, changed ${(entry.metrics.changedRatio * 100).toFixed(2)}%`)
  });
  const reportPath = String(process.env.BR2K_DESKTOP_CUDA_CONFORMANCE_REPORT || '').trim();
  if (reportPath) {
    const fs = require('node:fs/promises');
    await fs.writeFile(reportPath, JSON.stringify(report, null, 2), 'utf8');
  }
  assert.equal(report.version, CUDA_SCENE_CONFORMANCE_VERSION);
  assert.equal(report.passed, true, report.reason);
  assert.deepEqual(validateCudaSceneConformance(report), { ok: true, reason: '' });
});
