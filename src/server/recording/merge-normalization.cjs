'use strict';

const { createConcatStreamSignature } = require('./ffmpeg.cjs');

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
  // aspect ratios and frame clocks; other layouts keep the existing path.
  const aspect = Number(sourceVideo.width) / Number(sourceVideo.height);
  const targetAspect = Number(targetVideo.width) / Number(targetVideo.height);
  return Number(sourceVideo.width) > 0 && Number(sourceVideo.height) > 0 &&
    Number.isFinite(aspect) && Math.abs(aspect - targetAspect) < 0.0001 &&
    Number(sourceVideo.bitDepth || 8) === 8 && Number(targetVideo.bitDepth || 8) === 8;
}

module.exports = { canReuseMergeSegment, canScaleMergeOnGpu };
