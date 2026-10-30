import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { nativeRequest, parseNativePage, type NativeInput } from '../server/native-pages.js';
import { DouyinBrowser } from '../server/browser.js';
import type { JobContext } from '../server/jobs.js';
import { chromium } from 'playwright';

const when = '2026-10-30T00:00:00Z';
const parent = '123456789';
const child = '223456789';
const search: NativeInput = {
  kind: 'search_page',
  query: '合成测试词',
  cursor: 15,
  searchId: 'fixture-search-id',
  count: 8,
};
const row = {
  aweme_id: child,
  desc: '合成素材',
  create_time: 1000,
  statistics: { digg_count: 2 },
  author: { uid: '123' },
};

test('native request contracts preserve exact offset/search_id and parent/filter IDs', () => {
  const request = nativeRequest(search);
  const params = new URLSearchParams(request.query);
  assert.equal(request.path, '/aweme/v1/web/general/search/single/');
  assert.equal(params.get('offset'), '15');
  assert.equal(params.get('search_id'), search.kind === 'search_page' ? search.searchId : '');
  assert.equal(params.get('keyword'), '合成测试词');
  const related = nativeRequest({
    kind: 'related',
    videoId: parent,
    excludedIds: [parent, child, child],
    count: 8,
  });
  assert.equal(related.path, '/aweme/v1/web/aweme/related/');
  assert.equal(new URLSearchParams(related.query).get('filterGids'), `${parent},${child}`);
  assert(!request.query.includes('a_bogus')); // No signing/risk-control implementation is smuggled into the bridge.
});

test('synthetic public-contract search and related parsing retain cursor/body identity and no silent row loss', () => {
  const parsed = parseNativePage(
    Buffer.from(
      JSON.stringify({
        status_code: 0,
        data: [{ aweme_info: row }, { unknown: 'unparsed' }],
        cursor: 30,
        has_more: 1,
        extra: { logid: 'fixture-next-id' },
      }),
    ),
    search,
    when,
  );
  assert.equal(parsed.nativePage.cursor, 30);
  assert.equal(parsed.nativePage.searchId, 'fixture-next-id');
  assert.equal(parsed.nativePage.unparsedRows, 1);
  assert.equal(parsed.nativePage.hasMore, true);
  assert.deepEqual(parsed.nativePage.ids, [child]);
  const related = parseNativePage(
    Buffer.from(JSON.stringify({ status_code: 0, aweme_list: [row], has_more: 0 })),
    { kind: 'related', videoId: parent, excludedIds: [], count: 8 },
    when,
  );
  assert.equal(related.videos[0].relatedContext?.parentVideoId, parent);
  assert.equal(related.videos[0].relatedContext?.bodySha256, related.nativePage.bodySha256);
  assert.equal(related.nativePage.cursor, null); // Related filter lists are not a made-up numeric cursor.
});

test('reported verify_check response never becomes exhausted; missing positive fields stay unknown', async () => {
  const sample = JSON.parse(
    await fs.readFile(new URL('./fixtures/native-verify-check.json', import.meta.url), 'utf8'),
  );
  assert.throws(
    () => parseNativePage(Buffer.from(JSON.stringify(sample.response)), search, when),
    /人工验证/,
  );
  const missing = parseNativePage(
    Buffer.from(JSON.stringify({ status_code: 0, data: [{ aweme_info: row }] })),
    search,
    when,
  );
  assert.equal(missing.nativePage.hasMore, null);
  assert.equal(missing.nativePage.cursor, null);
  assert.throws(
    () => parseNativePage(Buffer.from(JSON.stringify({ status_code: 2483 })), search, when),
    /重新登录/,
  );
});

test('native browser respects persisted access pause before connecting or fetching', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'native-page-paused-'));
  const pause = '{"reason":"access_restriction"}';
  await fs.writeFile(path.join(root, 'comments-access-pause.json'), pause);
  const browser = new DouyinBrowser(root);
  let connects = 0;
  (browser as unknown as { connect: () => Promise<never> }).connect = async () => {
    connects++;
    throw new Error('Connection must not occur');
  };
  const job = { signal: new AbortController().signal, log() {}, update() {} } as unknown as JobContext;
  try {
    await assert.rejects(browser.nativePage(search, job), /已暂停/);
    assert.equal(connects, 0);
    assert.equal(await fs.readFile(path.join(root, 'comments-access-pause.json'), 'utf8'), pause);
  } finally {
    await browser.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('ordinary browser bridge archives a reported soft refusal and persists pause without retry', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'native-page-soft-block-'));
  const previous = process.env.DOUYIN_CDP_URL;
  process.env.DOUYIN_CDP_URL = 'http://127.0.0.1:9999';
  const sample = JSON.parse(
    await fs.readFile(new URL('./fixtures/native-verify-check.json', import.meta.url), 'utf8'),
  );
  let current = 'https://www.douyin.com/';
  let fetches = 0;
  let wire: { path: string; query: string } | undefined;
  const page = {
    setDefaultTimeout() {},
    on() {},
    off() {},
    route: async () => {},
    goto: async (url: string) => {
      current = url;
    },
    url: () => current,
    title: async () => 'fixture',
    isClosed: () => false,
    locator: () => ({ innerText: async () => '' }),
    evaluate: async (_fn: unknown, request: { path: string; query: string }) => {
      fetches++;
      wire = request;
      return { status: 200, text: JSON.stringify(sample.response) };
    },
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
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const browser = new DouyinBrowser(root);
  const job = {
    job: { id: 'fixture-native-soft-block' },
    signal: new AbortController().signal,
    log() {},
    update() {},
  } as unknown as JobContext;
  try {
    const failed = assert.rejects(browser.nativePage(search, job), /人工验证/);
    await new Promise((resolve) => setImmediate(resolve));
    t.mock.timers.tick(20_000);
    await failed;
    assert.equal(fetches, 1);
    assert.equal(new URLSearchParams(wire!.query).get('offset'), '15');
    assert((await fs.readdir(path.join(root, 'native-pages'))).some((file) => file.endsWith('.bin')));
    const pause = await fs.readFile(path.join(root, 'comments-access-pause.json'), 'utf8');
    assert.equal(JSON.parse(pause).reason, 'access_restriction');
    await assert.rejects(browser.nativePage(search, job), /已暂停/);
    assert.equal(fetches, 1);
  } finally {
    await browser.close();
    await fs.rm(root, { recursive: true, force: true });
    if (previous === undefined) delete process.env.DOUYIN_CDP_URL;
    else process.env.DOUYIN_CDP_URL = previous;
  }
});
