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
      accessRequired: Boolean(options.accessRequired)
    };
    this.clients.set(response, client);
    this.writeState(response, client);
    response.on('close', () => this.clients.delete(response));
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
      this.writeDeltaBatch(response, client, batch);
    }
  }

  writeState(response, client) {
    return this.writeEvent(response, 'state', this.getFullState(client));
  }

  writeEvent(response, eventName, payload) {
    try {
      response.write(`event: ${eventName}\ndata: ${JSON.stringify(payload)}\n\n`);
      return true;
    } catch {
      this.clients.delete(response);
      return false;
    }
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
