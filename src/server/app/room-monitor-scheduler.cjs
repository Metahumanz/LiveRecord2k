'use strict';

const MONITOR_FAST_CONFIRM_MS = 3 * 1000;
const MONITOR_PUSH_FALLBACK_MIN_MS = 30 * 1000;
const MONITOR_PUSH_FALLBACK_MAX_MS = 60 * 1000;
const MONITOR_DISCONNECTED_FALLBACK_MIN_MS = 10 * 1000;
const MONITOR_DISCONNECTED_FALLBACK_MAX_MS = 15 * 1000;

function getMonitorPollDelayMs(room, settings, pushConnected = false, now = Date.now()) {
  const configuredDelayMs = Math.max(1000, Number(settings?.pollIntervalSec || 15) * 1000);
  if (Number(room?.monitorFastPollUntil || 0) > now) {
    return MONITOR_FAST_CONFIRM_MS;
  }
  if (room?.lastError || !pushConnected) {
    return Math.max(
      MONITOR_DISCONNECTED_FALLBACK_MIN_MS,
      Math.min(MONITOR_DISCONNECTED_FALLBACK_MAX_MS, configuredDelayMs)
    );
  }
  return Math.max(MONITOR_PUSH_FALLBACK_MIN_MS, Math.min(MONITOR_PUSH_FALLBACK_MAX_MS, configuredDelayMs));
}

function jitterMonitorPollDelay(delayMs, random = Math.random) {
  const delay = Math.max(1000, Number(delayMs) || 1000);
  return Math.round(delay * (0.9 + random() * 0.2));
}

module.exports = {
  MONITOR_FAST_CONFIRM_MS,
  getMonitorPollDelayMs,
  jitterMonitorPollDelay
};
