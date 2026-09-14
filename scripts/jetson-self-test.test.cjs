const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  SELF_TEST_LEAD_INS,
  STAGE_LABELS,
  REQUIRED_SCENE_FILTERS,
  createSelfTestSceneGraph,
  createJetsonSelfTestPlan,
  createJetsonStageResults,
  resolveFfprobePath,
  runJetsonEndToEndSelfTest
} = require('../src/server/recording/jetson-self-test.cjs');

test('Jetson end-to-end self-test always covers H.264/HEVC plans and both required lead-ins', () => {
  assert.deepEqual(SELF_TEST_LEAD_INS, [0, 1.019]);
  assert.deepEqual(createJetsonSelfTestPlan('h264_nvv4l2'), {
    codec: 'h264_nvv4l2',
    sourceCodec: 'h264',
    sampleFile: 'h264-sample.mp4',
    nativeDecoder: 'h264_nvv4l2dec',
    encoderElement: 'nvv4l2h264enc',
    parserElement: 'h264parse',
    encodedExtension: 'h264'
  });
  assert.equal(createJetsonSelfTestPlan('hevc_nvv4l2').sourceCodec, 'hevc');
  assert.equal(createJetsonSelfTestPlan('hevc_nvv4l2').nativeDecoder, 'hevc_nvv4l2dec');
  assert.deepEqual(Object.keys(createJetsonStageResults()), Object.keys(STAGE_LABELS));
  assert.equal(Object.hasOwn(createJetsonStageResults(), 'cpuDecode'), true);
  assert.ok(REQUIRED_SCENE_FILTERS.includes('movie'));
  assert.ok(REQUIRED_SCENE_FILTERS.includes('concat'));
  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'br2k-ffprobe-path-'));
  const bundledFfmpegPath = path.join(temporaryDirectory, 'ffmpeg-full');
  const bundledFfprobePath = path.join(temporaryDirectory, 'ffprobe-full');
  fs.writeFileSync(bundledFfprobePath, 'probe');
  try {
    assert.equal(resolveFfprobePath(bundledFfmpegPath), bundledFfprobePath);
  } finally {
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  }
  assert.equal(fs.statSync(path.join(__dirname, '..', 'assets', 'jetson-self-test', 'h264-sample.mp4')).size > 1024, true);
  assert.equal(fs.statSync(path.join(__dirname, '..', 'assets', 'jetson-self-test', 'hevc-sample.mp4')).size > 1024, true);
  const graph = createSelfTestSceneGraph({ width: 320, height: 180, fps: 30 }, 'avatar.png');
  const types = new Set(graph.objects.map((object) => object.type));
  for (const type of ['Text', 'Avatar', 'Card', 'SuperChat', 'Gift']) assert.ok(types.has(type), 'missing Scene object ' + type);
  const implementation = fs.readFileSync(path.join(__dirname, '..', 'src', 'server', 'recording', 'jetson-self-test.cjs'), 'utf8');
  assert.match(implementation, /CPU 解码回退/);
  assert.doesNotMatch(implementation, /'-filters'/);
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
