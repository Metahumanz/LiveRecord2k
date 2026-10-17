const fsp = require('node:fs/promises');
const path = require('node:path');
const { DIST_ROOT, writeJson, writeText, mimeType, isBusinessError } = require('./service.cjs');
const { parseCookieHeader, SESSION_TTL_MS } = require('./auth.cjs');
const {
  getRequestNetworkContext,
  hasForwardingHeaders,
  isLoopbackAddress
} = require('../shared/security.cjs');

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
      writeApiError(response, 401, 'ACCESS_AUTH_REQUIRED', '请先登录远程管理页面。');
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
    writeApiError(response, 403, 'FORBIDDEN', '请求来源不被允许。');
    return;
  }
  const localConsole = isLocalConsoleRequest(request);
  const stateOptions = {
    redactCookie: !localConsole,
    localConsole,
    accessAuthenticated: access.authenticated,
    accessRequired: access.required
  };
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

  if (request.method === 'GET' && pathname === '/api/scene') {
    try {
      const rawStyleLayout = parsed.searchParams.get('styleLayout');
      let styleLayout = {};
      if (rawStyleLayout && rawStyleLayout.length <= 4096) {
        try {
          const parsedLayout = JSON.parse(rawStyleLayout);
          if (parsedLayout && typeof parsedLayout === 'object' && !Array.isArray(parsedLayout)) styleLayout = parsedLayout;
        } catch {}
      }
      writeJson(response, 200, await service.getSceneGraphForPreview({
        cleanPath: parsed.searchParams.get('cleanPath'),
        stylePreset: parsed.searchParams.get('stylePreset'),
        overlayMode: parsed.searchParams.get('overlayMode'),
        danmakuArea: parsed.searchParams.get('danmakuArea'),
        styleLayout
      }));
    } catch (error) {
      writeApiError(response, 400, 'SCENE_GRAPH_UNAVAILABLE', error.message || 'Scene Graph 不可用。');
    }
    return;
  }

  if (request.method === 'GET' && pathname === '/api/scene/avatar') {
    await service.serveSceneAvatar(
      parsed.searchParams.get('cleanPath'),
      parsed.searchParams.get('assetId'),
      request,
      response
    );
    return;
  }

  if (request.method === 'GET' && pathname.startsWith('/api/export/preview/')) {
    await service.serveExportPreview(parsed, request, response);
    return;
  }

  if (request.method === 'GET' && pathname === '/api/export/results') {
    writeJson(response, 200, await service.listExportedClips());
    return;
  }

  if (request.method === 'GET' && pathname === '/api/export/mux-recoveries') {
    writeJson(response, 200, await service.listSceneMuxRecoveries());
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

  let body;
  try {
    body = await readJsonBody(request);
  } catch (error) {
    writeRequestError(response, error);
    return;
  }
  const routes = {
    '/api/auth/qr/start': () => service.startQrLogin(),
    '/api/auth/qr/cancel': () => service.cancelQrLogin(),
    '/api/settings/choose-output-dir': () => service.chooseOutputDir(body.currentPath),
    '/api/settings/save': () => service.saveSettings(body.settings || body, { preserveCookie: stateOptions.redactCookie }),
    '/api/system/disk-space': () => service.getDiskSpace(body.path),
    '/api/rooms/add': () => service.addRoom(body.roomId),
    '/api/rooms/remove': () => service.removeRoom(body.roomId, { force: Boolean(body.force) }),
    '/api/rooms/refresh': () => service.refreshRoom(body.roomId, { silent: Boolean(body.silent) }),
    '/api/rooms/monitor': () => service.setMonitoring(body.roomId, body.enabled),
    '/api/rooms/auto-record': () => service.setAutoRecord(body.roomId, body.enabled),
    '/api/rooms/record/start': () => service.startRecording(body.roomId, false),
    '/api/rooms/record/stop': () => service.stopRecording(body.roomId),
    '/api/rooms/merge/cancel': () => service.cancelMerge(body.roomId, body.jobId),
    '/api/rooms/merge/retry': () => service.retryMerge(body.roomId, body.mergeGroup),
    '/api/recordings/merge': () => service.mergeSelectedRecordings(body),
    '/api/recordings/merge/plan': () => service.planSelectedRecordingMerge(body),
    '/api/rooms/preview/start': () => service.startPreview(body.roomId),
    '/api/rooms/burn': () => service.startBurnDanmaku(body.roomId, body.options || {}),
    '/api/rooms/burn/cancel': () => service.cancelBurnDanmaku(body.roomId),
    '/api/rooms/subtitles': () => service.prepareDanmakuForRoom(body.roomId, body.options || {}),
    '/api/export/preview/start': () => service.startExportPreview(body),
    '/api/export/preview/cancel': () => service.cancelExportPreview(),
    '/api/export/subtitles': () => service.prepareSubtitleExport(body),
    '/api/export/scene-tracks': () => service.prepareSceneTracks(body),
    '/api/export/clip': () => service.exportClip(body),
    '/api/export/mux-recover': () => service.queueSceneMuxRecovery(body.id),
    '/api/export/cancel': () => service.cancelExportClip(body.jobId),
    '/api/recordings/scan': () => service.refreshRecordingLibrary(),
    '/api/recordings/cleanup-merged': () =>
      service.cleanupMergedSegmentResiduals({ confirm: Boolean(body.confirm), scanId: body.scanId }),
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
    '/api/system/hardware-self-test': () => service.runHardwareAccelerationSelfTest(),
    '/api/system/test-notification': () => service.testNotification(),
    '/api/system/test-webhook': () => service.testWebhook(),
    '/api/system/shutdown': () => service.requestShutdown()
  };

  const action = routes[pathname];
  if (!action) {
    writeApiError(response, 404, 'API_ROUTE_NOT_FOUND', '接口不存在。');
    return;
  }

  try {
    const result = await action();
    writeJson(response, 200, result === undefined ? { ok: true } : redactRemoteState(result, stateOptions));
  } catch (error) {
    if (isBusinessError(error)) {
      writeApiError(response, error.statusCode, error.code, error.message);
      return;
    }
    service.log('error', error.message || String(error));
    writeApiError(response, 500, 'INTERNAL_ERROR', '服务器处理请求时发生异常，请稍后重试。');
  }
}

function writeApiError(response, statusCode, code, message) {
  writeJson(response, statusCode, { code, message });
}

function writeRequestError(response, error) {
  const statusCode = Number(error?.statusCode) || 400;
  if (statusCode === 413) {
    writeApiError(response, 413, 'REQUEST_TOO_LARGE', error.message || '请求体过大。');
    return;
  }
  writeApiError(response, 400, 'INVALID_REQUEST', error?.message || '请求内容无效。');
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
    const network = getRequestNetworkContext(request, service.settings?.trustedProxies);
    const session = await service.loginAccess(body.username, body.password, network.clientAddress || 'unknown');
    const secure = Boolean(request.socket?.encrypted) || network.forwardedProto === 'https';
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
  // Authentication is decided per request, never from the bind address. A
  // loopback-bound service can still be exposed by a reverse proxy.
  const required = !isLocalConsoleRequest(request, service.settings?.trustedProxies);
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
    ? `<div class="notice error" role="alert">${escapeHtml(errorMessage)}</div>`
    : configured
      ? '<div class="notice">此服务正在监听外部网络，登录后才能进入管理界面。</div>'
      : '<div class="notice error" role="alert">远程访问密码尚未配置。请先通过本机 WebUI 设置；全新 Linux 安装可在首次 bootstrap 时提供密码。</div>';
  const html = `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>远程访问登录 · 哔哩录播 2K</title>
  <style>
    :root{color-scheme:dark;font-size:17px;font-family:Inter,"Microsoft YaHei UI","Microsoft YaHei",system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:#0f1418;color:#edf4f1;font-synthesis:none;text-rendering:optimizeLegibility;-webkit-font-smoothing:antialiased}
    *{box-sizing:border-box}body{margin:0;min-height:100vh;min-height:100svh;display:grid;place-items:center;padding:32px 20px;background:#0f1418}
    main{width:min(440px,100%);min-width:0;padding:28px;border:1px solid rgba(255,255,255,.09);border-radius:8px;background:rgba(18,25,30,.78)}
    .brand{display:flex;align-items:center;gap:14px;padding-bottom:24px;border-bottom:1px solid rgba(255,255,255,.08)}.brand-icon{width:56px;height:56px;flex:0 0 56px;border-radius:8px;box-shadow:0 12px 32px rgba(0,0,0,.28)}.brand-name{margin:0;font-size:24px;font-weight:900;line-height:1.18}.brand-caption{margin:5px 0 0;color:#92a39e;font-size:13px;line-height:1.4}
    h1{margin:24px 0 0;font-size:20px;line-height:1.4;font-weight:900}.notice{margin:14px 0 20px;padding:12px 14px;border-radius:7px;background:rgba(121,222,213,.08);color:#aebfba;font-size:14px;line-height:1.65;overflow-wrap:anywhere}.notice.error{background:rgba(239,91,103,.15);color:#ffabb2}
    label{display:grid;gap:8px;margin-top:14px;color:#aebfba;font-size:15px;font-weight:800}input{width:100%;min-width:0;padding:12px 13px;border:1px solid rgba(255,255,255,.11);border-radius:7px;background:#0d1418;color:#edf4f1;font:inherit;outline:0}input:focus{border-color:#75d9d0;box-shadow:0 0 0 3px rgba(117,217,208,.14)}
    button{width:100%;min-height:44px;display:flex;align-items:center;justify-content:center;gap:8px;margin-top:22px;padding:12px 16px;border:0;border-radius:7px;background:#79ded5;color:#10201f;font:inherit;font-weight:900;cursor:pointer;transition:background 120ms ease}button:hover:not(:disabled){background:#8debe2}button:focus-visible{outline:2px solid #75d9d0;outline-offset:3px}button:disabled{opacity:.5;cursor:not-allowed}button svg{width:20px;height:20px;flex:0 0 20px}.foot{margin:20px 0 0;color:#92a39e;font-size:12px;line-height:1.65;text-align:center}
    @media(max-width:480px){body{padding:24px 16px}main{padding:22px}.brand-name{font-size:22px}}
    @media(prefers-reduced-motion:reduce){button{transition:none}}
  </style>
</head>
<body><main aria-labelledby="login-title">
  <div class="brand">
    <svg class="brand-icon" viewBox="0 0 256 256" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      <rect width="256" height="256" rx="54" fill="#101820"/>
      <path d="M0 74C44 40 87 24 130 28C181 33 218 62 256 110V256H0V74Z" fill="#16343A"/>
      <path d="M256 0V66C220 55 188 58 160 77C128 99 110 134 86 162C62 190 34 203 0 202V0H256Z" fill="#26484D"/>
      <path d="M194 57C217 66 236 81 256 103V148C236 123 218 108 197 100C164 87 136 100 112 133C96 155 83 172 66 184C47 198 25 204 0 202V166C29 169 50 160 68 140C82 124 94 102 111 82C133 55 160 44 194 57Z" fill="#77DAD1"/>
      <circle cx="76" cy="76" r="23" fill="#F35B68"/><circle cx="76" cy="76" r="10" fill="#FFE8E9"/>
      <path d="M105 82C105 71 117 65 126 71L180 104C189 110 189 124 180 130L126 163C117 169 105 163 105 152V82Z" fill="#F4C173"/>
      <path d="M46 198H92V212H46V198ZM46 181H62V198H46V181ZM76 164H92V198H76V164ZM46 150H92V164H46V150Z" fill="#F7FBF9"/>
      <path d="M113 150H129V212H113V150ZM129 178H144V194H129V178ZM146 150H164V168H146V150ZM146 194H164V212H146V194Z" fill="#F7FBF9"/>
    </svg>
    <div><p class="brand-name">哔哩录播 2K</p><p class="brand-caption">BiliRecord2K</p></div>
  </div>
  <h1 id="login-title">远程管理登录</h1>${message}
  <form method="post" action="/api/access/login">
    <label>用户名<input name="username" autocomplete="username" value="${username}" required></label>
    <label>密码<input name="password" type="password" autocomplete="current-password" required></label>
    <button type="submit"${configured ? '' : ' disabled'}><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 18l6-6-6-6M15 12H3M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4"/></svg>进入管理界面</button>
  </form>
  <p class="foot">会话 12 小时后失效；连续失败会触发临时限速。</p>
</main></body></html>`;
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
  return isLoopbackAddress(request.socket?.remoteAddress || request.connection?.remoteAddress || '');
}

function isLocalConsoleRequest(request) {
  if (!isLocalRequest(request)) {
    return false;
  }
  // A request relayed by a local reverse proxy is remote management traffic,
  // even though the final TCP peer is loopback.
  if (hasForwardingHeaders(request.headers || {})) {
    return false;
  }
  const host = normalizeHostHeader(request.headers.host);
  return isLoopbackHost(host.hostname);
}

function redactRemoteState(result, options = {}) {
  if (!result || typeof result !== 'object') {
    return result;
  }
  const next = { ...result };
  if (options.redactCookie && result.settings) {
    next.settings = { ...result.settings, cookie: '' };
    next.bilibiliCookieVisible = false;
  }
  if (options.localConsole === false && result.uiCapabilities) {
    next.uiCapabilities = {
      ...result.uiCapabilities,
      nativePathPicker: false,
      openServerPath: false
    };
  }
  return next;
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
  isLocalConsoleRequest,
  getAccessContext,
  redactRemoteState,
  LOCAL_ONLY_API_PATHS,
  LOCAL_ONLY_ERROR
};
