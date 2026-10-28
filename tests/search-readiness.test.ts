import test from 'node:test';
import assert from 'node:assert/strict';
import { waitForSearchData } from '../server/browser.js';

test('search waits for data readiness instead of treating an HTML shell as results', async () => {
  let checks = 0;
  await waitForSearchData(
    () => checks >= 2,
    async () => {
      checks++;
    },
    new AbortController().signal,
    1500,
  );
  assert.equal(checks, 2);
});

test('access restriction interrupts readiness wait before accepting results', async () => {
  await assert.rejects(
    waitForSearchData(
      () => true,
      async () => {
        throw new Error('人工验证');
      },
      new AbortController().signal,
    ),
    /人工验证/,
  );
});
