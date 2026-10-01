'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const ffmpeg = require('ffmpeg-static');
const { LiveRecordService } = require('../src/server/app/service.cjs');
const { runCapturedProcess, probeMediaFileInfo, probeMediaTimelineInfo } = require('../src/server/shared/helpers.cjs');
const { createBurnAudioMuxArgs, writeConcatFile } = require('../src/server/recording/ffmpeg.cjs');

test('bounded Scene mux preserves rendered tail frames when source AAC ends early', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'br2k-short-audio-tail-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const cleanPath = path.join(dir, 'source.mp4');
  const chunkPath = path.join(dir, 'rendered.mkv');
  const concatPath = path.join(dir, 'chunks.ffconcat');
  const generate = await runCapturedProcess(ffmpeg, [
    '-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=s=320x180:r=25:d=3',
    '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=2.7',
    '-c:v', 'libx264', '-bf', '0', '-c:a', 'aac', cleanPath
  ], { timeoutMs: 20000 });
  assert.equal(generate.status, 0, generate.stderr);
  const rendered = await runCapturedProcess(ffmpeg, [
    '-hide_banner', '-loglevel', 'error', '-y', '-i', cleanPath, '-map', '0:v:0', '-c:v', 'copy', '-an', chunkPath
  ], { timeoutMs: 20000 });
  assert.equal(rendered.status, 0, rendered.stderr);
  await writeConcatFile(concatPath, [chunkPath], { durations: [3] });
  for (const copyAudio of [false, true]) {
    const outputPath = path.join(dir, `mux-${copyAudio}.mp4`);
    const args = createBurnAudioMuxArgs({ concatPath, cleanPath, outputPath,
      codec: 'libx264', sourceCodec: 'h264', startTime: 0, duration: 3, container: 'mp4', copyAudio });
    const result = await runCapturedProcess(ffmpeg, args, { timeoutMs: 20000 });
    assert.equal(result.status, 0, result.stderr);
    const info = await probeMediaFileInfo(ffmpeg, outputPath);
    const timing = await probeMediaTimelineInfo(ffmpeg, outputPath, info);
    assert.ok(Math.abs(timing.videoPresentationDurationSec - 3) < 0.05, JSON.stringify(timing));
    if (!copyAudio) {
      assert.ok(Math.abs(timing.audioDurationSec - 3) < 0.05, JSON.stringify(timing));
      assert.ok(timing.timingSafeForCopy, JSON.stringify(timing));
    }
    const frames = await runCapturedProcess(ffmpeg, ['-hide_banner', '-i', outputPath,
      '-map', '0:v:0', '-c:v', 'copy', '-f', 'framehash', '-'], { timeoutMs: 20000 });
    assert.equal(frames.status, 0, frames.stderr);
    assert.equal(frames.stdout.split(/\r?\n/).filter(line => /^0,/.test(line)).length, 75,
      'Mux must retain every rendered video packet, including the frames after source audio EOF');
  }
});

test('real FFmpeg resumes audio mux from a video-only MKV after restart', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'br2k-real-mux-'));
  const sceneDir = await fs.mkdtemp(path.join(os.tmpdir(), 'br2k-export-scene-real-'));
  t.after(async () => { await fs.rm(root, { recursive: true, force: true }); await fs.rm(sceneDir, { recursive: true, force: true }); });
  const mediaDir = path.join(root, '.br2k-export-media-real');
  const recoveryDir = path.join(root, 'config', 'export-recovery');
  await fs.mkdir(mediaDir); await fs.mkdir(recoveryDir, { recursive: true });
  const cleanPath = path.join(root, '123_测试_20260928_120000.clean.mp4');
  const chunkPath = path.join(mediaDir, 'scene-chunk-0000.mkv');
  const outputPath = path.join(root, '123_测试_20260928_120000.clean.clip_0-2.danmaku.mp4');
  const sourceResult = await runCapturedProcess(ffmpeg, [
    '-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=s=640x360:r=30:d=2',
    '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=2',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', cleanPath
  ], { timeoutMs: 20000 });
  assert.equal(sourceResult.status, 0, sourceResult.stderr);
  const videoResult = await runCapturedProcess(ffmpeg, [
    '-hide_banner', '-loglevel', 'error', '-y', '-i', cleanPath, '-map', '0:v:0', '-c:v', 'copy', '-an', chunkPath
  ], { timeoutMs: 20000 });
  assert.equal(videoResult.status, 0, videoResult.stderr);
  const source = await fs.stat(cleanPath), chunk = await fs.stat(chunkPath);
  const id = 'scene-mux-1234567890-9999.json';
  await fs.writeFile(path.join(recoveryDir, id), JSON.stringify({
    version: 1, createdAt: new Date().toISOString(), cleanPath, finalOutputPath: outputPath,
    outputPath: path.join(mediaDir, 'completed.mp4'),
    concatPath: path.join(sceneDir, 'scene-chunks.ffconcat'), chunkPaths: [chunkPath], chunkDurations: [2],
    codec: 'libx264', sourceCodec: 'h264', startTime: 0, duration: 2, outputContainer: 'mp4',
    leadingAudioPaddingSec: 0, includeAudio: true, copyAudio: true,
    sourceSize: source.size, sourceMtimeMs: source.mtimeMs, chunkSizes: [chunk.size]
  }));
  const service = new LiveRecordService();
  service.settings.outputDir = root;
  service.lastExportDiagnosticPath = path.join(root, 'config', 'last-export-diagnostic.json');
  service.ffmpegPath = ffmpeg;
  service.log = () => {};
  service.emitState = () => {};
  await service.runSceneMuxRecovery(id);
  const info = await probeMediaFileInfo(ffmpeg, outputPath);
  assert.ok(info.videoInfo);
  assert.ok(info.audioInfo);
  await assert.rejects(fs.stat(chunkPath), { code: 'ENOENT' });
  assert.equal((await fs.stat(cleanPath)).size, source.size);
});
