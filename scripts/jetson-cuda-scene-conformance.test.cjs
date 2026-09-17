'use strict';

// This is deliberately opt-in: it runs real Jetson CUDA/NVENC work and is
// unsuitable for a developer laptop. Run with
// BR2K_JETSON_CUDA_CONFORMANCE=1 and the bundled ffmpeg-full/helper paths.

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const test = require('node:test');
const { createAss } = require('../src/server/danmaku/ass.cjs');
const { buildSceneGraph } = require('../src/server/danmaku/scene-graph.cjs');
const { writeSceneFilterScript } = require('../src/server/danmaku/scene-renderer.cjs');
const { createGpuSceneRenderRequest } = require('../src/server/danmaku/gpu-scene-renderer.cjs');
const {
  CUDA_SCENE_CONFORMANCE_VERSION,
  CUDA_SCENE_CONFORMANCE_PRESETS,
  CUDA_SCENE_CONFORMANCE_LEADS,
  CUDA_SCENE_CONFORMANCE_COVERAGE,
  CUDA_SCENE_MAX_MEAN_ABS_RGB,
  CUDA_SCENE_MAX_CHANGED_RATIO
} = require('../src/server/danmaku/gpu-scene-conformance.cjs');

const CANVAS = { width: 640, height: 360, fps: 60 };
const DURATION = 4;
const SAMPLE_TIMES = [1.6, 2.2];
// Both outputs use the same nvv4l2 encoder, so these limits measure renderer
// divergence rather than normal H.265 quantisation noise.
const EVENTS = [
  { type: 'danmaku', time: 0.25, uid: 1, user: '普通观众', text: 'CUDA 与 ASS 的基准弹幕正文', color: 0xffffff },
  { type: 'superchat', time: 0.75, duration: 5, uid: 2, user: '头像用户', text: '圆角、阴影、淡入淡出和移动的基准醒目留言。', price: 30 },
  { type: 'gift', time: 1.5, duration: 5, uid: 3, user: '礼物用户', giftName: '测试礼物', count: 3, price: 1 }
];

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: options.stdio || ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr = (stderr + chunk.toString()).slice(-16000); });
    child.on('error', reject);
    child.on('close', (code) => code === 0 ? resolve(stderr) : reject(new Error(`${path.basename(command)} exited ${code}: ${stderr}`)));
  });
}

async function pipeToHelper(ffmpeg, sourceArgs, helper, requestPath) {
  const source = spawn(ffmpeg, sourceArgs, { stdio: ['ignore', 'pipe', 'pipe'] });
  const renderer = spawn(helper, ['--request', requestPath], { stdio: ['pipe', 'ignore', 'pipe'] });
  source.stdout.pipe(renderer.stdin);
  let sourceStderr = '';
  let rendererStderr = '';
  source.stderr.on('data', (chunk) => { sourceStderr = (sourceStderr + chunk.toString()).slice(-12000); });
  renderer.stderr.on('data', (chunk) => { rendererStderr = (rendererStderr + chunk.toString()).slice(-12000); });
  const wait = (child) => new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('close', (code) => code === 0 ? resolve() : reject(new Error('pipeline exited ' + code)));
  });
  try {
    await Promise.all([wait(source), wait(renderer)]);
  } catch (error) {
    throw new Error(`${error.message}; ffmpeg: ${sourceStderr}; helper: ${rendererStderr}`);
  }
  return { sourceStderr, rendererStderr };
}

function sourceArgs(leadingVideoPaddingSec, filterScriptPath = '') {
  const args = ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', `color=c=0x1F2937:s=${CANVAS.width}x${CANVAS.height}:r=${CANVAS.fps}:d=${DURATION}`];
  if (filterScriptPath) {
    args.push('-filter_complex_script', filterScriptPath, '-map', '[vout]');
  } else if (leadingVideoPaddingSec > 0.0005) {
    args.push('-f', 'lavfi', '-i', `color=c=black:s=${CANVAS.width}x${CANVAS.height}:r=${CANVAS.fps}:d=${leadingVideoPaddingSec}`);
    args.push('-filter_complex', '[1:v][0:v]concat=n=2:v=1:a=0,format=yuv420p[vout]', '-map', '[vout]');
  }
  args.push('-an', '-pix_fmt', 'yuv420p', '-f', 'rawvideo', 'pipe:1');
  return args;
}

function pixelDelta(left, right) {
  assert.equal(left.length, right.length, '两条编码链的截图尺寸必须相同');
  let sum = 0;
  let changed = 0;
  const pixels = left.length / 3;
  for (let index = 0; index < left.length; index += 3) {
    const delta = (Math.abs(left[index] - right[index]) + Math.abs(left[index + 1] - right[index + 1]) + Math.abs(left[index + 2] - right[index + 2])) / 3;
    sum += delta;
    if (delta > 12) changed += 1;
  }
  return { meanAbsRgb: sum / pixels, changedRatio: changed / pixels };
}

async function decodeFrame(ffmpeg, inputPath, at, outputPath) {
  await run(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-i', inputPath, '-ss', String(at), '-frames:v', '1', '-pix_fmt', 'rgb24', '-f', 'rawvideo', outputPath]);
  const pixels = await fs.readFile(outputPath);
  assert.equal(pixels.length, CANVAS.width * CANVAS.height * 3, `无法从 ${path.basename(inputPath)} 抽取 ${at}s 的 RGB 截图`);
  return pixels;
}

function helperRequest(scene, outputPath, duration) {
  return createGpuSceneRenderRequest(scene, {
    backend: 'cuda-gstreamer', inputPath: '/dev/null', outputPath, codec: 'hevc_nvv4l2',
    width: CANVAS.width, height: CANVAS.height, fps: CANVAS.fps, duration
  });
}

test('Jetson CUDA Scene pixels conform to frozen ASS compatibility fixtures', async (t) => {
  if (process.env.BR2K_JETSON_CUDA_CONFORMANCE !== '1') return t.skip('仅在 AGX Orin 上显式执行 CUDA 像素一致性测试');
  const ffmpeg = process.env.BR2K_SCENE_CONFORMANCE_FFMPEG || '/usr/lib/bili-record-2k/bin/ffmpeg-full';
  const helper = process.env.BR2K_SCENE_CONFORMANCE_HELPER || '/usr/lib/bili-record-2k/bin/br2k-scene-gpu';
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'br2k-cuda-conformance-'));
  const report = { version: CUDA_SCENE_CONFORMANCE_VERSION, passed: false, executedAt: Date.now(), cases: [] };
  try {
    for (const preset of CUDA_SCENE_CONFORMANCE_PRESETS) {
      const assPath = path.join(directory, `${preset}.ass`);
      await fs.writeFile(assPath, createAss(EVENTS, { stylePreset: preset, overlayMode: 'danmaku-gift', videoInfo: CANVAS }), 'utf8');
      const scene = buildSceneGraph(EVENTS, { stylePreset: preset, overlayMode: 'danmaku-gift', videoInfo: CANVAS, durationSec: DURATION });
      for (const leadingVideoPaddingSec of CUDA_SCENE_CONFORMANCE_LEADS) {
        const id = `${preset}-${String(leadingVideoPaddingSec).replace('.', '_')}`;
        const caseResult = {
          preset, leadingVideoPaddingSec, passed: false,
          coverage: Object.fromEntries(CUDA_SCENE_CONFORMANCE_COVERAGE.map((key) => [key, true])),
          metrics: { meanAbsRgb: 0, changedRatio: 0 }, samples: []
        };
        const totalDuration = DURATION + leadingVideoPaddingSec;
        // FFmpeg's finite colour source is frame-count based. Match the
        // helper's expected I420 count rather than ceil(5.019 * 60), which
        // incorrectly requests a 302nd frame after a 61-frame lead-in.
        const helperDuration = (Math.floor(DURATION * CANVAS.fps) + Math.floor(leadingVideoPaddingSec * CANVAS.fps)) / CANVAS.fps;
        const assScript = await writeSceneFilterScript(path.join(directory, `${id}.ass.filter`), scene, {
          duration: DURATION, outputDuration: totalDuration, leadingVideoPaddingSec, fps: CANVAS.fps, target: 'jetson', legacyAssPath: assPath
        });
        const baselinePath = path.join(directory, `${id}.ass.h265`);
        const cudaPath = path.join(directory, `${id}.cuda.h265`);
        const baselineRequest = helperRequest({ ...scene, objects: [] }, baselinePath, helperDuration);
        const cudaRequest = helperRequest(scene, cudaPath, helperDuration);
        cudaRequest.timelineOffsetSec = leadingVideoPaddingSec;
        const baselineRequestPath = path.join(directory, `${id}.ass.json`);
        const cudaRequestPath = path.join(directory, `${id}.cuda.json`);
        await Promise.all([
          fs.writeFile(baselineRequestPath, JSON.stringify(baselineRequest)),
          fs.writeFile(cudaRequestPath, JSON.stringify(cudaRequest))
        ]);
        const baselineLog = await pipeToHelper(ffmpeg, sourceArgs(0, assScript.filterScriptPath), helper, baselineRequestPath);
        const cudaLog = await pipeToHelper(ffmpeg, sourceArgs(leadingVideoPaddingSec), helper, cudaRequestPath);
        const allMetrics = [];
        for (const sampleTime of SAMPLE_TIMES.map((time) => time + leadingVideoPaddingSec)) {
          const [assPixels, cudaPixels] = await Promise.all([
            decodeFrame(ffmpeg, baselinePath, sampleTime, path.join(directory, `${id}-${sampleTime}-ass.rgb`)),
            decodeFrame(ffmpeg, cudaPath, sampleTime, path.join(directory, `${id}-${sampleTime}-cuda.rgb`))
          ]);
          const metrics = pixelDelta(assPixels, cudaPixels);
          allMetrics.push(metrics);
          caseResult.samples.push({ time: sampleTime, ...metrics });
        }
        caseResult.metrics.meanAbsRgb = Math.max(...allMetrics.map((value) => value.meanAbsRgb));
        caseResult.metrics.changedRatio = Math.max(...allMetrics.map((value) => value.changedRatio));
        caseResult.passed = caseResult.metrics.meanAbsRgb <= CUDA_SCENE_MAX_MEAN_ABS_RGB && caseResult.metrics.changedRatio <= CUDA_SCENE_MAX_CHANGED_RATIO &&
          !/failed to import nvivafilter EGLImage/i.test(cudaLog.rendererStderr);
        if (!caseResult.passed) caseResult.reason = '像素差异超限或 CUDA EGLImage 导入失败。';
        report.cases.push(caseResult);
        t.diagnostic(`${id}: max mean RGB ${caseResult.metrics.meanAbsRgb.toFixed(3)}, changed ${(caseResult.metrics.changedRatio * 100).toFixed(2)}%`);
      }
    }
    report.passed = report.cases.every((entry) => entry.passed);
    report.reason = report.passed ? '' : '至少一组 ASS vs CUDA 像素一致性测试未通过。';
    const reportPath = process.env.BR2K_CUDA_SCENE_CONFORMANCE_REPORT;
    if (reportPath) await fs.writeFile(reportPath, JSON.stringify(report, null, 2), 'utf8');
    assert.equal(report.passed, true, report.reason);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});
