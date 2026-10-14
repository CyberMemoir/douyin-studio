import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium, type Page } from 'playwright';
import type { JobContext } from '../server/jobs.js';
import {
  DouyinBrowser,
  detectDouyinBlock,
  isKeywordSearchResponse,
  navigateDouyinPage,
} from '../server/browser.js';

test('CDP attachment preserves defaults and opens an empty default context before checking login', async (t) => {
  const old = process.env.DOUYIN_CDP_URL;
  process.env.DOUYIN_CDP_URL = 'http://127.0.0.1:9999';
  let opened = 0;
  let disconnected = false;
  const pages: object[] = [];
  const context = {
    pages: () => pages,
    async newPage() {
      opened++;
      const page = {};
      pages.push(page);
      return page;
    },
    async cookies() {
      assert(pages.length > 0, 'Storage.getCookies must not run with an unmaterialized default profile');
      return [{ name: 'sessionid', value: 'test-session', expires: -1 }];
    },
  };
  t.mock.method(chromium, 'connectOverCDP', async (endpoint: string, options: { noDefaults?: boolean }) => {
    assert.equal(endpoint, 'http://127.0.0.1:9999');
    assert.equal(options.noDefaults, true);
    return {
      contexts: () => [context],
      isConnected: () => true,
      on() {},
      async close() {
        disconnected = true;
      },
    };
  });
  try {
    const browser = new DouyinBrowser('/unused-test-directory');
    assert.equal((await browser.status()).login, 'likely');
    assert.equal((await browser.status()).connected, true);
    assert.equal(opened, 1);
    await browser.close();
    assert(disconnected);
    assert.equal(pages.length, 1, 'disconnect must not close an external browser page');
  } finally {
    if (old === undefined) delete process.env.DOUYIN_CDP_URL;
    else process.env.DOUYIN_CDP_URL = old;
  }
});

test('verification interstitial with an empty top-level body requests human attention', () => {
  assert.match(
    detectDouyinBlock('https://www.douyin.com/search/example?type=video', '验证码中间页', '    ') || '',
    /人工验证/,
  );
  assert.equal(
    detectDouyinBlock('https://www.douyin.com/video/123456789', '验证码是什么 - 抖音', '普通视频介绍'),
    null,
  );
});

test('keyword search rejects account posts, recommendations and another keyword response', () => {
  assert(
    isKeywordSearchResponse(
      'https://www.douyin.com/aweme/v1/web/general/search/single/?keyword=大狗叫',
      '大狗叫',
    ),
  );
  assert.equal(
    isKeywordSearchResponse('https://www.douyin.com/aweme/v1/web/aweme/post/?keyword=大狗叫', '大狗叫'),
    false,
  );
  assert.equal(isKeywordSearchResponse('https://www.douyin.com/aweme/v1/web/aweme/feed/', '大狗叫'), false);
  assert.equal(
    isKeywordSearchResponse(
      'https://www.douyin.com/aweme/v1/web/general/search/single/?keyword=其他词',
      '大狗叫',
    ),
    false,
  );
});

test('search collector does not mix account payloads or generic page state into keyword results', async (t) => {
  const old = process.env.DOUYIN_CDP_URL;
  process.env.DOUYIN_CDP_URL = 'http://127.0.0.1:9999';
  let responseListener: ((response: unknown) => void) | undefined;
  const payload = (id: string, desc: string) => ({
    aweme_id: id,
    desc,
    author: { nickname: 'fixture' },
    video: {},
  });
  const background = payload('123456789', 'unrelated account video');
  const requested = payload('987654321', 'requested result');
  const response = (url: string, value: unknown) => ({
    url: () => url,
    ok: () => true,
    status: () => 200,
    headers: () => ({ 'content-type': 'application/json' }),
    body: async () => Buffer.from(JSON.stringify(value)),
  });
  const page = {
    setDefaultTimeout() {},
    on(_event: string, listener: (response: unknown) => void) {
      responseListener = listener;
    },
    off() {},
    async goto() {
      responseListener!(response('https://www.douyin.com/aweme/v1/web/aweme/post/', background));
      responseListener!(
        response('https://www.douyin.com/aweme/v1/web/general/search/single/?keyword=keyword', requested),
      );
    },
    url: () => 'https://www.douyin.com/search/keyword',
    title: async () => 'search',
    isClosed: () => false,
    locator: () => ({ innerText: async () => '', allTextContents: async () => [JSON.stringify(background)] }),
    mouse: { wheel: async () => {} },
    close: async () => {},
  };
  const context = { pages: () => [page], newPage: async () => page };
  t.mock.method(chromium, 'connectOverCDP', async () => ({
    contexts: () => [context],
    isConnected: () => true,
    on() {},
    close: async () => {},
  }));
  const browser = new DouyinBrowser('/unused-test-directory');
  try {
    const job: JobContext = {
      job: {
        id: 'fixture-search',
        type: 'search',
        status: 'running',
        title: 'keyword',
        createdAt: '2026-10-06T00:00:00Z',
        updatedAt: '2026-10-06T00:00:00Z',
        progress: null,
        phase: 'search',
        logs: [],
      },
      signal: new AbortController().signal,
      log() {},
      update() {},
    };
    const videos = await browser.search('keyword', 1, job);
    assert.deepEqual(
      videos.map((video) => video.id),
      ['987654321'],
    );
    assert.equal(videos[0].searchContext?.responseKeyword, 'keyword');
    assert.equal(videos[0].searchContext?.keywordMatches, true);
    assert.equal(
      videos[0].searchContext?.responsePath,
      'https://www.douyin.com/aweme/v1/web/general/search/single/',
    );
  } finally {
    await browser.close();
    if (old === undefined) delete process.env.DOUYIN_CDP_URL;
    else process.env.DOUYIN_CDP_URL = old;
  }
});
test('normal in-site navigation interruption is tolerated but actual failures propagate', async () => {
  let waited = false;
  const page = {
    async goto() {
      throw new Error('page.goto: net::ERR_ABORTED; maybe frame was detached?');
    },
    isClosed: () => false,
    async waitForLoadState() {
      waited = true;
    },
    url: () => 'https://www.douyin.com/recommend',
  } as unknown as Page;
  await navigateDouyinPage(page, 'https://www.douyin.com/');
  assert(waited);
  await assert.rejects(
    navigateDouyinPage(
      {
        ...page,
        goto: async () => {
          throw new Error('Navigation timeout');
        },
      } as unknown as Page,
      'https://www.douyin.com/',
    ),
    /timeout/,
  );
});
