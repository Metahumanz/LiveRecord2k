'use strict';

const fsp = require('node:fs/promises');
const path = require('node:path');

const DISK_WARNING_BYTES = 10 * 1024 * 1024 * 1024;
const DISK_HARD_MIN_BYTES = 2 * 1024 * 1024 * 1024;

async function atomicReplaceFile(temporaryPath, outputPath) {
  const resolvedTemporary = path.resolve(temporaryPath);
  const resolvedOutput = path.resolve(outputPath);
  if (resolvedTemporary === resolvedOutput) throw new Error('临时输出不能与最终输出相同。');
  const backupPath = `${resolvedOutput}.previous-${process.pid}`;
  let movedExisting = false;
  try {
    const existing = await fsp.lstat(resolvedOutput).catch(() => null);
    if (existing) {
      if (!existing.isFile() || existing.isSymbolicLink()) throw new Error('最终输出不是可安全替换的普通文件。');
      await fsp.rm(backupPath, { force: true });
      await fsp.rename(resolvedOutput, backupPath);
      movedExisting = true;
    }
    await fsp.rename(resolvedTemporary, resolvedOutput);
    await fsp.rm(backupPath, { force: true });
  } catch (error) {
    if (movedExisting) {
      const outputExists = await fsp.lstat(resolvedOutput).catch(() => null);
      if (!outputExists) await fsp.rename(backupPath, resolvedOutput).catch(() => {});
    }
    throw error;
  }
}

async function getDiskAvailability(targetPath) {
  const directory = path.extname(targetPath) ? path.dirname(targetPath) : targetPath;
  const stats = await fsp.statfs(directory);
  const freeBytes = Number(stats.bavail) * Number(stats.bsize);
  const totalBytes = Number(stats.blocks) * Number(stats.bsize);
  return { freeBytes, totalBytes, warning: freeBytes < DISK_WARNING_BYTES, hardBlocked: freeBytes < DISK_HARD_MIN_BYTES };
}

async function assertDiskSpace(targetPath, options = {}) {
  const availability = await getDiskAvailability(targetPath);
  const estimatedBytes = Math.max(0, Number(options.estimatedBytes || 0));
  const requiredBytes = Math.max(DISK_HARD_MIN_BYTES, estimatedBytes + DISK_HARD_MIN_BYTES);
  if (availability.freeBytes < requiredBytes) {
    const gib = (availability.freeBytes / 1024 / 1024 / 1024).toFixed(2);
    throw new Error(`磁盘剩余 ${gib} GiB，低于媒体任务安全阈值，已拒绝开始以保护已有录像。`);
  }
  return availability;
}

module.exports = {
  DISK_WARNING_BYTES,
  DISK_HARD_MIN_BYTES,
  atomicReplaceFile,
  getDiskAvailability,
  assertDiskSpace
};
