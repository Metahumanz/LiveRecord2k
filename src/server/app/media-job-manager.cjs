'use strict';

const { EventEmitter } = require('node:events');

const DEFAULT_LIMITS = {
  recording: 50,
  network: 12,
  disk: 1,
  cpuEncode: 1,
  gpuEncode: 1,
  gpuComposite: 1
};
const JOB_PRIORITIES = { recording: 100, merge: 70, burn: 60, export: 50, preview: 20 };
const RESOURCE_ALIASES = {
  cpu: ['disk', 'cpuEncode'],
  gpu: ['disk', 'gpuEncode'],
  hybrid: ['disk', 'cpuEncode', 'gpuEncode'],
  io: ['disk'],
  recording: ['recording', 'network']
};
const RESOURCE_SLOTS = new Set(['recording', 'network', 'disk', 'cpuEncode', 'gpuEncode', 'gpuComposite']);

function normalizeResourceSlots(value) {
  const values = Array.isArray(value) ? value : [value];
  const slots = [];
  for (const valueItem of values) {
    const resource = String(valueItem || '').trim();
    const expanded = RESOURCE_ALIASES[resource] || [resource];
    for (const slot of expanded) {
      if (RESOURCE_SLOTS.has(slot) && !slots.includes(slot)) {
        slots.push(slot);
      }
    }
  }
  return slots.length ? slots : ['disk', 'cpuEncode'];
}

function resourceSummary(slots) {
  return slots.join('+');
}

class MediaJobManager extends EventEmitter {
  constructor(options = {}) {
    super();
    const configuredLimits = options.limits || {};
    this.limits = { ...DEFAULT_LIMITS, ...configuredLimits };
    // Keep third-party/older callers that still provide cpu/gpu limits useful
    // while the scheduler itself only reasons about the explicit dimensions.
    if (configuredLimits.cpu !== undefined && configuredLimits.cpuEncode === undefined) {
      this.limits.cpuEncode = Number(configuredLimits.cpu);
    }
    if (configuredLimits.gpu !== undefined && configuredLimits.gpuEncode === undefined) {
      this.limits.gpuEncode = Number(configuredLimits.gpu);
    }
    this.active = new Map();
    this.queue = [];
    this.external = new Map();
    this.draining = false;
  }

  acquire(job) {
    if (this.draining) return Promise.reject(new Error('服务正在 draining，不再接受新的媒体任务。'));
    const resources = normalizeResourceSlots(job.resources ?? job.resource ?? 'cpu');
    const item = {
      id: String(job.id),
      type: String(job.type || 'media'),
      resource: resourceSummary(resources),
      resources,
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
    const resources = normalizeResourceSlots(job.resources ?? job.resource ?? 'recording');
    this.external.set(id, {
      id,
      type: String(job.type || 'recording'),
      resource: resourceSummary(resources),
      resources,
      priority: Number(job.priority ?? JOB_PRIORITIES[job.type] ?? 100),
      status: 'running',
      startedAt: Date.now(),
      cancel: job.cancel
    });
    if (String(job.type || '') === 'recording') {
      for (const activeJob of this.active.values()) {
        // Copy-based recordings may safely coexist with one GPU encoder, but
        // CPU encodes and composite work are still preempted for capture
        // stability when a recording begins.
        if (activeJob.resources.includes('cpuEncode') || activeJob.resources.includes('gpuComposite')) {
          activeJob.cancel?.();
        }
      }
    }
    this.schedule();
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
      if (!this.resourceAvailable(job.resources)) {
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

  resourceAvailable(resources) {
    const requiredSlots = normalizeResourceSlots(resources);
    const runningJobs = [...this.active.values(), ...this.external.values()];
    const recordingActive = runningJobs.some((job) => job.resources.includes('recording'));
    if (recordingActive && requiredSlots.some((slot) => slot === 'cpuEncode' || slot === 'gpuComposite')) return false;
    return requiredSlots.every((slot) => {
      const limit = Math.max(0, Number(this.limits[slot] ?? DEFAULT_LIMITS[slot] ?? 1));
      const activeCount = runningJobs.filter((job) => job.resources.includes(slot)).length;
      return activeCount < limit;
    });
  }

  cancel(id) {
    const key = String(id);
    const queueIndex = this.queue.findIndex((job) => job.id === key);
    if (queueIndex >= 0) {
      const [job] = this.queue.splice(queueIndex, 1);
      const error = new Error('媒体任务已取消。');
      error.code = 'MEDIA_JOB_CANCELLED';
      job.reject(error);
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
      resources: [...job.resources],
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

module.exports = { MediaJobManager, JOB_PRIORITIES, DEFAULT_LIMITS, normalizeResourceSlots };
