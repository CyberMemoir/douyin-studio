import fs from 'node:fs';
import path from 'node:path';
import { chromium, type Browser, type BrowserContext, type Page, type Response } from 'playwright';
import type { Connection, StoredVideo, Trend } from '../shared/types.js';
import { extractPayload } from './normalize.js';
import { localCdpUrl, mediaUrl, parseVideoInput } from './validation.js';
import type { JobContext } from './jobs.js';

const HOME = 'https://www.douyin.com/';
const delay = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    signal.throwIfAborted();
    const done = () => {
      signal.removeEventListener('abort', stop);
      resolve();
    };
    const timer = setTimeout(done, ms);
    const stop = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    signal.addEventListener('abort', stop, { once: true });
  });

export class DouyinBrowser {
  private browser?: Browser;
  private context?: BrowserContext;
  private loginPage?: Page;
  constructor(private dataDir: string) {}

  private async connect(): Promise<BrowserContext> {
    if (this.context && (!this.browser || this.browser.isConnected())) {
      if (!this.context.pages().length) await this.context.newPage();
      return this.context;
    }
    if (process.env.DOUYIN_CDP_URL) {
      try {
        this.browser = await chromium.connectOverCDP(localCdpUrl(process.env.DOUYIN_CDP_URL), {
          noDefaults: true,
          timeout: 12000,
        });
        this.context = this.browser.contexts()[0];
        if (!this.context) throw new Error('浏览器未提供默认配置');
        this.browser.on('disconnected', () => {
          this.context = undefined;
          this.browser = undefined;
          this.loginPage = undefined;
        });
      } catch (error) {
        throw new Error(
          `连接自动化 Chrome 失败。请先打开原来的自动化浏览器，或移除 .env 中的 DOUYIN_CDP_URL 使用独立登录。${shortError(error)}`,
        );
      }
    } else {
      const profile = path.resolve(process.env.DOUYIN_PROFILE_DIR || path.join(this.dataDir, 'browser'));
      const macChrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
      const executablePath =
        process.env.DOUYIN_BROWSER_PATH ||
        (process.platform === 'darwin' && fs.existsSync(macChrome) ? macChrome : undefined);
      try {
        this.context = await chromium.launchPersistentContext(profile, {
          headless: false,
          ...(executablePath ? { executablePath } : {}),
          viewport: null,
          acceptDownloads: false,
        });
        this.context.on('close', () => {
          this.context = undefined;
          this.loginPage = undefined;
        });
      } catch (error) {
        throw new Error(
          `无法启动浏览器。安装 Chrome 或执行 npx playwright install chromium；专用浏览器目录不能被另一进程同时占用。${shortError(error)}`,
        );
      }
    }
    // On macOS Chrome may keep its CDP process alive after every window closes.
    // Materialize the default profile before Storage.getCookies and other context calls.
    if (!this.context!.pages().length) await this.context!.newPage();
    return this.context!;
  }

  async status(): Promise<Connection> {
    const context = await this.connect();
    // Inspect only this application's dedicated account session; never return cookie values.
    const cookies = await context.cookies(HOME);
    const session = cookies.some(
      (c) =>
        ['sessionid', 'sessionid_ss', 'sid_guard'].includes(c.name) &&
        c.value &&
        (c.expires === -1 || c.expires > Date.now() / 1000),
    );
    return {
      connected: true,
      login: session ? 'likely' : 'required',
      message: session
        ? '已检测到登录凭据，实际可用性以搜索结果为准。'
        : '请在自动化浏览器中扫码登录，然后点击“检查连接”。',
      checkedAt: new Date().toISOString(),
    };
  }

  async login(): Promise<Connection> {
    const context = await this.connect();
    if (!this.loginPage || this.loginPage.isClosed()) this.loginPage = await context.newPage();
    await navigateDouyinPage(this.loginPage, HOME);
    await this.loginPage.bringToFront();
    return this.status();
  }

  private async page<T>(job: JobContext, action: (page: Page) => Promise<T>): Promise<T> {
    job.signal.throwIfAborted();
    job.log('连接本地自动化浏览器');
    const context = await this.connect();
    job.signal.throwIfAborted();
    const page = await context.newPage();
    page.setDefaultTimeout(10000);
    const abort = () => {
      void page.close().catch(() => {});
    };
    job.signal.addEventListener('abort', abort, { once: true });
    let needsAttention = false;
    try {
      return await action(page);
    } catch (error) {
      if (!job.signal.aborted && /人工验证|重新登录/.test(error instanceof Error ? error.message : '')) {
        needsAttention = true;
        if (this.loginPage && this.loginPage !== page) await this.loginPage.close().catch(() => {});
        this.loginPage = page;
        await page.bringToFront().catch(() => {});
      }
      throw error;
    } finally {
      job.signal.removeEventListener('abort', abort);
      if (!needsAttention) await page.close().catch(() => {});
    }
  }

  private capture(page: Page) {
    const videos = new Map<string, StoredVideo>();
    const trends = new Map<string, Trend>();
    const pending = new Set<Promise<void>>();
    const ingest = (data: unknown) => {
      const parsed = extractPayload(data);
      for (const v of parsed.videos)
        if (!videos.has(v.id) || v.mediaUrls.length >= videos.get(v.id)!.mediaUrls.length)
          videos.set(v.id, v);
      for (const t of parsed.trends) trends.set(t.word, t);
    };
    const listener = (response: Response) => {
      const url = new URL(response.url());
      if (
        !(url.hostname === 'douyin.com' || url.hostname.endsWith('.douyin.com')) ||
        !/(aweme|search|hot|trending)/i.test(url.pathname) ||
        !response.ok()
      )
        return;
      if (Number(response.headers()['content-length'] || 0) > 12_000_000) return;
      const task = (async () => {
        try {
          const body = await response.body();
          if (body.length < 12_000_000) ingest(JSON.parse(body.toString('utf8')));
        } catch {
          /* Non-JSON and interrupted requests are expected during navigation. */
        }
      })();
      pending.add(task);
      void task.finally(() => pending.delete(task));
    };
    page.on('response', listener);
    return {
      videos,
      trends,
      async finish() {
        await Promise.allSettled([...pending]);
        const jsonScripts = await page
          .locator('script#RENDER_DATA, script#__NEXT_DATA__, script[type="application/json"]')
          .allTextContents()
          .catch(() => []);
        for (const text of jsonScripts) {
          if (text.length > 12_000_000) continue;
          for (const encoded of [false, true]) {
            try {
              ingest(JSON.parse(encoded ? decodeURIComponent(text) : text));
              break;
            } catch {
              /* Other script formats do not contain result data. */
            }
          }
        }
      },
      stop: () => page.off('response', listener),
    };
  }

  private async blocked(page: Page): Promise<string | null> {
    const url = page.url();
    if (/passport|\/login\b/.test(url)) return '抖音要求重新登录，请打开登录窗口完成扫码。';
    const visible = await page
      .locator('body')
      .innerText({ timeout: 3000 })
      .catch(() => '');
    if (
      /请完成下方验证|请完成验证后|拖动滑块完成|请按顺序点击|验证码验证|访问过于频繁|操作频繁/.test(visible)
    )
      return '页面需要人工验证或暂时限制访问，请在抖音浏览器中完成处理后重试。';
    if (/页面不见了|页面不见啦|视频已删除|作品已删除|视频暂时无法查看|该视频已下架/.test(visible))
      return '视频或页面已不可用，请换一个视频链接。';
    return null;
  }

  async search(query: string, limit: number, job: JobContext): Promise<StoredVideo[]> {
    return this.page(job, async (page) => {
      const captured = this.capture(page);
      try {
        job.log(`搜索“${query}”，等待抖音返回结果`);
        await navigateDouyinPage(
          page,
          `https://www.douyin.com/search/${encodeURIComponent(query)}?type=video`,
        );
        for (let round = 0; round < 7; round++) {
          await delay(round === 0 ? 6500 : 1300, job.signal);
          const block = await this.blocked(page);
          if (block) throw new Error(block);
          if (captured.videos.size >= limit) break;
          await page.mouse.wheel(0, 900);
        }
        await captured.finish();
        const videos = [...captured.videos.values()];
        if (videos.length < limit) {
          const dom = await this.domVideos(page);
          for (const v of dom) if (!videos.some((item) => item.id === v.id)) videos.push(v);
        }
        if (!videos.length) {
          const status = await this.status();
          throw new Error(
            status.login === 'required'
              ? '搜索没有返回视频，请先扫码登录再重试。'
              : '本次页面没有返回可识别的视频结果。请换一个关键词，或粘贴视频分享链接；不会使用示例数据替代。',
          );
        }
        job.log(`已获取 ${Math.min(videos.length, limit)} 条视频信息`);
        return videos.slice(0, limit);
      } finally {
        captured.stop();
      }
    });
  }

  private async domVideos(page: Page): Promise<StoredVideo[]> {
    return page.evaluate(() => {
      const results: StoredVideo[] = [];
      const seen = new Set<string>();
      for (const el of document.querySelectorAll<HTMLAnchorElement>('a[href]')) {
        const id = el.href.match(/(?:\/video\/|modal_id=)(\d{8,30})/)?.[1];
        if (!id || seen.has(id)) continue;
        seen.add(id);
        const card = el.closest('li, article, [data-e2e="search-result"]') || el;
        const image = card.querySelector('img');
        results.push({
          id,
          title: (el.innerText || image?.alt || card.textContent || '未命名视频').trim().slice(0, 500),
          author: '待解析',
          url: `https://www.douyin.com/video/${id}`,
          cover: image?.src || '',
          duration: 0,
          likes: null,
          comments: null,
          createdAt: null,
          source: 'page',
          mediaUrls: [],
        });
      }
      return results;
    });
  }

  async resolve(input: string, job: JobContext): Promise<StoredVideo> {
    const url = parseVideoInput(input);
    if (!url) throw new Error('请提供抖音视频链接或视频 ID');
    return this.page(job, async (page) => {
      const captured = this.capture(page);
      try {
        job.log('打开视频详情，解析页面提供的视频源');
        await navigateDouyinPage(page, url);
        for (let i = 0; i < 5; i++) {
          await delay(i === 0 ? 4000 : 1500, job.signal);
          const block = await this.blocked(page);
          if (block) throw new Error(block);
          const id = page.url().match(/(?:\/video\/|modal_id=)(\d{8,30})/)?.[1];
          if (id && captured.videos.get(id)?.mediaUrls.length) break;
        }
        await captured.finish();
        const id =
          page.url().match(/(?:\/(?:video|note)\/|modal_id=)(\d{8,30})/)?.[1] ||
          url.match(/\/video\/(\d{8,30})/)?.[1];
        if (!id) throw new Error('分享链接没有跳转到视频详情，请复制完整视频链接重试。');
        let video = captured.videos.get(id);
        const media = await page.evaluate(() => {
          const el = document.querySelector('video');
          return {
            src: el?.currentSrc || el?.src || '',
            duration: el && Number.isFinite(el.duration) ? el.duration : 0,
            poster: el?.poster || '',
            title: document.title,
          };
        });
        if (!video)
          video = {
            id,
            title: media.title.replace(/\s*[-–]\s*抖音.*$/, '') || '抖音视频',
            author: '待解析',
            url: `https://www.douyin.com/video/${id}`,
            cover: media.poster,
            duration: Math.round(media.duration),
            likes: null,
            comments: null,
            createdAt: null,
            source: 'page',
            mediaUrls: [],
          };
        if (media.src) {
          try {
            mediaUrl(media.src);
            if (!video.mediaUrls.includes(media.src)) video.mediaUrls.unshift(media.src);
          } catch {
            /* Blob and non-platform streams cannot be directly saved. */
          }
        }
        job.log(
          video.mediaUrls.length ? '视频信息与可下载地址已解析' : '已解析视频信息；尚未获得可保存的视频流',
        );
        return video;
      } finally {
        captured.stop();
      }
    });
  }

  async trends(job: JobContext): Promise<Trend[]> {
    return this.page(job, async (page) => {
      const captured = this.capture(page);
      try {
        job.log('打开抖音，获取当前热榜');
        await navigateDouyinPage(page, HOME);
        await delay(6000, job.signal);
        if (!captured.trends.size) {
          const hot = page.getByText('热榜', { exact: true }).first();
          if (await hot.isVisible().catch(() => false)) await hot.click().catch(() => {});
          await delay(2500, job.signal);
        }
        const block = await this.blocked(page);
        if (block) throw new Error(block);
        await captured.finish();
        let trends = [...captured.trends.values()].sort((a, b) => a.rank - b.rank);
        if (!trends.length) {
          trends = await page.evaluate(() => {
            const header = [...document.querySelectorAll('h1,h2,h3,span,div')].find((el) =>
              /^(抖音热榜|热榜)$/.test(el.textContent?.trim() || ''),
            );
            let root = header?.parentElement;
            for (let i = 0; i < 4 && root && root.querySelectorAll('a[href*="search"]').length < 5; i++)
              root = root.parentElement;
            if (!root || root === document.body) return [];
            const seen = new Set<string>();
            return [...root.querySelectorAll<HTMLAnchorElement>('a[href*="search"]')]
              .map((el) => {
                const title = el.innerText
                  .replace(/^\d+\s*/, '')
                  .replace(/\s+\d+(?:\.\d+)?万.*$/, '')
                  .trim();
                if (!title || seen.has(title)) return null;
                seen.add(title);
                return { word: title, rank: seen.size, heat: null, label: '' };
              })
              .filter((item): item is NonNullable<typeof item> => !!item)
              .slice(0, 50);
          });
        }
        if (!trends.length)
          throw new Error('当前页面没有返回热榜。请检查登录或稍后刷新；不会展示编造的热点。');
        job.log(`已获取 ${trends.length} 条实时热点`);
        return trends.slice(0, 50);
      } finally {
        captured.stop();
      }
    });
  }

  async close() {
    if (this.browser)
      await this.browser.close().catch(() => {}); // Disconnect, leave the external Chrome running.
    else await this.context?.close().catch(() => {});
    this.context = undefined;
    this.browser = undefined;
  }
}

export async function navigateDouyinPage(page: Page, url: string): Promise<void> {
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
  } catch (error) {
    const message = error instanceof Error ? error.message : '';
    // Douyin can replace its initial navigation with an in-site redirect.
    // Only tolerate that specific interruption, not timeouts or a closed page.
    if (!/net::ERR_ABORTED|interrupted by another navigation/i.test(message) || page.isClosed()) throw error;
    await page.waitForLoadState('domcontentloaded', { timeout: 15000 }).catch(() => {});
    const current = new URL(page.url());
    if (
      current.hostname !== 'douyin.com' &&
      !current.hostname.endsWith('.douyin.com') &&
      current.hostname !== 'www.iesdouyin.com'
    ) {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
    }
  }
}

function shortError(error: unknown): string {
  const message = error instanceof Error ? error.message.split('\n')[0] : '';
  return message ? `（${message.slice(0, 180)}）` : '';
}
