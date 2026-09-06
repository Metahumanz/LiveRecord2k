const assert = require('node:assert/strict');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const ffmpegPath = require('ffmpeg-static');

const { LiveRecordService } = require('../src/server/app/service.cjs');
const { runCapturedProcess } = require('../src/server/shared/helpers.cjs');

async function waitFor(predicate, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('等待导出状态超时。');
}

test('a dequeued export remains visible while subtitles and avatars are being prepared', async () => {
  const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'br2k-export-queue-'));
  const inputPath = path.join(tempDir, '123_测试_20260825_120000.clean.mp4');
  const danmakuPath = path.join(tempDir, '123_测试_20260825_120000.danmaku.jsonl');
  const outputPath = path.join(tempDir, '123_测试_20260825_120000.clip_0-1.danmaku.mp4');
  try {
    const source = await runCapturedProcess(
      ffmpegPath,
      [
        '-hide_banner', '-loglevel', 'error', '-y',
        '-f', 'lavfi', '-i', 'color=c=black:s=160x90:r=30:d=1',
        '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo',
        '-shortest', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', inputPath
      ],
      { timeoutMs: 20_000 }
    );
    assert.equal(source.status, 0, source.stderr);
    await fsp.writeFile(danmakuPath, '', 'utf8');

    const service = new LiveRecordService();
    service.ffmpegPath = ffmpegPath;
    service.settings.outputDir = tempDir;
    service.log = () => {};
    service.recordings = [
      {
        cleanPath: inputPath,
        durationSec: 1,
        timelineHealth: { firstVideoPts: 1.03, firstAudioPts: 0 },
        streamMetadata: { firstVideoPts: 1.03, firstAudioPts: 0 }
      }
    ];
    let queuedRequest;
    const runExportClipNow = service.runExportClipNow.bind(service);
    service.runExportClipNow = async (request) => {
      queuedRequest = request;
      return runExportClipNow(request);
    };
    let releaseSubtitlePreparation;
    const subtitlePreparation = new Promise((resolve) => {
      releaseSubtitlePreparation = resolve;
    });
    service.generateSubtitleAssets = async () => {
      await subtitlePreparation;
      return {
        cssPath: path.join(tempDir, 'subtitle.css'),
        assPath: path.join(tempDir, 'subtitle.ass'),
        avatarPlan: { entries: [] }
      };
    };

    service.settings.burnCodec = 'libx264';
    const queued = await service.exportClip({
      recording: { cleanPath: inputPath, danmakuPath },
      mode: 'burn',
      startTime: 0,
      endTime: 1,
      outputPath
    });
    service.settings.burnCodec = 'libx265';
    assert.equal(queued.queued, true);
    await waitFor(() => service.exportProgress?.status === 'running' && service.exportProgress?.message === '正在生成字幕');
    assert.equal(service.exportQueue.length, 0, 'the task has left the waiting list only because it is now visible as current');
    assert.match(service.exportProgress.label, /导出烧录片段/);
    assert.equal(queuedRequest?.recording?.timelineHealth?.firstVideoPts, 1.03);
    assert.equal(queuedRequest?.recording?.timelineHealth?.firstAudioPts, 0);
    assert.equal(queuedRequest?.codec, 'libx264', 'queued export keeps the codec selected when it was enqueued');

    await service.cancelExportClip();
    assert.equal(service.exportProgress.message, '正在取消准备中的导出');
    releaseSubtitlePreparation();
    await waitFor(() => service.exportProgress?.status === 'cancelled');
    await waitFor(() => !service.exportQueueRunning);
  } finally {
    await fsp.rm(tempDir, { recursive: true, force: true });
  }
});
