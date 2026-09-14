const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { spawn } = require('node:child_process');
const ffmpegPath = require('ffmpeg-static');

const {
  SCENE_OBJECT_TYPES,
  SCENE_ANIMATION_TYPES,
  assertSceneGraph,
  buildSceneGraph,
  clipSceneGraph,
  compactSceneCache,
  evaluateSceneObject,
  sceneCacheRecord
} = require('../src/server/danmaku/scene-graph.cjs');
const { compileSceneToAss, createSceneAssTracks } = require('../src/server/danmaku/scene-ass.cjs');
const { createSceneFilterScript, createSceneRenderPlan, evaluateRenderPlan, writeSceneFilterScript } = require('../src/server/danmaku/scene-renderer.cjs');
const { createBurnArgs, createSceneAssRemuxArgs } = require('../src/server/recording/ffmpeg.cjs');
const { LiveRecordService } = require('../src/server/app/service.cjs');
const { probeMediaFileInfo } = require('../src/server/shared/helpers.cjs');

function comparableState(state) {
  return {
    visible: state.visible,
    x: Number(state.x.toFixed(4)),
    y: Number(state.y.toFixed(4)),
    scaleX: Number(state.scaleX.toFixed(4)),
    scaleY: Number(state.scaleY.toFixed(4)),
    opacity: Number(state.opacity.toFixed(4))
  };
}

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (chunk) => {
      stderr = (stderr + chunk.toString('utf8')).slice(-12000);
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error('FFmpeg exited ' + code + ': ' + stderr));
    });
  });
}

test('Scene Graph is the canonical layout for Web, ASS, CUDA and Jetson targets', async () => {
  const events = [
    { type: 'danmaku', time: 0.5, uid: 11, user: '滚动用户', text: '滚动弹幕', color: 0xffffff },
    { type: 'superchat', time: 1, uid: 12, user: '醒目留言', text: 'Scene Graph 统一排版', price: 30, avatarUrl: 'https://example.invalid/a.png' },
    { type: 'gift', time: 2, uid: 13, user: '礼物用户', giftName: '小心心', count: 2, price: 0.1, avatarUrl: 'https://example.invalid/b.png' }
  ];
  const graph = buildSceneGraph(events, {
    stylePreset: 'current',
    overlayMode: 'danmaku-gift',
    videoInfo: { width: 1280, height: 720, fps: 30 }
  });
  assert.equal(assertSceneGraph(graph), true);
  const types = new Set(graph.objects.map((object) => object.type));
  for (const type of SCENE_OBJECT_TYPES) assert.ok(types.has(type), 'missing object type ' + type);
  const animations = new Set(graph.objects.flatMap((object) => object.animations || []).map((animation) => animation.type));
  for (const type of SCENE_ANIMATION_TYPES) assert.ok(animations.has(type), 'missing animation type ' + type);

  const clipped = clipSceneGraph(graph, 0, 8, { shiftTime: false });
  const ass = compileSceneToAss(clipped);
  assert.match(ass.ass, /\[Script Info\]/);
  assert.match(ass.ass, /\[Events\]/);
  assert.match(ass.ass, /\\t\(0,\d+,\\1a&H/);
  assert.match(ass.ass, /\\t\(0,\d+,\\fscx/);
  assert.ok(ass.degradedEffects.includes('avatar-raster'));
  assert.ok(ass.degradedEffects.includes('shadow'));

  const tracks = createSceneAssTracks(events, {
    presets: ['current', 'h5-card', 'bubble', 'minimal'],
    videoInfo: { width: 1280, height: 720 }
  });
  assert.deepEqual(Object.keys(tracks).sort(), ['bubble', 'current', 'h5-card', 'minimal']);
  for (const track of Object.values(tracks)) assert.match(track.ass, /\[Events\]/);

  const targets = ['software', 'cuda', 'jetson'];
  const plans = targets.map((target) => createSceneRenderPlan(clipped, { target, duration: 8 }));
  for (const plan of plans) {
    assert.equal(plan.canvas.width, clipped.canvas.width);
    assert.equal(plan.canvas.height, clipped.canvas.height);
    assert.equal(plan.metadata.directComposition, true);
    for (const object of plan.objects.filter((object) => object.type === 'Text')) {
      const source = clipped.objects.find((candidate) => candidate.id === object.id);
      assert.equal(object.props.fontFamily, source.props.fontFamily);
      assert.equal(object.props.fontSize, source.props.fontSize);
    }
  }
  for (const time of [0.5, 1.1, 2.25, 5]) {
    const canonical = new Map(
      clipped.objects
        .filter((object) => object.render !== false)
        .map((object) => [object.id, comparableState(evaluateSceneObject(object, time))])
    );
    for (const plan of plans) {
      const rendered = new Map(evaluateRenderPlan(plan, time).map((entry) => [entry.id, comparableState(entry.state)]));
      for (const [id, state] of canonical) {
        if (!state.visible) {
          assert.equal(rendered.has(id), false, plan.target + ' should hide ' + id);
        } else {
          assert.deepEqual(rendered.get(id), state, plan.target + ' differs for ' + id + ' at ' + time);
        }
      }
    }
  }

  const filter = createSceneFilterScript(clipped, { duration: 8, fps: 30, target: 'cuda' });
  assert.match(filter.script, /\[vout\]/);
  assert.match(filter.script, /scale=w=/);
  assert.match(filter.script, /boxblur=lr=/);
  assert.doesNotMatch(filter.script, /subtitles|ass=/i);
  assert.equal(filter.plan.metadata.avoidsAssVideoIntermediate, true);
  assert.equal(filter.plan.metadata.avoidsTransparentVideoIntermediate, true);

  const remuxArgs = createSceneAssRemuxArgs({
    cleanPath: 'source.clean.mp4',
    assPath: 'scene.h5-card.ass',
    outputPath: 'scene.h5-card.mkv'
  });
  assert.ok(remuxArgs.includes('-c'));
  assert.equal(remuxArgs[remuxArgs.indexOf('-c') + 1], 'copy');
  assert.ok(remuxArgs.includes('0:v?'));
  assert.ok(remuxArgs.includes('0:a?'));

  const temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'br2k-scene-test-'));
  try {
    const cachePath = path.join(temporaryDirectory, 'source.scene.jsonl');
    const scenePath = path.join(temporaryDirectory, 'source.scene.json');
    await fs.writeFile(
      cachePath,
      events.map((event) => JSON.stringify(sceneCacheRecord(event, { stylePreset: 'h5-card' }))).join('\n') + '\n',
      'utf8'
    );
    const compacted = await compactSceneCache(cachePath, scenePath, {
      stylePreset: 'h5-card',
      videoInfo: { width: 1280, height: 720 },
      durationSec: 8
    });
    assert.equal(compacted.eventCount, events.length);
    assert.ok(compacted.graph.timeline.end <= 8);
    assert.equal(JSON.parse(await fs.readFile(scenePath, 'utf8')).schema, 'bili-record2k.scene/v1');
  } finally {
    await fs.rm(temporaryDirectory, { recursive: true, force: true });
  }
});

test('four Scene ASS tracks retain the original style and remux original audio/video into MKV with stream copy', async () => {
  const temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'br2k-scene-remux-'));
  try {
    const cleanPath = path.join(temporaryDirectory, 'source.clean.mp4');
    const danmakuPath = path.join(temporaryDirectory, 'source.danmaku.jsonl');
    const remuxPath = path.join(temporaryDirectory, 'source.scene.bubble.mkv');
    await run(ffmpegPath, [
      '-hide_banner',
      '-y',
      '-f',
      'lavfi',
      '-i',
      'testsrc2=size=640x360:rate=30',
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=880:sample_rate=48000',
      '-t',
      '2',
      '-c:v',
      'libx264',
      '-pix_fmt',
      'yuv420p',
      '-c:a',
      'aac',
      '-shortest',
      cleanPath
    ]);
    await fs.writeFile(
      danmakuPath,
      JSON.stringify({ type: 'gift', time: 0.4, uid: 7, user: '封装测试', giftName: '小心心', count: 1, price: 1 }) + '\n',
      'utf8'
    );
    const service = new LiveRecordService();
    service.ffmpegPath = ffmpegPath;
    service.ensurePlatformCjkFont = async () => {};
    service.log = () => {};
    const result = await service.generateSceneAssTracks(
      { cleanPath, danmakuPath, durationSec: 2, videoInfo: { width: 640, height: 360, fps: 30 } },
      { stylePreset: 'bubble', remux: true, remuxPath, videoInfo: { width: 640, height: 360, fps: 30 } }
    );
    assert.deepEqual(result.tracks.map((track) => track.preset).sort(), ['bubble', 'current', 'h5-card', 'minimal']);
    for (const track of result.tracks) assert.ok((await fs.stat(track.assPath)).size > 80);
    const media = await probeMediaFileInfo(ffmpegPath, result.remuxPath);
    assert.ok(media.videoInfo, 'remux retains the original video stream');
    assert.ok(media.audioInfo, 'remux retains the original audio stream');
    assert.match(media.videoInfo.codec, /h264/i);
    assert.match(media.audioInfo.codec, /aac/i);
  } finally {
    await fs.rm(temporaryDirectory, { recursive: true, force: true });
  }
});

test('a legacy style request is migrated to one-pass Scene Graph MP4 export', async () => {
  const temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'br2k-scene-export-'));
  try {
    const cleanPath = path.join(temporaryDirectory, 'source.clean.mp4');
    const danmakuPath = path.join(temporaryDirectory, 'source.danmaku.jsonl');
    const outputPath = path.join(temporaryDirectory, 'source.scene.mp4');
    await run(ffmpegPath, [
      '-hide_banner',
      '-y',
      '-f',
      'lavfi',
      '-i',
      'testsrc2=size=640x360:rate=30',
      '-t',
      '2',
      '-c:v',
      'libx264',
      '-pix_fmt',
      'yuv420p',
      cleanPath
    ]);
    await fs.writeFile(
      danmakuPath,
      JSON.stringify({ type: 'superchat', time: 0.3, uid: 8, user: '直出测试', text: '直接烧录', price: 30 }) + '\n',
      'utf8'
    );
    const service = new LiveRecordService();
    service.settings.outputDir = temporaryDirectory;
    service.settings.sceneGraphDefaultStyle = 'bubble';
    service.ffmpegPath = ffmpegPath;
    service.log = () => {};
    service.emitState = () => {};
    service.waitForRuntimeCapabilities = async () => {};
    service.ensurePlatformCjkFont = async () => {};
    service.getHardwareDecoder = () => ({ value: 'software', label: 'CPU', kind: 'software', codec: 'h264' });
    service.generateSubtitleAssets = async () => {
      throw new Error('legacy ASS export must not run for an MP4 Scene Graph burn');
    };
    const result = await service.runExportClipNow({
      mode: 'burn',
      cleanPath,
      danmakuPath,
      startTime: 0,
      endTime: 2,
      stylePreset: 'current',
      codec: 'libx264',
      outputPath
    });
    assert.equal(result.ok, true);
    assert.equal(result.outputPath, outputPath);
    assert.ok((await fs.stat(outputPath)).size > 32 * 1024);
  } finally {
    await fs.rm(temporaryDirectory, { recursive: true, force: true });
  }
});

test('direct Scene Graph filter burns clean video in one FFmpeg pass without ASS video input', async () => {
  const temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'br2k-scene-burn-'));
  try {
    const cleanPath = path.join(temporaryDirectory, 'source.clean.mp4');
    const outputPath = path.join(temporaryDirectory, 'scene.mp4');
    const filterPath = path.join(temporaryDirectory, 'scene.filter');
    const avatarPath = path.join(temporaryDirectory, 'avatar.png');
    await run(ffmpegPath, [
      '-hide_banner',
      '-y',
      '-f',
      'lavfi',
      '-i',
      'testsrc2=size=640x360:rate=30',
      '-t',
      '3',
      '-c:v',
      'libx264',
      '-pix_fmt',
      'yuv420p',
      cleanPath
    ]);
    await run(ffmpegPath, [
      '-hide_banner',
      '-y',
      '-f',
      'lavfi',
      '-i',
      'color=c=red:s=32x32',
      '-frames:v',
      '1',
      avatarPath
    ]);
    const graph = clipSceneGraph(
      buildSceneGraph(
        [
          { type: 'danmaku', time: 0.2, uid: 1, user: 'A', text: 'direct scene' },
          { type: 'gift', time: 1, uid: 2, user: 'B', giftName: '花', count: 1, price: 1 }
        ],
        {
          stylePreset: 'h5-card',
          videoInfo: { width: 640, height: 360 },
          avatarAssets: { 2: { filePath: avatarPath } }
        }
      ),
      0,
      3,
      { shiftTime: false }
    );
    const changingText = graph.objects.find((object) => object.type === 'Text' && String(object.props && object.props.text || '').includes('赠送'));
    assert.ok(changingText, 'gift detail text is represented as a Scene Text node');
    changingText.props.textKeyframes = [
      { time: 1, text: String(changingText.props.text) },
      { time: 1.6, text: '赠送 花 x2' }
    ];
    const layer = await writeSceneFilterScript(filterPath, graph, { duration: 3, fps: 30 });
    assert.ok(layer.script.includes('赠送 花 x2'), 'direct renderer splits Scene text keyframes without a video intermediate');
    assert.match(compileSceneToAss(graph).ass, /赠送 花 x2/, 'ASS keeps the same semantic text update when it can express it');
    const args = createBurnArgs({
      cleanPath,
      assPath: '',
      burnedPath: outputPath,
      codec: 'libx264',
      crf: 28,
      container: 'mp4',
      startTime: 0,
      duration: 3,
      fps: 30,
      avatarOverlay: { filterScriptPath: layer.filterScriptPath },
      inputSeek: true,
      decoder: 'software'
    });
    assert.ok(args.includes('-filter_complex_script'));
    assert.equal(args.includes('-vf'), false);
    await run(ffmpegPath, args);
    assert.ok((await fs.stat(outputPath)).size > 32 * 1024);
  } finally {
    await fs.rm(temporaryDirectory, { recursive: true, force: true });
  }
});
