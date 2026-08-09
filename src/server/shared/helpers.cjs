const http = require('node:http');
const https = require('node:https');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const tls = require('node:tls');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { validateRemoteUrl } = require('./security.cjs');

let ffmpegStatic = null;
try {
  ffmpegStatic = require('ffmpeg-static');
} catch {
  ffmpegStatic = null;
}

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

const APP_NAME = 'BiliRecord2K';
const DEFAULT_PORT = 3263;
const STREAM_QN_PROBES = [25000, 20000, 15000, 10000, 400, 250, 150];
const RUN_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';
const BURN_CODEC_CANDIDATES = [
  { value: 'libx265', label: 'H.265 软件编码', kind: 'software' },
  { value: 'libx264', label: 'H.264 软件编码', kind: 'software' },
  { value: 'hevc_nvenc', label: 'NVIDIA H.265 硬件编码', kind: 'hardware', vendor: 'nvidia' },
  { value: 'h264_nvenc', label: 'NVIDIA H.264 硬件编码', kind: 'hardware', vendor: 'nvidia' },
  { value: 'hevc_qsv', label: 'Intel H.265 硬件编码', kind: 'hardware', vendor: 'intel' },
  { value: 'h264_qsv', label: 'Intel H.264 硬件编码', kind: 'hardware', vendor: 'intel' },
  { value: 'hevc_amf', label: 'AMD H.265 硬件编码', kind: 'hardware', vendor: 'amd' },
  { value: 'h264_amf', label: 'AMD H.264 硬件编码', kind: 'hardware', vendor: 'amd' }
];
const BURN_CODEC_VALUES = new Set(BURN_CODEC_CANDIDATES.map((codec) => codec.value));
const APP_ROOT = getAppRoot();
const APP_VERSION = getAppVersion();
const OFFICIAL_RELEASE_DOWNLOAD_PREFIX = 'https://github.com/Metahumanz/LiveRecord2k/releases/download/';
const UPDATE_DOWNLOAD_MIRROR_PREFIX = 'https://gh-proxy.com/';
const UPDATE_DOWNLOAD_LOW_SPEED_BYTES_PER_SECOND = 64 * 1024;
const UPDATE_DOWNLOAD_LOW_SPEED_WINDOW_MS = 20 * 1000;

const danmakuClient = require('../danmaku/client.cjs');
const danmakuAss = require('../danmaku/ass.cjs');
const ffmpegHelpers = require('../recording/ffmpeg.cjs');

async function fetchWithTimeout(url, options = {}, timeoutMs = 15000, label = '网络请求', consumeResponse = null) {
  const timeout = Math.max(0, Number(timeoutMs || 0));
  if (!timeout) {
    return fetch(url, options);
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  timer.unref?.();
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    return consumeResponse ? await consumeResponse(response) : response;
  } catch (error) {
    if (controller.signal.aborted || error?.name === 'AbortError') {
      const timeoutError = new Error(`${label}超时（${timeout}ms）`);
      timeoutError.code = 'FETCH_TIMEOUT';
      throw timeoutError;
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function requestBiliJsonWithCookies(url) {
  const { response, text } = await fetchWithTimeout(
    url,
    {
      headers: {
        Accept: 'application/json, text/plain, */*',
        Referer: 'https://passport.bilibili.com/',
        Origin: 'https://passport.bilibili.com',
        'User-Agent': USER_AGENT
      }
    },
    15000,
    'B站登录接口请求',
    async (response) => ({ response, text: await response.text() })
  );
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${text.slice(0, 120)}`);
  }
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`接口返回不是 JSON：${text.slice(0, 120)}`);
  }
  return {
    json,
    cookies: getSetCookieHeaders(response.headers)
  };
}

function getSetCookieHeaders(headers) {
  if (typeof headers.getSetCookie === 'function') {
    return headers.getSetCookie();
  }
  const combined = headers.get('set-cookie');
  if (!combined) {
    return [];
  }
  return splitSetCookieHeader(combined);
}

function splitSetCookieHeader(header) {
  return String(header)
    .split(/,(?=\s*[^;,=\s]+=[^;]+)/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function mergeCookieString(existingCookie, setCookieHeaders) {
  const jar = new Map();
  for (const part of String(existingCookie || '').split(';')) {
    const trimmed = part.trim();
    const index = trimmed.indexOf('=');
    if (index > 0) {
      jar.set(trimmed.slice(0, index), trimmed.slice(index + 1));
    }
  }

  for (const header of setCookieHeaders || []) {
    const pair = String(header).split(';')[0]?.trim();
    const index = pair.indexOf('=');
    if (index > 0) {
      jar.set(pair.slice(0, index), pair.slice(index + 1));
    }
  }

  return Array.from(jar.entries())
    .filter(([, value]) => value !== '')
    .map(([key, value]) => `${key}=${value}`)
    .join('; ');
}

function cookieHeadersFromLoginUrl(value) {
  let target;
  try {
    target = new URL(String(value || ''));
  } catch {
    return [];
  }
  const hostname = target.hostname.toLowerCase();
  if (
    hostname !== 'bilibili.com' &&
    !hostname.endsWith('.bilibili.com') &&
    hostname !== 'biligame.com' &&
    !hostname.endsWith('.biligame.com')
  ) {
    return [];
  }
  const allowedNames = new Map(
    ['SESSDATA', 'bili_jct', 'DedeUserID', 'DedeUserID__ckMd5', 'sid', 'buvid3', 'buvid4'].map((name) => [
      name.toLowerCase(),
      name
    ])
  );
  const result = [];
  for (const part of target.search.slice(1).split('&')) {
    const separator = part.indexOf('=');
    if (separator <= 0) continue;
    let name;
    try {
      name = decodeURIComponent(part.slice(0, separator).replace(/\+/g, ' '));
    } catch {
      continue;
    }
    const canonicalName = allowedNames.get(name.toLowerCase());
    const rawValue = part.slice(separator + 1);
    if (!canonicalName || !rawValue || /[\r\n;]/.test(rawValue)) continue;
    result.push(`${canonicalName}=${rawValue}`);
  }
  return result;
}

function sanitizeFilename(name) {
  return String(name || 'recording')
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 160);
}

function sanitizeHeaderValue(value) {
  return String(value || '').replace(/[\r\n]/g, '').trim();
}

function createImageProxyHeaders(target, cookie) {
  const headers = {
    Accept: 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
    'Cache-Control': 'no-cache',
    Pragma: 'no-cache',
    'User-Agent': USER_AGENT
  };
  if (isBilibiliHost(target.hostname)) {
    headers.Referer = 'https://live.bilibili.com/';
    const safeCookie = sanitizeHeaderValue(cookie);
    if (safeCookie) {
      headers.Cookie = safeCookie;
    }
  }
  return headers;
}

function createPreviewProxyHeaders(target, cookie, rangeHeader) {
  const headers = {
    Accept: '*/*',
    'Cache-Control': 'no-cache',
    Pragma: 'no-cache',
    'User-Agent': USER_AGENT
  };
  if (isBilibiliHost(target.hostname)) {
    headers.Referer = 'https://live.bilibili.com/';
    const safeCookie = sanitizeHeaderValue(cookie);
    if (safeCookie) {
      headers.Cookie = safeCookie;
    }
  }
  const range = sanitizeHeaderValue(rangeHeader);
  if (range) {
    headers.Range = range;
  }
  return headers;
}

function createPreviewProxyPath(token, targetUrl) {
  return `/api/preview/${encodeURIComponent(token)}/${encodePreviewUrl(targetUrl)}`;
}

function encodePreviewUrl(value) {
  return Buffer.from(String(value || ''), 'utf8').toString('base64url');
}

function decodePreviewUrl(value) {
  return Buffer.from(String(value || ''), 'base64url').toString('utf8');
}

function isPreviewPlaylist(target, body) {
  const pathname = target.pathname.toLowerCase();
  if (pathname.endsWith('.m3u8')) {
    return true;
  }
  const prefix = body.subarray(0, 16).toString('utf8');
  return prefix.startsWith('#EXTM3U');
}

function rewriteHlsManifest(text, baseUrl, token) {
  return String(text || '')
    .split(/\r?\n/)
    .map((line) => rewriteHlsManifestLine(line, baseUrl, token))
    .join('\n');
}

function rewriteHlsManifestLine(line, baseUrl, token) {
  const trimmed = String(line || '').trim();
  if (!trimmed) {
    return line;
  }
  if (trimmed.startsWith('#')) {
    return line.replace(/URI="([^"]+)"/g, (match, uri) => {
      const resolved = resolveHlsResourceUrl(uri, baseUrl);
      return resolved ? `URI="${createPreviewProxyPath(token, resolved)}"` : match;
    });
  }
  const resolved = resolveHlsResourceUrl(trimmed, baseUrl);
  return resolved ? createPreviewProxyPath(token, resolved) : line;
}

function resolveHlsResourceUrl(value, baseUrl) {
  const text = String(value || '').trim();
  if (!text || /^(?:data|blob):/i.test(text)) {
    return '';
  }
  try {
    return new URL(text, baseUrl).toString();
  } catch {
    return '';
  }
}

function previewMimeType(pathname) {
  const ext = path.extname(String(pathname || '')).toLowerCase();
  return (
    {
      '.m3u8': 'application/vnd.apple.mpegurl',
      '.m4s': 'video/iso.segment',
      '.mp4': 'video/mp4',
      '.ts': 'video/mp2t',
      '.aac': 'audio/aac',
      '.mp3': 'audio/mpeg',
      '.webvtt': 'text/vtt'
    }[ext] || 'application/octet-stream'
  );
}

function isBilibiliHost(hostname) {
  const host = String(hostname || '').toLowerCase();
  return (
    host === 'bilibili.com' ||
    host.endsWith('.bilibili.com') ||
    host === 'bilivideo.com' ||
    host.endsWith('.bilivideo.com') ||
    host === 'bilivideo.cn' ||
    host.endsWith('.bilivideo.cn') ||
    host === 'hdslb.com' ||
    host.endsWith('.hdslb.com') ||
    host === 'biliimg.com' ||
    host.endsWith('.biliimg.com')
  );
}

function getCookieValue(cookie, key) {
  const expectedKey = String(key || '').toLowerCase();
  for (const part of String(cookie || '').split(';')) {
    const trimmed = part.trim();
    const index = trimmed.indexOf('=');
    if (index > 0 && trimmed.slice(0, index).toLowerCase() === expectedKey) {
      return trimmed.slice(index + 1);
    }
  }
  return '';
}

function createBiliError(label, payload) {
  const code = Number(payload?.code);
  const message = String(payload?.message || payload?.msg || code || '未知错误');
  if (code === -352) {
    return new Error(
      `${label}接口返回 -352：疑似 B 站风控或登录态不足。请到设置页扫码登录；如果已登录，重新扫码刷新 Cookie 后再试。`
    );
  }
  if (code === -101) {
    return new Error(`${label}接口提示账号未登录：请到设置页扫码登录后再试。`);
  }
  return new Error(`${label}接口返回 ${Number.isNaN(code) ? message : code}：${message}`);
}

function normalizeContainer(value) {
  return value === 'mkv' ? 'mkv' : 'mp4';
}

function normalizeContainerStage(value) {
  const stage = String(value || '').trim();
  return ['capturing', 'finalizing', 'ready', 'failed'].includes(stage) ? stage : undefined;
}

function normalizeCommandCounts(value) {
  if (!value || typeof value !== 'object') {
    return {};
  }
  return Object.fromEntries(
    Object.entries(value)
      .map(([key, count]) => [String(key), Number(count || 0)])
      .filter(([key, count]) => key && Number.isFinite(count) && count > 0)
  );
}

function mergeCommandCounts(items) {
  const merged = {};
  for (const item of items || []) {
    for (const [key, count] of Object.entries(normalizeCommandCounts(item))) {
      merged[key] = (merged[key] || 0) + count;
    }
  }
  return merged;
}

async function detectFfmpegCapabilities(ffmpegPath) {
  const [encoderProbe, hwaccelProbe, videoAdapters] = await Promise.all([
    runFfmpegProbe(ffmpegPath, ['-hide_banner', '-encoders']),
    runFfmpegProbe(ffmpegPath, ['-hide_banner', '-hwaccels']),
    detectVideoAdapters()
  ]);
  const encoderNames = parseFfmpegEncoderNames(encoderProbe.output);
  const hwaccels = parseFfmpegHwaccels(hwaccelProbe.output);
  const burnCodecs = [];
  const unavailableBurnCodecs = [];

  for (const candidate of BURN_CODEC_CANDIDATES) {
    if (!encoderNames.has(candidate.value)) {
      unavailableBurnCodecs.push({ ...candidate, reason: 'ffmpeg 未包含该编码器' });
      continue;
    }
    if (candidate.kind === 'hardware') {
      if (!shouldTestHardwareEncoder(candidate, videoAdapters)) {
        unavailableBurnCodecs.push({ ...candidate, reason: '未检测到对应显卡' });
        continue;
      }
      const test = await testFfmpegEncoder(ffmpegPath, candidate.value);
      if (!test.ok) {
        unavailableBurnCodecs.push({ ...candidate, reason: test.reason || '硬件编码测试未通过' });
        continue;
      }
    }
    burnCodecs.push(candidate);
  }

  return {
    burnCodecs,
    unavailableBurnCodecs,
    hwaccels,
    videoAdapters,
    probedAt: Date.now(),
    probeError: encoderProbe.ok ? '' : encoderProbe.error
  };
}

async function runFfmpegProbe(ffmpegPath, args, options = {}) {
  try {
    const result = await runCapturedProcess(ffmpegPath, args, {
      timeoutMs: Number(options.timeoutMs || 8000),
      maxOutputBytes: Number(options.maxOutputBytes || 256 * 1024)
    });
    const output = `${result.stdout || ''}\n${result.stderr || ''}`;
    return {
      ok: result.status === 0 && !result.error && !result.timedOut,
      output,
      error: result.timedOut
        ? `ffmpeg 探测超时（${result.timeoutMs}ms）`
        : result.error
          ? result.error.message
          : result.status === 0
            ? ''
            : compactLogLine(output)
    };
  } catch (error) {
    return { ok: false, output: '', error: error.message };
  }
}

function runCapturedProcess(command, args, options = {}) {
  return new Promise((resolve) => {
    const timeoutMs = Math.max(0, Number(options.timeoutMs || 0));
    const maxOutputBytes = Math.max(1024, Number(options.maxOutputBytes || 256 * 1024));
    let child;
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;
    let timer = null;

    const appendOutput = (current, chunk) => `${current}${chunk.toString('utf8')}`.slice(-maxOutputBytes);
    const finish = (status, signal, error = null) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      options.onChild?.(null);
      resolve({ status, signal, stdout, stderr, error, timedOut, timeoutMs });
    };

    try {
      const hasInput = options.input !== undefined && options.input !== null;
      child = spawn(command, args, {
        windowsHide: true,
        stdio: [hasInput ? 'pipe' : 'ignore', 'pipe', 'pipe'],
        env: options.env || process.env
      });
      options.onChild?.(child);
      if (hasInput) {
        child.stdin?.on('error', () => {});
        child.stdin?.end(String(options.input));
      }
    } catch (error) {
      finish(null, null, error);
      return;
    }

    child.stdout?.on('data', (chunk) => {
      stdout = appendOutput(stdout, chunk);
    });
    child.stderr?.on('data', (chunk) => {
      stderr = appendOutput(stderr, chunk);
    });
    child.on('error', (error) => finish(null, null, error));
    child.on('close', (status, signal) => finish(status, signal));

    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        timedOut = true;
        child.kill('SIGKILL');
      }, timeoutMs);
      timer.unref?.();
    }
  });
}

function parseFfmpegEncoderNames(output) {
  const names = new Set();
  for (const line of String(output || '').split(/\r?\n/)) {
    const match = /^\s*[A-Z.]{6}\s+([^\s]+)\s+/i.exec(line);
    if (match) {
      names.add(match[1]);
    }
  }
  return names;
}

function parseFfmpegHwaccels(output) {
  return String(output || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.includes(':'))
    .filter((line) => /^[a-z0-9_]+$/i.test(line));
}

async function detectVideoAdapters() {
  if (process.platform === 'linux') {
    const adapters = [];
    const entries = await fsp.readdir('/sys/class/drm', { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (!/^card\d+$/.test(entry.name)) continue;
      const deviceRoot = path.join('/sys/class/drm', entry.name, 'device');
      const [vendorId, uevent] = await Promise.all([
        fsp.readFile(path.join(deviceRoot, 'vendor'), 'utf8').catch(() => ''),
        fsp.readFile(path.join(deviceRoot, 'uevent'), 'utf8').catch(() => '')
      ]);
      const label = `${entry.name} ${vendorId.trim()} ${uevent}`.trim();
      const vendor = detectVideoAdapterVendor(label);
      if (vendor !== 'unknown') adapters.push({ name: label.split(/\r?\n/)[0], vendor });
    }
    if (!adapters.some((adapter) => adapter.vendor === 'nvidia')) {
      const result = await runCapturedProcess(
        'nvidia-smi',
        ['--query-gpu=name', '--format=csv,noheader'],
        { timeoutMs: 3000, maxOutputBytes: 32 * 1024 }
      );
      if (result.status === 0) {
        for (const name of String(result.stdout || '').split(/\r?\n/).map((value) => value.trim()).filter(Boolean)) {
          adapters.push({ name, vendor: 'nvidia' });
        }
      }
    }
    return Array.from(new Map(adapters.map((adapter) => [`${adapter.vendor}:${adapter.name}`, adapter])).values());
  }
  if (process.platform !== 'win32') {
    return [];
  }
  const command =
    'Get-CimInstance Win32_VideoController | Select-Object Name,AdapterCompatibility,PNPDeviceID | ConvertTo-Json -Compress';
  for (const shell of ['powershell.exe', 'pwsh.exe']) {
    try {
      const result = await runCapturedProcess(shell, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', command], {
        timeoutMs: 8000,
        maxOutputBytes: 128 * 1024
      });
      if (result.status !== 0 || !String(result.stdout || '').trim()) {
        continue;
      }
      const parsed = JSON.parse(result.stdout);
      const adapters = Array.isArray(parsed) ? parsed : parsed ? [parsed] : [];
      return adapters
        .map((adapter) => {
          const name = String(adapter.Name || '').trim();
          const compatibility = String(adapter.AdapterCompatibility || '').trim();
          const pnpDeviceId = String(adapter.PNPDeviceID || '').trim();
          return {
            name: name || compatibility || pnpDeviceId,
            vendor: detectVideoAdapterVendor(`${name} ${compatibility} ${pnpDeviceId}`)
          };
        })
        .filter((adapter) => adapter.name);
    } catch {
      // Try the next shell.
    }
  }
  return [];
}

function detectVideoAdapterVendor(value) {
  const text = String(value || '').toLowerCase();
  if (text.includes('nvidia') || text.includes('ven_10de') || text.includes('0x10de')) {
    return 'nvidia';
  }
  if (text.includes('intel') || text.includes('ven_8086') || text.includes('0x8086')) {
    return 'intel';
  }
  if (text.includes('amd') || text.includes('radeon') || text.includes('advanced micro devices') || text.includes('ven_1002') || text.includes('0x1002')) {
    return 'amd';
  }
  return 'unknown';
}

function hasVideoAdapterVendor(adapters, vendor) {
  return adapters.some((adapter) => adapter.vendor === vendor);
}

function shouldTestHardwareEncoder(candidate, adapters, platform = process.platform) {
  return String(platform) !== 'win32' || hasVideoAdapterVendor(adapters, candidate.vendor);
}

async function testFfmpegEncoder(ffmpegPath, codec) {
  try {
    const result = await runCapturedProcess(
      ffmpegPath,
      [
        '-hide_banner',
        '-loglevel',
        'error',
        '-f',
        'lavfi',
        '-i',
        'testsrc2=size=256x144:rate=1',
        '-frames:v',
        '1',
        '-an',
        '-c:v',
        codec,
        '-f',
        'null',
        '-'
      ],
      {
        timeoutMs: 10000,
        maxOutputBytes: 128 * 1024
      }
    );
    if (result.status === 0 && !result.error) {
      return { ok: true, reason: '' };
    }
    const output = compactLogLine(`${result.stderr || ''}\n${result.stdout || ''}`);
    return {
      ok: false,
      reason: result.timedOut ? '硬件编码测试超时' : output || result.error?.message || `ffmpeg 退出码 ${result.status}`
    };
  } catch (error) {
    return { ok: false, reason: error.message };
  }
}

function normalizeBurnCodec(value) {
  const codec = String(value || '').trim();
  return BURN_CODEC_VALUES.has(codec) ? codec : 'libx265';
}

function normalizeRoomImageMode(value) {
  return value === 'cover' ? 'cover' : 'keyframe';
}

function normalizeBurnOverlayMode(value) {
  return value === 'danmaku' ? 'danmaku' : 'danmaku-gift';
}

function normalizeExportMode(value) {
  return value === 'burn' ? 'burn' : 'clean';
}

function overlayModeLabel(value) {
  return normalizeBurnOverlayMode(value) === 'danmaku' ? '仅弹幕' : '弹幕和礼物';
}

function basenameWithoutExt(url) {
  const value = String(url || '').trim();
  if (!value) {
    return '';
  }
  return value.split('/').pop()?.split('.')[0] || '';
}

function normalizeTargetQn(value) {
  const qn = Number(value || 15000);
  if (!Number.isFinite(qn) || qn <= 0) {
    return 15000;
  }
  return qn === 20000 ? 25000 : qn;
}

function createQnProbeList(value) {
  const targetQn = normalizeTargetQn(value);
  const probes = [targetQn];
  for (const qn of STREAM_QN_PROBES) {
    if (qn <= targetQn) {
      probes.push(qn);
    }
  }
  return Array.from(new Set(probes.filter((qn) => Number.isFinite(qn) && qn > 0)));
}

function getContainerFromPath(filePath) {
  return path.extname(filePath).toLowerCase() === '.mkv' ? 'mkv' : 'mp4';
}

function deriveSiblingPath(filePath, suffix, extension) {
  const parsed = path.parse(filePath);
  const ext = extension || parsed.ext.replace(/^\./, '') || 'mp4';
  const base = parsed.name.replace(/\.clean$/i, '');
  const tail = `.${suffix}.${ext}`;
  return path.join(parsed.dir, `${fitOutputBaseName(parsed.dir, base, tail)}${tail}`);
}

function deriveBurnedPath(filePath, overlayMode) {
  return deriveSiblingPath(filePath, normalizeBurnOverlayMode(overlayMode) === 'danmaku' ? 'danmaku-only' : 'danmaku');
}

function deriveClipPath(cleanPath, outputDir, mode, startTime, endTime) {
  const parsed = path.parse(cleanPath);
  const container = parsed.ext.replace(/^\./, '') || 'mp4';
  const base = parsed.name.replace(/\.clean$/i, '');
  const suffix = createClipSuffix(startTime, endTime, mode);
  const tail = `.${suffix}.${container}`;
  return path.join(outputDir, `${fitOutputBaseName(outputDir, base, tail)}${tail}`);
}

function fitOutputBaseName(directory, baseName, tail) {
  const base = String(baseName || 'recording');
  if (process.platform !== 'win32') {
    return base;
  }
  const directoryLength = path.resolve(String(directory || '.')).length;
  const budget = Math.max(20, 240 - directoryLength - 1 - String(tail || '').length);
  if (base.length <= budget) {
    return base;
  }
  const hash = crypto.createHash('sha1').update(base).digest('hex').slice(0, 8);
  return `${base.slice(0, Math.max(8, budget - hash.length - 1)).trimEnd()}-${hash}`;
}

function replaceExtension(filePath, extension) {
  const parsed = path.parse(filePath);
  return path.join(parsed.dir, `${parsed.name}${extension}`);
}

function isPathInsideDirectory(filePath, directory) {
  const relative = path.relative(path.resolve(directory), path.resolve(filePath));
  return Boolean(relative && !relative.startsWith('..') && !path.isAbsolute(relative));
}

function createClipSuffix(startTime, endTime, mode) {
  const start = safeTimeSlug(startTime);
  const end = Number.isFinite(Number(endTime)) ? safeTimeSlug(endTime) : 'end';
  return `clip_${start}-${end}.${normalizeClipModeName(mode)}`;
}

function normalizeClipModeName(mode) {
  if (mode === 'clean') {
    return 'clean';
  }
  return normalizeBurnOverlayMode(mode) === 'danmaku' ? 'danmaku-only' : 'danmaku';
}

function safeTimeSlug(value) {
  return formatFfmpegSeconds(value).replace('.', '_').replace(/:/g, '');
}

function parseTimeInput(value) {
  if (value === undefined || value === null || value === '') {
    return Number.NaN;
  }
  if (typeof value === 'number') {
    return value;
  }
  const text = String(value).trim();
  if (!text) {
    return Number.NaN;
  }
  if (/^\d+(?:\.\d+)?$/.test(text)) {
    return Number(text);
  }
  const parts = text.split(':').map((part) => Number(part));
  if (parts.some((part) => !Number.isFinite(part) || part < 0) || parts.length > 3) {
    return Number.NaN;
  }
  while (parts.length < 3) {
    parts.unshift(0);
  }
  return parts[0] * 3600 + parts[1] * 60 + parts[2];
}

function formatFfmpegSeconds(value) {
  const safe = Math.max(0, Number(value) || 0);
  return safe.toFixed(3).replace(/0+$/, '').replace(/\.$/, '');
}

function runFfmpegJob(ffmpegPath, args, onStderr, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpegPath, args, {
      windowsHide: true,
      stdio: ['ignore', 'ignore', 'pipe']
    });
    options.onChild?.(child);
    let stderr = '';
    child.stderr.on('data', (chunk) => {
      const text = chunk.toString('utf8');
      stderr = `${stderr}${text}`.slice(-8000);
      onStderr?.(text);
    });
    child.on('error', reject);
    child.on('close', (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`ffmpeg 退出码 ${code}，信号 ${signal || '-'}：${compactLogLine(stderr)}`));
    });
  });
}

function createFfmpegJobProgress({ kind, label, outputPath, durationSec, roomId, codec, codecKind }) {
  const now = Date.now();
  const duration = Number(durationSec || 0);
  return {
    id: `${kind}-${now}-${Math.random().toString(36).slice(2, 8)}`,
    kind,
    status: 'running',
    label,
    outputPath,
    roomId,
    codec: codec || '',
    codecKind: codecKind || undefined,
    startedAt: now,
    updatedAt: now,
    currentTimeSec: 0,
    durationSec: Number.isFinite(duration) && duration > 0 ? duration : 0,
    estimatedRemainingSec: null,
    percent: Number.isFinite(duration) && duration > 0 ? 0 : null,
    message: '准备中'
  };
}

function updateFfmpegJobProgress(progress, text) {
  if (!progress || progress.status !== 'running') {
    return false;
  }
  const currentTimeSec = parseFfmpegProgressTime(text);
  if (!Number.isFinite(currentTimeSec)) {
    return false;
  }
  const now = Date.now();
  const duration = Number(progress.durationSec || 0);
  const percent = duration > 0 ? clamp((currentTimeSec / duration) * 100, 0, 99.5) : null;
  const previousPercent = Number(progress.percent ?? 0);
  const previousTime = Number(progress.currentTimeSec || 0);
  const percentChanged = percent === null ? Math.abs(currentTimeSec - previousTime) >= 1 : Math.abs(percent - previousPercent) >= 0.4;
  if (!percentChanged && now - Number(progress.updatedAt || 0) < 500) {
    return false;
  }
  const elapsedSec = Math.max(0, (now - Number(progress.startedAt || now)) / 1000);
  const processedSec = Math.max(0, currentTimeSec);
  const remainingSec = duration > 0 ? Math.max(0, duration - processedSec) : 0;
  progress.currentTimeSec = Math.max(0, currentTimeSec);
  progress.percent = percent;
  progress.estimatedRemainingSec =
    duration > 0 && processedSec >= 1 && elapsedSec >= 1 ? remainingSec / Math.max(processedSec / elapsedSec, 0.001) : null;
  progress.updatedAt = now;
  progress.message =
    duration > 0
      ? `${formatDurationSeconds(currentTimeSec)} / ${formatDurationSeconds(duration)}`
      : `已处理 ${formatDurationSeconds(currentTimeSec)}`;
  return true;
}

function finishFfmpegJobProgress(progress, status, message) {
  if (!progress) {
    return;
  }
  progress.status = status;
  progress.updatedAt = Date.now();
  progress.message = message;
  if (status === 'completed') {
    progress.percent = 100;
    progress.estimatedRemainingSec = 0;
    if (Number(progress.durationSec || 0) > 0) {
      progress.currentTimeSec = Number(progress.durationSec || 0);
    }
  } else {
    progress.estimatedRemainingSec = null;
  }
}

function parseFfmpegProgressTime(text) {
  const value = String(text || '');
  let match;
  let latest = Number.NaN;
  const timePattern = /time=\s*([0-9:.]+)/gi;
  while ((match = timePattern.exec(value))) {
    latest = parseFfmpegTime(match[1]);
  }
  const outTimePattern = /out_time(?:_ms)?=([0-9:.]+)/gi;
  while ((match = outTimePattern.exec(value))) {
    const raw = match[1];
    const parsed = raw.includes(':') ? parseFfmpegTime(raw) : Number(raw) / 1_000_000;
    latest = parsed;
  }
  return latest;
}

function parseFfmpegTime(value) {
  const parts = String(value || '')
    .trim()
    .split(':')
    .map((part) => Number(part));
  if (parts.length !== 3 || parts.some((part) => !Number.isFinite(part) || part < 0)) {
    return Number.NaN;
  }
  return parts[0] * 3600 + parts[1] * 60 + parts[2];
}

function parseFfmpegDuration(text) {
  const match = String(text || '').match(/Duration:\s*([0-9:.]+)/i);
  if (!match) {
    return 0;
  }
  const duration = parseFfmpegTime(match[1]);
  return Number.isFinite(duration) && duration > 0 ? duration : 0;
}

function normalizeDurationSeconds(value) {
  const duration = Number(value || 0);
  return Number.isFinite(duration) && duration > 0 ? duration : 0;
}

function isLikelyCommonSegmentDuration(durationSec) {
  const duration = normalizeDurationSeconds(durationSec);
  if (!duration) {
    return false;
  }
  const commonDurations = [300, 600, 900, 1200, 1800, 2700, 3600, 5400, 7200, 10800, 14400];
  return commonDurations.some((candidate) => Math.abs(duration - candidate) <= Math.max(2, candidate * 0.002));
}

function isLikelySegmentPlaceholderDuration(mediaDurationSec, referenceDurationSec, segmentDurationSec) {
  const mediaDuration = normalizeDurationSeconds(mediaDurationSec);
  const referenceDuration = normalizeDurationSeconds(referenceDurationSec);
  if (!mediaDuration || !referenceDuration || referenceDuration >= mediaDuration) {
    return false;
  }

  const configuredSegment = normalizeDurationSeconds(segmentDurationSec);
  const closeToConfiguredSegment =
    configuredSegment > 0 && Math.abs(mediaDuration - configuredSegment) <= Math.max(2, Math.min(10, configuredSegment * 0.01));
  const looksLikeSegmentLimit = closeToConfiguredSegment || isLikelyCommonSegmentDuration(mediaDuration);
  const meaningfulGap = mediaDuration - referenceDuration > Math.max(10, Math.min(60, mediaDuration * 0.05));
  return looksLikeSegmentLimit && meaningfulGap;
}

function resolveReliableDurationSec({
  mediaDurationSec,
  elapsedSec,
  storedDurationSec,
  danmakuDurationSec,
  segmentDurationSec
} = {}) {
  const mediaDuration = normalizeDurationSeconds(mediaDurationSec);
  const references = [elapsedSec, storedDurationSec, danmakuDurationSec].map(normalizeDurationSeconds).filter(Boolean);
  const referenceDuration = references.length ? Math.max(...references) : 0;

  if (mediaDuration && isLikelySegmentPlaceholderDuration(mediaDuration, referenceDuration, segmentDurationSec)) {
    return referenceDuration;
  }
  return mediaDuration || referenceDuration || 0;
}

function parseRecordingStartedAtFromName(filePath) {
  const name = path.basename(String(filePath || ''));
  const matches = Array.from(name.matchAll(/_(\d{8})_(\d{6})(?=.*\.(?:clean|merged)\.(?:mp4|mkv)$)/gi));
  const match = matches.at(-1);
  if (!match) {
    return 0;
  }
  const date = match[1];
  const time = match[2];
  const startedAt = new Date(
    Number(date.slice(0, 4)),
    Number(date.slice(4, 6)) - 1,
    Number(date.slice(6, 8)),
    Number(time.slice(0, 2)),
    Number(time.slice(2, 4)),
    Number(time.slice(4, 6))
  ).getTime();
  return Number.isFinite(startedAt) ? startedAt : 0;
}

function estimateRecordingDurationFromStats(filePath, stat) {
  const startedAt = parseRecordingStartedAtFromName(filePath);
  const endedAt = Number(stat?.mtimeMs || 0);
  const duration = (endedAt - startedAt) / 1000;
  return Number.isFinite(duration) && duration > 0 && duration < 7 * 24 * 3600 ? duration : 0;
}

async function readDanmakuDurationSec(danmakuPath) {
  const result = await danmakuAss.inspectDanmakuFile(danmakuPath);
  return result.durationSec;
}

async function probeMediaFileInfo(ffmpegPath, filePath, options = {}) {
  if (!ffmpegPath || !filePath) {
    return { durationSec: 0, videoInfo: null, audioInfo: null };
  }
  const exists = await fsp.stat(filePath).then((stat) => stat.isFile()).catch(() => false);
  if (!exists) {
    return { durationSec: 0, videoInfo: null, audioInfo: null };
  }
  const probe = await runFfmpegProbe(ffmpegPath, ['-hide_banner', '-i', filePath], {
    timeoutMs: Number(options.timeoutMs || 8000)
  });
  if (!probe.ok && /超时/.test(probe.error || '')) {
    const error = new Error(`媒体信息探测超时：${path.basename(filePath)}`);
    error.code = 'MEDIA_PROBE_TIMEOUT';
    throw error;
  }
  return {
    durationSec: parseFfmpegDuration(probe.output),
    videoInfo: parseFfmpegVideoInfo(probe.output),
    audioInfo: parseFfmpegAudioInfo(probe.output)
  };
}

async function probeMediaTimelineInfo(ffmpegPath, filePath, mediaInfo = {}, options = {}) {
  const timeoutMs = Number(options.timeoutMs || 90000);
  const scanStream = async (selector) => {
    const result = await runCapturedProcess(
      ffmpegPath,
      [
        '-hide_banner',
        '-nostdin',
        '-loglevel',
        'error',
        '-i',
        filePath,
        '-map',
        selector,
        '-c',
        'copy',
        '-f',
        'null',
        '-',
        '-progress',
        'pipe:1'
      ],
      { timeoutMs }
    );
    if (result.timedOut) {
      throw new Error(`媒体时间轴扫描超时：${path.basename(filePath)}`);
    }
    if (result.status !== 0) {
      throw new Error(`媒体时间轴扫描失败：${path.basename(filePath)}（${compactLogLine(result.stderr)}）`);
    }
    const values = Array.from(String(result.stdout || '').matchAll(/out_time_us=(-?\d+)/g))
      .map((match) => Number(match[1]) / 1_000_000)
      .filter(Number.isFinite);
    return values.length ? Math.max(0, values.at(-1)) : 0;
  };

  const videoDurationSec = await scanStream('0:v:0');
  const audioDurationSec = mediaInfo.audioInfo ? await scanStream('0:a:0') : 0;
  const measuredAvDeltaSec = mediaInfo.audioInfo ? audioDurationSec - videoDurationSec : 0;
  // Stream-copy progress reports video DTS, which can trail presentation time by several B-frames.
  // Discount that known positive-only reorder gap before deciding whether the streams really drift.
  const fps = Number(mediaInfo.videoInfo?.fps || 0);
  const videoReorderAllowanceSec = fps > 0 ? Math.min(0.15, 3 / fps) : 0.12;
  const avDeltaSec = measuredAvDeltaSec > 0 ? Math.max(0, measuredAvDeltaSec - videoReorderAllowanceSec) : measuredAvDeltaSec;
  const containerDurationSec = Number(mediaInfo.durationSec || 0);
  const streamDurationSec = Math.max(videoDurationSec, audioDurationSec);
  return {
    containerDurationSec,
    videoDurationSec,
    audioDurationSec,
    avDeltaSec,
    measuredAvDeltaSec,
    videoReorderAllowanceSec,
    containerDeltaSec: containerDurationSec && streamDurationSec ? containerDurationSec - streamDurationSec : 0,
    timingSafeForCopy: !mediaInfo.audioInfo || Math.abs(avDeltaSec) <= 0.08
  };
}

function isHevcCodec(codec) {
  const value = String(codec || '').toLowerCase();
  return value.includes('hevc') || value.includes('h265') || value.includes('x265');
}

function formatTimestamp(date) {
  const pad = (value) => String(value).padStart(2, '0');
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}_${pad(date.getHours())}${pad(
    date.getMinutes()
  )}${pad(date.getSeconds())}`;
}

function formatDurationSeconds(seconds) {
  const total = Math.max(0, Math.round(Number(seconds) || 0));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) {
    return `${h}小时${m}分${s}秒`;
  }
  if (m > 0) {
    return `${m}分${s}秒`;
  }
  return `${s}秒`;
}

function streamScore(stream, settings) {
  const codec = String(stream.codec || '').toLowerCase();
  const hevc = codec.includes('hevc') || codec.includes('h265');
  const avc = codec.includes('avc') || codec.includes('h264');
  const qualityScore = Number(stream.qn || 0) * 1_000_000;
  const codecScore = settings.preferHevc ? (hevc ? 10_000 : avc ? 1_000 : 0) : avc ? 10_000 : hevc ? 1_000 : 0;
  const protocolScore = stream.protocol.includes('hls') ? 500 : 250;
  const formatScore = stream.format.includes('fmp4') ? 200 : stream.format.includes('flv') ? 100 : 0;
  return qualityScore + codecScore + protocolScore + formatScore;
}

function displayCodecName(codec) {
  const value = String(codec || '').toLowerCase();
  if (value.includes('hevc') || value.includes('h265')) {
    return 'H.265';
  }
  if (value.includes('avc') || value.includes('h264')) {
    return 'H.264';
  }
  return String(codec || '未知').toUpperCase();
}

function escapeFilterPath(filePath) {
  return String(filePath).replace(/\\/g, '/').replace(/:/g, '\\:').replace(/'/g, "\\'");
}

function compactLogLine(text) {
  return String(text).replace(/\s+/g, ' ').trim().slice(0, 240);
}

function parseFfmpegVideoInfo(text) {
  const line = String(text || '')
    .split(/\r?\n/)
    .find((item) => /Video:/i.test(item) && /\d{3,5}x\d{3,5}/.test(item));
  if (!line) {
    return null;
  }
  const sizeMatch = line.match(/,\s*(\d{3,5})x(\d{3,5})(?:[\s,\[]|$)/);
  if (!sizeMatch) {
    return null;
  }
  const codecMatch = line.match(/Video:\s*([^,\r\n]+)/i);
  const profileMatch = line.match(/Video:\s*[^,(]+\s*\(([^)]+)\)/i);
  const pixelFormatMatch = line.match(/Video:\s*[^,]+,\s*([a-z0-9_]+)(?:\(([^)]*)\))?/i);
  const fpsMatch = line.match(/,\s*([0-9]+(?:\.[0-9]+)?)\s*fps/i);
  const fps = fpsMatch ? Number(fpsMatch[1]) : 0;
  const pixelFormat = pixelFormatMatch?.[1] || '';
  const colorParts = String(pixelFormatMatch?.[2] || '').split('/').map((part) => part.trim());
  const bitDepthMatch = pixelFormat.match(/p0?(\d{2})(?:le|be)?$/i);
  const profile = profileMatch?.[1]?.trim() || '';
  const bitDepth = bitDepthMatch ? Number(bitDepthMatch[1]) : /(?:main\s*10|10-bit)/i.test(profile) ? 10 : 8;
  return {
    codec: codecMatch ? codecMatch[1].trim() : '',
    profile,
    pixelFormat,
    bitDepth,
    colorSpace: colorParts.length >= 3 ? colorParts[0].replace(/^tv,\s*/, '') : '',
    colorPrimaries: colorParts.length >= 3 ? colorParts[1] : '',
    colorTransfer: colorParts.length >= 3 ? colorParts[2] : '',
    hdr: /(?:smpte2084|arib-std-b67|bt2020)/i.test(String(pixelFormatMatch?.[2] || '')),
    width: Number(sizeMatch[1]),
    height: Number(sizeMatch[2]),
    fps: Number.isFinite(fps) && fps > 0 ? fps : undefined
  };
}

function parseFfmpegAudioInfo(text) {
  const line = String(text || '')
    .split(/\r?\n/)
    .find((item) => /Audio:/i.test(item));
  if (!line) {
    return null;
  }
  const codecMatch = line.match(/Audio:\s*([^,\r\n]+)/i);
  const sampleRateMatch = line.match(/,\s*(\d+)\s*Hz/i);
  const channelLayoutMatch = line.match(/,\s*(mono|stereo|(?:\d+\.\d+)(?:\([^)]*\))?)(?:,|\s|$)/i);
  return {
    codec: codecMatch ? codecMatch[1].trim() : '',
    sampleRate: sampleRateMatch ? Number(sampleRateMatch[1]) : undefined,
    channelLayout: channelLayoutMatch ? channelLayoutMatch[1].trim().toLowerCase() : undefined
  };
}

function buildActualQualityWarning(settings, stream, videoInfo) {
  const targetQn = Number(settings?.targetQn || 0);
  if (targetQn < 10000 || !videoInfo) {
    return '';
  }
  const expectedMinHeight = targetQn >= 25000 ? 2000 : 1200;
  if (Number(videoInfo.height || 0) >= expectedMinHeight) {
    return '';
  }
  const acceptQn = Array.isArray(stream?.acceptQn) ? stream.acceptQn.filter(Boolean).join('/') : '';
  return `请求 ${targetQn}，接口选中 ${stream?.qn || '未知'}，实际写入 ${videoInfo.width}x${videoInfo.height}。${
    acceptQn ? `接口可选 ${acceptQn}。` : ''
  }如果直播间确认有 2K/4K，请先扫码登录或刷新 Cookie。`;
}

function clamp(value, min, max) {
  const number = Number(value);
  if (Number.isNaN(number)) {
    return min;
  }
  return Math.max(min, Math.min(max, number));
}

function roomLabel(room) {
  return `${room.anchor || room.title || '直播间'}(${room.realRoomId || room.id})`;
}

function guardName(level) {
  if (Number(level) === 1) {
    return '总督';
  }
  if (Number(level) === 2) {
    return '提督';
  }
  return '舰长';
}

function getRuntimePort(settingsPort) {
  const argv = process.argv;
  const inline = argv.find((arg) => arg.startsWith('--port='));
  if (inline) {
    return clamp(Number(inline.split('=').slice(1).join('=')), 1, 65535);
  }
  const portIndex = argv.indexOf('--port');
  if (portIndex >= 0 && argv[portIndex + 1]) {
    return clamp(Number(argv[portIndex + 1]), 1, 65535);
  }
  return clamp(Number(settingsPort || DEFAULT_PORT), 1, 65535);
}

function normalizeServerHost(value) {
  const host = String(value || '').trim();
  if (host === '0.0.0.0' || host === '::' || host === '127.0.0.1' || host === 'localhost') {
    return host;
  }
  return '127.0.0.1';
}

function getRuntimeHost(settingsHost) {
  const argv = process.argv;
  const inline = argv.find((arg) => arg.startsWith('--host='));
  if (inline) {
    return normalizeServerHost(inline.split('=').slice(1).join('='));
  }
  const hostIndex = argv.indexOf('--host');
  if (hostIndex >= 0 && argv[hostIndex + 1]) {
    return normalizeServerHost(argv[hostIndex + 1]);
  }
  return normalizeServerHost(settingsHost || '127.0.0.1');
}

function getAppRoot() {
  const configuredRoot = String(process.env.BILI_RECORD_APP_ROOT || '').trim();
  if (configuredRoot) {
    return path.resolve(configuredRoot);
  }
  const execDir = path.dirname(process.execPath);
  if (process.pkg || fs.existsSync(path.join(execDir, 'dist'))) {
    return execDir;
  }
  return path.resolve(__dirname, '..', '..', '..');
}

function findFfmpegPath() {
  const localBinary = process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg';
  const candidates = [
    path.join(APP_ROOT, 'bin', localBinary),
    path.join(APP_ROOT, localBinary),
    path.join(process.cwd(), 'bin', localBinary),
    ffmpegStatic,
    'ffmpeg'
  ].filter(Boolean);

  for (const candidate of candidates) {
    if (candidate === 'ffmpeg') {
      return candidate;
    }
    try {
      if (fs.existsSync(candidate)) {
        return candidate;
      }
    } catch {
      // Keep trying.
    }
  }
  return 'ffmpeg';
}

function getAppVersion() {
  const candidates = [
    path.join(APP_ROOT, 'version.json'),
    path.join(APP_ROOT, 'package.json'),
    path.join(process.cwd(), 'package.json'),
    path.resolve(__dirname, '..', '..', '..', 'package.json')
  ];
  for (const candidate of candidates) {
    try {
      if (!fs.existsSync(candidate)) {
        continue;
      }
      const data = JSON.parse(fs.readFileSync(candidate, 'utf8'));
      if (data.version) {
        return String(data.version);
      }
    } catch {
      // Keep looking.
    }
  }
  return '0.0.1';
}

async function requestUrlBuffer(rawUrl, options = {}, redirectCount = 0) {
  if (redirectCount > Number(options.maxRedirects ?? 8)) {
    throw new Error('请求重定向次数过多。');
  }
  const maxAttempts = redirectCount === 0 ? clamp(Number(options.retries ?? 4), 1, 8) : 1;
  let lastError = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await requestUrlBufferOnce(rawUrl, options, redirectCount);
    } catch (error) {
      lastError = error;
      if (attempt >= maxAttempts || !isTransientNetworkError(error)) {
        break;
      }
      options.onRetry?.({ attempt, maxAttempts, error });
      await delay(Math.min(800 * attempt, 3000));
    }
  }
  if (lastError && maxAttempts > 1 && isTransientNetworkError(lastError)) {
    throw new Error(`网络请求失败（已重试 ${maxAttempts - 1} 次）：${lastError.message}`);
  }
  throw lastError;
}

async function requestUrlBufferOnce(rawUrl, options = {}, redirectCount = 0) {
  const target = new URL(rawUrl);
  const validation = options.validateUrl ? await options.validateUrl(target, redirectCount) : null;
  const initialOrigin = options._initialOrigin || target.origin;
  let headers = typeof options.headersForUrl === 'function'
    ? options.headersForUrl(target, redirectCount)
    : { ...(options.headers || {}) };
  if (redirectCount > 0 && target.origin !== initialOrigin && typeof options.headersForUrl !== 'function') {
    for (const name of Object.keys(headers)) {
      if (/^(?:authorization|proxy-authorization|cookie|host)$/i.test(name)) delete headers[name];
    }
  }
  const requestOptions = {
    ...options,
    headers,
    lookup: validation?.lookup || options.lookup,
    _initialOrigin: initialOrigin
  };
  const proxy = options.allowProxy === false ? null : await getProxyForUrl(target);
  return proxy
    ? requestUrlViaHttpProxy(target, proxy, requestOptions, redirectCount)
    : requestUrlDirect(target, requestOptions, redirectCount);
}

function requestUrlDirect(target, options, redirectCount) {
  return new Promise((resolve, reject) => {
    const transport = target.protocol === 'https:' ? https : http;
    const request = transport.request(
      {
        protocol: target.protocol,
        hostname: target.hostname,
        port: target.port || (target.protocol === 'https:' ? 443 : 80),
        path: `${target.pathname}${target.search}`,
        method: options.method || 'GET',
        headers: options.headers || {},
        lookup: options.lookup
      },
      (response) => collectUrlResponse(response, target, options, redirectCount, resolve, reject)
    );
    request.setTimeout(Number(options.timeoutMs || 45000), () => request.destroy(new Error('请求超时。')));
    request.on('error', reject);
    request.end(options.body);
  });
}

function isTransientNetworkError(error) {
  const code = String(error?.code || '').toUpperCase();
  const message = String(error?.message || '').toLowerCase();
  return (
    ['ECONNRESET', 'ETIMEDOUT', 'EAI_AGAIN', 'ECONNREFUSED', 'ENETUNREACH', 'EHOSTUNREACH', 'UND_ERR_SOCKET', 'ESLOWDOWNLOAD'].includes(code) ||
    message.includes('econnreset') ||
    message.includes('socket hang up') ||
    message.includes('timeout') ||
    message.includes('请求超时') ||
    message.includes('下载速度过慢') ||
    message.includes('tls') ||
    message.includes('代理请求超时') ||
    message.includes('代理 connect 超时')
  );
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function withTimeout(promise, timeoutMs, message) {
  let timer = null;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(message || '操作超时。')), timeoutMs);
    timer.unref?.();
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) {
      clearTimeout(timer);
    }
  });
}

function requestFfmpegStop(child, options = {}) {
  if (!child || child.exitCode !== null || child.signalCode) {
    return;
  }
  const graceful = options.graceful !== false;
  if (graceful && child.stdin && !child.stdin.destroyed) {
    try {
      child.stdin.write('q\n');
      child.stdin.end();
    } catch {
      forceKillProcess(child);
    }
  } else {
    forceKillProcess(child);
  }
  const timer = setTimeout(() => forceKillProcess(child), Number(options.timeoutMs || 5000));
  timer.unref?.();
  child.once?.('close', () => clearTimeout(timer));
}

function forceKillProcess(child) {
  if (!child || child.exitCode !== null || child.signalCode) {
    return;
  }
  if (process.platform === 'win32' && child.pid) {
    const fallback = setTimeout(() => killChildDirectly(child), 1200);
    fallback.unref?.();
    const killer = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], {
      windowsHide: true,
      stdio: 'ignore'
    });
    killer.on('error', () => {
      clearTimeout(fallback);
      killChildDirectly(child);
    });
    killer.on('close', (code) => {
      clearTimeout(fallback);
      if (code !== 0) {
        killChildDirectly(child);
      }
    });
    return;
  }
  killChildDirectly(child);
}

function killChildDirectly(child) {
  if (!child || child.exitCode !== null || child.signalCode) {
    return;
  }
  try {
    child.kill('SIGKILL');
  } catch {
    try {
      child.kill();
    } catch {}
  }
}

async function getFileSize(filePath) {
  try {
    const stat = await fsp.stat(filePath);
    return stat.isFile() ? stat.size : 0;
  } catch {
    return 0;
  }
}

function isRecordingFileLikelyPlayable({ fileSize, elapsedSec, videoInfo }) {
  const size = Number(fileSize || 0);
  if (size <= 0) {
    return false;
  }
  if (videoInfo && size >= 32 * 1024) {
    return true;
  }
  if (Number(elapsedSec || 0) <= 20 && size >= 32 * 1024) {
    return true;
  }
  return size >= MIN_PLAYABLE_BYTES && Boolean(videoInfo);
}

function hasReachedSegmentLimit(session, elapsedSec) {
  const targetSec = Number(session?.segmentDurationSec || 0);
  if (!Number.isFinite(targetSec) || targetSec <= 0) {
    return false;
  }
  const toleranceSec = Math.min(5, Math.max(1, targetSec * 0.02));
  return Number(elapsedSec || 0) >= targetSec - toleranceSec;
}

function cloneRecordingState(recording) {
  return {
    ...recording,
    danmakuCommandCounts: { ...(recording.danmakuCommandCounts || {}) },
    videoInfo: recording.videoInfo ? { ...recording.videoInfo } : recording.videoInfo
  };
}

function isCurrentRecordingSession(room, session) {
  return Boolean(
    room?.currentRecording &&
      session &&
      room.currentRecording.startedAt === session.startedAt &&
      room.currentRecording.cleanPath === session.cleanPath
  );
}

function formatBytes(bytes) {
  const value = Number(bytes || 0);
  if (value >= 1024 * 1024 * 1024) {
    return `${(value / 1024 / 1024 / 1024).toFixed(2)} GB`;
  }
  if (value >= 1024 * 1024) {
    return `${(value / 1024 / 1024).toFixed(1)} MB`;
  }
  if (value >= 1024) {
    return `${Math.round(value / 1024)} KB`;
  }
  return `${Math.round(value)} B`;
}

async function discoverRecordingFiles(outputDir, options = {}) {
  const candidates = [];
  const maxDepth = Number.isFinite(Number(options.maxDepth)) ? Number(options.maxDepth) : 4;
  const limit = Math.max(1, Number(options.limit || 160));
  const concurrency = Math.max(1, Math.min(8, Number(options.concurrency || 4)));

  let directories = [outputDir];
  for (let depth = 0; depth <= maxDepth && directories.length; depth += 1) {
    const currentDirectories = directories;
    const nextDirectories = [];
    let directoryCursor = 0;
    const scanDirectory = async () => {
      while (directoryCursor < currentDirectories.length) {
        const directory = currentDirectories[directoryCursor++];
        const entries = await fsp.readdir(directory, { withFileTypes: true }).catch(() => []);
        for (const entry of entries) {
          const filePath = path.join(directory, entry.name);
          if (entry.isDirectory()) {
            if (depth < maxDepth) nextDirectories.push(filePath);
            continue;
          }
          if (
            entry.isFile() &&
            /\.(?:clean|merged)\.(?:mp4|mkv)$/i.test(entry.name) &&
            !/\.tmp\.|\.finalizing\.|\.clip_/i.test(entry.name)
          ) {
            candidates.push(filePath);
          }
        }
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(concurrency, currentDirectories.length) }, () => scanDirectory())
    );
    directories = nextDirectories;
  }

  const statCandidates = [];
  let statCursor = 0;
  const statWorker = async () => {
    while (statCursor < candidates.length) {
      const cleanPath = candidates[statCursor++];
      const stat = await fsp.stat(cleanPath).catch(() => null);
      if (stat?.isFile()) statCandidates.push({ cleanPath, stat });
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, candidates.length) }, () => statWorker()));
  const selected = statCandidates.sort((a, b) => Number(b.stat.mtimeMs) - Number(a.stat.mtimeMs)).slice(0, limit);
  const recordings = new Array(selected.length);
  let cursor = 0;
  async function worker() {
    while (cursor < selected.length) {
      const index = cursor++;
      const { cleanPath, stat } = selected[index];
      const danmakuPath = deriveSiblingPath(cleanPath, 'danmaku', 'jsonl');
      const metadataPath = `${cleanPath}.metadata.json`;
      const metadata = await fsp.readFile(metadataPath, 'utf8').then(JSON.parse).catch(() => null);
      const metadataUsable =
        metadata?.schemaVersion === 1 &&
        Number(metadata.fileSize) === Number(stat.size) &&
        Math.abs(Number(metadata.fileMtimeMs) - Number(stat.mtimeMs)) < 2;
      const danmakuInfo = metadataUsable
        ? { eventCount: Number(metadata.eventCount || 0), durationSec: Number(metadata.danmakuDurationSec || 0) }
        : await danmakuAss.inspectDanmakuFile(danmakuPath);
      const eventCount = danmakuInfo.eventCount;
      const elapsedSec = estimateRecordingDurationFromStats(cleanPath, stat);
      const danmakuDurationSec = danmakuInfo.durationSec;
      const valid = stat.size >= 32 * 1024;
      let mediaInfo = metadataUsable
        ? { durationSec: Number(metadata.durationSec || 0), videoInfo: metadata.videoInfo || null }
        : { durationSec: 0, videoInfo: null };
      if (valid && !metadataUsable) {
        mediaInfo = await probeMediaFileInfo(options.ffmpegPath, cleanPath, { timeoutMs: options.probeTimeoutMs }).catch(
          () => mediaInfo
        );
      }
      recordings[index] = {
        id: `${cleanPath}:${Math.round(stat.mtimeMs)}`,
        startedAt: stat.mtimeMs,
        cleanPath,
        danmakuPath,
        cssPath: deriveSiblingPath(cleanPath, 'danmaku', 'css'),
        assPath: deriveSiblingPath(cleanPath, 'danmaku', 'ass'),
        burnedPath: deriveBurnedPath(cleanPath, 'danmaku-gift'),
        capturePath: '',
        containerStage: valid ? 'ready' : 'failed',
        validReason: valid ? '' : `文件过小：${formatBytes(stat.size)}`,
        durationSec: resolveReliableDurationSec({
          mediaDurationSec: mediaInfo.durationSec,
          elapsedSec,
          danmakuDurationSec,
          segmentDurationSec: options.segmentDurationSec
        }),
        fileSize: stat.size,
        valid,
        eventCount,
        capturedDanmakuCount: eventCount,
        rawDanmakuCount: eventCount,
        ignoredDanmakuCount: 0,
        danmakuCommandCounts: {},
        videoInfo: mediaInfo.videoInfo,
        metadataPath
      };
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, selected.length) }, () => worker()));
  return recordings.filter(Boolean);
}

async function countDanmakuLines(filePath) {
  const result = await danmakuAss.inspectDanmakuFile(filePath).catch(() => ({ eventCount: 0 }));
  return result.eventCount;
}

function requestUrlViaHttpProxy(target, proxy, options, redirectCount) {
  if (target.protocol === 'http:') {
    return new Promise((resolve, reject) => {
      const request = http.request(
        {
          hostname: proxy.hostname,
          port: proxy.port || 80,
          path: target.toString(),
          method: options.method || 'GET',
          headers: {
            ...(options.headers || {}),
            Host: target.host,
            ...proxyAuthorizationHeader(proxy)
          }
        },
        (response) => collectUrlResponse(response, target, options, redirectCount, resolve, reject)
      );
      request.setTimeout(Number(options.timeoutMs || 45000), () => request.destroy(new Error('代理请求超时。')));
      request.on('error', reject);
      request.end(options.body);
    });
  }

  return new Promise((resolve, reject) => {
    const connect = http.request({
      hostname: proxy.hostname,
      port: proxy.port || 80,
      method: 'CONNECT',
      path: `${target.hostname}:${target.port || 443}`,
      headers: {
        Host: `${target.hostname}:${target.port || 443}`,
        ...proxyAuthorizationHeader(proxy)
      }
    });
    connect.setTimeout(Number(options.timeoutMs || 45000), () => connect.destroy(new Error('代理 CONNECT 超时。')));
    connect.on('connect', (response, socket) => {
      if (response.statusCode !== 200) {
        socket.destroy();
        reject(new Error(`代理 CONNECT 失败：HTTP ${response.statusCode}`));
        return;
      }
      const secureSocket = tls.connect({ socket, servername: target.hostname });
      secureSocket.on('error', reject);
      secureSocket.once('secureConnect', () => {
        const request = https.request(
          {
            hostname: target.hostname,
            port: target.port || 443,
            path: `${target.pathname}${target.search}`,
            method: options.method || 'GET',
            headers: options.headers || {},
            createConnection: () => secureSocket,
            agent: false
          },
          (res) => collectUrlResponse(res, target, options, redirectCount, resolve, reject)
        );
        request.setTimeout(Number(options.timeoutMs || 45000), () => request.destroy(new Error('代理 HTTPS 请求超时。')));
        request.on('error', reject);
        request.end(options.body);
      });
    });
    connect.on('error', reject);
    connect.end();
  });
}

function collectUrlResponse(response, target, options, redirectCount, resolve, reject) {
  const statusCode = Number(response.statusCode || 0);
  const location = response.headers.location;
  if ([301, 302, 303, 307, 308].includes(statusCode) && location) {
    response.resume();
    if (redirectCount >= Number(options.maxRedirects ?? 8)) {
      reject(new Error('请求重定向次数过多。'));
      return;
    }
    resolve(requestUrlBuffer(new URL(location, target).toString(), options, redirectCount + 1));
    return;
  }
  const chunks = [];
  const totalBytes = Number(response.headers['content-length'] || 0);
  const maxBytes = Math.max(0, Number(options.maxBytes || 0));
  if (maxBytes && totalBytes > maxBytes) {
    response.destroy();
    reject(new Error(`远端响应超过大小限制 ${maxBytes} 字节。`));
    return;
  }
  let receivedBytes = 0;
  response.on('data', (chunk) => {
    if (maxBytes && receivedBytes + chunk.length > maxBytes) {
      response.destroy(new Error(`远端响应超过大小限制 ${maxBytes} 字节。`));
      return;
    }
    chunks.push(chunk);
    receivedBytes += chunk.length;
    options.onProgress?.({ receivedBytes, totalBytes, done: false });
  });
  response.on('end', () => {
    const body = Buffer.concat(chunks);
    if (statusCode < 200 || statusCode >= 300) {
      reject(new Error(`请求失败：HTTP ${statusCode} ${body.toString('utf8').slice(0, 180)}`.trim()));
      return;
    }
    options.onProgress?.({ receivedBytes: body.length, totalBytes, done: true });
    resolve(options.includeResponseMetadata ? { body, statusCode, headers: response.headers, url: target.toString() } : body);
  });
  response.on('error', reject);
}

async function getProxyForUrl(target) {
  if (shouldBypassProxy(target.hostname)) {
    return null;
  }
  const envProxy =
    target.protocol === 'https:'
      ? process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy
      : process.env.HTTP_PROXY || process.env.http_proxy;
  const proxySource = envProxy || (await getWindowsProxyForUrl(target)) || '';
  return normalizeProxyUrl(proxySource);
}

function shouldBypassProxy(hostname) {
  const noProxy = process.env.NO_PROXY || process.env.no_proxy || '';
  if (!noProxy.trim()) {
    return false;
  }
  const host = String(hostname || '').toLowerCase();
  return noProxy
    .split(',')
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean)
    .some((rule) => rule === '*' || host === rule || (rule.startsWith('.') ? host.endsWith(rule) : host.endsWith(`.${rule}`)));
}

async function getWindowsProxyForUrl(target) {
  if (process.platform !== 'win32') {
    return '';
  }
  const winInetProxy = await getWinInetProxyServer();
  if (winInetProxy) {
    return selectProxyServer(winInetProxy, target.protocol);
  }
  const winHttpProxy = await getWinHttpProxyServer();
  return winHttpProxy ? selectProxyServer(winHttpProxy, target.protocol) : '';
}

async function getWinInetProxyServer() {
  const key = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings';
  const enabled = await runCapturedProcess('reg.exe', ['query', key, '/v', 'ProxyEnable'], {
    timeoutMs: 2500,
    maxOutputBytes: 32 * 1024
  });
  if (enabled.status !== 0 || !/ProxyEnable\s+REG_DWORD\s+0x1/i.test(enabled.stdout || '')) {
    return '';
  }
  const server = await runCapturedProcess('reg.exe', ['query', key, '/v', 'ProxyServer'], {
    timeoutMs: 2500,
    maxOutputBytes: 32 * 1024
  });
  if (server.status !== 0) {
    return '';
  }
  return parseRegistryValue(server.stdout, 'ProxyServer');
}

async function getWinHttpProxyServer() {
  const result = await runCapturedProcess('netsh.exe', ['winhttp', 'show', 'proxy'], {
    timeoutMs: 3000,
    maxOutputBytes: 64 * 1024
  });
  if (result.status !== 0 || /Direct access|直接访问|无代理/i.test(result.stdout || '')) {
    return '';
  }
  const line = String(result.stdout || '')
    .split(/\r?\n/)
    .map((item) => item.trim())
    .find((item) => /Proxy Server|代理服务器|代理服务器\(s\)/i.test(item));
  return line?.split(':').slice(1).join(':').trim() || '';
}

function parseRegistryValue(text, name) {
  const line = String(text || '')
    .split(/\r?\n/)
    .find((item) => new RegExp(`\\b${name}\\b`, 'i').test(item));
  return line?.match(/\sREG_\w+\s+(.+)$/i)?.[1]?.trim() || '';
}

function selectProxyServer(proxyConfig, protocol) {
  const text = String(proxyConfig || '').trim();
  if (!text) {
    return '';
  }
  if (!text.includes('=')) {
    return text;
  }
  const desired = protocol === 'https:' ? 'https' : 'http';
  const map = new Map();
  for (const entry of text.split(';')) {
    const [key, ...rest] = entry.split('=');
    if (key && rest.length) {
      map.set(key.trim().toLowerCase(), rest.join('=').trim());
    }
  }
  return map.get(desired) || map.get('http') || '';
}

function normalizeProxyUrl(value) {
  const text = String(value || '').trim();
  if (!text || /^socks/i.test(text)) {
    return null;
  }
  try {
    const url = new URL(/^[a-z]+:\/\//i.test(text) ? text : `http://${text}`);
    if (url.protocol !== 'http:') {
      return null;
    }
    return url;
  } catch {
    return null;
  }
}

function proxyAuthorizationHeader(proxy) {
  if (!proxy.username) {
    return {};
  }
  const token = Buffer.from(`${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password || '')}`).toString('base64');
  return { 'Proxy-Authorization': `Basic ${token}` };
}

async function readTextSource(source, options = {}) {
  const value = String(source || '').trim();
  if (!value) {
    throw new Error('更新源为空。');
  }
  if (/^https?:\/\//i.test(value)) {
    const body = await requestUrlBuffer(value, {
      headers: {
        Accept: 'application/json, text/plain, */*',
        'User-Agent': `${APP_NAME}/${APP_VERSION}`,
        ...(options.headers || {})
      },
      retries: options.retries,
      timeoutMs: options.timeoutMs,
      onRetry: options.onRetry,
      maxRedirects: 4,
      maxBytes: 2 * 1024 * 1024,
      allowProxy: false,
      validateUrl: (target) => validateRemoteUrl(target, { protocols: ['https:'] })
    });
    return body.toString('utf8');
  }
  const filePath = value.startsWith('file://') ? new URL(value) : path.resolve(APP_ROOT, value);
  return fsp.readFile(filePath, 'utf8');
}

function isDefaultUpdateSource(source, defaultSource = '') {
  const normalized = String(source || '').trim().replace(/\/+$/, '');
  const fallback = String(defaultSource || '').trim().replace(/\/+$/, '');
  return (fallback && normalized === fallback) || normalized.endsWith('/releases/latest/download/update.json');
}

function normalizeUpdateManifest(payload, options = {}) {
  if (!payload || typeof payload !== 'object') {
    throw new Error('更新源不是有效 JSON。');
  }
  const platform = normalizeUpdatePlatform(options.platform || process.platform);
  const arch = normalizeUpdateArch(options.arch || process.arch);
  const preferredPackageType = normalizeUpdatePackageType(
    options.packageType ||
      getAppPackageType({ platform, appRoot: options.appRoot, configuredType: options.configuredType }),
    platform
  );
  if (Array.isArray(payload.assets)) {
    const files = payload.assets.map((asset) => ({
      name: asset.name || packageFileNameFromUrl(asset.browser_download_url || asset.url || ''),
      url: asset.browser_download_url || asset.url || '',
      sha256: String(asset.digest || '').replace(/^sha256:/i, '')
    }));
    const packageAsset = selectUpdatePackageFile(files, { platform, arch, preferredPackageType });
    return {
      version: normalizeVersion(payload.version || payload.tag_name || ''),
      tagName: payload.tag_name || '',
      packageType: packageAsset?.packageType || preferredPackageType,
      packageUrl: packageAsset?.url || '',
      sha256: packageAsset?.sha256 || payload.sha256 || '',
      releaseUrl: payload.html_url || '',
      notes: payload.body || '',
      packageName: packageAsset?.name || packageFileNameFromUrl(packageAsset?.url || '')
    };
  }
  const files = Array.isArray(payload.files) ? payload.files : [];
  const packageFile = selectUpdatePackageFile(files, { platform, arch, preferredPackageType });
  const legacyPackageUrl = payload.installerUrl || payload.packageUrl || payload.url || payload.downloadUrl || '';
  const legacyPackageType = normalizeUpdatePackageType(payload.packageType || legacyPackageUrl, platform);
  const legacyPlatform = inferUpdatePlatform(payload.platform || legacyPackageUrl, legacyPackageType);
  const canUseLegacyPackage = !packageFile && (!legacyPlatform || legacyPlatform === platform);
  const packageUrl = packageFile?.url || (canUseLegacyPackage ? legacyPackageUrl : '');
  const packageType = packageFile?.packageType || legacyPackageType;
  return {
    version: normalizeVersion(payload.version || payload.tagName || ''),
    tagName: payload.tagName || payload.tag_name || '',
    packageType,
    packageUrl,
    sha256:
      packageFile?.sha256 ||
      payload.sha256 ||
      (packageType === 'installer' ? payload.installerSha256 : packageType === 'portable' ? payload.portableSha256 : '') ||
      '',
    installerArgs: payload.installerArgs,
    releaseUrl: payload.releaseUrl || payload.htmlUrl || '',
    notes: payload.notes || payload.body || '',
    packageName: packageFile?.name || packageFileNameFromUrl(packageUrl),
    packageArch: packageFile?.arch || '',
    signed: payload.signed || null,
    signatureAlgorithm: String(payload.signatureAlgorithm || ''),
    signature: String(payload.signature || '')
  };
}

function normalizeVersion(value) {
  return String(value || '').trim().replace(/^v/i, '');
}

function normalizeUpdatePlatform(value) {
  const text = String(value || '').trim().toLowerCase();
  if (text === 'windows' || text === 'win32') return 'win32';
  if (text === 'linux') return 'linux';
  if (text === 'darwin' || text === 'macos' || text === 'mac') return 'darwin';
  return text;
}

function normalizeUpdateArch(value) {
  const text = String(value || '').trim().toLowerCase();
  if (text === 'amd64' || text === 'x86_64') return 'x64';
  if (text === 'aarch64') return 'arm64';
  if (text === 'any' || text === 'noarch') return 'all';
  return text;
}

function normalizeUpdatePackageType(value, platform = process.platform) {
  const text = String(value || '').trim().toLowerCase();
  if (text === 'deb' || /\.deb(?:$|[?#])/i.test(text)) {
    return 'deb';
  }
  if (text === 'tarball' || text === 'linux-tar' || /\.(?:tar\.gz|tgz)(?:$|[?#])/i.test(text)) {
    return 'tarball';
  }
  if (text === 'installer' || isInstallerFileName(text)) {
    return 'installer';
  }
  if (text === 'portable') {
    return 'portable';
  }
  if (/\.zip(?:$|[?#])/i.test(text)) {
    return 'portable';
  }
  if (normalizeUpdatePlatform(platform) === 'linux') {
    return 'deb';
  }
  return 'portable';
}

function inferUpdatePlatform(value, packageType = '') {
  const explicit = normalizeUpdatePlatform(value);
  if (explicit === 'win32' || explicit === 'linux' || explicit === 'darwin') {
    return explicit;
  }
  const text = String(value || '').toLowerCase();
  if (packageType === 'deb' || packageType === 'tarball' || /\.(?:deb|tar\.gz|tgz)(?:$|[?#])/i.test(text)) return 'linux';
  if (packageType === 'installer' || packageType === 'portable' || /\.(?:exe|msi|msix|zip)(?:$|[?#])/i.test(text)) return 'win32';
  return '';
}

function selectUpdatePackageFile(files, { platform, arch, preferredPackageType }) {
  const candidates = files
    .map((file) => {
      const nameOrUrl = file.name || file.url || '';
      const packageType = normalizeUpdatePackageType(file.kind || file.type || nameOrUrl, platform);
      return {
        ...file,
        packageType,
        platform: inferUpdatePlatform(file.platform || nameOrUrl, packageType),
        arch: normalizeUpdateArch(file.arch || 'all') || 'all'
      };
    })
    .filter((file) => file.url)
    .filter((file) => !file.platform || file.platform === platform)
    .filter((file) => file.arch === 'all' || !arch || file.arch === arch);
  const typeOrder = platform === 'linux' ? ['deb', 'tarball'] : platform === 'win32' ? ['installer', 'portable'] : [];
  candidates.sort((left, right) => {
    const score = (file) => {
      if (file.packageType === preferredPackageType) return 0;
      const index = typeOrder.indexOf(file.packageType);
      return index >= 0 ? index + 1 : 50;
    };
    return score(left) - score(right);
  });
  return candidates[0] || null;
}

function getAppPackageType(options = {}) {
  const platform = normalizeUpdatePlatform(options.platform || process.platform);
  const appRoot = path.resolve(String(options.appRoot || APP_ROOT));
  const configured = String(
    options.configuredType === undefined ? process.env.BILI_RECORD_PACKAGE_TYPE || '' : options.configuredType
  ).trim();
  if (configured) {
    return normalizeUpdatePackageType(configured, platform);
  }
  for (const candidate of [
    path.join(appRoot, 'install-type.json'),
    path.join(appRoot, 'version.json'),
    path.join(appRoot, 'package.json')
  ]) {
    try {
      const payload = JSON.parse(fs.readFileSync(candidate, 'utf8'));
      if (payload.packageType) {
        return normalizeUpdatePackageType(payload.packageType, platform);
      }
    } catch {
      // Keep looking.
    }
  }
  if (platform === 'win32') {
    try {
      if (fs.statSync(path.join(appRoot, 'Uninstall.exe')).isFile()) {
        return 'installer';
      }
    } catch {
      // Portable builds do not include the NSIS uninstaller.
    }
  }
  return normalizeUpdatePackageType('', platform);
}

function isInstallerFileName(value) {
  const text = String(value || '').toLowerCase();
  return /\.(?:exe|msi|msix|appinstaller)(?:$|[?#])/i.test(text) && /(setup|install|installer)/i.test(text);
}

function isInstallerUpdatePackage(manifest, packagePath) {
  return normalizeUpdatePackageType(manifest?.packageType || manifest?.packageUrl || packagePath) === 'installer';
}

function normalizeInstallerArgs(manifest) {
  if (Array.isArray(manifest?.installerArgs)) {
    return manifest.installerArgs.map(String);
  }
  if (typeof manifest?.installerArgs === 'string') {
    return splitCommandLineArgs(manifest.installerArgs);
  }
  return [];
}

function buildInstallerArgs(manifest, paths) {
  const args = normalizeInstallerArgs(manifest);
  args.push(`/STATUS=${portableInstallerArgPath(paths.statusPath)}`);
  args.push(`/LOG=${portableInstallerArgPath(paths.logPath)}`);
  args.push(`/PACKAGE=${portableInstallerArgPath(paths.packagePath)}`);
  return args;
}

function portableInstallerArgPath(filePath) {
  return path.resolve(String(filePath || '')).replace(/\\/g, '/');
}

function splitCommandLineArgs(value) {
  const args = [];
  const text = String(value || '');
  let current = '';
  let quote = '';
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if ((char === '"' || char === "'") && !quote) {
      quote = char;
      continue;
    }
    if (char === quote) {
      quote = '';
      continue;
    }
    if (/\s/.test(char) && !quote) {
      if (current) {
        args.push(current);
        current = '';
      }
      continue;
    }
    current += char;
  }
  if (current) {
    args.push(current);
  }
  return args;
}

function updatePackageLabel(manifest) {
  const packageType = normalizeUpdatePackageType(manifest?.packageType || manifest?.packageUrl, process.platform);
  if (packageType === 'deb') return 'Debian 安装包';
  if (packageType === 'tarball') return 'Linux 更新包';
  return isInstallerUpdatePackage(manifest, manifest?.packageUrl) ? '安装器' : '更新包';
}

function updatePackageFileName(manifest) {
  const version = sanitizeFilename(manifest?.version || 'latest');
  const packageType = normalizeUpdatePackageType(manifest?.packageType || manifest?.packageUrl, process.platform);
  const signedName = String(manifest?.packageName || '');
  if (signedName && path.basename(signedName) === signedName && !/[\\/]/.test(signedName)) {
    return signedName;
  }
  if (packageType === 'deb') {
    const arch = process.arch === 'x64' ? 'amd64' : process.arch === 'arm64' ? 'arm64' : process.arch;
    return `bili-record-2k_${version}_${arch}.deb`;
  }
  if (packageType === 'tarball') {
    return `bili-record-2k_${version}_linux_${process.arch}.tar.gz`;
  }
  const urlName = packageFileNameFromUrl(manifest?.packageUrl || '');
  const extension = path.extname(urlName).toLowerCase();
  if (extension) {
    return `bili-record-2k-${version}${extension}`;
  }
  return isInstallerUpdatePackage(manifest, '') ? `bili-record-2k-${version}-setup.exe` : `bili-record-2k-${version}.zip`;
}

function packageFileNameFromUrl(value) {
  try {
    return path.basename(new URL(String(value || '')).pathname);
  } catch {
    return path.basename(String(value || ''));
  }
}

function compareVersions(left, right) {
  const a = parseSemver(left);
  const b = parseSemver(right);
  for (const key of ['major', 'minor', 'patch']) {
    if (a[key] !== b[key]) return a[key] - b[key];
  }
  if (!a.prerelease.length && b.prerelease.length) return 1;
  if (a.prerelease.length && !b.prerelease.length) return -1;
  for (let index = 0; index < Math.max(a.prerelease.length, b.prerelease.length); index += 1) {
    if (a.prerelease[index] === undefined) return -1;
    if (b.prerelease[index] === undefined) return 1;
    const leftPart = a.prerelease[index];
    const rightPart = b.prerelease[index];
    if (leftPart === rightPart) continue;
    const leftNumeric = /^\d+$/.test(leftPart);
    const rightNumeric = /^\d+$/.test(rightPart);
    if (leftNumeric && rightNumeric) return Number(leftPart) - Number(rightPart);
    if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1;
    return leftPart.localeCompare(rightPart);
  }
  return 0;
}

function parseSemver(value) {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(normalizeVersion(value));
  if (!match) throw new Error(`无效的 SemVer：${value}`);
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] ? match[4].split('.') : []
  };
}

function createUpdateDownloadSources(rawUrl, options = {}) {
  const url = String(rawUrl || '').trim();
  const sources = [{ url, label: '更新源' }];
  if (options.officialSource !== true || !url.startsWith(OFFICIAL_RELEASE_DOWNLOAD_PREFIX)) {
    return sources;
  }
  sources[0].label = 'GitHub 官方源';
  sources.push({
    url: `${UPDATE_DOWNLOAD_MIRROR_PREFIX}${url}`,
    label: 'GitHub 镜像'
  });
  return sources;
}

async function downloadFile(url, targetPath, onProgress, downloadOptions = {}) {
  if (!/^https?:\/\//i.test(String(url || ''))) {
    throw new Error('更新包下载地址无效。');
  }
  const tmpPath = `${targetPath}.tmp`;
  const requestOptions = {
    headers: {
      Accept: 'application/x-msdownload, application/vnd.microsoft.portable-executable, application/vnd.debian.binary-package, application/gzip, application/zip, application/octet-stream, */*',
      'User-Agent': `${APP_NAME}/${APP_VERSION}`
    },
    onProgress,
    maxRedirects: 4,
    maxBytes: 8 * 1024 * 1024 * 1024,
    lowSpeedBytesPerSecond: UPDATE_DOWNLOAD_LOW_SPEED_BYTES_PER_SECOND,
    lowSpeedWindowMs: UPDATE_DOWNLOAD_LOW_SPEED_WINDOW_MS,
    validateUrl: (target) => validateRemoteUrl(target, { protocols: ['https:'] })
  };
  const sources = createUpdateDownloadSources(url, downloadOptions);
  let lastError;
  const maxAttemptsPerSource = sources.length > 1 ? 2 : 4;
  for (let sourceIndex = 0; sourceIndex < sources.length; sourceIndex += 1) {
    const source = sources[sourceIndex];
    for (let attempt = 1; attempt <= maxAttemptsPerSource; attempt += 1) {
      await fsp.rm(tmpPath, { force: true });
      try {
        await downloadUrlToFile(source.url, tmpPath, requestOptions);
        await fsp.rm(targetPath, { force: true });
        await fsp.rename(tmpPath, targetPath);
        return;
      } catch (error) {
        lastError = error;
        await fsp.rm(tmpPath, { force: true }).catch(() => {});
        const hasNextSource = sourceIndex + 1 < sources.length;
        const switchImmediately = error?.code === 'ESLOWDOWNLOAD' && hasNextSource;
        const shouldRetry = attempt < maxAttemptsPerSource && isTransientNetworkError(error) && !switchImmediately;
        if (shouldRetry) {
          onProgress?.({
            retrying: true,
            attempt,
            maxAttempts: maxAttemptsPerSource,
            sourceLabel: source.label,
            error,
            receivedBytes: 0,
            totalBytes: 0,
            done: false
          });
          await delay(Math.min(attempt * 800, 3000));
          continue;
        }
        if (hasNextSource) {
          onProgress?.({
            retrying: true,
            switchingSource: true,
            sourceLabel: sources[sourceIndex + 1].label,
            attempt,
            maxAttempts: maxAttemptsPerSource,
            error,
            receivedBytes: 0,
            totalBytes: 0,
            done: false
          });
        }
        break;
      }
    }
  }
  throw lastError || new Error('更新包下载失败。');
}

async function downloadUrlToFile(rawUrl, temporaryPath, options, redirectCount = 0) {
  if (redirectCount > Number(options.maxRedirects || 0)) throw new Error('更新包重定向次数过多。');
  const target = new URL(rawUrl);
  const validation = await options.validateUrl(target);
  await new Promise((resolve, reject) => {
    const transport = target.protocol === 'https:' ? https : http;
    const request = transport.request(
      {
        protocol: target.protocol,
        hostname: target.hostname,
        port: target.port || (target.protocol === 'https:' ? 443 : 80),
        path: `${target.pathname}${target.search}`,
        method: 'GET',
        headers: options.headers,
        lookup: validation.lookup
      },
      (response) => {
        const statusCode = Number(response.statusCode || 0);
        const location = response.headers.location;
        if ([301, 302, 303, 307, 308].includes(statusCode) && location) {
          response.resume();
          resolve(downloadUrlToFile(new URL(location, target).toString(), temporaryPath, options, redirectCount + 1));
          return;
        }
        if (statusCode < 200 || statusCode >= 300) {
          response.resume();
          reject(new Error(`更新包下载失败：HTTP ${statusCode}`));
          return;
        }
        const maxBytes = Number(options.maxBytes || 0);
        const totalBytes = Number(response.headers['content-length'] || 0);
        if (maxBytes && totalBytes > maxBytes) {
          response.destroy();
          reject(new Error(`更新包超过大小限制 ${maxBytes} 字节。`));
          return;
        }
        const output = fs.createWriteStream(temporaryPath, { flags: 'wx', mode: 0o600 });
        let receivedBytes = 0;
        let settled = false;
        let speedWindowStartedAt = Date.now();
        let speedWindowStartBytes = 0;
        let speedTimer = null;
        const clearSpeedTimer = () => {
          if (speedTimer) {
            clearInterval(speedTimer);
            speedTimer = null;
          }
        };
        const fail = (error) => {
          if (settled) return;
          settled = true;
          clearSpeedTimer();
          response.destroy();
          output.destroy();
          reject(error);
        };
        const lowSpeedWindowMs = Math.max(0, Number(options.lowSpeedWindowMs || 0));
        const lowSpeedBytesPerSecond = Math.max(0, Number(options.lowSpeedBytesPerSecond || 0));
        if (lowSpeedWindowMs && lowSpeedBytesPerSecond) {
          speedTimer = setInterval(() => {
            const now = Date.now();
            const elapsedMs = now - speedWindowStartedAt;
            if (elapsedMs < lowSpeedWindowMs) return;
            const bytesPerSecond = ((receivedBytes - speedWindowStartBytes) * 1000) / Math.max(1, elapsedMs);
            if (bytesPerSecond < lowSpeedBytesPerSecond) {
              const error = new Error('更新包下载速度过慢，正在尝试其他下载源。');
              error.code = 'ESLOWDOWNLOAD';
              fail(error);
              return;
            }
            speedWindowStartedAt = now;
            speedWindowStartBytes = receivedBytes;
          }, Math.min(5000, lowSpeedWindowMs));
          speedTimer.unref?.();
        }
        response.on('data', (chunk) => {
          receivedBytes += chunk.length;
          if (maxBytes && receivedBytes > maxBytes) {
            fail(new Error(`更新包超过大小限制 ${maxBytes} 字节。`));
            return;
          }
          options.onProgress?.({ receivedBytes, totalBytes, done: false });
        });
        response.on('error', fail);
        output.on('error', fail);
        output.on('finish', () => {
          if (settled) return;
          settled = true;
          clearSpeedTimer();
          options.onProgress?.({ receivedBytes, totalBytes, done: true });
          resolve();
        });
        response.pipe(output);
      }
    );
    request.setTimeout(45_000, () => request.destroy(new Error('更新包下载超时。')));
    request.on('error', reject);
    request.end();
  });
}

async function fileSha256(filePath) {
  const hash = crypto.createHash('sha256');
  for await (const chunk of fs.createReadStream(filePath)) hash.update(chunk);
  return hash.digest('hex');
}

async function isStartupEnabled() {
  if (process.platform === 'linux') {
    return process.env.BILI_RECORD_SYSTEMD === '1';
  }
  if (process.platform !== 'win32') {
    return false;
  }
  const result = await runCapturedProcess('reg.exe', ['query', RUN_KEY, '/v', APP_NAME], {
    timeoutMs: 2500,
    maxOutputBytes: 32 * 1024
  });
  return result.status === 0;
}

async function setStartupEnabled(enabled) {
  const command = createStartupCommand();
  const args = enabled
    ? ['add', RUN_KEY, '/v', APP_NAME, '/t', 'REG_SZ', '/d', command, '/f']
    : ['delete', RUN_KEY, '/v', APP_NAME, '/f'];
  const result = await runCapturedProcess('reg.exe', args, {
    timeoutMs: 4000,
    maxOutputBytes: 64 * 1024
  });
  if (result.status !== 0 && enabled) {
    throw new Error((result.stderr || result.stdout || '写入开机自启失败').trim());
  }
  if (result.status !== 0 && !enabled && !/unable|找不到|不存在/i.test(result.stderr || result.stdout || '')) {
    throw new Error((result.stderr || result.stdout || '删除开机自启失败').trim());
  }
}

function createStartupCommand() {
  const execDir = path.dirname(process.execPath);
  const launcherPath = path.join(execDir, 'BiliRecord2K.exe');
  if (fs.existsSync(path.join(execDir, 'dist')) && fs.existsSync(launcherPath)) {
    return `"${launcherPath}" --prod --no-open`;
  }
  if (process.pkg || fs.existsSync(path.join(execDir, 'dist'))) {
    return `"${process.execPath}" --prod --no-open`;
  }
  return `"${process.execPath}" "${path.join(APP_ROOT, 'src', 'server', 'index.cjs')}" --prod --no-open`;
}

function showWindowsToast(title, message) {
  if (process.platform !== 'win32') {
    return;
  }
  const script = `
$ErrorActionPreference = 'Stop'
function DecodeText([string]$value) {
  [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($value))
}
$title = [System.Security.SecurityElement]::Escape((DecodeText '${base64Utf8(title)}'))
$message = [System.Security.SecurityElement]::Escape((DecodeText '${base64Utf8(message)}'))
[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null
[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] | Out-Null
$xmlText = "<toast><visual><binding template='ToastGeneric'><text>$title</text><text>$message</text></binding></visual></toast>"
$xml = [Windows.Data.Xml.Dom.XmlDocument]::new()
$xml.LoadXml($xmlText)
$toast = [Windows.UI.Notifications.ToastNotification]::new($xml)
[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('${APP_NAME}').Show($toast)
`;
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  const child = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true
  });
  child.unref();
}

function base64Utf8(value) {
  return Buffer.from(String(value || ''), 'utf8').toString('base64');
}

function openUrl(url) {
  if (process.platform === 'win32') {
    spawn('cmd.exe', ['/c', 'start', '', url], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true
    }).unref();
    return;
  }
  openPath(url);
}

function openPath(targetPath) {
  if (process.platform === 'win32') {
    spawn('explorer.exe', [targetPath], { detached: true, stdio: 'ignore' }).unref();
    return;
  }
  if (process.platform === 'darwin') {
    spawn('open', [targetPath], { detached: true, stdio: 'ignore' }).unref();
    return;
  }
  spawn('xdg-open', [targetPath], { detached: true, stdio: 'ignore' }).unref();
}

function mimeType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  return (
    {
      '.html': 'text/html; charset=utf-8',
      '.js': 'text/javascript; charset=utf-8',
      '.css': 'text/css; charset=utf-8',
      '.json': 'application/json; charset=utf-8',
      '.svg': 'image/svg+xml',
      '.png': 'image/png',
      '.ico': 'image/x-icon',
      '.webp': 'image/webp',
      '.mp4': 'video/mp4',
      '.m4v': 'video/mp4',
      '.mov': 'video/quicktime',
      '.mkv': 'video/x-matroska',
      '.webm': 'video/webm'
    }[ext] || 'application/octet-stream'
  );
}

module.exports = {
  ...danmakuClient,
  ...danmakuAss,
  ...ffmpegHelpers,
  fetchWithTimeout,
  requestBiliJsonWithCookies,
  getSetCookieHeaders,
  splitSetCookieHeader,
  mergeCookieString,
  cookieHeadersFromLoginUrl,
  sanitizeFilename,
  sanitizeHeaderValue,
  createImageProxyHeaders,
  createPreviewProxyHeaders,
  createPreviewProxyPath,
  encodePreviewUrl,
  decodePreviewUrl,
  isPreviewPlaylist,
  rewriteHlsManifest,
  rewriteHlsManifestLine,
  resolveHlsResourceUrl,
  previewMimeType,
  isBilibiliHost,
  getCookieValue,
  createBiliError,
  normalizeContainer,
  normalizeContainerStage,
  normalizeCommandCounts,
  mergeCommandCounts,
  detectFfmpegCapabilities,
  runCapturedProcess,
  runFfmpegProbe,
  parseFfmpegEncoderNames,
  parseFfmpegHwaccels,
  detectVideoAdapters,
  detectVideoAdapterVendor,
  hasVideoAdapterVendor,
  shouldTestHardwareEncoder,
  testFfmpegEncoder,
  normalizeBurnCodec,
  normalizeRoomImageMode,
  normalizeBurnOverlayMode,
  normalizeExportMode,
  overlayModeLabel,
  basenameWithoutExt,
  normalizeTargetQn,
  createQnProbeList,
  getContainerFromPath,
  deriveSiblingPath,
  deriveBurnedPath,
  deriveClipPath,
  replaceExtension,
  isPathInsideDirectory,
  createClipSuffix,
  normalizeClipModeName,
  safeTimeSlug,
  parseTimeInput,
  formatFfmpegSeconds,
  runFfmpegJob,
  createFfmpegJobProgress,
  updateFfmpegJobProgress,
  finishFfmpegJobProgress,
  parseFfmpegProgressTime,
  parseFfmpegTime,
  parseFfmpegDuration,
  resolveReliableDurationSec,
  parseRecordingStartedAtFromName,
  estimateRecordingDurationFromStats,
  readDanmakuDurationSec,
  probeMediaFileInfo,
  probeMediaTimelineInfo,
  isHevcCodec,
  formatTimestamp,
  formatDurationSeconds,
  streamScore,
  displayCodecName,
  escapeFilterPath,
  compactLogLine,
  parseFfmpegVideoInfo,
  parseFfmpegAudioInfo,
  buildActualQualityWarning,
  clamp,
  roomLabel,
  guardName,
  getRuntimePort,
  getRuntimeHost,
  normalizeServerHost,
  getAppRoot,
  findFfmpegPath,
  getAppVersion,
  requestUrlBuffer,
  requestUrlBufferOnce,
  requestUrlDirect,
  isTransientNetworkError,
  delay,
  withTimeout,
  requestFfmpegStop,
  forceKillProcess,
  killChildDirectly,
  getFileSize,
  isRecordingFileLikelyPlayable,
  hasReachedSegmentLimit,
  cloneRecordingState,
  isCurrentRecordingSession,
  formatBytes,
  discoverRecordingFiles,
  countDanmakuLines,
  requestUrlViaHttpProxy,
  collectUrlResponse,
  getProxyForUrl,
  shouldBypassProxy,
  getWindowsProxyForUrl,
  getWinInetProxyServer,
  getWinHttpProxyServer,
  parseRegistryValue,
  selectProxyServer,
  normalizeProxyUrl,
  proxyAuthorizationHeader,
  readTextSource,
  isDefaultUpdateSource,
  normalizeUpdateManifest,
  normalizeVersion,
  normalizeUpdatePlatform,
  normalizeUpdateArch,
  normalizeUpdatePackageType,
  selectUpdatePackageFile,
  getAppPackageType,
  isInstallerFileName,
  isInstallerUpdatePackage,
  normalizeInstallerArgs,
  buildInstallerArgs,
  portableInstallerArgPath,
  splitCommandLineArgs,
  updatePackageLabel,
  updatePackageFileName,
  packageFileNameFromUrl,
  compareVersions,
  createUpdateDownloadSources,
  downloadFile,
  fileSha256,
  isStartupEnabled,
  setStartupEnabled,
  createStartupCommand,
  showWindowsToast,
  base64Utf8,
  openUrl,
  openPath,
  mimeType
};
