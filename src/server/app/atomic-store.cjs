'use strict';

const fsp = require('node:fs/promises');
const path = require('node:path');

const CURRENT_STORE_SCHEMA_VERSION = 2;

function migrateStore(input) {
  const source = input && typeof input === 'object' ? input : {};
  const schemaVersion = Number(source.schemaVersion || 0);
  const migrated = {
    schemaVersion: CURRENT_STORE_SCHEMA_VERSION,
    settings: source.settings && typeof source.settings === 'object' ? { ...source.settings } : {},
    rooms: Array.isArray(source.rooms) ? source.rooms : [],
    recordings: Array.isArray(source.recordings) ? source.recordings : [],
    mediaJobs: Array.isArray(source.mediaJobs) ? source.mediaJobs : [],
    segmentCleanups: Array.isArray(source.segmentCleanups) ? source.segmentCleanups : []
  };
  if (schemaVersion < 2 && migrated.settings.accessPassword && !migrated.settings.accessPasswordHash) {
    migrated.settings.legacyAccessPassword = String(migrated.settings.accessPassword);
  }
  delete migrated.settings.accessPassword;
  return migrated;
}

async function readJson(pathname) {
  return JSON.parse(await fsp.readFile(pathname, 'utf8'));
}

async function loadAtomicStore(storePath) {
  const backupPath = `${storePath}.backup`;
  try {
    return { store: migrateStore(await readJson(storePath)), recoveredFromBackup: false };
  } catch (primaryError) {
    if (primaryError.code === 'ENOENT') return { store: migrateStore({}), recoveredFromBackup: false };
    try {
      return { store: migrateStore(await readJson(backupPath)), recoveredFromBackup: true, primaryError };
    } catch {
      throw primaryError;
    }
  }
}

class AtomicJsonStore {
  constructor(storePath, options = {}) {
    this.storePath = storePath;
    this.backupPath = `${storePath}.backup`;
    this.mode = options.mode ?? 0o600;
    this.writeChain = Promise.resolve();
    this.sequence = 0;
    this.preserveBackupOnNextWrite = false;
  }

  async load() {
    const result = await loadAtomicStore(this.storePath);
    if (result.recoveredFromBackup) this.preserveBackupOnNextWrite = true;
    return result;
  }

  save(payload) {
    const snapshot = `${JSON.stringify(migrateStore(payload), null, 2)}\n`;
    const operation = this.writeChain.then(() => this.writeSnapshot(snapshot));
    this.writeChain = operation.catch(() => {});
    return operation;
  }

  flush() {
    return this.writeChain;
  }

  async writeSnapshot(snapshot) {
    await fsp.mkdir(path.dirname(this.storePath), { recursive: true, mode: 0o700 });
    const temporary = `${this.storePath}.${process.pid}.${++this.sequence}.tmp`;
    let handle;
    try {
      handle = await fsp.open(temporary, 'wx', this.mode);
      await handle.writeFile(snapshot, 'utf8');
      await handle.sync();
      await handle.close();
      handle = null;
      if (!this.preserveBackupOnNextWrite) {
        await fsp.copyFile(this.storePath, this.backupPath).catch((error) => {
          if (error.code !== 'ENOENT') throw error;
        });
        await fsp.chmod(this.backupPath, this.mode).catch(() => {});
      }
      await fsp.rename(temporary, this.storePath);
      await fsp.chmod(this.storePath, this.mode);
      this.preserveBackupOnNextWrite = false;
    } finally {
      await handle?.close().catch(() => {});
      await fsp.rm(temporary, { force: true }).catch(() => {});
    }
  }
}

module.exports = { AtomicJsonStore, loadAtomicStore, migrateStore, CURRENT_STORE_SCHEMA_VERSION };
