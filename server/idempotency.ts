import { createHash } from 'node:crypto';
import type { Job } from '../shared/types.js';
import { Store } from './store.js';

export class RequestConflict extends Error {
  constructor(
    message: string,
    readonly status = 409,
  ) {
    super(message);
  }
}

export function keyedJob(
  store: Store,
  key: string | undefined,
  action: string,
  input: unknown,
  create: () => Job,
): Job {
  if (!key) return create();
  if (!/^[A-Za-z0-9_-]{32,128}$/.test(key)) throw new RequestConflict('Invalid Idempotency-Key', 400);
  const hash = createHash('sha256').update(JSON.stringify({ action, input })).digest('hex');
  const receipt = store.receipts.get(key);
  if (receipt) {
    if (receipt.hash !== hash)
      throw new RequestConflict('Idempotency-Key already belongs to different input');
    const job = store.jobs.find((entry) => entry.id === receipt.jobId);
    if (!job)
      throw new RequestConflict(
        'Job result was evicted; inspect the archive. This key will not create another job.',
      );
    return job;
  }
  // Keep tombstones when transient job results are evicted. Never silently expire a key and rerun browser work.
  if (store.receipts.size >= 10000)
    throw new RequestConflict('Receipt capacity reached; export/archive state before maintenance', 503);
  const job = create();
  job.idempotencyKey = key;
  store.receipts.set(key, { hash, jobId: job.id });
  store.changed();
  return job;
}
