const http = require('node:http');
const https = require('node:https');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const tls = require('node:tls');
const crypto = require('node:crypto');
const { spawn, spawnSync } = require('node:child_process');

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

const danmakuClient = require('../danmaku/client.cjs');
const danmakuAss = require('../danmaku/ass.cjs');
const ffmpegHelpers = require('../recording/ffmpeg.cjs');

async function requestBiliJsonWithCookies(url) {
  const response = await fetch(url, {
    headers: {
      Accept: 'application/json, text/plain, */*',
      Referer: 'https://passport.bilibili.com/',
      Origin: 'https://passport.bilibili.com',
      'User-Agent': USER_AGENT
    }
  });
  const text = await response.text();
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
    host === 'hdslb.com' ||
    host.endsWith('.hdslb.com') ||
    host === 'biliimg.com' ||
    host.endsWith('.biliimg.com')
  );
}

function getCookieValue(cookie, key) {
  for (const part of String(cookie || '').split(';')) {
    const trimmed = part.trim();
    const index = trimmed.indexOf('=');
    if (index > 0 && trimmed.slice(0, index) === key) {
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

function detectFfmpegCapabilities(ffmpegPath) {
  const encoderProbe = runFfmpegProbe(ffmpegPath, ['-hide_banner', '-encoders']);
  const hwaccelProbe = runFfmpegProbe(ffmpegPath, ['-hide_banner', '-hwaccels']);
  const encoderNames = parseFfmpegEncoderNames(encoderProbe.output);
  const hwaccels = parseFfmpegHwaccels(hwaccelProbe.output);
  const videoAdapters = detectVideoAdapters();
  const burnCodecs = [];
  const unavailableBurnCodecs = [];

  for (const candidate of BURN_CODEC_CANDIDATES) {
    if (!encoderNames.has(candidate.value)) {
      unavailableBurnCodecs.push({ ...candidate, reason: 'ffmpeg 未包含该编码器' });
      continue;
    }
    if (candidate.kind === 'hardware') {
      if (!hasVideoAdapterVendor(videoAdapters, candidate.vendor)) {
        unavailableBurnCodecs.push({ ...candidate, reason: '未检测到对应显卡' });
        continue;
      }
      const test = testFfmpegEncoder(ffmpegPath, candidate.value);
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

function runFfmpegProbe(ffmpegPath, args) {
  try {
    const result = spawnSync(ffmpegPath, args, {
      encoding: 'utf8',
      timeout: 8000,
      windowsHide: true
    });
    const output = `${result.stdout || ''}\n${result.stderr || ''}`;
    return {
      ok: result.status === 0 && !result.error,
      output,
      error: result.error ? result.error.message : result.status === 0 ? '' : compactLogLine(output)
    };
  } catch (error) {
    return { ok: false, output: '', error: error.message };
  }
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

function detectVideoAdapters() {
  if (process.platform !== 'win32') {
    return [];
  }
  const command =
    'Get-CimInstance Win32_VideoController | Select-Object Name,AdapterCompatibility,PNPDeviceID | ConvertTo-Json -Compress';
  for (const shell of ['powershell.exe', 'pwsh.exe']) {
    try {
      const result = spawnSync(shell, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', command], {
        encoding: 'utf8',
        timeout: 8000,
        windowsHide: true
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
  if (text.includes('nvidia') || text.includes('ven_10de')) {
    return 'nvidia';
  }
  if (text.includes('intel') || text.includes('ven_8086')) {
    return 'intel';
  }
  if (text.includes('amd') || text.includes('radeon') || text.includes('advanced micro devices') || text.includes('ven_1002')) {
    return 'amd';
  }
  return 'unknown';
}

function hasVideoAdapterVendor(adapters, vendor) {
  return adapters.some((adapter) => adapter.vendor === vendor);
}

function testFfmpegEncoder(ffmpegPath, codec) {
  try {
    const result = spawnSync(
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
        encoding: 'utf8',
        timeout: 10000,
        windowsHide: true
      }
    );
    if (result.status === 0 && !result.error) {
      return { ok: true, reason: '' };
    }
    const output = compactLogLine(`${result.stderr || ''}\n${result.stdout || ''}`);
    return {
      ok: false,
      reason: result.error?.code === 'ETIMEDOUT' ? '硬件编码测试超时' : output || `ffmpeg 退出码 ${result.status}`
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
  return path.join(parsed.dir, `${base}.${suffix}.${ext}`);
}

function deriveBurnedPath(filePath, overlayMode) {
  return deriveSiblingPath(filePath, normalizeBurnOverlayMode(overlayMode) === 'danmaku' ? 'danmaku-only' : 'danmaku');
}

function deriveClipPath(cleanPath, outputDir, mode, startTime, endTime) {
  const parsed = path.parse(cleanPath);
  const container = parsed.ext.replace(/^\./, '') || 'mp4';
  const base = parsed.name.replace(/\.clean$/i, '');
  const suffix = createClipSuffix(startTime, endTime, mode);
  return path.join(outputDir, `${base}.${suffix}.${container}`);
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

function runFfmpegJob(ffmpegPath, args, onStderr) {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpegPath, args, {
      windowsHide: true,
      stdio: ['ignore', 'ignore', 'pipe']
    });
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

function createFfmpegJobProgress({ kind, label, outputPath, durationSec, roomId }) {
  const now = Date.now();
  const duration = Number(durationSec || 0);
  return {
    id: `${kind}-${now}-${Math.random().toString(36).slice(2, 8)}`,
    kind,
    status: 'running',
    label,
    outputPath,
    roomId,
    startedAt: now,
    updatedAt: now,
    currentTimeSec: 0,
    durationSec: Number.isFinite(duration) && duration > 0 ? duration : 0,
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
  progress.currentTimeSec = Math.max(0, currentTimeSec);
  progress.percent = percent;
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
    if (Number(progress.durationSec || 0) > 0) {
      progress.currentTimeSec = Number(progress.durationSec || 0);
    }
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
  const fpsMatch = line.match(/,\s*([0-9]+(?:\.[0-9]+)?)\s*fps/i);
  const fps = fpsMatch ? Number(fpsMatch[1]) : 0;
  return {
    codec: codecMatch ? codecMatch[1].trim() : '',
    width: Number(sizeMatch[1]),
    height: Number(sizeMatch[2]),
    fps: Number.isFinite(fps) && fps > 0 ? fps : undefined
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
  if (process.env.PORT) {
    return clamp(Number(process.env.PORT), 1, 65535);
  }
  return clamp(Number(settingsPort || DEFAULT_PORT), 1, 65535);
}

function getAppRoot() {
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
  if (redirectCount > 8) {
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

function requestUrlBufferOnce(rawUrl, options = {}, redirectCount = 0) {
  const target = new URL(rawUrl);
  const proxy = getProxyForUrl(target);
  return proxy
    ? requestUrlViaHttpProxy(target, proxy, options, redirectCount)
    : requestUrlDirect(target, options, redirectCount);
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
        headers: options.headers || {}
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
    ['ECONNRESET', 'ETIMEDOUT', 'EAI_AGAIN', 'ECONNREFUSED', 'ENETUNREACH', 'EHOSTUNREACH', 'UND_ERR_SOCKET'].includes(code) ||
    message.includes('econnreset') ||
    message.includes('socket hang up') ||
    message.includes('timeout') ||
    message.includes('请求超时') ||
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

async function discoverRecordingFiles(outputDir) {
  let entries;
  try {
    entries = await fsp.readdir(outputDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const recordings = [];
  for (const entry of entries) {
    if (!entry.isFile()) {
      continue;
    }
    const name = entry.name;
    if (!/\.(?:clean|merged)\.(?:mp4|mkv)$/i.test(name)) {
      continue;
    }
    if (/\.tmp\.|\.finalizing\.|\.clip_/i.test(name)) {
      continue;
    }
    const cleanPath = path.join(outputDir, name);
    const stat = await fsp.stat(cleanPath).catch(() => null);
    if (!stat?.isFile()) {
      continue;
    }
    const danmakuPath = deriveSiblingPath(cleanPath, 'danmaku', 'jsonl');
    const eventCount = await countDanmakuLines(danmakuPath);
    const valid = stat.size >= 32 * 1024;
    recordings.push({
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
      fileSize: stat.size,
      valid,
      eventCount,
      capturedDanmakuCount: eventCount,
      rawDanmakuCount: eventCount,
      ignoredDanmakuCount: 0,
      danmakuCommandCounts: {}
    });
  }
  return recordings;
}

async function countDanmakuLines(filePath) {
  try {
    const text = await fsp.readFile(filePath, 'utf8');
    return text.split(/\r?\n/).filter(Boolean).length;
  } catch {
    return 0;
  }
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
    resolve(requestUrlBuffer(new URL(location, target).toString(), options, redirectCount + 1));
    return;
  }
  const chunks = [];
  const totalBytes = Number(response.headers['content-length'] || 0);
  let receivedBytes = 0;
  response.on('data', (chunk) => {
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
    resolve(body);
  });
  response.on('error', reject);
}

function getProxyForUrl(target) {
  if (shouldBypassProxy(target.hostname)) {
    return null;
  }
  const envProxy =
    target.protocol === 'https:'
      ? process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy
      : process.env.HTTP_PROXY || process.env.http_proxy;
  const proxySource = envProxy || getWindowsProxyForUrl(target) || '';
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

function getWindowsProxyForUrl(target) {
  if (process.platform !== 'win32') {
    return '';
  }
  const winInetProxy = getWinInetProxyServer();
  if (winInetProxy) {
    return selectProxyServer(winInetProxy, target.protocol);
  }
  const winHttpProxy = getWinHttpProxyServer();
  return winHttpProxy ? selectProxyServer(winHttpProxy, target.protocol) : '';
}

function getWinInetProxyServer() {
  const key = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings';
  const enabled = spawnSync('reg.exe', ['query', key, '/v', 'ProxyEnable'], {
    encoding: 'utf8',
    windowsHide: true
  });
  if (enabled.status !== 0 || !/ProxyEnable\s+REG_DWORD\s+0x1/i.test(enabled.stdout || '')) {
    return '';
  }
  const server = spawnSync('reg.exe', ['query', key, '/v', 'ProxyServer'], {
    encoding: 'utf8',
    windowsHide: true
  });
  if (server.status !== 0) {
    return '';
  }
  return parseRegistryValue(server.stdout, 'ProxyServer');
}

function getWinHttpProxyServer() {
  const result = spawnSync('netsh.exe', ['winhttp', 'show', 'proxy'], {
    encoding: 'utf8',
    windowsHide: true
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
      onRetry: options.onRetry
    });
    return body.toString('utf8');
  }
  const filePath = value.startsWith('file://') ? new URL(value) : path.resolve(APP_ROOT, value);
  return fsp.readFile(filePath, 'utf8');
}

function isDefaultUpdateSource(source) {
  const normalized = String(source || '').trim().replace(/\/+$/, '');
  const fallback = String(DEFAULT_UPDATE_MANIFEST_URL || '').trim().replace(/\/+$/, '');
  return normalized === fallback || normalized.endsWith('/releases/latest/download/update.json');
}

function normalizeUpdateManifest(payload) {
  if (!payload || typeof payload !== 'object') {
    throw new Error('更新源不是有效 JSON。');
  }
  if (Array.isArray(payload.assets)) {
    const installerAsset = payload.assets.find((asset) => isInstallerFileName(asset.name || asset.browser_download_url || ''));
    const zipAsset = payload.assets.find((asset) => /\.zip$/i.test(asset.name || asset.browser_download_url || ''));
    const packageAsset = installerAsset || zipAsset;
    return {
      version: normalizeVersion(payload.version || payload.tag_name || ''),
      tagName: payload.tag_name || '',
      packageType: installerAsset ? 'installer' : 'portable',
      packageUrl: packageAsset?.browser_download_url || packageAsset?.url || '',
      sha256: payload.sha256 || '',
      releaseUrl: payload.html_url || '',
      notes: payload.body || ''
    };
  }
  const files = Array.isArray(payload.files) ? payload.files : [];
  const installerFile =
    files.find((file) => String(file.kind || file.type || '').toLowerCase() === 'installer') ||
    files.find((file) => isInstallerFileName(file.name || file.url || ''));
  const zipFile =
    files.find((file) => String(file.kind || file.type || '').toLowerCase() === 'portable') ||
    files.find((file) => /\.zip$/i.test(file.name || file.url || ''));
  const packageFile = installerFile || zipFile;
  const packageUrl =
    payload.installerUrl ||
    payload.packageUrl ||
    payload.url ||
    payload.downloadUrl ||
    packageFile?.url ||
    '';
  const packageType = normalizeUpdatePackageType(payload.packageType || packageFile?.kind || packageFile?.type || packageUrl);
  return {
    version: normalizeVersion(payload.version || payload.tagName || ''),
    tagName: payload.tagName || payload.tag_name || '',
    packageType,
    packageUrl,
    sha256:
      payload.sha256 ||
      (packageType === 'installer' ? payload.installerSha256 : payload.portableSha256) ||
      packageFile?.sha256 ||
      '',
    installerArgs: payload.installerArgs,
    releaseUrl: payload.releaseUrl || payload.htmlUrl || '',
    notes: payload.notes || payload.body || ''
  };
}

function normalizeVersion(value) {
  return String(value || '').trim().replace(/^v/i, '');
}

function normalizeUpdatePackageType(value) {
  const text = String(value || '').trim().toLowerCase();
  if (text === 'installer' || isInstallerFileName(text)) {
    return 'installer';
  }
  return 'portable';
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
  return ['/S'];
}

function buildInstallerArgs(manifest, paths) {
  const args = normalizeInstallerArgs(manifest);
  if (!args.some((arg) => String(arg).toUpperCase() === '/S')) {
    args.unshift('/S');
  }
  args.push(`/STATUS=${portableInstallerArgPath(paths.statusPath)}`);
  args.push(`/LOG=${portableInstallerArgPath(paths.logPath)}`);
  args.push(`/PACKAGE=${portableInstallerArgPath(paths.packagePath)}`);
  return args;
}

function portableInstallerArgPath(filePath) {
  return path.resolve(String(filePath || '')).replace(/\\/g, '/');
}

function createElevatedInstallerLaunchScript(packagePath, args) {
  const encodedArgs = args.map((arg) => base64Utf8(arg));
  return `
$ErrorActionPreference = 'Stop'
function DecodeText([string]$value) {
  [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($value))
}
$installer = DecodeText '${base64Utf8(packagePath)}'
$arguments = @(${encodedArgs.map((arg) => `(DecodeText '${arg}')`).join(', ')})
$argumentLine = ($arguments | ForEach-Object { '"' + ($_ -replace '"', '\"') + '"' }) -join ' '
Start-Process -FilePath $installer -ArgumentList $argumentLine -Verb RunAs
`;
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
  return isInstallerUpdatePackage(manifest, manifest?.packageUrl) ? '安装器' : '更新包';
}

function updatePackageFileName(manifest) {
  const version = sanitizeFilename(manifest?.version || 'latest');
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

function compareVersions(a, b) {
  const left = normalizeVersion(a).split(/[.-]/).map((part) => Number(part) || 0);
  const right = normalizeVersion(b).split(/[.-]/).map((part) => Number(part) || 0);
  const length = Math.max(left.length, right.length, 3);
  for (let index = 0; index < length; index += 1) {
    const diff = (left[index] || 0) - (right[index] || 0);
    if (diff !== 0) {
      return diff;
    }
  }
  return 0;
}

async function downloadFile(url, targetPath, onProgress) {
  if (!/^https?:\/\//i.test(String(url || ''))) {
    throw new Error('更新包下载地址无效。');
  }
  const tmpPath = `${targetPath}.tmp`;
  await fsp.rm(tmpPath, { force: true });
  const body = await requestUrlBuffer(url, {
    headers: {
      Accept: 'application/x-msdownload, application/vnd.microsoft.portable-executable, application/zip, application/octet-stream, */*',
      'User-Agent': `${APP_NAME}/${APP_VERSION}`
    },
    onProgress,
    onRetry: ({ attempt, maxAttempts, error }) => {
      onProgress?.({
        retrying: true,
        attempt,
        maxAttempts,
        error,
        receivedBytes: 0,
        totalBytes: 0,
        done: false
      });
    }
  });
  await fsp.writeFile(tmpPath, body);
  await fsp.rm(targetPath, { force: true });
  await fsp.rename(tmpPath, targetPath);
}

async function fileSha256(filePath) {
  const hash = crypto.createHash('sha256');
  hash.update(await fsp.readFile(filePath));
  return hash.digest('hex');
}

function isStartupEnabled() {
  if (process.platform !== 'win32') {
    return false;
  }
  const result = spawnSync('reg.exe', ['query', RUN_KEY, '/v', APP_NAME], {
    encoding: 'utf8',
    windowsHide: true
  });
  return result.status === 0;
}

function setStartupEnabled(enabled) {
  const command = createStartupCommand();
  const args = enabled
    ? ['add', RUN_KEY, '/v', APP_NAME, '/t', 'REG_SZ', '/d', command, '/f']
    : ['delete', RUN_KEY, '/v', APP_NAME, '/f'];
  const result = spawnSync('reg.exe', args, {
    encoding: 'utf8',
    windowsHide: true
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
      '.mkv': 'video/x-matroska'
    }[ext] || 'application/octet-stream'
  );
}

module.exports = {
  ...danmakuClient,
  ...danmakuAss,
  ...ffmpegHelpers,
  requestBiliJsonWithCookies,
  getSetCookieHeaders,
  splitSetCookieHeader,
  mergeCookieString,
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
  runFfmpegProbe,
  parseFfmpegEncoderNames,
  parseFfmpegHwaccels,
  detectVideoAdapters,
  detectVideoAdapterVendor,
  hasVideoAdapterVendor,
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
  isHevcCodec,
  formatTimestamp,
  formatDurationSeconds,
  streamScore,
  displayCodecName,
  escapeFilterPath,
  compactLogLine,
  parseFfmpegVideoInfo,
  buildActualQualityWarning,
  clamp,
  roomLabel,
  guardName,
  getRuntimePort,
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
  normalizeUpdatePackageType,
  isInstallerFileName,
  isInstallerUpdatePackage,
  normalizeInstallerArgs,
  buildInstallerArgs,
  portableInstallerArgPath,
  createElevatedInstallerLaunchScript,
  splitCommandLineArgs,
  updatePackageLabel,
  updatePackageFileName,
  packageFileNameFromUrl,
  compareVersions,
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
