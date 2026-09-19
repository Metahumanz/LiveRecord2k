'use strict';

// Opt-in real desktop NVIDIA gate. The ASS output is the frozen oracle; the
// candidate graph uses only canonical Scene objects plus hwupload_cuda and
// overlay_cuda before NVENC.

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const test = require('node:test');
const { createAss } = require('../src/server/danmaku/ass.cjs');
const { buildSceneGraph } = require('../src/server/danmaku/scene-graph.cjs');
const { writeSceneFilterScript } = require('../src/server/danmaku/scene-renderer.cjs');
const {
  CUDA_SCENE_CONFORMANCE_VERSION,
  CUDA_SCENE_CONFORMANCE_PRESETS,
  CUDA_SCENE_CONFORMANCE_LEADS,
  CUDA_SCENE_CONFORMANCE_COVERAGE,
  CUDA_SCENE_MAX_MEAN_ABS_RGB,
  CUDA_SCENE_MAX_CHANGED_RATIO
} = require('../src/server/danmaku/gpu-scene-conformance.cjs');

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

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr = (stderr + chunk).slice(-16000); });
    child.on('error', reject);
    child.on('close', (code) => code === 0 ? resolve() : reject(new Error(`${path.basename(command)} exited ${code}: ${stderr}`)));
  });
}

function pixelDelta(left, right) {
  assert.equal(left.length, right.length, '两条渲染链的截图尺寸必须相同');
  let sum = 0;
  let changed = 0;
  for (let index = 0; index < left.length; index += 3) {
    const delta = (Math.abs(left[index] - right[index]) + Math.abs(left[index + 1] - right[index + 1]) + Math.abs(left[index + 2] - right[index + 2])) / 3;
    sum += delta;
    if (delta > 12) changed += 1;
  }
  return { meanAbsRgb: sum / (left.length / 3), changedRatio: changed / (left.length / 3) };
}

async function snapshot(ffmpeg, input, at, output) {
  await run(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-ss', String(at), '-i', input, '-frames:v', '1', '-pix_fmt', 'rgb24', '-f', 'rawvideo', output]);
  const bytes = await fs.readFile(output);
  assert.equal(bytes.length, CANVAS.width * CANVAS.height * 3, '无法抽取用于一致性比较的 RGB 帧');
  return bytes;
}

async function render(ffmpeg, inputDuration, scriptPath, output, cuda) {
  const args = ['-hide_banner', '-loglevel', 'error', '-y'];
  if (cuda) args.push('-init_hw_device', 'cuda=br2k_scene_cuda:0', '-filter_hw_device', 'br2k_scene_cuda');
  args.push('-f', 'lavfi', '-i', `color=c=0x1F2937:s=${CANVAS.width}x${CANVAS.height}:r=${CANVAS.fps}:d=${inputDuration}`);
  // A Scene fixture has many independent colour/text sources. Serial graph
  // scheduling keeps their CUDA upload queues bounded on WDDM GPUs.
  args.push('-filter_complex_threads', '1', '-filter_complex_script', scriptPath, '-map', '[vout]', '-an', '-c:v', 'hevc_nvenc', '-preset', 'p5', '-cq', '20', '-b:v', '0', output);
  await run(ffmpeg, args);
}

test('desktop CUDA Scene pixels conform to frozen ASS fixtures', async (t) => {
  if (process.env.BR2K_DESKTOP_CUDA_CONFORMANCE !== '1') return t.skip('仅在本机 NVIDIA CUDA/NVENC 环境显式执行');
  const ffmpeg = process.env.BR2K_DESKTOP_CUDA_FFMPEG || 'ffmpeg';
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'br2k-desktop-cuda-conformance-'));
  const report = { version: CUDA_SCENE_CONFORMANCE_VERSION, backend: 'cuda-ffmpeg', passed: false, executedAt: Date.now(), cases: [] };
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
          await render(ffmpeg, DURATION, baseline.filterScriptPath, baselineVideo, false);
          await render(ffmpeg, DURATION, cuda.filterScriptPath, cudaVideo, true);
          for (const time of SAMPLE_TIMES.map((value) => value + leadingVideoPaddingSec)) {
            const [assPixels, cudaPixels] = await Promise.all([
              snapshot(ffmpeg, baselineVideo, time, path.join(directory, `${scenarioId}-${time}-ass.rgb`)),
              snapshot(ffmpeg, cudaVideo, time, path.join(directory, `${scenarioId}-${time}-cuda.rgb`))
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
        t.diagnostic(`${id}: mean ${entry.metrics.meanAbsRgb.toFixed(3)}, changed ${(entry.metrics.changedRatio * 100).toFixed(2)}%`);
      }
    }
    report.passed = report.cases.every((entry) => entry.passed);
    report.reason = report.passed ? '' : '至少一组 ASS vs 桌面 CUDA Scene 像素一致性测试未通过。';
    const reportPath = String(process.env.BR2K_DESKTOP_CUDA_CONFORMANCE_REPORT || '').trim();
    if (reportPath) await fs.writeFile(reportPath, JSON.stringify(report, null, 2), 'utf8');
    assert.equal(report.passed, true, report.reason);
  } finally {
    if (process.env.BR2K_DESKTOP_CUDA_KEEP_ARTIFACTS === '1') t.diagnostic(`保留桌面 CUDA 测试工件：${directory}`);
    else await fs.rm(directory, { recursive: true, force: true });
  }
});
