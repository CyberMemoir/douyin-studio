import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { keyedJob, RequestConflict } from '../server/idempotency.js';
import { JobQueue } from '../server/jobs.js';
import { Store } from '../server/store.js';

test('lost acknowledgement and restart reuse a committed collection job; conflicting/evicted keys stop', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'studio-idempotency-'));
  const key = 'a'.repeat(64);
  const store = new Store(directory);
  await store.init();
  const queue = new JobQueue(store);
  let calls = 0;
  const create = () =>
    queue.enqueue('comments', 'fixture', async () => {
      const persisted = JSON.parse(await fs.readFile(path.join(directory, 'state.json'), 'utf8'));
      assert.equal(persisted.receipts[key].jobId, store.jobs[0].id);
      calls++;
    });
  try {
    const first = keyedJob(store, key, 'comments', { videoId: '1234567890123456789' }, create);
    // Repeated HTTP submission would reach this same function after the first response was lost.
    const repeated = keyedJob(store, key, 'comments', { videoId: '1234567890123456789' }, create);
    assert.equal(first.id, repeated.id);
    await queue.idle();
    assert.equal(calls, 1);
    const restarted = new Store(directory);
    await restarted.init();
    const restored = keyedJob(restarted, key, 'comments', { videoId: '1234567890123456789' }, () => {
      throw new Error('must not resubmit');
    });
    assert.equal(restored.id, first.id);
    assert.equal(restored.status, 'completed');
    assert.throws(
      () => keyedJob(restarted, key, 'comments', { videoId: 'different' }, create),
      RequestConflict,
    );
    restarted.jobs = [];
    assert.throws(
      () => keyedJob(restarted, key, 'comments', { videoId: '1234567890123456789' }, create),
      /evicted/,
    );
    await restarted.flush();
  } finally {
    await queue.idle();
    await store.flush();
    const resolved = path.resolve(directory);
    assert(resolved.startsWith(path.resolve(os.tmpdir()) + path.sep));
    await fs.rm(resolved, { recursive: true, force: true });
  }
});
