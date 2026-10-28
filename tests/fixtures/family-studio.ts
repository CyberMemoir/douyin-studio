/** Local-only fixture: real API/receipt store, no browser, cookie, or upstream network. */
import fs from 'node:fs/promises';
import { Store } from '../../server/store.js';
import { JobQueue } from '../../server/jobs.js';
import { createApp, errorHandler } from '../../server/app.js';
import type { DouyinBrowser } from '../../server/browser.js';
import type { AddressInfo } from 'node:net';

if (!process.argv[2]) throw new Error('Explicit fixture data directory required');
const store = new Store(process.argv[2]);
await store.init();
const queue = new JobQueue(store);
const fixture = JSON.parse(await fs.readFile(new URL('./family-search.json', import.meta.url), 'utf8'));
const browser = {
  async search(query: string) {
    return structuredClone(fixture.result.videos).map(
      (row: { searchContext: { requestedQuery: string }; mediaUrls: string[] }) => ({
        ...row,
        searchContext: { ...row.searchContext, requestedQuery: query },
        mediaUrls: [],
      }),
    );
  },
  async status() {
    return {
      connected: true,
      login: 'likely',
      message: 'synthetic fixture only',
      checkedAt: new Date().toISOString(),
    };
  },
} as unknown as DouyinBrowser;
const app = createApp(store, browser, queue);
app.post('/fixture/checkpoint', async (_req, res) => {
  await queue.idle();
  await store.flush();
  res.json({ fixture: true, checkpointed: true });
});
app.use(errorHandler);
const server = app.listen(0, '127.0.0.1', () =>
  console.log(
    JSON.stringify({ origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, fixture: true }),
  ),
);
