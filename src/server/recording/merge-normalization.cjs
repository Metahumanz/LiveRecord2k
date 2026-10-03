'use strict';

const { createConcatStreamSignature } = require('./ffmpeg.cjs');
const path = require('node:path');

function canReuseMergeSegment(mediaInfo, targetVideoInfo, timingInfo, assessment, videoCodec) {
  const video = mediaInfo?.videoInfo;
  const audio = mediaInfo?.audioInfo;
  if (!video || !audio || !timingInfo || timingInfo.timingSafeForCopy !== true ||
      assessment?.requiresNormalization || assessment?.requiresPostMergeVerification ||
      Number(timingInfo.corruptPacketCount || 0) > 0) return false;
  const targetAudio = { codec: 'aac', sampleRate: 48000, channelLayout: 'stereo' };
  const signature = createConcatStreamSignature({ videoInfo: video, audioInfo: audio });
  if (signature !== createConcatStreamSignature({ videoInfo: targetVideoInfo, audioInfo: targetAudio })) return false;
  const hevc = /hevc|h265/i.test(videoCodec);
  if (hevc !== /hevc|h265/i.test(video.codec || '')) return false;
  if (!hevc && !/h264|avc/i.test(video.codec || '')) return false;
  const frameSec = 1 / Math.max(1, Number(targetVideoInfo.fps) || 30);
  return typeof timingInfo.avStartDeltaSec === 'number' && typeof timingInfo.avEndDeltaSec === 'number' &&
    Math.abs(timingInfo.avStartDeltaSec) <= frameSec && Math.abs(timingInfo.avEndDeltaSec) <= 0.08;
}

function canScaleMergeOnGpu(sourceVideo, targetVideo) {
  if (sourceVideo?.hdr || targetVideo?.hdr) return false;
  // nvvidconv scales without the CPU path's letterboxing. Admit only equal
  // aspect ratios; other layouts keep the existing path.
  const aspect = Number(sourceVideo.width) / Number(sourceVideo.height);
  const targetAspect = Number(targetVideo.width) / Number(targetVideo.height);
  return Number(sourceVideo.width) > 0 && Number(sourceVideo.height) > 0 &&
    Number.isFinite(aspect) && Math.abs(aspect - targetAspect) < 0.0001 &&
    Number(sourceVideo.bitDepth || 8) === 8 && Number(targetVideo.bitDepth || 8) === 8;
}

function canNormalizeNativeNvmm(renderer, sourceVideo, targetVideo, recoverySeekSec = 0) {
  if (!renderer?.available || renderer.backend !== 'cuda-gstreamer' || !renderer.nativeNvmmScene || !renderer.helper ||
      recoverySeekSec > 0 || !/^(h264|avc|hevc|h265)(?:\s|$)/i.test(sourceVideo?.codec || '') ||
      !canScaleMergeOnGpu(sourceVideo, targetVideo)) return false;
  const [n, d] = String(sourceVideo.rFrameRate || '').split('/').map(Number);
  return n > 0 && d > 0 && Number(targetVideo.fps) > 0 && Math.abs(n / d - Number(targetVideo.fps)) < 0.001;
}

function createJetsonNvdecCanonicalInputArgs(inputPath, outputPath, sourceVideo, durationSec) {
  if (!inputPath || !outputPath || !/h264|avc/i.test(sourceVideo?.codec || '') || sourceVideo.hdr ||
      Number(sourceVideo.bitDepth || 8) !== 8) throw new Error('NVDEC H.264 兼容输入仅支持 8 位 SDR。');
  if (path.resolve(inputPath) === path.resolve(outputPath)) throw new Error('NVDEC 兼容输入不能覆盖原录像。');
  const colorIds = { bt709: 1, bt470m: 4, bt470bg: 5, smpte170m: 6, smpte240m: 7 };
  const matrixIds = { ...colorIds, fcc: 4 };
  const transferIds = { ...colorIds, gamma22: 4, gamma28: 5, 'iec61966-2-1': 13 };
  // Recorded HD SDR with unspecified tags follows the same BT.709 contract
  // as the existing NVMM conversion. Explicit unsupported color never enters
  // this compatibility rewrite. Do not rewrite timing or picture payloads.
  const resolve = (value, table) => {
    if (!value || value === 'unknown' || value === 'unspecified') {
      if (Number(sourceVideo.height) >= 720) return 1;
      throw new Error('未标记色彩的 SD 源不能推断 NVDEC 色彩参数。');
    }
    if (table[value] === undefined) throw new Error(`不支持规范化的 NVDEC 色彩参数：${value}`);
    return table[value];
  };
  const bsf = 'filter_units=remove_types=12,h264_metadata=' +
    `video_full_range_flag=${sourceVideo.colorRange === 'pc' ? 1 : 0}:` +
    `colour_primaries=${resolve(sourceVideo.colorPrimaries, colorIds)}:` +
    `transfer_characteristics=${resolve(sourceVideo.colorTransfer, transferIds)}:` +
    `matrix_coefficients=${resolve(sourceVideo.colorSpace, matrixIds)}`;
  return ['-hide_banner', '-loglevel', 'error', '-y', '-copyts', '-start_at_zero', '-i', inputPath,
    ...(Number(durationSec) > 0 ? ['-t', String(durationSec)] : []), '-map', '0:v:0', '-an', '-c:v', 'copy',
    '-bsf:v', bsf, '-avoid_negative_ts', 'disabled', '-f', 'mp4', outputPath];
}

module.exports = { canReuseMergeSegment, canScaleMergeOnGpu, canNormalizeNativeNvmm, createJetsonNvdecCanonicalInputArgs };
