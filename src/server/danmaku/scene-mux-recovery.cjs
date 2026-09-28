'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');

const ID_PATTERN = /^scene-mux-[0-9]+-[0-9]+\.json$/;

function recoveryFile(directory, id) {
  if (!ID_PATTERN.test(String(id || ''))) throw new Error('封装恢复任务编号无效。');
  return path.join(directory, id);
}

async function readRecovery(directory, id) {
  const file = recoveryFile(directory, id);
  const entry = await fs.lstat(file);
  if (!entry.isFile() || entry.size > 64 * 1024) throw new Error('封装恢复清单无效。');
  const data = JSON.parse(await fs.readFile(file, 'utf8'));
  if (data.version !== 1 || !Array.isArray(data.chunkPaths) || !data.chunkPaths.length ||
      data.chunkPaths.length > 1000 || !Array.isArray(data.chunkSizes) ||
      data.chunkSizes.length !== data.chunkPaths.length || !Array.isArray(data.chunkDurations) ||
      data.chunkDurations.length !== data.chunkPaths.length ||
      !['mp4', 'mkv'].includes(data.outputContainer) ||
      !Number.isFinite(data.duration) || data.duration <= 0 ||
      !Number.isFinite(data.startTime) || data.startTime < 0) {
    throw new Error('封装恢复清单不完整。');
  }
  for (const key of ['cleanPath', 'finalOutputPath', 'outputPath', 'concatPath']) {
    if (!path.isAbsolute(data[key] || '')) throw new Error(`封装恢复清单的 ${key} 路径无效。`);
  }
  if (data.chunkPaths.some(filePath => !path.isAbsolute(filePath || '') || !/\.mkv$/i.test(filePath))) {
    throw new Error('封装恢复清单的视频分段路径无效。');
  }
  return { ...data, id, manifestPath: file };
}

async function checkRecoveryFiles(data) {
  try {
    const source = await fs.lstat(data.cleanPath);
    if (!source.isFile() || source.size !== data.sourceSize ||
        Math.abs(source.mtimeMs - data.sourceMtimeMs) > 2) return '源录像已经变化或不可用。';
    for (let i = 0; i < data.chunkPaths.length; i++) {
      const chunk = await fs.lstat(data.chunkPaths[i]);
      if (!chunk.isFile() || chunk.size < 1024 || chunk.size !== data.chunkSizes[i]) {
        return `烧录视频分段 ${i + 1} 已变化或不可用。`;
      }
    }
    try {
      await fs.lstat(data.finalOutputPath);
      return '目标成片已存在，请先检查成片。';
    } catch (error) {
      if (error.code !== 'ENOENT') return '目标成片状态无法确认。';
    }
    return '';
  } catch {
    return '源录像或烧录视频文件已丢失。';
  }
}

async function listRecoveries(directory, limit = 50) {
  let names;
  try { names = await fs.readdir(directory); } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
  const selected = names.filter(name => ID_PATTERN.test(name)).sort().reverse().slice(0, limit);
  return Promise.all(selected.map(async id => {
    try {
      const data = await readRecovery(directory, id);
      return { id, createdAt: data.createdAt, cleanPath: data.cleanPath,
        outputPath: data.finalOutputPath, durationSec: data.duration,
        videoCount: data.chunkPaths.length, unavailableReason: await checkRecoveryFiles(data) };
    } catch (error) {
      return { id, unavailableReason: `恢复清单无法读取：${error.message}` };
    }
  }));
}

module.exports = { recoveryFile, readRecovery, checkRecoveryFiles, listRecoveries };
