'use strict';
const fs = require('node:fs/promises');
const { rmSync } = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { buildSceneGraph } = require('./scene-graph.cjs');
const { runCapturedProcess } = require('../shared/helpers.cjs');
const { runBounded } = require('../shared/bounded-work.cjs');
const { readGraphLines } = require('./scene-graph-io.cjs');
const caches = new Map();
let directoryPromise;
function sceneWorkerHeapMb(eventCount, memory = {}) {
  const mib = 1024 ** 2;
  const total = Number(memory.totalBytes ?? (process.constrainedMemory?.() || os.totalmem()));
  const available = Number(memory.availableBytes ?? (process.availableMemory?.() || os.freemem()));
  // Animated card objects plus clipping need more than the original 1 GiB
  // for long recordings. Bound the isolated worker by both event demand and
  // the machine/container budget, leaving room for the server and NVMM.
  const demand = Math.max(1024, Math.ceil((512 + Math.max(0, Number(eventCount) || 0) / 4) / 256) * 256);
  const budget = Math.max(256, Math.floor(Math.min(8192, total / mib / 4, available / mib / 2) / 256) * 256);
  return Math.min(demand, budget);
}
async function buildSceneGraphJob(events, options, runtime) {
  if (events.length < 256) return buildSceneGraph(events, options);
  const input = JSON.stringify({ events, options });
  const paths = [...new Set(Object.values(options.avatarAssets || {}).map(asset => asset.filePath).filter(Boolean))];
  const avatars = [];
  await runBounded(paths, 16, async (file, index) => {
    const stat = await fs.stat(file).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
    avatars[index] = [file, stat?.size, stat?.mtimeMs];
  });
  const key = crypto.createHash('sha256').update(input).update(JSON.stringify(avatars)).digest('hex');
  if (!directoryPromise) directoryPromise = fs.mkdtemp(path.join(os.tmpdir(), `br2k-scene-layout-${process.pid}-`)).then(directory => {
    // Only remove this process's private, generated cache after it exits.
    process.once('exit', () => { try { rmSync(directory, { recursive: true, force: true }); } catch {} });
    return directory;
  }).catch(error => { directoryPromise = null; throw error; });
  const directory = await directoryPromise;
  const cachePath = path.join(directory, key + '.jsonl');
  const requestPath = path.join(directory, crypto.randomUUID() + '.request.json');
  const outputPath = requestPath + '.result';
  await fs.writeFile(requestPath, JSON.stringify({ events, options, cachePath, outputPath, resultFormat: 'jsonl',
    clipStart: runtime.clipStart, clipEnd: runtime.clipEnd }), { mode: 0o600 });
  try {
    const heapMb = sceneWorkerHeapMb(events.length);
    const args = runtime.singleExecutable ? ['--scene-worker', requestPath]
      : [`--max-old-space-size=${heapMb}`, runtime.entry, '--scene-worker', requestPath];
    const result = await runCapturedProcess(process.execPath, args, { timeoutMs: 180_000, onChild: runtime.onChild });
    if (result.status !== 0 || result.timedOut) throw new Error('Scene 后台布局失败：' + (result.stderr || '任务超时或被取消').slice(-2000));
    // Do not hold a second whole JSON string alongside the parsed long graph.
    const graph = await readGraphLines(outputPath);
    const stat = await fs.stat(cachePath);
    const indexStat = await fs.stat(cachePath + '.index.json').catch(error => {
      if (error.code === 'ENOENT') return { size: 0 }; throw error;
    });
    caches.delete(cachePath); caches.set(cachePath, stat.size + indexStat.size);
    let bytes = [...caches.values()].reduce((a, b) => a + b, 0);
    for (const [file, size] of caches) {
      if (caches.size <= 2 && bytes <= 512 * 1024 ** 2) break;
      await fs.rm(file, { force: true }); caches.delete(file); bytes -= size;
      await fs.rm(file + '.index.json', { force: true });
    }
    return graph;
  } finally {
    await Promise.all([fs.rm(requestPath, { force: true }), fs.rm(outputPath, { force: true }),
      fs.rm(outputPath + '.index.json', { force: true })]);
  }
}
module.exports = { buildSceneGraphJob, sceneWorkerHeapMb };
