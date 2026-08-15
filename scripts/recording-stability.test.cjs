const assert = require('node:assert/strict');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const zlib = require('node:zlib');

const { DanmakuClient, decodeDanmakuPacket, unpackDanmakuPackets } = require('../src/server/danmaku/client.cjs');
const { SessionEventDeduper } = require('../src/server/danmaku/dedupe.cjs');
const {
  normalizeDanmakuEvent,
  classifyDanmakuEventIgnore,
  createAss
} = require('../src/server/danmaku/ass.cjs');
const { createRecordingArgs, mergeDanmakuFiles } = require('../src/server/recording/ffmpeg.cjs');
const { LiveRecordService } = require('../src/server/app/service.cjs');
const { runCapturedProcess } = require('../src/server/shared/helpers.cjs');
const ffmpegPath = require('ffmpeg-static');

function makePacket(operation, body, version = 1) {
  const payload = Buffer.isBuffer(body) ? body : Buffer.from(body, 'utf8');
  const packet = Buffer.alloc(16 + payload.length);
  packet.writeUInt32BE(packet.length, 0);
  packet.writeUInt16BE(16, 4);
  packet.writeUInt16BE(version, 6);
  packet.writeUInt32BE(operation, 8);
  packet.writeUInt32BE(1, 12);
  payload.copy(packet, 16);
  return packet;
}

function makeCompressedPacket(body) {
  return makePacket(5, zlib.deflateSync(body), 2);
}

function decodePacketBuffer(buffer) {
  const [packet] = unpackDanmakuPackets(buffer);
  return decodeDanmakuPacket(packet);
}

function timing(videoTime = 1) {
  return { receivedAt: 1_786_432_100_123, receivedMono: 1234.5, videoTime };
}

test('guard protocol variants collapse to one session event and USER_TOAST_MSG_V2 is supported', () => {
  const deduper = new SessionEventDeduper();
  const guardBuy = {
    cmd: 'GUARD_BUY',
    data: { uid: 42, username: '舰长用户', guard_level: 3, num: 1, price: 138000, start_time: 1_786_432_100, tid: 'guard-1' }
  };
  const toastV2 = {
    cmd: 'USER_TOAST_MSG_V2',
    data: {
      tid: 'guard-1',
      data: { uid: 42, username: '舰长用户', guard_level: 3, num: 1, price: 138000, start_time: 1_786_432_100 }
    }
  };
  const toast = {
    cmd: 'USER_TOAST_MSG',
    data: { uid: 42, username: '舰长用户', guard_level: 3, num: 1, price: 138000, start_time: 1_786_432_100, tid: 'guard-1' }
  };
  const first = normalizeDanmakuEvent(guardBuy, timing(3));
  const duplicateClassic = normalizeDanmakuEvent(toast, timing(3.05));
  const duplicate = normalizeDanmakuEvent(toastV2, timing(3.1));

  assert.equal(first.type, 'guard');
  assert.equal(duplicate.type, 'guard');
  assert.equal(first.sourceCmd, 'GUARD_BUY');
  assert.equal(duplicateClassic.sourceCmd, 'USER_TOAST_MSG');
  assert.equal(duplicate.sourceCmd, 'USER_TOAST_MSG_V2');
  assert.equal(deduper.checkAndRemember(first, guardBuy, first.receivedAt).duplicate, false);
  assert.equal(deduper.checkAndRemember(duplicateClassic, toast, duplicateClassic.receivedAt + 25).duplicate, true);
  assert.equal(deduper.checkAndRemember(duplicate, toastV2, duplicate.receivedAt + 50).duplicate, true);
  const service = new LiveRecordService();
  assert.equal(service.getLiveDanmakuDeduper('same-live'), service.getLiveDanmakuDeduper('same-live'));
});

test('SEND_GIFT is captured once while COMBO_SEND is deliberately ignored without count inflation', () => {
  const sendGift = {
    cmd: 'SEND_GIFT',
    data: { uid: 7, uname: '连击用户', gift_name: '小花', gift_id: 100, num: 3, price: 1000, tid: 'gift-1', timestamp: 1_786_432_100 }
  };
  const combo = {
    cmd: 'COMBO_SEND',
    data: { uid: 7, uname: '连击用户', gift_name: '小花', gift_id: 100, combo_num: 3, price: 1000, tid: 'gift-1' }
  };
  const event = normalizeDanmakuEvent(sendGift, timing(4));

  assert.equal(event.type, 'gift');
  assert.equal(event.count, 3);
  assert.equal(normalizeDanmakuEvent(combo, timing(4.1)), null);
  assert.equal(classifyDanmakuEventIgnore(combo, null), 'deliberatelyIgnored');
});

test('standard and JPN superchat variants collapse to one source id', () => {
  const deduper = new SessionEventDeduper();
  const source = { id: 9988, uid: 9, user_info: { uname: 'SC用户' }, message: '同步测试', price: 30, start_time: 1_786_432_100 };
  const normal = { cmd: 'SUPER_CHAT_MESSAGE', data: source };
  const jpn = { cmd: 'SUPER_CHAT_MESSAGE_JPN', data: { ...source } };
  const first = normalizeDanmakuEvent(normal, timing(5));
  const duplicate = normalizeDanmakuEvent(jpn, timing(5.01));

  assert.equal(first.type, 'superchat');
  assert.equal(deduper.checkAndRemember(first, normal, first.receivedAt).duplicate, false);
  assert.equal(deduper.checkAndRemember(duplicate, jpn, duplicate.receivedAt + 10).duplicate, true);
});

test('raw websocket receipt time survives an intentionally delayed decode queue', async () => {
  let mono = 1000;
  let releaseDecode;
  const gate = new Promise((resolve) => {
    releaseDecode = resolve;
  });
  let received;
  let metrics;
  const client = new DanmakuClient({
    roomId: 1,
    token: 'test',
    nowMono: () => mono,
    nowWall: () => 1_786_432_100_000 + mono,
    decodePacket: async (packet) => {
      await gate;
      return [packet.body.toString('utf8')];
    },
    onCommand: (_command, meta) => {
      received = meta;
    },
    onPacketMetrics: (next) => {
      metrics = next;
    }
  });
  const queued = client.enqueueRawPacket(makePacket(5, JSON.stringify({ cmd: 'DANMU_MSG', info: [[], '迟到解析', [1, 'A']] })));
  mono = 8000;
  releaseDecode();
  await queued;

  assert.equal(received.receivedMono, 1000);
  assert.equal(received.receivedAt, 1_786_432_101_000);
  assert.equal(metrics.maxQueueLagMs, 7000);
});

test('nested compressed danmaku batches are accumulated without variadic stack expansion', async () => {
  const bodies = Buffer.concat(Array.from(
    { length: 20_000 },
    (_, index) => makePacket(5, JSON.stringify({ cmd: 'DANMU_MSG', index }))
  ));
  const nestedCompressed = makeCompressedPacket(bodies);
  const decoded = await decodePacketBuffer(makeCompressedPacket(nestedCompressed));

  assert.equal(decoded.length, 20_000);
  assert.match(decoded.at(-1), /"index":19999/);
});

test('oversized or excessively nested danmaku packets fail with a bounded decode error', async () => {
  const oversizedBodies = Buffer.concat(Array.from(
    { length: 50_001 },
    () => makePacket(5, '{}')
  ));
  const oversized = makeCompressedPacket(makeCompressedPacket(oversizedBodies));
  await assert.rejects(
    () => decodePacketBuffer(oversized),
    (error) => error?.code === 'DANMAKU_PACKET_LIMIT' || error?.code === 'DANMAKU_BODY_LIMIT'
  );

  let deeplyNested = makePacket(5, '{}');
  for (let index = 0; index < 5; index += 1) {
    deeplyNested = makeCompressedPacket(deeplyNested);
  }
  await assert.rejects(
    () => decodePacketBuffer(deeplyNested),
    (error) => error?.code === 'DANMAKU_NESTING_LIMIT'
  );
});

test('media clock uses first FFmpeg progress rather than FFmpeg spawn wall time', () => {
  const service = new LiveRecordService();
  service.log = () => {};
  service.emitState = () => {};
  const room = { id: 'clock', currentRecording: { startedAt: 1, cleanPath: 'clock.clean.mkv' } };
  const session = {
    roomId: room.id,
    startedAt: 1,
    cleanPath: 'clock.clean.mkv',
    ffmpegSpawnAt: 1,
    state: 'waiting-first-frame',
    videoInfo: { width: 1920, height: 1080 },
    finished: false,
    stopping: false,
    lastMediaOutTimeSec: 0,
    lastMediaProgressMono: 0
  };
  service.recordingSessions.set(room.id, session);

  service.processRecordingMediaProgress(room, session, 42.5, 5000, 1_786_432_105_000);

  assert.equal(session.state, 'waiting-first-frame');
  session.firstVideoAt = 1_786_432_105_000;
  service.maybeEnterRecordingState(room, session);
  assert.equal(session.state, 'recording');
  assert.equal(service.resolveSessionVideoTime(session, 1000), 0, 'pre-first-frame event is clamped to media start');
  assert.equal(service.resolveSessionVideoTime(session, 8000), 3, 'post-first-frame event does not include 5s startup wait or source PTS offset');
});

test('FFmpeg timeline regressions rotate the current segment and recording args disable hidden reconnects', () => {
  const args = createRecordingArgs({
    streamUrl: 'https://cdn.example/live.flv',
    headers: 'Referer: https://live.bilibili.com/\r\n',
    outputPath: 'segment.recording.mkv'
  });
  assert.ok(args.includes('-progress'));
  assert.ok(!args.includes('-reconnect'));
  assert.ok(!args.includes('+genpts+discardcorrupt'));

  const service = new LiveRecordService();
  service.log = () => {};
  service.emitState = () => {};
  const room = { id: 'pts', currentRecording: { startedAt: 1, cleanPath: 'pts.clean.mkv' } };
  const session = {
    roomId: room.id,
    liveSessionId: 'live-pts',
    stream: { host: 'https://bad-cdn.example' },
    startedAt: 1,
    cleanPath: 'pts.clean.mkv',
    state: 'recording',
    finished: false,
    stopping: false,
    rotating: false,
    lastMediaOutTimeSec: 10,
    lastMediaProgressMono: 10_000,
    ffmpeg: { exitCode: null, signalCode: null, kill: () => {} }
  };
  service.recordingSessions.set(room.id, session);

  service.processRecordingMediaProgress(room, session, 8, 11_000, 1_786_432_111_000);

  assert.equal(session.rotating, true);
  assert.equal(session.segmentReason, 'pts-discontinuity');
});

test('a large FFmpeg output-time jump also rotates instead of appending a torn timeline', () => {
  const service = new LiveRecordService();
  service.log = () => {};
  service.emitState = () => {};
  const room = { id: 'jump', currentRecording: { startedAt: 1, cleanPath: 'jump.clean.mkv' } };
  const session = {
    roomId: room.id,
    liveSessionId: 'live-jump',
    stream: { host: 'https://bad-cdn.example' },
    startedAt: 1,
    cleanPath: 'jump.clean.mkv',
    state: 'recording',
    finished: false,
    stopping: false,
    rotating: false,
    lastMediaOutTimeSec: 4,
    lastMediaProgressMono: 4_000,
    ffmpeg: { exitCode: null, signalCode: null, kill: () => {} }
  };
  service.recordingSessions.set(room.id, session);

  service.processRecordingMediaProgress(room, session, 35, 5_000, 1_786_432_105_000);

  assert.equal(session.rotating, true);
  assert.equal(session.segmentReason, 'pts-discontinuity');
});

test('merged danmaku advances by true segment media duration, not realtime reconnect gap', async () => {
  const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'br2k-danmaku-merge-'));
  const firstPath = path.join(tempDir, 'first.jsonl');
  const secondPath = path.join(tempDir, 'second.jsonl');
  const outputPath = path.join(tempDir, 'merged.jsonl');
  try {
    await fsp.writeFile(firstPath, `${JSON.stringify({ schemaVersion: 2, type: 'danmaku', videoTime: 9.5, text: 'first' })}\n`);
    await fsp.writeFile(secondPath, `${JSON.stringify({ schemaVersion: 2, type: 'danmaku', videoTime: 1, text: 'second' })}\n`);
    await mergeDanmakuFiles(
      [
        { danmakuPath: firstPath, durationSec: 10.25, startedAt: 1 },
        { danmakuPath: secondPath, durationSec: 2, startedAt: 1 + 20_250 }
      ],
      outputPath
    );
    const events = (await fsp.readFile(outputPath, 'utf8')).trim().split('\n').map(JSON.parse);
    assert.equal(events[0].videoTime, 9.5);
    assert.equal(events[1].videoTime, 11.25);
    assert.equal(events[1].time, 11.25);
  } finally {
    await fsp.rm(tempDir, { recursive: true, force: true });
  }
});

test('ASS generation accepts both schema v2 videoTime and legacy time JSONL events', () => {
  const ass = createAss([
    { schemaVersion: 2, type: 'danmaku', videoTime: 3.25, text: 'v2' },
    { type: 'danmaku', time: 5.5, text: 'legacy' }
  ]);
  assert.match(ass, /0:00:03\.25/);
  assert.match(ass, /0:00:05\.50/);
});

test('recording start lock prevents simultaneous LIVE push and polling starts from opening two sessions', async () => {
  const service = new LiveRecordService();
  service.log = () => {};
  service.emitState = () => {};
  const room = { id: 'race', realRoomId: 'race', liveStatus: 1, recording: false, title: 'race', anchor: 'test' };
  service.rooms.set(room.id, room);
  let resolveStream;
  let resolveCalls = 0;
  service.resolvePlayStream = () => {
    resolveCalls += 1;
    return new Promise((_resolve, reject) => {
      resolveStream = () => reject(new Error('test stop before spawn'));
    });
  };

  const pushStart = service.startRecording(room.id, true, { livePushReceivedAt: Date.now() });
  await new Promise((resolve) => setImmediate(resolve));
  await service.startRecording(room.id, true);
  assert.equal(resolveCalls, 1);
  resolveStream();
  await pushStart;
  assert.equal(service.recordingStartLocks.size, 0);
});

test('formal recording prefers HTTP-FLV and avoids a CDN already degraded in this live session', async () => {
  const service = new LiveRecordService();
  service.log = () => {};
  service.settings.targetQn = 10000;
  service.fetchBiliJson = async () => ({
    code: 0,
    data: {
      playurl_info: {
        playurl: {
          stream: [
            {
              protocol_name: 'http_hls',
              format: [
                {
                  format_name: 'fmp4',
                  codec: [
                    {
                      codec_name: 'avc', current_qn: 10000, accept_qn: [10000], base_url: '/hls.m3u8',
                      url_info: [{ host: 'https://hls.example', extra: '?token=hidden' }]
                    }
                  ]
                }
              ]
            },
            {
              protocol_name: 'http_stream',
              format: [
                {
                  format_name: 'flv',
                  codec: [
                    {
                      codec_name: 'avc', current_qn: 10000, accept_qn: [10000], base_url: '/bad.flv',
                      url_info: [{ host: 'https://bad-flv.example', extra: '?token=hidden' }]
                    },
                    {
                      codec_name: 'avc', current_qn: 10000, accept_qn: [10000], base_url: '/good.flv',
                      url_info: [{ host: 'https://good-flv.example', extra: '?token=hidden' }]
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
  const room = { id: 'flv', realRoomId: 'flv', title: 'flv', anchor: 'test' };
  const first = await service.resolvePlayStream(room, { liveSessionId: 'health-live' });
  assert.equal(first.format, 'flv');
  assert.equal(first.host, 'https://bad-flv.example');
  service.recordStreamHealth('health-live', first, 'stream-eof');
  service.recordStreamHealth('health-live', first, 'network-error');
  const retried = await service.resolvePlayStream(room, { liveSessionId: 'health-live' });
  assert.equal(retried.host, 'https://good-flv.example');
  const preview = await service.resolvePlayStream(room, { requireHls: true });
  assert.equal(preview.format, 'fmp4');
});

test('quality upgrade requires two stable observations before it rotates a segment', async () => {
  const service = new LiveRecordService();
  service.log = () => {};
  service.emitState = () => {};
  const room = { id: 'quality', liveStatus: 1, currentRecording: { startedAt: 1, cleanPath: 'quality.clean.mkv' } };
  const session = {
    roomId: room.id,
    liveSessionId: 'quality-live',
    startedAt: 1,
    cleanPath: 'quality.clean.mkv',
    stream: { url: 'https://current.example/live.flv', host: 'https://current.example', qn: 10000, codec: 'avc', protocol: 'http_stream', format: 'flv' },
    rotating: false,
    qualitySwitching: false,
    stopping: false,
    finished: false,
    state: 'recording',
    ffmpeg: { exitCode: null, signalCode: null, kill: () => {} }
  };
  service.recordingSessions.set(room.id, session);
  service.resolvePlayStream = async () => ({
    url: 'https://upgraded.example/live.flv', host: 'https://upgraded.example', qn: 15000, codec: 'hevc', protocol: 'http_stream', format: 'flv'
  });

  await service.checkRecordingQualityUpgrade(room, session, 15000);
  assert.equal(session.qualitySwitching, false);
  assert.equal(session.qualityCandidateConfirmations, 1);
  await service.checkRecordingQualityUpgrade(room, session, 15000);
  assert.equal(session.qualitySwitching, true);
  assert.equal(session.segmentReason, 'quality-upgrade');
});

test('session diagnostics persist media, CDN, and danmaku health without source URLs', async () => {
  const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'br2k-diagnostics-'));
  const diagnosticsPath = path.join(tempDir, 'diagnostics.json');
  try {
    const service = new LiveRecordService();
    const room = { id: 'diag', title: '诊断房间', anchor: '主播' };
    const session = {
      liveSessionId: 'diag-live',
      diagnosticsPath,
      startedAt: 1_786_432_100_000,
      startRecordingCalledAt: 1_786_432_100_000,
      ffmpegSpawnAt: 1_786_432_100_010,
      firstMediaProgressAt: 1_786_432_105_000,
      firstVideoAt: 1_786_432_105_010,
      danmakuWsConnectedAt: 1_786_432_101_000,
      firstDanmakuAt: 1_786_432_106_000,
      websocketPackets: 12,
      rawDanmakuCount: 10,
      eventCount: 6,
      danmakuReconnectCount: 1,
      danmakuDropCounts: { duplicateDropped: 2, unsupportedCommand: 1, decodeFailed: 1, writeDropped: 0 },
      danmakuQueueMetrics: { maxQueueLagMs: 300, averageQueueLagMs: 42 }
    };
    const recording = {
      liveSessionId: session.liveSessionId,
      diagnosticsPath,
      startedAt: session.startedAt,
      cleanPath: path.join(tempDir, 'segment.clean.mkv'),
      mergeSequence: 0,
      segmentReason: 'stream-eof',
      durationSec: 10.25,
      danmakuDurationSec: 10,
      streamMetadata: { protocol: 'http_stream', format: 'flv', codec: 'h264', qn: 10000, host: 'cdn.example', streamUrlId: 'redacted-id' },
      videoInfo: { codec: 'h264', width: 1920, height: 1080 },
      timelineHealth: { timelineHealth: 'healthy', videoDurationSec: 10.25, audioDurationSec: 10.24, avDeltaSec: -0.01, warnings: [] }
    };
    await service.appendSegmentDiagnostics(room, session, recording);
    await service.finalizeLiveDiagnostics(room, recording, 'completed');
    const diagnostics = JSON.parse(await fsp.readFile(diagnosticsPath, 'utf8'));

    assert.equal(diagnostics.liveSessionId, 'diag-live');
    assert.equal(diagnostics.video.segments[0].durationSec, 10.25);
    assert.equal(diagnostics.danmaku.duplicateDropped, 2);
    assert.equal(diagnostics.final.mergeResult, 'completed');
    assert.equal(JSON.stringify(diagnostics).includes('https://'), false);
  } finally {
    await fsp.rm(tempDir, { recursive: true, force: true });
  }
});

test('danmaku auth failure closes the client and enters the unified reconnect path', async () => {
  const service = new LiveRecordService();
  service.log = () => {};
  service.emitState = () => {};
  service.fetchDanmuInfo = async () => ({ code: 0, data: { token: 'token', host_list: [] } });
  const room = { id: 'auth', realRoomId: 1, currentRecording: { startedAt: 1, cleanPath: 'auth.clean.mkv' } };
  const session = {
    roomId: room.id,
    startedAt: 1,
    cleanPath: 'auth.clean.mkv',
    finished: false,
    stopping: false,
    danmakuReconnectTimer: null,
    danmakuReconnectAttempt: 0,
    danmakuDropCounts: {},
    danmakuQueueMetrics: {}
  };
  service.recordingSessions.set(room.id, session);
  let scheduledReason = '';
  service.scheduleDanmakuReconnect = (_room, _session, reason) => {
    scheduledReason = reason;
  };
  const originalConnect = DanmakuClient.prototype.connect;
  const originalClose = DanmakuClient.prototype.close;
  try {
    DanmakuClient.prototype.connect = function connectForTest() {
      setImmediate(() => this.onAuthReply?.({ code: -101, message: 'invalid token' }));
    };
    DanmakuClient.prototype.close = function closeForTest(reason) {
      this.onClose?.(reason || 'closed');
    };
    await service.startDanmakuCapture(room, session);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(scheduledReason, 'auth failed');
  } finally {
    DanmakuClient.prototype.connect = originalConnect;
    DanmakuClient.prototype.close = originalClose;
  }
});

test('crash recovery finalizes an interrupted recording segment and retains the source capture', async () => {
  const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'br2k-crash-recovery-'));
  const capturePath = path.join(tempDir, 'session.recording.mkv');
  const cleanPath = path.join(tempDir, 'session.clean.mp4');
  const finalizingPath = path.join(tempDir, 'session.clean.finalizing.mp4');
  const metadataPath = `${cleanPath}.metadata.json`;
  try {
    const generated = await runCapturedProcess(
      ffmpegPath,
      [
        '-hide_banner', '-loglevel', 'error', '-y',
        '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=30:duration=3',
        '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=3',
        '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', capturePath
      ],
      { timeoutMs: 30_000 }
    );
    assert.equal(generated.status, 0, generated.stderr);
    await fsp.writeFile(finalizingPath, 'stale partial finalization');
    await fsp.writeFile(
      metadataPath,
      JSON.stringify({
        schemaVersion: 2,
        status: 'recording',
        roomId: '',
        startedAt: Date.now(),
        cleanPath: path.basename(cleanPath),
        capturePath: path.basename(capturePath),
        liveSessionId: 'recovery-live',
        mergeGroup: 'recovery-group',
        mergeSequence: 0,
        danmakuPath: 'session.danmaku.jsonl'
      })
    );
    const service = new LiveRecordService();
    service.settings.outputDir = tempDir;
    service.ffmpegPath = ffmpegPath;
    service.log = () => {};
    service.saveStore = async () => {};
    const recovered = await service.recoverInterruptedRecordings();

    assert.equal(recovered.length, 1);
    assert.equal(recovered[0].recovery, 'recovered-after-crash');
    assert.ok(['healthy', 'warning', 'broken'].includes(recovered[0].timelineHealth.timelineHealth));
    assert.notEqual(recovered[0].timelineHealth.firstVideoPts, null);
    assert.equal(await fsp.stat(cleanPath).then((stat) => stat.isFile()), true);
    assert.equal(await fsp.stat(capturePath).then((stat) => stat.isFile()), true);
    assert.equal(await fsp.stat(finalizingPath).then(() => true).catch(() => false), false);
    const persisted = JSON.parse(await fsp.readFile(metadataPath, 'utf8'));
    assert.equal(persisted.schemaVersion, 2);
    assert.ok(['healthy', 'warning', 'broken'].includes(persisted.timelineHealth));
    assert.ok(persisted.timelineDetails);
  } finally {
    await fsp.rm(tempDir, { recursive: true, force: true });
  }
});
