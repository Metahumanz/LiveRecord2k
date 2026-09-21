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
    const failedPresets = [...new Set(
      (Array.isArray(report.cases) ? report.cases : [])
        .filter((entry) => entry?.passed !== true)
        .map((entry) => entry?.preset)
        .filter(Boolean)
    )];
    return {
      ok: false,
      reason: failedPresets.length
        ? `visualConformance=${failedPresets.join(',')} failed`
        : String(report.reason || 'CUDA Scene 像素一致性自检未通过。')
    };
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
  if (!renderer) {
    return { ok: false, reason: 'renderer不存在' };
  }
  if (renderer.available !== true) {
    return {
      ok: false,
      reason: `renderer.available=false + ${String(renderer.reason || '未提供 runtime probe 原因。')}`
    };
  }
  if (renderer.backend !== 'cuda-gstreamer') {
    return {
      ok: false,
      reason: `backend不是cuda-gstreamer + 实际backend=${String(renderer.backend || '-')}`
    };
  }
  return validateCudaSceneConformance(conformance || renderer.visualConformance);
}

// Desktop CUDA has no GStreamer helper: FFmpeg owns NVDEC, the CUDA texture
// uploads/overlay_cuda compositor, and NVENC. It must nevertheless pass the
// very same frozen-ASS visual gate before the legacy styles may use it.
function canUseDesktopCudaSceneProduction(capability, conformance) {
  if (!capability?.available || capability.backend !== 'cuda-ffmpeg') {
    return { ok: false, reason: '桌面 CUDA Scene runtime probe 未通过。' };
  }
  if (conformance?.backend !== 'cuda-ffmpeg') {
    return { ok: false, reason: '尚未执行本机桌面 CUDA Scene 像素一致性自检。' };
  }
  return validateCudaSceneConformance(conformance);
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
  canUseCudaSceneProduction,
  canUseDesktopCudaSceneProduction
};
