const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { discoverRecordingFiles, inferRecordingIdentity, parseRecordingStartedAtFromName } = require('../src/server/shared/helpers.cjs');
const { LiveRecordService } = require('../src/server/app/service.cjs');

test('legacy recordings recover numeric ownership from native Windows and Linux filenames', () => {
  for (const cleanPath of [
    '/mnt/zzzz/哔哩录播2K/883263-真栗/20260926_210417-真栗提到了你/883263_真栗_20260926_222753.clean.mp4',
    'X:\\zzzz\\哔哩录播2K\\883263-真栗\\20260926_210417-真栗提到了你\\883263_真栗_20260926_222753.clean.mp4'
  ]) {
    assert.deepEqual(inferRecordingIdentity({ cleanPath, roomId: '' }), { roomId: '883263', anchor: '真栗', roomTitle: '真栗提到了你' });
    assert.ok(parseRecordingStartedAtFromName(cleanPath) > 0);
  }
});

test('identity recovery respects explicit metadata and refuses conflicting or unrecognized paths', () => {
  assert.equal(inferRecordingIdentity({ cleanPath: '/883263_真栗_20260926_222753.clean.mp4', roomId: 123 }).roomId, '123');
  for (const cleanPath of [
    '/7953876-真栗/20260926_210417-直播/883263_真栗_20260926_222753.clean.mp4',
    '/883263-真栗/session/unrelated.clean.mp4',
    '/真栗/session/anchor_only.clean.mp4'
  ]) assert.equal(inferRecordingIdentity({ cleanPath }).roomId, '');
});

test('stored recordings normalize canonical room aliases and recover legacy chronological order', () => {
  const app = new LiveRecordService();
  app.rooms.set('short-room', { id: 'short-room', realRoomId: 883263 });
  const cleanPath = '/883263_真栗_20260926_222753.clean.mp4';
  const recovered = app.normalizeRecording({ cleanPath, roomId: '', startedAt: Date.now() });
  assert.equal(recovered.roomId, 'short-room');
  assert.equal(recovered.startedAt, parseRecordingStartedAtFromName(cleanPath));
  assert.equal(app.normalizeRecording({ cleanPath, roomId: 883263, startedAt: 1 }).roomId, 'short-room');
  assert.equal(app.normalizeRecording({ cleanPath, roomId: 883263, startedAt: 1 }).startedAt, 1);
});

test('library discovery restores missing room fields without rewriting videos or sidecars', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'br2k-identity-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const cleanPath = path.join(directory, '883263_真栗_20260926_222753.clean.mp4');
  const bytes = Buffer.alloc(64 * 1024, 7);
  await fs.writeFile(cleanPath, bytes);
  const stat = await fs.stat(cleanPath);
  const metadataPath = `${cleanPath}.metadata.json`;
  const metadata = JSON.stringify({ schemaVersion: 1, fileSize: stat.size, fileMtimeMs: stat.mtimeMs,
    durationSec: 37, eventCount: 39, roomId: '', videoInfo: { width: 2560, height: 1440, codec: 'hevc' } });
  await fs.writeFile(metadataPath, metadata);
  const [recording] = await discoverRecordingFiles(directory);
  assert.equal(recording.roomId, '883263');
  assert.equal(recording.anchor, '真栗');
  assert.equal(recording.startedAt, parseRecordingStartedAtFromName(cleanPath));
  assert.deepEqual(await fs.readFile(cleanPath), bytes);
  assert.equal(await fs.readFile(metadataPath, 'utf8'), metadata);
});
