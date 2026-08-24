const assert = require('node:assert/strict');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { LiveRecordService } = require('../src/server/app/service.cjs');

const ONE_PIXEL_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64'
);

function recordingPaths(directory, name) {
  const cleanPath = path.join(directory, `${name}.clean.mp4`);
  const avatarManifestPath = path.join(directory, `${name}.danmaku.avatars.json`);
  const avatarDirectory = path.join(directory, `${name}.danmaku.avatars`);
  return { cleanPath, avatarManifestPath, avatarDirectory };
}

test('recording captures avatar images into the recording sidecar structure', async () => {
  const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'br2k-avatar-capture-'));
  try {
    const service = new LiveRecordService();
    service.fetchAvatarImageAsset = async () => ({ body: ONE_PIXEL_PNG, contentType: 'image/png' });
    service.lookupBiliAvatarForOverlay = async (uid) => `https://i0.hdslb.com/bfs/face/${uid}.png`;
    const paths = recordingPaths(tempDir, 'session');
    const session = { ...paths, finished: false };

    service.queueRecordingAvatarCapture(session, { uid: 42 });
    assert.equal(await service.flushAvatarCapture(session), true);
    await service.scheduleAvatarManifestWrite(session, 'completed');

    const manifest = JSON.parse(await fsp.readFile(paths.avatarManifestPath, 'utf8'));
    assert.equal(manifest.captureComplete, true);
    assert.equal(manifest.entries.length, 1);
    assert.equal(manifest.entries[0].uid, 42);
    assert.match(manifest.entries[0].file, /^session\.danmaku\.avatars\/uid-42-/);
    assert.equal(await fsp.stat(path.join(tempDir, manifest.entries[0].file)).then((stat) => stat.isFile()), true);
  } finally {
    await fsp.rm(tempDir, { recursive: true, force: true });
  }
});

test('complete avatar manifests resolve a local image for the recording UID', async () => {
  const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'br2k-avatar-local-'));
  try {
    const service = new LiveRecordService();
    const paths = recordingPaths(tempDir, 'session');
    await fsp.mkdir(paths.avatarDirectory, { recursive: true });
    await fsp.writeFile(path.join(paths.avatarDirectory, 'uid-42-local.png'), ONE_PIXEL_PNG);
    await fsp.writeFile(
      paths.avatarManifestPath,
      JSON.stringify({
        schemaVersion: 1,
        captureComplete: true,
        entries: [{ uid: 42, file: 'session.danmaku.avatars/uid-42-local.png', capturedAt: Date.now() }]
      })
    );

    const manifest = await service.loadAvatarManifestForRecording(paths);
    const snapshot = manifest.byUid.get(42);
    assert.equal(manifest.captureComplete, true);
    assert.ok(snapshot?.filePath);
    assert.equal(await fsp.stat(snapshot.filePath).then((stat) => stat.isFile()), true);
  } finally {
    await fsp.rm(tempDir, { recursive: true, force: true });
  }
});
