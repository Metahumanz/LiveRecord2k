'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { LiveRecordService } = require('../src/server/app/service.cjs');
const {
  CUDA_SCENE_CONFORMANCE_VERSION,
  CUDA_SCENE_CONFORMANCE_PRESETS,
  CUDA_SCENE_CONFORMANCE_LEADS,
  CUDA_SCENE_CONFORMANCE_COVERAGE,
  createCudaSceneConformanceUnavailable,
  validateCudaSceneConformance,
  canUseCudaSceneProduction
} = require('../src/server/danmaku/gpu-scene-conformance.cjs');

function passingReport() {
  return {
    version: CUDA_SCENE_CONFORMANCE_VERSION,
    passed: true,
    cases: CUDA_SCENE_CONFORMANCE_PRESETS.flatMap((preset) =>
      CUDA_SCENE_CONFORMANCE_LEADS.map((leadingVideoPaddingSec) => ({
        preset,
        leadingVideoPaddingSec,
        passed: true,
        coverage: Object.fromEntries(CUDA_SCENE_CONFORMANCE_COVERAGE.map((key) => [key, true])),
        metrics: { meanAbsRgb: 0.01, changedRatio: 0.0001 }
      }))
    )
  };
}

test('CUDA Scene production gate rejects an unexecuted visual report', () => {
  const report = createCudaSceneConformanceUnavailable();
  assert.equal(validateCudaSceneConformance(report).ok, false);
  assert.equal(canUseCudaSceneProduction({ available: true, backend: 'cuda-gstreamer' }, report).ok, false);
});

test('CUDA Scene production gate requires every legacy style, lead-in and visual coverage item', () => {
  const report = passingReport();
  assert.equal(validateCudaSceneConformance(report).ok, true);
  assert.equal(canUseCudaSceneProduction({ available: true, backend: 'cuda-gstreamer' }, report).ok, true);

  report.cases.find((entry) => entry.preset === 'minimal' && entry.leadingVideoPaddingSec === 1.019).coverage.avatar = false;
  const result = validateCudaSceneConformance(report);
  assert.equal(result.ok, false);
  assert.match(result.reason, /avatar/);
});

test('CUDA Scene production gate rejects a report whose aggregate result hides a pixel mismatch', () => {
  const report = passingReport();
  report.cases[0].metrics.changedRatio = 0.1;
  const result = validateCudaSceneConformance(report);
  assert.equal(result.ok, false);
  assert.match(result.reason, /像素差异超限/);
});

test('服务仅加载已落盘的 CUDA 视觉通过报告', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'br2k-cuda-conformance-'));
  try {
    const service = new LiveRecordService();
    service.cudaSceneConformanceReportPath = path.join(directory, 'cuda-scene-conformance.json');
    await fs.writeFile(service.cudaSceneConformanceReportPath, JSON.stringify(passingReport()), 'utf8');
    const report = await service.readCudaSceneConformanceReport();
    assert.equal(canUseCudaSceneProduction({ available: true, backend: 'cuda-gstreamer' }, report).ok, true);
    await fs.writeFile(service.cudaSceneConformanceReportPath, '{', 'utf8');
    assert.equal((await service.readCudaSceneConformanceReport()).passed, false);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});
