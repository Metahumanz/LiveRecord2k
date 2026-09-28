'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const helpers = require('../src/server/shared/helpers.cjs');
const helperModule = require.cache[require.resolve('../src/server/shared/helpers.cjs')];
let muxRun;
helperModule.exports = {
  ...helpers,
  runFfmpegJob: (...args) => muxRun(...args),
  probeMediaFileInfo: async () => ({ videoInfo: { fps: 60 }, audioInfo: { codec: 'aac' } }),
  probeMediaTimelineInfo: async () => ({ timingSafeForCopy: true, videoPresentationDurationSec: 65 })
};
const { LiveRecordService } = require('../src/server/app/service.cjs');
const { listRecoveries } = require('../src/server/danmaku/scene-mux-recovery.cjs');
helperModule.exports = helpers;

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'br2k-mux-test-'));
  const sceneDir = await fs.mkdtemp(path.join(os.tmpdir(), 'br2k-export-scene-test-'));
  t.after(async () => { await fs.rm(root, { recursive: true, force: true }); await fs.rm(sceneDir, { recursive: true, force: true }); });
  const mediaDir = path.join(root, '.br2k-export-media-test');
  const recoveryDir = path.join(root, 'config', 'export-recovery');
  await fs.mkdir(mediaDir); await fs.mkdir(recoveryDir, { recursive: true });
  const cleanPath = path.join(root, '883263_真栗_20260912_214923.merged.mp4');
  const finalOutputPath = path.join(root, '883263_真栗_20260912_214923.merged.clip_0-65.danmaku.mp4');
  const chunkPath = path.join(mediaDir, 'scene-chunk-0000.mkv');
  await fs.writeFile(cleanPath, Buffer.alloc(2048));
  await fs.writeFile(chunkPath, Buffer.alloc(4096));
  const source = await fs.stat(cleanPath);
  const recovery = {
    version: 1, createdAt: new Date().toISOString(), cleanPath, finalOutputPath,
    outputPath: path.join(mediaDir, 'completed.mp4'),
    concatPath: path.join(sceneDir, 'scene-chunks.ffconcat'), chunkPaths: [chunkPath], chunkDurations: [65],
    codec: 'hevc_nvv4l2', sourceCodec: 'hevc', startTime: 0, duration: 65, outputContainer: 'mp4',
    leadingAudioPaddingSec: 0, includeAudio: true, copyAudio: true,
    sourceSize: source.size, sourceMtimeMs: source.mtimeMs, chunkSizes: [4096]
  };
  const id = 'scene-mux-1234567890-1234.json';
  await fs.writeFile(path.join(recoveryDir, id), JSON.stringify(recovery));
  const app = new LiveRecordService();
  app.settings.outputDir = root;
  app.lastExportDiagnosticPath = path.join(root, 'config', 'last-export-diagnostic.json');
  app.log = () => {};
  app.emitState = () => {};
  app.ffmpegPath = 'fake-ffmpeg';
  return { root, sceneDir, mediaDir, recoveryDir, cleanPath, chunkPath, finalOutputPath, id, app };
}

test('retained video appears after restart and only muxes before verified publication', async t => {
  const f = await fixture(t);
  assert.equal((await listRecoveries(f.recoveryDir))[0].unavailableReason, '');
  let calls = 0;
  muxRun = async (_ffmpeg, args, onStderr) => {
    calls++;
    assert.equal(args.includes(f.cleanPath), true);
    assert.equal(args.includes('-c:v'), true);
    assert.equal(args.includes('copy'), true);
    onStderr('out_time_us=65000000\n');
    await fs.writeFile(args.at(-1), Buffer.alloc(64 * 1024));
  };
  await f.app.runSceneMuxRecovery(f.id);
  assert.equal(calls, 1);
  assert.equal((await fs.stat(f.finalOutputPath)).size, 64 * 1024);
  assert.deepEqual(await listRecoveries(f.recoveryDir), []);
  await assert.rejects(fs.stat(f.chunkPath), { code: 'ENOENT' });
  assert.equal((await fs.stat(f.cleanPath)).size, 2048);
});

test('failed retry retains manifest and video, changed source refuses retry', async t => {
  const f = await fixture(t);
  muxRun = async () => { throw new Error('Permission denied'); };
  await assert.rejects(f.app.runSceneMuxRecovery(f.id), /共享盘拒绝访问/);
  assert.equal((await fs.stat(f.chunkPath)).size, 4096);
  assert.equal((await listRecoveries(f.recoveryDir))[0].unavailableReason, '');
  await fs.appendFile(f.cleanPath, 'changed');
  assert.match((await listRecoveries(f.recoveryDir))[0].unavailableReason, /源录像已经变化/);
  await assert.rejects(f.app.runSceneMuxRecovery(f.id), /源录像已经变化/);
});

test('cancelled mux retry leaves the encoded video available for another attempt', async t => {
  const f = await fixture(t);
  muxRun = async () => {
    f.app.exportCancelRequested = true;
    throw Object.assign(new Error('cancelled'), { code: 'BR2K_MEDIA_CANCELLED' });
  };
  await f.app.runSceneMuxRecovery(f.id);
  assert.equal((await fs.stat(f.chunkPath)).size, 4096);
  assert.equal((await listRecoveries(f.recoveryDir))[0].unavailableReason, '');
  assert.equal(f.app.exportProgress.status, 'cancelled');
});
