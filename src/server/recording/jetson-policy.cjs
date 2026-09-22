'use strict';

const NATIVE_EARLY_FALLBACK_SEC = 5;

function shouldAbortCommittedJetsonNativeFallback({ committed, processedMediaSeconds }) {
  return Boolean(committed) && Number(processedMediaSeconds) > NATIVE_EARLY_FALLBACK_SEC;
}

function createCommittedJetsonNativeRuntimeError(processedMediaSeconds, cause) {
  const processed = Math.max(0, Number(processedMediaSeconds) || 0);
  const causeMessage = String(cause?.message || cause || '未知错误').replace(/\s+/g, ' ').trim();
  const runtimeError = new Error(
    `CUDA/NVMM 已处理 ${processed.toFixed(1)}s 后失败。为避免从头重复处理，已停止导出：${causeMessage.slice(0, 240)}`
  );
  runtimeError.code = 'BR2K_NATIVE_RUNTIME_FAILED_AFTER_COMMIT';
  runtimeError.processedMediaSeconds = processed;
  return runtimeError;
}

function decideJetsonNativeFailure({ committed, processedMediaSeconds, cancelled }) {
  if (cancelled) return 'cancel';
  return shouldAbortCommittedJetsonNativeFallback({ committed, processedMediaSeconds })
    ? 'abort'
    : 'fallback';
}

module.exports = {
  NATIVE_EARLY_FALLBACK_SEC,
  shouldAbortCommittedJetsonNativeFallback,
  createCommittedJetsonNativeRuntimeError,
  decideJetsonNativeFailure
};
