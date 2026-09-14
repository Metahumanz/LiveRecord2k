const assert = require('node:assert/strict');
const test = require('node:test');

const {
  appendWhitelistedVideoEncoderArgs,
  createBurnArgs,
  createPreviewHlsArgs
} = require('../src/server/recording/ffmpeg.cjs');
const { LiveRecordService } = require('../src/server/app/service.cjs');

test('video encoder arguments are an explicit whitelist rather than a generic CRF fallback', () => {
  const software = [];
  appendWhitelistedVideoEncoderArgs(software, { codec: 'libx264', crf: 23 });
  assert.deepEqual(software, ['-c:v', 'libx264', '-preset', 'medium', '-crf', '23']);

  const nvenc = [];
  appendWhitelistedVideoEncoderArgs(nvenc, { codec: 'h264_nvenc', crf: 21 });
  assert.deepEqual(nvenc, ['-c:v', 'h264_nvenc', '-preset', 'p5', '-cq', '21', '-b:v', '0']);

  const v4l2 = [];
  appendWhitelistedVideoEncoderArgs(v4l2, { codec: 'h264_v4l2m2m', crf: 24 });
  assert.ok(v4l2.includes('-b:v'));
  assert.ok(!v4l2.includes('-crf'));
  assert.throws(() => appendWhitelistedVideoEncoderArgs([], { codec: 'not-an-encoder', crf: 24 }), /未知或未获准/);
  assert.throws(() => appendWhitelistedVideoEncoderArgs([], { codec: 'h264_nvv4l2', crf: 24 }), /GStreamer/);
});

test('burn and preview argument builders reject an omitted or unknown encoder', () => {
  assert.throws(
    () => createBurnArgs({ cleanPath: 'input.mp4', assPath: 'input.ass', burnedPath: 'output.mp4', crf: 24, container: 'mp4' }),
    /未知或未获准/
  );
  assert.throws(
    () => createPreviewHlsArgs({ inputPath: 'input.mp4', playlistPath: 'index.m3u8', segmentPattern: 'segment_%03d.ts' }),
    /未知或未获准/
  );
});

test('service never invents software codecs when capability detection found none', () => {
  const service = new LiveRecordService();
  service.ffmpegCapabilities = { probedAt: Date.now(), burnCodecs: [], unavailableBurnCodecs: [] };
  assert.deepEqual(service.getAvailableBurnCodecs(), []);
  assert.equal(service.chooseBurnCodec('libx265'), '');
  assert.equal(service.chooseBurnCodec(''), '');
  assert.throws(() => service.requireAvailableBurnCodec('', '烧录'), { code: 'BURN_CODEC_UNAVAILABLE' });
});
