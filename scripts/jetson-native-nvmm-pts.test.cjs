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

test('native NVMM progress is driven by media PTS rather than wall clock or frame count', async () => {
  const source = await fs.readFile(path.join(__dirname, '..', 'assets', 'scene-renderer', 'jetson', 'br2k-scene-gpu.py'), 'utf8');
  assert.match(source, /media_end_pts\s*=\s*int\(buffer\.pts\)/);
  assert.match(source, /scene_media_first_pts/);
  assert.match(source, /mediaClock/);
  assert.doesNotMatch(source, /media_seconds\s*=\s*max\(0\.0, min\(duration, counters\['scene'\] \/ max\(1\.0, fps\)\)\)/);
  assert.doesNotMatch(source, /media_seconds\s*=\s*.*wall_seconds/);
});

const FPS = 30;
const LEAD_SECONDS = 1.019;
const WIDTH = 320;
const HEIGHT = 180;

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const stdoutChunks = [];
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdoutChunks.push(chunk); });
    child.stderr.on('data', (chunk) => { stderr = `${stderr}${chunk}`.slice(-16000); });
    child.on('error', reject);
    child.on('close', (code) => {
      const stdoutBuffer = Buffer.concat(stdoutChunks);
      const stdout = stdoutBuffer.toString('utf8');
      code === 0
        ? resolve({ stdout, stdoutBuffer, stderr })
        : reject(new Error(`${path.basename(command)} exited ${code}: ${stderr || stdout}`));
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
