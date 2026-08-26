const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { Readable, Writable } = require('node:stream');
const test = require('node:test');

const { LiveRecordService, createUiCapabilities } = require('../src/server/app/service.cjs');
const {
  cookieHeadersFromLoginUrl,
  deriveClipPath,
  fetchWithTimeout,
  getCookieValue,
  mergeCookieString,
  runCapturedProcess,
  runFfmpegProbe,
  shouldTestHardwareEncoder
} = require('../src/server/shared/helpers.cjs');
const { createDefaultDanmakuCss, inspectDanmakuFile } = require('../src/server/danmaku/ass.cjs');
const {
  handleRequest,
  isLocalRequest,
  redactRemoteState,
  LOCAL_ONLY_API_PATHS,
  LOCAL_ONLY_ERROR
} = require('../src/server/app/routes.cjs');

const projectRoot = path.resolve(__dirname, '..');

test('QR login recovers credentials from the successful callback URL and updates login state', () => {
  const headers = cookieHeadersFromLoginUrl(
    'https://passport.biligame.com/crossDomain?DedeUserID=42&SESSDATA=abc%2Cdef&bili_jct=csrf-token&gourl=https%3A%2F%2Fwww.bilibili.com'
  );
  const cookie = mergeCookieString('', headers);
  assert.equal(getCookieValue(cookie, 'SESSDATA'), 'abc%2Cdef');
  assert.equal(getCookieValue(cookie, 'bili_jct'), 'csrf-token');
  assert.equal(cookieHeadersFromLoginUrl('https://evil.example/?SESSDATA=stolen').length, 0);
  const service = new LiveRecordService();
  service.settings.cookie = cookie;
  assert.equal(service.getState().bilibiliLoggedIn, true);
});

test('Linux hardware encoders are decided by the real FFmpeg probe even when adapter enumeration is unavailable', () => {
  const candidate = { vendor: 'nvidia' };
  assert.equal(shouldTestHardwareEncoder(candidate, [], 'linux'), true);
  assert.equal(shouldTestHardwareEncoder(candidate, [], 'win32'), false);
  assert.equal(shouldTestHardwareEncoder(candidate, [{ vendor: 'nvidia' }], 'win32'), true);
});

test('bootstrap environment credentials cannot override persistent settings after the first migration', async () => {
  const previousPassword = process.env.BILI_RECORD_AUTH_PASSWORD;
  const previousOutput = process.env.BILI_RECORD_OUTPUT_DIR;
  const previousAutoUpdate = process.env.BILI_RECORD_AUTO_UPDATE;
  process.env.BILI_RECORD_AUTH_PASSWORD = 'must-not-return';
  process.env.BILI_RECORD_OUTPUT_DIR = path.join(os.tmpdir(), 'must-not-return-output');
  process.env.BILI_RECORD_AUTO_UPDATE = '1';
  try {
    const service = new LiveRecordService();
    service.settings.configBootstrapVersion = 1;
    service.settings.accessPasswordHash = '';
    service.settings.outputDir = path.join(os.tmpdir(), 'persisted-output');
    service.settings.autoUpdateEnabled = false;
    service.saveStore = async () => {};
    await service.bootstrapPersistentConfiguration();
    assert.equal(service.settings.accessPasswordHash, '');
    assert.equal(service.settings.outputDir, path.join(os.tmpdir(), 'persisted-output'));
    assert.equal(service.settings.autoUpdateEnabled, false);
  } finally {
    if (previousPassword === undefined) delete process.env.BILI_RECORD_AUTH_PASSWORD;
    else process.env.BILI_RECORD_AUTH_PASSWORD = previousPassword;
    if (previousOutput === undefined) delete process.env.BILI_RECORD_OUTPUT_DIR;
    else process.env.BILI_RECORD_OUTPUT_DIR = previousOutput;
    if (previousAutoUpdate === undefined) delete process.env.BILI_RECORD_AUTO_UPDATE;
    else process.env.BILI_RECORD_AUTO_UPDATE = previousAutoUpdate;
  }
});

test('long Windows recording titles are shortened before adding an export suffix', () => {
  const outputDir = 'C:\\recordings\\room';
  const cleanPath = path.join(outputDir, `${'原神特别节目'.repeat(30)}.clean.mp4`);
  const outputPath = deriveClipPath(cleanPath, outputDir, 'danmaku-gift', 0, 3600);

  assert.match(path.basename(outputPath), /\.clip_0-3600\.danmaku\.mp4$/);
  if (process.platform === 'win32') {
    assert.ok(outputPath.length <= 240, `expected a conservative Windows path, got ${outputPath.length}`);
  }
});

async function invokeApi({ remoteAddress = '127.0.0.1', method = 'GET', pathname, body, service, headers = {} }) {
  const request = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body), 'utf8')]);
  request.method = method;
  request.url = pathname;
  request.headers = { host: '127.0.0.1:3263', ...headers };
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

test('startup cache migration removes obsolete preview and source-repair caches only', async () => {
  const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'br2k-cache-migration-'));
  const configRoot = path.join(tempDir, 'BiliRecord2K');
  const previewCacheDir = path.join(configRoot, 'preview-cache');
  const legacyRepairCacheDir = path.join(configRoot, 'repair-cache');
  const recordingDir = path.join(tempDir, 'recordings');
  const service = new LiveRecordService();
  service.storePath = path.join(configRoot, 'settings.json');
  service.previewCacheDir = previewCacheDir;
  service.legacyRepairCacheDir = legacyRepairCacheDir;
  const currentVersion = service.getState().version;

  try {
    await fsp.mkdir(path.join(previewCacheDir, 'preview-a'), { recursive: true });
    await fsp.writeFile(path.join(previewCacheDir, 'preview-a', 'index.m3u8'), '#EXTM3U\n', 'utf8');
    await fsp.mkdir(path.join(legacyRepairCacheDir, 'repair-a'), { recursive: true });
    await fsp.writeFile(path.join(legacyRepairCacheDir, 'repair-a', 'source.remux.mkv'), 'old-remux', 'utf8');
    await fsp.writeFile(
      path.join(legacyRepairCacheDir, 'repair-a', 'source.repaired.mp4'),
      'old-repaired-copy',
      'utf8'
    );
    await fsp.mkdir(recordingDir, { recursive: true });
    const recordingPath = path.join(recordingDir, 'keep.clean.mp4');
    await fsp.writeFile(recordingPath, 'recording-must-not-be-deleted', 'utf8');
    await fsp.writeFile(service.storePath, '{"rooms":[]}', 'utf8');
    await fsp.writeFile(
      service.getCacheStatePath(),
      JSON.stringify({ schemaVersion: 1, appVersion: '0.2.0', previewCacheVersion: 1 }),
      'utf8'
    );

    const migrated = await service.prepareVersionedCaches();
    assert.equal(migrated.cleared, true);
    assert.equal(migrated.clearedPreviewCache, true);
    assert.equal(migrated.previewEntriesRemoved, 1);
    assert.equal(migrated.clearedLegacyRepairCache, true);
    assert.equal(migrated.legacyRepairEntriesRemoved, 1);
    assert.deepEqual(await fsp.readdir(previewCacheDir), []);
    await assert.rejects(fsp.stat(legacyRepairCacheDir), { code: 'ENOENT' });
    assert.equal(await fsp.readFile(recordingPath, 'utf8'), 'recording-must-not-be-deleted');
    assert.equal(await fsp.readFile(service.storePath, 'utf8'), '{"rooms":[]}');
    const cacheState = JSON.parse(await fsp.readFile(service.getCacheStatePath(), 'utf8'));
    assert.equal(cacheState.appVersion, currentVersion);
    assert.match(service.logs.at(-1).message, /兼容预览缓存 1 项、旧版源流修复缓存 1 项/);

    await fsp.mkdir(path.join(previewCacheDir, 'current-preview'), { recursive: true });
    await fsp.writeFile(path.join(previewCacheDir, 'current-preview', 'index.m3u8'), '#EXTM3U\n', 'utf8');
    const sameVersion = await service.prepareVersionedCaches();
    assert.equal(sameVersion.cleared, false);
    assert.equal(
      await fsp.readFile(path.join(previewCacheDir, 'current-preview', 'index.m3u8'), 'utf8'),
      '#EXTM3U\n'
    );

    await fsp.mkdir(path.join(legacyRepairCacheDir, 'late-repair'), { recursive: true });
    await fsp.writeFile(path.join(legacyRepairCacheDir, 'late-repair', 'source.repaired.mp4'), 'obsolete', 'utf8');
    const repairOnly = await service.prepareVersionedCaches();
    assert.equal(repairOnly.cleared, true);
    assert.equal(repairOnly.clearedPreviewCache, false);
    assert.equal(repairOnly.clearedLegacyRepairCache, true);
    await assert.rejects(fsp.stat(legacyRepairCacheDir), { code: 'ENOENT' });
    assert.equal(
      await fsp.readFile(path.join(previewCacheDir, 'current-preview', 'index.m3u8'), 'utf8'),
      '#EXTM3U\n'
    );
  } finally {
    await fsp.rm(tempDir, { recursive: true, force: true });
  }
});

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
        input: JSON.stringify({
          danmakuPath,
          cssPath,
          assPath,
          overlayMode: 'danmaku',
          danmakuArea: 'half',
          videoInfo: { width: 540, height: 960 }
        }),
        timeoutMs: 10000
      }
    );
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), {
      ok: true,
      eventCount: 1,
      playWidth: 540,
      playHeight: 960,
      portrait: true
    });
    const ass = await fsp.readFile(assPath, 'utf8');
    assert.match(ass, /PlayResX: 540/);
    assert.match(ass, /PlayResY: 960/);
    assert.match(ass, /worker-test/);
  } finally {
    await fsp.rm(tempDir, { recursive: true, force: true });
  }
});

test('large avatar plans use a sidecar file instead of overflowing worker stdout', async () => {
  const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'br2k-ass-avatar-plan-'));
  const danmakuPath = path.join(tempDir, 'events.jsonl');
  const cssPath = path.join(tempDir, 'style.css');
  const assPath = path.join(tempDir, 'output.ass');
  const avatarPlanPath = path.join(tempDir, 'avatar-plan.json');
  const eventCount = 240;
  try {
    const events = Array.from({ length: eventCount }, (_, index) => ({
      type: 'gift',
      time: index * 2 + 1,
      uid: index + 1,
      user: `头像用户${index}`,
      giftName: '礼物',
      count: 1,
      avatarUrl: `https://i0.hdslb.com/bfs/face/${String(index).padStart(4, '0')}-${'x'.repeat(1700)}.jpg`
    }));
    await Promise.all([
      fsp.writeFile(danmakuPath, `${events.map((event) => JSON.stringify(event)).join('\n')}\n`, 'utf8'),
      fsp.writeFile(cssPath, createDefaultDanmakuCss(), 'utf8')
    ]);
    const result = await runCapturedProcess(
      process.execPath,
      [path.join(projectRoot, 'src/server/index.cjs'), '--ass-worker'],
      {
        input: JSON.stringify({
          danmakuPath,
          cssPath,
          assPath,
          avatarPlanPath,
          overlayMode: 'danmaku-gift',
          danmakuArea: 'half',
          stylePreset: 'h5-card',
          avatarOverlayMaxEntries: Number.MAX_SAFE_INTEGER,
          avatarOverlayMaxSegmentsPerEntry: 128,
          videoInfo: { width: 1920, height: 1080 }
        }),
        timeoutMs: 10000
      }
    );
    assert.equal(result.status, 0, result.stderr);
    const response = JSON.parse(result.stdout);
    assert.equal(response.ok, true);
    assert.equal(response.avatarPlanStored, true);
    assert.equal(Object.prototype.hasOwnProperty.call(response, 'avatarPlan'), false);
    assert.ok(Buffer.byteLength(result.stdout) < 4096);
    const avatarPlan = JSON.parse(await fsp.readFile(avatarPlanPath, 'utf8'));
    assert.ok(avatarPlan.entries.length >= eventCount, 'motion buckets may split one source into several safe layers');
    assert.equal(new Set(avatarPlan.entries.map((entry) => entry.uid)).size, eventCount);
    assert.ok(Buffer.byteLength(JSON.stringify(avatarPlan)) > 256 * 1024);
    assert.ok((await fsp.stat(assPath)).isFile());
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
      const response = JSON.parse(result.stdout);
      assert.equal(response.ok, true);
      assert.equal(response.eventCount, 1);
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
  service.settings.webhookBearerToken = 'secret-webhook-token';
  service.accessAuth.sessions.set('remote-test-session', { expiresAt: Date.now() + 60_000 });

  assert.equal(service.getState().settings.cookie, 'SESSDATA=secret-cookie');
  assert.equal(service.getState().settings.webhookBearerToken, '');
  assert.equal(service.getState().settings.webhookBearerTokenConfigured, true);
  assert.doesNotMatch(JSON.stringify(service.getState()), /secret-webhook-token/);
  assert.equal(service.getState().bilibiliLoggedIn, true);
  assert.equal(service.getState().bilibiliCookieVisible, true);
  assert.equal(service.getState({ redactCookie: true }).settings.cookie, '');
  assert.equal(service.getState({ redactCookie: true }).bilibiliLoggedIn, true);
  assert.equal(service.getState({ redactCookie: true }).bilibiliCookieVisible, false);
  const redacted = redactRemoteState(
    {
      settings: { cookie: 'SESSDATA=secret-cookie' },
      bilibiliLoggedIn: true,
      bilibiliCookieVisible: true,
      uiCapabilities: { nativePathPicker: true, openServerPath: true }
    },
    { redactCookie: true, localConsole: false }
  );
  assert.equal(redacted.settings.cookie, '');
  assert.equal(redacted.bilibiliLoggedIn, true);
  assert.equal(redacted.bilibiliCookieVisible, false);
  assert.equal(redacted.uiCapabilities.nativePathPicker, false);
  assert.equal(redacted.uiCapabilities.openServerPath, false);

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
  assert.doesNotMatch(ssePayload, /secret-webhook-token/);

  const stateResponse = await invokeApi({
    remoteAddress: '192.168.1.20',
    pathname: '/api/state',
    headers: { cookie: 'br2k_access=remote-test-session' },
    service
  });
  assert.equal(stateResponse.statusCode, 200);
  assert.equal(stateResponse.body.settings.cookie, '');
  assert.equal(stateResponse.body.bilibiliLoggedIn, true);
  assert.equal(stateResponse.body.bilibiliCookieVisible, false);

  let saveOptions;
  const saveResponse = await invokeApi({
    remoteAddress: '192.168.1.20',
    method: 'POST',
    pathname: '/api/settings/save',
    body: { settings: { cookie: '', pollIntervalSec: 20 } },
    headers: { cookie: 'br2k_access=remote-test-session' },
    service: {
      settings: {},
      authenticateAccess: (token) => token === 'remote-test-session',
      saveSettings(_settings, options) {
        saveOptions = options;
        return { settings: { cookie: 'SESSDATA=secret-cookie' } };
      }
    }
  });
  assert.deepEqual(saveOptions, { preserveCookie: true });
  assert.equal(saveResponse.body.settings.cookie, '');
});

test('generic Webhook posts event JSON with Bearer auth and retries transient failures', async () => {
  let requestCount = 0;
  const received = [];
  const receiver = http.createServer((request, response) => {
    let raw = '';
    request.setEncoding('utf8');
    request.on('data', (chunk) => {
      raw += chunk;
    });
    request.on('end', () => {
      requestCount += 1;
      received.push({
        method: request.method,
        headers: request.headers,
        body: JSON.parse(raw)
      });
      response.writeHead(requestCount === 1 ? 503 : 204);
      response.end();
    });
  });
  await new Promise((resolve) => receiver.listen(0, '127.0.0.1', resolve));
  const address = receiver.address();
  const service = new LiveRecordService();
  service.settings.webhookUrl = `http://127.0.0.1:${address.port}/events`;
  service.settings.webhookBearerToken = 'receiver-secret';
  service.settings.webhookAllowPrivateNetwork = true;

  try {
    const payload = await service.sendWebhookNotification(
      {
        id: 'event-1',
        event: 'recording.completed',
        title: '录制结束',
        message: '测试直播间录制完成',
        time: Date.UTC(2026, 7, 2, 12, 0, 0),
        data: { roomId: '123', eventCount: 456 }
      },
      { retryDelays: [0, 1] }
    );

    assert.equal(requestCount, 2);
    assert.equal(received[0].method, 'POST');
    assert.equal(received[1].headers.authorization, 'Bearer receiver-secret');
    assert.equal(received[1].headers['x-bilirecord2k-event'], 'recording.completed');
    assert.equal(received[1].body.event, 'recording.completed');
    assert.equal(received[1].body.occurredAt, '2026-08-02T12:00:00.000Z');
    assert.equal(received[1].body.data.roomId, '123');
    assert.equal(received[1].body.data.eventCount, 456);
    assert.equal(payload.source.name, 'BiliRecord2K');
  } finally {
    await new Promise((resolve, reject) => receiver.close((error) => (error ? reject(error) : resolve())));
  }
});

test('saving Webhook settings preserves an undisclosed token and can explicitly clear it', async () => {
  const service = new LiveRecordService();
  service.settings.webhookBearerToken = 'stored-secret';
  service.ensureDirectoryReady = async () => true;
  service.saveStore = async () => {};
  service.refreshOutputDiskSpace = async () => {};

  const preserved = await service.saveSettings({
    webhookEnabled: true,
    webhookUrl: 'https://notify.example.com/hook',
    webhookBearerToken: '',
    webhookBearerTokenConfigured: true,
    webhookBearerTokenClear: false
  });
  assert.equal(service.settings.webhookBearerToken, 'stored-secret');
  assert.equal(preserved.settings.webhookBearerToken, '');
  assert.equal(preserved.settings.webhookBearerTokenConfigured, true);

  const cleared = await service.saveSettings({
    webhookBearerToken: '',
    webhookBearerTokenConfigured: true,
    webhookBearerTokenClear: true
  });
  assert.equal(service.settings.webhookBearerToken, '');
  assert.equal(cleared.settings.webhookBearerTokenConfigured, false);
});

test('Linux cloud UI capabilities exclude desktop-only Windows actions', () => {
  assert.deepEqual(createUiCapabilities('linux', { BILI_RECORD_SYSTEMD: '1' }, { localConsole: false }), {
    nativePathPicker: false,
    openServerPath: false,
    nativeNotifications: false,
    startupControl: false,
    managedService: true,
    serviceShutdown: false
  });
  assert.deepEqual(createUiCapabilities('linux', { DISPLAY: ':0' }, { localConsole: true }), {
    nativePathPicker: false,
    openServerPath: true,
    nativeNotifications: false,
    startupControl: false,
    managedService: false,
    serviceShutdown: true
  });
});

test('client login badges and Linux pages use server state and platform capabilities', () => {
  const settingsSource = fs.readFileSync(path.join(projectRoot, 'src/client/pages/SettingsPage.tsx'), 'utf8');
  const overviewSource = fs.readFileSync(path.join(projectRoot, 'src/client/pages/OverviewPage.tsx'), 'utf8');
  const exportSource = fs.readFileSync(path.join(projectRoot, 'src/client/pages/ExportPage.tsx'), 'utf8');
  const maintenanceSource = fs.readFileSync(path.join(projectRoot, 'src/client/pages/MaintenancePage.tsx'), 'utf8');

  assert.match(settingsSource, /isBilibiliLoggedIn\(state\)/);
  assert.match(overviewSource, /isBilibiliLoggedIn\(state\)/);
  assert.doesNotMatch(settingsSource, /settingsDraft\.cookie\.includes\(['"]SESSDATA=/);
  assert.match(settingsSource, /uiCapabilities\?\.nativeNotifications/);
  assert.match(exportSource, /uiCapabilities\?\.nativePathPicker/);
  assert.match(maintenanceSource, /uiCapabilities\?\.serviceShutdown/);
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

test('a loopback reverse proxy cannot inherit the local-console authentication bypass', async () => {
  const service = new LiveRecordService();
  service.currentHost = '127.0.0.1';
  service.settings.trustedProxies = ['loopback'];
  const response = await invokeApi({
    remoteAddress: '127.0.0.1',
    pathname: '/api/state',
    headers: { 'x-forwarded-for': '203.0.113.8', 'x-forwarded-proto': 'https' },
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
      settings: {},
      authenticateAccess: () => true,
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

test('Windows system-drive directories do not depend on a PowerShell probe startup', async (t) => {
  if (process.platform !== 'win32') {
    t.skip('Windows-specific local-drive behavior');
    return;
  }
  const service = new LiveRecordService();
  const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'br2k-path-local-'));
  const targetDir = path.join(tempDir, 'new-recording-directory');
  try {
    await service.ensureDirectoryReady(targetDir, { label: '本地测试目录', timeoutMs: 250 });
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

test('Windows installer does not launch a legacy tray executable while the app is stopped', () => {
  const installerSource = fs.readFileSync(path.join(projectRoot, 'scripts/installer.nsi'), 'utf8');
  const installStop = installerSource.match(/Function StopRunningApp([\s\S]*?)FunctionEnd/)?.[1] || '';
  const uninstallStop = installerSource.match(/Function un\.StopRunningApp([\s\S]*?)FunctionEnd/)?.[1] || '';

  assert.match(installerSource, /OpenMutexW\(i 0x00100000, i 0, w "Local\\BiliRecord2K\.Tray"\)/);
  assert.match(installerSource, /FileWrite \$0 .*packageType.*installer/);
  assert.match(installerSource, /Delete "\$INSTDIR\\install-type\.json"/);
  for (const stopFunction of [installStop, uninstallStop]) {
    assert.match(stopFunction, /IsTrayRunning/);
    assert.ok(stopFunction.indexOf('IsTrayRunning') < stopFunction.indexOf('--request-shutdown'));
    assert.match(stopFunction, /StrCmp "\$0" "1" 0 forceStop/);
    assert.match(stopFunction, /ExecToLog \/TIMEOUT=125000 .*--request-shutdown/);
    assert.match(stopFunction, /ExecToLog \/TIMEOUT=10000 .*taskkill\.exe/);
  }
});

test(
  'Linux normalizes only the configured recording root and leaves historical contents untouched',
  { skip: process.platform !== 'linux' },
  async () => {
    const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'br2k-output-root-mode-'));
    const outputRoot = path.join(tempDir, 'custom-output');
    const historicalDir = path.join(outputRoot, 'historical-recording');
    const historicalFile = path.join(historicalDir, 'old.clean.mkv');
    const service = new LiveRecordService();
    try {
      await fsp.mkdir(historicalDir, { recursive: true, mode: 0o700 });
      await fsp.writeFile(historicalFile, 'history', { mode: 0o600 });
      await fsp.chmod(outputRoot, 0o700);
      await fsp.chmod(historicalDir, 0o700);
      await fsp.chmod(historicalFile, 0o600);

      const changed = await service.normalizeLinuxRecordingRootPermissions(outputRoot);

      assert.equal(changed, true);
      assert.equal((await fsp.stat(outputRoot)).mode & 0o7777, 0o2770);
      assert.equal((await fsp.stat(historicalDir)).mode & 0o7777, 0o700);
      assert.equal((await fsp.stat(historicalFile)).mode & 0o7777, 0o600);
    } finally {
      await fsp.rm(tempDir, { recursive: true, force: true });
    }
  }
);

test('Linux recording root permission normalization targets only the configured root node', async () => {
  const service = new LiveRecordService();
  const outputRoot = path.resolve('simulated-linux-output-root');
  let mode = 0o700;
  let gid = 2002;
  const calls = [];
  const fileSystem = {
    async stat(target) {
      calls.push(['stat', target]);
      return { mode, uid: 1001, gid, isDirectory: () => true };
    },
    async chown(target, uid, nextGid) {
      calls.push(['chown', target, uid, nextGid]);
      gid = nextGid;
    },
    async chmod(target, nextMode) {
      calls.push(['chmod', target, nextMode]);
      mode = nextMode;
    }
  };

  const changed = await service.normalizeLinuxRecordingRootPermissions(outputRoot, {
    platform: 'linux',
    currentUid: 1001,
    currentGid: 2001,
    fileSystem
  });

  assert.equal(changed, true);
  assert.equal(mode, 0o2770);
  assert.equal(gid, 2001);
  assert.ok(calls.every(([, target]) => target === outputRoot));
  assert.deepEqual(
    calls.map(([operation]) => operation),
    ['stat', 'chown', 'chmod', 'stat']
  );
});
