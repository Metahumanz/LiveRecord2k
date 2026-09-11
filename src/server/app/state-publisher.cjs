'use strict';

const DELTA_TYPES = new Set(['room', 'recording', 'settings', 'mediaJob', 'diskSpace', 'system']);

class StatePublisher {
  constructor(options = {}) {
    this.getFullState = options.getFullState;
    this.getRoomIds = options.getRoomIds;
    this.getDeltaPayload = options.getDeltaPayload;
    this.delayMs = Math.max(0, Number(options.delayMs) || 80);
    this.clients = new Map();
    this.timer = null;
    this.resetDirtyState();
  }

  addClient(response, options = {}) {
    const client = {
      redactCookie: Boolean(options.redactCookie),
      localConsole: Boolean(options.localConsole),
      accessAuthenticated: Boolean(options.accessAuthenticated),
      accessRequired: Boolean(options.accessRequired),
      paused: false,
      drainListener: null
    };
    this.clients.set(response, client);
    this.writeState(response, client);
    response.on('close', () => this.removeClient(response, client));
  }

  invalidateAccessClients(payload = {}) {
    const eventPayload = {
      code: String(payload.code || 'ACCESS_AUTH_INVALIDATED'),
      message: String(payload.message || '远程访问凭据已更新，请重新登录。')
    };
    let invalidated = 0;
    for (const [response, client] of this.clients) {
      if (!client.accessRequired) continue;
      this.removeClient(response, client);
      try {
        response.write(this.formatEvent('auth-invalidated', eventPayload));
      } catch {
        // The connection may already have gone away; it is removed either way.
      }
      try {
        response.end?.();
      } catch {
        // Closing a broken HTTP stream is best effort.
      }
      invalidated += 1;
    }
    return invalidated;
  }

  markAllDirty() {
    this.dirty.roomsAll = true;
    for (const type of DELTA_TYPES) {
      if (type !== 'room') this.dirty[type] = true;
    }
    this.schedule();
  }

  markDirty(type, detail = {}) {
    if (Array.isArray(type)) {
      for (const item of type) this.markDirty(item, detail);
      return;
    }
    const eventName = String(type || '');
    if (eventName === 'room') {
      const roomId = String(detail.roomId || detail.id || '');
      if (roomId) {
        this.dirty.rooms.set(roomId, { deleted: Boolean(detail.deleted) });
      } else {
        this.dirty.roomsAll = true;
      }
    } else if (eventName === 'log') {
      if (detail.clear) {
        this.dirty.logClear = true;
        this.dirty.logEntries = [];
      } else if (detail.entry) {
        this.dirty.logEntries.push(detail.entry);
      } else {
        this.dirty.logReplace = true;
      }
    } else if (DELTA_TYPES.has(eventName)) {
      this.dirty[eventName] = true;
    }
    this.schedule();
  }

  markRoomDirty(roomId) {
    this.markDirty('room', { roomId });
  }

  markRoomDeleted(roomId) {
    this.markDirty('room', { roomId, deleted: true });
  }

  markLog(entry) {
    this.markDirty('log', { entry });
  }

  markLogsCleared() {
    this.markDirty('log', { clear: true });
  }

  flush() {
    if (!this.hasDirtyState()) return;
    const batch = this.takeDirtyState();
    for (const [response, client] of this.clients) {
      if (client.paused) continue;
      this.writeDeltaBatch(response, client, batch);
    }
  }

  writeState(response, client) {
    if (client?.paused) return false;
    return this.writeEvent(response, 'state', this.getFullState(client));
  }

  writeEvent(response, eventName, payload) {
    const client = this.clients.get(response);
    if (client?.paused) return false;
    try {
      const writable = response.write(this.formatEvent(eventName, payload));
      if (writable === false) {
        this.pauseClient(response, client);
        return false;
      }
      return true;
    } catch {
      this.removeClient(response, client);
      return false;
    }
  }

  formatEvent(eventName, payload) {
    return `event: ${eventName}\ndata: ${JSON.stringify(payload)}\n\n`;
  }

  pauseClient(response, client) {
    if (!client || client.paused) return;
    client.paused = true;
    const resume = () => {
      if (this.clients.get(response) !== client) return;
      client.paused = false;
      client.drainListener = null;
      // Deltas accumulated while the stream was blocked were deliberately
      // skipped, so resume with a current full snapshot instead of replaying
      // an arbitrary stale subset.
      this.writeState(response, client);
    };
    client.drainListener = resume;
    if (typeof response.once === 'function') {
      response.once('drain', resume);
      return;
    }
    this.removeClient(response, client);
    try {
      response.end?.();
    } catch {
      // No usable stream lifecycle hook is available.
    }
  }

  removeClient(response, expectedClient) {
    const client = this.clients.get(response);
    if (!client || (expectedClient && client !== expectedClient)) return;
    if (client.drainListener) {
      if (typeof response.off === 'function') {
        response.off('drain', client.drainListener);
      } else if (typeof response.removeListener === 'function') {
        response.removeListener('drain', client.drainListener);
      }
      client.drainListener = null;
    }
    this.clients.delete(response);
  }

  writeDeltaBatch(response, client, batch) {
    const emittedRooms = new Set();
    if (batch.roomsAll) {
      for (const roomId of this.getRoomIds()) {
        emittedRooms.add(String(roomId));
        if (!this.writeRoom(response, client, roomId, false)) return;
      }
    }
    for (const [roomId, detail] of batch.rooms) {
      if (!detail.deleted && emittedRooms.has(roomId)) continue;
      if (!this.writeRoom(response, client, roomId, detail.deleted)) return;
    }

    if (batch.recording && !this.writePayload(response, client, 'recording')) return;
    if (batch.logClear && !this.writeEvent(response, 'log', { clear: true })) return;
    if (batch.logEntries.length && !this.writeEvent(response, 'log', { entries: batch.logEntries })) return;
    if (batch.logReplace && !this.writePayload(response, client, 'log')) return;
    for (const type of ['settings', 'mediaJob', 'diskSpace', 'system']) {
      if (batch[type] && !this.writePayload(response, client, type)) return;
    }
  }

  writeRoom(response, client, roomId, deleted) {
    const payload = this.getDeltaPayload('room', { roomId: String(roomId), deleted: Boolean(deleted) }, client);
    return payload === undefined || this.writeEvent(response, 'room', payload);
  }

  writePayload(response, client, type) {
    const payload = this.getDeltaPayload(type, {}, client);
    return payload === undefined || this.writeEvent(response, type, payload);
  }

  schedule() {
    if (this.timer !== null) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.flush();
    }, this.delayMs);
    this.timer.unref?.();
  }

  hasDirtyState() {
    return (
      this.dirty.roomsAll ||
      this.dirty.rooms.size > 0 ||
      this.dirty.recording ||
      this.dirty.logClear ||
      this.dirty.logEntries.length > 0 ||
      this.dirty.logReplace ||
      this.dirty.settings ||
      this.dirty.mediaJob ||
      this.dirty.diskSpace ||
      this.dirty.system
    );
  }

  takeDirtyState() {
    const batch = this.dirty;
    this.resetDirtyState();
    return batch;
  }

  resetDirtyState() {
    this.dirty = {
      roomsAll: false,
      rooms: new Map(),
      recording: false,
      logClear: false,
      logEntries: [],
      logReplace: false,
      settings: false,
      mediaJob: false,
      diskSpace: false,
      system: false
    };
  }
}

module.exports = { StatePublisher };
