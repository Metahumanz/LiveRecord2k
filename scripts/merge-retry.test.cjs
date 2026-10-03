const assert = require('node:assert/strict');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const ffmpegPath = require('ffmpeg-static');

const { LiveRecordService, getMergeSegmentTimingAssessment } = require('../src/server/app/service.cjs');
const { AtomicJsonStore } = require('../src/server/app/atomic-store.cjs');
const { createNormalizeSegmentArgs, createNormalizeEncodedVideoMuxArgs } = require('../src/server/recording/ffmpeg.cjs');
const {
  createFfmpegJobProgress,
  discoverRecordingFiles,
  parseFfmpegProgressTime,
  probeMediaFileInfo,
  probeMediaTimelineInfo,
  runFfmpegJob,
  runCapturedProcess,
  setFfmpegJobPhase,
  setFfmpegJobStageFps,
  updateFfmpegJobPrepareProgress,
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

test('cancelled groups and manual selection survive a real store reload without suppressing the next session', async t => {
  const directory = await fsp.mkdtemp(path.join(os.tmpdir(), 'br2k-cancel-persist-'));
  t.after(() => fsp.rm(directory, { recursive: true, force: true }));
  const app = createMergeTestService(); const room = { id: '883263' }; app.rooms.set(room.id, room);
  const files = [];
  for (let i = 0; i < 4; i++) { const file = path.join(directory, `${i}.clean.mp4`); await fsp.writeFile(file, 'source'); files.push(file); }
  app.recordings = files.map((cleanPath, i) => ({ cleanPath, roomId: room.id, startedAt: i < 2 ? i + 10 : i, valid: true,
    mergeGroup: i < 2 ? 'first-session' : 'second-session', mergeSequence: i % 2 + 1, durationSec: 10, segmentTargetDurationSec: 600 }));
  app.storePath = path.join(directory, 'settings.json'); app.stateStore = new AtomicJsonStore(app.storePath);
  app.saveStore = LiveRecordService.prototype.saveStore;
  room.mergeProgress = { kind: 'merge', id: 'first-job', mergeGroup: 'manual-first-session', status: 'retrying',
    manual: true, sourcePaths: files.slice(0, 2), outputPath: path.join(directory, 'first.merged.mp4') };
  await app.cancelMerge(room.id, 'first-job');
  const restarted = createMergeTestService(); restarted.storePath = app.storePath; restarted.stateStore = new AtomicJsonStore(app.storePath);
  await restarted.loadStore();
  const restored = restarted.getRoom(room.id);
  assert.equal(restored.mergeProgress.status, 'cancelled'); assert.deepEqual(restored.mergeProgress.sourcePaths, files.slice(0, 2));
  assert.equal(restarted.mergeCancelRequests.has(restarted.getMergeRetryKey(room.id, 'manual-first-session')), true);
  assert.equal(restarted.mergeCancelRequests.has(restarted.getMergeRetryKey(room.id, 'first-session')), false);
  assert.equal(restarted.mergeCancelRequests.has(restarted.getMergeRetryKey(room.id, 'second-session')), false);
  assert.equal((await restarted.getPendingMergeGroupForRoom(restored)).mergeGroup, 'second-session');
  assert.equal(restarted.isCancelledMergeSelection(room.id, restarted.recordings.slice(0, 2)), true);
  restarted.clearCancelledMergeSelection(room.id, files.slice(0, 2));
  assert.equal((await restarted.getPendingMergeGroupForRoom(restored)).mergeGroup, 'first-session');
});

test('deterministic A/V timeline failure does not re-encode the whole group again', () => {
  const app = createMergeTestService();
  const room = { id: '883263', mergeProgress: { kind: 'merge', mergeGroup: 'session', status: 'error' } };
  const error = Object.assign(new Error('合并后音画时长不一致'), { code: 'MERGE_AV_TIMELINE_UNSAFE' });
  assert.equal(app.scheduleMergeRetry(room, 'session', {}, error), false);
  assert.equal(app.mergeRetryStates.size, 0);
});

test('automatic cancellation survives restart and explicit retry releases only the selected session', async t => {
  const directory = await fsp.mkdtemp(path.join(os.tmpdir(), 'br2k-auto-cancel-retry-'));
  t.after(() => fsp.rm(directory, { recursive: true, force: true }));
  const app = createMergeTestService(), room = { id: '883263', recording: false };
  app.rooms.set(room.id, room);
  app.storePath = path.join(directory, 'settings.json'); app.stateStore = new AtomicJsonStore(app.storePath);
  app.saveStore = LiveRecordService.prototype.saveStore;
  const files = [0, 1].map(i => path.join(directory, `segment${i}.clean.mp4`));
  await Promise.all(files.map(file => fsp.writeFile(file, 'source')));
  app.recordings = files.map((cleanPath, index) => ({ cleanPath, roomId: room.id, valid: true,
    mergeGroup: 'cancelled-session', mergeSequence: index + 1, startedAt: index + 1,
    mergeOutputPath: path.join(directory, 'merged.mp4'), durationSec: 10, segmentTargetDurationSec: 600 }));
  room.mergeProgress = { kind: 'merge', id: 'auto-job', status: 'retrying', mergeGroup: 'cancelled-session' };
  await app.cancelMerge(room.id, 'auto-job');
  const restarted = createMergeTestService(); restarted.storePath = app.storePath; restarted.stateStore = new AtomicJsonStore(app.storePath);
  await restarted.loadStore();
  assert.equal(restarted.getRoom(room.id).mergeProgress.status, 'cancelled');
  assert.equal(await restarted.getPendingMergeGroupForRoom(restarted.getRoom(room.id)), null);
  const otherKey = restarted.getMergeRetryKey(room.id, 'another-session'); restarted.mergeCancelRequests.add(otherKey);
  let retriedGroup;
  restarted.finalizeReconnectGroup = async (_room, group) => { retriedGroup = group; };
  await restarted.retryMerge(room.id, 'cancelled-session');
  assert.equal(retriedGroup, 'cancelled-session');
  assert.equal(restarted.mergeCancelRequests.has(restarted.getMergeRetryKey(room.id, 'cancelled-session')), false);
  assert.equal(restarted.mergeCancelRequests.has(otherKey), true);
  assert.equal(restarted.getRoom(room.id).cancelledMergeProgress, undefined);
});

test('disk space failures retain their reason and do not repeatedly retry an unchanged merge', () => {
  for (const code of ['BR2K_DISK_SPACE_INSUFFICIENT', 'ENOSPC']) {
    const app = createMergeTestService();
    const room = { id: '883263', mergeProgress: { kind: 'merge', mergeGroup: 'session', status: 'error', message: '空间不足，源分段保留' } };
    const error = Object.assign(new Error('空间不足'), { code });
    assert.equal(app.scheduleMergeRetry(room, 'session', {}, error), false);
    assert.equal(app.mergeRetryStates.size, 0);
    assert.equal(room.mergeProgress.message, '空间不足，源分段保留');
  }
});

test('a retry in another group displays its own output path rather than the previous completed merge', () => {
  const app = createMergeTestService(); const room = { id: '883263', mergeProgress: {
    kind: 'merge', status: 'completed', mergeGroup: 'first-session', outputPath: 'first.merged.mp4' } };
  app.getMergeRetryDelayMs = () => 60000;
  app.scheduleMergeRetry(room, 'second-session', { cleanPath: 'second.clean.mp4', mergeOutputPath: 'second.merged.mp4' }, new Error('retry'));
  assert.equal(room.mergeProgress.outputPath, 'second.merged.mp4'); assert.equal(room.mergeProgress.mergeGroup, 'second-session');
  app.clearMergeRetryStatesForRoom(room.id);
});

test('service shutdown does not persist an interruption as a user cancellation', async () => {
  const app = createMergeTestService(); const room = { id: '883263' }; app.rooms.set(room.id, room);
  const progress = createFfmpegJobProgress({ kind: 'merge', durationSec: 60, roomId: room.id });
  progress.mergeGroup = 'not-user-cancelled'; room.mergeProgress = progress;
  const lease = await app.acquireMergeMediaLease(room, progress, { preferred: 'libx264', requiresTranscode: true });
  app.draining = true; await app.mediaJobs.shutdown();
  assert.equal(app.mergeCancelRequests.size, 0);
  assert.equal(app.mergePreemptRequests.has(app.getMergeRetryKey(room.id, progress.mergeGroup)), true);
  lease.release();
});

test('cancelling one live session does not suppress finalization of a later single-segment session', async () => {
  const app = createMergeTestService();
  const room = { id: '883263', mergeProgress: { kind: 'merge', id: 'old-job', mergeGroup: 'first-session', status: 'cancelled' } };
  app.rooms.set(room.id, room);
  app.mergeCancelRequests.add(app.getMergeRetryKey(room.id, 'first-session'));
  const recording = { cleanPath: 'second-session.mp4', liveSessionId: 'second-session', eventCount: 0, valid: true };
  app.mergeReconnectGroupIfNeeded = async (_room, group) => { assert.equal(group, 'second-session'); return recording; };
  let finalized;
  app.finalizeLiveDiagnostics = async (_room, output) => { finalized = output; };
  assert.equal(await app.finalizeReconnectGroup(room, 'second-session', recording), recording);
  assert.equal(finalized, recording);
});

test('cancelling the displayed retry leaves other live-session retries intact and rejects a stale button', async t => {
  const app = createMergeTestService();
  const room = { id: '883263' }; app.rooms.set(room.id, room);
  app.getMergeRetryDelayMs = () => 40;
  t.after(() => app.clearMergeRetryStatesForRoom(room.id));
  const retried = [];
  app.finalizeReconnectGroup = async (_room, group) => retried.push(group);
  app.scheduleMergeRetry(room, 'second-session', {}, new Error('temporary failure'));
  app.scheduleMergeRetry(room, 'first-session', {}, new Error('temporary failure'));
  const job = room.mergeProgress.id;
  await assert.rejects(app.cancelMerge(room.id, 'stale-job'), error => error.code === 'MERGE_TASK_CHANGED');
  await app.cancelMerge(room.id, job);
  assert.equal(app.mergeRetryStates.has(app.getMergeRetryKey(room.id, 'second-session')), true);
  await waitFor(() => retried.length === 1);
  assert.deepEqual(retried, ['second-session']);
});

test('same-room merge groups serialize and an older cancellation cannot stop a later group', async () => {
  const app = createMergeTestService(); const room = { id: '883263' }; app.rooms.set(room.id, room);
  let unblock; const gate = new Promise(resolve => { unblock = resolve; });
  const started = [];
  app.performMergeReconnectGroup = async (_room, group) => { started.push(group); if (group === 'first') await gate; return group; };
  const first = app.mergeReconnectGroupIfNeededInternal(room, 'first', {});
  const second = app.mergeReconnectGroupIfNeededInternal(room, 'second', {});
  await waitFor(() => started.length === 1);
  app.mergeCancelRequests.add(app.getMergeRetryKey(room.id, 'first'));
  unblock();
  assert.equal(await first, 'first'); assert.equal(await second, 'second');
  assert.deepEqual(started, ['first', 'second']); assert.equal(app.mergeRoomTasks.size, 0);
});

test('recording preemption yields resources without marking a user cancellation and can retry the manual selection', async t => {
  const app = createMergeTestService(); const room = { id: '883263' }; app.rooms.set(room.id, room);
  const progress = createFfmpegJobProgress({ kind: 'merge', durationSec: 60, roomId: room.id });
  progress.mergeGroup = 'manual-first'; progress.manual = true; room.mergeProgress = progress;
  const lease = await app.acquireMergeMediaLease(room, progress, { preferred: 'libx264', requiresTranscode: true });
  const releaseRecording = app.mediaJobs.registerExternal({ id: 'recording:883263:new-session', type: 'recording', resource: 'recording' });
  t.after(() => { lease.release(); releaseRecording(); app.clearMergeRetryStatesForRoom(room.id); });
  const key = app.getMergeRetryKey(room.id, progress.mergeGroup);
  assert.equal(app.mergeCancelRequests.has(key), false); assert.equal(app.mergePreemptRequests.has(key), true);
  await assert.rejects(app.runMergePreparationStage(room, progress, '检查', async () => {}), error => error.code === 'MERGE_PREEMPTED');
  app.mergePreemptRequests.delete(key); lease.release();
  const selected = { segments: [{ cleanPath: 'one' }, { cleanPath: 'two' }], outputPath: 'same-target.mp4' };
  let retried;
  app.mergeReconnectGroupIfNeededInternal = async (_room, group, _fallback, options) => { retried = { group, options }; };
  const error = Object.assign(new Error('yield'), { code: 'MERGE_PREEMPTED' });
  assert.equal(app.scheduleMergeRetry(room, 'manual-first', {}, error, { manualOptions: selected }), true);
  assert.match(room.mergeProgress.message, /录制优先/);
  await waitFor(() => retried);
  assert.equal(retried.group, 'manual-first'); assert.equal(retried.options, selected);
});

test('Jetson merge rejects a mux that would overwrite its video input before launching FFmpeg', () => {
  assert.throws(() => createNormalizeEncodedVideoMuxArgs({ encodedVideoPath: 'same.mkv', outputPath: './same.mkv' }), /同一路径/);
});

for (const destinationStaging of [false, true]) test(`Jetson cross-resolution merge uses separate video and mux files on ${destinationStaging ? 'the output disk when local space is insufficient' : 'a local workspace'}`, async t => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'br2k-jetson-mux-'));
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));
  const app = createMergeTestService();
  app.ffmpegPath = ffmpegPath;
  app.settings.outputDir = dir;
  const room = { id: '883263', recording: false };
  app.rooms.set(room.id, room);
  app.getMergeEncoderPlan = () => ({ preferred: 'h264_nvv4l2', fallback: '', software: '' });
  app.getLinuxRecordingRootMount = async () => ({ fsType: 'cifs', mountPoint: dir });
  if (destinationStaging) {
    const originalStat = fsp.stat.bind(fsp);
    t.mock.method(fsp, 'statfs', async name => ({ bavail: (String(name).startsWith(dir) ? 100 : 2) * 1024 ** 3 / 4096,
      bsize: 4096, blocks: 100 * 1024 ** 3 / 4096 }));
    t.mock.method(fsp, 'stat', async name => {
      const result = await originalStat(name);
      result.dev = String(name).startsWith(dir) ? 2 : 1;
      return result;
    });
  }
  const progressSamples = [];
  app.markRoomDirty = () => { if (room.mergeProgress) progressSamples.push({ ...room.mergeProgress }); };
  const originals = [];
  for (let i = 0; i < 2; i++) {
    const cleanPath = path.join(dir, `883263_test_20260926_22275${i + 3}.clean.mp4`);
    const generated = await runCapturedProcess(ffmpegPath, ['-y', '-f', 'lavfi', '-i', `testsrc2=size=${i ? '640x360' : '320x180'}:rate=30:duration=1`,
      '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=1', '-c:v', 'libx264', '-c:a', 'aac', '-shortest', cleanPath], { timeoutMs: 20_000 });
    assert.equal(generated.status, 0, generated.stderr);
    originals.push(cleanPath);
    app.recordings.push({ cleanPath, roomId: room.id, startedAt: i + 1, durationSec: 1, valid: true });
  }
  let attempts = 0;
  let mediaWorkspace;
  app.runJetsonGstreamerTranscode = async options => {
    attempts++;
    const mux = options.createMuxArgs();
    const source = mux[mux.indexOf('-i', mux.indexOf('-i') + 1) + 1];
    assert.notEqual(path.resolve(options.encodedVideoPath), path.resolve(mux.at(-1)));
    assert.equal(path.basename(options.encodedVideoPath), `${String(attempts).padStart(3, '0')}.video.mkv`);
    mediaWorkspace = path.dirname(path.dirname(options.encodedVideoPath));
    assert.ok(mediaWorkspace.includes(destinationStaging ? '.br2k-merge-media-' : 'br2k-merge-publish-'));
    if (destinationStaging) assert.equal(path.dirname(mediaWorkspace), dir);
    const encoded = await runCapturedProcess(ffmpegPath, ['-y', '-i', source, '-an', '-vf', `scale=${options.width}:${options.height}`,
      '-c:v', 'libx264', '-preset', 'ultrafast', '-bf', '0', options.encodedVideoPath], { timeoutMs: 20_000 });
    assert.equal(encoded.status, 0, encoded.stderr);
    options.onPhase?.('render');
    options.onStderr?.('out_time_us=900000');
    const renderPercent = Number(room.mergeProgress?.percent || 0);
    options.onPhase?.('mux');
    options.onStderr?.('out_time_us=100000');
    assert.ok(Number(room.mergeProgress?.percent || 0) >= renderPercent, 'audio mux progress must not rewind the merged video progress');
    await runFfmpegJob(ffmpegPath, mux, options.onStderr, { onChild: options.onChild });
  };
  await app.mergeSelectedRecordings({ cleanPaths: originals });
  const result = await [...app.mergeInFlightGroups.values()][0];
  assert.equal(attempts, 2);
  assert.ok(progressSamples.some(sample => sample.phase === 'render' && sample.phaseCurrentTimeSec > 0), 'normalization media PTS never reached the progress fields');
  assert.ok(progressSamples.some(sample => sample.phase === 'mux' && sample.phaseCurrentTimeSec > 0), 'concat media PTS never reached the progress fields');
  assert.equal((await probeMediaFileInfo(ffmpegPath, result.cleanPath)).videoInfo.width, 640);
  for (const source of originals) assert.ok((await fsp.stat(source)).size);
  await assert.rejects(fsp.stat(mediaWorkspace), { code: 'ENOENT' });
});

test('manual selection merges complete segments chronologically and preserves source files and rows', async t => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'br2k-manual-merge-'));
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));
  const app = createMergeTestService();
  app.ffmpegPath = ffmpegPath;
  app.settings.outputDir = dir;
  const room = { id: '883263', title: '今天的直播标题', recording: false };
  app.rooms.set(room.id, room);
  for (let index = 0; index < 2; index++) {
    const cleanPath = path.join(dir, `883263_真栗_20260926_22275${index + 3}.clean.mp4`);
    const result = await runCapturedProcess(ffmpegPath, ['-hide_banner', '-loglevel', 'error', '-y',
      '-f', 'lavfi', '-i', `testsrc2=size=320x180:rate=30:duration=1`,
      '-f', 'lavfi', '-i', `sine=frequency=${440 + index * 220}:sample_rate=48000:duration=1`,
      '-c:v', 'libx264', '-c:a', 'aac', '-shortest', cleanPath], { timeoutMs: 20_000 });
    assert.equal(result.status, 0, result.stderr);
    const danmakuPath = path.join(dir, `${index}.danmaku.jsonl`);
    await fsp.writeFile(danmakuPath, JSON.stringify({ type: 'danmaku', time: 0.2, text: `分段${index}`, uid: index }) + '\n');
    app.recordings.push({ cleanPath, danmakuPath, roomId: '', startedAt: index + 1,
      roomTitle: index === 0 ? '录制时的原始标题' : '同场后来修改的标题',
      durationSec: 1, segmentTargetDurationSec: 1, valid: true, eventCount: 1 });
  }
  const original = [...app.recordings];
  app.mergeCancelRequests.add(app.getMergeRetryKey(room.id, 'previous-cancelled-session'));
  await app.mergeSelectedRecordings({ cleanPaths: original.map(row => row.cleanPath).reverse() });
  const task = [...app.mergeInFlightGroups.values()][0];
  assert.ok(task);
  const merged = await task;
  assert.deepEqual(merged.mergedFrom, original.map(row => row.cleanPath));
  assert.equal(merged.roomTitle, '录制时的原始标题');
  assert.equal(room.title, '今天的直播标题');
  assert.ok((await probeMediaFileInfo(ffmpegPath, merged.cleanPath)).videoInfo);
  assert.equal(app.recordings.length, 3);
  for (const row of original) assert.ok((await fsp.stat(row.cleanPath)).size > 0);
  assert.equal(app.pendingSegmentCleanups.size, 0);
  const rescanned = await discoverRecordingFiles(dir, { ffmpegPath });
  assert.ok(rescanned.some(row => row.cleanPath === merged.cleanPath), 'manual output disappeared after refreshing the library');
  assert.equal(rescanned.find(row => row.cleanPath === merged.cleanPath).roomTitle, '录制时的原始标题');
  const events = (await fsp.readFile(merged.danmakuPath, 'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(events.length, 2);
  assert.ok(events[1].time > events[0].time);
});

test('mixed merge transcodes only incompatible segments and validates original-to-encoded boundaries', async t => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'br2k-selective-merge-'));
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));
  const app = createMergeTestService(); app.ffmpegPath = ffmpegPath; app.settings.outputDir = dir;
  app.getMergeEncoderPlan = () => ({ preferred: 'libx264', fallback: '' });
  const room = { id: '883263', recording: false }; app.rooms.set(room.id, room);
  const messages = []; app.log = (_level, message) => messages.push(message);
  let sawReducedEtaHorizon = false;
  app.markRoomDirty = () => {
    const progress = room.mergeProgress;
    if (progress?.phase === 'render' && progress.stageLabel?.includes('规范化') &&
        progress.phaseDurationSec < progress.durationSec) sawReducedEtaHorizon = true;
  };
  for (let i = 0; i < 3; i++) {
    const cleanPath = path.join(dir, `883263_selective_20261004_00000${i}.clean.mp4`);
    const generated = await runCapturedProcess(ffmpegPath, ['-hide_banner', '-loglevel', 'error', '-y',
      '-f', 'lavfi', '-i', `testsrc2=size=${i === 1 ? '320x180' : '640x360'}:rate=30:duration=1`,
      '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=1',
      '-c:v', 'libx264', '-bf', '0', '-c:a', 'aac', '-ac', '2', '-shortest', cleanPath], { timeoutMs: 20000 });
    assert.equal(generated.status, 0, generated.stderr);
    const media = await probeMediaFileInfo(ffmpegPath, cleanPath);
    const timing = await probeMediaTimelineInfo(ffmpegPath, cleanPath, media);
    app.recordings.push({ cleanPath, roomId: room.id, startedAt: i + 1, durationSec: media.durationSec,
      valid: true, timelineHealth: { ...timing, avStartDeltaSec: 0, avEndDeltaSec: timing.avDeltaSec } });
  }
  const sourcePaths = app.recordings.map(r => r.cleanPath);
  await app.mergeSelectedRecordings({ cleanPaths: sourcePaths, deleteSources: false });
  const merged = await [...app.mergeInFlightGroups.values()][0];
  assert(merged?.cleanPath);
  assert.equal(messages.filter(m => m.includes('复用源视频及音频')).length, 2, messages.join('\n'));
  assert(sawReducedEtaHorizon, '规范化 ETA 不应把无需重编码的分段计为渲染工作量');
  const media = await probeMediaFileInfo(ffmpegPath, merged.cleanPath);
  const timing = await probeMediaTimelineInfo(ffmpegPath, merged.cleanPath, media);
  assert(timing.timingSafeForCopy, JSON.stringify(timing));
  assert.equal(media.videoInfo.width, 640);
  for (const file of sourcePaths) assert((await fsp.stat(file)).size > 0);
});

test('manual selection rejects duplicate, cross-room and unfinished inputs', async () => {
  const app = createMergeTestService();
  app.recordings = [{ cleanPath: 'one.mp4', roomId: 'one', valid: true },
    { cleanPath: 'two.mp4', roomId: 'two', valid: true }];
  await assert.rejects(app.mergeSelectedRecordings({ cleanPaths: ['one.mp4', 'one.mp4'] }), error => error.code === 'MERGE_SELECTION_INVALID');
  await assert.rejects(app.mergeSelectedRecordings({ cleanPaths: ['one.mp4', 'two.mp4'] }), error => error.code === 'MERGE_ROOM_MISMATCH');
  app.recordings[1].roomId = 'one';
  app.recordings[1].containerStage = 'capturing';
  await assert.rejects(app.mergeSelectedRecordings({ cleanPaths: ['one.mp4', 'two.mp4'] }), error => error.code === 'MERGE_SOURCE_INVALID');
});

test('manual retry clears cancellation and retries the displayed group rather than a newer group', async () => {
  const app = createMergeTestService();
  const room = { id: 'retry-display', recording: false, mergeProgress: { kind: 'merge', status: 'error', mergeGroup: 'old-group' } };
  app.rooms.set(room.id, room);
  app.mergeCancelRequests.add(app.getMergeRetryKey(room.id, 'old-group'));
  app.getPendingMergeGroupForRoom = async (_room, preferred) => {
    assert.equal(preferred, 'old-group');
    return { mergeGroup: preferred, fallbackRecording: {} };
  };
  let called = false;
  app.finalizeReconnectGroup = async (_room, group) => {
    called = true;
    assert.equal(group, 'old-group');
    assert.equal(app.mergeCancelRequests.has(app.getMergeRetryKey(room.id, 'old-group')), false);
  };
  await app.retryMerge(room.id);
  assert.equal(called, true);
});

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

test('a source PTS boundary offset is advisory when measured A/V duration remains in sync', () => {
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

  assert.equal(delayedAudio.requiresNormalization, false);
  assert.equal(delayedAudio.requiresPostMergeVerification, true);
  assert.match(delayedAudio.reason, /PTS/);
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

test('render ETA uses media-time samples at a constant 2x speed', () => {
  const originalNow = Date.now;
  let now = 1_000_000;
  Date.now = () => now;
  try {
    const progress = createFfmpegJobProgress({
      kind: 'burn',
      label: 'burn',
      durationSec: 120,
      sourceFps: 60
    });
    setFfmpegJobPhase(progress, 'render', { now });
    for (const mediaTime of [0, 2, 4, 6]) {
      now += 1_000;
      updateFfmpegJobProgress(progress, `out_time_us=${mediaTime * 1_000_000}`);
    }
    assert.equal(progress.etaState, 'ready');
    assert.equal(progress.realtimeFactor, 2);
    assert.equal(progress.renderFps, 120);
    assert.equal(Math.round(progress.phaseEstimatedRemainingSec), 57);
  } finally {
    Date.now = originalNow;
  }
});

test('render EWMA smooths a 1x to 3x speed change instead of jumping', () => {
  const originalNow = Date.now;
  let now = 2_000_000;
  Date.now = () => now;
  try {
    const progress = createFfmpegJobProgress({ kind: 'export', label: 'cuda', durationSec: 120 });
    setFfmpegJobPhase(progress, 'render', { now });
    for (const mediaTime of [0, 1, 2, 3]) {
      now += 1_000;
      updateFfmpegJobProgress(progress, `out_time_us=${mediaTime * 1_000_000}`);
    }
    assert.equal(progress.realtimeFactor, 1);
    for (const mediaTime of [6, 9, 12, 15]) {
      now += 1_000;
      updateFfmpegJobProgress(progress, `out_time_us=${mediaTime * 1_000_000}`);
    }
    assert.ok(progress.realtimeFactor > 1 && progress.realtimeFactor < 3);
    for (const mediaTime of [18, 21, 24, 27, 30, 33]) {
      now += 1_000;
      updateFfmpegJobProgress(progress, `out_time_us=${mediaTime * 1_000_000}`);
    }
    assert.ok(progress.realtimeFactor > 2 && progress.realtimeFactor < 3);
  } finally {
    Date.now = originalNow;
  }
});

test('prepare ETA is object-count based and does not contaminate render samples', () => {
  const originalNow = Date.now;
  let now = 3_000_000;
  Date.now = () => now;
  try {
    const progress = createFfmpegJobProgress({ kind: 'export', label: 'cuda', durationSec: 120 });
    for (const prepared of [0, 100, 200, 300]) {
      now += 1_000;
      updateFfmpegJobPrepareProgress(progress, prepared, 600, now);
    }
    assert.equal(progress.phase, 'prepare');
    assert.equal(progress.etaState, 'ready');
    assert.equal(Math.round(progress.phaseEstimatedRemainingSec), 3);
    setFfmpegJobPhase(progress, 'render', { now });
    now += 1_000;
    updateFfmpegJobProgress(progress, 'out_time_us=1000000');
    assert.equal(progress.etaState, 'estimating');
    assert.equal(progress.phaseEstimatedRemainingSec, null);
  } finally {
    Date.now = originalNow;
  }
});

test('fallback resets render ETA samples', () => {
  const originalNow = Date.now;
  let now = 4_000_000;
  Date.now = () => now;
  try {
    const progress = createFfmpegJobProgress({ kind: 'export', label: 'cuda', durationSec: 60 });
    setFfmpegJobPhase(progress, 'render', { now });
    for (const mediaTime of [0, 2, 4, 6]) {
      now += 1_000;
      updateFfmpegJobProgress(progress, `out_time_us=${mediaTime * 1_000_000}`);
    }
    assert.equal(progress.etaState, 'ready');
    setFfmpegJobPhase(progress, 'render', { now, force: true });
    now += 1_000;
    updateFfmpegJobProgress(progress, 'out_time_us=1000000');
    assert.equal(progress.etaState, 'estimating');
    assert.equal(progress.phaseEstimatedRemainingSec, null);
  } finally {
    Date.now = originalNow;
  }
});

test('stage FPS is diagnostics only and never creates an ETA', () => {
  const progress = createFfmpegJobProgress({
    kind: 'export',
    label: 'cuda',
    outputPath: '/tmp/cuda.mp4',
    durationSec: 3600,
    sourceFps: 60
  });
  assert.equal(setFfmpegJobStageFps(progress, { decode: 132, scene: 120, encode: 120, total: 120 }), true);
  assert.equal(progress.renderFps, null);
  assert.equal(progress.realtimeFactor, null);
  assert.equal(progress.estimatedRemainingSec, null);
  assert.equal(progress.stageFps.total, 120);
});

test('mux out_time starts at zero without rewinding completed render progress', () => {
  const originalNow = Date.now;
  let now = 5_000_000;
  Date.now = () => now;
  try {
    const progress = createFfmpegJobProgress({ kind: 'export', label: 'cuda', durationSec: 60 });
    setFfmpegJobPhase(progress, 'render', { now });
    now += 4_000;
    updateFfmpegJobProgress(progress, 'out_time_us=60000000');
    assert.equal(progress.currentTimeSec, 60);
    setFfmpegJobPhase(progress, 'mux', { now });
    now += 1_000;
    updateFfmpegJobProgress(progress, 'out_time_us=0');
    assert.equal(progress.currentTimeSec, 60);
    assert.equal(progress.percent, 100);
    assert.equal(progress.phaseCurrentTimeSec, 0);
    assert.equal(progress.phasePercent, 0);
  } finally {
    Date.now = originalNow;
  }
});

test('render reaching 100% while mux runs is still not completed', () => {
  const progress = createFfmpegJobProgress({ kind: 'export', label: 'cuda', durationSec: 60 });
  setFfmpegJobPhase(progress, 'render', { now: Date.now() });
  updateFfmpegJobProgress(progress, 'out_time_us=60000000');
  setFfmpegJobPhase(progress, 'mux', { now: Date.now() });
  assert.equal(progress.status, 'running');
  assert.equal(progress.percent, 100);
  assert.equal(progress.phase, 'mux');
  assert.notEqual(progress.status, 'completed');
});

test('insufficient render samples stay in estimating state', () => {
  const originalNow = Date.now;
  let now = 6_000_000;
  Date.now = () => now;
  try {
    const progress = createFfmpegJobProgress({ kind: 'export', label: 'cuda', durationSec: 60 });
    setFfmpegJobPhase(progress, 'render', { now });
    now += 1_000;
    updateFfmpegJobProgress(progress, 'out_time_us=1000000');
    now += 1_000;
    updateFfmpegJobProgress(progress, 'out_time_us=2000000');
    assert.equal(progress.etaState, 'estimating');
    assert.equal(progress.phaseEstimatedRemainingSec, null);
  } finally {
    Date.now = originalNow;
  }
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
    const waitForLease = service.acquireMergeMediaLease(room, progress, { preferred: 'libx264', requiresTranscode: true }).then(
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

test('real merge keeps a PTS-origin-only source segment on the fast copy path and verifies A/V safety', async () => {
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
    assert.ok(logs.some((message) => /仅 PTS 起点偏移不会再触发规范化重编码/.test(message)), logs.join('\n'));
    assert.ok(logs.some((message) => /快速无损合并/.test(message)), logs.join('\n'));
  } finally {
    await fsp.rm(outputDir, { recursive: true, force: true });
  }
});

test('full-length recording segments are merge boundaries while adjacent incomplete reconnect segments remain eligible', async () => {
  const outputDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'br2k-merge-boundary-'));
  const paths = ['first.clean.mp4', 'second.clean.mp4', 'tail.clean.mp4'].map((name) => path.join(outputDir, name));
  try {
    await Promise.all(paths.map((filePath) => fsp.writeFile(filePath, 'source')));
    const service = createMergeTestService();
    const room = { id: 'merge-boundary', title: 'Boundary', anchor: 'test', recording: false };
    service.rooms.set(room.id, room);
    service.recordings = paths.map((cleanPath, index) => ({
      roomId: room.id,
      mergeGroup: 'boundary-group',
      mergeSequence: index + 1,
      startedAt: index + 1,
      cleanPath,
      mergeOutputPath: path.join(outputDir, 'session.merged.mp4'),
      durationSec: index < 2 ? 3600 : 1200,
      segmentTargetDurationSec: 3600,
      valid: true
    }));

    assert.equal(await service.getPendingMergeGroupForRoom(room), null);
    const result = await service.mergeReconnectGroupIfNeeded(room, 'boundary-group', service.recordings[2]);
    assert.equal(result, service.recordings[2]);

    service.recordings[0].durationSec = 120;
    service.recordings[1].durationSec = 180;
    service.recordings[2].durationSec = 240;
    service.recordings.forEach((recording) => {
      recording.segmentTargetDurationSec = 600;
    });
    const pending = await service.getPendingMergeGroupForRoom(room);
    assert.equal(pending?.mergeGroup, 'boundary-group');
    assert.equal(pending?.fallbackRecording.cleanPath, paths[2]);
    await fsp.writeFile(pending.fallbackRecording.mergeOutputPath, 'incomplete prior merge');
    service.ffmpegPath = ffmpegPath;
    assert.equal((await service.getPendingMergeGroupForRoom(room))?.mergeGroup, 'boundary-group',
      'an existing invalid output must not hide preserved source segments from retry');
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
