const assert = require('node:assert/strict');
const test = require('node:test');
const {
  SELF_TEST_LEAD_INS,
  STAGE_LABELS,
  createJetsonSelfTestPlan,
  createJetsonStageResults,
  runJetsonEndToEndSelfTest
} = require('../src/server/recording/jetson-self-test.cjs');

test('Jetson end-to-end self-test always covers H.264/HEVC plans and both required lead-ins', () => {
  assert.deepEqual(SELF_TEST_LEAD_INS, [0, 1.019]);
  assert.deepEqual(createJetsonSelfTestPlan('h264_nvv4l2'), {
    codec: 'h264_nvv4l2',
    sourceCodec: 'h264',
    sourceEncoder: 'libx264',
    nativeDecoder: 'h264_nvv4l2dec',
    encoderElement: 'nvv4l2h264enc',
    parserElement: 'h264parse',
    encodedExtension: 'h264'
  });
  assert.equal(createJetsonSelfTestPlan('hevc_nvv4l2').sourceCodec, 'hevc');
  assert.equal(createJetsonSelfTestPlan('hevc_nvv4l2').nativeDecoder, 'hevc_nvv4l2dec');
  assert.deepEqual(Object.keys(createJetsonStageResults()), Object.keys(STAGE_LABELS));
});

test('non-Jetson hosts never mark nvv4l2 as burn-ready', async () => {
  const result = await runJetsonEndToEndSelfTest({
    codec: 'h264_nvv4l2',
    ffmpegPath: process.execPath,
    platform: 'win32',
    runProcess: async () => {
      throw new Error('不应在非 Jetson 主机执行命令');
    }
  });
  assert.equal(result.ok, false);
  assert.equal(result.stages.nativeDecode.status, 'skipped');
  assert.equal(result.stages.finalMux.status, 'skipped');
});
