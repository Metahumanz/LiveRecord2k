const fsp = require('node:fs/promises');
const path = require('node:path');
const { DIST_ROOT, writeJson, writeText, mimeType } = require('./service.cjs');
const { parseCookieHeader, SESSION_TTL_MS } = require('./auth.cjs');

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
const ACCESS_COOKIE = 'br2k_access';

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
  const access = getAccessContext(service, request);
  if (parsed.pathname === '/api/access/login' && request.method === 'POST') {
    await handleAccessLogin(service, request, response);
    return;
  }
  if (parsed.pathname === '/api/access/logout' && request.method === 'POST') {
    service.logoutAccess(access.token);
    response.writeHead(303, {
      Location: '/',
      'Set-Cookie': `${ACCESS_COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`,
      'Cache-Control': 'no-store'
    });
    response.end();
    return;
  }
  if (access.required && !access.authenticated) {
    if (parsed.pathname.startsWith('/api/')) {
      writeJson(response, 401, { error: '请先登录远程管理页面。', code: 'ACCESS_AUTH_REQUIRED' });
    } else {
      serveAccessLoginPage(service, response);
    }
    return;
  }
  if (parsed.pathname.startsWith('/api/')) {
    await handleApi(service, parsed, port, request, response, access);
    return;
  }

  if (vite) {
    await serveVite(vite, parsed.pathname, request, response);
    return;
  }

  await serveStatic(parsed.pathname, response);
}

async function handleApi(service, parsed, port, request, response, access) {
  const pathname = parsed.pathname;
  if (!isTrustedApiRequest(request, port)) {
    writeJson(response, 403, { error: 'Forbidden' });
    return;
  }
  const localConsole = isLocalConsoleRequest(request);
  const stateOptions = { redactCookie: !localConsole, accessAuthenticated: access.authenticated };
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

  if (LOCAL_ONLY_API_PATHS.has(pathname) && !localConsole) {
    writeJson(response, 403, { error: LOCAL_ONLY_ERROR });
    return;
  }

  const body = await readJsonBody(request);
  const routes = {
    '/api/auth/qr/start': () => service.startQrLogin(),
    '/api/auth/qr/cancel': () => service.cancelQrLogin(),
    '/api/settings/choose-output-dir': () => service.chooseOutputDir(body.currentPath),
    '/api/settings/save': () => service.saveSettings(body.settings || body, { preserveCookie: stateOptions.redactCookie }),
    '/api/system/disk-space': () => service.getDiskSpace(body.path),
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

async function handleAccessLogin(service, request, response) {
  const contentType = String(request.headers['content-type'] || '').toLowerCase();
  const raw = await readRequestBody(request);
  let body = {};
  if (contentType.includes('application/json')) {
    try {
      body = raw ? JSON.parse(raw) : {};
    } catch {
      writeJson(response, 400, { error: '请求体不是有效 JSON。' });
      return;
    }
  } else {
    body = Object.fromEntries(new URLSearchParams(raw));
  }
  try {
    const session = await service.loginAccess(body.username, body.password, getRemoteKey(request));
    const secure = request.socket?.encrypted || String(request.headers['x-forwarded-proto'] || '').toLowerCase() === 'https';
    response.writeHead(303, {
      Location: '/',
      'Set-Cookie': `${ACCESS_COOKIE}=${encodeURIComponent(session.token)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${Math.floor(
        SESSION_TTL_MS / 1000
      )}${secure ? '; Secure' : ''}`,
      'Cache-Control': 'no-store'
    });
    response.end();
  } catch (error) {
    serveAccessLoginPage(service, response, error.message || '登录失败。', error.statusCode || 401);
  }
}

function getAccessContext(service, request) {
  const host = String(service.currentHost || service.settings?.serverHost || '').toLowerCase();
  const exposed = host === '0.0.0.0' || host === '::';
  const required = exposed && !isLocalConsoleRequest(request);
  const token = parseCookieHeader(request.headers.cookie)[ACCESS_COOKIE] || '';
  return {
    required,
    token,
    authenticated: !required || service.authenticateAccess(token)
  };
}

function serveAccessLoginPage(service, response, errorMessage = '', statusCode = 200) {
  const configured = service.accessAuth.isConfigured(service.settings);
  const username = escapeHtml(service.settings?.accessUsername || 'admin');
  const message = errorMessage
    ? `<div class="notice error">${escapeHtml(errorMessage)}</div>`
    : configured
      ? '<div class="notice">此服务正在监听外部网络，登录后才能进入管理界面。</div>'
      : '<div class="notice error">远程访问密码尚未配置。请在服务端本机设置，或通过 BILI_RECORD_AUTH_PASSWORD 环境变量启动。</div>';
  const html = `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>远程访问登录 · 哔哩录播 2K</title>
  <style>
    :root{color-scheme:dark;font-family:Inter,"Microsoft YaHei UI",system-ui,sans-serif;background:#0b1017;color:#edf3fb}
    *{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;padding:24px;background:radial-gradient(circle at 20% 0,#19324a 0,transparent 38%),#0b1017}
    main{width:min(420px,100%);padding:32px;border:1px solid #2a3b4d;border-radius:22px;background:rgba(17,25,35,.94);box-shadow:0 24px 80px rgba(0,0,0,.45)}
    .eyebrow{margin:0 0 8px;color:#63d4ff;font-size:13px;font-weight:700;letter-spacing:.12em;text-transform:uppercase}h1{margin:0 0 10px;font-size:27px}p{color:#aebccc;line-height:1.65}
    .notice{margin:20px 0;padding:12px 14px;border-radius:12px;background:#152b3a;color:#bfeaff;font-size:14px}.notice.error{background:#3b2025;color:#ffd3d8}
    label{display:grid;gap:8px;margin-top:16px;color:#cbd6e2;font-size:14px;font-weight:650}input{width:100%;padding:12px 13px;border:1px solid #34475a;border-radius:11px;background:#0d151f;color:#fff;font:inherit;outline:none}input:focus{border-color:#56c9f5;box-shadow:0 0 0 3px rgba(86,201,245,.14)}
    button{width:100%;margin-top:22px;padding:13px;border:0;border-radius:12px;background:linear-gradient(135deg,#38bdf8,#0ea5e9);color:#061019;font:inherit;font-weight:800;cursor:pointer}button:disabled{opacity:.55;cursor:not-allowed}.foot{margin:18px 0 0;text-align:center;font-size:12px;color:#75869a}
  </style>
</head>
<body><main><p class="eyebrow">BiliRecord2K</p><h1>远程管理登录</h1>${message}<form method="post" action="/api/access/login"><label>用户名<input name="username" autocomplete="username" value="${username}" required></label><label>密码<input name="password" type="password" autocomplete="current-password" required></label><button type="submit"${configured ? '' : ' disabled'}>进入管理界面</button></form><p class="foot">会话 12 小时后失效；连续失败会触发临时限速。</p></main></body></html>`;
  response.writeHead(statusCode, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer'
  });
  response.end(html);
}

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function getRemoteKey(request) {
  return String(request.socket?.remoteAddress || request.connection?.remoteAddress || 'unknown').toLowerCase();
}

async function readRequestBody(request) {
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
  return Buffer.concat(chunks).toString('utf8').trim();
}

async function readJsonBody(request) {
  const raw = await readRequestBody(request);
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
  const rawHost = String(hostHeader || '').trim().toLowerCase();
  if (rawHost && target.host.toLowerCase() === rawHost) {
    return true;
  }
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

function isLocalConsoleRequest(request) {
  if (!isLocalRequest(request)) {
    return false;
  }
  const host = normalizeHostHeader(request.headers.host);
  return isLoopbackHost(host.hostname);
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
