const assert = require('node:assert/strict');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const ffmpegPath = require('ffmpeg-static');

const { LiveRecordService } = require('../src/server/app/service.cjs');
const { MediaJobManager } = require('../src/server/app/media-job-manager.cjs');
const { runCapturedProcess } = require('../src/server/shared/helpers.cjs');

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(predicate, timeoutMs = 12_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await delay(10);
  }
  throw new Error('等待预览任务进入队列超时。');
}

test('compatibility preview returns a queued job immediately and can cancel it before resources are acquired', async () => {
  const tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'br2k-preview-queue-'));
  const tempDir = path.join(tempRoot, 'PreviewQueueCase');
  await fsp.mkdir(tempDir);
  const sourcePath = path.join(tempDir, 'queue-test.clean.mp4');
  const service = new LiveRecordService();
  service.ffmpegPath = ffmpegPath;
  service.settings.outputDir = tempDir;
  service.previewCacheDir = path.join(tempDir, 'preview-cache');
  service.log = () => {};
  service.emitState = () => {};
  service.mediaJobs = new MediaJobManager({ limits: { cpu: 1, gpu: 1 } });
  const releaseRecording = service.mediaJobs.registerExternal({ id: 'recording:test', type: 'recording' });

  try {
    const source = await runCapturedProcess(
      ffmpegPath,
      [
        '-hide_banner', '-loglevel', 'error', '-y',
        '-f', 'lavfi', '-i', 'color=c=black:s=160x90:r=30:d=1',
        '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo',
        '-shortest', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', sourcePath
      ],
      { timeoutMs: 20_000 }
    );
    assert.equal(source.status, 0, source.stderr);

    let startError = null;
    const startPromise = service.startExportPreview({ cleanPath: sourcePath }).catch((error) => {
      startError = error;
      throw error;
    });
    startPromise.catch(() => {});
    await waitFor(() => {
      if (startError) throw startError;
      return service.mediaJobs.snapshot().some((job) => job.type === 'preview' && job.status === 'queued');
    });

    const result = await Promise.race([startPromise, delay(100).then(() => null)]);
    assert.ok(result, 'HTTP-facing preview request should not wait for the media lease');
    assert.equal(result.ready, false);
    assert.equal(result.progress.status, 'queued');
    assert.equal(result.jobId, result.progress.id);
    assert.equal(service.exportPreviewProgress.status, 'queued');

    await service.cancelExportPreview();
    assert.equal(service.exportPreviewProgress.status, 'cancelled');
    assert.equal(service.mediaJobs.snapshot().some((job) => job.id === result.jobId), false);
  } finally {
    releaseRecording();
    await service.mediaJobs.shutdown();
    await fsp.rm(tempRoot, { recursive: true, force: true });
  }
});
