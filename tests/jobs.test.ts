import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../server/store.js';
import { JobQueue } from '../server/jobs.js';

test('jobs serialize, persist results, and recover interrupted jobs after restart', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'studio-queue-'));
  const store = new Store(dir);
  await store.init();
  try {
    const queue = new JobQueue(store);
    const order: number[] = [];
    queue.enqueue('search', 'first', async (ctx) => {
      order.push(1);
      await new Promise((r) => setTimeout(r, 15));
      ctx.log('完成第一步');
      order.push(2);
    });
    queue.enqueue('search', 'second', async () => {
      order.push(3);
    });
    await queue.idle();
    assert.deepEqual(order, [1, 2, 3]);
    assert(store.jobs.every((job) => job.status === 'completed'));
    store.jobs[0].status = 'running';
    await store.flush();
    const restored = new Store(dir);
    await restored.init();
    assert.equal(restored.jobs[0].status, 'failed');
    assert.match(restored.jobs[0].error!, /重启/);
    await restored.flush();
  } finally {
    await store.flush();
    await fs.rm(dir, { recursive: true, force: true });
  }
});
test('queued cancellation avoids running work and failed work remains explicit', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'studio-cancel-'));
  const store = new Store(dir);
  await store.init();
  try {
    const queue = new JobQueue(store);
    const cancelled = queue.enqueue('search', 'cancel', async () => {
      throw new Error('must never run');
    });
    assert(queue.cancel(cancelled.id));
    const failed = queue.enqueue('search', 'fail', async () => {
      throw new Error('真实错误');
    });
    await queue.idle();
    assert.equal(cancelled.status, 'cancelled');
    assert.equal(failed.status, 'failed');
    assert.equal(failed.error, '真实错误');
    assert(!queue.cancel('missing'));
  } finally {
    await store.flush();
    await fs.rm(dir, { recursive: true, force: true });
  }
});
