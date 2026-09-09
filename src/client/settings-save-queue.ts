export type SettingsSaveKey<T extends object> = Extract<keyof T, string>;

export type SettingsSaveAttempt<T extends object> = {
  id: number;
  patch: Partial<T>;
  versions: Partial<Record<SettingsSaveKey<T>, number>>;
};

export type SettingsSaveFailure<T extends object> = {
  autoRetryKeys: Array<SettingsSaveKey<T>>;
  manualRetryKeys: Array<SettingsSaveKey<T>>;
};

/**
 * Tracks persisted settings by field version instead of one global request
 * version. A response can therefore only settle the exact values it carried.
 */
export class SettingsSaveCoordinator<T extends object> {
  private readonly versions = new Map<SettingsSaveKey<T>, number>();
  private readonly dirtyFields = new Set<SettingsSaveKey<T>>();
  private readonly pendingPatch: Partial<T> = {};
  private readonly pendingVersions = new Map<SettingsSaveKey<T>, number>();
  private readonly inFlight = new Map<number, SettingsSaveAttempt<T>>();
  private readonly retryCounts = new Map<SettingsSaveKey<T>, number>();
  private readonly failedFields = new Set<SettingsSaveKey<T>>();
  private attemptSequence = 0;

  constructor(private readonly autoRetryLimit = 1) {}

  reset() {
    this.versions.clear();
    this.dirtyFields.clear();
    this.clearPending();
    this.inFlight.clear();
    this.retryCounts.clear();
    this.failedFields.clear();
  }

  markChanged(patch: Partial<T>, options: { queue?: boolean } = {}) {
    const shouldQueue = options.queue !== false;
    for (const key of this.patchKeys(patch)) {
      const version = (this.versions.get(key) || 0) + 1;
      this.versions.set(key, version);
      this.dirtyFields.add(key);
      this.retryCounts.delete(key);
      this.failedFields.delete(key);
      if (shouldQueue) {
        this.enqueue(key, patch[key] as T[SettingsSaveKey<T>], version);
      }
    }
  }

  queueCurrent(keys: Array<SettingsSaveKey<T>>, draft: T) {
    for (const key of keys) {
      if (!this.dirtyFields.has(key)) continue;
      this.enqueue(key, draft[key], this.versions.get(key) || 0);
      this.failedFields.delete(key);
    }
  }

  takePending(): SettingsSaveAttempt<T> | null {
    const keys = this.patchKeys(this.pendingPatch);
    if (!keys.length) return null;
    const patch: Partial<T> = {};
    const versions: Partial<Record<SettingsSaveKey<T>, number>> = {};
    for (const key of keys) {
      patch[key] = this.pendingPatch[key] as T[SettingsSaveKey<T>];
      versions[key] = this.pendingVersions.get(key) || 0;
    }
    this.clearPending();
    const attempt: SettingsSaveAttempt<T> = { id: ++this.attemptSequence, patch, versions };
    this.inFlight.set(attempt.id, attempt);
    return attempt;
  }

  settleSuccess(attempt: SettingsSaveAttempt<T>) {
    this.inFlight.delete(attempt.id);
    for (const key of this.patchKeys(attempt.patch)) {
      if (this.versions.get(key) !== attempt.versions[key]) continue;
      this.dirtyFields.delete(key);
      this.retryCounts.delete(key);
      this.failedFields.delete(key);
    }
  }

  settleFailure(attempt: SettingsSaveAttempt<T>, draft: T): SettingsSaveFailure<T> {
    this.inFlight.delete(attempt.id);
    const autoRetryKeys: Array<SettingsSaveKey<T>> = [];
    const manualRetryKeys: Array<SettingsSaveKey<T>> = [];
    for (const key of this.patchKeys(attempt.patch)) {
      // A later edit for this field is already authoritative and will be
      // (or has been) enqueued separately. Never put the failed old value back.
      if (this.versions.get(key) !== attempt.versions[key]) continue;
      const retryCount = (this.retryCounts.get(key) || 0) + 1;
      this.retryCounts.set(key, retryCount);
      if (retryCount <= this.autoRetryLimit) {
        this.enqueue(key, draft[key], this.versions.get(key) || 0);
        autoRetryKeys.push(key);
      } else {
        this.failedFields.add(key);
        manualRetryKeys.push(key);
      }
    }
    return { autoRetryKeys, manualRetryKeys };
  }

  retryFailed(draft: T) {
    const keys = [...this.failedFields];
    for (const key of keys) {
      if (!this.dirtyFields.has(key)) continue;
      this.retryCounts.set(key, 0);
      this.enqueue(key, draft[key], this.versions.get(key) || 0);
      this.failedFields.delete(key);
    }
    return keys;
  }

  getDirtyFields() {
    return new Set(this.dirtyFields);
  }

  hasPending() {
    return this.patchKeys(this.pendingPatch).length > 0;
  }

  hasInFlight() {
    return this.inFlight.size > 0;
  }

  hasFailures() {
    return this.failedFields.size > 0;
  }

  isFullySaved() {
    return this.dirtyFields.size === 0 && !this.hasPending() && !this.hasInFlight();
  }

  private enqueue(key: SettingsSaveKey<T>, value: T[SettingsSaveKey<T>], version: number) {
    this.pendingPatch[key] = value;
    this.pendingVersions.set(key, version);
  }

  private clearPending() {
    for (const key of this.patchKeys(this.pendingPatch)) {
      delete this.pendingPatch[key];
    }
    this.pendingVersions.clear();
  }

  private patchKeys(patch: Partial<T>) {
    return Object.keys(patch) as Array<SettingsSaveKey<T>>;
  }
}
