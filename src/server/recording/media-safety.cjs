'use strict';

const fsp = require('node:fs/promises');
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const { pipeline } = require('node:stream/promises');

const DISK_WARNING_BYTES = 10 * 1024 * 1024 * 1024;
const DISK_HARD_MIN_BYTES = 2 * 1024 * 1024 * 1024;

async function atomicReplaceFile(temporaryPath, outputPath, options = {}) {
  const resolvedTemporary = path.resolve(temporaryPath);
  const resolvedOutput = path.resolve(outputPath);
  if (resolvedTemporary === resolvedOutput) throw new Error('临时输出不能与最终输出相同。');
  const backupPath = `${resolvedOutput}.previous-${crypto.randomUUID()}`;
  const partialPath = `${resolvedOutput}.publishing-${crypto.randomUUID()}`;
  let movedExisting = false;
  let publishPath = resolvedTemporary;
  const throwIfCancelled = () => {
    if (options.isCancelled?.()) throw Object.assign(new Error('媒体发布已取消'), { code: 'BR2K_MEDIA_CANCELLED' });
  };
  try {
    throwIfCancelled();
    const [source, destination] = await Promise.all([fsp.stat(resolvedTemporary), fsp.stat(path.dirname(resolvedOutput))]);
    if (source.dev !== destination.dev) {
      const controller = new AbortController();
      const timer = setInterval(() => { if (options.isCancelled?.()) controller.abort(); }, 100);
      try {
        await pipeline(fs.createReadStream(resolvedTemporary), fs.createWriteStream(partialPath, { flags: 'wx' }), { signal: controller.signal });
        if ((await fsp.stat(partialPath)).size !== source.size) throw new Error('媒体发布拷贝大小不一致；本地成片已保留。');
        throwIfCancelled();
        publishPath = partialPath;
      } catch (error) {
        throwIfCancelled();
        throw error;
      } finally { clearInterval(timer); }
    }
    const existing = await fsp.lstat(resolvedOutput).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
    if (existing) {
      if (!existing.isFile() || existing.isSymbolicLink()) throw new Error('最终输出不是可安全替换的普通文件。');
      await fsp.rename(resolvedOutput, backupPath);
      movedExisting = true;
    }
    await fsp.rename(publishPath, resolvedOutput);
    if (publishPath !== resolvedTemporary) await fsp.rm(resolvedTemporary, { force: true }).catch(() => {});
    await fsp.rm(backupPath, { force: true }).catch(() => {});
  } catch (error) {
    if (movedExisting) {
      const outputExists = await fsp.lstat(resolvedOutput).catch(() => null);
      if (!outputExists) await fsp.rename(backupPath, resolvedOutput).catch(() => {});
    }
    throw error;
  } finally {
    await fsp.rm(partialPath, { force: true }).catch(() => {});
  }
}

async function getDiskAvailability(targetPath) {
  const directory = path.extname(targetPath) ? path.dirname(targetPath) : targetPath;
  const stats = await fsp.statfs(directory);
  const freeBytes = Number(stats.bavail) * Number(stats.bsize);
  const totalBytes = Number(stats.blocks) * Number(stats.bsize);
  return { directory: path.resolve(directory), freeBytes, totalBytes, warning: freeBytes < DISK_WARNING_BYTES, hardBlocked: freeBytes < DISK_HARD_MIN_BYTES };
}

async function assertDiskSpace(targetPath, options = {}) {
  const availability = await getDiskAvailability(targetPath);
  const estimatedBytes = Math.max(0, Number(options.estimatedBytes || 0));
  const requiredBytes = Math.max(DISK_HARD_MIN_BYTES, estimatedBytes + DISK_HARD_MIN_BYTES);
  if (availability.freeBytes < requiredBytes) {
    const gib = bytes => (bytes / 1024 / 1024 / 1024).toFixed(2);
    throw Object.assign(new Error(`磁盘空间不足：${availability.directory} 剩余 ${gib(availability.freeBytes)} GiB，` +
      `本任务预计需要 ${gib(estimatedBytes)} GiB，另保留 ${gib(DISK_HARD_MIN_BYTES)} GiB，` +
      `合计需要 ${gib(requiredBytes)} GiB；已拒绝开始以保护已有录像。`), {
      code: 'BR2K_DISK_SPACE_INSUFFICIENT', targetPath: availability.directory,
      freeBytes: availability.freeBytes, estimatedBytes, requiredBytes
    });
  }
  return availability;
}

async function selectSceneMediaWorkspace(outputPath, sceneDirectory, options = {}) {
  const mediaPeakBytes = Math.max(0, Number(options.mediaPeakBytes) || 0);
  const scratchBytes = Math.max(0, Number(options.scratchBytes) || 0);
  await assertDiskSpace(outputPath, { estimatedBytes: options.outputBytes });
  try {
    await assertDiskSpace(sceneDirectory, { estimatedBytes: mediaPeakBytes + scratchBytes });
    return { mediaDirectory: sceneDirectory, separateMediaDirectory: false };
  } catch (error) {
    if (error.code !== 'BR2K_DISK_SPACE_INSUFFICIENT' || !options.allowDestinationMedia) throw error;
    const destination = path.dirname(outputPath);
    const [local, remote] = await Promise.all([fsp.stat(sceneDirectory), fsp.stat(destination)]);
    // Moving intermediates within the same filesystem cannot create space.
    if (local.dev === remote.dev) throw error;
    await assertDiskSpace(sceneDirectory, { estimatedBytes: scratchBytes });
    await assertDiskSpace(outputPath, { estimatedBytes: mediaPeakBytes });
    const mediaDirectory = await fsp.mkdtemp(path.join(destination, '.br2k-export-media-'));
    return { mediaDirectory, separateMediaDirectory: true, localSpaceError: error.message };
  }
}

module.exports = {
  DISK_WARNING_BYTES,
  DISK_HARD_MIN_BYTES,
  atomicReplaceFile,
  getDiskAvailability,
  assertDiskSpace,
  selectSceneMediaWorkspace
};
