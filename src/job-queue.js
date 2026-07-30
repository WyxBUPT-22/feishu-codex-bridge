import { EventEmitter } from "node:events";

export class JobQueue extends EventEmitter {
  constructor(concurrency, handler) {
    super();
    this.concurrency = concurrency;
    this.handler = handler;
    this.pending = [];
    this.running = new Map();
    this.closed = false;
    this.idleWaiters = new Set();
  }

  add(job) {
    if (this.closed) {
      const error = new Error("job queue is closed");
      error.code = "QUEUE_CLOSED";
      throw error;
    }
    this.pending.push(job);
    this.emit("queued", job);
    this.pump();
  }

  cancel(jobId) {
    const index = this.pending.findIndex((job) => job.id === jobId);
    if (index >= 0) {
      const [job] = this.pending.splice(index, 1);
      this.emit("canceled", job);
      this.notifyIdle();
      return { type: "pending", job };
    }
    const job = this.running.get(jobId);
    return job ? { type: "running", job } : null;
  }

  status() {
    return { pending: [...this.pending], running: [...this.running.values()] };
  }

  close({ cancelPending = true } = {}) {
    if (this.closed) return [];
    this.closed = true;
    const canceled = cancelPending ? this.pending.splice(0) : [];
    for (const job of canceled) this.emit("canceled", job);
    this.notifyIdle();
    return canceled;
  }

  whenIdle() {
    if (this.pending.length === 0 && this.running.size === 0) return Promise.resolve();
    return new Promise((resolve) => this.idleWaiters.add(resolve));
  }

  notifyIdle() {
    if (this.pending.length !== 0 || this.running.size !== 0) return;
    for (const resolve of this.idleWaiters) resolve();
    this.idleWaiters.clear();
    this.emit("idle");
  }

  async pump() {
    while (!this.closed && this.running.size < this.concurrency && this.pending.length > 0) {
      const job = this.pending.shift();
      this.running.set(job.id, job);
      this.emit("started", job);
      Promise.resolve()
        .then(() => this.handler(job))
        .then((result) => this.emit("completed", job, result))
        .catch((error) => this.emit("failed", job, error))
        .finally(() => {
          this.running.delete(job.id);
          this.pump();
          this.notifyIdle();
        });
    }
    this.notifyIdle();
  }
}
