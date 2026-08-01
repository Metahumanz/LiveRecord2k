const assert = require('node:assert/strict');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const ffmpegPath = require('ffmpeg-static');

const { LiveRecordService } = require('../src/server/app/service.cjs');
const { createAss } = require('../src/server/danmaku/ass.cjs');
const {
  createBurnArgs,
  createConcatTranscodeArgs,
  selectHighestResolutionVideoInfo,
  shouldTranscodeConcat
} = require('../src/server/recording/ffmpeg.cjs');
const {
  parseFfmpegAudioInfo,
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
