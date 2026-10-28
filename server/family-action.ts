import fs from 'node:fs/promises';
import path from 'node:path';
import type { Job } from '../shared/types.js';
import { sha256, validateAction, type FamilyAction } from './family-source-bundle.js';

type Request = (route: string, body?: object, key?: string) => Promise<Job | null>;
export type ActionJournal = {
  version: 1;
  recipe_id: string;
  execution_id: string;
  epoch: string;
  mode: 'head' | 'history';
  status: string;
  query: string;
  family_id: string;
  purpose: string;
  job_id?: string;
  job?: Job;
  reason?: string;
};
export const recipeIdentity = (value: FamilyAction) => {
  const action = validateAction(value);
  return sha256(
    JSON.stringify({
      type: action.action_type,
      platform: action.target_platform,
      family: action.family_id,
      query: action.query.trim(),
      purpose: action.purpose,
    }),
  );
};
async function exists(file: string) {
  try {
    await fs.access(file);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    return false;
  }
}
async function save(file: string, value: unknown) {
  const handle = await fs.open(file + '.tmp', 'w', 0o600);
  try {
    await handle.writeFile(JSON.stringify(value, null, 2));
    await handle.sync();
  } finally {
    await handle.close();
  }
  await fs.rename(file + '.tmp', file);
  if (process.platform !== 'win32') {
    const directory = await fs.open(path.dirname(file), 'r');
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  }
}
export async function cancelFamilyAction(action: FamilyAction, directory: string, reason: string) {
  if (!reason.trim()) throw new Error('Cancellation reason required');
  const recipe = recipeIdentity(action);
  await fs.mkdir(directory, { recursive: true });
  await save(path.join(directory, recipe + '.cancelled.json'), {
    recipe_id: recipe,
    reason,
    cancelled_at: new Date().toISOString(),
  });
  return recipe;
}

export async function runFamilyAction(
  actionValue: FamilyAction,
  options: {
    directory: string;
    epoch: string;
    mode: 'head' | 'history';
    pauseFile: string;
    request?: Request;
    signal?: AbortSignal;
    pollMs?: number;
    timeoutMs?: number;
  },
) {
  const action = validateAction(actionValue);
  if (!options.epoch.trim() || !['head', 'history'].includes(options.mode))
    throw new Error('Explicit head/history epoch required');
  const recipe = recipeIdentity(action),
    execution = sha256(JSON.stringify({ recipe, mode: options.mode, epoch: options.epoch }));
  await fs.mkdir(options.directory, { recursive: true });
  const file = path.join(options.directory, execution + '.json');
  // One process owns an execution. A crash leaves a lock requiring explicit offline recovery.
  const lock = await fs.open(file + '.lock', 'wx');
  await lock.writeFile(JSON.stringify({ pid: process.pid, acquired_at: new Date().toISOString() }));
  let journal: ActionJournal;
  try {
    journal = await fs.readFile(file, 'utf8').then(JSON.parse, (error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error;
      return {
        version: 1,
        recipe_id: recipe,
        execution_id: execution,
        epoch: options.epoch,
        mode: options.mode,
        status: 'prepared',
        query: action.query,
        family_id: action.family_id,
        purpose: action.purpose,
      };
    });
    const cancelledFile = path.join(options.directory, recipe + '.cancelled.json');
    if (await exists(cancelledFile)) {
      journal.status = 'cancelled';
      journal.reason = 'persistent_recipe_cancellation';
      await save(file, journal);
      return journal;
    }
    if (
      [
        'completed',
        'failed',
        'blocked_login',
        'blocked_verification',
        'cancelled',
        'interrupted',
        'unsupported',
      ].includes(journal.status)
    )
      return journal;
    if (options.mode === 'history') {
      journal.status = 'unsupported';
      journal.reason = 'native_search_cursor_not_implemented';
      await save(file, journal);
      return journal;
    }
    if (await exists(options.pauseFile)) {
      journal.status = 'blocked_verification';
      journal.reason = 'persisted_studio_access_pause';
      await save(file, journal);
      return journal;
    }
    if (!options.request) {
      await save(file, journal);
      return journal;
    }
    if (options.signal?.aborted) {
      journal.status = 'interrupted';
      journal.reason = 'operator_stop_before_submit';
      await save(file, journal);
      return journal;
    }
    const request = options.request;
    const deadline = Date.now() + (options.timeoutMs ?? 120_000);
    try {
      // Recover durable receipt before another mutation, including lost acknowledgement.
      let job = journal.job_id ? null : await request(`receipts/${execution}`);
      if (!journal.job_id) {
        journal.status = 'submission_unknown';
        await save(file, journal);
        job ??= await request('search', { query: action.query.trim(), limit: 8, maxScrolls: 0 }, execution);
        if (!job?.id || job.idempotencyKey !== execution)
          throw new Error('Studio omitted matching keyed receipt');
        journal.job_id = job.id;
        journal.status = 'running';
        await save(file, journal);
      }
      while (true) {
        const cancelled = await exists(cancelledFile);
        if (cancelled || options.signal?.aborted) {
          // Cancel the known local Studio task, without performing another platform read.
          try {
            await request(`jobs/${journal.job_id}/cancel`, {});
          } finally {
            journal.status = cancelled ? 'cancelled' : 'interrupted';
            journal.reason = 'operator_stop';
            await save(file, journal);
          }
          return journal;
        }
        if (Date.now() >= deadline) {
          journal.status = 'waiting';
          journal.reason = 'client_timeout_not_reader_terminal';
          await save(file, journal);
          return journal;
        }
        job = await request(`jobs/${journal.job_id}`);
        if (!job || job.id !== journal.job_id)
          throw new Error('Studio job identity missing/changed; do not resubmit');
        if (['completed', 'failed', 'cancelled'].includes(job.status)) {
          journal.job = job;
          journal.status = job.status;
          journal.reason = job.error ?? undefined;
          await save(file, journal);
          return journal;
        }
        if (!['queued', 'running'].includes(job.status)) throw new Error('Unknown Studio job status');
        await new Promise((resolve) => setTimeout(resolve, options.pollMs ?? 1000));
      }
    } catch (error) {
      journal.reason = error instanceof Error ? error.message : 'request_failed';
      await save(file, journal);
      throw error;
    }
  } finally {
    await lock.close();
    await fs.unlink(file + '.lock');
  }
}

export async function recoverActionLock(
  action: FamilyAction,
  directory: string,
  epoch: string,
  mode: 'head' | 'history',
) {
  const recipe = recipeIdentity(action),
    execution = sha256(JSON.stringify({ recipe, mode, epoch }));
  const file = path.join(directory, execution + '.json.lock');
  const owner = JSON.parse(await fs.readFile(file, 'utf8'));
  if (!Number.isInteger(owner.pid) || owner.pid <= 0)
    throw new Error('Invalid lock owner; preserve for operator diagnosis');
  try {
    process.kill(owner.pid, 0);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
    await fs.rename(file, file + '.recovered-' + Date.now());
    return { execution_id: execution, recovered: true, network_requests: 0 };
  }
  throw new Error('Lock owner still exists; no concurrent recovery');
}

export function studioRequest(origin: string): Request {
  const url = new URL(origin);
  if (
    url.protocol !== 'http:' ||
    !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) ||
    url.username ||
    url.password ||
    url.pathname !== '/' ||
    url.search ||
    url.hash
  )
    throw new Error('Only local Studio origin supported');
  return async (route, body, key) => {
    const response = await fetch(`${url.origin}/api/${route}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers:
        body === undefined
          ? {}
          : {
              'Content-Type': 'application/json',
              'X-Studio-Client': '1',
              ...(key ? { 'Idempotency-Key': key } : {}),
            },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });
    if (response.status === 404 && route.startsWith('receipts/')) return null;
    const data = await response.json();
    if (!response.ok) throw new Error(`Studio HTTP ${response.status}; do not resubmit with a new key`);
    return data;
  };
}
