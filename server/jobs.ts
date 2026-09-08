import { randomUUID } from 'node:crypto';
import type { Job, JobType, Video } from '../shared/types.js';
import { Store } from './store.js';

export type JobContext = {
  job: Job;
  signal: AbortSignal;
  log: (text: string) => void;
  update: (patch: Partial<Job>) => void;
};
type Work = (context: JobContext) => Promise<void>;
export class JobQueue {
  private waiting: { job: Job; work: Work; controller: AbortController }[] = [];
  private controllers = new Map<string, AbortController>();
  private active = false;
  constructor(private store: Store) {}
  enqueue(type: JobType, title: string, work: Work, video?: Video): Job {
    if (this.waiting.length > 60) throw new Error('等待中的任务过多，请稍后再试');
    const now = new Date().toISOString();
    const job: Job = {
      id: randomUUID(),
      type,
      title,
      status: 'queued',
      createdAt: now,
      updatedAt: now,
      progress: null,
      phase: '等待执行',
      logs: [],
      ...(video ? { video } : {}),
    };
    this.store.jobs.unshift(job);
    // Preserve download history, including the file index. Cap disposable search/check history.
    const transient = this.store.jobs.filter((j) => j.type !== 'download');
    const evict = new Set(
      transient
        .slice(100)
        .filter((j) => !['queued', 'running'].includes(j.status))
        .map((j) => j.id),
    );
    this.store.jobs = this.store.jobs.filter((j) => !evict.has(j.id));
    const controller = new AbortController();
    this.controllers.set(job.id, controller);
    this.waiting.push({ job, work, controller });
    this.store.changed();
    queueMicrotask(() => void this.drain());
    return job;
  }
  cancel(id: string): boolean {
    const controller = this.controllers.get(id);
    if (!controller) return false;
    controller.abort(new Error('任务已取消'));
    const pending = this.waiting.find((entry) => entry.job.id === id);
    if (pending) {
      pending.job.status = 'cancelled';
      pending.job.phase = '已取消';
      pending.job.updatedAt = new Date().toISOString();
      this.store.changed();
    }
    return true;
  }
  cancelAll() {
    for (const id of this.controllers.keys()) this.cancel(id);
  }
  async idle() {
    while (this.active || this.waiting.length) await new Promise((resolve) => setTimeout(resolve, 30));
  }
  private async drain() {
    if (this.active) return;
    this.active = true;
    try {
      while (this.waiting.length) {
        const { job, work, controller } = this.waiting.shift()!;
        if (controller.signal.aborted) {
          this.controllers.delete(job.id);
          continue;
        }
        const update = (patch: Partial<Job>) => {
          Object.assign(job, patch, { updatedAt: new Date().toISOString() });
          this.store.changed();
        };
        const log = (text: string) => {
          job.logs.push({ time: new Date().toISOString(), text: text.slice(0, 1000) });
          job.logs = job.logs.slice(-80);
          update({ phase: text });
        };
        update({ status: 'running', phase: '开始执行' });
        try {
          await work({ job, signal: controller.signal, log, update });
          controller.signal.throwIfAborted();
          update({ status: 'completed', progress: 100, phase: '已完成' });
        } catch (error) {
          const cancelled = controller.signal.aborted;
          const message = error instanceof Error ? error.message : '任务执行失败';
          log(cancelled ? '任务已取消' : message);
          update({
            status: cancelled ? 'cancelled' : 'failed',
            phase: cancelled ? '已取消' : '执行失败',
            error: cancelled ? undefined : message,
          });
        } finally {
          this.controllers.delete(job.id);
        }
      }
    } finally {
      this.active = false;
    }
  }
}
