const assert = require('node:assert/strict');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const ffmpegPath = require('ffmpeg-static');

const { LiveRecordService, getMergeSegmentTimingAssessment } = require('../src/server/app/service.cjs');
const { createNormalizeSegmentArgs } = require('../src/server/recording/ffmpeg.cjs');
const {
  createFfmpegJobProgress,
  discoverRecordingFiles,
  parseFfmpegProgressTime,
  probeMediaFileInfo,
  probeMediaTimelineInfo,
  runFfmpegJob,
  runCapturedProcess,
  updateFfmpegJobProgress
} = require('../src/server/shared/helpers.cjs');

function waitFor(predicate, timeoutMs = 1500) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const check = () => {
      if (predicate()) {
        resolve();
        return;
      }
      if (Date.now() >= deadline) {
        reject(new Error('等待条件超时'));
        return;
      }
      setTimeout(check, 10);
    };
    check();
  });
}

function createMergeTestService() {
  const service = new LiveRecordService();
  service.log = () => {};
  service.emitState = () => {};
  service.saveStore = async () => {};
  service.scheduleQueuedUpdateCheck = () => {};
  service.finalizeLiveDiagnostics = async () => {};
  service.settings.autoBurnDanmaku = false;
  service.getMergeRetryDelayMs = () => 1;
  return service;
}

test('merge watchdog terminates an FFmpeg process whose media timestamp stops progressing', async () => {
  let notified = false;
  const startedAt = Date.now();
  await assert.rejects(
    runFfmpegJob(
      process.execPath,
      [
        '-e',
        "process.stderr.write('time=00:00:00.000\\n'); setInterval(() => process.stderr.write('[hevc] Duplicate POC in a sequence\\n'), 20);"
      ],
      () => {},
      {
        progressStallTimeoutMs: 250,
        progressValueFromText: parseFfmpegProgressTime,
        onNoProgress: () => {
          notified = true;
        }
      }
    ),
    (error) => error?.code === 'FFMPEG_NO_PROGRESS' && error?.ffmpegNoProgress === true
  );
  assert.equal(notified, true);
  assert.ok(Date.now() - startedAt < 5000);
});

test('one source segment with an A/V boundary offset forces safe normalization even when stream specs match', () => {
  const delayedAudio = getMergeSegmentTimingAssessment(
    {
      timelineHealth: {
        timelineHealth: 'healthy',
        timingSafeForCopy: true,
        avDeltaSec: 0,
        firstVideoPts: 0,
        firstAudioPts: 0.65,
        lastVideoPts: 59.96,
        lastAudioPts: 60.61
      }
    },
    true
  );
  const aligned = getMergeSegmentTimingAssessment(
    {
      timelineHealth: {
        timelineHealth: 'healthy',
        timingSafeForCopy: true,
        avDeltaSec: 0,
        firstVideoPts: 0,
        firstAudioPts: -0.021,
        lastVideoPts: 59.96,
        lastAudioPts: 59.98
      }
    },
    true
  );

  assert.equal(delayedAudio.requiresNormalization, true);
  assert.match(delayedAudio.reason, /起始/);
  assert.equal(aligned.requiresNormalization, false);
});

test('merge progress keeps the current segment stage after FFmpeg begins reporting time', () => {
  const progress = createFfmpegJobProgress({
    kind: 'merge',
    label: 'merge',
    durationSec: 120
  });
  progress.stageLabel = '正在规范化分段 2/4';

  assert.equal(updateFfmpegJobProgress(progress, 'time=00:00:31.500'), true);
  assert.match(progress.message, /规范化分段 2\/4/);
  assert.match(progress.message, /\d+秒/);
});

test('structured FFmpeg progress and merge resource waiting remain observable and cancellable', async () => {
  assert.equal(parseFfmpegProgressTime('frame=42\nout_time_us=31500000\nprogress=continue'), 31.5);

  const service = createMergeTestService();
  const room = { id: 'merge-queue', title: 'Queue', anchor: 'test', recording: false };
  const progress = createFfmpegJobProgress({ kind: 'merge', label: 'merge', durationSec: 120, roomId: room.id });
  room.mergeProgress = progress;
  service.rooms.set(room.id, room);
  service.setMergeProgressStage(room, progress, '正在读取分段媒体信息');
  assert.equal(progress.percent, null);
  const releaseRecording = service.mediaJobs.registerExternal({
    id: `recording:${room.id}:1`,
    type: 'recording',
    resource: 'recording'
  });
  try {
    const waitForLease = service.acquireMergeMediaLease(room, progress, { preferred: 'libx264' }).then(
      () => null,
      (error) => error
    );
    await waitFor(() => room.mergeProgress?.status === 'queued');
    assert.match(room.mergeProgress.message, /录制优先/);
    assert.match(room.mergeProgress.message, /合并队列第 1 位/);

    await service.cancelMerge(room.id);
    const error = await waitForLease;
    assert.equal(error?.code, 'MEDIA_JOB_CANCELLED');
    assert.equal(room.mergeProgress?.status, 'cancelled');
    assert.match(room.mergeProgress?.message || '', /取消排队合并/);
    assert.equal(service.mediaJobs.snapshot().some((job) => job.id === progress.id), false);
  } finally {
    releaseRecording();
  }
});

test('merge normalization can retry one corrupt segment with CUDA decode and a duration-preserving prefix repair', () => {
  const args = createNormalizeSegmentArgs({
    inputPath: 'source.clean.mp4',
    outputPath: 'normalized.mkv',
    container: 'mkv',
    durationSec: 30,
    hasAudio: true,
    targetVideoInfo: { width: 1920, height: 1080, fps: 30, codec: 'h264', bitDepth: 8, pixelFormat: 'yuv420p' },
    videoCodec: 'libx264'
  });

  assert.ok(args.includes('+genpts+discardcorrupt'));
  assert.equal(args.includes('ignore_err'), true, '损坏 HEVC 包应跳过，不应卡住规范化作业');

  const recoveryArgs = createNormalizeSegmentArgs({
    inputPath: 'source.clean.mp4',
    outputPath: 'normalized.mkv',
    container: 'mkv',
    durationSec: 30,
    hasAudio: true,
    targetVideoInfo: { width: 1920, height: 1080, fps: 30, codec: 'hevc', bitDepth: 8, pixelFormat: 'yuv420p' },
    videoCodec: 'hevc_nvenc',
    decoder: 'cuda',
    decoderThreads: 1,
    recoverySeekSec: 5
  });
  const filter = recoveryArgs[recoveryArgs.indexOf('-filter_complex') + 1];

  assert.equal(recoveryArgs[recoveryArgs.indexOf('-hwaccel') + 1], 'cuda');
  assert.equal(recoveryArgs[recoveryArgs.indexOf('-ss') + 1], '5');
  assert.equal(recoveryArgs[recoveryArgs.indexOf('-threads') + 1], '1');
  assert.equal(recoveryArgs.filter((value) => value === 'source.clean.mp4').length, 2);
  assert.match(filter, /tpad=start_duration=5:start_mode=add:color=black,trim=duration=30/);
  assert.match(filter, /\[1:a:0\]aresample=48000,asetpts=PTS-STARTPTS,apad,atrim=duration=30/);
  assert.doesNotMatch(filter, /async=1|fps=/, 'recovery must retain original audio/video clocks');
});

test('real merge normalizes a timing-risk source segment and produces an A/V-safe merged recording', async () => {
  const outputDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'br2k-merge-av-'));
  const firstPath = path.join(outputDir, 'first.clean.mp4');
  const secondPath = path.join(outputDir, 'second.clean.mp4');
  const outputPath = path.join(outputDir, 'session.merged.mp4');
  const firstDanmakuPath = path.join(outputDir, 'first.danmaku.jsonl');
  const secondDanmakuPath = path.join(outputDir, 'second.danmaku.jsonl');
  const makeSource = async (filePath, frequency) => {
    const result = await runCapturedProcess(
      ffmpegPath,
      [
        '-hide_banner', '-loglevel', 'error', '-y',
        '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=25:duration=2',
        '-f', 'lavfi', '-i', 'sine=frequency=' + frequency + ':sample_rate=48000:duration=2',
        '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', filePath
      ],
      { timeoutMs: 30_000 }
    );
    assert.equal(result.status, 0, result.stderr);
  };
  try {
    await Promise.all([makeSource(firstPath, 440), makeSource(secondPath, 660), fsp.writeFile(firstDanmakuPath, ''), fsp.writeFile(secondDanmakuPath, '')]);
    const service = createMergeTestService();
    service.ffmpegPath = ffmpegPath;
    service.settings.outputDir = outputDir;
    const logs = [];
    service.log = (_level, message) => logs.push(message);
    const room = { id: 'merge-av', title: 'A/V', anchor: 'test', recording: false };
    service.rooms.set(room.id, room);
    service.recordings = [
      {
        roomId: room.id, mergeGroup: 'merge-av-group', mergeSequence: 1, startedAt: 1, cleanPath: firstPath,
        danmakuPath: firstDanmakuPath, mergeOutputPath: outputPath, valid: true, eventCount: 0,
        timelineHealth: {
          timelineHealth: 'healthy', timingSafeForCopy: true, avDeltaSec: 0,
          firstVideoPts: 0, firstAudioPts: -0.021, lastVideoPts: 1.96, lastAudioPts: 1.98
        }
      },
      {
        roomId: room.id, mergeGroup: 'merge-av-group', mergeSequence: 2, startedAt: 2, cleanPath: secondPath,
        danmakuPath: secondDanmakuPath, mergeOutputPath: outputPath, valid: true, eventCount: 0,
        timelineHealth: {
          timelineHealth: 'healthy', timingSafeForCopy: true, avDeltaSec: 0,
          firstVideoPts: 0, firstAudioPts: 0.65, lastVideoPts: 1.96, lastAudioPts: 2.61
        }
      }
    ];

    const merged = await service.mergeReconnectGroupIfNeeded(room, 'merge-av-group', service.recordings[1]);
    const mergedMediaInfo = await probeMediaFileInfo(ffmpegPath, outputPath);
    const mergedTiming = await probeMediaTimelineInfo(ffmpegPath, outputPath, mergedMediaInfo, { timeoutMs: 30_000 });

    assert.equal(merged.mergedFrom.length, 2);
    assert.ok(mergedMediaInfo.videoInfo);
    assert.ok(Math.abs(mergedTiming.avDeltaSec) <= 0.08, JSON.stringify(mergedTiming));
    assert.ok(logs.some((message) => /单段音画时间轴风险/.test(message)), logs.join('\n'));
  } finally {
    await fsp.rm(outputDir, { recursive: true, force: true });
  }
});

test('failed reconnect merge retries three times and then leaves a clear terminal state', async () => {
  const service = createMergeTestService();
  const room = { id: 'merge-retry', title: 'Retry', anchor: 'test', recording: false };
  service.rooms.set(room.id, room);
  let attempts = 0;
  service.mergeReconnectGroupIfNeeded = async () => {
    attempts += 1;
    throw new Error('decoder did not advance');
  };

  await assert.rejects(service.finalizeReconnectGroup(room, 'retry-group', { cleanPath: 'source.clean.mp4' }), /decoder did not advance/);
  await waitFor(() => attempts === 4 && service.mergeRetryStates.size === 0);

  assert.equal(room.mergeProgress?.status, 'error');
  assert.match(room.mergeProgress?.message || '', /自动重试 3 次后/);
});

test('a successful automatic retry clears its pending retry state', async () => {
  const service = createMergeTestService();
  const room = { id: 'merge-success', title: 'Success', anchor: 'test', recording: false };
  service.rooms.set(room.id, room);
  let attempts = 0;
  service.mergeReconnectGroupIfNeeded = async () => {
    attempts += 1;
    if (attempts === 1) throw new Error('temporary decoder error');
    return { cleanPath: 'merged.mp4', eventCount: 0, valid: true };
  };

  await assert.rejects(service.finalizeReconnectGroup(room, 'success-group', { cleanPath: 'source.clean.mp4' }), /temporary decoder error/);
  await waitFor(() => attempts === 2 && service.mergeRetryStates.size === 0);

  assert.equal(service.mergeRetryStates.size, 0);
});

test('cancelling a scheduled merge retry keeps source segments and prevents the retry callback', async () => {
  const outputDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'br2k-merge-cancel-'));
  const sourcePath = path.join(outputDir, 'source.clean.mp4');
  try {
    await fsp.writeFile(sourcePath, 'source-segment');
    const service = createMergeTestService();
    const room = { id: 'merge-cancel', title: 'Cancel', anchor: 'test', recording: false };
    service.rooms.set(room.id, room);
    let retries = 0;
    service.finalizeReconnectGroup = async () => {
      retries += 1;
    };
    service.getMergeRetryDelayMs = () => 80;

    assert.equal(service.scheduleMergeRetry(room, 'cancel-group', { cleanPath: sourcePath }, new Error('retry me')), true);
    await service.cancelMerge(room.id);
    await new Promise((resolve) => setTimeout(resolve, 120));

    assert.equal(retries, 0);
    assert.equal(service.mergeRetryStates.size, 0);
    assert.equal(room.mergeProgress?.status, 'cancelled');
    assert.match(room.mergeProgress?.message || '', /源分段均已保留/);
    assert.equal((await fsp.stat(sourcePath)).isFile(), true);
  } finally {
    await fsp.rm(outputDir, { recursive: true, force: true });
  }
});

test('startup scan schedules preserved unfinished reconnect segments for merge recovery', async () => {
  const outputDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'br2k-merge-recovery-'));
  const firstPath = path.join(outputDir, 'first.clean.mp4');
  const secondPath = path.join(outputDir, 'second.clean.mp4');
  const outputPath = path.join(outputDir, 'session.merged.mp4');
  try {
    await Promise.all([fsp.writeFile(firstPath, 'source-one'), fsp.writeFile(secondPath, 'source-two')]);
    const service = createMergeTestService();
    const room = { id: 'merge-startup', title: 'Startup', anchor: 'test', recording: false };
    service.rooms.set(room.id, room);
    service.recordings = [
      {
        roomId: room.id,
        mergeGroup: 'startup-group',
        mergeSequence: 1,
        startedAt: 1,
        cleanPath: firstPath,
        mergeOutputPath: outputPath,
        valid: true
      },
      {
        roomId: room.id,
        mergeGroup: 'startup-group',
        mergeSequence: 2,
        startedAt: 2,
        cleanPath: secondPath,
        mergeOutputPath: outputPath,
        valid: true
      }
    ];
    const scheduled = [];
    service.scheduleMergeRetry = (...args) => {
      scheduled.push(args);
      return true;
    };

    assert.equal(await service.resumePendingMergeRetries(), 1);
    assert.equal(scheduled.length, 1);
    assert.equal(scheduled[0][1], 'startup-group');
    assert.equal(scheduled[0][2].cleanPath, secondPath);
  } finally {
    await fsp.rm(outputDir, { recursive: true, force: true });
  }
});

test('restart recovery keeps merge ownership in sidecars even without the previous in-memory list', async () => {
  const outputDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'br2k-merge-sidecar-recovery-'));
  const firstPath = path.join(outputDir, 'first.clean.mp4');
  const secondPath = path.join(outputDir, 'second.clean.mp4');
  const outputPath = path.join(outputDir, 'session.merged.mp4');
  const room = { id: 'merge-sidecar', title: 'Sidecar', anchor: 'test', recording: false };
  try {
    await Promise.all([fsp.writeFile(firstPath, Buffer.alloc(64 * 1024, 1)), fsp.writeFile(secondPath, Buffer.alloc(64 * 1024, 2))]);
    const writer = createMergeTestService();
    for (const [index, cleanPath] of [firstPath, secondPath].entries()) {
      const recording = writer.normalizeRecording({
        roomId: room.id,
        roomTitle: room.title,
        anchor: room.anchor,
        startedAt: 100 + index,
        cleanPath,
        mergeGroup: 'sidecar-group',
        mergeSequence: index + 1,
        mergeOutputPath: outputPath,
        valid: true
      });
      await writer.writeRecordingMetadata(recording);
    }

    const restarted = createMergeTestService();
    restarted.rooms.set(room.id, room);
    restarted.recordings = (await discoverRecordingFiles(outputDir, { concurrency: 1 }))
      .map((recording) => restarted.normalizeRecording(recording))
      .filter(Boolean);
    const scheduled = [];
    restarted.scheduleMergeRetry = (...args) => {
      scheduled.push(args);
      return true;
    };

    assert.equal(restarted.recordings.every((recording) => recording.roomId === room.id), true);
    assert.equal(await restarted.resumePendingMergeRetries(), 1);
    assert.equal(scheduled[0][1], 'sidecar-group');
  } finally {
    await fsp.rm(outputDir, { recursive: true, force: true });
  }
});

test('successful merge cleanup removes source sidecars and temporary variants but preserves merged output and user clips', async () => {
  const outputDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'br2k-merge-cleanup-'));
  const stem = '123_anchor_20260816_202412';
  const cleanPath = path.join(outputDir, `${stem}.clean.mp4`);
  const mergedPath = path.join(outputDir, `${stem}.merged.mp4`);
  const sourceArtifacts = [
    cleanPath,
    `${cleanPath}.metadata.json`,
    path.join(outputDir, `${stem}.recording.mkv`),
    path.join(outputDir, `${stem}.clean.finalizing.mp4`),
    path.join(outputDir, `${stem}.clean.recovered.tmp.mp4`),
    path.join(outputDir, `${stem}.danmaku.jsonl`),
    path.join(outputDir, `${stem}.danmaku.css`),
    path.join(outputDir, `${stem}.danmaku.ass`),
    path.join(outputDir, `${stem}.danmaku.half.ass`),
    path.join(outputDir, `${stem}.danmaku-only.full.ass`),
    path.join(outputDir, `${stem}.danmaku.half.ass.123.456.tmp`),
    path.join(outputDir, `${stem}.danmaku.tmp.mp4`)
  ];
  const mergedAssPath = path.join(outputDir, `${stem}.merged.danmaku.half.ass`);
  const userClipPath = path.join(outputDir, `${stem}.clean.clip_0_10.danmaku.mp4`);
  const unrelatedPath = path.join(outputDir, 'keep-me.txt');
  try {
    await Promise.all([
      ...sourceArtifacts.map((filePath) => fsp.writeFile(filePath, 'source')),
      fsp.writeFile(mergedPath, 'merged'),
      fsp.writeFile(mergedAssPath, 'merged subtitle'),
      fsp.writeFile(userClipPath, 'user clip'),
      fsp.writeFile(unrelatedPath, 'unrelated')
    ]);
    const service = createMergeTestService();
    service.settings.outputDir = outputDir;
    const room = { id: 'merge-cleanup', title: 'Cleanup', anchor: 'test', recording: false, burning: false };
    const result = await service.cleanupMergedSegmentFiles(
      room,
      [
        {
          cleanPath,
          capturePath: path.join(outputDir, `${stem}.recording.mkv`),
          danmakuPath: path.join(outputDir, `${stem}.danmaku.jsonl`),
          cssPath: path.join(outputDir, `${stem}.danmaku.css`),
          assPath: path.join(outputDir, `${stem}.danmaku.ass`),
          burnedPath: path.join(outputDir, `${stem}.danmaku.mp4`)
        }
      ],
      { cleanPath: mergedPath, mergeOutputPath: mergedPath }
    );

    assert.ok(result.deletedCount >= sourceArtifacts.length);
    for (const filePath of sourceArtifacts) {
      assert.equal(await fsp.stat(filePath).then(() => true).catch(() => false), false, filePath);
    }
    for (const filePath of [mergedPath, mergedAssPath, userClipPath, unrelatedPath]) {
      assert.equal(await fsp.stat(filePath).then(() => true).catch(() => false), true, filePath);
    }
  } finally {
    await fsp.rm(outputDir, { recursive: true, force: true });
  }
});
