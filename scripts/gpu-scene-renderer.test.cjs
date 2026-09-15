'use strict';

const assert = require('node:assert/strict');
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
  assert.ok(JETSON_CUDA_NVMM_REQUIRED_ELEMENTS.includes('br2kcudaoverlay'));
  assert.equal(JETSON_CUDA_NVMM_REQUIRED_ELEMENTS.includes('cudacompositor'), false);
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
