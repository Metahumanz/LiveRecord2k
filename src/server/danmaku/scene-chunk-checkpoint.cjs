'use strict';
const fs = require('node:fs/promises');
const { createReadStream } = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

async function digestFile(file, isCancelled) {
  const hash = crypto.createHash('sha256');
  for await (const bytes of createReadStream(file, { highWaterMark: 1024 * 1024 })) {
    if (isCancelled?.()) throw Object.assign(new Error('导出已取消。'), { code: 'BR2K_MEDIA_CANCELLED' });
    hash.update(bytes);
  }
  return hash.digest('hex');
}

// Completed windows survive a failed later window and a service restart.
// A different source, render graph, asset, or encoder starts a different cache.
async function openSceneChunkCheckpoint({ root, cleanPath, finalOutputPath, graph, settings, isCancelled, onVerify }) {
  const source = await fs.stat(cleanPath);
  const assets = await Promise.all((graph.assets || []).map(async asset => {
    const file = asset.filePath || asset.path;
    if (!file) return asset;
    const stat = await fs.stat(file);
    return { ...asset, size: stat.size, mtimeMs: stat.mtimeMs };
  }));
  const identity = { revision: 2, cleanPath, sourceSize: source.size, sourceMtimeMs: source.mtimeMs,
    finalOutputPath, settings, canvas: graph.canvas, timeline: graph.timeline, objects: graph.objects, assets };
  const key = crypto.createHash('sha256').update(JSON.stringify(identity)).digest('hex');
  const directory = path.join(root, key);
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const manifestPath = path.join(directory, 'checkpoint.json');
  const outputDirectory = path.dirname(finalOutputPath);
  const safePath = file => {
    const relative = path.relative(outputDirectory, file);
    return path.isAbsolute(file) && (path.dirname(file) === directory ||
      relative && !relative.startsWith('..') && !path.isAbsolute(relative) &&
      /^\.br2k-export-media-[^/\\]+$/.test(path.basename(path.dirname(file)))) &&
      /^scene-chunk-\d+\.mkv$/.test(path.basename(file));
  };
  let saved;
  try { saved = JSON.parse(await fs.readFile(manifestPath, 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error; }
  const chunks = [];
  if (saved?.key === key && Array.isArray(saved.chunks)) {
    for (const [index, chunk] of saved.chunks.entries()) {
      if (!safePath(chunk.path) || !(chunk.duration > 0) || !/^[a-f0-9]{64}$/.test(chunk.sha256 || '')) break;
      onVerify?.(index + 1, saved.chunks.length);
      try {
        const stat = await fs.lstat(chunk.path);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== chunk.size ||
            await digestFile(chunk.path, isCancelled) !== chunk.sha256) break;
      } catch (error) { if (error.code === 'BR2K_MEDIA_CANCELLED') throw error; break; }
      chunks.push(chunk);
    }
  }
  const save = async () => {
    const temporary = manifestPath + '.tmp';
    await fs.writeFile(temporary, JSON.stringify({ version: 1, key, chunks }, null, 2), { mode: 0o600 });
    await fs.rename(temporary, manifestPath);
  };
  await save();
  return {
    directory, manifestPath, chunks,
    async append(file, duration, sha256) {
      if (!safePath(file)) throw new Error('烧录分段不在可恢复工作目录内。');
      const stat = await fs.lstat(file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 1024) throw new Error('烧录分段文件无效。');
      chunks.push({ path: file, duration, size: stat.size, sha256: sha256 || await digestFile(file, isCancelled) });
      await save();
    },
    async discard() {
      for (const chunk of chunks) if (safePath(chunk.path)) {
        await fs.rm(chunk.path, { force: true });
        if (path.dirname(chunk.path) !== directory) await fs.rmdir(path.dirname(chunk.path)).catch(() => {});
      }
      await fs.rm(manifestPath, { force: true });
      await fs.rmdir(directory).catch(() => {});
    }
  };
}
module.exports = { openSceneChunkCheckpoint, digestFile };
