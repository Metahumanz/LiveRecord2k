'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs/promises'), os = require('node:os'), path = require('node:path');
const { planResolutionMergeGroups } = require('../src/server/recording/merge-resolution-groups.cjs');
const { LiveRecordService } = require('../src/server/app/service.cjs');
const { runCapturedProcess, probeMediaFileInfo, discoverRecordingFiles } = require('../src/server/shared/helpers.cjs');
const ffmpeg = require('ffmpeg-static');

test('grouping preserves adjacency and isolates unknown or changing streams instead of globally sorting resolutions', () => {
  const segments = Array.from({ length: 8 }, (_, i) => ({ cleanPath: String(i) }));
  const info = width => ({ videoInfo: { codec: 'h264', width, height: width * 9 / 16, rFrameRate: '60/1' },
    audioInfo: { codec: 'aac', sampleRate: 48000, channelLayout: 'stereo' } });
  const media = [info(3840), info(3840), info(2560), info(2560), info(3840), info(3840), info(3840), {}];
  media[5].streamHeaders = { parameterSetsStable: false };
  const plan = planResolutionMergeGroups(segments, media);
  assert.deepEqual(plan.groups.map(g => g.sourcePaths), [['0', '1'], ['2', '3'], ['4'], ['5'], ['6'], ['7']]);
  assert.equal(plan.groups[3].action, 'keep'); assert.match(plan.groups[3].reason, /段内/);
  assert.equal(plan.groups.at(-1).label, '分辨率未知');
  assert.equal(planResolutionMergeGroups(segments.slice(0, 2), [info(3840), { ...info(3840), videoInfo: { ...info(3840).videoInfo, rFrameRate: '30/1' } }]).groups.length, 2);
});

for (const deleteSources of [false, true]) test(`${deleteSources ? 'manual grouping with cleanup' : 'automatic grouping'} publishes separate copy outputs and retains singleton inputs after rescan`, async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'br2k-resolution-groups-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const app = new LiveRecordService(); app.ffmpegPath = ffmpeg; app.settings.outputDir = dir; app.settings.autoBurnDanmaku = false;
  app.log = (_level, message) => logs.push(message); app.emitState = () => {}; app.saveStore = async () => {};
  app.scheduleQueuedUpdateCheck = () => {}; app.finalizeLiveDiagnostics = async () => {};
  app.getMergeEncoderPlan = () => ({ preferred: 'libx264', fallback: '' });
  const logs = [], room = { id: '883263', recording: false }; app.rooms.set(room.id, room);
  for (const [i, width] of [640, 640, 320, 320, 640].entries()) {
    const cleanPath = path.join(dir, `883263_sample_20261016_00000${i}.clean.mp4`);
    const generated = await runCapturedProcess(ffmpeg, ['-v', 'error', '-y', '-f', 'lavfi', '-i', `testsrc2=size=${width}x${width * 9 / 16}:rate=30:duration=2`,
      '-f', 'lavfi', '-i', 'sine=sample_rate=48000:duration=2', '-c:v', 'libx264', '-bf', '0', '-c:a', 'aac', '-ac', '2', '-shortest', cleanPath], { timeoutMs: 20000 });
    assert.equal(generated.status, 0, generated.stderr);
    const info = await probeMediaFileInfo(ffmpeg, cleanPath), danmakuPath = cleanPath.replace('.clean.mp4', '.danmaku.jsonl');
    await fs.writeFile(danmakuPath, JSON.stringify({ type: 'danmaku', time: 0.5, text: '分组'+i, uid: i+1 })+'\n');
    app.recordings.push({ cleanPath, danmakuPath, roomId: room.id, startedAt: 1000+i*3000, durationSec: info.durationSec,
      videoInfo: info.videoInfo, mergeGroup: 'session', mergeSequence: i, valid: true, eventCount: 1 });
  }
  const sources = [...app.recordings];
  let result;
  if (deleteSources) {
    await app.mergeSelectedRecordings({ cleanPaths: sources.map(row => row.cleanPath), deleteSources: true, resolutionMode: 'groups' });
    result = await [...app.mergeInFlightGroups.values()][0];
  } else result = await app.mergeReconnectGroupIfNeeded(room, 'session', sources.at(-1));
  assert.equal(result.mergeResults.length, 3);
  const outputs = result.mergeResults.filter(row => row.mergedFrom?.length);
  assert.equal(outputs.length, 2); assert.equal(path.dirname(outputs[0].cleanPath), path.dirname(outputs[1].cleanPath));
  assert.notEqual(path.dirname(outputs[0].cleanPath), dir);
  assert.equal(result.mergeResults.at(-1).cleanPath, sources.at(-1).cleanPath);
  assert.equal(result.mergeResults.at(-1).resolutionMerge.retained, true);
  assert(!logs.some(line => /需要重编码|原生性能|CPU 解码/.test(line)), logs.join('\n'));
  for (const output of outputs) {
    const media = await probeMediaFileInfo(ffmpeg, output.cleanPath);
    assert.equal(media.videoInfo.width, output.mergedFrom.includes(sources[0].cleanPath) ? 640 : 320);
    assert.equal((await fs.readFile(output.danmakuPath, 'utf8')).trim().split('\n').length, 2);
  }
  for (const source of sources) assert.equal(await fs.stat(source.cleanPath).then(() => true, error => {
    if (error.code === 'ENOENT') return false; throw error;
  }), !deleteSources || source === sources.at(-1));
  const manifest = JSON.parse(await fs.readFile(path.join(path.dirname(outputs[0].cleanPath), '合并清单.json')));
  assert.equal(manifest.status, 'completed'); assert.equal(manifest.parts.length, 3);
  assert.equal(await app.getPendingMergeGroupForRoom(room), null);
  app.recordings = (await discoverRecordingFiles(dir, { ffmpegPath: ffmpeg })).map(row => app.normalizeRecording(row));
  assert(app.recordings.some(row => row.cleanPath === sources.at(-1).cleanPath && row.resolutionMerge?.retained));
  assert.equal(await app.getPendingMergeGroupForRoom(room), null);
  const tail = app.recordings.find(row => row.cleanPath === sources.at(-1).cleanPath);
  const nextPath = path.join(dir, '883263_sample_20261016_000005.clean.mp4');
  await fs.copyFile(tail.cleanPath, nextPath);
  app.recordings.push({ ...tail, cleanPath: nextPath, startedAt: tail.startedAt+3000, mergeSequence: 5, resolutionMerge: null });
  assert.deepEqual((await app.getPendingMergeGroupForRoom(room)).sourcePaths, [tail.cleanPath, nextPath]);
});

test('cancelling a resolution batch stops later groups and leaves every source intact', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'br2k-group-cancel-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const app = new LiveRecordService(); app.settings.outputDir = dir; app.log = () => {}; app.emitState = () => {};
  const room = { id: '1' }, sources = [];
  for (let i = 0; i < 4; i++) { const file = path.join(dir, i+'.mp4'); await fs.writeFile(file, 'original'); sources.push({ cleanPath: file }); }
  let calls = 0;
  app.performMergeReconnectGroup = async () => { calls++; app.mergeCancelRequests.add(app.getMergeRetryKey(room.id, 'g')); return null; };
  const plan = { groups: [{ index: 1, label: '4K', indices: [0,1], action: 'merge' }, { index: 2, label: '2K', indices: [2,3], action: 'merge' }] };
  assert.equal(await app.performResolutionMergeGroups(room, 'g', sources, plan, path.join(dir, 'base.mp4'), {}, null), null);
  assert.equal(calls, 1);
  for (const source of sources) assert.equal(await fs.readFile(source.cleanPath, 'utf8'), 'original');
});

test('a stable retained tail can merge with later arrivals, while a published intervening group remains a boundary', () => {
  const app = new LiveRecordService();
  const early = { roomId: '1', cleanPath: 'early.mp4', startedAt: 1000, durationSec: 2,
    resolutionMerge: { retained: true, reason: '' } };
  const later = { roomId: '1', cleanPath: 'later.mp4', startedAt: 8000, durationSec: 2 };
  app.recordings = [early, later];
  assert.deepEqual(app.getPartialReconnectClusters([early, later]), [[early, later]]);
  app.recordings.push({ roomId: '1', cleanPath: 'middle.merged.mp4', startedAt: 4000, mergedFrom: ['middle-1', 'middle-2'] });
  assert.deepEqual(app.getPartialReconnectClusters([early, later]), []);
});
