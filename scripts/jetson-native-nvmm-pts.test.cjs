'use strict';

// This test is deliberately opt-in because it needs an actual Jetson NVDEC,
// NVMM allocator and NVENC session. It guards the bug where a CUDA-only
// timeline offset moved UI objects but failed to create physical black video
// frames before the source, pulling video ahead of the separately muxed audio.

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const test = require('node:test');
const { createGpuSceneRenderRequest } = require('../src/server/danmaku/gpu-scene-renderer.cjs');
const { writeSceneFilterScript } = require('../src/server/danmaku/scene-renderer.cjs');
const { verifySceneOutputFrame } = require('../src/server/danmaku/scene-output-verifier.cjs');
const { runFfmpegJob } = require('../src/server/shared/helpers.cjs');

test('native NVMM progress is driven by media PTS rather than wall clock or frame count', async () => {
  const source = await fs.readFile(process.env.BR2K_JETSON_NVMM_HELPER || path.join(__dirname, '..', 'assets', 'scene-renderer', 'jetson', 'br2k-scene-gpu.py'), 'utf8');
  assert.match(source, /media_end_pts\s*=\s*int\(buffer\.pts\)/);
  assert.match(source, /scene_media_first_pts/);
  assert.match(source, /mediaClock/);
  assert.doesNotMatch(source, /media_seconds\s*=\s*max\(0\.0, min\(duration, counters\['scene'\] \/ max\(1\.0, fps\)\)\)/);
  assert.doesNotMatch(source, /media_seconds\s*=\s*.*wall_seconds/);
  const native = source.slice(source.indexOf('def render_native_nvmm('));
  assert(native.indexOf("add_probe(Gst.PadProbeType.BUFFER, count_buffer") < native.indexOf('pipeline.set_state(Gst.State.PLAYING)'), '逐帧探针必须在启动播放之前安装，不能丢失最初预取的帧');
});

const FPS = 30;
const LEAD_SECONDS = 1.019;
const WIDTH = 320;
const HEIGHT = 180;

test('native rolling glyphs keep a 5 ms source lead both with and without a black frame', async t => {
  if (process.env.BR2K_JETSON_NVMM_PTS !== '1') return t.skip('需要 Orin CUDA/NVMM 实机');
  const helper = process.env.BR2K_JETSON_NVMM_HELPER || '/usr/lib/bili-record-2k/bin/br2k-scene-gpu';
  const ffmpeg = process.env.BR2K_JETSON_NVMM_FFMPEG || '/usr/lib/bili-record-2k/bin/ffmpeg-full';
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'br2k-native-small-lead-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const source = path.join(dir, 'source.mp4'), output = path.join(dir, 'rendered.mkv');
  const base = path.join(dir, 'base.mp4');
  await run('gst-launch-1.0', ['-q', 'videotestsrc', 'num-buffers=120', 'pattern=black', '!',
    'video/x-raw,format=I420,width=640,height=360,framerate=60/1', '!', 'nvvidconv', '!',
    'video/x-raw(memory:NVMM),format=NV12', '!', 'nvv4l2h264enc', 'bitrate=1000000', '!',
    'h264parse', '!', 'qtmux', '!', 'filesink', 'location=' + base]);
  await run(ffmpeg, ['-v', 'error', '-y', '-itsoffset', '0.005', '-i', base,
    '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo', '-map', '0:v', '-map', '1:a',
    '-c:v', 'copy', '-c:a', 'aac', '-t', '2', source]);
  const graph = { schema: 'bili-record2k.scene/v1', version: 1, canvas: { width: 640, height: 360, fps: 60 },
    timeline: { start: 0, end: 2 }, assets: [], objects: [{
    id: 'rolling', type: 'Text', start: 0, end: 2, frame: { x: 620, y: 30, width: 300, height: 50 },
    props: { text: 'CLOCK TEST', fontFamily: 'Noto Sans CJK SC', fontSize: 36, fontWeight: 400 },
    style: { fill: '#ffffff', stroke: '#000000', strokeWidth: 2 },
    animations: [{ type: 'Move', start: 0, end: 2, from: { x: 620, y: 30 }, to: { x: -2180, y: 30 } }]
  }] };
  const opts = { duration: 2, fps: 60, preserveInputClock: true, roundCoordinates: true };
  const reference = await writeSceneFilterScript(path.join(dir, 'reference.filter'), graph, opts);
  const clean = await writeSceneFilterScript(path.join(dir, 'clean.filter'), { ...graph, objects: [] }, opts);
  const check = candidate => verifySceneOutputFrame({ runJob: (...args) => runFfmpegJob(ffmpeg, ...args),
    sourcePath: source, outputPath: candidate, referenceScript: reference.filterScriptPath,
    cleanScript: clean.filterScriptPath, sourceStart: 0, time: 0.3, graph, directory: dir,
    ffmpegPath: ffmpeg, textMask: true });
  for (const timelineOffsetSec of [0, 0.005]) {
    const request = createGpuSceneRenderRequest(graph, { backend: 'cuda-gstreamer', inputPath: source,
      outputPath: output, codec: 'hevc_nvv4l2', fps: 56.87, duration: 2, timelineOffsetSec, container: 'mkv' });
    Object.assign(request.input, { codec: 'h264', sourceFrameRate: '60/1' });
    const requestPath = path.join(dir, 'request.json'); await fs.writeFile(requestPath, JSON.stringify(request));
    await run(helper, ['--native-scene-request', requestPath]);
    assert.equal((await check(output)).ok, true);
  }
  await assert.rejects(check(source), { code: 'BR2K_SCENE_TEXT_VERIFICATION_FAILED' });
});

test('native storage verification reports completed reads and rejects corruption or blocked I/O', async t => {
  if (process.env.BR2K_JETSON_NVMM_PTS !== '1') return t.skip('在 Orin Python 运行时验证存储校验契约');
  const result = await run('/usr/bin/python3', [path.join(__dirname, 'jetson-storage-verification.py')]);
  assert.match(result.stdout, /blocked I\/O passed/);
});

test('native seek preserves every picture and Chinese overlay after a non-IDR sync sample', async t => {
  if (process.env.BR2K_JETSON_NVMM_PTS !== '1') return t.skip('需要 Orin NVDEC/NVMM/NVENC 实机');
  const result = await run('/usr/bin/python3', [path.join(__dirname, 'jetson-native-seek-regression.py')]);
  const report = JSON.parse(result.stdout.trim());
  assert.equal(report.ok, true);
  assert.equal(report.nonIdrSyncSample, true);
  assert.equal(report.reports.length, 3);
});

test('native Scene drawing follows actual PTS across a two-second source gap', async (t) => {
  if (process.env.BR2K_JETSON_NVMM_PTS !== '1') return t.skip('需要 Orin 原生 NVDEC/CUDA/NVENC 链路');
  const result = await run('/usr/bin/python3', [path.join(__dirname, 'jetson-scene-pts-gap.py')]);
  const pixels = result.stdout.split(/\r?\n/).find(line => line.startsWith('{"whiteGlyphPixels"'));
  assert(pixels, result.stderr);
  const report = JSON.parse(pixels);
  assert.equal(report.ok, true);
  assert(report.whiteGlyphPixels > 20);
});

test('native CUDA clock keeps requested fps for unknown caps and accepts precise rational rates', async (t) => {
  if (process.env.BR2K_JETSON_NVMM_PTS !== '1') return t.skip('在 Orin Python 运行时验证解码器帧率契约');
  const helper = process.env.BR2K_JETSON_NVMM_HELPER || '/usr/lib/bili-record-2k/bin/br2k-scene-gpu';
  // Extract only the dependency-free resolver; importing the whole helper
  // would start GStreamer and load libass for this numeric contract test.
  const python = `import ast, pathlib, sys
tree = ast.parse(pathlib.Path(sys.argv[1]).read_text())
function = next(n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name == 'resolve_native_scene_fps')
scope = {}
exec(compile(ast.Module(body=[function], type_ignores=[]), '<fps-contract>', 'exec'), scope)
resolve = scope['resolve_native_scene_fps']
for caps in ['video/x-raw,framerate=(fraction)0/1', 'framerate=(fraction)60/0', 'video/x-raw']:
    assert resolve(caps, 59.9041043857) == ('unavailable', 59.9041043857)
assert resolve('framerate=(fraction)60/1', 59.9) == ('60/1', 60)
_, source_fps = resolve('framerate=(fraction)60/1', 59.9041043857)
assert resolve('framerate=(fraction)0/1', source_fps) == ('unavailable', 60)
name, fps = resolve('framerate=(fraction)60000/1001', 30)
assert name == '60000/1001' and abs(fps - 59.94005994006) < 1e-9
print('unknown and rational decoder rates passed')
`;
  const result = await run('/usr/bin/python3', ['-c', python, helper]);
  assert.match(result.stdout, /decoder rates passed/);
});

function run(command, args, { timeoutMs = 60000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, timeoutMs);
    const stdoutChunks = [];
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdoutChunks.push(chunk); });
    child.stderr.on('data', (chunk) => { stderr = `${stderr}${chunk}`.slice(-16000); });
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('close', (code) => {
      clearTimeout(timer);
      const stdoutBuffer = Buffer.concat(stdoutChunks);
      const stdout = stdoutBuffer.toString('utf8');
      code === 0
        ? resolve({ stdout, stdoutBuffer, stderr })
        : reject(new Error(`${path.basename(command)} ${timedOut ? 'timed out' : `exited ${code}`}: ${stderr || stdout}`));
    });
  });
}

async function probeStreams(ffprobe, inputPath) {
  const result = await run(ffprobe, [
    '-v', 'error', '-show_entries', 'stream=codec_type,start_time,duration', '-of', 'json', inputPath
  ]);
  return JSON.parse(result.stdout).streams || [];
}

async function rgbMean(ffmpeg, inputPath, at) {
  const result = await run(ffmpeg, [
    '-hide_banner', '-loglevel', 'error', '-i', inputPath, '-ss', String(at),
    '-frames:v', '1', '-pix_fmt', 'rgb24', '-f', 'rawvideo', 'pipe:1'
  ]);
  const bytes = result.stdoutBuffer;
  assert.equal(bytes.length, WIDTH * HEIGHT * 3, '必须能抽取 NVMM 输出帧');
  let sum = 0;
  for (const byte of bytes) sum += byte;
  return sum / bytes.length;
}

test('native MP4 edit-list gap preserves the original picture time and finite EOF', async t => {
  if (process.env.BR2K_JETSON_NVMM_PTS !== '1') return t.skip('仅在 AGX Orin 上执行 edit-list PTS 回归');
  const helper = process.env.BR2K_JETSON_NVMM_HELPER || '/usr/lib/bili-record-2k/bin/br2k-scene-gpu';
  const ffmpeg = process.env.BR2K_JETSON_NVMM_FFMPEG || '/usr/lib/bili-record-2k/bin/ffmpeg-full';
  const ffprobe = process.env.BR2K_JETSON_NVMM_FFPROBE || '/usr/lib/bili-record-2k/bin/ffprobe-full';
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'br2k-edit-list-'));
  try {
    const source = path.join(directory, 'source.mp4'), output = path.join(directory, 'output.mkv');
    const request = path.join(directory, 'request.json');
    const raw = path.join(directory, 'white.mp4');
    await run('gst-launch-1.0', ['-q', 'videotestsrc', 'pattern=white', 'num-buffers=102', '!',
      `video/x-raw,format=I420,width=${WIDTH},height=${HEIGHT},framerate=60/1`, '!', 'nvvidconv', '!',
      'video/x-raw(memory:NVMM),format=NV12', '!', 'nvv4l2h264enc', '!', 'h264parse', '!', 'mp4mux', '!',
      'filesink', `location=${raw}`]);
    await run(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-copyts', '-itsoffset', '1.029',
      '-i', raw, '-c:v', 'copy', '-an', source]);
    const sourceStreams = await probeStreams(ffprobe, source);
    const first = Number(sourceStreams.find(s => s.codec_type === 'video').start_time);
    assert.ok(first > 1, '测试素材必须真实含有大于1秒的 edit-list 前导');
    const duration = first + 1.7;
    await fs.writeFile(request, JSON.stringify({
      protocol: 'bili-record2k.gpu-scene-render/v1', backend: 'cuda-gstreamer',
      input: { path: source, codec: 'h264', sourceFrameRate: '60/1', startTime: 0, duration },
      output: { path: output, container: 'mkv', codec: 'hevc_nvv4l2', width: WIDTH, height: HEIGHT,
        fps: 60.0017, pixelFormat: 'nv12', bitrate: 1000000 },
      scene: { schema: 'bili-record2k.render-plan/v1', canvas: { width: WIDTH, height: HEIGHT, fps: 60 }, duration, objects: [], metadata: {} },
      timelineOffsetSec: 0,
      guarantees: { sourcePixelsCompositedOnce: true, avoidsAssVideoIntermediate: true, avoidsTransparentVideoIntermediate: true, exactSceneGraphTiming: true }
    }));
    const result = await run(helper, ['--native-scene-request', request]);
    const metrics = JSON.parse(result.stdout.split(/\r?\n/).find(line => line.includes('"nativeNvmmMetrics"'))).nativeNvmmMetrics;
    assert.equal(metrics.ptsBridge.ok, true);
    assert.ok(metrics.ptsBridge.leadingFrames >= 60, '正式请求不提供前导值时，必须读取容器空编辑');
    assert.ok(Math.abs(metrics.ptsBridge.sourceFirstPts / 1e9 - first) <= 1 / 60, 'NVDEC 必须保留 edit-list 的真实起点');
    assert.ok(metrics.ptsBridge.encodeCoverageSec >= duration - 0.051);
    assert.ok(metrics.ptsBridge.encodeCoverageSec <= duration + 0.051);
    const packets = JSON.parse((await run(ffprobe, ['-v','error','-select_streams','v',
      '-show_entries','packet=pts_time,dts_time,duration_time','-of','json',output])).stdout).packets;
    const times = packets.map(p => Number(p.pts_time));
    // Matroska stores presentation timestamps; FFprobe may guess packet DTS
    // from HEVC headers. Check the frames on the actual presentation clock.
    const decoded = JSON.parse((await run(ffprobe, ['-v','error','-select_streams','v',
      '-show_frames','-show_entries','frame=best_effort_timestamp_time','-of','json',output])).stdout).frames;
    const presentation = decoded.map(frame => Number(frame.best_effort_timestamp_time));
    assert.ok(presentation.every((value,index) => Number.isFinite(value) && (!index || value >= presentation[index-1])), '解码后的成片时间必须单调: ' + JSON.stringify(presentation.slice(0,12)));
    assert.ok(Math.max(...times) <= duration + 1 / 60, '不能重复加上前导时长');
    assert.ok(await rgbMean(ffmpeg, output, first - 0.1) < 12, '前导应为黑帧');
    assert.ok(await rgbMean(ffmpeg, output, first + 0.1) > 200, '原始画面应在正确媒体时刻出现');
    assert.doesNotMatch(result.stderr, /Unsupported frameRate/);
    const seekRequest = JSON.parse(await fs.readFile(request, 'utf8'));
    seekRequest.input.startTime = first + 0.3;
    seekRequest.input.duration = 0.8;
    seekRequest.output.path = path.join(directory, 'seek.mkv');
    seekRequest.scene.duration = 0.8;
    seekRequest.selfTest = true;
    await fs.writeFile(request, JSON.stringify(seekRequest));
    // The old BLOCK probe raced a FLUSH seek and could deadlock only on
    // some starts. Repeat startup and check that draining warmup frames
    // preserves the first requested picture and the complete PTS interval.
    for (let attempt = 0; attempt < 8; attempt++) {
      const seekResult = await run(helper, ['--native-scene-request', request], { timeoutMs: 15000 });
      const seekMetrics = JSON.parse(seekResult.stdout.split(/\r?\n/).find(line => line.includes('"nativeNvmmMetrics"'))).nativeNvmmMetrics;
      assert.equal(seekMetrics.ptsBridge.ok, true);
      assert.equal(seekMetrics.ptsBridge.leadingFrames, 0, '非零剪辑不能重复插入源文件空编辑');
      assert.ok(seekMetrics.ptsBridge.encodeCoverageSec >= 0.75 && seekMetrics.ptsBridge.encodeCoverageSec <= 0.85);
      assert.ok(await rgbMean(ffmpeg, seekRequest.output.path, 0) > 200, '定位后的首帧应立即显示所选源画面');
    }
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('low-rate HEVC clips starting inside an empty edit preserve black lead and Chinese glyph timing', async t => {
  if (process.env.BR2K_JETSON_NVMM_PTS !== '1') return t.skip('需要 Orin NVDEC/CUDA/NVENC 实机');
  const helper = process.env.BR2K_JETSON_NVMM_HELPER || '/usr/lib/bili-record-2k/bin/br2k-scene-gpu';
  const ffmpeg = process.env.BR2K_JETSON_NVMM_FFMPEG || '/usr/lib/bili-record-2k/bin/ffmpeg-full';
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'br2k-low-rate-edit-'));
  try {
    const raw = path.join(directory, 'raw.mp4'), source = path.join(directory, 'source.mp4');
    await run('gst-launch-1.0', ['-q', 'videotestsrc', 'pattern=white', 'num-buffers=30', '!',
      `video/x-raw,format=I420,width=${WIDTH},height=${HEIGHT},framerate=5/1`, '!', 'nvvidconv', '!',
      'video/x-raw(memory:NVMM),format=NV12', '!', 'nvv4l2h265enc', '!', 'h265parse', '!', 'mp4mux', '!',
      'filesink', `location=${raw}`]);
    await run(ffmpeg, ['-v', 'error', '-y', '-copyts', '-itsoffset', '1.991', '-i', raw, '-c:v', 'copy', '-an', source]);
    for (const start of [0.5, 1]) {
      const output = path.join(directory, `clip-${start}.mkv`), request = path.join(directory, 'request.json');
      await fs.writeFile(request, JSON.stringify({
        protocol: 'bili-record2k.gpu-scene-render/v1', backend: 'cuda-gstreamer',
        input: { path: source, codec: 'hevc', sourceFrameRate: '5/1', startTime: start, duration: 3 },
        output: { path: output, container: 'mkv', codec: 'hevc_nvv4l2', width: WIDTH, height: HEIGHT, fps: 4.99, bitrate: 1000000 },
        scene: { canvas: { width: WIDTH, height: HEIGHT, fps: 5 }, duration: 3, objects: [{
          id: 'text-in-empty-edit', type: 'Text', start: 0.2, end: 0.6,
          frame: { x: 10, y: 10, width: 300, height: 60 },
          props: { text: '黑帧时间验收', fontSize: 28, fontFamily: 'Noto Sans CJK SC' }, style: { fill: '#ffffff' }
        }] }
      }));
      const result = await run(helper, ['--native-scene-request', request]);
      const metrics = JSON.parse(result.stdout.split(/\r?\n/).find(line => line.includes('"nativeNvmmMetrics"'))).nativeNvmmMetrics;
      assert.equal(metrics.ptsBridge.ok, true);
      assert.equal(metrics.seekPrerollSec, 0);
      assert.ok(metrics.ptsBridge.leadingFrames > 0);
      const frame = await run(ffmpeg, ['-v', 'error', '-i', output, '-ss', '0.4', '-frames:v', '1', '-pix_fmt', 'rgb24', '-f', 'rawvideo', 'pipe:1']);
      assert.equal(frame.stdoutBuffer.length, WIDTH * HEIGHT * 3);
      let white = 0;
      for (let i = 0; i < frame.stdoutBuffer.length; i += 3) if (Math.min(...frame.stdoutBuffer.subarray(i, i + 3)) > 180) white++;
      assert.ok(white > 20 && white < WIDTH * HEIGHT / 3, `黑帧中的中文必须在所选剪辑时钟显示，实际白色像素=${white}`);
      assert.ok(await rgbMean(ffmpeg, output, 0.8) < 12, '文字结束后仍处于空编辑的画面应恢复黑色');
      assert.doesNotMatch(result.stderr, /invalid or overflowing|before segment event/);
    }
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});

test('native NVMM CUDA Scene materializes a black lead and keeps muxed A/V at PTS zero', async (t) => {
  if (process.env.BR2K_JETSON_NVMM_PTS !== '1') return t.skip('仅在 AGX Orin 上显式执行 NVMM 前导 PTS 回归');
  const helper = process.env.BR2K_JETSON_NVMM_HELPER || '/usr/lib/bili-record-2k/bin/br2k-scene-gpu';
  const ffmpeg = process.env.BR2K_JETSON_NVMM_FFMPEG || '/usr/lib/bili-record-2k/bin/ffmpeg-full';
  const ffprobe = process.env.BR2K_JETSON_NVMM_FFPROBE || '/usr/lib/bili-record-2k/bin/ffprobe-full';
  const source = process.env.BR2K_JETSON_NVMM_SAMPLE || '/usr/lib/bili-record-2k/assets/jetson-self-test/hevc-sample.mp4';
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'br2k-native-nvmm-pts-'));
  try {
    const elementary = path.join(directory, 'lead.h265');
    const requestPath = path.join(directory, 'lead.json');
    const muxed = path.join(directory, 'lead.mp4');
    await fs.writeFile(requestPath, JSON.stringify({
      protocol: 'bili-record2k.gpu-scene-render/v1',
      backend: 'cuda-gstreamer',
      input: { path: source, codec: 'hevc', startTime: 0, duration: 2.5 },
      output: { path: elementary, codec: 'hevc_nvv4l2', width: WIDTH, height: HEIGHT, fps: FPS, pixelFormat: 'nv12', bitrate: 1000000 },
      scene: { schema: 'bili-record2k.render-plan/v1', canvas: { width: WIDTH, height: HEIGHT, fps: FPS }, duration: 2.5, objects: [], metadata: {} },
      timelineOffsetSec: LEAD_SECONDS,
      guarantees: { sourcePixelsCompositedOnce: true, avoidsAssVideoIntermediate: true, avoidsTransparentVideoIntermediate: true, exactSceneGraphTiming: true }
    }), 'utf8');
    const helperResult = await run(helper, ['--native-scene-request', requestPath]);
    // JetPack may print an informational encoder line after the helper's JSON
    // result. Locate the structured line rather than assuming it is last.
    const metricsLine = helperResult.stdout.split(/\r?\n/).find((line) => line.includes('"nativeNvmmMetrics"'));
    assert.ok(metricsLine, `helper 未输出 nativeNvmmMetrics：${helperResult.stdout.slice(-1000)}`);
    const metrics = JSON.parse(metricsLine).nativeNvmmMetrics;
    assert.equal(metrics.pipelineFps, metrics.total, 'native metrics 必须提供 pipelineFps 别名');
    assert.equal(metrics.ptsBridge?.pendingRemaining, 0, 'PTS pending 队列必须在 EOS 清空');
    assert.equal(metrics.ptsBridge?.unmatchedEncodeFrames, 0, '编码帧不能缺少 Scene 配对');
    assert.ok(metrics.frames >= Math.floor(2.4 * FPS), '有限 NVMM 输出必须覆盖请求的媒体时长');
    await fs.stat(elementary);

    // An elementary stream has no container timestamps. Mux it exactly like
    // the production final stage, with an audio clock beginning at zero.
    await run(ffmpeg, [
      '-hide_banner', '-loglevel', 'error', '-y', '-r', String(FPS), '-i', elementary,
      '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo', '-t', '2.5',
      '-map', '0:v:0', '-map', '1:a:0', '-c:v', 'copy', '-c:a', 'aac', '-avoid_negative_ts', 'make_zero', muxed
    ]);
    const streams = await probeStreams(ffprobe, muxed);
    const video = streams.find((stream) => stream.codec_type === 'video');
    const audio = streams.find((stream) => stream.codec_type === 'audio');
    assert.ok(video && audio, '最终 mux 必须同时含有音频和视频');
    assert.ok(Math.abs(Number(video.start_time || 0)) <= 1 / FPS, '视频必须从零时钟开始');
    assert.ok(Math.abs(Number(audio.start_time || 0)) <= 0.03, '音频必须从零时钟开始');

    // Sample the muxed file on the same PTS clock the player will use. Output
    // seeking (rather than raw H26x input seeking) also avoids needing a key
    // frame before the sample point.
    const blackMean = await rgbMean(ffmpeg, muxed, 0.5);
    assert.ok(blackMean < 12, `前导帧必须为黑色，实际平均 RGB=${blackMean.toFixed(2)}`);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});
