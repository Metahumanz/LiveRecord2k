const assert = require('node:assert/strict');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const test = require('node:test');
const { mergeDanmakuFiles } = require('../src/server/recording/ffmpeg.cjs');
const { LiveRecordService } = require('../src/server/app/service.cjs');

test('streamed danmaku merge reports bytes and events while retaining offsets, malformed-line handling and cancellation', async t => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'br2k-sidecar-progress-'));
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));
  const first = path.join(dir, 'first.jsonl'), second = path.join(dir, 'second.jsonl'), output = path.join(dir, 'out.jsonl');
  await fsp.writeFile(first, Array.from({ length: 1000 }, (_, i) => JSON.stringify({ time: i / 100, text: '中文🙂' })).join('\n') + '\nmalformed\n');
  await fsp.writeFile(second, JSON.stringify({ videoTime: 1.25, text: 'second' }) + '\n');
  const segments = [{ danmakuPath: first, durationSec: 10 }, { danmakuPath: path.join(dir, 'missing'), durationSec: 2 },
    { danmakuPath: second, durationSec: 1 }];
  const samples = [];
  await mergeDanmakuFiles(segments, output, { onProgress: p => samples.push(p) });
  const events = (await fsp.readFile(output, 'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(events.length, 1001); assert.equal(events[0].text, '中文🙂');
  assert.equal(events.at(-1).videoTime, 13.25); assert.equal(events.at(-1).time, 13.25);
  assert(samples.some(p => p.eventCount === 256 && p.completed > 0));
  assert.equal(samples.at(-1).completed, (await fsp.stat(first)).size + (await fsp.stat(second)).size);
  assert.equal(samples.at(-1).completed, samples.at(-1).total);
  const controller = new AbortController();
  await assert.rejects(mergeDanmakuFiles(segments, output, { signal: controller.signal,
    onProgress: p => { if (p.eventCount >= 256) controller.abort(new Error('cancel during merge')); } }), /cancel during merge/);
  assert.equal((await fsp.readFile(output, 'utf8')).trim().split('\n').length, 256);
});

test('avatar merging copies a captured duplicate only once, reports records and preserves fallback selection', async t => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'br2k-avatar-progress-'));
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'source.png'); await fsp.writeFile(file, 'avatar');
  const app = new LiveRecordService();
  const entry = { uid: 7, avatarUrl: 'https://i0.hdslb.com/a.png', filePath: file, status: 'captured' };
  app.readAvatarManifestFile = async () => ({ present: true, captureComplete: true,
    entries: [{ ...entry, filePath: '' }, entry, { ...entry, filePath: path.join(dir, 'not-needed.png') }] });
  const target = path.join(dir, 'out.avatars.json');
  const progress = [];
  await app.mergeAvatarManifests([{}, {}], target, { onProgress: p => progress.push(p) });
  const manifest = JSON.parse(await fsp.readFile(target, 'utf8'));
  assert.equal(manifest.entryCount, 1); assert.equal(manifest.totalBytes, 6);
  assert.equal((await fsp.readdir(path.join(dir, 'out.avatars'))).length, 1);
  assert.equal(await fsp.readFile(path.join(dir, manifest.entries[0].file), 'utf8'), 'avatar');
  assert.deepEqual(progress.at(-1), { completed: 1, total: 1, unit: 'items' });
  const controller = new AbortController();
  await assert.rejects(app.mergeAvatarManifests([{}, {}], path.join(dir, 'cancel.avatars.json'), {
    signal: controller.signal, onProgress: p => { if (p.completed >= 1) controller.abort(new Error('cancel avatars')); }
  }), /cancel avatars/);
  await assert.rejects(fsp.stat(path.join(dir, 'cancel.avatars')), { code: 'ENOENT' });
});

test('measurable preparation stages publish progress and stop on this job cancellation', async () => {
  const app = new LiveRecordService(); app.markRoomDirty = () => {};
  const room = { id: 'room', mergeProgress: { id: 'job', mergeGroup: 'group', status: 'running', workStartedAt: 1 } };
  app.rooms.set(room.id, room);
  await assert.rejects(app.runMergePreparationStage(room, room.mergeProgress, '正在合并弹幕记录', async options => {
    options.onProgress({ completed: 5, total: 10, unit: 'bytes', eventCount: 2 });
    assert.equal(room.mergeProgress.phasePercent, 50);
    app.mergeCancelRequests.add(app.getMergeRetryKey(room.id, 'group'));
    options.onProgress({ completed: 6, total: 10, unit: 'bytes' });
  }), { code: 'MEDIA_JOB_CANCELLED' });
});
