'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { canReuseMergeSegment, canScaleMergeOnGpu, canNormalizeNativeNvmm, createJetsonNvdecCanonicalInputArgs } = require('../src/server/recording/merge-normalization.cjs');
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

test('native normalization requires an admitted decoder and an exact source frame clock', () => {
  const renderer = { available: true, backend: 'cuda-gstreamer', nativeNvmmScene: true, helper: '/helper' };
  assert(canNormalizeNativeNvmm(renderer, { ...video, width: 1920, height: 1080 }, video));
  for (const patch of [{ available: false }, { nativeNvmmScene: false }, { backend: 'cuda-ffmpeg' }, { helper: '' }])
    assert.equal(canNormalizeNativeNvmm({ ...renderer, ...patch }, video, video), false);
  for (const patch of [{ rFrameRate: '0/1' }, { rFrameRate: '30000/1001' }, { codec: 'vp9' }, { hdr: true }, { bitDepth: 10 }])
    assert.equal(canNormalizeNativeNvmm(renderer, { ...video, ...patch }, video), false);
  assert.equal(canNormalizeNativeNvmm(renderer, video, video, 0.1), false);
});

test('SPS compatibility removes malformed filler first, preserving pictures, color range and source timing', () => {
  const args = createJetsonNvdecCanonicalInputArgs('/source.mp4', '/work.mp4', video, 30);
  assert.equal(args[args.indexOf('-c:v') + 1], 'copy');
  assert.equal(args[args.indexOf('-bsf:v') + 1], 'filter_units=remove_types=12,h264_metadata=video_full_range_flag=0:colour_primaries=1:transfer_characteristics=1:matrix_coefficients=1');
  assert(args.includes('-copyts')); assert(args.includes('-start_at_zero'));
  assert(!args.includes('-r')); assert(!args.join(' ').includes('tick_rate'));
  const fullRange = createJetsonNvdecCanonicalInputArgs('/source.mp4', '/work.mp4', { ...video, colorRange: 'pc', colorPrimaries: 'smpte170m', colorTransfer: 'smpte170m', colorSpace: 'smpte170m' });
  assert.match(fullRange[fullRange.indexOf('-bsf:v') + 1], /video_full_range_flag=1:colour_primaries=6:transfer_characteristics=6:matrix_coefficients=6/);
  for (const patch of [{ hdr: true }, { bitDepth: 10 }, { colorTransfer: 'smpte2084' }, { height: 480 }])
    assert.throws(() => createJetsonNvdecCanonicalInputArgs('/source.mp4', '/work.mp4', { ...video, ...patch }));
  assert.throws(() => createJetsonNvdecCanonicalInputArgs('/source.mp4', '/source.mp4', video), /覆盖/);
});
