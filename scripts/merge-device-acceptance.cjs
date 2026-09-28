'use strict';

// Run on a real device with BR2K_ACCEPT_FFMPEG set to its production FFmpeg.
// All generated media stays in an isolated temporary directory.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { performance } = require('node:perf_hooks');
const { LiveRecordService } = require('../src/server/app/service.cjs');
const { probeMediaFileInfo, runCapturedProcess } = require('../src/server/shared/helpers.cjs');

async function main() {
  const ffmpegPath = process.env.BR2K_ACCEPT_FFMPEG || 'ffmpeg';
  const videoEncoder = process.env.BR2K_ACCEPT_VIDEO_ENCODER || 'libx264';
  const deleteSources = process.env.BR2K_ACCEPT_DELETE_SOURCES === '1';
  const realSources = [process.env.BR2K_ACCEPT_REAL_SOURCE_A, process.env.BR2K_ACCEPT_REAL_SOURCE_B];
  const useRealSources = realSources.every(Boolean);
  assert.ok(useRealSources || realSources.every(source => !source), 'both real source paths are required');
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'br2k-merge-device-'));
  const started = performance.now();
  let passed = false;
  try {
    const service = new LiveRecordService();
    const progress = [];
    const mergeLogs = [];
    service.ffmpegPath = ffmpegPath;
    service.settings.outputDir = directory;
    service.settings.autoBurnDanmaku = false;
    service.log = (_level, message) => {
      if (/合并方案|时间轴|规格变化|规范化/.test(message)) mergeLogs.push(message);
    };
    service.emitState = () => {
      if (room.mergeProgress) progress.push({ phase: room.mergeProgress.phase, status: room.mergeProgress.status });
    };
    service.saveStore = async () => {};
    service.scheduleQueuedUpdateCheck = () => {};
    service.finalizeLiveDiagnostics = async () => {};
    const room = { id: '883263', title: '隔离合并验收', recording: false };
    service.rooms.set(room.id, room);
    const firstAt = Date.parse('2026-09-26T20:00:00+08:00');
    const sources = [];
    const sourceMediaInfos = [];
    let sourceBytes = 0;
    let expectedDurationSec = 0;
    let expectedEvents = 0;
    for (let index = 0; index < 2; index++) {
      const cleanPath = path.join(directory, useRealSources
        ? path.basename(realSources[index]) : `883263_device_20260926_20000${index}.clean.mp4`);
      const danmakuPath = path.join(directory, `part-${index}.danmaku.jsonl`);
      if (useRealSources) {
        const source = realSources[index];
        assert.ok((await fs.stat(source)).size < 50 * 1024 * 1024, 'real sample must stay below 50 MiB');
        await fs.copyFile(source, cleanPath);
        await fs.copyFile(source.replace(/\.clean\.mp4$/i, '.danmaku.jsonl'), danmakuPath);
      } else {
        const generated = await runCapturedProcess(ffmpegPath, [
          '-hide_banner', '-loglevel', 'error', '-y',
          '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=30:duration=2',
          '-f', 'lavfi', '-i', `sine=frequency=${440 + index * 220}:sample_rate=48000:duration=2`,
          '-c:v', videoEncoder, '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', cleanPath
        ], { timeoutMs: 30_000 });
        assert.equal(generated.status, 0, generated.stderr);
        await fs.writeFile(danmakuPath, `${JSON.stringify({ type: 'danmaku', time: 0.5, text: `测试弹幕${index}`, uid: index + 1 })}\n`);
      }
      const sourceMedia = await probeMediaFileInfo(ffmpegPath, cleanPath);
      sourceMediaInfos.push(sourceMedia);
      sourceBytes += (await fs.stat(cleanPath)).size;
      const eventCount = (await fs.readFile(danmakuPath, 'utf8')).split(/\r?\n/).filter(Boolean).length;
      expectedDurationSec += sourceMedia.durationSec;
      expectedEvents += eventCount;
      service.recordings.push({ cleanPath, danmakuPath, roomId: room.id, startedAt: firstAt + index * 3000,
        durationSec: sourceMedia.durationSec, liveSessionId: 'same-broadcast', roomTitle: '原始直播标题',
        segmentTargetDurationSec: sourceMedia.durationSec, valid: true, eventCount });
      sources.push(cleanPath);
    }
    await service.mergeSelectedRecordings({ cleanPaths: [...sources].reverse(), deleteSources });
    const task = [...service.mergeInFlightGroups.values()][0];
    assert.ok(task, 'merge did not start');
    const merged = await task;
    assert.deepEqual(merged.mergedFrom, sources);
    assert.equal(merged.roomTitle, '原始直播标题');
    assert.ok(progress.some(item => item.status === 'running' || item.status === 'completed'),
      `没有收到合并状态：${JSON.stringify(progress)}`);
    const media = await probeMediaFileInfo(ffmpegPath, merged.cleanPath);
    assert.ok(media.videoInfo);
    assert.equal(media.videoInfo.width, Math.max(...sourceMediaInfos.map(info => info.videoInfo.width)));
    assert.equal(media.videoInfo.height, Math.max(...sourceMediaInfos.map(info => info.videoInfo.height)));
    assert.ok(Math.abs(media.durationSec - expectedDurationSec) < 0.25,
      `duration ${media.durationSec}, expected ${expectedDurationSec}`);
    const events = (await fs.readFile(merged.danmakuPath, 'utf8')).trim().split('\n').map(JSON.parse);
    assert.equal(events.length, expectedEvents);
    if (!useRealSources) assert.ok(events[1].time > events[0].time);
    for (const source of sources) {
      const sourceSize = await fs.stat(source).then(stat => stat.size).catch(error => {
        if (error.code === 'ENOENT') return 0;
        throw error;
      });
      assert.equal(sourceSize > 0, !deleteSources);
    }
    const result = { ok: true, host: os.hostname(), ffmpegPath,
      input: useRealSources ? 'real-recording-copy' : 'generated',
      videoEncoder: useRealSources ? 'source' : videoEncoder, durationSec: media.durationSec,
      sourceVideos: sourceMediaInfos.map(info => info.videoInfo),
      outputVideo: media.videoInfo,
      sourceBytes, mergeMode: room.mergeProgress?.mergeMode, mergeReason: room.mergeProgress?.mergeReason,
      mergeLogs: mergeLogs.slice(-8),
      outputBytes: (await fs.stat(merged.cleanPath)).size, danmakuEvents: events.length,
      sourcesRetained: !deleteSources, elapsedSec: Number(((performance.now() - started) / 1000).toFixed(3)) };
    passed = true;
    console.log(JSON.stringify(result));
  } finally {
    if (passed && path.dirname(directory) === path.resolve(os.tmpdir()) &&
      path.basename(directory).startsWith('br2k-merge-device-')) {
      await fs.rm(directory, { recursive: true, force: true });
    } else if (!passed) {
      console.error(`验收失败，隔离文件保留于 ${directory}`);
    }
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
