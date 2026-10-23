import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { isCommentResponse, parseCommentPage, readCommentBody } from '../server/comments.js';
import { saveComments } from '../scripts/collect.js';
import type { Job } from '../shared/types.js';
import { chromium } from 'playwright';
import { DouyinBrowser } from '../server/browser.js';
import type { JobContext } from '../server/jobs.js';

const id = '1234567890123456789';
const body = Buffer.from(
  JSON.stringify({
    status_code: 0,
    cursor: 0,
    has_more: 0,
    comments: [{ cid: '111', aweme_id: id, text: '合成评论原句', user: { uid: '222' }, digg_count: 0 }],
  }),
);

test('a stalled comment response cannot hold the serial queue indefinitely', async () => {
  await assert.rejects(
    readCommentBody(() => new Promise<Buffer>(() => {}), 5),
    /超时/,
  );
});

test('only collect normal responses explicitly bound to the requested video', () => {
  assert(isCommentResponse(`https://www.douyin.com/aweme/v1/web/comment/list/?aweme_id=${id}`, id));
  assert(!isCommentResponse('https://www.douyin.com/aweme/v1/web/comment/list/?aweme_id=999', id));
  assert(!isCommentResponse(`https://evil.test/aweme/v1/web/comment/list/?aweme_id=${id}`, id));
  const page = parseCommentPage(body, id, '2026-10-14T00:00:00Z');
  assert.equal(page.comments[0].text, '合成评论原句');
  assert.equal(page.comments[0].likes, 0);
  assert.equal(page.comments[0].createdAt, null);
  assert.equal(page.bodySha256, createHash('sha256').update(body).digest('hex'));
  assert.throws(() => parseCommentPage(body, '999', ''), /其他作品/);
  assert.throws(() => parseCommentPage(Buffer.from('{"status_code":0}'), id, ''), /结构变化/);
});

test('comment export preserves raw evidence and does not automatically generate queries or proposals', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'comment-export-'));
  const page = parseCommentPage(body, id, '2026-10-14T00:00:00Z');
  const job = {
    id: 'fixture',
    type: 'comments',
    status: 'completed',
    result: {
      commentCollection: {
        videoId: id,
        comments: page.comments,
        pages: [page],
        endReason: 'entry_exhausted',
        coverage: 'bounded_top_level_comments',
      },
    },
  } as Job;
  try {
    const manifest = await saveComments(job, path.join(root, 'result'));
    assert.equal(manifest.source_count, 1);
    assert.equal(manifest.query_count, 0);
    assert.equal(manifest.candidate_count, 0);
    assert.equal(manifest.public_import_authorized, false);
    const record = JSON.parse((await fs.readFile(path.join(root, 'result/comments.jsonl'), 'utf8')).trim());
    assert.equal(record.text, '合成评论原句');
    assert.equal(record.is_actual_search_log, false);
    page.rawBody = '{}';
    await assert.rejects(saveComments(job, path.join(root, 'bad')), /指纹/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('normal browser comment collection binds pages and persists access pauses', async (t) => {
  const old = process.env.DOUYIN_CDP_URL;
  process.env.DOUYIN_CDP_URL = 'http://127.0.0.1:9999';
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'comment-browser-'));
  let listener: (response: unknown) => void = () => {};
  let restricted = false;
  let navigations = 0;
  const page = {
    setDefaultTimeout() {},
    on(event: string, callback: (response: unknown) => void) {
      if (event === 'response') listener = callback;
    },
    off() {},
    async goto() {
      navigations++;
      listener({
        url: () => `https://www.douyin.com/aweme/v1/web/comment/list/?aweme_id=${id}`,
        status: () => (restricted ? 403 : 200),
        ok: () => !restricted,
        body: async () => body,
      });
    },
    url: () => `https://www.douyin.com/video/${id}`,
    title: async () => 'fixture',
    isClosed: () => false,
    locator: () => ({ innerText: async () => '', first: () => ({ isVisible: async () => false }) }),
    close: async () => {},
    bringToFront: async () => {},
  };
  const context = { pages: () => [page], newPage: async () => page };
  t.mock.method(chromium, 'connectOverCDP', async () => ({
    contexts: () => [context],
    isConnected: () => true,
    on() {},
    close: async () => {},
  }));
  const browser = new DouyinBrowser(root);
  const job = {
    job: {
      id: 'fixture',
      type: 'comments',
      status: 'running',
      title: 'fixture',
      createdAt: '2026-10-14T00:00:00Z',
      updatedAt: '2026-10-14T00:00:00Z',
      progress: null,
      phase: 'comments',
      logs: [],
    },
    signal: new AbortController().signal,
    log() {},
    update() {},
  } as JobContext;
  try {
    const result = await browser.comments(id, 8, 0, job);
    assert.equal(result.comments[0].text, '合成评论原句');
    assert.equal(result.endReason, 'entry_exhausted');
    const finalPageBody = Buffer.from(
      JSON.stringify({
        status_code: 0,
        has_more: 0,
        comments: [1, 2, 3].map((cid) => ({ cid: String(cid), aweme_id: id, text: `comment ${cid}` })),
      }),
    );
    // Use the real browser response listener; no platform or CDP connection is made.
    page.goto = async () => {
      listener({
        url: () => `https://www.douyin.com/aweme/v1/web/comment/list/?aweme_id=${id}`,
        status: () => (restricted ? 403 : 200),
        ok: () => !restricted,
        body: async () => finalPageBody,
      });
    };
    for (const [limit, expected] of [
      [1, 'limit'],
      [3, 'entry_exhausted'],
      [5, 'entry_exhausted'],
    ] as const) {
      const finalPage = await browser.comments(id, limit, 0, job);
      assert.equal(finalPage.comments.length, Math.min(limit, 3));
      assert.equal(finalPage.pages[0].comments.length, 3);
      assert.equal(finalPage.endReason, expected);
    }
    restricted = true;
    await assert.rejects(browser.comments(id, 8, 0, job), /人工验证/);
    const count = navigations;
    await assert.rejects(browser.comments(id, 8, 0, job), /已暂停/);
    assert.equal(navigations, count);
  } finally {
    await browser.close();
    await fs.rm(root, { recursive: true, force: true });
    if (old === undefined) delete process.env.DOUYIN_CDP_URL;
    else process.env.DOUYIN_CDP_URL = old;
  }
});
