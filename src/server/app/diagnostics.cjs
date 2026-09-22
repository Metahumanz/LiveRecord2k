'use strict';

const path = require('node:path');

function check(id, label, ok, reason = '', details = {}) {
  return { id, label, ok: Boolean(ok), reason: String(reason || ''), details };
}

function buildAccelerationDiagnostics(options = {}) {
  const capabilities = options.ffmpegCapabilities || {};
  const desktop = capabilities.desktopCuda || {};
  const renderer = capabilities.sceneGpuRenderer || {};
  const jetson = options.jetsonRuntime || {};
  const jetsonPlatform = String(options.platform || process.platform) === 'linux' && String(options.arch || process.arch) === 'arm64';
  const checks = {};
  if (jetsonPlatform) {
    checks.l4t = check('l4t', 'JetPack/L4T运行环境', Boolean(jetson.l4tRelease), jetson.l4tRelease ? '' : '未读取到 /etc/nv_tegra_release。', jetson);
    checks.cudaDriver = check('cudaDriver', 'CUDA驱动/runtime', Boolean(jetson.cudaDriver), jetson.cudaDriver ? '' : '未读取到设备现有 CUDA 驱动信息。');
    checks.nvv4l2decoder = check('nvv4l2decoder', 'nvv4l2decoder', jetson.elements?.nvv4l2decoder === true, '设备未提供可用的 nvv4l2decoder。');
    checks.nvv4l2h264enc = check('nvv4l2h264enc', 'nvv4l2h264enc', jetson.elements?.nvv4l2h264enc === true, '设备未提供可用的 nvv4l2h264enc。');
    checks.nvv4l2h265enc = check('nvv4l2h265enc', 'nvv4l2h265enc', jetson.elements?.nvv4l2h265enc === true, '设备未提供可用的 nvv4l2h265enc。');
    checks.nvvidconv = check('nvvidconv', 'nvvidconv', jetson.elements?.nvvidconv === true, '设备未提供可用的 nvvidconv。');
    checks.nvivafilter = check('nvivafilter', 'nvivafilter', jetson.elements?.nvivafilter === true, '设备未提供可用的 nvivafilter。');
    checks.br2kPlugin = check('br2kPlugin', 'BiliRecord2K CUDA Scene插件', renderer.available === true, renderer.reason || 'BiliRecord2K私有 Scene helper 不可用。');
    checks.visualGate = check('visualGate', 'CUDA Scene视觉一致性门禁', renderer.visualConformance?.passed === true, renderer.visualConformance?.reason || '视觉一致性门禁未通过。');
    checks.realSourcePreflight = check('realSourcePreflight', '真实源NVMM预检', renderer.nativeNvmmScene === true, renderer.nativeNvmmReason || '真实源 NVMM 预检未通过。');
  } else {
    checks.nvidiaGpu = check('nvidiaGpu', 'NVIDIA GPU', desktop.available === true, desktop.reason || '未检测到可用 NVIDIA CUDA runtime。', { adapters: capabilities.videoAdapters || [] });
    checks.cudaRuntime = check('cudaRuntime', 'CUDA runtime', capabilities.hwaccels?.includes('cuda'), 'FFmpeg 未检测到 CUDA 设备。');
    checks.nvdec = check('nvdec', 'NVDEC', capabilities.hardwareDecoders?.some((decoder) => decoder?.value === 'cuda'), '未通过 NVIDIA CUDA 硬件解码探测。');
    checks.hwuploadCuda = check('hwuploadCuda', 'hwupload_cuda', desktop.available === true, desktop.reason || '桌面 CUDA 上传/合成链不可用。');
    checks.overlayCuda = check('overlayCuda', 'overlay_cuda', desktop.compositor === 'overlay_cuda', desktop.reason || 'overlay_cuda 未通过真实探测。');
    checks.scaleCuda = check('scaleCuda', 'scale_cuda', desktop.available === true, desktop.reason || 'scale_cuda 未随完整桌面链通过探测。');
    checks.nvenc = check('nvenc', 'NVENC', Boolean(desktop.encoder), desktop.reason || '没有通过真实自检的 NVENC 编码器。');
    checks.visualGate = check('visualGate', 'CUDA Scene视觉一致性门禁', desktop.visualConformance?.passed === true, desktop.conformanceReason || '视觉一致性门禁未通过。');
    checks.desktopCuda = check('desktopCuda', '完整桌面CUDA Scene', desktop.fullSceneProduction === true, desktop.conformanceReason || desktop.reason || '完整桌面 CUDA Scene 尚未准入。');
  }
  const finalCapability = jetsonPlatform
    ? {
        platform: 'jetson',
        nativeNvmmScene: checks.br2kPlugin.ok && checks.visualGate.ok && checks.realSourcePreflight.ok,
        hardwareEncode: checks.nvv4l2h264enc.ok || checks.nvv4l2h265enc.ok,
        compatibleHardwareEncode: checks.nvvidconv.ok && (checks.nvv4l2h264enc.ok || checks.nvv4l2h265enc.ok)
      }
    : {
        platform: String(options.platform || process.platform),
        desktopCudaScene: checks.desktopCuda.ok,
        cudaComposeNvenc: checks.hwuploadCuda.ok && checks.overlayCuda.ok && checks.nvenc.ok,
        cpuDecodeCudaComposeNvenc: checks.hwuploadCuda.ok && checks.overlayCuda.ok && checks.nvenc.ok
      };
  return {
    version: 1,
    generatedAt: Date.now(),
    platform: String(options.platform || process.platform),
    arch: String(options.arch || process.arch),
    appVersion: String(options.appVersion || ''),
    checks,
    finalCapability
  };
}

function redactString(value, key = '') {
  const text = String(value);
  if (/(?:cookie|password|passwd|token|secret|authorization|bearer|accesskey)/i.test(key)) return '[redacted]';
  if (/https?:\/\//i.test(text)) return '[redacted-url]';
  if (/(?:path|file|directory|root|output)/i.test(key)) return path.basename(text);
  return text.length > 1000 ? `${text.slice(0, 1000)}…` : text;
}

function sanitizeDiagnosticReport(value, key = '') {
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') return redactString(value, key);
  if (typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.slice(0, 100).map((item) => sanitizeDiagnosticReport(item, key));
  return Object.fromEntries(Object.entries(value).map(([childKey, childValue]) => [
    childKey,
    sanitizeDiagnosticReport(childValue, childKey)
  ]));
}

function buildExportDiagnosticReport(context = {}, error = null) {
  return sanitizeDiagnosticReport({
    version: 1,
    createdAt: new Date().toISOString(),
    appVersion: context.appVersion,
    platform: context.platform,
    arch: context.arch,
    pipeline: context.pipeline,
    jetpack: context.jetpack,
    decoder: context.decoder,
    scene: context.scene,
    encoder: context.encoder,
    preflight: context.preflight,
    ptsBridge: context.ptsBridge,
    fallback: context.fallback,
    lastError: error ? {
      code: error.code,
      message: error.message,
      processedMediaSeconds: error.processedMediaSeconds
    } : context.lastError
  });
}

module.exports = {
  buildAccelerationDiagnostics,
  buildExportDiagnosticReport,
  sanitizeDiagnosticReport
};
