const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { LiveRecordService } = require('../src/server/app/service.cjs');
const { buildSceneGraph } = require('../src/server/danmaku/scene-graph.cjs');

test('final verification distinguishes cancellation from an output failure requiring diagnostics', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'br2k-verification-cancel-'));
  const service = new LiveRecordService();
  service.ffmpegPath = process.env.FFMPEG_BIN || require('ffmpeg-static');
  service.writeLegacySceneCompatibilityAss = async () => '';
  const events = [{ type: 'danmaku', time: 0, text: 'Visible text' }];
  const graph = buildSceneGraph(events, { videoInfo: { width: 640, height: 360 } });
  const options = { graph, events, cleanPath: path.join(directory, 'source.mp4'),
    outputPath: path.join(directory, 'missing-output.mp4'), startTime: 0, duration: 5, fps: 25, directory };
  try {
    let checks = 0;
    // The subprocess fails after cancellation was requested. Classify the
    // same underlying failure both ways; never retain RGB diagnostics on cancel.
    await assert.rejects(service.verifyFinalSceneTextOutput({ ...options, isCancelled: () => ++checks > 1 }), error => {
      assert.equal(error.code, 'BR2K_MEDIA_CANCELLED');
      assert.equal(error.diagnosticDirectory, undefined);
      return true;
    });
    await assert.rejects(service.verifyFinalSceneTextOutput({ ...options, isCancelled: () => false }), error => {
      assert.notEqual(error.code, 'BR2K_MEDIA_CANCELLED');
      assert.equal(error.diagnosticDirectory, directory);
      return true;
    });
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});
