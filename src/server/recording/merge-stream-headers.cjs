'use strict';

const fs = require('node:fs/promises');
const { runCapturedProcess } = require('../shared/helpers.cjs');
const cache = new Map();

// A recording can change its SPS/PPS without changing the container's initial
// codec metadata. Timestamp health alone cannot admit such a file for reuse:
// seeking past the one in-band update restores the obsolete container headers.
async function probeMergeStreamHeaders(ffmpegPath, filePath, videoInfo, options = {}) {
  if (!/h264|avc/i.test(videoInfo?.codec || '')) return null;
  const stat = await fs.stat(filePath);
  const cacheKey = JSON.stringify([ffmpegPath, filePath, stat.dev, stat.ino, stat.size, stat.mtimeMs]);
  if (cache.has(cacheKey)) { options.onChild?.(null); return { ...cache.get(cacheKey) }; }
  const sets = { sps: new Set(), pps: new Set() };
  let pending = '', kind = '', fields = [], errors = '';
  const flush = () => {
    if (kind && fields.length) sets[kind].add(fields.join(';'));
    fields = [];
  };
  const consume = line => {
    const header = /\[trace_headers @ [^\]]+\]\s+(Sequence|Picture) Parameter Set\s*$/.exec(line);
    if (header) { flush(); kind = header[1] === 'Sequence' ? 'sps' : 'pps'; return; }
    const field = /\[trace_headers @ [^\]]+\]\s+\d+\s+(\S+)\s+[01]+\s+=\s+(-?\d+)\s*$/.exec(line);
    if (field && kind) { fields.push(`${field[1]}=${field[2]}`); return; }
    if (/\[trace_headers @ [^\]]+\]/.test(line)) { flush(); kind = ''; }
    if (/error|invalid|failed|corrupt/i.test(line)) errors = (errors + line + '\n').slice(-2000);
  };
  const result = await runCapturedProcess(ffmpegPath, ['-hide_banner', '-nostdin', '-loglevel', 'info', '-i', filePath,
    '-map', '0:v:0', '-an', '-c:v', 'copy', '-bsf:v', 'filter_units=pass_types=7|8,trace_headers', '-f', 'null', '-'], {
    timeoutMs: Math.max(Number(options.timeoutMs || 30000), Math.ceil(stat.size / (16 * 1024 ** 2) * 1000) + 30000),
    maxOutputBytes: 4096, onChild: options.onChild,
    onStderr: text => { pending += text; const lines = pending.split('\n'); pending = lines.pop(); for (const line of lines) consume(line.trim()); }
  });
  if (pending) consume(pending.trim());
  flush();
  if (result.status !== 0 || result.timedOut || errors || !sets.sps.size || !sets.pps.size) {
    throw new Error('无法确认分段码流参数稳定：' + (errors || result.stderr || filePath));
  }
  const value = { parameterSetsStable: sets.sps.size === 1 && sets.pps.size === 1,
    spsVariants: sets.sps.size, ppsVariants: sets.pps.size };
  const after = await fs.stat(filePath);
  if (after.size === stat.size && after.mtimeMs === stat.mtimeMs) {
    if (cache.size >= 160) cache.delete(cache.keys().next().value);
    cache.set(cacheKey, value);
  }
  return { ...value };
}

module.exports = { probeMergeStreamHeaders };
