'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { runSceneAudioMuxWithRetry } = require('../src/server/danmaku/scene-audio-mux.cjs');

test('transient shared-storage permission failure retries only the mux', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'br2k-mux-retry-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const outputPath = path.join(dir, 'partial.mp4');
  let attempts = 0, retried = 0;
  await runSceneAudioMuxWithRetry({
    sharedOutput: true, outputPath,
    run: async onStderr => {
      attempts++;
      if (attempts === 1) {
        await fs.writeFile(outputPath, 'partial');
        onStderr('[out#0/mp4] Error closing file: Permission denied');
        throw new Error('ffmpeg 退出码 243');
      }
      await assert.rejects(fs.stat(outputPath), { code: 'ENOENT' });
      await fs.writeFile(outputPath, 'complete');
    },
    onRetry: () => { retried++; },
    delay: async () => {}
  });
  assert.equal(attempts, 2);
  assert.equal(retried, 1);
  assert.equal(await fs.readFile(outputPath, 'utf8'), 'complete');
});

test('repeated permission denial stops with a recoverable error', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'br2k-mux-denied-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  let attempts = 0;
  await assert.rejects(runSceneAudioMuxWithRetry({
    sharedOutput: true, outputPath: path.join(dir, 'partial.mp4'),
    run: async onStderr => {
      attempts++;
      onStderr('Error closing file: Permission denied');
      throw new Error('ffmpeg 退出码 243');
    }, delay: async () => {}
  }), { code: 'BR2K_SCENE_MUX_STORAGE_DENIED' });
  assert.equal(attempts, 2);
});

test('local or unrelated mux failure does not retry', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'br2k-mux-other-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  for (const [sharedOutput, stderr] of [[false, 'Permission denied'], [true, 'Invalid data']]) {
    let attempts = 0;
    await assert.rejects(runSceneAudioMuxWithRetry({
      sharedOutput, outputPath: path.join(dir, 'partial.mp4'),
      run: async onStderr => { attempts++; onStderr(stderr); throw new Error('ffmpeg failed'); }
    }));
    assert.equal(attempts, 1);
  }
});

test('cancellation never starts a mux retry', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'br2k-mux-cancel-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  let attempts = 0;
  await assert.rejects(runSceneAudioMuxWithRetry({
    sharedOutput: true, outputPath: path.join(dir, 'partial.mp4'),
    isCancelled: () => true,
    run: async onStderr => { attempts++; onStderr('Permission denied'); throw new Error('ffmpeg failed'); }
  }));
  assert.equal(attempts, 1);
});
