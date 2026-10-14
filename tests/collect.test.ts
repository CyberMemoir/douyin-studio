import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { saveEvidence, validateVideo, waitForJob } from '../scripts/collect.js';
import { resolveDetailId } from '../server/browser.js';
import type { Job, Video } from '../shared/types.js';

const video: Video = { id: '1234567890123456789', url: 'https://www.douyin.com/video/1234567890123456789',
  title: '🙂已读乱回的面试', author: 'fixture', duration: 0, likes: 0, comments: null, createdAt: null,
  cover: 'https://example.invalid/transient', source: 'network' };
const job = (status: Job['status']): Job => ({ id: 'fixture-job', type: 'search', title: 'fixture', status,
  createdAt: '2026-10-13T00:00:00Z', updatedAt: '2026-10-13T00:00:01Z', progress: null, phase: status, logs: [],
  result: { videos: [video] }, ...(status === 'failed' ? { error: '页面需要人工验证' } : {}) });

test('detail identity rejects another work or non-detail redirect; genuine short share resolves', () => {
  const canonical = video.url;
  assert.equal(resolveDetailId(canonical, canonical), video.id);
  assert.equal(resolveDetailId('https://v.douyin.com/fixture/', canonical), video.id);
  assert.throws(() => resolveDetailId(canonical, 'https://www.douyin.com/video/2234567890123456789'), /不一致/);
  assert.throws(() => resolveDetailId(canonical, 'https://www.douyin.com/'));
  assert.throws(() => validateVideo({ ...video, url: 'https://www.douyin.com/video/2234567890123456789' }), /不一致/);
});

test('script follows queued/running to failed and never treats timeout as terminal', async () => {
  const states = ['queued', 'running', 'failed'] as const;
  let n = 0;
  const failed = await waitForJob('fixture-job', async () => ({ jobs: [job(states[Math.min(n++, 2)])] }), 100, 1);
  assert.equal(failed.clientStatus, 'failed');
  assert.match(failed.job!.error!, /人工验证/);
  const timeout = await waitForJob('fixture-job', async () => ({ jobs: [job('running')] }), 0, 1);
  assert.equal(timeout.clientStatus, 'client_timeout');
  assert.equal(timeout.job!.status, 'running');
});

test('source evidence preserves Unicode spans and hashes without auto-querying or media URL leakage', async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'studio-collect-'));
  try {
    const archived = job('completed');
    (archived.result!.videos![0] as Video & { mediaUrls: string[] }).mediaUrls = ['https://example.invalid/private'];
    const output = path.join(temp, 'out');
    const manifest = await saveEvidence(archived, output, [{ id: video.id, text: '已读乱回', span: [1, 5], targetIds: [], relation: 'observed_use' }]);
    assert.equal(manifest.query_count, 1);
    assert(!((await fs.readFile(path.join(output, 'job.json'), 'utf8')).includes('example.invalid')));
    const source = JSON.parse((await fs.readFile(path.join(output, 'sources.jsonl'), 'utf8')).trim());
    assert.equal(source.observed_at, null, 'Legacy content lacks an actual observed timestamp');
    const query = JSON.parse((await fs.readFile(path.join(output, 'queries.jsonl'), 'utf8')).trim());
    assert.equal(query.is_actual_search_log, false);
    assert.equal(query.ingest_approved, false);
    assert.deepEqual(query.span, [1, 5]);
    for (const entry of manifest.files) assert.equal(createHash('sha256').update(await fs.readFile(path.join(output, entry.path))).digest('hex'), entry.sha256);
    await assert.rejects(saveEvidence(archived, output), /EEXIST/);
    const plain = await saveEvidence(archived, path.join(temp, 'plain'));
    assert.equal(plain.query_count, 0, 'Titles never automatically become human query records');
    await assert.rejects(saveEvidence(archived, path.join(temp, 'bad'), [{ id: video.id, text: '已读乱回', span: [2, 6], targetIds: [] }]), /定位/);
  } finally { await fs.rm(temp, { recursive: true, force: true }); }
});

test('failed job archives failure and pending notes with no fabricated content evidence', async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'studio-blocked-'));
  try {
    const manifest = await saveEvidence(job('failed'), path.join(temp, 'out'), [{ id: video.id, text: '已读乱回', span: [1, 5], targetIds: [] }]);
    assert.equal(manifest.source_count, 0);
    assert.equal(manifest.query_count, 0);
    assert.equal(manifest.job_status, 'failed');
  } finally { await fs.rm(temp, { recursive: true, force: true }); }
});
