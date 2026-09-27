'use strict';
const { createReadStream, createWriteStream } = require('node:fs');
const { createInterface } = require('node:readline');
const { once } = require('node:events');

async function writeGraph(file, graph, lines = false) {
  const stream = createWriteStream(file, { mode: 0o600 });
  let failure;
  stream.on('error', error => { failure = error; });
  let batch = '';
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
    await append(lines ? JSON.stringify(header) + '\n' : JSON.stringify(header).slice(0, -1) + ',"objects":[');
    for (let index = 0; index < graph.objects.length; index++) {
      await append((!lines && index ? ',' : '') + JSON.stringify(graph.objects[index]) + (lines ? '\n' : ''));
    }
    if (!lines) await append(']}');
    const finished = once(stream, 'finish');
    stream.end(batch);
    await finished;
    if (failure) throw failure;
  } catch (error) { stream.destroy(); throw error; }
}

async function readGraphLines(file, start, end) {
  const stream = createReadStream(file, { encoding: 'utf8' });
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  let graph;
  const clipped = Number.isFinite(start) && Number.isFinite(end);
  try {
    for await (const line of lines) {
      const value = JSON.parse(line);
      if (!graph) graph = { ...value, objects: [] };
      else if (!clipped || Number(value.end) >= start && Number(value.start) <= end) graph.objects.push(value);
    }
    if (!graph) throw new Error('Scene 布局缓存为空。');
    return graph;
  } finally { lines.close(); stream.destroy(); }
}
module.exports = { writeGraph, readGraphLines };
