'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { deriveClipPath } = require('../shared/helpers.cjs');

// Final clips are separate from source recordings. Discover published names
// on disk so refresh/restart also finds exports made before this index existed.
async function discoverExportedClips(root, recordings = [], { maxDepth = 4, limit = 160 } = {}) {
  const results = [];
  let directories = [path.resolve(root)];
  for (let depth = 0; directories.length && depth <= maxDepth; depth++) {
    const next = [];
    for (const directory of directories) {
      const entries = depth === 0 ? await fs.readdir(directory, { withFileTypes: true })
        : await fs.readdir(directory, { withFileTypes: true }).catch(() => []);
      for (const entry of entries) {
        if (entry.name.startsWith('.')) continue;
        const outputPath = path.join(directory, entry.name);
        if (entry.isDirectory()) { if (depth < maxDepth) next.push(outputPath); continue; }
        if (!entry.isFile()) continue;
        const match = entry.name.match(/^(.+)\.clip_(\d+(?:_\d+)?)-(\d+(?:_\d+)?)\.(clean|danmaku|danmaku-only)\.(mp4|mkv)$/i);
        if (!match || /\.tmp\.|\.finalizing\./i.test(entry.name)) continue;
        const startTime = Number(match[2].replace('_', '.'));
        const endTime = Number(match[3].replace('_', '.'));
        if (!(endTime > startTime)) continue;
        const stat = await fs.stat(outputPath).catch(() => null);
        if (!stat?.isFile() || stat.size < 32768) continue;
        const overlay = match[4].toLowerCase();
        const mode = overlay === 'clean' ? 'clean' : 'burn';
        const candidates = recordings.filter(recording => recording.cleanPath &&
          path.basename(deriveClipPath(recording.cleanPath, directory,
            overlay === 'danmaku-only' ? 'danmaku' : overlay === 'danmaku' ? 'danmaku-gift' : 'clean',
            startTime, endTime)).toLowerCase() === entry.name.toLowerCase());
        const owner = candidates.find(recording => path.dirname(recording.cleanPath) === directory) ||
          (candidates.length === 1 ? candidates[0] : null);
        results.push({ outputPath, cleanPath: owner?.cleanPath || '', mode,
          startTime, endTime, fileSize: stat.size, modifiedAt: stat.mtimeMs });
      }
    }
    directories = next;
  }
  return results.sort((a, b) => b.modifiedAt - a.modifiedAt).slice(0, limit);
}

module.exports = { discoverExportedClips };
