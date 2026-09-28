'use strict';

// Opt-in real-source regression. Writes all results below --output-dir;
// neither the original recording nor its JSONL/cache is modified.
const fs = require('node:fs/promises');
const path = require('node:path');
const { LiveRecordService } = require('../src/server/app/service.cjs');
const { readDanmakuEvents } = require('../src/server/danmaku/ass.cjs');
const { buildSceneGraph, clipSceneGraph } = require('../src/server/danmaku/scene-graph.cjs');
const { selectDesktopScenePath } = require('../src/server/danmaku/desktop-scene-policy.cjs');
const { runDesktopSceneExport } = require('../src/server/danmaku/desktop-scene-export.cjs');
const { runFfmpegJob, probeMediaFileInfo, runCapturedProcess } = require('../src/server/shared/helpers.cjs');

async function main() {
  const args = Object.fromEntries(process.argv.slice(2).reduce((pairs, item, index, list) => {
    if (item.startsWith('--')) pairs.push([item.slice(2), list[index + 1]]);
    return pairs;
  }, []));
  if (!args.input || !args.danmaku || !args['output-dir']) throw new Error('需要 --input、--danmaku 和 --output-dir；可选 --duration 30/300/full、--style current/h5-card/bubble/minimal、--start、--ffmpeg。');
  const directory = path.resolve(args['output-dir']);
  await fs.mkdir(directory, { recursive: true });
  const ffmpeg = args.ffmpeg || require('ffmpeg-static');
  const media = await probeMediaFileInfo(ffmpeg, args.input);
  const startTime = Number(args.start || 0);
  const duration = args.duration === 'full' ? media.durationSec - startTime : Number(args.duration || 30);
  const events = await readDanmakuEvents(args.danmaku);
  const stylePreset = args.style || 'current';
  const sceneOptions = { stylePreset, overlayMode: 'danmaku-gift', danmakuArea: 'quarter', videoInfo: media.videoInfo };
  const graph = clipSceneGraph(buildSceneGraph(events, sceneOptions), startTime, startTime + duration, { shiftTime: true });
  const service = new LiveRecordService();
  service.ffmpegPath = ffmpeg;
  const codec = args.codec || 'hevc_nvenc';
  const policy = selectDesktopScenePath(codec, stylePreset, null);
  const decoder = { value: args.decoder || 'cuda', codec: media.videoInfo.codec, label: 'CUDA', kind: 'hardware' };
  const report = { input: path.basename(args.input), duration, startTime, stylePreset, codec,
    sourceFps: media.videoInfo.fps, originalEventCount: events.length, objectCount: graph.objects.length,
    renderer: policy.renderer, startedAt: new Date().toISOString(), processMemoryPeakBytes: 0,
    childMemoryPeakBytes: 0, gpuMemoryPeakMiB: 0, gpu: null };
  const gpu = await runCapturedProcess('nvidia-smi', ['--query-gpu=name,driver_version,memory.total', '--format=csv,noheader']);
  report.gpu = gpu.stdout.trim();
  let child = null;
  let sampling = false;
  let currentTime = 0;
  const started = Date.now();
  const timer = setInterval(async () => {
    if (sampling) return;
    sampling = true;
    try {
      report.processMemoryPeakBytes = Math.max(report.processMemoryPeakBytes, process.memoryUsage().rss);
      const memory = await runCapturedProcess('nvidia-smi', ['--query-gpu=memory.used', '--format=csv,noheader,nounits'], { timeoutMs: 2000 });
      report.gpuMemoryPeakMiB = Math.max(report.gpuMemoryPeakMiB, Number(memory.stdout.trim()) || 0);
      if (process.platform === 'win32' && child?.pid) {
        const processMemory = await runCapturedProcess('powershell.exe', ['-NoProfile', '-Command',
          `(Get-Process -Id ${Number(child.pid)} -ErrorAction SilentlyContinue).WorkingSet64`], { timeoutMs: 2000 });
        report.childMemoryPeakBytes = Math.max(report.childMemoryPeakBytes, Number(processMemory.stdout.trim()) || 0);
      }
    } finally { sampling = false; }
  }, 1500);
  try {
    report.verification = await runDesktopSceneExport({ graph, events, cleanPath: args.input,
      outputPath: path.join(directory, 'result.mp4'), startTime, duration, fps: media.videoInfo.fps,
      codec, crf: 23, container: 'mp4', directory, policy, decoder, includeAudio: Boolean(media.audioInfo),
      copyAudio: startTime === 0 && args.duration === 'full', sceneOptions, ffmpegPath: ffmpeg,
      writeLegacyAss: service.writeLegacySceneCompatibilityAss.bind(service),
      runJob: (jobArgs, stderr, options) => runFfmpegJob(ffmpeg, jobArgs, stderr, options),
      runFallback: service.runFfmpegWithHardwareDecodeFallback.bind(service),
      onChild: (value) => { child = value; },
      onStage: (stage) => console.log(stage),
      onStderr: (text) => { if (/error|failed|invalid/i.test(text)) console.log(text.slice(-600)); },
      onProgress: (seconds) => { currentTime = Math.max(currentTime, seconds); },
      onDiagnostics: (value) => { report.verification = value; }
    });
    report.ok = true;
    // PNGs make the same raw acceptance frames reviewable without extra decoding.
    for (const name of ['preflight-reference', 'preflight-actual', 'final-actual']) {
      await runFfmpegJob(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'rawvideo', '-pix_fmt', 'rgb24',
        '-s', `${media.videoInfo.width}x${media.videoInfo.height}`, '-i', path.join(directory, `${name}.rgb`),
        '-frames:v', '1', path.join(directory, `${name}.png`)]);
    }
  } catch (error) {
    report.ok = false;
    report.error = { message: error.message, code: error.code, processedMediaSeconds: error.processedMediaSeconds,
      completedMediaSeconds: error.completedMediaSeconds, failureKind: error.failureKind };
    process.exitCode = 1;
  } finally {
    clearInterval(timer);
    report.elapsedSeconds = (Date.now() - started) / 1000;
    report.completedMediaSeconds = currentTime;
    report.effectiveFps = currentTime * media.videoInfo.fps / report.elapsedSeconds;
    report.memoryMeasurement = '1.5s sampled; GPU total includes other applications; child peak is sampled working set';
    await fs.writeFile(path.join(directory, 'report.json'), JSON.stringify(report, null, 2), 'utf8');
    console.log(JSON.stringify({ ok: report.ok, fps: report.effectiveFps, elapsedSeconds: report.elapsedSeconds,
      gpuMemoryPeakMiB: report.gpuMemoryPeakMiB, childMemoryPeakBytes: report.childMemoryPeakBytes, error: report.error }));
  }
}

if (require.main === module) main().catch((error) => { console.error(error); process.exitCode = 1; });
