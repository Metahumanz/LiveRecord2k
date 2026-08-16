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

test('manual cleanup removes orphaned source sidecars only when their metadata points to an existing merged output', async () => {
  const outputDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'br2k-cleanup-orphan-sidecars-'));
  const sourcePath = path.join(outputDir, 'orphan.clean.mp4');
  const sourceCapturePath = path.join(outputDir, 'orphan.recording.mkv');
  const sourceDanmakuPath = path.join(outputDir, 'orphan.danmaku.jsonl');
  const sourceCssPath = path.join(outputDir, 'orphan.danmaku.css');
  const sourceAssPath = path.join(outputDir, 'orphan.danmaku.ass');
  const sourceFinalizingPath = path.join(outputDir, 'orphan.clean.finalizing.mp4');
  const legacyFinalizingPath = path.join(outputDir, 'orphan.finalizing.mp4');
  const mergedPath = path.join(outputDir, 'orphan.merged.mp4');
  const mergedDanmakuPath = path.join(outputDir, 'orphan.merged.danmaku.jsonl');
  const unrelatedPath = path.join(outputDir, 'unrelated.clean.mp4');
  const unrelatedDanmakuPath = path.join(outputDir, 'unrelated.danmaku.jsonl');
  try {
    await Promise.all([
      writeRecordingFile(sourcePath),
      writeRecordingFile(sourceCapturePath),
      writeRecordingFile(sourceDanmakuPath),
      writeRecordingFile(sourceCssPath),
      writeRecordingFile(sourceAssPath),
      writeRecordingFile(sourceFinalizingPath),
      writeRecordingFile(legacyFinalizingPath),
      writeRecordingFile(mergedPath),
      writeRecordingFile(mergedDanmakuPath),
      writeRecordingFile(unrelatedPath),
      writeRecordingFile(unrelatedDanmakuPath)
    ]);
    await Promise.all([
      writeLegacyMetadata(mergedPath, {
        mergeGroup: 'orphan-group',
        mergeOutputPath: path.basename(mergedPath),
        segmentReason: 'merged'
      }),
      writeLegacyMetadata(sourcePath, {
        status: 'completed',
        mergeGroup: 'orphan-group',
        mergeOutputPath: path.basename(mergedPath),
        segmentReason: 'stream-eof'
      }),
      writeLegacyMetadata(unrelatedPath, {
        status: 'completed',
        mergeGroup: 'orphan-group',
        mergeOutputPath: 'not-a-real-merged-output.merged.mp4',
        segmentReason: 'stream-eof'
      })
    ]);
    await Promise.all([fsp.rm(sourcePath), fsp.rm(unrelatedPath)]);

    const discovered = await discoverRecordingFiles(outputDir, { concurrency: 1 });
    assert.deepEqual(discovered.map((recording) => recording.cleanPath), [mergedPath]);
    const cleaner = createService(outputDir);
    cleaner.recordings = discovered.map((recording) => cleaner.normalizeRecording(recording)).filter(Boolean);
    await cleaner.cleanupMergedSegmentResiduals();

    for (const filePath of [
      `${sourcePath}.metadata.json`,
      sourceCapturePath,
      sourceDanmakuPath,
      sourceCssPath,
      sourceAssPath,
      sourceFinalizingPath,
      legacyFinalizingPath
    ]) {
      assert.equal(await fileExists(filePath), false, `expected stale source artifact to be deleted: ${path.basename(filePath)}`);
    }
    assert.equal(await fileExists(mergedPath), true);
    assert.equal(await fileExists(`${mergedPath}.metadata.json`), true);
    assert.equal(await fileExists(mergedDanmakuPath), true);
    assert.equal(await fileExists(`${unrelatedPath}.metadata.json`), true);
    assert.equal(await fileExists(unrelatedDanmakuPath), true);
  } finally {
    await fsp.rm(outputDir, { recursive: true, force: true });
  }
});

test('crash recovery removes only a zero-byte capture owned by an interrupted recording metadata file', async () => {
  const outputDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'br2k-cleanup-empty-capture-'));
  const cleanPath = path.join(outputDir, 'empty.clean.mp4');
  const capturePath = path.join(outputDir, 'empty.recording.mkv');
  const danmakuPath = path.join(outputDir, 'empty.danmaku.jsonl');
  const cssPath = path.join(outputDir, 'empty.danmaku.css');
  const assPath = path.join(outputDir, 'empty.danmaku.ass');
  const diagnosticsPath = path.join(outputDir, 'diagnostics.json');
  const unownedCapturePath = path.join(outputDir, 'unowned.recording.mkv');
  try {
    await Promise.all([
      fsp.writeFile(capturePath, ''),
      fsp.writeFile(danmakuPath, '{"videoTime":0}\n'),
      fsp.writeFile(cssPath, '/* danmaku */'),
      fsp.writeFile(assPath, '[Script Info]'),
      fsp.writeFile(diagnosticsPath, '{}\n'),
      fsp.writeFile(unownedCapturePath, '')
    ]);
    await fsp.writeFile(
      `${cleanPath}.metadata.json`,
      `${JSON.stringify({
        schemaVersion: 2,
        status: 'recording',
        cleanPath: path.basename(cleanPath),
        capturePath: path.basename(capturePath),
        danmakuPath: path.basename(danmakuPath)
      })}\n`
    );

    const service = createService(outputDir);
    const recovered = await service.recoverInterruptedRecordings();

    assert.deepEqual(recovered, []);
    for (const filePath of [capturePath, `${cleanPath}.metadata.json`, danmakuPath, cssPath, assPath]) {
      assert.equal(await fileExists(filePath), false, `expected owned empty artifact to be deleted: ${path.basename(filePath)}`);
    }
    assert.equal(await fileExists(diagnosticsPath), true, 'session diagnostics are not a disposable capture sidecar');
    assert.equal(await fileExists(unownedCapturePath), true, 'an unowned empty capture remains available for manual inspection');
  } finally {
    await fsp.rm(outputDir, { recursive: true, force: true });
  }
});

test('source deletion setting is disabled whenever automatic burn is disabled', () => {
  const service = new LiveRecordService();
  const disabled = service.normalizeSettings({
    ...service.settings,
    autoBurnDanmaku: false,
    deleteSourceAfterBurn: true
  });
  const enabled = service.normalizeSettings({
    ...service.settings,
    autoBurnDanmaku: true,
    deleteSourceAfterBurn: true
  });

  assert.equal(disabled.deleteSourceAfterBurn, false);
  assert.equal(enabled.deleteSourceAfterBurn, true);
});

test('automatic burn source deletion requires a completed output and preserves source sidecars', async () => {
  const outputDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'br2k-delete-source-after-burn-'));
  const sourcePath = path.join(outputDir, 'session.clean.mp4');
  const burnedPath = path.join(outputDir, 'session.danmaku.mp4');
  const sourceDanmakuPath = path.join(outputDir, 'session.danmaku.jsonl');
  const room = { id: 'delete-source', title: 'Delete source', anchor: 'test', currentRecording: { cleanPath: sourcePath } };
  try {
    await Promise.all([writeRecordingFile(sourcePath), writeRecordingFile(sourceDanmakuPath)]);
    const service = createService(outputDir);
    const sourceRecording = service.normalizeRecording({ cleanPath: sourcePath, danmakuPath: sourceDanmakuPath });
    service.recordings = [sourceRecording];

    await assert.rejects(
      () => service.deleteBurnSourceAfterSuccess(room, sourceRecording, burnedPath),
      /弹幕版成片不存在/
    );
    assert.equal(await fileExists(sourcePath), true);

    await writeRecordingFile(burnedPath);
    const result = await service.deleteBurnSourceAfterSuccess(room, sourceRecording, burnedPath);

    assert.deepEqual(result, { deleted: true, missing: false });
    assert.equal(await fileExists(sourcePath), false);
    assert.equal(await fileExists(burnedPath), true);
    assert.equal(await fileExists(sourceDanmakuPath), true);
    assert.equal(service.recordings.length, 0);
    assert.equal(room.currentRecording, undefined);
  } finally {
    await fsp.rm(outputDir, { recursive: true, force: true });
  }
});
