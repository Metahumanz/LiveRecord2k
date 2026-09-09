'use strict';

// Opt-in local FFmpeg stress probe for the recording-preemption window.
// It never contacts Bilibili: a short local MPEG-TS fixture is looped with
// -c copy for the simulated recordings, while the cancellable preview uses
// the real NVENC encoder. Run with: npm run stress:recording

const assert = require('node:assert/strict');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const ffmpegPath = require('ffmpeg-static');
const { MediaJobManager } = require('../src/server/app/media-job-manager.cjs');

const START_TIMEOUT_MS = 12_000;
const EXIT_TIMEOUT_MS = 5_000;

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function startFfmpeg(label, args) {
  const child = spawn(
    ffmpegPath,
    ['-hide_banner', '-loglevel', 'warning', '-nostdin', ...args],
    { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] }
  );
  let stderr = '';
  child.stderr.on('data', (chunk) => {
    stderr = `${stderr}${chunk}`.slice(-12_000);
  });
  const completion = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => resolve({ code, signal, stderr }));
  });
  return { label, child, completion, getStderr: () => stderr };
}

async function waitForFileSize(filePath, processInfo, label, minimumBytes = 64 * 1024) {
  const deadline = Date.now() + START_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const stat = await fsp.stat(filePath).catch(() => null);
    if (Number(stat?.size || 0) >= minimumBytes) return Number(stat.size);
    if (processInfo.child.exitCode !== null || processInfo.child.signalCode !== null) {
      const result = await processInfo.completion;
      throw new Error(`${label} 在写入输出前退出（code=${result.code}, signal=${result.signal}）：${result.stderr}`);
    }
    await delay(100);
  }
  throw new Error(`${label} 未在 ${START_TIMEOUT_MS}ms 内写入 ${minimumBytes} 字节。${processInfo.getStderr()}`);
}

async function fileSize(filePath) {
  const stat = await fsp.stat(filePath);
  return Number(stat.size || 0);
}

async function stopFfmpeg(processInfo) {
  if (!processInfo) return null;
  const { child, completion } = processInfo;
  if (child.exitCode === null && child.signalCode === null) {
    child.kill('SIGTERM');
  }
  const timeout = delay(EXIT_TIMEOUT_MS).then(() => null);
  let result = await Promise.race([completion, timeout]);
  if (result !== null) return result;
  child.kill('SIGKILL');
  result = await completion;
  return result;
}

async function createLoopFixture(directory) {
  const fixturePath = path.join(directory, 'fixture.ts');
  const fixture = startFfmpeg('fixture', [
    '-y',
    '-f', 'lavfi', '-i', 'testsrc2=size=1280x720:rate=30:duration=3',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
    '-f', 'mpegts', fixturePath
  ]);
  const result = await fixture.completion;
  assert.equal(result.code, 0, `无法生成本地压力测试素材：${result.stderr}`);
  return fixturePath;
}

function startCopyRecording(fixturePath, outputPath, label) {
  return startFfmpeg(label, [
    '-y', '-stream_loop', '-1', '-re', '-i', fixturePath,
    '-map', '0:v:0', '-c:v', 'copy', '-f', 'mpegts', outputPath
  ]);
}

function startNvencPreview(fixturePath, outputPath, label) {
  return startFfmpeg(label, [
    '-y', '-stream_loop', '-1', '-re', '-i', fixturePath,
    '-map', '0:v:0', '-vf', 'scale=1280:720',
    '-c:v', 'h264_nvenc', '-preset', 'p4', '-b:v', '4M', '-maxrate', '4M',
    '-f', 'mpegts', outputPath
  ]);
}

async function probeNvenc() {
  const probe = startFfmpeg('NVENC probe', [
    '-f', 'lavfi', '-i', 'testsrc2=size=320x240:rate=1:duration=1',
    '-frames:v', '1', '-c:v', 'h264_nvenc', '-f', 'null', '-'
  ]);
  const result = await probe.completion;
  if (result.code === 0) return { available: true };
  const detail = String(result.stderr || '').trim().replace(/\s+/g, ' ').slice(0, 600);
  return {
    available: false,
    reason: detail || `FFmpeg 以 code=${result.code}, signal=${result.signal || 'none'} 退出`
  };
}

async function runScenario({ directory, fixturePath, name, initialRecordings, diskWriteLimit }) {
  const manager = new MediaJobManager({
    limits: { diskRead: initialRecordings + 1, diskWrite: diskWriteLimit, gpuEncode: 1 }
  });
  const recordings = [];
  const releases = [];
  let preview;
  let previewLease;
  let previewExitAt = 0;
  let cancelRequestedAt = 0;

  try {
    for (let index = 1; index <= initialRecordings; index += 1) {
      const outputPath = path.join(directory, `${name}-recording-${index}.ts`);
      const processInfo = startCopyRecording(fixturePath, outputPath, `${name} recording ${index}`);
      recordings.push({ outputPath, processInfo });
      releases.push(
        manager.registerExternal({
          id: `${name}:recording:${index}`,
          type: 'recording',
          resources: ['recording', 'network', 'diskWrite']
        })
      );
      await waitForFileSize(outputPath, processInfo, `${name} 录制 ${index}`);
    }

    const previewPath = path.join(directory, `${name}-preview.ts`);
    preview = startNvencPreview(fixturePath, previewPath, `${name} NVENC preview`);
    previewLease = await manager.acquire({
      id: `${name}:preview`,
      type: 'preview',
      resources: ['diskRead', 'diskWrite', 'gpuEncode'],
      cancel: () => {
        if (cancelRequestedAt) return;
        cancelRequestedAt = Date.now();
        preview.child.kill('SIGTERM');
      }
    });
    preview.completion.then(() => {
      previewExitAt = Date.now();
      previewLease.release();
    }).catch(() => {
      previewExitAt = Date.now();
      previewLease.release();
    });
    await waitForFileSize(previewPath, preview, `${name} NVENC 预览`);

    const nextIndex = initialRecordings + 1;
    const nextOutputPath = path.join(directory, `${name}-recording-${nextIndex}.ts`);
    const nextRecording = {
      outputPath: nextOutputPath,
      processInfo: startCopyRecording(fixturePath, nextOutputPath, `${name} recording ${nextIndex}`)
    };
    recordings.push(nextRecording);
    // This mirrors the product order: the new FFmpeg capture is allowed to
    // start immediately, and registerExternal requests preemption in parallel.
    releases.push(
      manager.registerExternal({
        id: `${name}:recording:${nextIndex}`,
        type: 'recording',
        resources: ['recording', 'network', 'diskWrite']
      })
    );
    await waitForFileSize(nextOutputPath, nextRecording.processInfo, `${name} 录制 ${nextIndex}`);
    const previewResult = await preview.completion;
    assert.ok(cancelRequestedAt > 0, `${name} 新录制没有请求取消冲突的预览任务`);
    assert.ok(previewExitAt >= cancelRequestedAt, `${name} 预览未记录退出时间`);
    const preemptionExitMs = previewExitAt - cancelRequestedAt;
    assert.ok(
      preemptionExitMs <= EXIT_TIMEOUT_MS,
      `${name} 被抢占的预览在 ${preemptionExitMs}ms 后才退出，超过 ${EXIT_TIMEOUT_MS}ms 上限：${previewResult.stderr}`
    );

    const beforeSizes = await Promise.all(recordings.map(({ outputPath }) => fileSize(outputPath)));
    await delay(1_200);
    const afterSizes = await Promise.all(recordings.map(({ outputPath }) => fileSize(outputPath)));
    const growthBytes = afterSizes.map((size, index) => size - beforeSizes[index]);
    assert.ok(growthBytes.every((growth) => growth > 0), `${name} 存在断流或停写：${growthBytes.join(', ')}`);

    return {
      name,
      recordingCount: recordings.length,
      previewExitCode: previewResult.code,
      previewExitSignal: previewResult.signal,
      preemptionExitMs,
      growthBytes
    };
  } finally {
    previewLease?.release();
    for (const release of releases.reverse()) release();
    await Promise.all(recordings.map(({ processInfo }) => stopFfmpeg(processInfo)));
    await stopFfmpeg(preview);
  }
}

async function main() {
  const nvenc = await probeNvenc();
  if (!nvenc.available) {
    process.stdout.write(`${JSON.stringify({
      status: 'SKIPPED',
      reason: `NVENC 不可用，未执行录制抢占压力测试：${nvenc.reason}`,
      scenarios: []
    }, null, 2)}\n`);
    return;
  }
  const directory = await fsp.mkdtemp(path.join(os.tmpdir(), 'br2k-recording-preemption-'));
  try {
    const fixturePath = await createLoopFixture(directory);
    const results = [];
    results.push(await runScenario({
      directory,
      fixturePath,
      name: 'two-recordings',
      initialRecordings: 1,
      diskWriteLimit: 2
    }));
    results.push(await runScenario({
      directory,
      fixturePath,
      name: 'three-recordings',
      initialRecordings: 2,
      diskWriteLimit: 3
    }));
    process.stdout.write(`${JSON.stringify({ passed: true, scenarios: results }, null, 2)}\n`);
  } finally {
    await fsp.rm(directory, { recursive: true, force: true });
  }
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exitCode = 1;
});
