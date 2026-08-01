const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { Readable, Writable } = require('node:stream');
const test = require('node:test');

const { LiveRecordService } = require('../src/server/app/service.cjs');
const { deriveClipPath, fetchWithTimeout, runCapturedProcess, runFfmpegProbe } = require('../src/server/shared/helpers.cjs');
const { createDefaultDanmakuCss, inspectDanmakuFile } = require('../src/server/danmaku/ass.cjs');
const {
  handleRequest,
  isLocalRequest,
  redactRemoteState,
  LOCAL_ONLY_API_PATHS,
  LOCAL_ONLY_ERROR
} = require('../src/server/app/routes.cjs');

const projectRoot = path.resolve(__dirname, '..');

test('long Windows recording titles are shortened before adding an export suffix', () => {
  const outputDir = 'C:\\recordings\\room';
  const cleanPath = path.join(outputDir, `${'原神特别节目'.repeat(30)}.clean.mp4`);
  const outputPath = deriveClipPath(cleanPath, outputDir, 'danmaku-gift', 0, 3600);

  assert.match(path.basename(outputPath), /\.clip_0-3600\.danmaku\.mp4$/);
  if (process.platform === 'win32') {
    assert.ok(outputPath.length <= 240, `expected a conservative Windows path, got ${outputPath.length}`);
  }
});

async function invokeApi({ remoteAddress = '127.0.0.1', method = 'GET', pathname, body, service }) {
  const request = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body), 'utf8')]);
  request.method = method;
  request.url = pathname;
  request.headers = { host: '127.0.0.1:3263' };
  request.socket = { remoteAddress };
  let statusCode = 200;
  let responseBody = '';
  const response = new Writable({
    write(chunk, _encoding, callback) {
      responseBody += chunk.toString('utf8');
      callback();
    }
  });
  response.writeHead = (status) => {
    statusCode = status;
  };
  const finished = new Promise((resolve) => response.once('finish', resolve));
  await handleRequest(service, null, 3263, request, response);
  await finished;
  return { statusCode, body: JSON.parse(responseBody) };
}

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

  let finishStatusCheck;
  let statusCheckCount = 0;
  service.rooms.set('1', { id: '1', monitoring: true, liveStatus: 0 });
  service.fetchRoomLiveStatus = () => {
    statusCheckCount += 1;
    return new Promise((resolve) => {
      finishStatusCheck = resolve;
    });
  };
  service.applyDetectedLiveStatus = async () => {};
  const firstTick = service.tickRoom('1');
  await new Promise((resolve) => setImmediate(resolve));
  await service.tickRoom('1');
  assert.equal(statusCheckCount, 1);
  finishStatusCheck({ liveStatus: 0 });
  await firstTick;
});

test('LAN state and SSE never expose the Bilibili cookie', async () => {
  const service = new LiveRecordService();
  service.settings.cookie = 'SESSDATA=secret-cookie';

  assert.equal(service.getState().settings.cookie, 'SESSDATA=secret-cookie');
  assert.equal(service.getState({ redactCookie: true }).settings.cookie, '');
  assert.equal(redactRemoteState({ settings: { cookie: 'SESSDATA=secret-cookie' } }, { redactCookie: true }).settings.cookie, '');

  let ssePayload = '';
  const response = {
    write(value) {
      ssePayload += value;
    },
    on() {}
  };
  service.addClient(response, { redactCookie: true });
  service.emitState();
  assert.doesNotMatch(ssePayload, /secret-cookie/);

  const stateResponse = await invokeApi({
    remoteAddress: '192.168.1.20',
    pathname: '/api/state',
    service
  });
  assert.equal(stateResponse.statusCode, 200);
  assert.equal(stateResponse.body.settings.cookie, '');

  let saveOptions;
  const saveResponse = await invokeApi({
    remoteAddress: '192.168.1.20',
    method: 'POST',
    pathname: '/api/settings/save',
    body: { settings: { cookie: '', pollIntervalSec: 20 } },
    service: {
      saveSettings(_settings, options) {
        saveOptions = options;
        return { settings: { cookie: 'SESSDATA=secret-cookie' } };
      }
    }
  });
  assert.deepEqual(saveOptions, { preserveCookie: true });
  assert.equal(saveResponse.body.settings.cookie, '');
});

test('external network binding gates the WebUI API before any recorder action runs', async () => {
  const service = new LiveRecordService();
  service.currentHost = '0.0.0.0';
  const response = await invokeApi({
    remoteAddress: '203.0.113.8',
    pathname: '/api/state',
    service
  });

  assert.equal(response.statusCode, 401);
  assert.equal(response.body.code, 'ACCESS_AUTH_REQUIRED');
});

test('media and export paths stay inside the recording library and match recording names', () => {
  const service = new LiveRecordService();
  const libraryDir = path.join(os.tmpdir(), 'br2k-recording-library');
  const sourcePath = path.join(libraryDir, '123456_anchor_title_20260716_120000.clean.mp4');
  const burnedPath = path.join(libraryDir, '123456_anchor_title_20260716_120000.danmaku.mp4');
  const clipPath = path.join(libraryDir, '123456_anchor_title_20260716_120000.clip_0-120.clean.mp4');
  const arbitraryName = path.join(libraryDir, 'holiday-video.mp4');
  const outsidePath = path.join(os.tmpdir(), 'br2k-outside', 'secret.clean.mp4');
  service.settings.outputDir = libraryDir;

  assert.equal(service.isKnownMediaPath(sourcePath), true);
  assert.equal(service.isKnownMediaPath(burnedPath), true);
  assert.equal(service.isKnownMediaPath(clipPath), true);
  assert.equal(service.isKnownMediaPath(arbitraryName), false);
  assert.equal(service.isKnownMediaPath(outsidePath), false);
  assert.doesNotThrow(() => service.assertExportSourcePath(sourcePath));
  assert.throws(() => service.assertExportSourcePath(outsidePath), /录像库目录/);
  assert.doesNotThrow(() => service.assertExportOutputPath(libraryDir, clipPath));
  assert.throws(() => service.assertExportOutputPath(path.dirname(outsidePath), outsidePath), /录像库目录/);
});

test('only the server computer can run system-level API actions', async () => {
  assert.equal(isLocalRequest({ socket: { remoteAddress: '127.0.0.1' } }), true);
  assert.equal(isLocalRequest({ socket: { remoteAddress: '::1' } }), true);
  assert.equal(isLocalRequest({ socket: { remoteAddress: '::ffff:127.0.0.1' } }), true);
  assert.equal(isLocalRequest({ socket: { remoteAddress: '192.168.1.20' } }), false);
  assert.equal(LOCAL_ONLY_API_PATHS.has('/api/shell/open-output'), true);
  assert.equal(LOCAL_ONLY_API_PATHS.has('/api/update/apply'), false);
  assert.equal(LOCAL_ONLY_API_PATHS.has('/api/system/shutdown'), false);

  const invoke = async (remoteAddress) => {
    const request = new Readable({
      read() {
        this.push(null);
      }
    });
    request.method = 'POST';
    request.url = '/api/shell/open-output';
    request.headers = { host: '127.0.0.1:3263' };
    request.socket = { remoteAddress };
    let statusCode = 200;
    let responseBody = '';
    const response = new Writable({
      write(chunk, _encoding, callback) {
        responseBody += chunk.toString('utf8');
        callback();
      }
    });
    response.writeHead = (status) => {
      statusCode = status;
    };
    let opened = false;
    const service = {
      openOutputDir: () => {
        opened = true;
        return { ok: true };
      }
    };
    const finished = new Promise((resolve) => response.once('finish', resolve));
    await handleRequest(service, null, 3263, request, response);
    await finished;
    return { opened, statusCode, responseBody };
  };

  const remote = await invoke('192.168.1.20');
  assert.equal(remote.opened, false);
  assert.equal(remote.statusCode, 403);
  assert.match(remote.responseBody, new RegExp(LOCAL_ONLY_ERROR));

  const local = await invoke('127.0.0.1');
  assert.equal(local.opened, true);
  assert.equal(local.statusCode, 200);
});

test(
  'path picker requests are single-flight while the first dialog is pending',
  { skip: process.platform !== 'win32' },
  async () => {
    const service = new LiveRecordService();
    let finishPicker;
    service.resolvePathPickerInitialPath = async (currentPath) => currentPath;
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

test(
  'path pickers replace a disconnected initial drive before opening the Windows dialog',
  { skip: process.platform !== 'win32' },
  async () => {
    const service = new LiveRecordService();
    let pickerEnvironment;
    service.getLocalFallbackDirectory = () => 'C:\\';
    service.probePathAvailability = async () => ({ kind: 'timeout', path: 'J:\\recordings', existingPath: '' });
    service.runWindowsPathPicker = (_script, environment) => {
      pickerEnvironment = environment;
      return Promise.resolve({ status: 2, stdout: '', stderr: '' });
    };

    const result = await service.selectPath({ type: 'directory', currentPath: 'J:\\recordings' });

    assert.deepEqual(result, { ok: false, cancelled: true });
    assert.equal(pickerEnvironment.BR2K_CURRENT_PATH, 'C:\\');
    assert.match(service.logs.at(-1).message, /盘符已断开/);
  }
);

test(
  'Windows path picker processes are terminated after the interactive timeout',
  { skip: process.platform !== 'win32' },
  async () => {
    const service = new LiveRecordService();
    const startedAt = Date.now();
    const result = await service.runWindowsPathPicker('Start-Sleep -Seconds 30', {}, { timeoutMs: 1000 });

    assert.equal(result.status, null);
    assert.match(result.error.message, /已自动关闭/);
    assert.ok(Date.now() - startedAt < 5000, 'hung picker should be terminated promptly');
  }
);

test(
  'Windows path picker script pins the native dialog above the browser window',
  { skip: process.platform !== 'win32' },
  async () => {
    const service = new LiveRecordService();
    let pickerScript = '';
    service.resolvePathPickerInitialPath = async (currentPath) => currentPath;
    service.runWindowsPathPicker = (script) => {
      pickerScript = script;
      return Promise.resolve({ status: 2, stdout: '', stderr: '' });
    };

    await service.selectPath({ type: 'directory', currentPath: 'C:\\' });

    assert.match(pickerScript, /HWND_TOPMOST/);
    assert.match(pickerScript, /PinVisibleDialog/);
    assert.match(pickerScript, /System\.Windows\.Forms\.Timer/);
    const typeDefinition = pickerScript.match(/Add-Type -TypeDefinition @'\r?\n([\s\S]*?)\r?\n'@/);
    assert.ok(typeDefinition, 'native foreground helper should be embedded in the picker script');
    const compileResult = await runCapturedProcess(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', `Add-Type -TypeDefinition @'\n${typeDefinition[1]}\n'@`],
      { timeoutMs: 10000 }
    );
    assert.equal(compileResult.status, 0, compileResult.stderr || compileResult.stdout);
  }
);

test('opening an unavailable directory falls back without creating the missing path', async () => {
  const service = new LiveRecordService();
  const openedPaths = [];
  service.settings.outputDir = 'J:\\recordings';
  service.getLocalFallbackDirectory = () => 'C:\\';
  service.probePathAvailability = async () => ({ kind: 'timeout', path: 'J:\\recordings', existingPath: '' });
  service.openSystemPath = (targetPath) => openedPaths.push(targetPath);

  const result = await service.openOutputDir();

  assert.deepEqual(openedPaths, ['C:\\']);
  assert.equal(result.operationNotice.kind, 'warning');
  assert.match(result.operationNotice.message, /J:\\recordings/);
  assert.match(result.operationNotice.message, /C:\\/);
});

test('saving a newly selected unavailable directory keeps the previous settings intact', async () => {
  const service = new LiveRecordService();
  const originalOutputDir = service.settings.outputDir;
  const originalPollIntervalSec = service.settings.pollIntervalSec;
  service.probePathAvailability = async () => ({ kind: 'timeout', path: 'J:\\recordings', existingPath: '' });
  service.saveStore = async () => {
    throw new Error('saveStore should not run for an unavailable replacement directory');
  };

  await assert.rejects(
    service.saveSettings({ outputDir: 'J:\\recordings', pollIntervalSec: originalPollIntervalSec + 5 }),
    /盘符可能已断开/
  );
  assert.equal(service.settings.outputDir, originalOutputDir);
  assert.equal(service.settings.pollIntervalSec, originalPollIntervalSec);
});

test('reachable missing directories can still be created through the bounded path helper', async () => {
  const service = new LiveRecordService();
  const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'br2k-path-create-'));
  const targetDir = path.join(tempDir, 'new-recording-directory');
  try {
    await service.ensureDirectoryReady(targetDir, { label: '测试目录' });
    assert.equal((await fsp.stat(targetDir)).isDirectory(), true);
  } finally {
    await fsp.rm(tempDir, { recursive: true, force: true });
  }
});

test('recording scans retain the library when the configured drive is disconnected', async () => {
  const service = new LiveRecordService();
  service.settings.outputDir = 'J:\\recordings';
  service.recordings = [{ id: 'existing', cleanPath: 'J:\\recordings\\existing.clean.mp4' }];
  service.probePathAvailability = async () => ({ kind: 'timeout', path: service.settings.outputDir, existingPath: '' });
  service.saveStore = async () => {
    throw new Error('saveStore should not run when a scan is skipped');
  };

  await service.performRecordingLibraryRefresh();

  assert.equal(service.recordings.length, 1);
  assert.equal(service.recordings[0].id, 'existing');
  assert.match(service.logs.at(-1).message, /已保留现有录像列表/);
});

test('the settings directory picker sends the current draft path instead of the last saved path', () => {
  const appSource = fs.readFileSync(path.join(projectRoot, 'src/client/App.tsx'), 'utf8');
  const clientSource = fs.readFileSync(path.join(projectRoot, 'src/client/recorderClient.ts'), 'utf8');

  assert.match(appSource, /recorder\.chooseOutputDir\(settingsDraft\?\.outputDir \|\| ''\)/);
  assert.match(clientSource, /currentPath\.trim\(\) \|\| latestState\?\.settings\.outputDir/);
});

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
