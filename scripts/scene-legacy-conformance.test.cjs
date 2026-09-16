'use strict';

// Pixel conformance for the three visual presets.  The legacy ASS renderer is
// the frozen v0.6.7 visual oracle; direct Scene Graph must keep its geometry
// and timing before CUDA is allowed to compare against it.

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { spawn } = require('node:child_process');
const ffmpegPath = require('ffmpeg-static');

const { createAss } = require('../src/server/danmaku/ass.cjs');
const { buildSceneGraph } = require('../src/server/danmaku/scene-graph.cjs');
const { writeSceneFilterScript } = require('../src/server/danmaku/scene-renderer.cjs');
const { createAssFilter } = require('../src/server/recording/ffmpeg.cjs');

const CANVAS = { width: 640, height: 360, fps: 60 };
const PRESETS = ['h5-card', 'bubble', 'minimal'];
const SAMPLE_TIMES = [1.6, 2.2];
const EVENTS = [
  { type: 'danmaku', time: 0.25, uid: 1, user: '普通观众', text: '三套样式的基准弹幕正文', color: 0xffffff },
  { type: 'superchat', time: 0.75, duration: 5, uid: 2, user: '醒目留言用户', text: '这是用于验证卡片正文、圆角、头像与层级的基准消息。', price: 30 },
  { type: 'gift', time: 1.5, duration: 5, uid: 3, user: '礼物用户', giftName: '测试礼物', count: 3, price: 1 }
];

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr = (stderr + chunk.toString()).slice(-12000); });
    child.on('error', reject);
    child.on('close', (code) => code === 0 ? resolve() : reject(new Error('FFmpeg exited ' + code + ': ' + stderr)));
  });
}

function pixelDelta(legacy, scene) {
  assert.equal(legacy.length, scene.length);
  let sum = 0;
  let changed = 0;
  const pixels = legacy.length / 3;
  for (let index = 0; index < legacy.length; index += 3) {
    const delta = (Math.abs(legacy[index] - scene[index]) + Math.abs(legacy[index + 1] - scene[index + 1]) + Math.abs(legacy[index + 2] - scene[index + 2])) / 3;
    sum += delta;
    if (delta > 12) changed += 1;
  }
  return { meanAbsRgb: sum / pixels, changedRatio: changed / pixels };
}

async function renderRaw(command, args, target) {
  await run(command, args.concat(['-frames:v', '1', '-pix_fmt', 'rgb24', '-f', 'rawvideo', target]));
  return fs.readFile(target);
}

test('CPU Scene Graph stays visually conformant with the v0.6.7 ASS oracle', async (t) => {
  if (!ffmpegPath) return t.skip('没有可执行的 FFmpeg 基准渲染器');
  const temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'br2k-legacy-scene-'));
  try {
    for (const preset of PRESETS) {
      const assPath = path.join(temporaryDirectory, preset + '.ass');
      const scriptPath = path.join(temporaryDirectory, preset + '.filter');
      await fs.writeFile(assPath, createAss(EVENTS, { stylePreset: preset, overlayMode: 'danmaku-gift', videoInfo: CANVAS }), 'utf8');
      const scene = buildSceneGraph(EVENTS, { stylePreset: preset, overlayMode: 'danmaku-gift', videoInfo: CANVAS, durationSec: 4 });
      await writeSceneFilterScript(scriptPath, scene, { duration: 4, outputDuration: 4, fps: CANVAS.fps, target: 'software' });
      for (const time of SAMPLE_TIMES) {
        const label = preset + '-' + String(time).replace('.', '_');
        const legacy = await renderRaw(ffmpegPath, [
          '-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=0x1F2937:s=640x360:r=60:d=4',
          '-vf', createAssFilter(assPath), '-ss', String(time)
        ], path.join(temporaryDirectory, label + '.legacy.rgb'));
        const scenePixels = await renderRaw(ffmpegPath, [
          '-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=0x1F2937:s=640x360:r=60:d=4',
          '-filter_complex_script', scriptPath, '-map', '[vout]', '-ss', String(time)
        ], path.join(temporaryDirectory, label + '.scene.rgb'));
        const delta = pixelDelta(legacy, scenePixels);
        t.diagnostic(label + ': mean RGB delta ' + delta.meanAbsRgb.toFixed(3) + ', changed pixels ' + (delta.changedRatio * 100).toFixed(2) + '%');
        assert.ok(delta.meanAbsRgb <= 5.2, label + ' mean RGB delta ' + delta.meanAbsRgb.toFixed(3));
        assert.ok(delta.changedRatio <= 0.07, label + ' changed pixel ratio ' + (delta.changedRatio * 100).toFixed(2) + '%');
      }
    }
  } finally {
    await fs.rm(temporaryDirectory, { recursive: true, force: true });
  }
});
