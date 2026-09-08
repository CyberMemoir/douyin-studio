import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { Store } from '../server/store.js';
import { JobQueue } from '../server/jobs.js';
import { createApp, errorHandler } from '../server/app.js';
import type { DouyinBrowser } from '../server/browser.js';

test('API rejects cross-origin requests, validates input and never exposes media URLs', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'studio-api-'));
  const store = new Store(path.join(dir, '.data'));
  await store.init();
  const queue = new JobQueue(store);
  const fake = {
    status: async () => ({
      connected: true,
      login: 'likely',
      message: 'test',
      checkedAt: new Date().toISOString(),
    }),
    search: async () => [
      {
        id: '1234567890123456789',
        title: 'fixture',
        author: 'test',
        url: 'https://www.douyin.com/video/1234567890123456789',
        cover: '',
        duration: 1,
        likes: 0,
        comments: 0,
        createdAt: null,
        source: 'network',
        mediaUrls: ['https://v3.douyinvod.com/private-signed-url'],
      },
    ],
  } as unknown as DouyinBrowser;
  const app = createApp(store, fake, queue);
  app.use(errorHandler);
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
  const headers = { 'Content-Type': 'application/json', 'X-Studio-Client': '1' };
  try {
    assert.equal((await fetch(`${base}/health`)).status, 200);
    assert.equal(
      (
        await fetch(`${base}/search`, {
          method: 'POST',
          headers: { ...headers, Origin: 'https://evil.test' },
          body: '{}',
        })
      ).status,
      403,
    );
    assert.equal(
      (
        await fetch(`${base}/search`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: '{}',
        })
      ).status,
      403,
    );
    assert.equal(
      (await fetch(`${base}/search`, { method: 'POST', headers, body: JSON.stringify({ query: '' }) }))
        .status,
      400,
    );
    assert.equal(
      (
        await fetch(`${base}/downloads`, {
          method: 'POST',
          headers,
          body: JSON.stringify({ ids: ['1234567890123456789'] }),
        })
      ).status,
      404,
    );
    const created = await fetch(`${base}/search`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ query: 'test', limit: 10 }),
    });
    assert.equal(created.status, 202);
    await queue.idle();
    const text = await (await fetch(`${base}/state`)).text();
    assert(!text.includes('private-signed-url'));
    assert(!text.includes('mediaUrls'));
    assert.equal(JSON.parse(text).jobs[0].status, 'completed');
    assert.equal((await fetch(`${base}/jobs/${store.jobs[0].id}/export`)).status, 200);
    const contents = Buffer.concat([Buffer.from([0, 0, 0, 20]), Buffer.from('ftypisom'), Buffer.alloc(32)]);
    await fs.writeFile(path.join(store.downloads, 'fixture.mp4'), contents);
    store.jobs.unshift({
      ...store.jobs[0],
      id: 'download-fixture',
      type: 'download',
      status: 'completed',
      fileName: 'fixture.mp4',
    });
    const inline = await fetch(`${base}/downloads/download-fixture/file?inline=1`, {
      headers: { Range: 'bytes=0-11' },
    });
    assert.equal(inline.status, 206);
    assert.match(inline.headers.get('content-type')!, /video\/mp4/);
    assert.equal((await inline.arrayBuffer()).byteLength, 12);
    const attachment = await fetch(`${base}/downloads/download-fixture/file`);
    assert.equal(attachment.status, 200);
    assert.match(attachment.headers.get('content-disposition')!, /attachment/);
    assert.deepEqual(Buffer.from(await attachment.arrayBuffer()), contents);
    await fs.symlink(path.join(dir, 'outside.mp4'), path.join(store.downloads, 'linked.mp4'));
    store.jobs[0].fileName = 'linked.mp4';
    assert.equal((await fetch(`${base}/downloads/download-fixture/file`)).status, 404);
    assert.equal((await fetch(`${base}/download-missing`)).status, 404);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await queue.idle();
    await store.flush();
    await fs.rm(dir, { recursive: true, force: true });
  }
});
