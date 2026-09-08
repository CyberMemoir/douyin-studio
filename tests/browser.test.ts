import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium, type Page } from 'playwright';
import { DouyinBrowser, navigateDouyinPage } from '../server/browser.js';

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
