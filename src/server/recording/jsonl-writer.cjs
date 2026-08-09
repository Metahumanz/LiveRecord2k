'use strict';

const fs = require('node:fs');

class BufferedJsonlWriter {
  constructor(filePath, options = {}) {
    this.maxBufferBytes = Math.max(64 * 1024, Number(options.maxBufferBytes || 2 * 1024 * 1024));
    this.queue = [];
    this.queuedBytes = 0;
    this.blocked = false;
    this.failed = false;
    this.ending = false;
    this.onError = options.onError;
    this.onDrop = options.onDrop;
    this.stream = fs.createWriteStream(filePath, { flags: 'a', mode: 0o660 });
    this.stream.on('drain', () => {
      this.blocked = false;
      this.flushQueue();
    });
    this.stream.on('error', (error) => {
      this.failed = true;
      this.queue.length = 0;
      this.queuedBytes = 0;
      this.onError?.(error);
    });
  }

  write(value) {
    if (this.failed || this.ending) return false;
    const chunk = Buffer.from(String(value), 'utf8');
    if (!this.blocked && this.queue.length === 0) {
      this.blocked = !this.stream.write(chunk);
      return true;
    }
    if (chunk.length > this.maxBufferBytes || this.queuedBytes + chunk.length > this.maxBufferBytes) {
      this.onDrop?.(chunk.length);
      return false;
    }
    this.queue.push(chunk);
    this.queuedBytes += chunk.length;
    return true;
  }

  flushQueue() {
    while (!this.failed && !this.blocked && this.queue.length) {
      const chunk = this.queue.shift();
      this.queuedBytes -= chunk.length;
      this.blocked = !this.stream.write(chunk);
    }
    if (this.ending && !this.queue.length && !this.failed) this.stream.end();
  }

  end(callback) {
    this.ending = true;
    if (callback) this.stream.once('close', callback);
    if (this.failed) {
      this.stream.destroy();
      return;
    }
    if (this.queue.length || this.blocked) this.flushQueue();
    else this.stream.end();
  }
}

module.exports = { BufferedJsonlWriter };
