'use strict';

const { canUseDesktopCudaSceneProduction } = require('./gpu-scene-conformance.cjs');
const { clipSceneGraph, evaluateSceneObject } = require('./scene-graph.cjs');

const LEGACY_PRESETS = new Set(['h5-card', 'bubble', 'minimal']);
const MAX_SEGMENT_SECONDS = 20;
const MAX_FILTER_LAYERS = 128;
const AUTO_LONG_BURN_SECONDS = 300;

function selectDesktopScenePath(codec, preset, capability) {
  const admission = canUseDesktopCudaSceneProduction(capability, capability?.visualConformance,
    { environmentFingerprint: capability?.environmentFingerprint });
  // Recover the proven legacy path while retaining independently selected
  // NVENC. The existing visual report covers only legacy presets; it cannot
  // authorize a different preset or a per-object CUDA filter topology.
  return {
    target: 'software',
    renderer: LEGACY_PRESETS.has(preset) ? 'libass-legacy-compatibility' : 'desktop-scene-segmented',
    segmented: !LEGACY_PRESETS.has(preset),
    encoder: codec,
    cudaAdmission: admission
  };
}

function filterLayerCount(graph) {
  return graph.objects.reduce((total, object) => {
    if (object.render === false || object.end <= object.start) return total;
    if (object.type === 'Text') return total + 1 + (object.props?.textKeyframes?.length || 0);
    return total + (Number(object.style?.shadow?.opacity) > 0 ? 2 : 1);
  }, 0);
}

function planDesktopSceneSegments(graph, duration, fps = 30, options = {}) {
  const frameRate = Math.max(1, Number(fps) || 30);
  const frameCount = Math.round(duration * frameRate);
  const maxFrames = Math.max(1, Math.floor((options.maxSeconds || MAX_SEGMENT_SECONDS) * frameRate));
  const limit = options.maxLayers || MAX_FILTER_LAYERS;
  const segments = [];
  let firstFrame = 0;
  while (firstFrame < frameCount) {
    let lastFrame = Math.min(frameCount, firstFrame + maxFrames);
    let clipped;
    while (true) {
      clipped = clipSceneGraph(graph, firstFrame / frameRate, lastFrame / frameRate, { shiftTime: true });
      if (filterLayerCount(clipped) <= limit) break;
      if (lastFrame - firstFrame <= 1) {
        const error = new Error(`Scene 单帧滤镜对象超过资源上限 ${limit}，已停止；请降低弹幕密度。`);
        error.code = 'BR2K_SCENE_RESOURCE_LIMIT';
        throw error;
      }
      lastFrame = firstFrame + Math.max(1, Math.floor((lastFrame - firstFrame) / 2));
    }
    segments.push({ start: firstFrame / frameRate, end: lastFrame / frameRate, duration: (lastFrame - firstFrame) / frameRate, frames: lastFrame - firstFrame });
    firstFrame = lastFrame;
  }
  return segments;
}

function sampleSceneObject(graph, object, duration) {
    if (object.render === false || object.type !== 'Text' || !String(object.props?.text || '').trim()) return null;
    if (duration > 1 && object.end - object.start < 0.5) return null;
    const time = Math.min(duration - 0.05, object.start + Math.min(2, (object.end - object.start) / 2));
    const state = evaluateSceneObject(object, time);
    if (!state.visible || state.opacity < 0.5 || state.x >= graph.canvas.width || state.y >= graph.canvas.height ||
      state.x + object.frame.width <= 0 || state.y + object.frame.height <= 0) return null;
    const sampleDuration = Math.min(10, duration);
    const start = Math.max(0, Math.min(time - 2, duration - sampleDuration));
    return { start, duration: sampleDuration, time: time - start, outputTime: time, objectId: object.id };
}

function selectSceneSample(graph, duration) {
  for (const object of graph.objects) {
    const sample = sampleSceneObject(graph, object, duration);
    if (sample) return sample;
  }
  const error = new Error('剪辑范围内没有有效可见弹幕文字，已停止烧录；请检查弹幕时间轴、JSONL 与 Scene 缓存。');
  error.code = 'BR2K_SCENE_NO_VISIBLE_TEXT';
  throw error;
}

function classifyDecodeFailure(error) {
  const detail = `${error?.ffmpegStderr || ''}\n${error?.message || ''}`;
  if (/CUDA_ERROR_OUT_OF_MEMORY|out of memory|cannot allocate memory|bad_alloc|resource temporarily unavailable/i.test(detail)) {
    return /CUDA_ERROR_OUT_OF_MEMORY|CUDA.*out of memory/i.test(detail) ? 'gpu-memory' : 'filter-resources';
  }
  if (/(?:no device available for decoder|device setup failed|failed setup for format|cannot load nvcuda|cuvid[^\n]*(?:unsupported|not supported|failed|error)|(?:nvdec|hwaccel|hardware decoding)[^\n]*(?:unsupported|not supported|failed|error)|unsupported.*(?:surface|pixel format))/i.test(detail)) return 'decode-compatibility';
  return 'other';
}

function selectDistributedSceneSamples(graph, duration) {
  if (duration <= 300) return [selectSceneSample(graph, duration)];
  const targets = [0, duration * .25, duration * .5, duration * .75, duration];
  const best = targets.map(() => null);
  for (const object of graph.objects) {
    const sample = sampleSceneObject(graph, object, duration);
    if (!sample) continue;
    for (let index = 0; index < targets.length; index++) {
      const distance = Math.abs(sample.outputTime - targets[index]);
      if (!best[index] || distance < best[index].distance) best[index] = { sample, distance };
    }
  }
  if (!best[0]) return [selectSceneSample(graph, duration)];
  const selected = new Map();
  for (const value of best) selected.set(value.sample.outputTime, value.sample);
  return [...selected.values()].sort((a, b) => a.outputTime - b.outputTime);
}

module.exports = { LEGACY_PRESETS, MAX_FILTER_LAYERS, MAX_SEGMENT_SECONDS, AUTO_LONG_BURN_SECONDS,
  selectDesktopScenePath, filterLayerCount, planDesktopSceneSegments, selectSceneSample, selectDistributedSceneSamples, classifyDecodeFailure };
