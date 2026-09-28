'use strict';

// Runs the real recovery path against an existing long source and an already
// burned video. Only test-owned workspaces are written; existing media is read.
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { LiveRecordService } = require('../src/server/app/service.cjs');
const { probeMediaFileInfo } = require('../src/server/shared/helpers.cjs');

const root = path.resolve(process.env.BR2K_ACCEPT_ROOT || '');
const sourcePath = path.resolve(process.env.BR2K_ACCEPT_SOURCE || '');
const burnedPath = path.resolve(process.env.BR2K_ACCEPT_BURNED || '');
const ffmpegPath = path.resolve(process.env.BR2K_ACCEPT_FFMPEG || '');
const reportPath = path.resolve(process.env.BR2K_ACCEPT_REPORT || path.join(os.tmpdir(), 'br2k-scene-mux-recovery-report.json'));
const output = value => process.stdout.write(JSON.stringify({ at: new Date().toISOString(), ...value }) + '\n');

function runMedia(args, { hashOutput = false } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpegPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const hash = crypto.createHash('sha256');
    let outputBytes = 0;
    let stderr = '';
    let stdout = '';
    let lastReport = Date.now();
    child.stdout.on('data', data => {
      if (hashOutput) { hash.update(data); outputBytes += data.length; }
      else {
        stdout = (stdout + data.toString()).slice(-4096);
        if (Date.now() - lastReport > 30000) {
          const stamp = /out_time=([^\r\n]+)/.exec(stdout)?.[1] || '';
          output({ stage: 'video-copy', mediaTime: stamp });
          lastReport = Date.now();
        }
      }
    });
    child.stderr.on('data', data => { stderr = (stderr + data.toString()).slice(-4096); });
    child.once('error', reject);
    child.once('close', code => code === 0 && (!hashOutput || outputBytes > 0)
      ? resolve(hashOutput ? hash.digest('hex') : null)
      : reject(new Error(`ffmpeg 退出码 ${code}：${stderr.slice(-1200)}`)));
  });
}

async function frameHash(file, second) {
  return runMedia(['-hide_banner', '-nostdin', '-loglevel', 'error', '-ss', second.toFixed(3),
    '-i', file, '-frames:v', '1', '-vf', 'format=rgb24', '-f', 'image2pipe', '-vcodec', 'png', 'pipe:1'],
  { hashOutput: true });
}

async function main() {
  if (![root, sourcePath, burnedPath, ffmpegPath].every(value => value && value !== path.resolve(''))) {
    throw new Error('必须指定 BR2K_ACCEPT_ROOT、SOURCE、BURNED 和 FFMPEG。');
  }
  if (sourcePath === burnedPath || !sourcePath.startsWith(root + path.sep) || !burnedPath.startsWith(root + path.sep)) {
    throw new Error('测试源文件和既有烧录片必须是录像目录内不同的文件。');
  }
  const [sourceInfo, burnedInfo] = await Promise.all([
    probeMediaFileInfo(ffmpegPath, sourcePath), probeMediaFileInfo(ffmpegPath, burnedPath)
  ]);
  const fullDuration = Number(burnedInfo.durationSec || 0);
  const requestedDuration = Number(process.env.BR2K_ACCEPT_DURATION || fullDuration);
  if (!sourceInfo.videoInfo || !sourceInfo.audioInfo || !burnedInfo.videoInfo ||
      !Number.isFinite(requestedDuration) || requestedDuration < 2 || requestedDuration > fullDuration + 0.01 ||
      Math.abs(Number(sourceInfo.durationSec || 0) - fullDuration) > 0.25) {
    throw new Error('源片与既有烧录片的音视频或时长不匹配。');
  }
  const testDir = await fs.mkdtemp(path.join(root, '.br2k-recovery-accept-'));
  const sceneDir = await fs.mkdtemp(path.join(os.tmpdir(), 'br2k-export-scene-accept-'));
  const mediaDir = await fs.mkdtemp(path.join(testDir, '.br2k-export-media-'));
  const chunkPath = path.join(mediaDir, 'scene-chunk-0000.mkv');
  const targetPath = path.join(testDir, path.basename(burnedPath));
  const id = `scene-mux-${Date.now()}-${process.pid}.json`;
  const recoveryDir = path.join(testDir, 'export-recovery');
  await fs.mkdir(recoveryDir);
  const report = { sourcePath, burnedPath, testDir, sceneDir, mediaDir, targetPath, durationSec: requestedDuration,
    sourceBytes: (await fs.stat(sourcePath)).size, burnedBytes: (await fs.stat(burnedPath)).size,
    phaseTimes: {}, frameMatches: [], ok: false };
  const writeReport = async () => { await fs.writeFile(reportPath, JSON.stringify(report, null, 2)); };
  try {
    const copyStarted = Date.now();
    output({ stage: 'video-copy-start', durationSec: requestedDuration, testDir });
    await runMedia(['-hide_banner', '-nostdin', '-y', '-i', burnedPath,
      '-t', String(requestedDuration), '-map', '0:v:0', '-c:v', 'copy', '-an',
      '-f', 'matroska', '-progress', 'pipe:1', chunkPath]);
    report.phaseTimes.videoCopySec = (Date.now() - copyStarted) / 1000;
    const sourceStat = await fs.stat(sourcePath), chunkStat = await fs.stat(chunkPath);
    report.chunkBytes = chunkStat.size;
    const recovery = { version: 1, createdAt: new Date().toISOString(), cleanPath: sourcePath,
      finalOutputPath: targetPath, outputPath: path.join(mediaDir, 'completed.mp4'),
      concatPath: path.join(sceneDir, 'scene-chunks.ffconcat'), chunkPaths: [chunkPath],
      chunkDurations: [requestedDuration], codec: burnedInfo.videoInfo.codec || 'hevc',
      sourceCodec: sourceInfo.videoInfo.codec || 'hevc', startTime: 0, duration: requestedDuration,
      outputContainer: 'mp4', leadingAudioPaddingSec: 0, includeAudio: true, copyAudio: true,
      sourceSize: sourceStat.size, sourceMtimeMs: sourceStat.mtimeMs, chunkSizes: [chunkStat.size] };
    await fs.writeFile(path.join(recoveryDir, id), JSON.stringify(recovery));
    const app = new LiveRecordService();
    app.settings.outputDir = root;
    app.lastExportDiagnosticPath = path.join(testDir, 'last-export-diagnostic.json');
    app.ffmpegPath = ffmpegPath;
    app.log = (level, message) => output({ stage: 'service-log', level, message: String(message).slice(0, 500) });
    app.emitState = () => {};
    const timer = setInterval(() => {
      const progress = app.exportProgress;
      if (progress) output({ stage: progress.phase, phasePercent: progress.phasePercent,
        mediaTimeSec: progress.phaseCurrentTimeSec, message: progress.stageLabel });
    }, 30000);
    timer.unref();
    try {
      const muxStarted = Date.now();
      output({ stage: 'recovery-start', chunkBytes: chunkStat.size });
      await app.runSceneMuxRecovery(id);
      report.phaseTimes.recoverySec = (Date.now() - muxStarted) / 1000;
    } finally { clearInterval(timer); }
    const finalInfo = await probeMediaFileInfo(ffmpegPath, targetPath);
    if (!finalInfo.videoInfo || !finalInfo.audioInfo) throw new Error('实测成片缺少视频或音频。');
    report.finalBytes = (await fs.stat(targetPath)).size;
    report.finalDurationSec = finalInfo.durationSec;
    const points = [20, requestedDuration * 0.25, requestedDuration * 0.5,
      requestedDuration * 0.75, Math.max(1, requestedDuration - 20)]
      .filter(value => value < requestedDuration - 0.2);
    for (const second of points) {
      const [original, recovered] = await Promise.all([
        frameHash(burnedPath, second), frameHash(targetPath, second)
      ]);
      report.frameMatches.push({ second, match: original === recovered });
      if (original !== recovered) throw new Error(`第 ${second.toFixed(2)} 秒画面与既有烧录片不一致。`);
    }
    if ((await fs.stat(sourcePath)).size !== report.sourceBytes ||
        (await fs.stat(burnedPath)).size !== report.burnedBytes) throw new Error('原始媒体大小发生变化。');
    report.ok = true;
    await writeReport();
    await fs.rm(testDir, { recursive: true, force: true });
    report.testOutputRemoved = true;
    await writeReport();
    output({ stage: 'completed', reportPath, finalBytes: report.finalBytes,
      recoverySec: report.phaseTimes.recoverySec, frames: report.frameMatches.length });
  } catch (error) {
    report.error = error.message;
    await writeReport();
    output({ stage: 'failed', reportPath, testDir, error: error.message });
    throw error;
  }
}

main().catch(error => { process.stderr.write(error.stack + '\n'); process.exitCode = 1; });
