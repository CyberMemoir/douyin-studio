import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { Store } from '../server/store.js';
import { JobQueue } from '../server/jobs.js';
import { createApp, errorHandler } from '../server/app.js';
import type { DouyinBrowser } from '../server/browser.js';
import { parseNativePage, type NativeInput } from '../server/native-pages.js';

test('real local API retains native cursor/parent parameters and keyed receipts without upstream access', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'native-api-'));
  const store = new Store(root);
  await store.init();
  const queue = new JobQueue(store);
  const calls: NativeInput[] = [];
  const fake = {
    nativePage: async (input: NativeInput) => {
      calls.push(input);
      const row = { aweme_id: '223456789', desc: '合成结果' };
      const body =
        input.kind === 'search_page'
          ? {
              status_code: 0,
              data: [{ aweme_info: row }],
              cursor: 30,
              has_more: 0,
              extra: { logid: 'fixture-next' },
            }
          : { status_code: 0, aweme_list: [row], has_more: 0 };
      return parseNativePage(Buffer.from(JSON.stringify(body)), input, '2026-10-30T00:00:00Z');
    },
  } as unknown as DouyinBrowser;
  const app = createApp(store, fake, queue);
  app.use(errorHandler);
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
  const submit = (route: string, input: object, key: string) =>
    fetch(base + route, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Studio-Client': '1', 'Idempotency-Key': key },
      body: JSON.stringify(input),
    });
  try {
    const input = { query: '测试', cursor: 15, searchId: 'fixture-log', count: 8 };
    const response = await submit('/search/page', input, 'a'.repeat(64));
    assert.equal(response.status, 202);
    const job = await response.json();
    for (
      let i = 0;
      i < 100 && !['completed', 'failed'].includes(store.jobs.find((item) => item.id === job.id)!.status);
      i++
    )
      await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(store.jobs.find((item) => item.id === job.id)?.status, 'completed');
    const again = await (await submit('/search/page', input, 'a'.repeat(64))).json();
    assert.equal(again.id, job.id);
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0], { kind: 'search_page', ...input });
    const receipt = await (await fetch(base + '/receipts/' + 'a'.repeat(64))).json();
    assert.equal(receipt.result.nativePage.cursor, 30);
    assert.equal(receipt.result.nativePage.request.searchId, 'fixture-log');
    assert.equal(
      (await submit('/related', { videoId: 'invalid', excludedIds: [], count: 8 }, 'b'.repeat(64))).status,
      400,
    );
    const related = await (
      await submit('/related', { videoId: '123456789', excludedIds: ['323456789'], count: 8 }, 'c'.repeat(64))
    ).json();
    for (
      let i = 0;
      i < 100 && !['completed', 'failed'].includes(store.jobs.find((item) => item.id === related.id)!.status);
      i++
    )
      await new Promise((resolve) => setTimeout(resolve, 5));
    assert.deepEqual(calls[1], {
      kind: 'related',
      videoId: '123456789',
      excludedIds: ['323456789'],
      count: 8,
    });
  } finally {
    queue.cancelAll();
    await store.flush();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    await fs.rm(root, { recursive: true, force: true });
  }
});
