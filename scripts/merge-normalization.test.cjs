'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { canReuseMergeSegment, canScaleMergeOnGpu } = require('../src/server/recording/merge-normalization.cjs');
const video = { codec: 'h264', width: 3840, height: 2160, fps: 60, rFrameRate: '60/1', pixelFormat: 'yuv420p', bitDepth: 8 };
const media = { videoInfo: video, audioInfo: { codec: 'aac (LC)', sampleRate: 48000, channelLayout: 'stereo' } };
const timing = { timingSafeForCopy: true, corruptPacketCount: 0, avStartDeltaSec: 0, avEndDeltaSec: 0.01 };

test('healthy matching long segments retain their original packets, independent of dropped-frame average FPS', () => {
  assert(canReuseMergeSegment({ ...media, videoInfo: { ...video, fps: 59.97 } }, video, timing, {}, 'h264_nvv4l2'));
  for (const patch of [{ width: 1920 }, { bitDepth: 10 }, { colorTransfer: 'smpte2084' }, { rFrameRate: '30/1' }, { codec: 'hevc' }])
    assert.equal(canReuseMergeSegment({ ...media, videoInfo: { ...video, ...patch } }, video, timing, {}, 'h264_nvv4l2'), false);
});

test('unsafe timestamps, unknown timing and noncanonical audio cannot enter mixed copy concat', () => {
  for (const patch of [{ timingSafeForCopy: false }, { corruptPacketCount: 1 }, { avStartDeltaSec: 1 }, { avEndDeltaSec: 0.2 }])
    assert.equal(canReuseMergeSegment(media, video, { ...timing, ...patch }, {}, 'h264_nvv4l2'), false);
  assert.equal(canReuseMergeSegment(media, video, {}, {}, 'h264_nvv4l2'), false);
  assert.equal(canReuseMergeSegment(media, video, { timingSafeForCopy: true }, {}, 'h264_nvv4l2'), false);
  assert.equal(canReuseMergeSegment(media, video, timing, { requiresNormalization: true }, 'h264_nvv4l2'), false);
  assert.equal(canReuseMergeSegment({ ...media, audioInfo: { ...media.audioInfo, sampleRate: 44100 } }, video, timing, {}, 'h264_nvv4l2'), false);
});

test('GPU scaling preserves aspect ratio and rejects HDR and unsupported bit depth', () => {
  assert(canScaleMergeOnGpu({ ...video, width: 1920, height: 1080 }, video));
  for (const patch of [{ width: 1080, height: 1920 }, { hdr: true }, { bitDepth: 10 }, { width: 0 }])
    assert.equal(canScaleMergeOnGpu({ ...video, ...patch }, video), false);
});
