const fsp = require('node:fs/promises');
const path = require('node:path');
const { DIST_ROOT, writeJson, writeText, mimeType } = require('./service.cjs');

const MAX_JSON_BODY_BYTES = 1024 * 1024;
const DEFAULT_PORT = 3263;
const LOCAL_ONLY_API_PATHS = new Set([
  '/api/settings/choose-output-dir',
  '/api/shell/open-output',
  '/api/shell/open-path-dir',
  '/api/shell/select-path',
  '/api/shell/open-config'
]);
const LOCAL_ONLY_ERROR = '此操作只能在服务端电脑上执行，请在服务端电脑操作。';

async function createViteMiddleware() {
  const { createServer } = await import('vite');
  const vite = await createServer({
    server: { middlewareMode: true },
    appType: 'spa'
  });
  return vite;
}

async function handleRequest(service, vite, port, request, response) {
  const parsed = new URL(request.url || '/', `http://${request.headers.host || `127.0.0.1:${port}`}`);
  if (parsed.pathname.startsWith('/api/')) {
    await handleApi(service, parsed, port, request, response);
    return;
  }

  if (vite) {
    await serveVite(vite, parsed.pathname, request, response);
    return;
  }

  await serveStatic(parsed.pathname, response);
}

async function handleApi(service, parsed, port, request, response) {
  const pathname = parsed.pathname;
  if (!isTrustedApiRequest(request, port)) {
    writeJson(response, 403, { error: 'Forbidden' });
    return;
  }
  const stateOptions = { redactCookie: !isLocalRequest(request) };
  if (request.method === 'GET' && pathname === '/api/state') {
    writeJson(response, 200, service.getState(stateOptions));
    return;
  }

  if (request.method === 'GET' && pathname === '/api/image') {
    await service.proxyImage(parsed.searchParams.get('url'), response);
    return;
  }

  if (request.method === 'GET' && pathname === '/api/media') {
    await service.serveMedia(parsed.searchParams.get('path'), request, response);
    return;
  }

  if (request.method === 'GET' && pathname.startsWith('/api/export/preview/')) {
    await service.serveExportPreview(parsed, request, response);
    return;
  }

  if (request.method === 'GET' && pathname.startsWith('/api/preview/')) {
    await service.servePreview(parsed, request, response);
    return;
  }

  if (request.method === 'GET' && pathname === '/api/tray/state') {
    const afterSeq = Number(parsed.searchParams.get('after') || 0);
    writeText(response, 200, service.getTrayStateText(afterSeq));
    return;
  }

  if (request.method === 'GET' && pathname === '/api/events') {
    response.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no'
    });
    service.addClient(response, stateOptions);
    return;
  }

  if (request.method !== 'POST') {
    writeJson(response, 405, { error: 'Method not allowed' });
    return;
  }

  if (LOCAL_ONLY_API_PATHS.has(pathname) && !isLocalRequest(request)) {
    writeJson(response, 403, { error: LOCAL_ONLY_ERROR });
    return;
  }

  const body = await readJsonBody(request);
  const routes = {
    '/api/auth/qr/start': () => service.startQrLogin(),
    '/api/auth/qr/cancel': () => service.cancelQrLogin(),
    '/api/settings/choose-output-dir': () => service.chooseOutputDir(body.currentPath),
    '/api/settings/save': () => service.saveSettings(body.settings || body, { preserveCookie: stateOptions.redactCookie }),
    '/api/rooms/add': () => service.addRoom(body.roomId),
    '/api/rooms/remove': () => service.removeRoom(body.roomId),
    '/api/rooms/refresh': () => service.refreshRoom(body.roomId, { silent: Boolean(body.silent) }),
    '/api/rooms/monitor': () => service.setMonitoring(body.roomId, body.enabled),
    '/api/rooms/record/start': () => service.startRecording(body.roomId, false),
    '/api/rooms/record/stop': () => service.stopRecording(body.roomId),
    '/api/rooms/preview/start': () => service.startPreview(body.roomId),
    '/api/rooms/burn': () => service.startBurnDanmaku(body.roomId, body.options || {}),
    '/api/rooms/burn/cancel': () => service.cancelBurnDanmaku(body.roomId),
    '/api/rooms/subtitles': () => service.prepareDanmakuForRoom(body.roomId, body.options || {}),
    '/api/export/preview/start': () => service.startExportPreview(body),
    '/api/export/preview/cancel': () => service.cancelExportPreview(),
    '/api/export/subtitles': () => service.prepareSubtitleExport(body),
    '/api/export/clip': () => service.exportClip(body),
    '/api/export/cancel': () => service.cancelExportClip(),
    '/api/recordings/scan': () => service.refreshRecordingLibrary(),
    '/api/recordings/cleanup-merged': () => service.cleanupMergedSegmentResiduals(),
    '/api/logs/clear': () => service.clearLogs(),
    '/api/shell/open-output': () => service.openOutputDir(),
    '/api/shell/open-path-dir': () => service.openPathDir(body.path, { asDirectory: Boolean(body.asDirectory) }),
    '/api/shell/select-path': () => service.selectPath(body),
    '/api/shell/open-config': () => service.openConfigDir(),
    '/api/update/check': () => service.checkUpdate(),
    '/api/update/download': () => service.downloadUpdateOnly(),
    '/api/update/apply': () => service.applyUpdate(),
    '/api/update/queue': () => service.queueUpdateAfterJobs(),
    '/api/system/startup': () => service.setStartup(body.enabled),
    '/api/system/test-notification': () => service.testNotification(),
    '/api/system/shutdown': () => service.requestShutdown()
  };

  const action = routes[pathname];
  if (!action) {
    writeJson(response, 404, { error: 'Not found' });
    return;
  }

  try {
    const result = await action();
    writeJson(response, 200, result === undefined ? { ok: true } : redactRemoteState(result, stateOptions));
  } catch (error) {
    service.log('error', error.message || String(error));
    writeJson(response, 500, { error: error.message || String(error) });
  }
}

async function readJsonBody(request) {
  const chunks = [];
  let totalBytes = 0;
  for await (const chunk of request) {
    totalBytes += chunk.length;
    if (totalBytes > MAX_JSON_BODY_BYTES) {
      const error = new Error('请求体过大。');
      error.statusCode = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString('utf8').trim();
  if (!raw) {
    return {};
  }
  try {
    return JSON.parse(raw);
  } catch {
    const error = new Error('请求体不是有效 JSON。');
    error.statusCode = 400;
    throw error;
  }
}

function isTrustedApiRequest(request, port) {
  const fetchSite = String(request.headers['sec-fetch-site'] || '').toLowerCase();
  if (fetchSite && fetchSite !== 'same-origin' && fetchSite !== 'none') {
    return false;
  }
  const host = request.headers.host || `127.0.0.1:${port}`;
  const origin = request.headers.origin;
  if (origin && !isAllowedWebOrigin(origin, host, port)) {
    return false;
  }
  const referer = request.headers.referer;
  if (!origin && referer && !isAllowedWebOrigin(referer, host, port)) {
    return false;
  }
  return true;
}

function isAllowedWebOrigin(value, hostHeader, port) {
  let target;
  try {
    target = new URL(value);
  } catch {
    return false;
  }
  if (!['http:', 'https:'].includes(target.protocol)) {
    return false;
  }
  const originPort = Number(target.port || (target.protocol === 'https:' ? 443 : 80));
  const requestHost = normalizeHostHeader(hostHeader);
  if (requestHost.hostname && target.hostname.toLowerCase() === requestHost.hostname && originPort === requestHost.port) {
    return true;
  }
  return isLoopbackHost(target.hostname) && originPort === Number(port || DEFAULT_PORT);
}

function normalizeHostHeader(hostHeader) {
  const raw = String(hostHeader || '').trim();
  if (!raw) {
    return { hostname: '', port: DEFAULT_PORT };
  }
  try {
    const parsed = new URL(`http://${raw}`);
    return {
      hostname: parsed.hostname.toLowerCase(),
      port: Number(parsed.port || DEFAULT_PORT)
    };
  } catch {
    return { hostname: '', port: DEFAULT_PORT };
  }
}

function isLoopbackHost(hostname) {
  const host = String(hostname || '').toLowerCase();
  return host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]';
}

function isLocalRequest(request) {
  const remoteAddress = String(request.socket?.remoteAddress || request.connection?.remoteAddress || '').toLowerCase();
  return remoteAddress === '127.0.0.1' || remoteAddress === '::1' || remoteAddress === '::ffff:127.0.0.1';
}

function redactRemoteState(result, options = {}) {
  if (!options.redactCookie || !result || typeof result !== 'object' || !result.settings) {
    return result;
  }
  return {
    ...result,
    settings: { ...result.settings, cookie: '' }
  };
}

async function serveVite(vite, pathname, request, response) {
  await new Promise((resolve, reject) => {
    let settled = false;
    vite.middlewares(request, response, (error) => {
      if (settled) {
        return;
      }
      settled = true;
      if (error) {
        reject(error);
      } else {
        resolve();
      }
    });
    response.on('finish', () => {
      if (!settled) {
        settled = true;
        resolve();
      }
    });
  });

  if (response.writableEnded) {
    return;
  }

  const indexPath = path.join(APP_ROOT, 'index.html');
  const rawHtml = await fsp.readFile(indexPath, 'utf8');
  const html = await vite.transformIndexHtml(pathname, rawHtml);
  response.writeHead(200, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-cache'
  });
  response.end(html);
}

async function serveStatic(pathname, response) {
  const root = DIST_ROOT;
  const decodedPath = decodeURIComponent(pathname);
  const safePath = decodedPath === '/' ? '/index.html' : decodedPath;
  let filePath = path.resolve(root, `.${safePath}`);

  if (!filePath.startsWith(`${root}${path.sep}`) && filePath !== root) {
    writeJson(response, 403, { error: 'Forbidden' });
    return;
  }

  try {
    const stat = await fsp.stat(filePath);
    if (stat.isDirectory()) {
      filePath = path.join(filePath, 'index.html');
    }
  } catch {
    filePath = path.join(root, 'index.html');
  }

  try {
    const data = await fsp.readFile(filePath);
    response.writeHead(200, {
      'Content-Type': mimeType(filePath),
      'Cache-Control': filePath.endsWith('index.html') ? 'no-cache' : 'public, max-age=31536000, immutable'
    });
    response.end(data);
  } catch (error) {
    writeJson(response, 404, { error: `dist 未构建或文件不存在：${error.message}` });
  }
}

module.exports = {
  createViteMiddleware,
  handleRequest,
  isLocalRequest,
  redactRemoteState,
  LOCAL_ONLY_API_PATHS,
  LOCAL_ONLY_ERROR
};
