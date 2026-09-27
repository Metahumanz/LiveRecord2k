'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const { atomicReplaceFile } = require('../recording/media-safety.cjs');

async function reuseVerifiedNativeVideo(source, target, metrics, options = {}) {
  if (metrics?.ptsBridge?.ok !== true || metrics?.outputStorageVerified !== true) {
    throw new Error('原生 Scene 视频未通过 PTS 或存储校验，不能直接封装。');
  }
  const from = path.resolve(source), to = path.resolve(target);
  if (from === to || path.dirname(from) !== path.dirname(to) ||
      !/\.mkv$/i.test(from) || !/\.mkv$/i.test(to)) {
    throw new Error('原生 Scene 视频复用必须在同一工作目录内使用独立 MKV。');
  }
  const stat = await fs.lstat(from);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 1024) {
    throw new Error('原生 Scene 视频未产生有效普通文件。');
  }
  // The helper already emitted a PTS-bearing, storage-verified Matroska file.
  // The caller still scans its timeline and validates the final audio mux.
  await atomicReplaceFile(from, to, options);
}
module.exports = { reuseVerifiedNativeVideo };
