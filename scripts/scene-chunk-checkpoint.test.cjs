'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { openSceneChunkCheckpoint } = require('../src/server/danmaku/scene-chunk-checkpoint.cjs');

async function fixture(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'br2k-checkpoint-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const cleanPath = path.join(dir, 'source.mp4');
  await fs.writeFile(cleanPath, Buffer.alloc(2048));
  return { root: path.join(dir, 'cache'), cleanPath, finalOutputPath: path.join(dir, 'final.mp4'),
    graph: { canvas: { width: 640, height: 360 }, timeline: { start: 0, end: 30 }, assets: [], objects: [] },
    settings: { codec: 'hevc_nvv4l2', crf: 23 } };
}

test('equal-size corruption discards that chunk and every later window', async t => {
  const opts = await fixture(t), cache = await openSceneChunkCheckpoint(opts);
  for (let index = 0; index < 3; index++) {
    const file = path.join(cache.directory, `scene-chunk-000${index}.mkv`);
    await fs.writeFile(file, Buffer.alloc(2048, index));
    await cache.append(file, 10);
  }
  await fs.writeFile(cache.chunks[1].path, Buffer.alloc(2048, 9));
  const resumed = await openSceneChunkCheckpoint(opts);
  assert.equal(resumed.chunks.length, 1);
  assert.equal(resumed.chunks[0].duration, 10);
});

test('source, render settings and assets bind the checkpoint identity', async t => {
  const opts = await fixture(t);
  const asset = path.join(path.dirname(opts.cleanPath), 'emoji.png');
  await fs.writeFile(asset, 'initial asset');
  opts.graph.assets = [{ id: 'emoji', type: 'emoji', path: asset }];
  const first = await openSceneChunkCheckpoint(opts);
  const altered = await openSceneChunkCheckpoint({ ...opts, settings: { ...opts.settings, crf: 24 } });
  assert.notEqual(altered.directory, first.directory);
  await fs.writeFile(opts.cleanPath, Buffer.alloc(4096));
  const changedSource = await openSceneChunkCheckpoint(opts);
  assert.notEqual(changedSource.directory, first.directory);
  await fs.writeFile(asset, 'changed emoji asset');
  assert.notEqual((await openSceneChunkCheckpoint(opts)).directory, changedSource.directory);
});

test('cancellation cannot pass chunk hash verification and manifest paths cannot escape the work directories', async t => {
  const opts = await fixture(t), cache = await openSceneChunkCheckpoint(opts);
  const file = path.join(cache.directory, 'scene-chunk-0000.mkv');
  await fs.writeFile(file, Buffer.alloc(2048)); await cache.append(file, 10);
  await assert.rejects(openSceneChunkCheckpoint({ ...opts, isCancelled: () => true }), { code: 'BR2K_MEDIA_CANCELLED' });
  await assert.rejects(cache.append(opts.cleanPath, 10), /可恢复工作目录/);
  const saved = JSON.parse(await fs.readFile(cache.manifestPath, 'utf8'));
  saved.chunks[0].path = opts.cleanPath;
  await fs.writeFile(cache.manifestPath, JSON.stringify(saved));
  assert.equal((await openSceneChunkCheckpoint(opts)).chunks.length, 0);
  assert.equal((await fs.stat(opts.cleanPath)).size, 2048);
});
