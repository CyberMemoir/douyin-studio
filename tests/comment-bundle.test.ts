import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parseCommentPage } from '../server/comments.js';
import { commentEvidence } from '../server/comment-evidence.js';
import { produceBundle, pointer, sha256 } from '../server/family-source-bundle.js';
import { anchorRequests, type BilibiliAnchor } from '../server/bilibili-anchor.js';
import type { Job, CommentCollection } from '../shared/types.js';

const videoId = '1234567890123456789';
function fixture() {
  const pages = [0, 1].map((index) =>
    parseCommentPage(
      Buffer.from(
        JSON.stringify({
          status_code: 0,
          has_more: index === 0 ? 1 : 0,
          cursor: index + 1,
          comments: [
            {
              cid: String(100 + index),
              aweme_id: videoId,
              text: index ? '🙂原话' : '原话使用场景',
              user: { uid: '123', avatar: 'https://private.invalid/?token=secret' },
              create_time: index ? undefined : 1553184000,
              digg_count: index + 2,
            },
          ],
        }),
      ),
      videoId,
      `2026-10-28T10:00:0${index}Z`,
    ),
  );
  const collection: CommentCollection = {
    videoId,
    pages,
    comments: pages.flatMap((page) => page.comments),
    endReason: 'entry_exhausted',
    coverage: 'bounded_top_level_comments',
  };
  const job: Job = {
    id: 'synthetic-comments',
    type: 'comments',
    status: 'completed',
    title: 'comments',
    createdAt: '2026-10-28T10:00:00Z',
    updatedAt: '2026-10-28T10:00:01Z',
    progress: 1,
    phase: 'completed',
    logs: [],
    result: { commentCollection: collection },
  };
  return { job, collection };
}

test('comment bundle preserves native pointers/video binding and dates, excludes signed fields', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'studio-comment-bundle-'));
  try {
    const { job, collection } = fixture();
    const manifest = await produceBundle(job, path.join(root, 'bundle'), {
      sourceId: 'synthetic-comments',
      publicationUnit: 'seconds',
      material: 'fixture',
    });
    assert.equal(manifest.outcome, 'succeeded');
    assert.equal(manifest.comment_cursor?.native_resume_implemented, false);
    assert.equal(manifest.comment_cursor?.raw_value, 2);
    const bytes = await fs.readFile(path.join(root, 'bundle/records.jsonl'));
    assert.equal(sha256(bytes), manifest.records_sha256);
    const records = bytes
      .toString()
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    const body = await fs.readFile(
      path.join(root, 'bundle/objects', records[0].evidence_sha + '.bin'),
      'utf8',
    );
    const view = JSON.parse(body);
    assert(!body.includes('token=secret'));
    for (const record of records) {
      assert.equal(record.kind, 'comment');
      assert.equal(record.url, `https://www.douyin.com/video/${videoId}`);
      assert.equal(pointer(view, record.texts[0].locator), record.texts[0].text);
    }
    assert.equal(records[0].normalized_published_time.start_at, '2019-03-21T16:00:00+00:00');
    assert.equal(records[1].normalized_published_time, null);
    assert.equal(records[1].publication_unit, 'unknown');
    assert.equal(view.comment_pages[0].source_body_sha256, collection.pages[0].bodySha256);
    // collect.ts's existing archive stores result directly, rather than API nesting.
    job.result = collection as unknown as Job['result'];
    assert.equal(commentEvidence(job).rows.length, 2);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('truncated final page, repeated cursor and blocked partial comments never claim completion', async () => {
  const { job, collection } = fixture();
  collection.comments.pop();
  assert.equal(commentEvidence(job).complete, false);
  assert.equal(commentEvidence(job).cursor?.unexported_comment_versions, 1);
  assert.equal(commentEvidence(job).cursor?.requires_page_replay, true);
  const next = fixture();
  const raw = JSON.parse(next.collection.pages[1].rawBody);
  raw.cursor = 1;
  next.collection.pages[1] = parseCommentPage(
    Buffer.from(JSON.stringify(raw)),
    videoId,
    '2026-10-28T10:00:01Z',
  );
  next.collection.comments[1] = next.collection.pages[1].comments[0];
  assert.equal(commentEvidence(next.job).cursor?.repeated_cursor, true);
  assert.equal(commentEvidence(next.job).complete, false);
});

test('tampered comment body, cross-video ID, text and observation binding reject export', () => {
  for (const mutate of [
    (c: CommentCollection) => {
      c.pages[0].rawBody += ' ';
    },
    (c: CommentCollection) => {
      c.comments[0].videoId = '999999999';
    },
    (c: CommentCollection) => {
      c.comments[0].text = 'forged';
    },
    (c: CommentCollection) => {
      c.comments[0].observedAt = '2026-10-29T00:00:00Z';
    },
  ]) {
    const { job, collection } = fixture();
    mutate(collection);
    assert.throws(() => commentEvidence(job), /mismatch/);
  }
});

test('blocked comment bundle retains observed rows and zero-result stop', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'studio-comment-stop-'));
  try {
    const { job } = fixture();
    job.status = 'failed';
    job.error = '人工验证';
    const options = {
      sourceId: 'synthetic-stop',
      publicationUnit: 'seconds' as const,
      material: 'fixture' as const,
    };
    const partial = await produceBundle(job, path.join(root, 'partial'), options);
    assert.equal(partial.outcome, 'blocked_verification');
    assert.equal(partial.record_count, 2);
    job.result = undefined;
    const empty = await produceBundle(job, path.join(root, 'empty'), options);
    assert.equal(empty.outcome, 'blocked_verification');
    assert.equal(empty.record_count, 0);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('anchor conversion preserves purpose/proof, requires explicit source, never invents family or relation', () => {
  const anchor: BilibiliAnchor = {
    family_id: 'bilibili-family-1',
    purpose: 'source',
    terms: ['别称'],
    evidence_refs: [
      { evidence_sha: 'a'.repeat(64), locator: '/segments/0/text', span: [0, 2], original_text: '原话' },
    ],
  };
  assert.equal(anchorRequests(anchor).stop, 'missing_source');
  assert.equal(
    anchorRequests({
      ...anchor,
      source_hint: { kind: 'url', value: `https://www.douyin.com/video/${videoId}` },
    }).detail_url,
    `https://www.douyin.com/video/${videoId}`,
  );
  assert.throws(
    () => anchorRequests({ ...anchor, source_hint: { kind: 'url', value: 'https://example.com/video/123' } }),
    /canonical/,
  );
  const named = anchorRequests({ ...anchor, source_hint: { kind: 'named', value: '具名原作' } });
  assert.equal(named.searches[0].query, '具名原作');
  const usage = anchorRequests({ ...anchor, purpose: 'usage' });
  assert.equal(usage.context.purpose, 'usage');
  assert.equal(usage.searches[0].family_id, anchor.family_id);
  assert.deepEqual(usage.searches[0].evidence_refs, anchor.evidence_refs);
  assert.equal(usage.context.relation_status, 'candidate');
  assert.equal(anchorRequests({ ...anchor, purpose: 'derivative' }).context.purpose, 'derivative');
});
