import 'dotenv/config';
import path from 'node:path';
import fs from 'node:fs';
import express from 'express';
import { createServer as createViteServer } from 'vite';
import { Store } from './store.js';
import { DouyinBrowser } from './browser.js';
import { JobQueue } from './jobs.js';
import { createApp, errorHandler } from './app.js';

const port = Number(process.env.PORT || 4321);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('PORT 必须是 1024–65535 的整数');
const root = process.cwd();
const store = new Store(path.resolve(process.env.DOUYIN_DATA_DIR || path.join(root, '.data')));
await store.init();
const browser = new DouyinBrowser(store.root);
const queue = new JobQueue(store);
const app = createApp(store, browser, queue);
const production = process.argv.includes('--production') || process.env.NODE_ENV === 'production';
let vite: Awaited<ReturnType<typeof createViteServer>> | undefined;
if (production) {
  const dist = path.join(root, 'dist');
  if (!fs.existsSync(path.join(dist, 'index.html'))) throw new Error('请先执行 npm run build');
  app.use(express.static(dist, { index: false }));
  app.get('/{*path}', (_req, res) => res.sendFile(path.join(dist, 'index.html')));
} else {
  vite = await createViteServer({
    root,
    server: { middlewareMode: true, hmr: { port: port + 1, host: '127.0.0.1' }, fs: { strict: true } },
    appType: 'spa',
  });
  app.use(vite.middlewares);
}
app.use(errorHandler);
const server = app.listen(port, '127.0.0.1', () =>
  console.log(`\n  Douyin Studio\n  http://127.0.0.1:${port}\n  本地数据：${store.root}\n`),
);
server.on('error', (error) => {
  console.error(error.message);
  process.exitCode = 1;
  void shutdown();
});
let stopping = false;
async function shutdown() {
  if (stopping) return;
  stopping = true;
  server.close();
  server.closeAllConnections();
  queue.cancelAll();
  await browser.close();
  await queue.idle();
  await store.flush();
  await vite?.close();
}
for (const signal of ['SIGINT', 'SIGTERM'] as const)
  process.once(signal, () => {
    void shutdown();
  });
