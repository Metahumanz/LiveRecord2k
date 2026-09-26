'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { evaluateSceneObject } = require('./scene-graph.cjs');
const { probeMediaFileInfo, probeMediaClipTimelineInfo } = require('../shared/helpers.cjs');

function compareSceneTextPixels(actual, reference, clean, graph, time, textMask = false) {
  const width = Math.floor(graph.canvas.width / 2) * 2;
  const height = Math.floor(graph.canvas.height / 2) * 2;
  const expectedBytes = width * height * 3;
  if ([actual, reference, clean].some((bytes) => bytes.length !== expectedBytes)) throw new Error('弹幕验收抽帧尺寸无效。');
  const mask = new Uint8Array(width * height);
  let glyphPixels = 0;
  let matchedPixels = 0;
  const regions = textMask ? [{ type: 'Text', start: 0, end: Number.MAX_SAFE_INTEGER,
    frame: { x: 1, y: 1, width: width - 2, height: height - 2 } }] : graph.objects;
  for (const object of regions) {
    if (object.render === false || object.type !== 'Text') continue;
    const state = evaluateSceneObject(object, time);
    if (!state.visible || state.opacity < 0.5) continue;
    const left = Math.max(1, Math.floor(state.x));
    const top = Math.max(1, Math.floor(state.y));
    const right = Math.min(width - 1, Math.ceil(state.x + object.frame.width * state.scaleX));
    const bottom = Math.min(height - 1, Math.ceil(state.y + object.frame.height * state.scaleY));
    for (let y = top; y < bottom; y++) {
      for (let x = left; x < right; x++) {
        const pixel = y * width + x;
        if (mask[pixel]) continue;
        mask[pixel] = 1;
        const i = pixel * 3;
        let expectedDelta = 0;
        let actualError = 0;
        let edge = 0;
        for (let channel = 0; channel < 3; channel++) {
          expectedDelta += Math.abs(reference[i + channel] - clean[i + channel]);
          actualError += Math.abs(actual[i + channel] - reference[i + channel]);
          edge += Math.max(Math.abs(reference[i + channel] - reference[i + channel - 3]),
            Math.abs(reference[i + channel] - reference[i + channel - width * 3]));
        }
        // Restrict acceptance to contrasting glyph edges inside text bounds.
        // Card fills, video motion and encoder noise cannot pass this test.
        if (expectedDelta < 96 || edge < 60) continue;
        glyphPixels++;
        if (actualError < expectedDelta * 0.65) matchedPixels++;
      }
    }
  }
  const matchedRatio = glyphPixels ? matchedPixels / glyphPixels : 0;
  return { ok: glyphPixels >= 12 && matchedRatio >= 0.55, glyphPixels, matchedPixels, matchedRatio, time };
}

async function verifySceneOutputFrame({ runJob, sourcePath, outputPath, referenceScript, cleanScript,
  sourceStart, time, outputTime = time, graph, directory, prefix = 'preflight', onChild, ffmpegPath, textMask = false }) {
  const outputInfo = await probeMediaFileInfo(ffmpegPath, outputPath);
  const outputTimeline = await probeMediaClipTimelineInfo(ffmpegPath, outputPath, 0, 2, outputInfo, { packetSampleDurationSec: 1 });
  // Input seeking is relative to the container origin, which can be audio's
  // AAC priming timestamp. Compensate the measured mux lead, not a guessed
  // frame delay, so scrolling glyph edges refer to the same scene frame.
  const videoOrigin = Number(outputTimeline.firstVideoPts) || 0;
  const containerOrigin = outputTimeline.firstAudioPts === null ? videoOrigin
    : Math.min(videoOrigin, Number(outputTimeline.firstAudioPts) || 0);
  const muxOffset = videoOrigin - containerOrigin;
  const snapshot = async (input, at, name, script = '', frames = 1) => {
    const target = path.join(directory, `${prefix}-${name}.rgb`);
    const args = ['-hide_banner', '-loglevel', 'error', '-y', '-ss', String(script ? sourceStart : at), '-i', input];
    if (script) args.push('-filter_complex_threads', '1', '-filter_complex_script', script, '-map', '[vout]', '-ss', String(at));
    else args.push('-map', '0:v:0');
    args.push('-frames:v', String(frames), '-pix_fmt', 'rgb24', '-f', 'rawvideo', target);
    await runJob(args, () => {}, { onChild });
    return fs.readFile(target);
  };
  // Keep bounded sequential decoding; do not allocate three 1440p decoders
  // while a desktop capture is still running.
  const reference = await snapshot(sourcePath, time, 'reference', referenceScript);
  const clean = await snapshot(sourcePath, time, 'clean', cleanScript);
  const frameStep = 1 / (Number(outputInfo.videoInfo?.fps) || 30);
  // Source VFR and the encoded CFR may quantize a requested timestamp to
  // opposite sides of a frame boundary. Inspect only its adjacent frames;
  // missing glyphs still fail every candidate, regardless of video motion.
  const actualFrames = await snapshot(outputPath, Math.max(0, outputTime + muxOffset - frameStep), 'actual', '', 3);
  const frameBytes = reference.length;
  let result = null;
  let bestFrame = null;
  for (let offset = 0; offset < Math.min(3, Math.floor(actualFrames.length / frameBytes)); offset++) {
    const actual = actualFrames.subarray(offset * frameBytes, (offset + 1) * frameBytes);
    const candidate = compareSceneTextPixels(actual, reference, clean, graph, time, textMask);
    if (!result || candidate.matchedRatio > result.matchedRatio) {
      result = { ...candidate, adjacentFrame: offset - 1 };
      bestFrame = actual;
    }
  }
  if (!result) throw new Error('弹幕验收无法抽取成片帧。');
  await fs.writeFile(path.join(directory, `${prefix}-actual.rgb`), bestFrame);
  result.muxOffset = muxOffset;
  await fs.writeFile(path.join(directory, `${prefix}-pixels.json`), JSON.stringify(result, null, 2), 'utf8');
  if (!result.ok) {
    const error = new Error(`弹幕画面验收失败：预期文字边缘 ${result.glyphPixels} 像素，匹配 ${(result.matchedRatio * 100).toFixed(1)}%；已停止并保留诊断。`);
    error.code = 'BR2K_SCENE_TEXT_VERIFICATION_FAILED';
    error.verification = result;
    throw error;
  }
  return result;
}

module.exports = { compareSceneTextPixels, verifySceneOutputFrame };
