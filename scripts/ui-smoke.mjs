// Optional live smoke test. Requires a running local server and your logged-in Douyin browser.
// It performs a real search and downloads one result. Not run by CI.
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
if (!process.argv.includes('--live'))
  throw new Error('Pass --live to explicitly run a real search and download.');
const base = process.env.STUDIO_URL || 'http://127.0.0.1:4321';
const output = process.env.QA_OUTPUT || (await fs.mkdtemp(path.join(os.tmpdir(), 'douyin-studio-qa-')));
await fs.mkdir(output, { recursive: true });
const browser = await chromium.launch({
  headless: true,
  ...(process.env.QA_CHANNEL ? { channel: process.env.QA_CHANNEL } : {}),
});
const errors = [];
try {
  const page = await browser.newPage({ viewport: { width: 1536, height: 1024 } });
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(base, { waitUntil: 'networkidle' });
  await page.screenshot({ path: path.join(output, 'desktop.png'), fullPage: true });
  await page.getByRole('button', { name: '使用指南', exact: true }).click();
  assert.equal(await page.locator('h1').innerText(), '从第一次搜索开始。');
  await page.getByRole('button', { name: '视频搜索', exact: true }).click();
  await page.getByRole('button', { name: '检查连接', exact: true }).click();
  await page.getByRole('dialog').waitFor();
  await page.getByRole('heading', { name: '已连接本地浏览器', exact: true }).waitFor({ timeout: 20000 });
  await page.keyboard.press('Escape');
  assert.equal(await page.getByRole('dialog').count(), 0);
  await page.getByLabel('搜索关键词或抖音视频链接').fill('AI工具');
  await page.getByLabel('结果数量', { exact: true }).selectOption('10');
  await page.getByRole('button', { name: '搜索', exact: true }).click();
  await page.locator('.video-row').first().waitFor({ timeout: 90000 });
  assert((await page.locator('.video-row').count()) > 0);
  await page.waitForFunction(
    () => {
      const img = document.querySelector('.video-row img');
      return img && img.complete && img.naturalWidth > 0;
    },
    null,
    { timeout: 30000 },
  );
  await page.screenshot({ path: path.join(output, 'search.png') });
  await page.locator('.video-row input[type=checkbox]').first().check();
  await page.getByRole('button', { name: '下载所选', exact: true }).click();
  await page.getByRole('heading', { name: '把好内容，留在手边。', exact: true }).waitFor();
  await page.getByRole('button', { name: '预览视频', exact: true }).first().waitFor({ timeout: 180000 });
  await page.getByRole('button', { name: '预览视频', exact: true }).first().click();
  const video = page.locator('video');
  await video.waitFor();
  await page.waitForFunction(
    () => {
      const v = document.querySelector('video');
      return v && v.readyState >= 2 && Number.isFinite(v.duration) && v.duration > 0;
    },
    null,
    { timeout: 30000 },
  );
  await video.evaluate((el) => el.play());
  await page.waitForFunction(() => document.querySelector('video')?.currentTime > 0.2, null, {
    timeout: 15000,
  });
  const playback = await video.evaluate((el) => ({
    duration: el.duration,
    currentTime: el.currentTime,
    error: el.error?.message || null,
  }));
  assert(!playback.error);
  await page.screenshot({ path: path.join(output, 'preview.png'), fullPage: true });
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: '任务日志', exact: true }).first().click();
  assert((await page.locator('.job-logs li').count()) > 0);
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: '实时热点', exact: true }).click();
  const [refreshResponse] = await Promise.all([
    page.waitForResponse(
      (response) => response.url().endsWith('/api/trends') && response.request().method() === 'POST',
    ),
    page.getByRole('button', { name: '刷新热榜', exact: true }).click(),
  ]);
  const refreshedJob = await refreshResponse.json();
  await page.locator('.trend-list li').first().waitFor({ timeout: 90000 });
  const refreshDeadline = Date.now() + 90000;
  let finishedRefresh;
  while (Date.now() < refreshDeadline) {
    const latest = await (await fetch(`${base}/api/state`)).json();
    finishedRefresh = latest.jobs.find((job) => job.id === refreshedJob.id);
    if (finishedRefresh && !['queued', 'running'].includes(finishedRefresh.status)) break;
    await new Promise((resolve) => setTimeout(resolve, 350));
  }
  assert.equal(
    finishedRefresh?.status,
    'completed',
    finishedRefresh?.error || 'hot-list refresh did not complete',
  );
  await page.screenshot({ path: path.join(output, 'trends.png'), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('button', { name: '视频搜索', exact: true }).click();
  assert.equal(await page.locator('body').evaluate((el) => el.scrollWidth), 390);
  await page.screenshot({ path: path.join(output, 'mobile.png'), fullPage: true });
  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify(
      {
        ok: true,
        viewport: '1536x1024 + 390x844',
        videoPlayback: playback,
        consoleErrors: errors,
        screenshots: output,
      },
      null,
      2,
    ),
  );
} finally {
  await browser.close();
}
