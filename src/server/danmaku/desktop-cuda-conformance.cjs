'use strict';

// The desktop CUDA visual gate is shared by the opt-in hardware test and the
// runtime capability cache.  Keep process execution and fixture construction
// here, but leave assertions and node:test policy to the caller.

const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { runCapturedProcess } = require('../shared/helpers.cjs');
const { createAss } = require('./ass.cjs');
const { buildSceneGraph } = require('./scene-graph.cjs');
const { writeSceneFilterScript } = require('./scene-renderer.cjs');
const {
  CUDA_SCENE_CONFORMANCE_VERSION,
  CUDA_SCENE_CONFORMANCE_PRESETS,
  CUDA_SCENE_CONFORMANCE_LEADS,
  CUDA_SCENE_CONFORMANCE_COVERAGE,
  CUDA_SCENE_MAX_MEAN_ABS_RGB,
  CUDA_SCENE_MAX_CHANGED_RATIO
} = require('./gpu-scene-conformance.cjs');

const CANVAS = { width: 640, height: 360, fps: 60 };
const DURATION = 2;
const SAMPLE_TIMES = [0.9, 1.6];
const EVENTS = [
  { type: 'danmaku', time: 0.25, uid: 1, user: '普通观众', text: 'CUDA 与 ASS 的基准弹幕正文', color: 0xffffff },
  { type: 'superchat', time: 0.75, duration: 5, uid: 2, user: '头像用户', text: '圆角、阴影、淡入淡出和移动的基准醒目留言。', price: 30 },
  { type: 'gift', time: 1.5, duration: 5, uid: 3, user: '礼物用户', giftName: '测试礼物', count: 3, price: 1 }
];
const SCENARIOS = [
  { id: 'danmaku', events: [EVENTS[0]], coverage: ['danmaku', 'move', 'fade'] },
  { id: 'superchat', events: [EVENTS[1]], coverage: ['avatar', 'superchat', 'roundedCorners', 'shadow', 'fade'] },
  { id: 'gift', events: [EVENTS[2]], coverage: ['avatar', 'gift', 'roundedCorners', 'shadow', 'move', 'fade'] }
];

function defaultRunProcess(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr = (stderr + chunk).slice(-16000); });
    child.on('error', reject);
    child.on('close', (code) => code === 0
      ? resolve({ code, stderr })
      : reject(new Error(`${path.basename(command)} exited ${code}: ${stderr}`)));
  });
}

function pixelDelta(left, right) {
  if (left.length !== right.length) throw new Error('两条渲染链的截图尺寸必须相同');
  let sum = 0;
  let changed = 0;
  for (let index = 0; index < left.length; index += 3) {
    const delta = (Math.abs(left[index] - right[index]) + Math.abs(left[index + 1] - right[index + 1]) + Math.abs(left[index + 2] - right[index + 2])) / 3;
    sum += delta;
    if (delta > 12) changed += 1;
  }
  return { meanAbsRgb: sum / (left.length / 3), changedRatio: changed / (left.length / 3) };
}

async function snapshot(runProcess, ffmpeg, input, at, output) {
  await runProcess(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-ss', String(at), '-i', input, '-frames:v', '1', '-pix_fmt', 'rgb24', '-f', 'rawvideo', output]);
  const bytes = await fs.readFile(output);
  if (bytes.length !== CANVAS.width * CANVAS.height * 3) throw new Error('无法抽取用于一致性比较的 RGB 帧');
  return bytes;
}

async function render(runProcess, ffmpeg, inputDuration, scriptPath, output, cuda) {
  const args = ['-hide_banner', '-loglevel', 'error', '-y'];
  if (cuda) args.push('-init_hw_device', 'cuda=br2k_scene_cuda:0', '-filter_hw_device', 'br2k_scene_cuda');
  args.push('-f', 'lavfi', '-i', `color=c=0x1F2937:s=${CANVAS.width}x${CANVAS.height}:r=${CANVAS.fps}:d=${inputDuration}`);
  args.push('-filter_complex_threads', '1', '-filter_complex_script', scriptPath, '-map', '[vout]', '-an', '-c:v', 'hevc_nvenc', '-preset', 'p5', '-cq', '20', '-b:v', '0', output);
  await runProcess(ffmpeg, args);
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function fingerprintEnvironment(environment) {
  const normalized = {
    platform: environment?.platform || process.platform,
    arch: environment?.arch || process.arch,
    conformanceVersion: environment?.conformanceVersion || CUDA_SCENE_CONFORMANCE_VERSION,
    ffmpegVersion: environment?.ffmpegVersion || '',
    gpu: environment?.gpu || null,
    videoAdapters: environment?.videoAdapters || []
  };
  return crypto.createHash('sha256').update(stableJson(normalized)).digest('hex');
}

async function collectDesktopCudaEnvironment(options = {}) {
  const ffmpegPath = String(options.ffmpegPath || 'ffmpeg');
  const runCommand = options.runCommand || runCapturedProcess;
  const ffmpegResult = await runCommand(ffmpegPath, ['-version'], { timeoutMs: 5000, maxOutputBytes: 32 * 1024 });
  const nvidiaResult = await runCommand(
    String(options.nvidiaSmiPath || 'nvidia-smi'),
    ['--query-gpu=name,driver_version,pci.bus_id', '--format=csv,noheader'],
    { timeoutMs: 5000, maxOutputBytes: 32 * 1024 }
  );
  const gpu = String(nvidiaResult?.status === 0 ? nvidiaResult.stdout || '' : '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [name, driver, pciBusId] = line.split(',').map((item) => String(item || '').trim());
      return { name, driver, pciBusId };
    });
  const environment = {
    platform: String(options.platform || process.platform),
    arch: String(options.arch || process.arch),
    appVersion: String(options.appVersion || ''),
    conformanceVersion: CUDA_SCENE_CONFORMANCE_VERSION,
    ffmpegVersion: String(ffmpegResult?.stdout || '').split(/\r?\n/)[0].trim(),
    gpu: gpu.length ? gpu : null,
    // Some Windows driver setups hide nvidia-smi. Keep the capability probe's
    // adapter inventory as a diagnostic fallback, but never invent a GPU.
    videoAdapters: Array.isArray(options.videoAdapters) ? options.videoAdapters : []
  };
  environment.fingerprint = fingerprintEnvironment(environment);
  return environment;
}

async function runDesktopCudaSceneConformance(options = {}) {
  const ffmpeg = String(options.ffmpegPath || 'ffmpeg');
  const runProcess = options.runProcess || defaultRunProcess;
  const directory = options.workDir || await fs.mkdtemp(path.join(os.tmpdir(), 'br2k-desktop-cuda-conformance-'));
  const ownsDirectory = !options.workDir;
  const report = {
    version: CUDA_SCENE_CONFORMANCE_VERSION,
    backend: 'cuda-ffmpeg',
    passed: false,
    executedAt: Date.now(),
    environment: options.environment || undefined,
    environmentFingerprint: options.environmentFingerprint || undefined,
    cases: []
  };
  try {
    for (const preset of CUDA_SCENE_CONFORMANCE_PRESETS) {
      for (const leadingVideoPaddingSec of CUDA_SCENE_CONFORMANCE_LEADS) {
        const id = `${preset}-${String(leadingVideoPaddingSec).replace('.', '_')}`;
        const totalDuration = DURATION + leadingVideoPaddingSec;
        const entry = {
          preset, leadingVideoPaddingSec, passed: false,
          coverage: Object.fromEntries(CUDA_SCENE_CONFORMANCE_COVERAGE.map((key) => [key, false])),
          metrics: { meanAbsRgb: 0, changedRatio: 0 }, samples: []
        };
        for (const scenario of SCENARIOS) {
          const scenarioId = `${id}-${scenario.id}`;
          const assPath = path.join(directory, `${scenarioId}.ass`);
          await fs.writeFile(assPath, createAss(scenario.events, { stylePreset: preset, overlayMode: 'danmaku-gift', videoInfo: CANVAS }), 'utf8');
          const scene = buildSceneGraph(scenario.events, { stylePreset: preset, overlayMode: 'danmaku-gift', videoInfo: CANVAS, durationSec: DURATION });
          const baseline = await writeSceneFilterScript(path.join(directory, `${scenarioId}.ass.filter`), scene, {
            duration: DURATION, outputDuration: totalDuration, leadingVideoPaddingSec, fps: CANVAS.fps, target: 'software', legacyAssPath: assPath
          });
          const cuda = await writeSceneFilterScript(path.join(directory, `${scenarioId}.cuda.filter`), scene, {
            duration: DURATION, outputDuration: totalDuration, leadingVideoPaddingSec, fps: CANVAS.fps, target: 'cuda', cudaInput: false, legacyAssPath: assPath
          });
          const baselineVideo = path.join(directory, `${scenarioId}.ass.mp4`);
          const cudaVideo = path.join(directory, `${scenarioId}.cuda.mp4`);
          await render(runProcess, ffmpeg, DURATION, baseline.filterScriptPath, baselineVideo, false);
          await render(runProcess, ffmpeg, DURATION, cuda.filterScriptPath, cudaVideo, true);
          for (const time of SAMPLE_TIMES.map((value) => value + leadingVideoPaddingSec)) {
            const [assPixels, cudaPixels] = await Promise.all([
              snapshot(runProcess, ffmpeg, baselineVideo, time, path.join(directory, `${scenarioId}-${time}-ass.rgb`)),
              snapshot(runProcess, ffmpeg, cudaVideo, time, path.join(directory, `${scenarioId}-${time}-cuda.rgb`))
            ]);
            const metrics = pixelDelta(assPixels, cudaPixels);
            entry.samples.push({ scenario: scenario.id, time, ...metrics });
            entry.metrics.meanAbsRgb = Math.max(entry.metrics.meanAbsRgb, metrics.meanAbsRgb);
            entry.metrics.changedRatio = Math.max(entry.metrics.changedRatio, metrics.changedRatio);
          }
          for (const key of scenario.coverage) entry.coverage[key] = true;
        }
        entry.passed = entry.metrics.meanAbsRgb <= CUDA_SCENE_MAX_MEAN_ABS_RGB && entry.metrics.changedRatio <= CUDA_SCENE_MAX_CHANGED_RATIO;
        if (!entry.passed) entry.reason = 'ASS 与桌面 CUDA Scene 像素差异超限。';
        report.cases.push(entry);
        if (typeof options.onCase === 'function') await options.onCase(entry);
      }
    }
    report.passed = report.cases.every((entry) => entry.passed);
    report.reason = report.passed ? '' : '至少一组 ASS vs 桌面 CUDA Scene 像素一致性测试未通过。';
    return report;
  } catch (error) {
    report.reason = String(error?.message || error);
    return report;
  } finally {
    if (ownsDirectory && options.keepArtifacts !== true) await fs.rm(directory, { recursive: true, force: true });
  }
}

module.exports = {
  CANVAS,
  DURATION,
  SAMPLE_TIMES,
  EVENTS,
  SCENARIOS,
  pixelDelta,
  fingerprintEnvironment,
  collectDesktopCudaEnvironment,
  runDesktopCudaSceneConformance
};
