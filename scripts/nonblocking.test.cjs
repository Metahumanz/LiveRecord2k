const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { LiveRecordService } = require('../src/server/app/service.cjs');
const { fetchWithTimeout, runCapturedProcess, runFfmpegProbe } = require('../src/server/shared/helpers.cjs');
const { createDefaultDanmakuCss, inspectDanmakuFile } = require('../src/server/danmaku/ass.cjs');

const projectRoot = path.resolve(__dirname, '..');

test('captured child processes do not block the Node event loop', async () => {
  let heartbeat = false;
  const heartbeatTimer = setTimeout(() => {
    heartbeat = true;
  }, 30);
  const result = await runCapturedProcess(
    process.execPath,
    ['-e', 'setTimeout(() => process.stdout.write("ready"), 160)'],
    { timeoutMs: 2000 }
  );
  clearTimeout(heartbeatTimer);

  assert.equal(result.status, 0);
  assert.equal(result.stdout, 'ready');
  assert.equal(heartbeat, true);
});

test('captured child processes are terminated after their timeout', async () => {
  const startedAt = Date.now();
  const result = await runCapturedProcess(process.execPath, ['-e', 'setTimeout(() => {}, 10000)'], {
    timeoutMs: 120
  });

  assert.equal(result.timedOut, true);
  assert.ok(Date.now() - startedAt < 3000, 'timed out child should be reaped promptly');
});

test('ffmpeg-style probes report a readable timeout error', async () => {
  const result = await runFfmpegProbe(process.execPath, ['-e', 'setTimeout(() => {}, 10000)'], { timeoutMs: 100 });

  assert.equal(result.ok, false);
  assert.match(result.error, /探测超时/);
});

test('captured child processes can receive bounded worker input', async () => {
  const result = await runCapturedProcess(
    process.execPath,
    ['-e', 'process.stdin.setEncoding("utf8"); let s=""; process.stdin.on("data", c => s += c); process.stdin.on("end", () => process.stdout.write(s.toUpperCase()));'],
    { input: 'worker input', timeoutMs: 2000 }
  );

  assert.equal(result.status, 0);
  assert.equal(result.stdout, 'WORKER INPUT');
});

test('danmaku inspection streams JSONL once and tolerates malformed lines', async () => {
  const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'br2k-danmaku-'));
  const danmakuPath = path.join(tempDir, 'events.jsonl');
  try {
    await fsp.writeFile(
      danmakuPath,
      `${JSON.stringify({ type: 'danmaku', time: 1.5, text: 'a' })}\nnot-json\n${JSON.stringify({ type: 'gift', time: 9 })}\n`,
      'utf8'
    );
    const summary = await inspectDanmakuFile(danmakuPath, { includeEvents: true });
    assert.equal(summary.eventCount, 3);
    assert.equal(summary.durationSec, 9);
    assert.equal(summary.events.length, 2);
  } finally {
    await fsp.rm(tempDir, { recursive: true, force: true });
  }
});

test('ASS generation runs successfully in the isolated worker process', async () => {
  const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'br2k-ass-worker-'));
  const danmakuPath = path.join(tempDir, 'events.jsonl');
  const cssPath = path.join(tempDir, 'style.css');
  const assPath = path.join(tempDir, 'output.ass');
  try {
    await Promise.all([
      fsp.writeFile(danmakuPath, `${JSON.stringify({ type: 'danmaku', time: 1, text: 'worker-test' })}\n`, 'utf8'),
      fsp.writeFile(cssPath, createDefaultDanmakuCss(), 'utf8')
    ]);
    const result = await runCapturedProcess(
      process.execPath,
      [path.join(projectRoot, 'src/server/index.cjs'), '--ass-worker'],
      {
        input: JSON.stringify({ danmakuPath, cssPath, assPath, overlayMode: 'danmaku', danmakuArea: 'half' }),
        timeoutMs: 10000
      }
    );
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), { ok: true, eventCount: 1 });
    assert.match(await fsp.readFile(assPath, 'utf8'), /worker-test/);
  } finally {
    await fsp.rm(tempDir, { recursive: true, force: true });
  }
});

test(
  'packaged Windows service can enter ASS worker mode',
  { skip: !fs.existsSync(path.join(projectRoot, 'release', 'webui', 'BiliRecord2K.Service.exe')) },
  async () => {
    const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'br2k-sea-worker-'));
    const danmakuPath = path.join(tempDir, 'events.jsonl');
    const cssPath = path.join(tempDir, 'style.css');
    const assPath = path.join(tempDir, 'output.ass');
    try {
      await Promise.all([
        fsp.writeFile(danmakuPath, `${JSON.stringify({ type: 'danmaku', time: 1, text: 'sea-worker-test' })}\n`, 'utf8'),
        fsp.writeFile(cssPath, createDefaultDanmakuCss(), 'utf8')
      ]);
      const result = await runCapturedProcess(
        path.join(projectRoot, 'release', 'webui', 'BiliRecord2K.Service.exe'),
        ['--ass-worker'],
        {
          input: JSON.stringify({ danmakuPath, cssPath, assPath, overlayMode: 'danmaku', danmakuArea: 'half' }),
          timeoutMs: 10000
        }
      );
      assert.equal(result.status, 0, result.stderr);
      assert.deepEqual(JSON.parse(result.stdout), { ok: true, eventCount: 1 });
      assert.match(await fsp.readFile(assPath, 'utf8'), /sea-worker-test/);
    } finally {
      await fsp.rm(tempDir, { recursive: true, force: true });
    }
  }
);

test('Bilibili fetches fail with a readable timeout', async () => {
  const originalFetch = global.fetch;
  global.fetch = (_url, options = {}) =>
    new Promise((_resolve, reject) => {
      options.signal?.addEventListener('abort', () => {
        const error = new Error('aborted');
        error.name = 'AbortError';
        reject(error);
      });
    });
  try {
    await assert.rejects(fetchWithTimeout('https://example.invalid', {}, 25, '测试请求'), /测试请求超时/);
    global.fetch = (_url, options = {}) =>
      Promise.resolve({
        text: () =>
          new Promise((_resolve, reject) => {
            options.signal?.addEventListener('abort', () => {
              const error = new Error('body aborted');
              error.name = 'AbortError';
              reject(error);
            });
          })
      });
    await assert.rejects(
      fetchWithTimeout('https://example.invalid', {}, 25, '响应读取', (response) => response.text()),
      /响应读取超时/
    );
  } finally {
    global.fetch = originalFetch;
  }
});

test('recording scans and room ticks are single-flight', async () => {
  const service = new LiveRecordService();
  service.getState = () => ({ ok: true });
  let finishScan;
  let scanCount = 0;
  service.performRecordingLibraryRefresh = () => {
    scanCount += 1;
    return new Promise((resolve) => {
      finishScan = resolve;
    });
  };
  const firstScan = service.refreshRecordingLibrary();
  const secondScan = service.refreshRecordingLibrary();
  assert.equal(scanCount, 1);
  finishScan({ ok: true });
  await Promise.all([firstScan, secondScan]);

  let finishRefresh;
  let refreshCount = 0;
  service.rooms.set('1', { id: '1', monitoring: true, liveStatus: 0 });
  service.refreshRoom = () => {
    refreshCount += 1;
    return new Promise((resolve) => {
      finishRefresh = resolve;
    });
  };
  const firstTick = service.tickRoom('1');
  await new Promise((resolve) => setImmediate(resolve));
  await service.tickRoom('1');
  assert.equal(refreshCount, 1);
  finishRefresh();
  await firstTick;
});

test(
  'path picker requests are single-flight while the first dialog is pending',
  { skip: process.platform !== 'win32' },
  async () => {
    const service = new LiveRecordService();
    let finishPicker;
    service.runWindowsPathPicker = () =>
      new Promise((resolve) => {
        finishPicker = resolve;
      });

    const firstRequest = service.selectPath({ type: 'directory', currentPath: 'C:\\' });
    await new Promise((resolve) => setImmediate(resolve));
    const secondResult = await service.selectPath({ type: 'directory', currentPath: 'C:\\' });

    assert.equal(secondResult.ok, false);
    assert.equal(secondResult.cancelled, false);
    assert.match(secondResult.message, /已有系统路径选择器/);

    finishPicker({ status: 2, stdout: '', stderr: '' });
    const firstResult = await firstRequest;
    assert.deepEqual(firstResult, { ok: false, cancelled: true });
    assert.equal(service.pathPickerPromise, null);
  }
);

test('runtime server code does not reintroduce synchronous child processes', () => {
  const serviceSource = fs.readFileSync(path.join(projectRoot, 'src/server/app/service.cjs'), 'utf8');
  const helperSource = fs.readFileSync(path.join(projectRoot, 'src/server/shared/helpers.cjs'), 'utf8');

  assert.doesNotMatch(serviceSource, /\bspawnSync\b/);
  assert.doesNotMatch(helperSource, /\bspawnSync\b/);
  assert.doesNotMatch(serviceSource, /fs\.existsSync\(/);
});

test('danmaku runtime avoids synchronous decompression', () => {
  const clientSource = fs.readFileSync(path.join(projectRoot, 'src/server/danmaku/client.cjs'), 'utf8');

  assert.doesNotMatch(clientSource, /inflateSync|brotliDecompressSync/);
  assert.match(clientSource, /maxPayload: MAX_WEBSOCKET_PAYLOAD_BYTES/);
});

test('tray polling stays off the window thread and uses callback coordinates', () => {
  const traySource = fs.readFileSync(path.join(projectRoot, 'scripts/win-tray-launcher.c'), 'utf8');

  assert.match(traySource, /CreateThread\(NULL, 0, tray_poll_thread/);
  assert.match(traySource, /case WM_TRAY_POLL_COMPLETE/);
  assert.match(traySource, /GET_X_LPARAM\(wparam\)/);
  assert.match(traySource, /Shell_NotifyIconGetRect/);
});
