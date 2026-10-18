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

test('source media descriptors bind to durable resolve jobs and stay out of public snapshots', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'source-media-'));
  const id = '1234567890123456789';
  let calls = 0;
  let matched = true;
  const reader = {
    resolve: async () => {
      calls++;
      return {
        id,
        title: 'fixture',
        author: 'fixture',
        url: `https://www.douyin.com/video/${id}`,
        cover: '',
        duration: 2,
        likes: null,
        comments: null,
        createdAt: null,
        source: 'network',
        mediaUrls: ['https://v.douyinvod.com/video.mp4?private-token'],
        sourceMediaUrls: matched ? ['https://v.douyinvod.com/video.mp4?private-token'] : [],
        subtitleTracks: [
          {
            url: 'https://v.bytecdn.com/subtitle.vtt?private-caption-token',
            language: 'zh',
            label: 'subtitle',
            kind: 'subtitles',
          },
        ],
      };
    },
    status: async () => null,
  } as unknown as DouyinBrowser;
  const headers = {
    'Content-Type': 'application/json',
    'X-Studio-Client': '1',
    'Idempotency-Key': 'e'.repeat(64),
  };
  const store = new Store(directory);
  await store.init();
  const queue = new JobQueue(store);
  const app = createApp(store, reader, queue);
  app.use(errorHandler);
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const first = await (
      await fetch(`${base}/api/search`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ query: id, limit: 1, maxScrolls: 0 }),
      })
    ).json();
    await queue.idle();
    const descriptor = await (await fetch(`${base}/api/jobs/${first.id}/source-media`)).json();
    assert.equal(descriptor.videoId, id);
    assert.equal(descriptor.mediaUrls.length, 1);
    assert.equal(descriptor.subtitleTracks[0].language, 'zh');
    const duplicate = await (
      await fetch(`${base}/api/search`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ query: id, limit: 1, maxScrolls: 0 }),
      })
    ).json();
    assert.equal(duplicate.id, first.id);
    assert.equal(calls, 1);
    matched = false;
    const fallbackJob = await (
      await fetch(`${base}/api/search`, {
        method: 'POST',
        headers: { ...headers, 'Idempotency-Key': 'f'.repeat(64) },
        body: JSON.stringify({ query: id, limit: 1, maxScrolls: 0 }),
      })
    ).json();
    await queue.idle();
    assert.deepEqual(
      (await (await fetch(`${base}/api/jobs/${fallbackJob.id}/source-media`)).json()).mediaUrls,
      [],
    );
    // A later UI fallback must not replace the original job's matched receipt.
    assert.deepEqual(await (await fetch(`${base}/api/jobs/${first.id}/source-media`)).json(), descriptor);
    for (const endpoint of [
      '/api/state',
      `/api/jobs/${first.id}`,
      `/api/receipts/${headers['Idempotency-Key']}`,
      `/api/jobs/${first.id}/export`,
    ]) {
      assert(!(await (await fetch(base + endpoint)).text()).includes('private-'));
    }
    assert.equal(
      (await fetch(`${base}/api/jobs/${first.id}/source-media`, { headers: { Origin: 'https://evil.test' } }))
        .status,
      403,
    );
    assert.equal((await fetch(`${base}/api/jobs/missing/source-media`)).status, 409);
    await store.flush();
    const restarted = new Store(directory);
    await restarted.init();
    assert.deepEqual(restarted.sourceMedia.get(first.id), descriptor);
    assert(!JSON.stringify(restarted.snapshot()).includes('private-'));
    await restarted.flush();
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await queue.idle();
    await store.flush();
    await fs.rm(directory, { recursive: true, force: true });
  }
});
