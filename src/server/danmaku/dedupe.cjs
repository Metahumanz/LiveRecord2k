'use strict';

const crypto = require('node:crypto');

const DEFAULT_TTL_MS = 30 * 60 * 1000;
const STABLE_ID_TTL_MS = 6 * 60 * 60 * 1000;
const DEFAULT_MAX_ENTRIES = 20_000;

function normalizeSourceTimestamp(value) {
  const raw = Number(value);
  if (!Number.isFinite(raw) || raw <= 0) return 0;
  // Bilibili uses both seconds and milliseconds in different commands.
  return raw < 10_000_000_000 ? Math.round(raw * 1000) : Math.round(raw);
}

function firstValue(...values) {
  return values.find((value) => value !== undefined && value !== null && String(value) !== '') || '';
}

function dataFromCommand(command) {
  const raw = command?.data;
  if (Array.isArray(raw)) return raw.find((item) => item && typeof item === 'object') || {};
  if (raw && typeof raw === 'object' && raw.data && typeof raw.data === 'object' && !Array.isArray(raw.data)) {
    return { ...raw, ...raw.data };
  }
  return raw && typeof raw === 'object' ? raw : {};
}

function sourceTimestampFromCommand(command, data = dataFromCommand(command)) {
  const info = Array.isArray(command?.info) ? command.info : [];
  const meta = info[9] && typeof info[9] === 'object' ? info[9] : {};
  return normalizeSourceTimestamp(
    firstValue(
      data.send_time,
      data.timestamp,
      data.ts,
      data.start_time,
      data.rnd,
      command?.timestamp,
      command?.ts,
      meta.ts,
      meta.timestamp
    )
  );
}

function sourceIdFromCommand(command, data = dataFromCommand(command)) {
  const info = Array.isArray(command?.info) ? command.info : [];
  const meta = info[9] && typeof info[9] === 'object' ? info[9] : {};
  return String(
    firstValue(
      data.id,
      data.msg_id,
      data.message_id,
      data.sc_id,
      data.tid,
      data.rnd,
      data.transaction_id,
      data.gift_id && data.tid ? `${data.gift_id}:${data.tid}` : '',
      command?.id,
      command?.tid,
      meta.id,
      meta.msg_id
    )
  ).trim();
}

function stableTextHash(value) {
  return crypto.createHash('sha1').update(String(value || '')).digest('hex').slice(0, 16);
}

function makeEventDedupeKeys(event, command) {
  const data = dataFromCommand(command);
  const uid = Number(event?.uid || data.uid || 0);
  const sourceId = String(event?.sourceId || sourceIdFromCommand(command, data) || '').trim();
  const sourceTimestamp = normalizeSourceTimestamp(event?.sourceTimestamp || sourceTimestampFromCommand(command, data));
  const type = String(event?.type || 'unknown');
  const keys = [];

  if (sourceId) {
    keys.push({ key: `${type}:id:${sourceId}`, stable: true });
  }

  if (type === 'guard') {
    const guardLevel = Number(event.guardLevel || data.guard_level || 0);
    const startTime = normalizeSourceTimestamp(firstValue(data.start_time, data.begin_time, sourceTimestamp));
    const count = Math.max(1, Number(event.count || data.num || 1));
    if (uid && guardLevel && startTime) {
      keys.push({ key: `guard:purchase:${uid}:${guardLevel}:${startTime}:${count}`, stable: true });
    }
    // USER_TOAST_MSG and GUARD_BUY do not always expose the same identifier;
    // this bounded fallback bridges the two actual protocol variants.
    if (uid && guardLevel && sourceTimestamp) {
      keys.push({ key: `guard:near:${uid}:${guardLevel}:${Math.floor(sourceTimestamp / 1000)}:${count}`, stable: false });
    }
  } else if (type === 'gift') {
    const giftId = String(firstValue(data.gift_id, data.giftId, event.giftId)).trim();
    const tid = String(firstValue(data.tid, data.rnd, event.sourceId)).trim();
    if (uid && giftId && tid) {
      keys.push({ key: `gift:${uid}:${giftId}:${tid}`, stable: true });
    } else if (uid && giftId && sourceTimestamp) {
      keys.push({ key: `gift:fallback:${uid}:${giftId}:${sourceTimestamp}:${Number(event.count || 1)}`, stable: false });
    }
  } else if (type === 'superchat') {
    const scId = String(firstValue(data.id, data.sc_id, data.message_id, sourceId)).trim();
    if (scId) {
      keys.push({ key: `superchat:${scId}`, stable: true });
    } else if (uid && sourceTimestamp) {
      keys.push({
        key: `superchat:fallback:${uid}:${sourceTimestamp}:${Number(event.price || 0)}:${stableTextHash(event.text)}`,
        stable: false
      });
    }
  } else if (type === 'danmaku' && sourceId) {
    keys.push({ key: `danmaku:${sourceId}`, stable: true });
  }

  return Array.from(new Map(keys.map((item) => [item.key, item])).values());
}

class SessionEventDeduper {
  constructor(options = {}) {
    this.defaultTtlMs = Math.max(1000, Number(options.defaultTtlMs || DEFAULT_TTL_MS));
    this.stableIdTtlMs = Math.max(this.defaultTtlMs, Number(options.stableIdTtlMs || STABLE_ID_TTL_MS));
    this.maxEntries = Math.max(100, Number(options.maxEntries || DEFAULT_MAX_ENTRIES));
    this.entries = new Map();
  }

  checkAndRemember(event, command, now = Date.now()) {
    this.prune(now);
    const keys = makeEventDedupeKeys(event, command);
    if (!keys.length) return { duplicate: false, keys: [] };
    const duplicate = keys.some(({ key }) => Number(this.entries.get(key) || 0) > now);
    if (duplicate) return { duplicate: true, keys: keys.map(({ key }) => key) };
    for (const item of keys) {
      this.entries.set(item.key, now + (item.stable ? this.stableIdTtlMs : this.defaultTtlMs));
    }
    this.trim();
    return { duplicate: false, keys: keys.map(({ key }) => key) };
  }

  prune(now = Date.now()) {
    for (const [key, expiresAt] of this.entries) {
      if (Number(expiresAt) <= now) this.entries.delete(key);
    }
  }

  trim() {
    while (this.entries.size > this.maxEntries) {
      const oldestKey = this.entries.keys().next().value;
      if (!oldestKey) break;
      this.entries.delete(oldestKey);
    }
  }
}

module.exports = {
  DEFAULT_TTL_MS,
  STABLE_ID_TTL_MS,
  normalizeSourceTimestamp,
  sourceTimestampFromCommand,
  sourceIdFromCommand,
  makeEventDedupeKeys,
  SessionEventDeduper
};
