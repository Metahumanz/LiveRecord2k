'use strict';
// Run on Orin with BR2K_EMOJI_SOURCE pointing to a real recording. All outputs
// belong to a private test directory; recordings/JSONL are never modified.
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { buildSceneGraph, evaluateSceneObject, clipSceneGraph } = require('../src/server/danmaku/scene-graph.cjs');
const { createGpuSceneRenderRequest } = require('../src/server/danmaku/gpu-scene-renderer.cjs');
const { createAss } = require('../src/server/danmaku/ass.cjs');
const { createSceneFilterScript } = require('../src/server/danmaku/scene-renderer.cjs');
const { compareSceneTextPixels } = require('../src/server/danmaku/scene-output-verifier.cjs');
const { unicodeAsset } = require('../src/server/danmaku/emoji.cjs');

async function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), 90_000);
    child.stdout.on('data', b => { stdout += b; });
    child.stderr.on('data', b => { stderr = (stderr + b).slice(-20_000); });
    child.on('error', reject);
    child.on('close', code => { clearTimeout(timer); code === 0 ? resolve({ stdout, stderr }) : reject(new Error(`${command} ${code}: ${stderr}`)); });
  });
}

(async () => {
  const source = process.env.BR2K_EMOJI_SOURCE;
  assert.ok(source, '必须指定 BR2K_EMOJI_SOURCE 真实录像');
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'br2k-emoji-acceptance-'));
  const ffmpeg = '/usr/lib/bili-record-2k/bin/ffmpeg-full';
  const helper = process.env.BR2K_EMOJI_HELPER || '/usr/lib/bili-record-2k/bin/br2k-scene-gpu';
  const probe = JSON.parse((await run('/usr/lib/bili-record-2k/bin/ffprobe-full', ['-v', 'error', '-show_streams', '-of', 'json', source])).stdout);
  const video = probe.streams.find(s => s.codec_type === 'video');
  const [n, d] = video.r_frame_rate.split('/').map(Number);
  const fps = n / d, duration = 10, start = 30;
  const canvas = { width: video.width, height: video.height, fps };
  const emoteUrl = 'https://i0.hdslb.com/bfs/emote/acceptance-fixture.png';
  // Simulated protocol image: same offline snapshot path as an actual CDN
    // download. Protocol parsing and persistence have separate unit coverage;
    // this fixture does not claim a live room/CDN download acceptance.
  const emojiAssets = { [emoteUrl]: { filePath: unicodeAsset('😀').filePath } };
  const events = [
    { type: 'danmaku', time: 0.3, user: '表情观众', text: '😀中文👍🏽🇨🇳👨‍👩‍👧‍👦[测试]', emoticons: [{ token: '[测试]', url: emoteUrl }] },
    { type: 'superchat', time: 0.5, user: '醒目留言用户', text: '长醒目留言必须完整显示，超出一行自动换行，不截成一行。😀这是后面的正文。', price: 30 },
    { type: 'guard', time: 2, uid: 42, user: '真实舰长', giftName: '舰长', guardLevel: 3, count: 1, price: 198, sourceCmd: 'GUARD_BUY' },
    { type: 'guard', time: 2.13, uid: 0, user: '', giftName: '大航海', guardLevel: 0, price: 0, sourceCmd: 'USER_TOAST_MSG_V2' }
  ];
  const report = { source, canvas, directory, tests: [] };
  console.log('DIRECTORY', directory);
  for (const preset of ['current', 'h5-card', 'bubble', 'minimal']) {
    const graph = clipSceneGraph(buildSceneGraph(events, { stylePreset: preset, videoInfo: canvas, emojiAssets }), 0, duration, { shiftTime: false });
    const output = path.join(directory, preset + '.mkv');
    const request = createGpuSceneRenderRequest(graph, { backend: 'cuda-gstreamer', inputPath: source, outputPath: output,
      startTime: start, duration, fps, width: canvas.width, height: canvas.height, codec: 'hevc_nvv4l2', container: 'mkv' });
    Object.assign(request.input, { codec: video.codec_name, sourceFrameRate: video.r_frame_rate });
    const requestPath = path.join(directory, preset + '.json'); await fs.writeFile(requestPath, JSON.stringify(request));
    const result = await run(helper, ['--native-scene-request', requestPath]);
    const metrics = JSON.parse(result.stdout.split(/\r?\n/).find(s => s.includes('"nativeNvmmMetrics"'))).nativeNvmmMetrics;
    assert.equal(metrics.ptsBridge.ok, true);
    const time = 3;
    const actualPath = path.join(directory, preset + '.rgb');
    await run(ffmpeg, ['-v', 'error', '-y', '-i', output, '-ss', String(time), '-frames:v', '1', '-pix_fmt', 'rgb24', '-f', 'rawvideo', actualPath]);
    const assPath = path.join(directory, preset + '.ass');
    await fs.writeFile(assPath, createAss(events.map(e => ({ ...e, _emojiAssets: emojiAssets })), { stylePreset: preset, videoInfo: canvas, renderEmojiImages: true }));
    const filterPath = path.join(directory, preset + '.filter');
    const options = { target: 'software', duration, fps, ...(preset === 'current' ? {} : { legacyAssPath: assPath }) };
    await fs.writeFile(filterPath, createSceneFilterScript(graph, options).script);
    const referencePath = path.join(directory, preset + '-reference.rgb');
    await run(ffmpeg, ['-v', 'error', '-y', '-ss', String(start), '-i', source, '-filter_complex_threads', '1', '-filter_complex_script', filterPath,
      '-map', '[vout]', '-ss', String(time), '-frames:v', '1', '-pix_fmt', 'rgb24', '-f', 'rawvideo', referencePath]);
    const cleanPath = path.join(directory, preset + '-clean.rgb');
    await run(ffmpeg, ['-v', 'error', '-y', '-ss', String(start + time), '-i', source, '-frames:v', '1', '-pix_fmt', 'rgb24', '-f', 'rawvideo', cleanPath]);
    const [actual, reference, clean] = await Promise.all([actualPath, referencePath, cleanPath].map(p => fs.readFile(p)));
    // At 5 fps the selected frame can differ by one source frame after seek.
    // Validate the complete, settled SC body here; moving text is covered by
    // the independent PTS bridge and animation/pixel regressions.
    const bodyAnchor = graph.objects.find(o => o.type === 'Text' && String(o.props.text).includes('长醒目留言') && evaluateSceneObject(o, time).visible);
    assert.ok(bodyAnchor, '醒目留言正文必须存在');
    const bodyId = bodyAnchor.id.replace(/-run-\d+$/, '');
    const bodyGraph = { ...graph, objects: graph.objects.filter(o => o.id === bodyId || o.id.startsWith(bodyId + '-run-') || o.id.startsWith(bodyId + '-emoji-')) };
    const pixels = compareSceneTextPixels(actual, reference, clean, bodyGraph, time);
    let emojiPixels = 0;
    for (const object of graph.objects.filter(o => o.type === 'Image')) {
      const state = evaluateSceneObject(object, time);
      if (!state.visible) continue;
      for (let y = Math.max(0, Math.floor(state.y)); y < Math.min(canvas.height, Math.ceil(state.y + object.frame.height)); y++) {
        for (let x = Math.max(0, Math.floor(state.x)); x < Math.min(canvas.width, Math.ceil(state.x + object.frame.width)); x++) {
          const i = (y * canvas.width + x) * 3;
          const delta = [0, 1, 2].reduce((s, c) => s + Math.abs(reference[i + c] - clean[i + c]), 0);
          const error = [0, 1, 2].reduce((s, c) => s + Math.abs(actual[i + c] - reference[i + c]), 0);
          if (delta > 96 && error < delta * 0.65) emojiPixels++;
        }
      }
    }
    assert.ok(emojiPixels > 30, preset + ' 表情必须出现在 CUDA 成片预期区域');
    assert.ok(pixels.ok, preset + ' 中文和多行 SC 必须通过成片像素门禁 ' + JSON.stringify(pixels));
    await run(ffmpeg, ['-v', 'error', '-y', '-i', output, '-ss', String(time), '-frames:v', '1', path.join(directory, preset + '.png')]);
    report.tests.push({ preset, emojiPixels, pixels, metrics });
    console.log('PASS', preset, 'emojiPixels', emojiPixels, 'text', JSON.stringify(pixels), 'fps', metrics.pipelineFps);
  }
  await fs.writeFile(path.join(directory, 'report.json'), JSON.stringify(report, null, 2));
  console.log('REPORT', path.join(directory, 'report.json'));
})().catch(error => { console.error(error); process.exitCode = 1; });
