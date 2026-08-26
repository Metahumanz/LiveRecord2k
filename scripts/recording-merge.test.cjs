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
  createAvatarOverlayChunkFilterScript,
  createConcatCopyArgs,
  createNormalizeSegmentArgs,
  createConcatTranscodeArgs,
  writeConcatFile,
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
  assert.deepEqual(normalizeArgs.slice(0, 5), ['-hide_banner', '-nostats', '-progress', 'pipe:2', '-y']);

  const copyArgs = createConcatCopyArgs({
    concatPath: 'normalized.concat.txt',
    outputPath: 'merged.mp4',
    container: 'mp4',
    streamCodec: 'hevc (Main)'
  });
  assert.ok(copyArgs.includes('hvc1'));
  assert.deepEqual(copyArgs.slice(0, 5), ['-hide_banner', '-nostats', '-progress', 'pipe:2', '-y']);

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

test('independent avatar chunks trim a bounded preroll before their exact source boundary', () => {
  const args = createBurnArgs({
    cleanPath: 'C:/temp/input.mp4',
    assPath: 'C:/temp/overlay.ass',
    burnedPath: 'C:/temp/chunk.mkv',
    codec: 'libx264',
    crf: 20,
    container: 'mkv',
    startTime: 60,
    duration: 60,
    fps: 60,
    avatarOverlay: { filterScriptPath: 'C:/temp/avatar-layer.ffscript', entries: [] },
    inputSeek: true,
    inputSeekPrerollSec: 2,
    includeAudio: false
  });
  const inputIndex = args.indexOf('-i');
  assert.deepEqual(args.slice(inputIndex - 2, inputIndex + 3), ['-ss', '58', '-i', 'C:/temp/input.mp4', '-t']);
  const script = createAvatarOverlayChunkFilterScript({
    assPath: 'C:/temp/overlay.ass',
    fps: 60,
    avatarOverlay: { entries: [] },
    chunkStart: 60,
    chunkEnd: 120,
    timelineOffset: 60,
    inputTrimStartSec: 2,
    inputTrimEndSec: 62
  });
  assert.match(script, /trim=start=2:end=62,setpts=PTS-STARTPTS/);
  assert.doesNotMatch(script, /fps=60:start_time=0/, 'independent chunks must preserve the source frame clock');
});

test('chunk concat directives retain the caller supplied source-time windows', async () => {
  const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'br2k-concat-duration-'));
  const concatPath = path.join(tempDir, 'chunks.ffconcat');
  try {
    await writeConcatFile(concatPath, ['C:/temp/first.mkv', 'C:/temp/second.mkv'], { durations: [60, 12.34567] });
    const content = await fsp.readFile(concatPath, 'utf8');
    assert.equal(
      content,
      "file 'C:/temp/first.mkv'\nduration 60\nfile 'C:/temp/second.mkv'\nduration 12.346\n"
    );
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
    assert.match(script, /movie='[^']+',settb=AVTB,setpts=PTS-STARTPTS,format=rgba,loop=loop=-1:size=1:start=0/);
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
    assert.equal(args.filter((arg) => arg === '-i').length, 1, 'avatar images are loaded from the filter script');
    assert.equal(args.includes('-framerate'), false, 'avatar artwork is not added as a separate live input');
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

test('multiple recorded avatars remain visible in separate chunked time windows', async () => {
  const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'br2k-avatar-multi-burn-'));
  const inputPath = path.join(tempDir, 'input.mp4');
  const redPath = path.join(tempDir, 'red.png');
  const bluePath = path.join(tempDir, 'blue.png');
  const assPath = path.join(tempDir, 'overlay.ass');
  const filterScriptPath = path.join(tempDir, 'avatar-layer.ffscript');
  const outputPath = path.join(tempDir, 'output.mp4');
  try {
    for (const [color, imagePath] of [['black', inputPath], ['red', redPath], ['blue', bluePath]]) {
      const args = color === 'black'
        ? [
            '-hide_banner', '-loglevel', 'error', '-y',
            '-f', 'lavfi', '-i', 'color=c=black:s=320x180:r=30:d=2',
            '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=2',
            '-shortest', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', imagePath
          ]
        : [
            '-hide_banner', '-loglevel', 'error', '-y',
            '-f', 'lavfi', '-i', `color=c=${color}:s=32x32:r=1:d=1`,
            '-frames:v', '1', '-pix_fmt', 'rgba', imagePath
          ];
      const generated = await runCapturedProcess(ffmpegPath, args, { timeoutMs: 20_000 });
      assert.equal(generated.status, 0, generated.stderr);
    }
    await fsp.writeFile(assPath, createAss([]), 'utf8');
    const avatarOverlay = {
      panel: { left: 10, width: 120, height: 180 },
      filterScriptPath,
      entries: [
        {
          imagePath: redPath,
          segments: [{ start: 1.1, end: 1.55, x1: 18, x2: 18, y1: 28, y2: 28 }]
        },
        {
          imagePath: bluePath,
          segments: [{ start: 1.6, end: 1.95, x1: 18, x2: 18, y1: 68, y2: 68 }]
        }
      ]
    };
    await fsp.writeFile(
      filterScriptPath,
      createAvatarOverlayFilterScript({ assPath, fps: 30, avatarOverlay, duration: 2, chunkDuration: 0.5 }),
      'utf8'
    );
    const burned = await runCapturedProcess(
      ffmpegPath,
      createBurnArgs({
        cleanPath: inputPath,
        assPath,
        burnedPath: outputPath,
        codec: 'libx264',
        crf: 20,
        container: 'mp4',
        fps: 30,
        startTime: 1,
        duration: 1,
        avatarOverlay
      }),
      { timeoutMs: 20_000 }
    );
    assert.equal(burned.status, 0, burned.stderr);
    const outputInfo = await probeMediaFileInfo(ffmpegPath, outputPath);
    assert.ok(outputInfo.audioInfo, 'chunked avatar compositing must keep the source audio stream');

    const samplePixel = async (time, x, y, label) => {
      const rawPath = path.join(tempDir, `${label}.raw`);
      const sampled = await runCapturedProcess(
        ffmpegPath,
        [
          '-hide_banner', '-loglevel', 'error', '-y', '-ss', String(time), '-i', outputPath,
          '-frames:v', '1', '-vf', `crop=1:1:${x}:${y},format=rgb24`, '-f', 'rawvideo', rawPath
        ],
        { timeoutMs: 20_000 }
      );
      assert.equal(sampled.status, 0, sampled.stderr);
      return [...(await fsp.readFile(rawPath)).subarray(0, 3)];
    };

    assert.deepEqual(await samplePixel(0.2, 34, 44, 'red'), [252, 0, 0]);
    assert.deepEqual(await samplePixel(0.8, 34, 84, 'blue'), [0, 0, 252]);
    assert.deepEqual(await samplePixel(0.2, 34, 84, 'empty'), [0, 0, 0]);
  } finally {
    await fsp.rm(tempDir, { recursive: true, force: true });
  }
});

test('long avatar burns process each source-time chunk independently and keep A/V aligned', async () => {
  const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'br2k-avatar-real-chunks-'));
  const inputPath = path.join(tempDir, 'input.mp4');
  const redPath = path.join(tempDir, 'red.png');
  const bluePath = path.join(tempDir, 'blue.png');
  const assPath = path.join(tempDir, 'overlay.ass');
  const outputPath = path.join(tempDir, 'output.mp4');
  try {
    for (const [color, output] of [['red', redPath], ['blue', bluePath]]) {
      const avatar = await runCapturedProcess(
        ffmpegPath,
        [
          '-hide_banner', '-loglevel', 'error', '-y',
          '-f', 'lavfi', '-i', `color=c=${color}:s=32x32:r=1:d=1`,
          '-frames:v', '1', '-pix_fmt', 'rgba', output
        ],
        { timeoutMs: 20_000 }
      );
      assert.equal(avatar.status, 0, avatar.stderr);
    }
    const input = await runCapturedProcess(
      ffmpegPath,
      [
        '-hide_banner', '-loglevel', 'error', '-y',
        '-f', 'lavfi', '-i', 'color=c=black:s=320x180:r=30:d=3',
        '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=3',
        '-shortest', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', inputPath
      ],
      { timeoutMs: 20_000 }
    );
    assert.equal(input.status, 0, input.stderr);
    await fsp.writeFile(assPath, createAss([]), 'utf8');
    const service = new LiveRecordService();
    service.ffmpegPath = ffmpegPath;
    service.log = () => {};
    const temporaryDir = await fsp.mkdtemp(path.join(tempDir, 'avatar-layer-'));
    await service.runChunkedAvatarBurn({
      cleanPath: inputPath,
      assPath,
      burnedPath: outputPath,
      codec: 'libx264',
      crf: 20,
      startTime: 1,
      duration: 2,
      fps: 30,
      avatarLayer: {
        panel: { left: 10, width: 120, height: 180 },
        temporaryDir,
        chunkDuration: 0.5,
        entries: [
          { imagePath: redPath, segments: [{ start: 1.1, end: 1.5, x1: 18, x2: 18, y1: 28, y2: 28 }] },
          { imagePath: bluePath, segments: [{ start: 2.1, end: 2.5, x1: 18, x2: 18, y1: 68, y2: 68 }] }
        ]
      },
      onStderr: () => {}
    });
    const outputInfo = await probeMediaFileInfo(ffmpegPath, outputPath);
    assert.ok(outputInfo.videoInfo);
    assert.ok(outputInfo.audioInfo);
    assert.ok(Math.abs(outputInfo.durationSec - 2) < 0.15, JSON.stringify(outputInfo));
    const timeline = await probeMediaTimelineInfo(ffmpegPath, outputPath, outputInfo);
    assert.ok(Math.abs(timeline.avDeltaSec) < 0.08, JSON.stringify(timeline));

    const samplePixel = async (time, x, y, label) => {
      const rawPath = path.join(tempDir, `${label}.raw`);
      const sampled = await runCapturedProcess(
        ffmpegPath,
        [
          '-hide_banner', '-loglevel', 'error', '-y', '-ss', String(time), '-i', outputPath,
          '-frames:v', '1', '-vf', `crop=1:1:${x}:${y},format=rgb24`, '-f', 'rawvideo', rawPath
        ],
        { timeoutMs: 20_000 }
      );
      assert.equal(sampled.status, 0, sampled.stderr);
      return [...(await fsp.readFile(rawPath)).subarray(0, 3)];
    };
    assert.deepEqual(await samplePixel(0.2, 34, 44, 'red'), [252, 0, 0]);
    assert.deepEqual(await samplePixel(1.2, 34, 84, 'blue'), [0, 0, 252]);
    assert.deepEqual(await samplePixel(0.2, 34, 84, 'empty'), [0, 0, 0]);
  } finally {
    await fsp.rm(tempDir, { recursive: true, force: true });
  }
});

test('chunked burns preserve a source video lead-in instead of pulling video ahead of audio', async () => {
  const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'br2k-avatar-av-lead-in-'));
  const inputPath = path.join(tempDir, 'input.mp4');
  const assPath = path.join(tempDir, 'overlay.ass');
  const outputPath = path.join(tempDir, 'output.mp4');
  try {
    // Deliberately model a real fMP4/HLS capture: audio begins at t=0 while
    // the first decodable video frame appears one second later.
    const input = await runCapturedProcess(
      ffmpegPath,
      [
        '-hide_banner', '-loglevel', 'error', '-y',
        '-f', 'lavfi', '-i', 'color=c=red:s=320x180:r=30:d=1',
        '-f', 'lavfi', '-i', 'color=c=blue:s=320x180:r=30:d=1',
        '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=3',
        '-filter_complex', '[0:v][1:v]concat=n=2:v=1:a=0,setpts=PTS+1/TB[v]',
        '-map', '[v]', '-map', '2:a', '-t', '3',
        '-c:v', 'libx264', '-bf', '0', '-pix_fmt', 'yuv420p',
        '-c:a', 'aac', '-avoid_negative_ts', 'disabled', inputPath
      ],
      { timeoutMs: 20_000 }
    );
    assert.equal(input.status, 0, input.stderr);
    await fsp.writeFile(assPath, createAss([]), 'utf8');

    const service = new LiveRecordService();
    service.ffmpegPath = ffmpegPath;
    service.log = () => {};
    const temporaryDir = await fsp.mkdtemp(path.join(tempDir, 'avatar-layer-'));
    await service.runChunkedAvatarBurn({
      cleanPath: inputPath,
      assPath,
      burnedPath: outputPath,
      codec: 'libx264',
      crf: 20,
      startTime: 0,
      duration: 3,
      fps: 30,
      avatarLayer: {
        panel: { left: 10, width: 120, height: 180 },
        temporaryDir,
        chunkDuration: 1.5,
        entries: []
      },
      timelineAlignment: { videoPaddingSec: 1, audioPaddingSec: 0 },
      onStderr: () => {}
    });

    const outputInfo = await probeMediaFileInfo(ffmpegPath, outputPath);
    assert.ok(outputInfo.videoInfo);
    assert.ok(outputInfo.audioInfo);
    assert.ok(Math.abs(outputInfo.durationSec - 3) < 0.15, JSON.stringify(outputInfo));
    const timeline = await probeMediaTimelineInfo(ffmpegPath, outputPath, outputInfo);
    assert.ok(Math.abs(timeline.avDeltaSec) < 0.12, JSON.stringify(timeline));

    const samplePixel = async (time, label) => {
      const rawPath = path.join(tempDir, `${label}.raw`);
      const sampled = await runCapturedProcess(
        ffmpegPath,
        [
          '-hide_banner', '-loglevel', 'error', '-y', '-ss', String(time), '-i', outputPath,
          '-frames:v', '1', '-vf', 'crop=1:1:160:90,format=rgb24', '-f', 'rawvideo', rawPath
        ],
        { timeoutMs: 20_000 }
      );
      assert.equal(sampled.status, 0, sampled.stderr);
      return [...(await fsp.readFile(rawPath)).subarray(0, 3)];
    };
    const isBlack = ([red, green, blue]) => red < 20 && green < 20 && blue < 20;
    const isRed = ([red, green, blue]) => red > 180 && green < 70 && blue < 70;
    const isBlue = ([red, green, blue]) => blue > 180 && red < 70 && green < 70;

    assert.ok(isBlack(await samplePixel(0.5, 'lead-in')), 'the original video lead-in must remain black');
    assert.ok(isRed(await samplePixel(1.2, 'red')), 'red source video must begin after the one-second lead-in');
    assert.ok(isBlue(await samplePixel(2.2, 'blue')), 'later chunks must remain on the same source clock');
  } finally {
    await fsp.rm(tempDir, { recursive: true, force: true });
  }
});

test('NVIDIA avatar composite keeps the full visual timeline on CUDA', () => {
  const avatarOverlay = {
    panel: { left: 10, width: 120, height: 180 },
    filterScriptPath: 'C:/temp/avatar-layer.ffscript',
    gpuComposite: true,
    entries: [
      {
        imagePath: 'C:/temp/avatar.png',
        segments: [{ start: 0.1, end: 1, x1: 18, x2: 18, y1: 28, y2: 56 }]
      }
    ]
  };
  const script = createAvatarOverlayFilterScript({
    assPath: 'C:/temp/overlay.ass',
    fps: 60,
    avatarOverlay,
    gpuComposite: true
  });
  const args = createBurnArgs({
    cleanPath: 'C:/temp/input.mp4',
    assPath: 'C:/temp/overlay.ass',
    burnedPath: 'C:/temp/output.mp4',
    codec: 'hevc_nvenc',
    crf: 24,
    container: 'mp4',
    fps: 60,
    avatarOverlay
  });

  assert.match(script, /ass='C\\:\/temp\/overlay\.ass',hwupload_cuda\[avatar_layer_0\]/);
  assert.match(script, /overlay_cuda=/);
  assert.match(script, /overlay_cuda=x='[^']*\\,18\\,18\)/, 'CUDA uses full-canvas avatar coordinates');
  assert.match(script, /scale_cuda=format=yuv420p\[vout\]/);
  assert.doesNotMatch(script, /enable='between/);
  assert.equal(args[args.indexOf('-init_hw_device') + 1], 'cuda=br2k_avatar:0');
  assert.equal(args[args.indexOf('-filter_hw_device') + 1], 'br2k_avatar');
  assert.equal(args.filter((arg) => arg === '-i').length, 1);
  assert.match(script, /movie='C\\:\/temp\/avatar\.png'/);
});

test('CUDA avatar chunks download once before applying a CPU-only video lead-in', () => {
  const script = createAvatarOverlayChunkFilterScript({
    assPath: 'C:/temp/overlay.ass',
    fps: 60,
    avatarOverlay: {
      panel: { left: 10, width: 120, height: 180 },
      entries: [
        {
          imagePath: 'C:/temp/avatar.png',
          segments: [{ start: 0.1, end: 1, x1: 18, x2: 18, y1: 28, y2: 56 }]
        }
      ]
    },
    chunkStart: 0,
    chunkEnd: 2,
    timelineOffset: 1,
    leadingVideoPaddingSec: 1,
    outputDuration: 2,
    gpuComposite: true
  });
  assert.match(
    script,
    /scale_cuda=format=yuv420p,hwdownload,format=yuv420p,setpts=PTS-STARTPTS,tpad=start_duration=1:start_mode=add:color=black/
  );
});

test('multiple static avatar inputs hold their first frame until their queue window', () => {
  const entries = [
    {
      imagePath: 'C:/temp/avatar-first.png',
      segments: [{ start: 0.1, end: 0.3, x1: 18, x2: 18, y1: 28, y2: 28 }]
    },
    {
      imagePath: 'C:/temp/avatar-second.png',
      segments: [{ start: 0.4, end: 0.6, x1: 18, x2: 18, y1: 68, y2: 68 }]
    }
  ];
  for (const gpuComposite of [false, true]) {
    const script = createAvatarOverlayFilterScript({
      assPath: 'C:/temp/overlay.ass',
      fps: 60,
      avatarOverlay: {
        panel: { left: 10, width: 120, height: 180 },
        gpuComposite,
        entries
      }
    });
    const avatarOverlayLines = script
      .split(/\r?\n/)
      .filter((line) => /overlay(?:_cuda)?=/.test(line) && line.includes('[avatar_image_'));
    assert.ok(avatarOverlayLines.length >= 2);
    assert.ok(
      avatarOverlayLines.every((line) => line.includes('eof_action=pass:repeatlast=1')),
      `${gpuComposite ? 'CUDA' : 'CPU'} avatar layers must hold their static source frame`
    );
  }
});

test(
  'NVIDIA avatar composite renders a real 2K/60 ASS-plus-avatar export',
  { skip: process.env.BR2K_TEST_CUDA !== '1' },
  async () => {
    const width = 2560;
    const height = 1440;
    const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'br2k-cuda-avatar-burn-'));
    const inputPath = path.join(tempDir, 'input.mp4');
    const avatarPath = path.join(tempDir, 'avatar.png');
    const assPath = path.join(tempDir, 'overlay.ass');
    const filterScriptPath = path.join(tempDir, 'avatar-layer.ffscript');
    const outputPath = path.join(tempDir, 'output.mp4');
    try {
      const input = await runCapturedProcess(
        ffmpegPath,
        [
          '-hide_banner', '-loglevel', 'error', '-y',
          '-f', 'lavfi', '-i', `testsrc2=size=${width}x${height}:rate=60:duration=0.5`,
          '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=0.5',
          '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', inputPath
        ],
        { timeoutMs: 20_000 }
      );
      assert.equal(input.status, 0, input.stderr);
      const avatar = await runCapturedProcess(
        ffmpegPath,
        [
          '-hide_banner', '-loglevel', 'error', '-y',
          '-f', 'lavfi', '-i', 'color=c=red@0.5:s=32x32:r=1:d=1,format=rgba',
          '-frames:v', '1', '-pix_fmt', 'rgba', avatarPath
        ],
        { timeoutMs: 20_000 }
      );
      assert.equal(avatar.status, 0, avatar.stderr);
      await fsp.writeFile(assPath, createAss([{ type: 'danmaku', time: 0.1, text: 'CUDA 头像' }]), 'utf8');
      const avatarOverlay = {
        panel: { left: 10, width: 120, height: 180 },
        filterScriptPath,
        gpuComposite: true,
        entries: [
          {
            imagePath: avatarPath,
          segments: [{ start: 0.1, end: 0.4, x1: 18, x2: 18, y1: 28, y2: 56 }]
          }
        ]
      };
      await fsp.writeFile(
        filterScriptPath,
        createAvatarOverlayFilterScript({ assPath, fps: 60, avatarOverlay, gpuComposite: true }),
        'utf8'
      );
      const burned = await runCapturedProcess(
        ffmpegPath,
        createBurnArgs({
          cleanPath: inputPath,
          assPath,
          burnedPath: outputPath,
          codec: 'hevc_nvenc',
          crf: 24,
          container: 'mp4',
          fps: 60,
          avatarOverlay
        }),
        { timeoutMs: 30_000 }
      );
      assert.equal(burned.status, 0, burned.stderr);
      const info = await probeMediaFileInfo(ffmpegPath, outputPath);
      assert.ok(info.videoInfo);
      assert.ok(info.audioInfo);
      assert.equal(info.videoInfo.width, width);
      assert.equal(info.videoInfo.height, height);
      assert.equal(Math.round(Number(info.videoInfo.fps || 0)), 60, 'static avatar artwork keeps the 60fps output timeline');
    } finally {
      await fsp.rm(tempDir, { recursive: true, force: true });
    }
  }
);

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
