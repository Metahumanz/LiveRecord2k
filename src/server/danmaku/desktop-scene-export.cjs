'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { clipSceneGraph } = require('./scene-graph.cjs');
const { writeSceneFilterScript } = require('./scene-renderer.cjs');
const { planDesktopSceneSegments, selectSceneSample, filterLayerCount, MAX_FILTER_LAYERS } = require('./desktop-scene-policy.cjs');
const { verifySceneOutputFrame } = require('./scene-output-verifier.cjs');
const { createBurnArgs, createConcatCopyArgs, createBurnEncodedVideoMuxArgs, writeConcatFile } = require('../recording/ffmpeg.cjs');
const { parseFfmpegProgressTime, probeMediaFileInfo, probeMediaTimelineHealth, probeMediaClipTimelineInfo } = require('../shared/helpers.cjs');

async function runDesktopSceneExport(options) {
  const { graph, events, cleanPath, outputPath, startTime = 0, duration, fps, codec, crf, container, directory,
    policy, decoder, includeAudio, copyAudio, writeLegacyAss, runJob, runFallback, onStderr, onChild, onFallback,
    onStage, onProgress, onDiagnostics, isCancelled, ffmpegPath, sceneOptions } = options;
  const checkCancelled = () => {
    if (!isCancelled?.()) return;
    const error = new Error('Scene 烧录已取消。');
    error.code = 'BR2K_MEDIA_CANCELLED';
    throw error;
  };
  const createLayer = async (selectedGraph, name, sourceStart, span) => {
    checkCancelled();
    const legacyAssPath = await writeLegacyAss(path.join(directory, `${name}.ass`), events,
      { ...sceneOptions, startTime: sourceStart, endTime: sourceStart + span, shiftTime: true });
    let leadingVideoPaddingSec = 0;
    if (policy.segmented) {
      const media = await probeMediaFileInfo(ffmpegPath, cleanPath);
      const clock = await probeMediaClipTimelineInfo(ffmpegPath, cleanPath, sourceStart, span, media, { packetSampleDurationSec: 2 });
      const lead = Math.max(0, Number(clock.firstVideoPts) - sourceStart);
      // Resetting the first decoded video PTS would read past this chunk's
      // source boundary and overlap the following chunk. Retain the measured
      // missing-video interval on the output clock, without shifting audio.
      if (lead > 2 / fps) leadingVideoPaddingSec = Math.min(span, lead);
    }
    const layer = await writeSceneFilterScript(path.join(directory, `${name}.filter`), selectedGraph,
      { duration: span, fps, target: policy.target, legacyAssPath, leadingVideoPaddingSec,
        normalizeFrameClock: policy.segmented, directText: policy.segmented });
    return { ...layer, leadingVideoPaddingSec };
  };
  let activeDecoder = decoder;
  let completedMediaSeconds = 0;
  let formalSegmentStart = 0;
  let formalStarted = false;
  const publishProgress = (seconds) => {
    completedMediaSeconds = Math.max(completedMediaSeconds, Math.min(duration, seconds));
    onProgress?.(completedMediaSeconds);
  };
  const fontWarnings = new Set();
  const encode = async (selectedGraph, sourceStart, span, name, target, audio, frames) => {
    if (policy.segmented && filterLayerCount(selectedGraph) > MAX_FILTER_LAYERS) {
      const error = new Error(`Scene 样本滤镜对象超过资源上限 ${MAX_FILTER_LAYERS}，已停止；请选择较低密度的样本或减少弹幕密度。`);
      error.code = 'BR2K_SCENE_RESOURCE_LIMIT';
      throw error;
    }
    const layer = await createLayer(selectedGraph, name, sourceStart, span);
    checkCancelled();
    if (name !== 'preflight') {
      formalSegmentStart = sourceStart - startTime;
      formalStarted = true;
    }
    activeDecoder = await runFallback({
      decoder: activeDecoder,
      createArgs: (chosen) => {
        const args = createBurnArgs({ cleanPath, burnedPath: target, codec, crf,
          container: audio ? container : 'mkv', startTime: sourceStart, duration: span, fps, inputSeek: true,
          avatarOverlay: layer, decoder: chosen, sourceCodec: decoder?.codec,
          includeAudio: audio && includeAudio, copyAudio });
        args.splice(args.length - 1, 0, '-filter_complex_threads', '1');
        if (frames) args.splice(args.length - 1, 0, '-r', String(fps), '-frames:v', String(frames));
        return args;
      },
      onStderr: (text) => {
        for (const line of String(text).split(/[\r\n]/)) {
          if (!/Fontconfig error|failed to find any fallback with glyph|Glyph.*not found/i.test(line)) continue;
          const warning = line.replace(/\[[^\]]+@[^\]]+\]/g, '').trim().slice(0, 400);
          if (!fontWarnings.has(warning) && fontWarnings.size < 50) { fontWarnings.add(warning); onStderr?.(line); }
        }
        const seconds = parseFfmpegProgressTime(text);
        if (name !== 'preflight') {
          if (Number.isFinite(seconds)) publishProgress(sourceStart - startTime + seconds);
          // Progress clocks are aggregated here, outside the chunk's clock.
          if (!Number.isFinite(seconds) || /error|failed|invalid/i.test(text)) onStderr?.(text);
        } else if (/error|failed|invalid/i.test(text)) onStderr?.(text);
      }, onChild, onFallback, label: '桌面 Scene 烧录',
      beforeRetry: () => fs.rm(target, { force: true })
    });
    if ([...fontWarnings].some((warning) => /Fontconfig error/i.test(warning))) {
      const error = new Error('FFmpeg Fontconfig 配置加载失败，已停止；字体诊断已保留。');
      error.code = 'BR2K_FONTCONFIG_FAILED';
      throw error;
    }
    return layer;
  };
  try {
    const sample = selectSceneSample(graph, duration);
    // Frame-aligned sampling makes rolling text comparable across raw and
    // encoded pictures without tolerating a missing overlay.
    sample.time = Math.round(sample.time * fps) / fps;
    sample.outputTime = sample.start + sample.time;
    const sampleGraph = clipSceneGraph(graph, sample.start, sample.start + sample.duration, { shiftTime: true });
    onStage?.(`正在验证有弹幕样本（${sample.duration.toFixed(1)}秒）`);
    const samplePath = path.join(directory, 'preflight.mkv');
    const sampleLayer = await encode(sampleGraph, startTime + sample.start, sample.duration, 'preflight', samplePath, false);
    const textlessAssPath = path.join(directory, 'preflight-no-text.ass');
    let textlessAss = '';
    if (policy.renderer === 'libass-legacy-compatibility') {
      const body = await fs.readFile(path.join(directory, 'preflight.ass'), 'utf8');
      await fs.writeFile(textlessAssPath, body.split(/\r?\n/).filter((line) =>
        !line.startsWith('Dialogue:') || /^Dialogue:\s*[^,]*,[^,]*,[^,]*,Shape,/.test(line)).join('\n'), 'utf8');
      textlessAss = textlessAssPath;
    }
    // The control retains cards/avatars and the identical input clock; only
    // text disappears. Its difference from the oracle is a glyph-only mask,
    // even if the ASS compatibility layout differs from preview geometry.
    const cleanLayer = await writeSceneFilterScript(path.join(directory, 'preflight-clean.filter'),
      { ...sampleGraph, objects: sampleGraph.objects.filter((object) => object.type !== 'Text') },
      { duration: sample.duration, fps, target: 'software', legacyAssPath: textlessAss,
        leadingVideoPaddingSec: sampleLayer.leadingVideoPaddingSec, normalizeFrameClock: policy.segmented });
    // Verify optimised text against the established texture renderer rather
    // than regenerating the candidate's drawtext chain as its own oracle.
    const referenceLayer = policy.segmented
      ? await writeSceneFilterScript(path.join(directory, 'preflight-reference.filter'), sampleGraph,
        { duration: sample.duration, fps, target: 'software', directText: false,
          leadingVideoPaddingSec: sampleLayer.leadingVideoPaddingSec, normalizeFrameClock: true })
      : sampleLayer;
    const verification = { sample, renderer: policy.renderer, encoder: codec, decoder: activeDecoder,
      fontWarnings: [...fontWarnings], leadingVideoPaddingSec: sampleLayer.leadingVideoPaddingSec };
    verification.pixels = await verifySceneOutputFrame({ runJob, sourcePath: cleanPath, outputPath: samplePath,
      referenceScript: referenceLayer.filterScriptPath, cleanScript: cleanLayer.filterScriptPath,
      sourceStart: startTime + sample.start, time: sample.time, graph: sampleGraph, directory, onChild, ffmpegPath, textMask: true });
    onDiagnostics?.(verification);
    checkCancelled();
    const chunks = [];
    if (policy.segmented) {
      const segments = planDesktopSceneSegments(graph, duration, fps);
      verification.segmentCount = segments.length;
      const totalFrames = segments.reduce((sum, segment) => sum + segment.frames, 0);
      verification.frameCount = totalFrames;
      for (let index = 0; index < segments.length; index++) {
        checkCancelled();
        const segment = segments[index];
        onStage?.(`正在分段合成 Scene：${index + 1}/${segments.length}`);
        const chunkGraph = clipSceneGraph(graph, segment.start, segment.end, { shiftTime: true });
        const target = path.join(directory, `chunk-${index}.mkv`);
        const chunkLayer = await encode(chunkGraph, startTime + segment.start, segment.duration, `chunk-${index}`, target, false, segment.frames);
        if (index === 0) verification.leadingVideoPaddingSec = chunkLayer.leadingVideoPaddingSec;
        // Audit actual stream timestamps before admitting a chunk to concat.
        const chunkInfo = await probeMediaFileInfo(ffmpegPath, target);
        const health = await probeMediaTimelineHealth(ffmpegPath, target, chunkInfo, { packetSampleDurationSec: 1 });
        if (!health.timingSafeForCopy || Math.abs(Number(health.videoPresentationDurationSec) - segment.duration) > Math.max(0.08, 2 / fps)) {
          throw new Error(`Scene 分段 ${index + 1} 的时长/时间戳未通过连续性验收。`);
        }
        chunks.push(target);
        publishProgress(segment.end);
      }
      const concatPath = path.join(directory, 'chunks.concat');
      const joined = path.join(directory, 'joined.mkv');
      await writeConcatFile(concatPath, chunks, { durations: segments.map((segment) => segment.duration) });
      await runJob(createConcatCopyArgs({ concatPath, outputPath: joined, container: 'mkv', streamCodec: codec }), onStderr, { onChild });
      onStage?.('正在封装音视频并验证连续性');
      await runJob(createBurnEncodedVideoMuxArgs({ encodedVideoPath: joined, cleanPath, outputPath, codec,
        sourceCodec: decoder?.codec, fps, startTime, duration, container, includeAudio, copyAudio, preserveVideoTimestamps: true }), onStderr, { onChild });
      const finalInfo = await probeMediaFileInfo(ffmpegPath, outputPath);
      const health = await probeMediaTimelineHealth(ffmpegPath, outputPath, finalInfo, { packetSampleDurationSec: 1 });
      verification.timeline = health;
      if (!health.timingSafeForCopy || Math.abs(Number(health.videoPresentationDurationSec) - totalFrames / fps) > Math.max(0.1, 2 / fps)) {
        throw new Error('Scene 合并成片的音视频连续性未通过验收。');
      }
    } else {
      onStage?.('正在 ASS 兼容合成并编码');
      await encode(graph, startTime, duration, 'formal', outputPath, true);
    }
    checkCancelled();
    onStage?.('正在抽帧验证成片弹幕');
    verification.finalPixels = await verifySceneOutputFrame({ runJob, sourcePath: cleanPath, outputPath,
      referenceScript: referenceLayer.filterScriptPath, cleanScript: cleanLayer.filterScriptPath,
      sourceStart: startTime + sample.start, time: sample.time, outputTime: sample.outputTime,
      graph: sampleGraph, directory, prefix: 'final', onChild, ffmpegPath, textMask: true });
    verification.decoder = activeDecoder;
    verification.completedMediaSeconds = duration;
    verification.fontWarnings = [...fontWarnings];
    await fs.writeFile(path.join(directory, 'verification.json'), JSON.stringify(verification, null, 2), 'utf8');
    onDiagnostics?.(verification);
    return verification;
  } catch (error) {
    error.completedMediaSeconds = Math.min(duration, Math.max(completedMediaSeconds,
      formalStarted ? formalSegmentStart + (Number(error.processedMediaSeconds) || 0) : 0));
    if (error.code !== 'BR2K_MEDIA_CANCELLED') {
      error.diagnosticDirectory = directory;
      await fs.writeFile(path.join(directory, 'failure.json'), JSON.stringify({ code: error.code, message: error.message,
        processedMediaSeconds: error.processedMediaSeconds, completedMediaSeconds: error.completedMediaSeconds,
        failureKind: error.failureKind, policy }, null, 2), 'utf8').catch(() => {});
    }
    throw error;
  }
}

module.exports = { runDesktopSceneExport };
