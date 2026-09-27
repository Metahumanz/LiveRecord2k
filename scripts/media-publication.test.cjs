'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { Writable } = require('node:stream');
const test = require('node:test');
const { atomicReplaceFile } = require('../src/server/recording/media-safety.cjs');

async function fixture(t) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'br2k-publication-'));
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));
  const source = path.join(dir, 'completed.mp4'), output = path.join(dir, 'output.mp4');
  await fsp.writeFile(source, 'verified new movie');
  await fsp.writeFile(output, 'previous movie');
  const stat = fsp.stat.bind(fsp);
  t.mock.method(fsp, 'stat', async name => {
    const value = await stat(name);
    if (name === source) value.dev += 1; // Exercise the real stream copy across devices.
    return value;
  });
  return { dir, source, output };
}
test('cross-device publication commits only the complete copy and removes local source', async t => {
  const { dir, source, output } = await fixture(t);
  await atomicReplaceFile(source, output);
  assert.equal(await fsp.readFile(output, 'utf8'), 'verified new movie');
  assert.deepEqual(await fsp.readdir(dir), ['output.mp4']);
});
test('share write failure preserves the old output and the verified local movie', async t => {
  const { dir, source, output } = await fixture(t);
  t.mock.method(fs, 'createWriteStream', () => new Writable({ write(_chunk, _encoding, callback) {
    callback(Object.assign(new Error('share write denied'), { code: 'EACCES' }));
  } }));
  await assert.rejects(atomicReplaceFile(source, output), error => error.code === 'EACCES');
  assert.equal(await fsp.readFile(output, 'utf8'), 'previous movie');
  assert.equal(await fsp.readFile(source, 'utf8'), 'verified new movie');
  assert.deepEqual((await fsp.readdir(dir)).sort(), ['completed.mp4', 'output.mp4']);
});
test('cancellation after the copy leaves the old output untouched', async t => {
  const { dir, source, output } = await fixture(t);
  let checks = 0;
  await assert.rejects(atomicReplaceFile(source, output, { isCancelled: () => ++checks > 1 }), error => error.code === 'BR2K_MEDIA_CANCELLED');
  assert.equal(await fsp.readFile(output, 'utf8'), 'previous movie');
  assert.equal(await fsp.readFile(source, 'utf8'), 'verified new movie');
  assert.equal((await fsp.readdir(dir)).length, 2);
});
test('failed commit restores the old output after it was moved to backup', async t => {
  const { source, output } = await fixture(t);
  const rename = fsp.rename.bind(fsp);
  t.mock.method(fsp, 'rename', async (from, to) => {
    if (String(from).includes('.publishing-')) throw Object.assign(new Error('share rename denied'), { code: 'EACCES' });
    return rename(from, to);
  });
  await assert.rejects(atomicReplaceFile(source, output), error => error.code === 'EACCES');
  assert.equal(await fsp.readFile(output, 'utf8'), 'previous movie');
  assert.equal(await fsp.readFile(source, 'utf8'), 'verified new movie');
});
