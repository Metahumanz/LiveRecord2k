'use strict';
const fs = require('node:fs/promises');
const cache = new Map();

async function scanFullMedia(ffmpegPath, filePath, options, run) {
  const stat = await fs.stat(filePath);
  const key = JSON.stringify([ffmpegPath, filePath, stat.dev, stat.ino, stat.size, stat.mtimeMs]);
  if (cache.has(key)) { options.onChild?.(null); return cache.get(key); }
  // Shared media can exceed 20 GiB. Scale the deadline to an explicit low
  // throughput budget instead of cutting every long scan off at 30 seconds.
  const timeoutMs = Math.max(Number(options.timeoutMs || 90_000), Math.ceil(stat.size / (16 * 1024 ** 2) * 1000) + 30_000);
  const timebases = new Map();
  const streams = new Map();
  let pending = '', errors = '', fatalError = '';
  let child;
  const consume = line => {
    let match = /^#tb\s+(\d+):\s*(\d+)\/(\d+)/.exec(line);
    if (match) { timebases.set(Number(match[1]), Number(match[2]) / Number(match[3])); return; }
    const parts = line.split(',');
    if (parts.length < 6 || line.startsWith('#')) return;
    const [index, dts, pts, duration] = parts.slice(0, 4).map(Number);
    const tb = timebases.get(index);
    if (!tb || ![index, dts, pts, duration].every(Number.isFinite)) return;
    const previous = streams.get(index) || { dtsEnd: 0, ptsEnd: 0, packets: 0 };
    previous.dtsEnd = Math.max(previous.dtsEnd, (dts + duration) * tb);
    previous.ptsEnd = Math.max(previous.ptsEnd, (pts + duration) * tb);
    previous.packets += 1;
    streams.set(index, previous);
  };
  const result = await run(ffmpegPath, ['-hide_banner', '-nostdin', '-loglevel', 'warning', '-i', filePath,
    '-map', '0:v:0', '-map', '0:a:0?', '-c', 'copy', '-f', 'framecrc', '-'], {
    timeoutMs, maxOutputBytes: 64 * 1024, onChild: next => { child = next; options.onChild?.(next); },
    onStdout: text => { pending += text; const lines = pending.split('\n'); pending = lines.pop(); for (const line of lines) consume(line.trim()); },
    onStderr: text => {
      errors = (errors + text).slice(-128 * 1024);
      if (!fatalError && /invalid as first byte of an EBML number|file ended prematurely|input\/output error|packet corrupt|invalid (?:data|nal)|error while decoding/i.test(errors)) {
        fatalError = errors.slice(-2000);
        child?.kill('SIGTERM');
      }
    }
  });
  if (pending) consume(pending.trim());
  if (result.timedOut && !fatalError) throw new Error('媒体完整性扫描超时：' + filePath);
  if (result.status !== 0 || !streams.get(0)?.packets || fatalError) {
    const error = new Error('媒体封装或存储完整性检查失败：' + (fatalError || errors.slice(-2000)));
    error.code = 'BR2K_MEDIA_CORRUPT'; throw error;
  }
  const value = { video: streams.get(0), audio: streams.get(1) || null,
    warnings: { exitCode: result.status, corruptPacketCount: (errors.match(/corrupt|invalid (?:data|nal)|error while decoding/gi) || []).length,
      nonMonotonicCount: (errors.match(/non[- ]monoton(?:ous|ically)|timestamp.*discontinuity/gi) || []).length, output: errors.slice(-2000) } };
  const after = await fs.stat(filePath);
  if (stat.size === after.size && stat.mtimeMs === after.mtimeMs) {
    if (cache.size >= 32) cache.delete(cache.keys().next().value);
    cache.set(key, value);
  }
  return value;
}
module.exports = { scanFullMedia };
