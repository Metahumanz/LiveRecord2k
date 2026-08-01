const crypto = require('node:crypto');
const { promisify } = require('node:util');

const scrypt = promisify(crypto.scrypt);
const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_KEY_LENGTH = 32;
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const FAILURE_WINDOW_MS = 5 * 60 * 1000;
const FAILURE_LIMIT = 5;
const LOCKOUT_MS = 5 * 60 * 1000;

async function hashAccessPassword(password) {
  const value = String(password || '');
  if (value.length < 8) {
    throw new Error('访问密码至少需要 8 个字符。');
  }
  const salt = crypto.randomBytes(16);
  const derived = await scrypt(value, salt, SCRYPT_KEY_LENGTH, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
    maxmem: 64 * 1024 * 1024
  });
  return `scrypt$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$${salt.toString('base64url')}$${Buffer.from(derived).toString(
    'base64url'
  )}`;
}

async function verifyAccessPassword(password, encodedHash) {
  const parts = String(encodedHash || '').split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') {
    return false;
  }
  const [, nText, rText, pText, saltText, hashText] = parts;
  const n = Number(nText);
  const r = Number(rText);
  const p = Number(pText);
  if (!Number.isFinite(n) || !Number.isFinite(r) || !Number.isFinite(p) || n <= 1 || r <= 0 || p <= 0) {
    return false;
  }
  let salt;
  let expected;
  try {
    salt = Buffer.from(saltText, 'base64url');
    expected = Buffer.from(hashText, 'base64url');
  } catch {
    return false;
  }
  if (!salt.length || !expected.length || expected.length > 128) {
    return false;
  }
  try {
    const actual = Buffer.from(
      await scrypt(String(password || ''), salt, expected.length, {
        N: n,
        r,
        p,
        maxmem: 64 * 1024 * 1024
      })
    );
    return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

class AccessAuthManager {
  constructor(options = {}) {
    this.sessionTtlMs = Number(options.sessionTtlMs || SESSION_TTL_MS);
    this.sessions = new Map();
    this.failures = new Map();
    this.environmentPasswordHash = '';
  }

  async initFromEnvironment() {
    const password = String(process.env.BILI_RECORD_AUTH_PASSWORD || '');
    this.environmentPasswordHash = password ? await hashAccessPassword(password) : '';
  }

  getPasswordHash(settings) {
    return this.environmentPasswordHash || String(settings?.accessPasswordHash || '');
  }

  isConfigured(settings) {
    return Boolean(this.getPasswordHash(settings));
  }

  async login({ username, password, settings, remoteKey }) {
    const now = Date.now();
    const key = String(remoteKey || 'unknown');
    const failure = this.getActiveFailure(key, now);
    if (failure?.blockedUntil > now) {
      const error = new Error(`登录尝试过多，请在 ${Math.ceil((failure.blockedUntil - now) / 1000)} 秒后重试。`);
      error.statusCode = 429;
      throw error;
    }

    const passwordHash = this.getPasswordHash(settings);
    if (!passwordHash) {
      const error = new Error('远程访问密码尚未配置，请先在服务端本机设置，或设置 BILI_RECORD_AUTH_PASSWORD。');
      error.statusCode = 503;
      throw error;
    }

    const expectedUsername = String(process.env.BILI_RECORD_AUTH_USERNAME || settings?.accessUsername || 'admin').trim() || 'admin';
    const passwordMatches = await verifyAccessPassword(password, passwordHash);
    const usernameMatches = safeTextEqual(String(username || ''), expectedUsername);
    if (!usernameMatches || !passwordMatches) {
      this.recordFailure(key, now);
      const error = new Error('用户名或密码错误。');
      error.statusCode = 401;
      throw error;
    }

    this.failures.delete(key);
    this.pruneSessions(now);
    const token = crypto.randomBytes(32).toString('base64url');
    this.sessions.set(token, { expiresAt: now + this.sessionTtlMs });
    return { token, expiresAt: now + this.sessionTtlMs, username: expectedUsername };
  }

  authenticate(token) {
    const value = String(token || '');
    if (!value) {
      return false;
    }
    const session = this.sessions.get(value);
    if (!session) {
      return false;
    }
    if (session.expiresAt <= Date.now()) {
      this.sessions.delete(value);
      return false;
    }
    return true;
  }

  logout(token) {
    if (token) {
      this.sessions.delete(String(token));
    }
  }

  clearSessions() {
    this.sessions.clear();
  }

  getActiveFailure(key, now) {
    const failure = this.failures.get(key);
    if (!failure) {
      return null;
    }
    failure.attempts = failure.attempts.filter((time) => now - time <= FAILURE_WINDOW_MS);
    if (failure.blockedUntil <= now && failure.attempts.length === 0) {
      this.failures.delete(key);
      return null;
    }
    return failure;
  }

  recordFailure(key, now) {
    const failure = this.getActiveFailure(key, now) || { attempts: [], blockedUntil: 0 };
    failure.attempts.push(now);
    if (failure.attempts.length >= FAILURE_LIMIT) {
      failure.blockedUntil = now + LOCKOUT_MS;
      failure.attempts = [];
    }
    this.failures.set(key, failure);
  }

  pruneSessions(now = Date.now()) {
    for (const [token, session] of this.sessions) {
      if (session.expiresAt <= now) {
        this.sessions.delete(token);
      }
    }
  }
}

function safeTextEqual(left, right) {
  const leftHash = crypto.createHash('sha256').update(String(left)).digest();
  const rightHash = crypto.createHash('sha256').update(String(right)).digest();
  return crypto.timingSafeEqual(leftHash, rightHash);
}

function parseCookieHeader(header) {
  const cookies = {};
  for (const part of String(header || '').split(';')) {
    const separator = part.indexOf('=');
    if (separator <= 0) continue;
    const name = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();
    if (!name) continue;
    try {
      cookies[name] = decodeURIComponent(value);
    } catch {
      cookies[name] = value;
    }
  }
  return cookies;
}

module.exports = {
  AccessAuthManager,
  hashAccessPassword,
  verifyAccessPassword,
  parseCookieHeader,
  SESSION_TTL_MS
};
