'use strict';
const fs = require('node:fs/promises');
const { rmSync } = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { buildSceneGraph } = require('./scene-graph.cjs');
const { runCapturedProcess } = require('../shared/helpers.cjs');
const { runBounded } = require('../shared/bounded-work.cjs');
const caches = new Map();
let directoryPromise;
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
  await fs.writeFile(requestPath, JSON.stringify({ events, options, cachePath, outputPath,
    clipStart: runtime.clipStart, clipEnd: runtime.clipEnd }), { mode: 0o600 });
  try {
    const args = runtime.singleExecutable ? ['--scene-worker', requestPath]
      : ['--max-old-space-size=1024', runtime.entry, '--scene-worker', requestPath];
    const result = await runCapturedProcess(process.execPath, args, { timeoutMs: 180_000, onChild: runtime.onChild });
    if (result.status !== 0 || result.timedOut) throw new Error('Scene 后台布局失败：' + (result.stderr || '任务超时或被取消').slice(-2000));
    const graph = JSON.parse(await fs.readFile(outputPath, 'utf8'));
    const stat = await fs.stat(cachePath);
    caches.delete(cachePath); caches.set(cachePath, stat.size);
    let bytes = [...caches.values()].reduce((a, b) => a + b, 0);
    for (const [file, size] of caches) {
      if (caches.size <= 2 && bytes <= 512 * 1024 ** 2) break;
      await fs.rm(file, { force: true }); caches.delete(file); bytes -= size;
    }
    return graph;
  } finally {
    await Promise.all([fs.rm(requestPath, { force: true }), fs.rm(outputPath, { force: true })]);
  }
}
module.exports = { buildSceneGraphJob };
