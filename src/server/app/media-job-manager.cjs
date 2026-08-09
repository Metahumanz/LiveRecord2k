'use strict';

const { EventEmitter } = require('node:events');

const DEFAULT_LIMITS = { cpu: 1, gpu: 1, io: 2 };
const JOB_PRIORITIES = { recording: 100, merge: 70, burn: 60, export: 50, preview: 20 };

class MediaJobManager extends EventEmitter {
  constructor(options = {}) {
    super();
    this.limits = { ...DEFAULT_LIMITS, ...(options.limits || {}) };
    this.active = new Map();
    this.queue = [];
    this.external = new Map();
    this.draining = false;
  }

  acquire(job) {
    if (this.draining) return Promise.reject(new Error('服务正在 draining，不再接受新的媒体任务。'));
    const item = {
      id: String(job.id),
      type: String(job.type || 'media'),
      resource: String(job.resource || 'cpu'),
      priority: Number(job.priority ?? JOB_PRIORITIES[job.type] ?? 0),
      createdAt: Date.now(),
      cancel: job.cancel
    };
    return new Promise((resolve, reject) => {
      item.resolve = resolve;
      item.reject = reject;
      this.queue.push(item);
      this.queue.sort((left, right) => right.priority - left.priority || left.createdAt - right.createdAt);
      this.schedule();
      this.emit('change');
    });
  }

  registerExternal(job) {
    const id = String(job.id);
    this.external.set(id, {
      id,
      type: String(job.type || 'recording'),
      resource: String(job.resource || 'recording'),
      priority: Number(job.priority ?? JOB_PRIORITIES[job.type] ?? 100),
      status: 'running',
      startedAt: Date.now(),
      cancel: job.cancel
    });
    if (String(job.type || '') === 'recording') {
      for (const activeJob of this.active.values()) {
        if (activeJob.type === 'preview') activeJob.cancel?.();
      }
    }
    this.emit('change');
    return () => {
      this.external.delete(id);
      this.schedule();
      this.emit('change');
    };
  }

  schedule() {
    if (this.draining) return;
    for (let index = 0; index < this.queue.length; ) {
      const job = this.queue[index];
      if (!this.resourceAvailable(job.resource)) {
        index += 1;
        continue;
      }
      this.queue.splice(index, 1);
      job.status = 'running';
      job.startedAt = Date.now();
      this.active.set(job.id, job);
      let released = false;
      job.resolve({
        id: job.id,
        release: () => {
          if (released) return;
          released = true;
          this.active.delete(job.id);
          this.schedule();
          this.emit('change');
        }
      });
    }
  }

  resourceAvailable(resource) {
    const recordingActive = Array.from(this.external.values()).some((job) => job.type === 'recording');
    if (recordingActive && (resource === 'cpu' || resource === 'gpu')) return false;
    const limit = Number(this.limits[resource] ?? 1);
    const activeCount = Array.from(this.active.values()).filter((job) => job.resource === resource).length;
    return activeCount < limit;
  }

  cancel(id) {
    const key = String(id);
    const queueIndex = this.queue.findIndex((job) => job.id === key);
    if (queueIndex >= 0) {
      const [job] = this.queue.splice(queueIndex, 1);
      job.reject(new Error('媒体任务已取消。'));
      this.emit('change');
      return true;
    }
    const job = this.active.get(key) || this.external.get(key);
    if (!job) return false;
    job.cancel?.();
    return true;
  }

  snapshot() {
    const mapJob = (job, status) => ({
      id: job.id,
      type: job.type,
      resource: job.resource,
      priority: job.priority,
      status,
      createdAt: job.createdAt,
      startedAt: job.startedAt
    });
    return [
      ...Array.from(this.external.values()).map((job) => mapJob(job, 'running')),
      ...Array.from(this.active.values()).map((job) => mapJob(job, 'running')),
      ...this.queue.map((job) => mapJob(job, 'queued'))
    ];
  }

  hasActive() {
    return this.external.size > 0 || this.active.size > 0 || this.queue.length > 0;
  }

  waitForIdle(timeoutMs = 90_000) {
    if (!this.hasActive()) return Promise.resolve(true);
    return new Promise((resolve) => {
      let settled = false;
      const finish = (idle) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.off('change', check);
        resolve(idle);
      };
      const check = () => {
        if (!this.hasActive()) finish(true);
      };
      const timer = setTimeout(() => finish(false), Math.max(1, Number(timeoutMs) || 90_000));
      timer.unref?.();
      this.on('change', check);
      check();
    });
  }

  async shutdown() {
    this.draining = true;
    const queued = this.queue.splice(0);
    for (const job of queued) job.reject(new Error('服务正在关闭，排队媒体任务已取消。'));
    for (const job of [...this.active.values(), ...this.external.values()]) job.cancel?.();
    this.emit('change');
  }
}

module.exports = { MediaJobManager, JOB_PRIORITIES, DEFAULT_LIMITS };
