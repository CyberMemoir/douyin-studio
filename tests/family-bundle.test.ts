import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { produceBundle, pointer, sha256, type FamilyAction } from '../server/family-source-bundle.js';
import { cancelFamilyAction, recipeIdentity, runFamilyAction } from '../server/family-action.js';
import type { Job } from '../shared/types.js';

const fixture = async (): Promise<Job> =>
  JSON.parse(
    await fs.readFile(fileURLToPath(new URL('./fixtures/family-search.json', import.meta.url)), 'utf8'),
  );
const action: FamilyAction = {
  action_type: 'search',
  target_platform: 'douyin',
  family_id: '00000000-0000-4000-8000-000000000001',
  query: '甲表达',
  purpose: 'find_independent_uses',
  evidence_refs: [],
  query_layer: 'rule_seed',
  is_actual_search_log: false,
};

test('action evidence is self-contained and Unicode spans cannot be silently rebound', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'studio-action-evidence-'));
  try {
    const body = JSON.stringify({ title: '🙂甲表达是什么梗' }),
      sha = sha256(body);
    await fs.writeFile(path.join(root, sha + '.bin'), body);
    const bound = {
      ...action,
      evidence_refs: [
        { evidence_sha: sha, locator: '/title', span: [1, 4] as [number, number], original_text: '甲表达' },
      ],
    };
    const manifest = await produceBundle(await fixture(), path.join(root, 'out'), {
      sourceId: 'bound-fixture',
      publicationUnit: 'seconds',
      material: 'fixture',
      action: bound,
      actionObjects: root,
    });
    assert(manifest.objects.includes(sha));
    assert.equal(await fs.readFile(path.join(root, 'out/objects', sha + '.bin'), 'utf8'), body);
    bound.evidence_refs[0].span = [2, 5];
    await assert.rejects(
      produceBundle(await fixture(), path.join(root, 'bad'), {
        sourceId: 'bad-fixture',
        publicationUnit: 'seconds',
        material: 'fixture',
        action: bound,
        actionObjects: root,
      }),
      /span mismatch/,
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('operator stop cancels known Studio work and persists a stopped epoch across restart', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'studio-stop-'));
  try {
    const controller = new AbortController();
    let submitted = 0,
      cancelled = 0;
    const request = async (route: string, _body?: object, key?: string) => {
      if (route.startsWith('receipts/')) return null;
      if (route === 'search') {
        submitted++;
        controller.abort();
        return { ...(await fixture()), idempotencyKey: key };
      }
      if (route.endsWith('/cancel')) {
        cancelled++;
        return null;
      }
      throw new Error('No polling should follow the stop');
    };
    const options = {
      directory,
      epoch: 'stopped',
      mode: 'head' as const,
      pauseFile: path.join(directory, 'absent.pause'),
      request,
      signal: controller.signal,
    };
    assert.equal((await runFamilyAction(action, options)).status, 'interrupted');
    assert.equal(
      (await runFamilyAction(action, { ...options, signal: new AbortController().signal })).status,
      'interrupted',
    );
    assert.equal(submitted, 1);
    assert.equal(cancelled, 1);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('self-contained bundle binds raw text, explicit seconds/milliseconds, missing dates and privacy', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'studio-bundle-'));
  try {
    const job = await fixture();
    const output = path.join(root, 'bundle');
    const manifest = await produceBundle(job, output, {
      sourceId: 'synthetic',
      publicationUnit: 'seconds',
      material: 'fixture',
    });
    assert.equal(manifest.outcome, 'partial');
    const bytes = await fs.readFile(path.join(output, 'records.jsonl'));
    assert.equal(sha256(bytes), manifest.records_sha256);
    const records = bytes
      .toString('utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    const body = await fs.readFile(path.join(output, 'objects', records[0].evidence_sha + '.bin'));
    assert(!body.toString().includes('signed?token'));
    const view = JSON.parse(body.toString());
    assert.equal(pointer(view, records[0].texts[0].locator), records[0].texts[0].text);
    assert.equal(records[0].normalized_published_time.basis, 'unix_seconds');
    assert.equal(records[0].normalized_published_time.start_at, '2019-03-21T16:00:00+00:00');
    assert.equal(records[1].normalized_published_time, null);
    assert.equal(records[1].publication_unit, 'unknown');
    job.result!.videos![0].createdAt = 1553184000123;
    await produceBundle(job, path.join(root, 'ms'), {
      sourceId: 'synthetic-ms',
      publicationUnit: 'milliseconds',
      material: 'fixture',
    });
    const ms = JSON.parse((await fs.readFile(path.join(root, 'ms/records.jsonl'), 'utf8')).split('\n')[0]);
    assert.equal(ms.normalized_published_time.start_at, '2019-03-21T16:00:00.123000+00:00');
    await assert.rejects(
      produceBundle(job, output, {
        sourceId: 'synthetic',
        publicationUnit: 'milliseconds',
        material: 'fixture',
      }),
      /EEXIST/,
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('blocked/cancelled reader outcomes survive packaging, including zero-record stops', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'studio-outcomes-'));
  try {
    const job = await fixture();
    job.status = 'failed';
    job.error = '人工验证';
    const blocked = await produceBundle(job, path.join(root, 'blocked'), {
      sourceId: 'synthetic',
      publicationUnit: 'seconds',
      material: 'fixture',
    });
    assert.equal(blocked.outcome, 'blocked_verification');
    assert.equal(blocked.record_count, 2);
    job.status = 'cancelled';
    job.error = undefined;
    job.result = undefined;
    const cancelled = await produceBundle(job, path.join(root, 'cancelled'), {
      sourceId: 'synthetic',
      publicationUnit: 'unknown',
      material: 'fixture',
    });
    assert.equal(cancelled.reader_outcome, 'cancelled');
    assert.equal(cancelled.record_count, 0);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('head epochs get fresh keyed identities, same epoch restarts replay, cancellation survives replanning', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'studio-actions-'));
  try {
    let submissions = 0;
    const keys: string[] = [];
    const request = async (route: string, _body?: object, key?: string) => {
      if (route.startsWith('receipts/')) return null;
      if (route === 'search') {
        submissions++;
        keys.push(key!);
        return { ...(await fixture()), id: 'job-' + submissions, idempotencyKey: key };
      }
      return { ...(await fixture()), id: 'job-' + submissions };
    };
    const options = {
      directory,
      epoch: 'head-1',
      mode: 'head' as const,
      pauseFile: path.join(directory, 'absent.pause'),
      request,
    };
    const first = await runFamilyAction(action, options);
    const restarted = await runFamilyAction(action, options);
    assert.equal(first.execution_id, restarted.execution_id);
    assert.equal(submissions, 1);
    await runFamilyAction(action, { ...options, epoch: 'head-2' });
    assert.equal(submissions, 2);
    assert.notEqual(keys[0], keys[1]);
    await cancelFamilyAction(action, directory, 'operator ended recipe');
    const replanned = {
      ...action,
      evidence_refs: [
        {
          evidence_sha: 'a'.repeat(64),
          locator: '/title',
          span: [0, 3] as [number, number],
          original_text: '甲表达',
        },
      ],
    };
    assert.equal(recipeIdentity(action), recipeIdentity(replanned));
    const cancelled = await runFamilyAction(replanned, { ...options, epoch: 'head-3' });
    assert.equal(cancelled.status, 'cancelled');
    assert.equal(submissions, 2);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('lost POST acknowledgement recovers original receipt; pause/history never submit', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'studio-receipt-'));
  try {
    let created: Job | null = null;
    let submissions = 0;
    const request = async (route: string, _body?: object, key?: string) => {
      if (route.startsWith('receipts/')) return created;
      if (route === 'search') {
        submissions++;
        created = { ...(await fixture()), idempotencyKey: key };
        throw new Error('lost acknowledgement');
      }
      return created;
    };
    const options = {
      directory,
      epoch: 'one',
      mode: 'head' as const,
      pauseFile: path.join(directory, 'absent.pause'),
      request,
    };
    await assert.rejects(runFamilyAction(action, options), /lost acknowledgement/);
    assert.equal((await runFamilyAction(action, options)).status, 'completed');
    assert.equal(submissions, 1);
    await fs.writeFile(options.pauseFile, '{}');
    assert.equal(
      (await runFamilyAction(action, { ...options, epoch: 'paused' })).status,
      'blocked_verification',
    );
    assert.equal(
      (await runFamilyAction(action, { ...options, mode: 'history', epoch: 'history' })).status,
      'unsupported',
    );
    assert.equal(submissions, 1);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});
