#!/usr/bin/env node
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { promisify } = require('node:util');

const scrypt = promisify(crypto.scrypt);
const ENV_PATH = '/etc/bili-record-2k/environment';
const STORE_PATH = '/var/lib/bili-record-2k/BiliRecord2K/settings.json';

function parseEnvironment(text) {
  const values = {};
  for (const line of String(text || '').split(/\r?\n/)) {
    const match = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(line.trim());
    if (!match) continue;
    let value = match[2];
    if (value.startsWith('"') && value.endsWith('"')) {
      value = value.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, '\\');
    }
    values[match[1]] = value;
  }
  return values;
}

async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const derived = await scrypt(password, salt, 32, { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
  return `scrypt$16384$8$1$${salt.toString('base64url')}$${Buffer.from(derived).toString('base64url')}`;
}

async function writeAtomic(filePath, payload, mode = 0o600) {
  const temporary = `${filePath}.${process.pid}.${crypto.randomBytes(8).toString('hex')}.tmp`;
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  const flags = fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW || 0);
  let handle = null;
  try {
    handle = await fsp.open(temporary, flags, mode);
    await handle.chmod(mode);
    await handle.writeFile(payload, 'utf8');
    await handle.sync();
    await handle.close();
    handle = null;
    await fsp.rename(temporary, filePath);
  } catch (error) {
    if (handle) await handle.close().catch(() => {});
    await fsp.rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
}

async function migrateBootstrapStore(input, environment) {
  const store = input && typeof input === 'object' ? input : {};
  store.schemaVersion = 2;
  store.settings = store.settings && typeof store.settings === 'object' ? store.settings : {};
  store.rooms = Array.isArray(store.rooms) ? store.rooms : [];
  store.recordings = Array.isArray(store.recordings) ? store.recordings : [];
  store.mediaJobs = Array.isArray(store.mediaJobs) ? store.mediaJobs : [];
  store.segmentCleanups = Array.isArray(store.segmentCleanups) ? store.segmentCleanups : [];
  const settings = store.settings;
  const firstBootstrap = Number(settings.configBootstrapVersion || 0) < 1;
  if (firstBootstrap) {
    if (environment.BILI_RECORD_OUTPUT_DIR) settings.outputDir = environment.BILI_RECORD_OUTPUT_DIR;
    if (environment.BILI_RECORD_HOST) settings.serverHost = environment.BILI_RECORD_HOST;
    if (environment.BILI_RECORD_PORT) settings.serverPort = Number(environment.BILI_RECORD_PORT);
    if (environment.BILI_RECORD_AUTH_USERNAME) settings.accessUsername = environment.BILI_RECORD_AUTH_USERNAME;
    settings.autoUpdateEnabled = environment.BILI_RECORD_AUTO_UPDATE === '1';
    settings.configBootstrapVersion = 1;
  }
  const legacyPassword = String(settings.accessPassword || '');
  const bootstrapPassword = firstBootstrap ? String(environment.BILI_RECORD_AUTH_PASSWORD || '') : '';
  const passwordToMigrate = legacyPassword || bootstrapPassword;
  if (!settings.accessPasswordHash && passwordToMigrate) {
    if (passwordToMigrate.length < 8) throw new Error('首次或旧版管理密码至少需要 8 位。');
    settings.accessPasswordHash = await hashPassword(passwordToMigrate);
  }
  delete settings.accessPassword;
  return store;
}

async function readNoFollow(filePath, options = {}) {
  const handle = await fsp.open(filePath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > Number(options.maxBytes || 16 * 1024 * 1024)) {
      throw new Error(`${path.basename(filePath)} 不是大小合理的普通文件。`);
    }
    return handle.readFile('utf8');
  } finally {
    await handle.close();
  }
}

async function sanitizeBootstrapEnvironment(environmentPath, environment) {
  const configRoot = String(environment.BILI_RECORD_CONFIG_DIR || '/var/lib/bili-record-2k').trim() || '/var/lib/bili-record-2k';
  const payload = [
    `BILI_RECORD_CONFIG_DIR=${configRoot}`,
    'BILI_RECORD_MANAGED_UPDATE=1',
    'BILI_RECORD_SYSTEMD=1',
    ''
  ].join('\n');
  await writeAtomic(environmentPath, payload, 0o640);
}

async function main() {
  const environmentRaw = await readNoFollow(ENV_PATH, { maxBytes: 1024 * 1024 }).catch((error) => {
    if (error.code === 'ENOENT') return '';
    throw error;
  });
  const environment = parseEnvironment(environmentRaw);
  let storeRaw = '';
  let store = {};
  try {
    storeRaw = await readNoFollow(STORE_PATH);
    store = JSON.parse(storeRaw);
  } catch (error) {
    if (error.code !== 'ENOENT') throw new Error(`拒绝覆盖无法解析或不安全的 settings.json：${error.message}`);
  }
  const firstBootstrap = Number(store?.settings?.configBootstrapVersion || 0) < 1;
  store = await migrateBootstrapStore(store, environment);
  if (storeRaw) await writeAtomic(`${STORE_PATH}.backup`, storeRaw, 0o600);
  await writeAtomic(STORE_PATH, `${JSON.stringify(store, null, 2)}\n`);
  if (firstBootstrap) {
    await sanitizeBootstrapEnvironment(ENV_PATH, environment);
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error.stack || error.message || error);
    process.exitCode = 1;
  });
}

module.exports = { parseEnvironment, migrateBootstrapStore, writeAtomic, readNoFollow, sanitizeBootstrapEnvironment };
