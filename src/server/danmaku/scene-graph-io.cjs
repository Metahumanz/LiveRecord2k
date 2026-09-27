'use strict';
const { createReadStream, createWriteStream } = require('node:fs');
const { createInterface } = require('node:readline');
const { once } = require('node:events');
const fs = require('node:fs/promises');
// Objects are not time-sorted: a block bounds all its objects, including
// long-lived avatars. The sidecar is derived data and must match this file.
const INDEX_BLOCK_OBJECTS = 512;
const fingerprint = stat => [stat.dev, stat.ino, stat.size, stat.mtimeMs];

async function writeGraph(file, graph, lines = false) {
  const stream = createWriteStream(file, { mode: 0o600 });
  let failure;
  stream.on('error', error => { failure = error; });
  let batch = '';
  let offset = 0, headerBytes = 0, block;
  const blocks = [];
  async function append(value) {
    if (failure) throw failure;
    batch += value;
    if (batch.length >= 65536) {
      if (!stream.write(batch)) await once(stream, 'drain');
      batch = '';
    }
  }
  try {
    const header = { ...graph }; delete header.objects;
    const headerText = lines ? JSON.stringify(header) + '\n' : JSON.stringify(header).slice(0, -1) + ',"objects":[';
    await append(headerText);
    if (lines) headerBytes = offset = Buffer.byteLength(headerText);
    for (let index = 0; index < graph.objects.length; index++) {
      const object = graph.objects[index];
      const text = (!lines && index ? ',' : '') + JSON.stringify(object) + (lines ? '\n' : '');
      if (lines) {
        if (index % INDEX_BLOCK_OBJECTS === 0) {
          block = { offset, bytes: 0, minStart: Number(object.start), maxEnd: Number(object.end) };
          blocks.push(block);
        }
        const bytes = Buffer.byteLength(text);
        block.bytes += bytes; offset += bytes;
        block.minStart = Math.min(block.minStart, Number(object.start));
        block.maxEnd = Math.max(block.maxEnd, Number(object.end));
      }
      await append(text);
    }
    if (!lines) await append(']}');
    const finished = once(stream, 'finish');
    stream.end(batch);
    await finished;
    if (failure) throw failure;
    if (lines) {
      const stat = await fs.stat(file);
      await fs.writeFile(file + '.index.json', JSON.stringify({ version: 1,
        fingerprint: fingerprint(stat), headerBytes, blocks }), { mode: 0o600 });
    }
  } catch (error) { stream.destroy(); throw error; }
}

async function readGraphLines(file, start, end, options = {}) {
  const handle = await fs.open(file, 'r');
  let graph;
  const clipped = Number.isFinite(start) && Number.isFinite(end);
  let readBytes = 0, selectedBlocks = 0, indexed = false;
  const consumeRange = async (first, last, headerOnly = false) => {
    if (last < first) return;
    const stream = createReadStream(file, { fd: handle.fd, autoClose: false, encoding: 'utf8',
      start: first, end: last, highWaterMark: 1024 * 1024 });
    const lines = createInterface({ input: stream, crlfDelay: Infinity });
    try {
      for await (const line of lines) {
        const value = JSON.parse(line);
        if (!graph) graph = { ...value, objects: [] };
        else if (!headerOnly && (!clipped || Number(value.end) >= start && Number(value.start) <= end)) graph.objects.push(value);
      }
      readBytes += last - first + 1;
    } finally { lines.close(); stream.pause(); }
  };
  try {
    const stat = await handle.stat();
    let index;
    if (clipped) {
      try {
        const indexStat = await fs.stat(file + '.index.json');
        if (indexStat.size > 4 * 1024 * 1024) throw new Error('Scene index exceeds limit');
        index = JSON.parse(await fs.readFile(file + '.index.json', 'utf8'));
        if (index.version !== 1 || JSON.stringify(index.fingerprint) !== JSON.stringify(fingerprint(stat)) ||
            !Number.isSafeInteger(index.headerBytes) || index.headerBytes < 1 || index.headerBytes > stat.size ||
            !Array.isArray(index.blocks)) throw new Error('Scene index fingerprint mismatch');
        let next = index.headerBytes;
        for (const block of index.blocks) {
          if (block.offset !== next || !Number.isSafeInteger(block.bytes) || block.bytes < 1 ||
              !Number.isFinite(block.minStart) || !Number.isFinite(block.maxEnd) || block.maxEnd < block.minStart) {
            throw new Error('Scene index has invalid ranges');
          }
          next += block.bytes;
        }
        if (next !== stat.size) throw new Error('Scene index has incomplete coverage');
      } catch { index = null; } // Old or stale derived indexes fall back to the complete stream.
    }
    if (index) {
      indexed = true;
      await consumeRange(0, index.headerBytes - 1, true);
      for (const block of index.blocks) {
        if (block.maxEnd < start || block.minStart > end) continue;
        selectedBlocks++;
        await consumeRange(block.offset, block.offset + block.bytes - 1);
      }
    } else {
      await consumeRange(0, stat.size - 1);
    }
    if (!graph) throw new Error('Scene 布局缓存为空。');
    if (JSON.stringify(fingerprint(await handle.stat())) !== JSON.stringify(fingerprint(stat))) {
      throw new Error('Scene 布局缓存读取期间发生变化。');
    }
    options.onReadStats?.({ indexed, readBytes, selectedBlocks, totalBytes: stat.size });
    return graph;
  } finally { await handle.close(); }
}
module.exports = { writeGraph, readGraphLines };
