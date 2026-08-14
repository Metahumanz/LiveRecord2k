const assert = require('node:assert/strict');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { LiveRecordService } = require('../src/server/app/service.cjs');
const { discoverRecordingFiles } = require('../src/server/shared/helpers.cjs');

function createService(outputDir) {
  const service = new LiveRecordService();
  service.settings.outputDir = outputDir;
  service.log = () => {};
  service.emitState = () => {};
  service.saveStore = async () => {};
  return service;
}

async function fileExists(filePath) {
  return Boolean(await fsp.stat(filePath).catch(() => null));
}

async function writeRecordingFile(filePath) {
  await fsp.writeFile(filePath, 'recording-data');
}

async function writeLegacyMetadata(filePath, fields) {
  const stat = await fsp.stat(filePath);
  await fsp.writeFile(
    `${filePath}.metadata.json`,
    `${JSON.stringify({
      schemaVersion: 2,
      fileSize: stat.size,
      fileMtimeMs: stat.mtimeMs,
      durationSec: 0,
      eventCount: 0,
      ...fields
    })}\n`
  );
}

test('merged recording metadata preserves cleanup lineage across a library refresh', async () => {
  const outputDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'br2k-cleanup-metadata-'));
  const sourceOne = path.join(outputDir, 'session-part-1.clean.mp4');
  const sourceTwo = path.join(outputDir, 'session-part-2.clean.mp4');
  const mergedPath = path.join(outputDir, 'session.merged.mp4');
  try {
    await Promise.all([writeRecordingFile(sourceOne), writeRecordingFile(sourceTwo), writeRecordingFile(mergedPath)]);
    const writer = createService(outputDir);
    const merged = writer.normalizeRecording({
      cleanPath: mergedPath,
      mergeGroup: 'session-group',
      mergeOutputPath: mergedPath,
      segmentReason: 'merged',
      mergedFrom: [sourceOne, sourceTwo],
      cleanupId: 'cleanup-metadata'
    });
    await writer.writeRecordingMetadata(merged);

    const metadata = JSON.parse(await fsp.readFile(`${mergedPath}.metadata.json`, 'utf8'));
    assert.deepEqual(metadata.mergedFrom.sort(), [path.basename(sourceOne), path.basename(sourceTwo)].sort());
    assert.equal(metadata.mergeOutputPath, path.basename(mergedPath));
    assert.equal(metadata.cleanupId, 'cleanup-metadata');

    const discovered = await discoverRecordingFiles(outputDir, { concurrency: 1 });
    const restored = discovered.find((recording) => recording.cleanPath === mergedPath);
    assert.ok(restored);
    assert.deepEqual(restored.mergedFrom.sort(), [sourceOne, sourceTwo].sort());
    assert.equal(restored.mergeOutputPath, mergedPath);
    assert.equal(restored.cleanupId, 'cleanup-metadata');

    const cleaner = createService(outputDir);
    cleaner.recordings = discovered.map((recording) => cleaner.normalizeRecording(recording)).filter(Boolean);
    await cleaner.cleanupMergedSegmentResiduals();

    assert.equal(await fileExists(sourceOne), false);
    assert.equal(await fileExists(sourceTwo), false);
    assert.equal(await fileExists(mergedPath), true);
  } finally {
    await fsp.rm(outputDir, { recursive: true, force: true });
  }
});

test('manual cleanup processes persisted pending cleanup tasks without recording-library lineage', async () => {
  const outputDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'br2k-cleanup-pending-'));
  const sourcePath = path.join(outputDir, 'session-part.clean.mp4');
  const mergedPath = path.join(outputDir, 'session.merged.mp4');
  try {
    await Promise.all([writeRecordingFile(sourcePath), writeRecordingFile(mergedPath)]);
    const service = createService(outputDir);
    const cleanupId = 'pending-cleanup';
    const mergedRecording = service.normalizeRecording({
      cleanPath: mergedPath,
      mergeGroup: 'pending-group',
      mergeOutputPath: mergedPath,
      segmentReason: 'merged',
      cleanupId
    });
    service.pendingSegmentCleanups.set(cleanupId, {
      cleanupId,
      roomId: 'room-1',
      status: 'pending',
      segments: [service.normalizeRecording({ cleanPath: sourcePath })],
      mergedRecording
    });

    await service.cleanupMergedSegmentResiduals();

    assert.equal(await fileExists(sourcePath), false);
    assert.equal(await fileExists(mergedPath), true);
    assert.equal(service.pendingSegmentCleanups.has(cleanupId), false);
  } finally {
    await fsp.rm(outputDir, { recursive: true, force: true });
  }
});

test('automatic cleanup retry drains every pending task for a room after burning finishes', async () => {
  const outputDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'br2k-cleanup-retry-'));
  const room = { id: 'room-retry', title: 'Retry', anchor: 'test', burning: false };
  try {
    const service = createService(outputDir);
    for (const suffix of ['one', 'two']) {
      const sourcePath = path.join(outputDir, `${suffix}-part.clean.mp4`);
      const mergedPath = path.join(outputDir, `${suffix}.merged.mp4`);
      const cleanupId = `retry-${suffix}`;
      await Promise.all([writeRecordingFile(sourcePath), writeRecordingFile(mergedPath)]);
      service.pendingSegmentCleanups.set(cleanupId, {
        cleanupId,
        roomId: room.id,
        status: 'pending',
        segments: [service.normalizeRecording({ cleanPath: sourcePath })],
        mergedRecording: service.normalizeRecording({
          cleanPath: mergedPath,
          mergeGroup: `retry-group-${suffix}`,
          mergeOutputPath: mergedPath,
          segmentReason: 'merged',
          cleanupId
        })
      });
    }

    await service.cleanupPendingSegmentCleanupsForRoom(room);

    assert.equal(await fileExists(path.join(outputDir, 'one-part.clean.mp4')), false);
    assert.equal(await fileExists(path.join(outputDir, 'two-part.clean.mp4')), false);
    assert.equal(service.pendingSegmentCleanups.size, 0);
  } finally {
    await fsp.rm(outputDir, { recursive: true, force: true });
  }
});

test('manual cleanup can safely reconstruct a legacy merge group that predates persisted mergedFrom', async () => {
  const outputDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'br2k-cleanup-legacy-'));
  const sourceOne = path.join(outputDir, 'legacy-part-1.clean.mp4');
  const sourceTwo = path.join(outputDir, 'legacy-part-2.clean.mp4');
  const mergedPath = path.join(outputDir, 'legacy.merged.mp4');
  try {
    await Promise.all([writeRecordingFile(sourceOne), writeRecordingFile(sourceTwo), writeRecordingFile(mergedPath)]);
    await Promise.all([
      writeLegacyMetadata(sourceOne, { mergeGroup: 'legacy-group', mergeSequence: 0, segmentReason: 'initial' }),
      writeLegacyMetadata(sourceTwo, { mergeGroup: 'legacy-group', mergeSequence: 1, segmentReason: 'stream-eof' }),
      writeLegacyMetadata(mergedPath, { mergeGroup: 'legacy-group', mergeSequence: 0, segmentReason: 'merged' })
    ]);

    const discovered = await discoverRecordingFiles(outputDir, { concurrency: 1 });
    const cleaner = createService(outputDir);
    cleaner.recordings = discovered.map((recording) => cleaner.normalizeRecording(recording)).filter(Boolean);
    await cleaner.cleanupMergedSegmentResiduals();

    assert.equal(await fileExists(sourceOne), false);
    assert.equal(await fileExists(sourceTwo), false);
    assert.equal(await fileExists(mergedPath), true);
  } finally {
    await fsp.rm(outputDir, { recursive: true, force: true });
  }
});
