'use strict';

// CUDA Scene is allowed to replace the frozen legacy ASS renderer only after
// a complete, current visual run. A helper's advertised primitives are not
// evidence that its pixels, alpha or timeline are compatible.

const CUDA_SCENE_CONFORMANCE_VERSION = 'ass-compat-v1';
const CUDA_SCENE_CONFORMANCE_PRESETS = ['h5-card', 'bubble', 'minimal'];
const CUDA_SCENE_CONFORMANCE_LEADS = [0, 1.019];
const CUDA_SCENE_CONFORMANCE_COVERAGE = [
  'danmaku', 'avatar', 'superchat', 'gift', 'roundedCorners', 'shadow', 'move', 'fade'
];
// Both reference and CUDA paths are H.265 encoded before comparison on the
// Orin, so a small encoder-domain tolerance is necessary. It is deliberately
// far below the observed broken-renderer deltas and is shared by the runner
// and the production gate.
const CUDA_SCENE_MAX_MEAN_ABS_RGB = 2;
const CUDA_SCENE_MAX_CHANGED_RATIO = 0.02;

function number(value, fallback = NaN) {
  const result = Number(value);
  return Number.isFinite(result) ? result : fallback;
}

function sameLead(left, right) {
  return Math.abs(number(left) - number(right)) < 0.0005;
}

function createCudaSceneConformanceUnavailable(reason = '尚未执行 CUDA Scene 像素一致性自检。') {
  return {
    version: CUDA_SCENE_CONFORMANCE_VERSION,
    passed: false,
    executedAt: 0,
    reason: String(reason),
    cases: CUDA_SCENE_CONFORMANCE_PRESETS.flatMap((preset) =>
      CUDA_SCENE_CONFORMANCE_LEADS.map((leadingVideoPaddingSec) => ({
        preset,
        leadingVideoPaddingSec,
        passed: false,
        coverage: {}
      }))
    )
  };
}

function validateCudaSceneConformance(report) {
  if (!report || report.version !== CUDA_SCENE_CONFORMANCE_VERSION) {
    return { ok: false, reason: 'CUDA Scene 像素一致性报告版本无效。' };
  }
  if (report.passed !== true) {
    return { ok: false, reason: String(report.reason || 'CUDA Scene 像素一致性自检未通过。') };
  }
  const cases = Array.isArray(report.cases) ? report.cases : [];
  for (const preset of CUDA_SCENE_CONFORMANCE_PRESETS) {
    for (const leadingVideoPaddingSec of CUDA_SCENE_CONFORMANCE_LEADS) {
      const entry = cases.find((candidate) =>
        candidate?.preset === preset && sameLead(candidate.leadingVideoPaddingSec, leadingVideoPaddingSec)
      );
      if (!entry?.passed) {
        return { ok: false, reason: `${preset} / ${leadingVideoPaddingSec}s 前导没有通过 CUDA 像素一致性测试。` };
      }
      const missing = CUDA_SCENE_CONFORMANCE_COVERAGE.filter((key) => entry.coverage?.[key] !== true);
      if (missing.length) {
        return { ok: false, reason: `${preset} / ${leadingVideoPaddingSec}s 前导缺少覆盖：${missing.join('、')}。` };
      }
      const meanAbsRgb = number(entry.metrics?.meanAbsRgb, Infinity);
      const changedRatio = number(entry.metrics?.changedRatio, Infinity);
      if (meanAbsRgb > CUDA_SCENE_MAX_MEAN_ABS_RGB || changedRatio > CUDA_SCENE_MAX_CHANGED_RATIO) {
        return { ok: false, reason: `${preset} / ${leadingVideoPaddingSec}s 前导像素差异超限。` };
      }
    }
  }
  return { ok: true, reason: '' };
}

function canUseCudaSceneProduction(renderer, conformance) {
  if (!renderer?.available || renderer.backend !== 'cuda-gstreamer') {
    return { ok: false, reason: 'CUDA Scene runtime probe 未通过。' };
  }
  return validateCudaSceneConformance(conformance || renderer.visualConformance);
}

module.exports = {
  CUDA_SCENE_CONFORMANCE_VERSION,
  CUDA_SCENE_CONFORMANCE_PRESETS,
  CUDA_SCENE_CONFORMANCE_LEADS,
  CUDA_SCENE_CONFORMANCE_COVERAGE,
  CUDA_SCENE_MAX_MEAN_ABS_RGB,
  CUDA_SCENE_MAX_CHANGED_RATIO,
  createCudaSceneConformanceUnavailable,
  validateCudaSceneConformance,
  canUseCudaSceneProduction
};
