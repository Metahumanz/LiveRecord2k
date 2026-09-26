'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { LiveRecordService } = require('../src/server/app/service.cjs');
const { buildSceneGraph, clipSceneGraph, readSceneCacheEvents, sceneCacheRecord } = require('../src/server/danmaku/scene-graph.cjs');
const { createSceneFilterScript } = require('../src/server/danmaku/scene-renderer.cjs');
const { selectDesktopScenePath, planDesktopSceneSegments, filterLayerCount, selectSceneSample, classifyDecodeFailure } = require('../src/server/danmaku/desktop-scene-policy.cjs');
const { canUseDesktopCudaSceneProduction, DESKTOP_CUDA_REPORT_MAX_AGE_MS } = require('../src/server/danmaku/gpu-scene-conformance.cjs');
const { compareSceneTextPixels } = require('../src/server/danmaku/scene-output-verifier.cjs');
const { ffmpegEnvironment } = require('../src/server/recording/fontconfig.cjs');
const { runFfmpegJob, runCapturedProcess } = require('../src/server/shared/helpers.cjs');
const { runDesktopSceneExport } = require('../src/server/danmaku/desktop-scene-export.cjs');

test('NVENC and an unavailable/stale CUDA gate never construct a CUDA desktop scene', () => {
  for (const capability of [null, { available: false }, { available: true, backend: 'cuda-ffmpeg', environmentFingerprint: 'new' }]) {
    for (const preset of ['h5-card', 'bubble', 'minimal', 'current']) {
      const policy = selectDesktopScenePath('hevc_nvenc', preset, capability);
      assert.equal(policy.target, 'software');
      assert.equal(policy.encoder, 'hevc_nvenc');
      assert.equal(policy.segmented, preset === 'current');
      const graph = buildSceneGraph([{ type: 'danmaku', time: 0, text: '验证弹幕' }], { stylePreset: preset, videoInfo: { width: 640, height: 360 } });
      const rendered = createSceneFilterScript(graph, { ...policy, duration: 2, legacyAssPath: preset === 'current' ? '' : 'fixture.ass' });
      assert.doesNotMatch(rendered.script, /hwupload_cuda|overlay_cuda/);
    }
  }
});

test('software composition with NVENC reserves CPU as well as encoder resources', () => {
  const service = new LiveRecordService();
  const desktop = service.getTranscodeResourcePlan('hevc_nvenc', {}, { gpuComposite: true, cpuComposite: true });
  assert.ok(desktop.resources.includes('cpuEncode'));
  assert.ok(desktop.resources.includes('gpuEncode'));
  const jetson = service.getTranscodeResourcePlan('hevc_nvv4l2', {}, { gpuComposite: true });
  assert.equal(jetson.resources.includes('cpuEncode'), false);
});

test('desktop admission rejects old, future and missing environment reports at the final gate', () => {
  const now = Date.now();
  const capability = { available: true, backend: 'cuda-ffmpeg', environmentFingerprint: 'machine' };
  const report = { version: 'ass-compat-v1', backend: 'cuda-ffmpeg', passed: true, executedAt: now,
    environmentFingerprint: 'machine', cases: ['h5-card', 'bubble', 'minimal'].flatMap((preset) => [0, 1.019].map((leadingVideoPaddingSec) => ({
      preset, leadingVideoPaddingSec, passed: true, metrics: { meanAbsRgb: 0, changedRatio: 0 },
      coverage: Object.fromEntries(['danmaku', 'avatar', 'superchat', 'gift', 'roundedCorners', 'shadow', 'move', 'fade'].map((key) => [key, true]))
    }))) };
  assert.equal(canUseDesktopCudaSceneProduction(capability, report, { now }).ok, true);
  for (const changes of [{ executedAt: now - DESKTOP_CUDA_REPORT_MAX_AGE_MS - 1 }, { executedAt: now + 61_000 },
    { executedAt: 0 }, { executedAt: 'invalid' }, { environmentFingerprint: 'old-machine' }]) {
    assert.equal(canUseDesktopCudaSceneProduction(capability, { ...report, ...changes }, { now }).ok, false);
  }
});

test('two hour pressure timeline is bounded by frame-aligned durations and actual filter layers', () => {
  const events = Array.from({ length: 10_000 }, (_, index) => ({ type: 'danmaku', time: index * 0.72, text: '长录像压力测试 ' + index }));
  const graph = buildSceneGraph(events, { stylePreset: 'current', videoInfo: { width: 1280, height: 720 }, durationSec: 7200 });
  const segments = planDesktopSceneSegments(graph, 7200, 59.94);
  assert.ok(segments.length >= 360);
  assert.equal(segments.reduce((sum, segment) => sum + segment.frames, 0), Math.round(7200 * 59.94));
  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i];
    assert.ok(segment.duration <= 20);
    if (i) assert.equal(segment.start, segments[i - 1].end);
    const clipped = clipSceneGraph(graph, segment.start, segment.end, { shiftTime: true });
    assert.ok(filterLayerCount(clipped) <= 128);
    if (i === 0 || i === segments.length - 1) {
      const { script } = createSceneFilterScript(clipped, { duration: segment.duration, fps: 59.94, target: 'software' });
      assert.ok(script.length < 250_000);
      assert.doesNotMatch(script, /:d=7200/);
    }
  }
});

test('unrenderable single-frame density fails before allocating an FFmpeg graph', () => {
  const graph = buildSceneGraph([{ type: 'danmaku', time: 0, text: '资源上限' }], { stylePreset: 'current' });
  graph.objects = Array.from({ length: 129 }, (_, index) => ({ ...graph.objects[0], id: 'dense-' + index, start: 0, end: 1 }));
  assert.throws(() => planDesktopSceneSegments(graph, 1, 30), { code: 'BR2K_SCENE_RESOURCE_LIMIT' });
});

test('empty or out-of-range captured events cannot pass a burn sample gate', () => {
  const graph = buildSceneGraph([{ type: 'danmaku', time: 100, text: '范围外弹幕' }], { stylePreset: 'current' });
  assert.throws(() => selectSceneSample(clipSceneGraph(graph, 0, 30), 30), { code: 'BR2K_SCENE_NO_VISIBLE_TEXT' });
});

test('literal-newline legacy caches recover escaped user text without modifying the source', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'br2k-cache-regression-'));
  try {
    const file = path.join(directory, 'legacy.jsonl');
    const events = [{ type: 'danmaku', time: 0, text: '正文\n换行\\n与反斜杠' }, { type: 'danmaku', time: 1, text: '第二条' }];
    const contents = events.map((event) => JSON.stringify(sceneCacheRecord(event))).join('\\n') + '\\n';
    await fs.writeFile(file, contents);
    assert.deepEqual((await readSceneCacheEvents(file)).map((event) => event.text), events.map((event) => event.text));
    assert.equal(await fs.readFile(file, 'utf8'), contents);
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});

test('chunk clipping retains carried text and shifts text keyframes into the chunk clock', () => {
  const graph = buildSceneGraph([{ type: 'danmaku', time: 0, text: '初始' }], { stylePreset: 'current' });
  const text = graph.objects.find((object) => object.type === 'Text');
  text.start = 0; text.end = 30;
  text.props.textKeyframes = [{ time: 3, text: '前段更新' }, { time: 11, text: '后段更新' }];
  const clipped = clipSceneGraph(graph, 10, 20, { shiftTime: true }).objects.find((object) => object.type === 'Text');
  assert.equal(clipped.props.text, '前段更新');
  assert.deepEqual(clipped.props.textKeyframes, [{ time: 1, text: '后段更新' }]);
});

test('late hardware decode failure and CUDA/filter OOM never restart the whole file', async () => {
  const service = new LiveRecordService(); service.ffmpegPath = process.execPath; service.log = () => {};
  for (const [stderr, expectedKind, seconds] of [
    ['out_time_us=600000000\ncuvid decoder failed: unsupported surface\n', 'decode-compatibility', 600],
    ['CUDA_ERROR_OUT_OF_MEMORY: out of memory\n', 'gpu-memory', 0],
    ['Error parsing filter_complex_script: Cannot allocate memory\n', 'filter-resources', 0]
  ]) {
    let attempts = 0;
    await assert.rejects(service.runFfmpegWithHardwareDecodeFallback({ decoder: 'cuda', createArgs: () => {
      attempts++; return ['-e', `process.stderr.write(${JSON.stringify(stderr)}); process.exit(1)`];
    }}), (error) => error.failureKind === expectedKind && error.processedMediaSeconds === seconds);
    assert.equal(attempts, 1);
  }
  assert.equal(classifyDecodeFailure(new Error('hevc Error parsing NAL unit')), 'other');
});

test('only a decoder compatibility error within the startup window retries CPU once', async () => {
  const service = new LiveRecordService(); service.ffmpegPath = process.execPath; service.log = () => {};
  const attempts = [];
  const result = await service.runFfmpegWithHardwareDecodeFallback({ decoder: 'cuda', createArgs: (decoder) => {
    attempts.push(decoder);
    return decoder === 'software' ? ['-e', 'process.exit(0)'] : ['-e', "process.stderr.write('cuvid decoder failed: unsupported surface'); process.exit(1)"];
  }});
  assert.equal(result, 'software'); assert.deepEqual(attempts, ['cuda', 'software']);
});

test('the sole CPU retry retains late progress and resource failure diagnostics', async () => {
  const service = new LiveRecordService(); service.ffmpegPath = process.execPath; service.log = () => {};
  let attempts = 0;
  await assert.rejects(service.runFfmpegWithHardwareDecodeFallback({ decoder: 'cuda', createArgs: (decoder) => {
    attempts++;
    const stderr = decoder === 'software' ? 'out_time_us=600000000\nError in filter_complex: Cannot allocate memory\n'
      : 'cuvid decoder failed: unsupported surface\n';
    return ['-e', `process.stderr.write(${JSON.stringify(stderr)}); process.exit(1)`];
  }}), (error) => error.processedMediaSeconds === 600 && error.failureKind === 'filter-resources');
  assert.equal(attempts, 2);
});

test('a completed clean video cannot pass glyph acceptance even if it is a valid MP4', () => {
  const graph = { canvas: { width: 64, height: 32 }, objects: [{ type: 'Text', start: 0, end: 10,
    frame: { x: 1, y: 1, width: 62, height: 30 } }] };
  const clean = Buffer.alloc(64 * 32 * 3, 20);
  const reference = Buffer.from(clean);
  for (let y = 5; y < 25; y++) for (let x = 5; x < 55; x += 3) reference.fill(240, (y * 64 + x) * 3, (y * 64 + x + 1) * 3);
  assert.equal(compareSceneTextPixels(clean, reference, clean, graph, 1, true).ok, false);
  assert.equal(compareSceneTextPixels(reference, reference, clean, graph, 1, true).ok, true);
});

test('real valid videos with missing overlays fail preflight or final acceptance and retain diagnostics', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'br2k-empty-burn-regression-'));
  const ffmpeg = require('ffmpeg-static');
  const service = new LiveRecordService(); service.log = () => {};
  const videoInfo = { width: 640, height: 360, fps: 30 };
  const events = [{ type: 'danmaku', time: 0, text: '中文弹幕必须存在' }];
  const sceneOptions = { stylePreset: 'minimal', overlayMode: 'danmaku', videoInfo };
  const graph = clipSceneGraph(buildSceneGraph(events, sceneOptions), 0, 2, { shiftTime: true });
  const input = path.join(directory, 'input.mp4');
  try {
    await runFfmpegJob(ffmpeg, ['-hide_banner', '-y', '-f', 'lavfi', '-i', 'color=0x203040:s=640x360:r=30:d=2', '-c:v', 'libx264', input]);
    for (const corruptStage of ['preflight', 'formal']) {
      const folder = path.join(directory, corruptStage); await fs.mkdir(folder);
      const stages = [];
      let formalRuns = 0;
      const output = path.join(folder, 'result.mp4');
      await assert.rejects(runDesktopSceneExport({ graph, events, cleanPath: input, outputPath: output,
        duration: 2, fps: 30, codec: 'libx264', crf: 23, container: 'mp4', directory: folder,
        policy: selectDesktopScenePath('libx264', 'minimal', null), decoder: { value: 'software', codec: 'h264' },
        includeAudio: false, sceneOptions, ffmpegPath: ffmpeg,
        writeLegacyAss: service.writeLegacySceneCompatibilityAss.bind(service),
        runJob: (args, stderr, options) => runFfmpegJob(ffmpeg, args, stderr, options),
        runFallback: async (job) => {
          const args = job.createArgs('software');
          const filterIndex = args.indexOf('-filter_complex_script') + 1;
          const script = args[filterIndex];
          if (script.endsWith('formal.filter')) formalRuns++;
          if (script.endsWith(`${corruptStage}.filter`)) {
            // Replace only the candidate's filter, preserving a valid encoder
            // and container. The oracle is independently generated intact.
            const blank = path.join(folder, 'missing-overlay.filter');
            await fs.writeFile(blank, '[0:v]null[vout]\n');
            args[filterIndex] = blank;
          }
          await runFfmpegJob(ffmpeg, args, job.onStderr, { onChild: job.onChild });
          return 'software';
        }, onStage: (stage) => stages.push(stage)
      }), (error) => error.code === 'BR2K_SCENE_TEXT_VERIFICATION_FAILED' && error.diagnosticDirectory === folder);
      assert.ok((await fs.stat(path.join(folder, 'failure.json'))).size > 0);
      assert.equal(formalRuns, corruptStage === 'preflight' ? 0 : 1);
    }
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});

test('automatic long recordings stay out of the queue with all capture inputs preserved', async (t) => {
  if (process.platform !== 'win32') return t.skip('Windows 长录像暂停策略');
  const service = new LiveRecordService(); service.log = () => {};
  const room = { id: 'pause-regression', title: '暂停自动长片' }; service.rooms.set(room.id, room);
  const recording = { cleanPath: 'C:\\capture\\original.mp4', danmakuPath: 'C:\\capture\\events.jsonl',
    sceneCachePath: 'C:\\capture\\scene.jsonl', durationSec: 7200 };
  const original = { ...recording };
  assert.equal(await service.enqueueBurnRecording(room, recording, { automatic: true }), null);
  assert.equal(service.burnQueue.length, 0);
  assert.deepEqual(recording, original);
});

test('segmented output keeps the source video clock when the first video frame follows audio by one second', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'br2k-desktop-pts-regression-'));
  const ffmpeg = require('ffmpeg-static');
  const service = new LiveRecordService(); service.ffmpegPath = ffmpeg; service.log = () => {};
  const input = path.join(directory, 'delayed-video.mp4');
  const output = path.join(directory, 'result.mp4');
  const videoInfo = { width: 320, height: 180, fps: 30 };
  const events = [{ type: 'danmaku', time: 1, text: '首段时钟' }, { type: 'danmaku', time: 20, text: '跨段时钟' }];
  const sceneOptions = { stylePreset: 'current', overlayMode: 'danmaku', videoInfo };
  try {
    await runFfmpegJob(ffmpeg, ['-hide_banner', '-y', '-f', 'lavfi', '-i', 'testsrc2=s=320x180:r=30:d=25',
      '-f', 'lavfi', '-i', 'sine=d=26', '-vf', 'setpts=PTS+1/TB', '-fps_mode', 'passthrough',
      '-c:v', 'libx264', '-bf', '0', '-c:a', 'aac', input]);
    const graph = clipSceneGraph(buildSceneGraph(events, sceneOptions), 0, 24, { shiftTime: true });
    const jobOptions = { graph, events, cleanPath: input, outputPath: output,
      duration: 24, fps: 30, codec: 'libx264', crf: 18, container: 'mp4', directory,
      policy: selectDesktopScenePath('libx264', 'current', null), decoder: { value: 'software', codec: 'h264' },
      includeAudio: true, sceneOptions, ffmpegPath: ffmpeg,
      writeLegacyAss: service.writeLegacySceneCompatibilityAss.bind(service),
      runJob: (args, stderr, options) => runFfmpegJob(ffmpeg, args, stderr, options),
      runFallback: service.runFfmpegWithHardwareDecodeFallback.bind(service)
    };
    const report = await runDesktopSceneExport(jobOptions);
    assert.ok(report.leadingVideoPaddingSec > 0.9);
    assert.equal(report.segmentCount, 2);
    for (const at of [2, 20.5]) {
      const images = [];
      for (const [name, file] of [['source', input], ['output', output]]) {
        const raw = path.join(directory, `${name}-${at}.rgb`);
        await runFfmpegJob(ffmpeg, ['-hide_banner', '-y', '-ss', String(at), '-i', file, '-vf', 'crop=320:90:0:90',
          '-frames:v', '1', '-pix_fmt', 'rgb24', '-f', 'rawvideo', raw]);
        images.push(await fs.readFile(raw));
      }
      assert.equal(images[0].length, images[1].length);
      let error = 0;
      for (let i = 0; i < images[0].length; i++) error += Math.abs(images[0][i] - images[1][i]);
      assert.ok(error / images[0].length < 10, `源时间 ${at}s 成片画面漂移：${error / images[0].length}`);
    }
    const failedDirectory = path.join(directory, 'late-failure'); await fs.mkdir(failedDirectory);
    await assert.rejects(runDesktopSceneExport({ ...jobOptions, directory: failedDirectory,
      outputPath: path.join(failedDirectory, 'result.mp4'), runFallback: async (job) => {
        const args = job.createArgs('software');
        if (args.some((arg) => String(arg).endsWith('chunk-1.filter'))) {
          const error = new Error('滤镜资源耗尽');
          error.processedMediaSeconds = 2; error.failureKind = 'filter-resources';
          throw error;
        }
        return service.runFfmpegWithHardwareDecodeFallback(job);
      }
    }), (error) => error.completedMediaSeconds === 22 && error.processedMediaSeconds === 2);
    const failure = JSON.parse(await fs.readFile(path.join(failedDirectory, 'failure.json'), 'utf8'));
    assert.equal(failure.completedMediaSeconds, 22);
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});

test('Windows bundled FFmpeg resolves Chinese text and symbol fallback with a usable Fontconfig config', async (t) => {
  if (process.platform !== 'win32') return t.skip('Windows 字体配置回归');
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'br2k-fontconfig-regression-'));
  try {
    const env = ffmpegEnvironment({ ...process.env, FONTCONFIG_FILE: '' });
    const config = await fs.readFile(env.FONTCONFIG_FILE, 'utf8');
    assert.match(config, /Windows\/Fonts|WINDOWS\/Fonts/);
    assert.match(config, /Segoe UI Symbol/);
    const target = path.join(directory, 'glyphs.rgb');
    const result = await runCapturedProcess(require('ffmpeg-static'), ['-hide_banner', '-loglevel', 'verbose', '-y', '-f', 'lavfi',
      '-i', "color=black:s=640x128:r=30,drawtext=font='Microsoft YaHei':text='中文字体测试 ♡':fontsize=36:fontcolor=white", '-frames:v', '1', '-pix_fmt', 'rgb24', '-f', 'rawvideo', target], { env });
    assert.equal(result.status, 0, result.stderr);
    assert.doesNotMatch(result.stderr, /Cannot load default config|No such file.*font/i);
    const bytes = await fs.readFile(target);
    assert.ok(bytes.filter((value) => value > 100).length > 1000);
    const assFile = path.join(directory, 'fallback.ass');
    await fs.writeFile(assFile, '[Script Info]\nScriptType: v4.00+\nPlayResX: 640\nPlayResY: 128\n' +
      '[V4+ Styles]\nFormat: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\n' +
      'Style: Default,Segoe UI Symbol,36,&H00FFFFFF,&H00FFFFFF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,0,0,7,10,10,10,1\n' +
      '[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n' +
      'Dialogue: 0,0:00:00.00,0:00:02.00,Default,,0,0,0,,中文缺字回退 ♡\n');
    const assFilter = assFile.replace(/\\/g, '/').replace(/:/g, '\\:');
    const fallback = await runCapturedProcess(require('ffmpeg-static'), ['-hide_banner', '-loglevel', 'verbose', '-y',
      '-f', 'lavfi', '-i', 'color=black:s=640x128:r=30:d=2', '-vf', `ass=filename='${assFilter}'`,
      '-frames:v', '1', '-pix_fmt', 'rgb24', '-f', 'rawvideo', target], { env });
    assert.equal(fallback.status, 0, fallback.stderr);
    assert.doesNotMatch(fallback.stderr, /Cannot load default config|failed to find any fallback/i);
    assert.match(fallback.stderr, /Glyph 0x4E2D not found, selecting one more font/i);
    assert.ok((await fs.readFile(target)).filter((value) => value > 100).length > 1000);
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});

test('direct scrolling glyphs match the canonical texture path through motion and fade', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'br2k-direct-text-regression-'));
  const ffmpeg = require('ffmpeg-static');
  const graph = buildSceneGraph([
    { type: 'danmaku', time: 0.3, text: '中文弹幕 ABC ♡' },
    { type: 'danmaku', time: 0.8, text: '移动测试 123' }
  ], { stylePreset: 'current', videoInfo: { width: 1280, height: 720 }, durationSec: 5 });
  const text = graph.objects.find((object) => object.type === 'Text');
  text.animations.push({ type: 'Fade', start: 0.3, end: 1.3, from: 0, to: 1 });
  try {
    const scripts = [];
    for (const directText of [false, true]) {
      const rendered = createSceneFilterScript(graph, { target: 'software', duration: 5, fps: 30, directText });
      if (directText) assert.doesNotMatch(rendered.script, /scene_text_image_/);
      const file = path.join(directory, `${directText}.filter`);
      await fs.writeFile(file, rendered.script);
      scripts.push(file);
    }
    for (const at of [1, 1.6, 2.2]) {
      const images = [];
      for (let index = 0; index < scripts.length; index++) {
        const raw = path.join(directory, `${index}-${at}.rgb`);
        await runFfmpegJob(ffmpeg, ['-hide_banner', '-y', '-f', 'lavfi', '-i', 'color=0x203040:s=1280x720:r=30:d=5',
          '-filter_complex_script', scripts[index], '-map', '[vout]', '-filter_complex_threads', '1',
          '-ss', String(at), '-frames:v', '1', '-pix_fmt', 'rgb24', '-f', 'rawvideo', raw]);
        images.push(await fs.readFile(raw));
      }
      assert.equal(images[0].length, images[1].length);
      let difference = 0; let changed = 0;
      for (let i = 0; i < images[0].length; i++) {
        const delta = Math.abs(images[0][i] - images[1][i]);
        difference += delta;
        if (delta > 24) changed++;
      }
      assert.ok(difference / images[0].length < 2 && changed / images[0].length < 0.02,
        `文字优化在 ${at}s 偏离原渲染：mean=${difference / images[0].length}, changed=${changed / images[0].length}`);
      assert.ok(images[1].some((value) => value > 90), `在 ${at}s 应存在可见字形`);
      const clean = Buffer.alloc(images[0].length);
      for (let i = 0; i < clean.length; i += 3) {
        clean[i] = 32; clean[i + 1] = 48; clean[i + 2] = 64;
      }
      if (at >= 1.6) assert.equal(compareSceneTextPixels(images[1], images[0], clean, graph, at, true).ok, true);
    }
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});

test('legacy CUDA ASS textures retain visible glyph alpha instead of disappearing', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'br2k-ass-alpha-regression-'));
  const ffmpeg = require('ffmpeg-static');
  const service = new LiveRecordService(); service.log = () => {};
  const events = [{ type: 'danmaku', time: 0, text: '中文弹幕 Alpha' }];
  const sceneOptions = { stylePreset: 'minimal', videoInfo: { width: 640, height: 360 } };
  const graph = buildSceneGraph(events, sceneOptions);
  try {
    const ass = await service.writeLegacySceneCompatibilityAss(path.join(directory, 'text.ass'), events, sceneOptions);
    const script = createSceneFilterScript(graph, { target: 'cuda', legacyAssPath: ass, duration: 3, fps: 30 }).script;
    assert.match(script, /:alpha=1,format=yuva420p,hwupload_cuda/);
    const assFilter = ass.replace(/\\/g, '/').replace(/:/g, '\\:');
    const alphas = [];
    for (const alpha of [0, 1]) {
      const raw = path.join(directory, `${alpha}.rgba`);
      await runFfmpegJob(ffmpeg, ['-hide_banner', '-y', '-f', 'lavfi', '-i', 'color=black@0.0:s=640x360:r=30:d=3,format=rgba',
        '-vf', `format=rgba,ass=filename='${assFilter}':alpha=${alpha}`, '-ss', '2', '-frames:v', '1', '-pix_fmt', 'rgba', '-f', 'rawvideo', raw]);
      const bytes = await fs.readFile(raw);
      let visible = 0;
      for (let i = 3; i < bytes.length; i += 4) if (bytes[i] > 100) visible++;
      alphas.push(visible);
    }
    assert.equal(alphas[0], 0, '默认 ASS 不写透明底的字形 alpha，CUDA 合成会完全不可见');
    assert.ok(alphas[1] > 100, '修复后必须存在可见字形 alpha');
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});
