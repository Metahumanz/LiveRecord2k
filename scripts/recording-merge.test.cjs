const assert = require('node:assert/strict');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const ffmpegPath = require('ffmpeg-static');

const { LiveRecordService, isFfmpegMemoryPressureError } = require('../src/server/app/service.cjs');
const { createAss } = require('../src/server/danmaku/ass.cjs');
const {
  createBurnArgs,
  createAvatarOverlayFilterScript,
  createConcatCopyArgs,
  createNormalizeSegmentArgs,
  createConcatTranscodeArgs,
  selectHighestResolutionVideoInfo,
  shouldTranscodeConcat,
  assertSafeMergeTargetProfile
} = require('../src/server/recording/ffmpeg.cjs');
const {
  parseFfmpegAudioInfo,
  parseFfmpegVideoInfo,
  probeMediaFileInfo,
  probeMediaTimelineInfo,
  runCapturedProcess
} = require('../src/server/shared/helpers.cjs');

test('a lower quality stream remains usable while the requested quality is unavailable', async () => {
  const service = new LiveRecordService();
  service.settings.targetQn = 15000;
  service.log = () => {};
  let playInfoCalls = 0;
  service.fetchBiliJson = async () => ({
    code: 0,
    data: {
      playurl_info: {
        playurl: {
          stream: [
            {
              protocol_name: 'http_stream',
              format: [
                {
                  format_name: 'flv',
                  codec: [
                    {
                      codec_name: 'avc',
                      current_qn: 10000,
                      accept_qn: [10000, 400],
                      base_url: '/live.flv',
                      url_info: [{ host: 'https://example.test', extra: '?token=test' }]
                    }
                  ]
                }
              ]
            }
          ]
        }
      }
    }
  });
  const fetchPlayInfo = service.fetchBiliJson;
  service.fetchBiliJson = async (...args) => {
    playInfoCalls += 1;
    return fetchPlayInfo(...args);
  };

  const room = { id: '123', realRoomId: '123', title: 'test', anchor: 'anchor' };
  const stream = await service.resolvePlayStream(room);

  assert.equal(stream.qn, 10000);
  assert.equal(playInfoCalls, 1);
  assert.match(room.qualityWarning, /实际选中 10000/);
});

test('merge memory-pressure detection covers Linux signals and Windows allocation failures', () => {
  assert.equal(isFfmpegMemoryPressureError({ ffmpegSignal: 'SIGKILL' }), true);
  assert.equal(isFfmpegMemoryPressureError({ ffmpegExitCode: -1073741801 }), true);
  assert.equal(isFfmpegMemoryPressureError({ ffmpegStderr: 'Cannot allocate memory while opening encoder' }), true);
  assert.equal(isFfmpegMemoryPressureError({ message: 'Unknown encoder h264_not_real' }), false);
});

test('mixed segment specifications select the highest resolution and require transcoding', () => {
  const mediaInfos = [
    {
      videoInfo: { codec: 'h264 (High)', width: 1920, height: 1080, fps: 30 },
      audioInfo: { codec: 'aac (LC)', sampleRate: 48000, channelLayout: 'stereo' }
    },
    {
      videoInfo: { codec: 'hevc (Main)', width: 3840, height: 2160, fps: 60 },
      audioInfo: { codec: 'aac (LC)', sampleRate: 48000, channelLayout: 'stereo' }
    }
  ];

  assert.deepEqual(selectHighestResolutionVideoInfo(mediaInfos), {
    codec: 'hevc (Main)',
    width: 3840,
    height: 2160,
    fps: 60
  });
  assert.equal(shouldTranscodeConcat(mediaInfos), true);
  assert.equal(shouldTranscodeConcat([mediaInfos[0], structuredClone(mediaInfos[0])]), false);

  const args = createConcatTranscodeArgs({
    segments: [
      { filePath: 'first.mp4', durationSec: 1, hasAudio: true },
      { filePath: 'second.mp4', durationSec: 1, hasAudio: false }
    ],
    outputPath: 'merged.mp4',
    container: 'mp4',
    targetVideoInfo: mediaInfos[1].videoInfo,
    videoCodec: 'libx265'
  });
  const filter = args[args.indexOf('-filter_complex') + 1];
  assert.match(filter, /scale=w=3840:h=2160/);
  assert.match(filter, /aresample=48000:async=1:first_pts=0,apad,atrim=duration=1/);
  assert.match(filter, /anullsrc=r=48000:cl=stereo/);
  assert.match(filter, /concat=n=2:v=1:a=1/);
  assert.ok(args.includes('hvc1'));

  const normalizeArgs = createNormalizeSegmentArgs({
    inputPath: 'first.mp4',
    outputPath: 'first.normalized.mkv',
    container: 'mkv',
    durationSec: 1,
    hasAudio: false,
    targetVideoInfo: mediaInfos[1].videoInfo,
    videoCodec: 'libx265'
  });
  const normalizeFilter = normalizeArgs[normalizeArgs.indexOf('-filter_complex') + 1];
  assert.equal(normalizeArgs.filter((arg) => arg === '-i').length, 1);
  assert.match(normalizeFilter, /scale=w=3840:h=2160/);
  assert.match(normalizeFilter, /anullsrc=r=48000:cl=stereo/);
  assert.doesNotMatch(normalizeFilter, /concat=n=/);
  assert.equal(normalizeArgs[normalizeArgs.indexOf('-filter_threads') + 1], '1');

  const copyArgs = createConcatCopyArgs({
    concatPath: 'normalized.concat.txt',
    outputPath: 'merged.mp4',
    container: 'mp4',
    streamCodec: 'hevc (Main)'
  });
  assert.ok(copyArgs.includes('hvc1'));

  const realProfileTarget = selectHighestResolutionVideoInfo([
    { videoInfo: { codec: 'h264 (High)', width: 3840, height: 2160, fps: 30, pixelFormat: 'yuv420p10le', bitDepth: 10 } },
    { videoInfo: { codec: 'h264 (High)', width: 1920, height: 1080, fps: 60, pixelFormat: 'yuv420p', bitDepth: 8 } }
  ]);
  assert.equal(realProfileTarget.fps, 30);
  assert.equal(realProfileTarget.pixelFormat, 'yuv420p10le');
  assert.equal(realProfileTarget.bitDepth, 10);
  assert.equal(
    shouldTranscodeConcat([
      { videoInfo: { codec: 'hevc', width: 1920, height: 1080, fps: 30, pixelFormat: 'yuv420p10le', bitDepth: 10 } },
      { videoInfo: { codec: 'hevc', width: 1920, height: 1080, fps: 30, pixelFormat: 'yuv420p', bitDepth: 8 } }
    ]),
    true
  );
});

test('safe merge profiles refuse silent HDR, bit-depth, and chroma degradation', () => {
  const hdr = { codec: 'hevc', width: 1920, height: 1080, fps: 30, pixelFormat: 'yuv420p10le', bitDepth: 10, hdr: true, colorTransfer: 'smpte2084' };
  assert.equal(assertSafeMergeTargetProfile([{ videoInfo: hdr }, { videoInfo: { ...hdr } }], hdr), true);
  assert.throws(
    () => assertSafeMergeTargetProfile([{ videoInfo: hdr }, { videoInfo: { ...hdr, hdr: false, colorTransfer: 'bt709' } }], hdr),
    /HDR 与 SDR/
  );
  const eightBitTarget = { codec: 'hevc', width: 3840, height: 2160, fps: 30, pixelFormat: 'yuv420p', bitDepth: 8, hdr: false };
  assert.throws(
    () => assertSafeMergeTargetProfile([{ videoInfo: eightBitTarget }, { videoInfo: { ...eightBitTarget, width: 1920, height: 1080, pixelFormat: 'yuv422p10le', bitDepth: 10 } }], eightBitTarget),
    /拒绝静默降质/
  );
  assert.throws(
    () => assertSafeMergeTargetProfile([{ videoInfo: hdr }, { videoInfo: { ...hdr } }], hdr, { requiresVideoTranscode: true }),
    /mastering metadata/
  );
});

test('ffmpeg audio probing reads the stream properties used by merge compatibility checks', () => {
  const audioInfo = parseFfmpegAudioInfo(
    'Stream #0:1: Audio: aac (LC), 48000 Hz, stereo, fltp, 160 kb/s'
  );
  assert.deepEqual(audioInfo, { codec: 'aac (LC)', sampleRate: 48000, channelLayout: 'stereo' });
});

test('timeline audit detects A/V drift before a segment is copied into a merge', async () => {
  const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'br2k-timeline-audit-'));
  const filePath = path.join(tempDir, 'drifted.mp4');
  try {
    const generated = await runCapturedProcess(
      ffmpegPath,
      [
        '-hide_banner',
        '-loglevel',
        'error',
        '-y',
        '-f',
        'lavfi',
        '-i',
        'testsrc2=size=320x180:rate=30:duration=1',
        '-f',
        'lavfi',
        '-i',
        'sine=frequency=440:sample_rate=48000:duration=0.55',
        '-c:v',
        'libx264',
        '-pix_fmt',
        'yuv420p',
        '-c:a',
        'aac',
        filePath
      ],
      { timeoutMs: 20_000 }
    );
    assert.equal(generated.status, 0, generated.stderr);
    const mediaInfo = await probeMediaFileInfo(ffmpegPath, filePath);
    const timing = await probeMediaTimelineInfo(ffmpegPath, filePath, mediaInfo);

    assert.ok(timing.videoDurationSec >= 0.85, JSON.stringify(timing));
    assert.ok(timing.audioDurationSec < 0.7, JSON.stringify(timing));
    assert.ok(timing.avDeltaSec < -0.25, JSON.stringify(timing));
    assert.equal(timing.timingSafeForCopy, false);
  } finally {
    await fsp.rm(tempDir, { recursive: true, force: true });
  }
});

test('video probing retains the 10-bit HDR profile used by safe merge selection', () => {
  const videoInfo = parseFfmpegVideoInfo(
    'Stream #0:0: Video: hevc (Main 10), p010le(tv, bt2020nc/bt2020/smpte2084), 3840x2160, 60 fps'
  );
  assert.equal(videoInfo.profile, 'Main 10');
  assert.equal(videoInfo.pixelFormat, 'p010le');
  assert.equal(videoInfo.bitDepth, 10);
  assert.equal(videoInfo.colorSpace, 'bt2020nc');
  assert.equal(videoInfo.colorPrimaries, 'bt2020');
  assert.equal(videoInfo.colorTransfer, 'smpte2084');
  assert.equal(videoInfo.hdr, true);
});

test('a 900ms merged A/V gap is repaired and the verified output is kept', async () => {
  const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'br2k-900ms-merge-'));
  const firstPath = path.join(tempDir, 'first.clean.mp4');
  const secondPath = path.join(tempDir, 'second.clean.mp4');
  const outputPath = path.join(tempDir, 'session.merged.mp4');
  const generate = async (output, audioDuration) => {
    const result = await runCapturedProcess(
      ffmpegPath,
      [
        '-hide_banner', '-loglevel', 'error', '-y',
        '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=30:duration=1',
        '-f', 'lavfi', '-i', `sine=frequency=440:sample_rate=48000:duration=${audioDuration}`,
        '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', output
      ],
      { timeoutMs: 20_000 }
    );
    assert.equal(result.status, 0, result.stderr);
  };

  try {
    await generate(firstPath, 1);
    await generate(secondPath, 0.1);
    const service = new LiveRecordService();
    service.log = () => {};
    service.emitState = () => {};
    service.saveStore = async () => {};
    service.writeRecordingMetadata = async () => {};
    service.cleanupMergedSegmentFiles = async () => {};
    service.getMergeEncoderPlan = () => ({ preferred: 'libx264', fallback: '' });
    const room = { id: '900', title: 'drift', anchor: 'test', recording: false };
    const segments = [firstPath, secondPath].map((cleanPath, index) => ({
      id: `segment-${index}`,
      roomId: room.id,
      startedAt: Date.now() + index * 1000,
      cleanPath,
      danmakuPath: path.join(tempDir, `segment-${index}.jsonl`),
      cssPath: '',
      mergeGroup: 'drift-group',
      mergeSequence: index + 1,
      mergeOutputPath: outputPath,
      durationSec: 1,
      valid: true,
      eventCount: 0
    }));
    service.recordings = segments;
    const merged = await service.mergeReconnectGroupIfNeeded(room, 'drift-group', segments[1]);

    assert.equal(merged.cleanPath, outputPath);
    assert.equal(await fsp.stat(outputPath).then((stat) => stat.isFile()), true);
    assert.equal(await fsp.stat(firstPath).then((stat) => stat.isFile()), true);
    assert.equal(await fsp.stat(secondPath).then((stat) => stat.isFile()), true);
    const mediaInfo = await probeMediaFileInfo(ffmpegPath, outputPath);
    const timing = await probeMediaTimelineInfo(ffmpegPath, outputPath, mediaInfo);
    assert.equal(timing.timingSafeForCopy, true, JSON.stringify(timing));
    assert.ok(Math.abs(timing.avDeltaSec) <= 0.08, JSON.stringify(timing));
  } finally {
    await fsp.rm(tempDir, { recursive: true, force: true });
  }
});

test('eleven mixed reconnect segments are normalized sequentially before the final copy concat', async () => {
  const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'br2k-bounded-merge-'));
  const sourcePaths = Array.from({ length: 11 }, (_unused, index) =>
    path.join(tempDir, `segment-${String(index + 1).padStart(2, '0')}.clean.mp4`)
  );
  const outputPath = path.join(tempDir, 'session.merged.mp4');
  const generate = async (output, size, rate, tone) => {
    const result = await runCapturedProcess(
      ffmpegPath,
      [
        '-hide_banner', '-loglevel', 'error', '-y',
        '-f', 'lavfi', '-i', `testsrc2=size=${size}:rate=${rate}:duration=0.5`,
        '-f', 'lavfi', '-i', `sine=frequency=${tone}:sample_rate=48000:duration=0.5`,
        '-shortest', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', output
      ],
      { timeoutMs: 20_000 }
    );
    assert.equal(result.status, 0, result.stderr);
  };

  try {
    for (let index = 0; index < sourcePaths.length; index += 1) {
      await generate(sourcePaths[index], index % 3 === 1 ? '640x360' : '320x180', index % 3 === 1 ? 30 : 24, 440 + index * 40);
    }
    const service = new LiveRecordService();
    const logs = [];
    service.log = (_level, message) => logs.push(message);
    service.emitState = () => {};
    service.saveStore = async () => {};
    service.writeRecordingMetadata = async () => {};
    service.cleanupMergedSegmentFiles = async () => {};
    service.getMergeEncoderPlan = () => ({ preferred: 'libx264', fallback: '' });
    const room = { id: 'bounded', title: 'bounded', anchor: 'test', recording: false };
    const segments = sourcePaths.map((cleanPath, index) => ({
      id: `segment-${index}`,
      roomId: room.id,
      startedAt: Date.now() + index * 1000,
      cleanPath,
      danmakuPath: path.join(tempDir, `segment-${index}.danmaku.jsonl`),
      cssPath: '',
      mergeGroup: 'bounded-group',
      mergeSequence: index + 1,
      mergeOutputPath: outputPath,
      durationSec: 0.5,
      valid: true,
      eventCount: 0
    }));
    service.recordings = segments;

    const merged = await service.mergeReconnectGroupIfNeeded(room, 'bounded-group', segments.at(-1));

    assert.equal(merged.cleanPath, outputPath);
    const mergedInfo = await probeMediaFileInfo(ffmpegPath, outputPath);
    assert.equal(mergedInfo.videoInfo.width, 640);
    assert.equal(mergedInfo.videoInfo.height, 360);
    assert.ok(mergedInfo.durationSec >= 5.2, `expected all eleven segments, got ${mergedInfo.durationSec}s`);
    const timing = await probeMediaTimelineInfo(ffmpegPath, outputPath, mergedInfo);
    assert.equal(timing.timingSafeForCopy, true, JSON.stringify(timing));
    assert.ok(logs.some((message) => /逐段重建时间轴/.test(message)));
    const leftovers = (await fsp.readdir(tempDir)).filter((name) => name.startsWith('.br2k-merge-'));
    assert.deepEqual(leftovers, []);
  } finally {
    await fsp.rm(tempDir, { recursive: true, force: true });
  }
});

test('burn filter waits for the first decodable keyframe and still produces valid A/V output', async () => {
  const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'br2k-safe-burn-'));
  const inputPath = path.join(tempDir, 'input.mp4');
  const assPath = path.join(tempDir, 'overlay.ass');
  const outputPath = path.join(tempDir, 'output.mp4');
  try {
    const generated = await runCapturedProcess(
      ffmpegPath,
      [
        '-hide_banner',
        '-loglevel',
        'error',
        '-y',
        '-f',
        'lavfi',
        '-i',
        'testsrc2=size=320x180:rate=30:duration=0.8',
        '-f',
        'lavfi',
        '-i',
        'sine=frequency=660:sample_rate=48000:duration=0.8',
        '-c:v',
        'libx264',
        '-pix_fmt',
        'yuv420p',
        '-c:a',
        'aac',
        inputPath
      ],
      { timeoutMs: 20_000 }
    );
    assert.equal(generated.status, 0, generated.stderr);
    await fsp.writeFile(assPath, createAss([{ type: 'danmaku', time: 0.1, text: 'test' }]), 'utf8');
    const args = createBurnArgs({
      cleanPath: inputPath,
      assPath,
      burnedPath: outputPath,
      codec: 'libx264',
      crf: 24,
      container: 'mp4',
      fps: 30
    });
    const filter = args[args.indexOf('-vf') + 1];
    assert.match(filter, /select='if\(isnan\(prev_selected_t\)\\,key\\,1\)'/);
    const burned = await runCapturedProcess(ffmpegPath, args, { timeoutMs: 20_000 });
    assert.equal(burned.status, 0, burned.stderr);
    const info = await probeMediaFileInfo(ffmpegPath, outputPath);
    assert.ok(info.videoInfo);
    assert.ok(info.audioInfo);
  } finally {
    await fsp.rm(tempDir, { recursive: true, force: true });
  }
});

test('photo avatars are composed through a separate transparent side layer and keep an MP4-compatible output', async () => {
  const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'br2k-avatar-layer-burn-'));
  const inputPath = path.join(tempDir, 'input.mp4');
  const sourceAvatarPath = path.join(tempDir, 'source.png');
  const avatarPath = path.join(tempDir, 'avatar.png');
  const assPath = path.join(tempDir, 'overlay.ass');
  const filterScriptPath = path.join(tempDir, 'avatar-layer.ffscript');
  const outputPath = path.join(tempDir, 'output.mp4');
  try {
    const input = await runCapturedProcess(
      ffmpegPath,
      [
        '-hide_banner', '-loglevel', 'error', '-y',
        '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=30:duration=1.2',
        '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=1.2',
        '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', inputPath
      ],
      { timeoutMs: 20_000 }
    );
    assert.equal(input.status, 0, input.stderr);
    const source = await runCapturedProcess(
      ffmpegPath,
      ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=80x80:rate=1:duration=1', '-frames:v', '1', sourceAvatarPath],
      { timeoutMs: 20_000 }
    );
    assert.equal(source.status, 0, source.stderr);
    const cropped = await runCapturedProcess(
      ffmpegPath,
      [
        '-hide_banner', '-loglevel', 'error', '-y', '-i', sourceAvatarPath, '-frames:v', '1', '-vf',
        "scale=32:32:force_original_aspect_ratio=increase,crop=32:32,format=rgba,geq=r='r(X,Y)':g='g(X,Y)':b='b(X,Y)':a='if(lte((X-W/2)*(X-W/2)+(Y-H/2)*(Y-H/2),(W/2)*(W/2)),255,0)'",
        '-pix_fmt', 'rgba', avatarPath
      ],
      { timeoutMs: 20_000 }
    );
    assert.equal(cropped.status, 0, cropped.stderr);
    await fsp.writeFile(assPath, createAss([]), 'utf8');
    const avatarOverlay = {
      panel: { left: 10, width: 120, height: 180 },
      filterScriptPath,
      entries: [
        {
          imagePath: avatarPath,
          segments: [
            { start: 0.1, end: 0.6, x1: 18, x2: 18, y1: 28, y2: 56 },
            { start: 0.6, end: 1, x1: 18, x2: 18, y1: 56, y2: 56 }
          ]
        }
      ]
    };
    const script = createAvatarOverlayFilterScript({ assPath, fps: 30, avatarOverlay });
    assert.match(script, /color=c=black@0\.0:s=120x180:r=30,format=rgba/);
    assert.match(script, /\[avatar_layer_0\]\[avatar_image_0\]overlay=/);
    assert.match(script, /format=yuv420p\[vout\]/);
    await fsp.writeFile(filterScriptPath, script, 'utf8');
    const args = createBurnArgs({
      cleanPath: inputPath,
      assPath,
      burnedPath: outputPath,
      codec: 'libx264',
      crf: 24,
      container: 'mp4',
      fps: 30,
      avatarOverlay
    });
    assert.ok(args.includes('-filter_complex_script'));
    assert.equal(args.includes('-vf'), false);
    assert.equal(args.filter((arg) => arg === '-i').length, 2, 'source video plus the alpha avatar input');
    const burned = await runCapturedProcess(ffmpegPath, args, { timeoutMs: 20_000 });
    assert.equal(burned.status, 0, burned.stderr);
    const info = await probeMediaFileInfo(ffmpegPath, outputPath);
    assert.ok(info.videoInfo);
    assert.ok(info.audioInfo);
    assert.equal(info.videoInfo.pixelFormat, 'yuv420p');
  } finally {
    await fsp.rm(tempDir, { recursive: true, force: true });
  }
});

test('portrait burn keeps the source canvas and renders its adaptive ASS overlay', async () => {
  const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'br2k-portrait-burn-'));
  const inputPath = path.join(tempDir, 'portrait-input.mp4');
  const danmakuPath = path.join(tempDir, 'portrait-input.danmaku.jsonl');
  const cssPath = path.join(tempDir, 'portrait-input.danmaku.css');
  const outputPath = path.join(tempDir, 'portrait-output.mp4');
  try {
    const generated = await runCapturedProcess(
      ffmpegPath,
      [
        '-hide_banner',
        '-loglevel',
        'error',
        '-y',
        '-f',
        'lavfi',
        '-i',
        'testsrc2=size=540x960:rate=30:duration=0.8',
        '-f',
        'lavfi',
        '-i',
        'sine=frequency=660:sample_rate=48000:duration=0.8',
        '-c:v',
        'libx264',
        '-pix_fmt',
        'yuv420p',
        '-c:a',
        'aac',
        inputPath
      ],
      { timeoutMs: 20_000 }
    );
    assert.equal(generated.status, 0, generated.stderr);
    await fsp.writeFile(
      danmakuPath,
      `${JSON.stringify({ type: 'danmaku', time: 0.1, uid: 42, user: '观众', text: '竖屏烧录' })}\n`,
      'utf8'
    );
    const service = new LiveRecordService();
    service.ffmpegPath = ffmpegPath;
    service.ensurePlatformCjkFont = async () => {};
    const recording = {
      cleanPath: inputPath,
      danmakuPath,
      cssPath,
      // A stale library entry must never determine the ASS canvas.
      videoInfo: { width: 1920, height: 1080 }
    };
    const assets = await service.generateSubtitleAssets(recording, {
      stylePreset: 'h5-card'
    });
    const ass = await fsp.readFile(assets.assPath, 'utf8');
    assert.match(ass, /PlayResX: 540/);
    assert.match(ass, /PlayResY: 960/);
    assert.equal(assets.playWidth, 540);
    assert.equal(assets.playHeight, 960);
    assert.equal(assets.avatarPlan?.entries?.[0]?.uid, 42, 'worker returns the matching photo-layer motion plan');
    assert.equal(recording.videoInfo.width, 540);
    assert.equal(recording.videoInfo.height, 960);
    const burned = await runCapturedProcess(
      ffmpegPath,
      createBurnArgs({
        cleanPath: inputPath,
        assPath: assets.assPath,
        burnedPath: outputPath,
        codec: 'libx264',
        crf: 24,
        container: 'mp4',
        fps: 30
      }),
      { timeoutMs: 20_000 }
    );
    assert.equal(burned.status, 0, burned.stderr);
    const info = await probeMediaFileInfo(ffmpegPath, outputPath);
    assert.equal(info.videoInfo.width, 540);
    assert.equal(info.videoInfo.height, 960);
  } finally {
    await fsp.rm(tempDir, { recursive: true, force: true });
  }
});

test('different-resolution segments are retained in a highest-resolution merged file', async () => {
  const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'br2k-resolution-merge-'));
  const firstPath = path.join(tempDir, 'first.mp4');
  const secondPath = path.join(tempDir, 'second.mp4');
  const outputPath = path.join(tempDir, 'merged.mp4');
  const generate = async (output, size, rate, tone) => {
    const result = await runCapturedProcess(
      ffmpegPath,
      [
        '-hide_banner',
        '-loglevel',
        'error',
        '-y',
        '-f',
        'lavfi',
        '-i',
        `testsrc2=size=${size}:rate=${rate}:duration=0.6`,
        '-f',
        'lavfi',
        '-i',
        `sine=frequency=${tone}:sample_rate=48000:duration=0.6`,
        '-shortest',
        '-c:v',
        'libx264',
        '-pix_fmt',
        'yuv420p',
        '-c:a',
        'aac',
        output
      ],
      { timeoutMs: 20000 }
    );
    assert.equal(result.status, 0, result.stderr);
  };

  try {
    await generate(firstPath, '320x180', 24, 440);
    await generate(secondPath, '640x360', 30, 660);
    const mediaInfos = [
      await probeMediaFileInfo(ffmpegPath, firstPath),
      await probeMediaFileInfo(ffmpegPath, secondPath)
    ];
    const targetVideoInfo = selectHighestResolutionVideoInfo(mediaInfos);
    const args = createConcatTranscodeArgs({
      segments: [
        { filePath: firstPath, durationSec: mediaInfos[0].durationSec, hasAudio: true },
        { filePath: secondPath, durationSec: mediaInfos[1].durationSec, hasAudio: true }
      ],
      outputPath,
      container: 'mp4',
      targetVideoInfo,
      videoCodec: 'libx264'
    });
    const mergeResult = await runCapturedProcess(ffmpegPath, args, { timeoutMs: 30000 });
    assert.equal(mergeResult.status, 0, mergeResult.stderr);

    const mergedInfo = await probeMediaFileInfo(ffmpegPath, outputPath);
    assert.equal(mergedInfo.videoInfo.width, 640);
    assert.equal(mergedInfo.videoInfo.height, 360);
    assert.ok(mergedInfo.durationSec >= 1.1, `expected both segments, got ${mergedInfo.durationSec}s`);
    const mergedTiming = await probeMediaTimelineInfo(ffmpegPath, outputPath, mergedInfo);
    assert.equal(mergedTiming.timingSafeForCopy, true, JSON.stringify(mergedTiming));
  } finally {
    await fsp.rm(tempDir, { recursive: true, force: true });
  }
});
