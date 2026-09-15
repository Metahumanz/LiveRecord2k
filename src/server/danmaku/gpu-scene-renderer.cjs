'use strict';

// GPU Scene Graph rendering is deliberately a native-helper boundary.  The
// Node server owns recording, layout and scheduling; the helper owns GPU
// surfaces and never receives credentials, recording configuration or shell
// fragments.  Keeping the protocol as JSON prevents the GPU path from
// changing the canonical Scene Graph or the ASS compatibility exporter.

const fs = require('node:fs');
const path = require('node:path');
const { createSceneRenderPlan } = require('./scene-renderer.cjs');

const GPU_SCENE_PROTOCOL = 'bili-record2k.gpu-scene-render/v1';
const GPU_SCENE_BACKENDS = new Set(['cuda-gstreamer', 'vulkan-gstreamer', 'gl-gstreamer']);
const JETSON_CUDA_REQUIRED_ELEMENTS = [
  'cudaupload',
  'cudacompositor',
  'cudaconvertscale',
  'nvvidconv',
  'nvv4l2h264enc',
  'nvv4l2h265enc'
];
const JETSON_GL_REQUIRED_ELEMENTS = [
  'appsrc',
  'glupload',
  'glvideomixer',
  'gldownload',
  'videoconvert',
  'nvvidconv',
  'nvv4l2h264enc',
  'nvv4l2h265enc'
];

function finite(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function normalizeBackend(value) {
  const backend = String(value || '').trim().toLowerCase();
  return GPU_SCENE_BACKENDS.has(backend) ? backend : '';
}

function createGpuSceneRenderRequest(scene, options = {}) {
  // GL is the first production Jetson backend because the L4T runtime ships
  // GL plugins more consistently than the optional CUDA GStreamer plugin.
  // CUDA/Vulkan remain protocol-compatible targets, not aliases.
  const backend = normalizeBackend(options.backend) || 'gl-gstreamer';
  const plan = createSceneRenderPlan(scene, {
    target: 'jetson',
    duration: options.duration,
    fps: options.fps
  });
  const width = Math.max(2, Math.floor(finite(options.width, plan.canvas.width) / 2) * 2);
  const height = Math.max(2, Math.floor(finite(options.height, plan.canvas.height) / 2) * 2);
  const fps = Math.max(1, finite(options.fps, plan.canvas.fps || 30));
  const duration = Math.max(0.001, finite(options.duration, plan.duration));
  const input = String(options.inputPath || '').trim();
  const output = String(options.outputPath || '').trim();
  if (!input) throw new Error('GPU Scene 渲染缺少 clean 视频输入路径。');
  if (!output) throw new Error('GPU Scene 渲染缺少 H26x 临时输出路径。');
  return {
    protocol: GPU_SCENE_PROTOCOL,
    backend,
    input: {
      path: input,
      startTime: Math.max(0, finite(options.startTime)),
      duration,
      decoder: String(options.decoder || 'software').trim() || 'software'
    },
    output: {
      path: output,
      codec: String(options.codec || 'h264_nvv4l2').trim(),
      width,
      height,
      fps,
      pixelFormat: 'nv12'
    },
    scene: plan,
    // A helper may only use local, already prepared avatar assets referenced
    // by the plan.  URL fetching remains the server's responsibility.
    guarantees: {
      sourcePixelsCompositedOnce: true,
      avoidsAssVideoIntermediate: true,
      avoidsTransparentVideoIntermediate: true,
      exactSceneGraphTiming: true
    }
  };
}

function getBundledGpuSceneRendererCandidates(options = {}) {
  const result = [];
  const explicit = String(options.helperPath || '').trim();
  if (explicit) result.push(explicit);
  const resourcePath = String(options.resourcePath || process.resourcesPath || '').trim();
  if (resourcePath) result.push(path.join(resourcePath, 'bin', 'br2k-scene-gpu'));
  result.push('/usr/lib/bili-record-2k/bin/br2k-scene-gpu');
  return [...new Set(result.map((entry) => path.resolve(entry)))];
}

function resolveGpuSceneRenderer(options = {}) {
  for (const candidate of getBundledGpuSceneRendererCandidates(options)) {
    try {
      const stat = fs.statSync(candidate);
      if (stat.isFile() && (process.platform === 'win32' || (stat.mode & 0o111) !== 0)) return candidate;
    } catch {
      // The helper is optional.  CPU Scene rendering remains the safe default.
    }
  }
  return '';
}

function parseGpuSceneRendererProbe(value, expectedBackend = '') {
  let probe;
  try {
    probe = typeof value === 'string' ? JSON.parse(value) : value;
  } catch {
    return { ok: false, reason: 'GPU Scene helper 返回的 probe 不是 JSON。' };
  }
  const backend = normalizeBackend(probe?.backend);
  if (!probe || probe.protocol !== GPU_SCENE_PROTOCOL || !backend) {
    return { ok: false, reason: 'GPU Scene helper 的协议或后端标识无效。' };
  }
  if (expectedBackend && backend !== normalizeBackend(expectedBackend)) {
    return { ok: false, reason: `GPU Scene helper 后端不匹配：期望 ${expectedBackend}，实际 ${backend}。` };
  }
  const capabilities = new Set(Array.isArray(probe.capabilities) ? probe.capabilities.map(String) : []);
  const required = ['Text', 'Avatar', 'Rect', 'Card', 'SuperChat', 'Gift', 'Move', 'Fade', 'Scale'];
  const missing = required.filter((capability) => !capabilities.has(capability));
  if (missing.length) return { ok: false, reason: 'GPU Scene helper 缺少能力：' + missing.join('、') + '。' };
  return {
    ok: true,
    backend,
    version: String(probe.version || '').trim(),
    capabilities: [...capabilities].sort(),
    gstreamerElements: Array.isArray(probe.gstreamerElements) ? probe.gstreamerElements.map(String).sort() : []
  };
}

function createGpuSceneProbeArgs() {
  return ['--probe=json'];
}

module.exports = {
  GPU_SCENE_PROTOCOL,
  GPU_SCENE_BACKENDS,
  JETSON_CUDA_REQUIRED_ELEMENTS,
  JETSON_GL_REQUIRED_ELEMENTS,
  normalizeBackend,
  createGpuSceneRenderRequest,
  getBundledGpuSceneRendererCandidates,
  resolveGpuSceneRenderer,
  parseGpuSceneRendererProbe,
  createGpuSceneProbeArgs
};
