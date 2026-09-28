'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const ffmpeg = require('ffmpeg-static');
const { LiveRecordService } = require('../src/server/app/service.cjs');
const { runCapturedProcess, probeMediaFileInfo } = require('../src/server/shared/helpers.cjs');

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
