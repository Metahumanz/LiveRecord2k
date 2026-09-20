'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { buildSceneGraph } = require('../src/server/danmaku/scene-graph.cjs');
const {
  GPU_SCENE_PROTOCOL,
  JETSON_CUDA_NVMM_REQUIRED_ELEMENTS,
  createGpuSceneRenderRequest,
  createGpuSceneProbeArgs,
  parseGpuSceneRendererProbe
} = require('../src/server/danmaku/gpu-scene-renderer.cjs');

function sampleGraph() {
  return buildSceneGraph(
    [
      { type: 'danmaku', time: 0.2, uid: 7, user: 'GPU', text: 'GPU Scene', color: 0xffffff },
      { type: 'superchat', time: 0.5, uid: 8, user: '头像', text: '卡片', price: 30, avatarUrl: 'builtin:avatar' },
      { type: 'gift', time: 1, uid: 9, user: '礼物', giftName: '测试', count: 1, price: 1, avatarUrl: 'builtin:avatar' }
    ],
    { videoInfo: { width: 1920, height: 1080, fps: 60 }, durationSec: 3, overlayMode: 'danmaku-gift' }
  );
}

test('GPU Scene request preserves canonical objects and has no pixel intermediate', () => {
  const graph = sampleGraph();
  const request = createGpuSceneRenderRequest(graph, {
    inputPath: '/recording/clean.mp4', outputPath: '/tmp/out.h265', codec: 'hevc_nvv4l2', duration: 3, fps: 60
  });
  assert.equal(request.protocol, GPU_SCENE_PROTOCOL);
  assert.equal(request.backend, 'gl-gstreamer');
  assert.equal(request.output.pixelFormat, 'nv12');
  assert.equal(request.scene.objects.length, graph.objects.filter((object) => object.render !== false).length);
  assert.equal(request.guarantees.avoidsAssVideoIntermediate, true);
  assert.equal(request.guarantees.avoidsTransparentVideoIntermediate, true);
  assert.deepEqual(createGpuSceneProbeArgs(), ['--probe=json']);
  assert.ok(JETSON_CUDA_NVMM_REQUIRED_ELEMENTS.includes('nvivafilter'));
  assert.equal(JETSON_CUDA_NVMM_REQUIRED_ELEMENTS.includes('cudacompositor'), false);
});

test('GPU Scene aligns a fractional lead-in to the next I420 frame boundary', () => {
  const request = createGpuSceneRenderRequest(sampleGraph(), {
    inputPath: '/recording/clean.mp4', outputPath: '/tmp/out.h265', duration: 3, fps: 60, timelineOffsetSec: 1.019
  });
  assert.equal(request.timelineOffsetSec, 62 / 60);
});

test('native NVMM and the I420 bridge can use a timestamped MKV contract', () => {
  const nativeRequest = createGpuSceneRenderRequest(sampleGraph(), {
    inputPath: '/recording/clean.mp4', outputPath: '/tmp/native.mkv', duration: 20, fps: 59.483, container: 'mkv'
  });
  const bridgeRequest = createGpuSceneRenderRequest(sampleGraph(), {
    inputPath: '/recording/clean.mp4', outputPath: '/tmp/bridge.mkv', duration: 20, fps: 59.483, container: 'mkv'
  });
  assert.equal(nativeRequest.output.container, 'mkv');
  assert.equal(bridgeRequest.output.container, 'mkv');
});

test('native NVMM lead keeps the source timestamp basis and stops on the requested PTS budget', () => {
  const helper = fs.readFileSync(
    path.join(__dirname, '..', 'assets', 'scene-renderer', 'jetson', 'br2k-scene-gpu.py'),
    'utf8'
  );
  assert.match(helper, /concat name=timeline_lead adjust-base=false/);
  assert.match(helper, /requested_frame_count = max\(1, int\(math\.ceil\(duration \* fps\)\) \+ 1\)/);
  assert.match(helper, /reached_pts_budget = leading_video_frames <= 0 and buffer\.pts >= target_pts/);
  assert.match(helper, /scene_encode_pending = deque\(\)/);
  assert.match(helper, /leading_video_frames or measured_media_seconds <= 0/);
});

test('GPU Scene helper is rejected unless it declares every Scene Graph primitive', () => {
  const insufficient = parseGpuSceneRendererProbe({ protocol: GPU_SCENE_PROTOCOL, backend: 'cuda-gstreamer', capabilities: ['Text'] });
  assert.equal(insufficient.ok, false);
  assert.match(insufficient.reason, /Avatar/);
  const full = parseGpuSceneRendererProbe({
    protocol: GPU_SCENE_PROTOCOL,
    backend: 'cuda-gstreamer',
    version: '0.1.0',
    capabilities: ['Text', 'Avatar', 'Rect', 'Card', 'SuperChat', 'Gift', 'Move', 'Fade', 'Scale'],
    gstreamerElements: JETSON_CUDA_NVMM_REQUIRED_ELEMENTS
  }, 'cuda-gstreamer');
  assert.equal(full.ok, true);
  assert.equal(full.backend, 'cuda-gstreamer');
});
