'use strict';
const fs = require('node:fs/promises');

function isMuxPermissionFailure(text) {
  return /(?:permission denied|eacces|access is denied|error\s*=\s*-13)/i.test(String(text || ''));
}

async function runSceneAudioMuxWithRetry({
  run, outputPath, sharedOutput = false, onStderr, onRetry, isCancelled,
  delay = (ms) => new Promise(resolve => setTimeout(resolve, ms))
}) {
  for (let attempt = 0; attempt < 2; attempt++) {
    let failureTail = '';
    try {
      return await run((line) => {
        failureTail = (failureTail + String(line || '')).slice(-8192);
        onStderr?.(line);
      });
    } catch (error) {
      if (isCancelled?.() || error?.code === 'BR2K_MEDIA_CANCELLED') throw error;
      const accessDenied = isMuxPermissionFailure(`${failureTail}\n${error?.message || ''}`);
      if (attempt === 0 && sharedOutput && accessDenied) {
        await fs.rm(outputPath, { force: true });
        onRetry?.();
        await delay(3000);
        if (isCancelled?.()) {
          const cancelled = new Error('Scene Graph 导出已取消。');
          cancelled.code = 'BR2K_MEDIA_CANCELLED';
          throw cancelled;
        }
        continue;
      }
      if (accessDenied) {
        const storageError = new Error('音视频封装时共享盘拒绝访问；已停止，烧录视频将保留供仅重试封装。');
        storageError.code = 'BR2K_SCENE_MUX_STORAGE_DENIED';
        storageError.cause = error;
        throw storageError;
      }
      throw error;
    }
  }
}

module.exports = { isMuxPermissionFailure, runSceneAudioMuxWithRetry };
