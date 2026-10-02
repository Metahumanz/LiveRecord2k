'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { discoverExportedClips } = require('../src/server/recording/exported-clips.cjs');

test('old final clips in the chosen directory and source folder survive refresh without a history index', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'br2k-export-results-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const folder = path.join(root, '7953876-anchor', 'session');
  await fs.mkdir(folder, { recursive: true });
  const cleanPath = path.join(folder, '7953876_anchor_20261001_212131.clean.mp4');
  const rootClip = path.join(root, '7953876_anchor_20261001_212131.clip_0-2332_5.danmaku.mp4');
  const nestedClip = path.join(folder, '7953876_anchor_20261001_212131.clip_1_25-20_5.clean.mp4');
  await Promise.all([cleanPath, rootClip, nestedClip].map(file => fs.writeFile(file, Buffer.alloc(32768))));
  const recordings = [{ cleanPath }];
  const first = await discoverExportedClips(root, recordings);
  assert.equal(first.length, 2);
  assert.ok(first.every(item => item.cleanPath === cleanPath && item.fileSize === 32768));
  assert.equal(first.find(item => item.outputPath === rootClip).mode, 'burn');
  assert.equal(first.find(item => item.outputPath === rootClip).endTime, 2332.5);
  assert.equal(first.find(item => item.outputPath === nestedClip).startTime, 1.25);
  await fs.unlink(rootClip);
  assert.deepEqual((await discoverExportedClips(root, recordings)).map(item => item.outputPath), [nestedClip]);
});

test('in-progress, hidden scratch, invalid ranges and tiny files never appear as published results', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'br2k-export-hidden-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const hidden = path.join(root, '.br2k-export-media');
  await fs.mkdir(hidden);
  for (const file of ['x.clip_0-10.danmaku.tmp.mp4', 'x.clip_10-0.clean.mp4', 'x.clean.mp4']) {
    await fs.writeFile(path.join(root, file), Buffer.alloc(32768));
  }
  await fs.writeFile(path.join(root, 'x.clip_0-10.danmaku.mp4'), 'partial');
  await fs.writeFile(path.join(hidden, 'x.clip_0-10.danmaku.mp4'), Buffer.alloc(32768));
  assert.deepEqual(await discoverExportedClips(root), []);
});

test('merged clips keep their canonical source identity and latest outputs are bounded', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'br2k-export-merged-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const cleanPath = path.join(root, '7953876_anchor.manual-id.merged.mp4');
  const other = path.join(root, '7953876_anchor_20261002_000000.clean.mp4');
  const older = path.join(root, '7953876_anchor.manual-id.merged.clip_0-10.danmaku-only.mp4');
  const newer = path.join(root, '7953876_anchor.manual-id.merged.clip_0-20.danmaku.mp4');
  await Promise.all([older, newer].map(file => fs.writeFile(file, Buffer.alloc(32768))));
  await fs.utimes(older, 1, 1);
  const rows = await discoverExportedClips(root, [{ cleanPath }, { cleanPath: other }], { limit: 1 });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].outputPath, newer);
  assert.equal(rows[0].cleanPath, cleanPath);
});
