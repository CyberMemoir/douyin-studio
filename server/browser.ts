import fs from 'node:fs';
import path from 'node:path';
import { chromium, type Browser, type BrowserContext, type Page, type Response } from 'playwright';
import type {
  Connection,
  StoredVideo,
  Trend,
  CommentCollection,
  CommentPage,
  CommentRecord,
} from '../shared/types.js';
import { isCommentResponse, parseCommentPage, readCommentBody } from './comments.js';
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
  private accessPaused = false;
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
          headless: process.env.DOUYIN_HEADLESS === 'true',
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
    if (this.accessPaused || fs.existsSync(path.join(this.dataDir, 'comments-access-pause.json')))
      throw new Error('读取已暂停，需要人工处理访问提醒后显式恢复');
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
      await this.saveFailureDiagnostics(page, job).catch(() => {});
      if (!job.signal.aborted && /人工验证|重新登录/.test(error instanceof Error ? error.message : '')) {
        this.persistAccessPause();
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

  private persistAccessPause() {
    this.accessPaused = true;
    fs.mkdirSync(this.dataDir, { recursive: true, mode: 0o700 });
    const file = path.join(this.dataDir, 'comments-access-pause.json');
    const descriptor = fs.openSync(`${file}.tmp`, 'w', 0o600);
    try {
      fs.writeFileSync(
        descriptor,
        JSON.stringify({ pausedAt: new Date().toISOString(), reason: 'access_restriction' }),
      );
      fs.fsyncSync(descriptor);
    } finally {
      fs.closeSync(descriptor);
    }
    fs.renameSync(`${file}.tmp`, file);
    if (process.platform !== 'win32') {
      const directory = fs.openSync(this.dataDir, 'r');
      try {
        fs.fsyncSync(directory);
      } finally {
        fs.closeSync(directory);
      }
    }
  }

  private async saveFailureDiagnostics(page: Page, job: JobContext) {
    const directory = process.env.DOUYIN_DIAGNOSTICS_DIR;
    if (!directory || page.isClosed() || job.signal.aborted) return;
    await fs.promises.mkdir(directory, { recursive: true, mode: 0o700 });
    const url = new URL(page.url());
    const snapshot = {
      observedAt: new Date().toISOString(),
      url: `${url.origin}${url.pathname}`,
      title: await page.title().catch(() => ''),
      visibleText: (
        await page
          .locator('body')
          .innerText({ timeout: 3000 })
          .catch(() => '')
      ).slice(0, 30000),
    };
    await fs.promises.writeFile(
      path.join(directory, `${job.job.id}-page.json`),
      JSON.stringify(snapshot, null, 2),
      { mode: 0o600 },
    );
    await page.screenshot({
      path: path.join(directory, `${job.job.id}-page.png`),
      fullPage: false,
      timeout: 5000,
    });
    job.log('已保存本地失败页面诊断（不含请求查询参数或 Cookie）');
  }

  private capture(page: Page, searchQuery?: string) {
    let restriction: Error | undefined;
    const videos = new Map<string, StoredVideo>();
    const trends = new Map<string, Trend>();
    const pending = new Set<Promise<void>>();
    const responses: {
      path: string;
      status: number;
      contentType: string;
      videos?: number;
      trends?: number;
      parseError?: boolean;
    }[] = [];
    const ingest = (data: unknown, searchContext?: StoredVideo['searchContext']) => {
      const parsed = extractPayload(data);
      for (const v of parsed.videos)
        if (!videos.has(v.id) || v.mediaUrls.length >= videos.get(v.id)!.mediaUrls.length)
          videos.set(v.id, searchContext ? { ...v, searchContext } : v);
      for (const t of parsed.trends) trends.set(t.word, t);
      return parsed;
    };
    const listener = (response: Response) => {
      const url = new URL(response.url());
      if (
        !(url.hostname === 'douyin.com' || url.hostname.endsWith('.douyin.com')) ||
        !/(aweme|search|hot|trending)/i.test(url.pathname) ||
        (searchQuery !== undefined && !isKeywordSearchResponse(url.href, searchQuery))
      )
        return;
      const summary = {
        path: `${url.origin}${url.pathname}`,
        status: response.status(),
        contentType: response.headers()['content-type'] || '',
      } as (typeof responses)[number];
      if (responses.length < 100) responses.push(summary);
      if ([401, 403, 412, 429, 461, 471].includes(response.status())) {
        restriction = new Error(`读取需要人工验证（HTTP ${response.status()}），停止访问`);
        try {
          this.persistAccessPause();
        } catch {
          restriction = new Error('人工验证暂停记录写入失败；停止读取并检查磁盘');
        }
        return;
      }
      if (!response.ok()) return;
      if (Number(response.headers()['content-length'] || 0) > 12_000_000) return;
      const task = (async () => {
        try {
          const body = await readCommentBody(() => response.body());
          if (body.length < 12_000_000) {
            const payload = JSON.parse(body.toString('utf8'));
            const pageUrl = new URL(page.url());
            const responseKeyword = url.searchParams.get('keyword');
            const searchContext =
              searchQuery === undefined
                ? undefined
                : {
                    responsePath: `${url.origin}${url.pathname}`,
                    pagePath: `${pageUrl.origin}${pageUrl.pathname}`,
                    requestedQuery: searchQuery,
                    responseKeyword,
                    keywordMatches: responseKeyword === null ? null : responseKeyword === searchQuery,
                    observedAt: new Date().toISOString(),
                  };
            const parsed = ingest(payload, searchContext);
            summary.videos = parsed.videos.length;
            summary.trends = parsed.trends.length;
          }
        } catch {
          summary.parseError = true;
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
      responses,
      check() {
        if (restriction) throw restriction;
      },
      async finish() {
        await Promise.allSettled([...pending]);
        if (restriction) throw restriction;
        // Generic application state can include the signed-in account's posts or recommendations.
        if (searchQuery !== undefined) return;
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
    const [title, visible] = await Promise.all([
      page.title().catch(() => ''),
      page
        .locator('body')
        .innerText({ timeout: 3000 })
        .catch(() => ''),
    ]);
    return detectDouyinBlock(page.url(), title, visible);
  }

  async search(query: string, limit: number, job: JobContext, maxScrolls = 2): Promise<StoredVideo[]> {
    return this.page(job, async (page) => {
      const captured = this.capture(page, query);
      try {
        job.log(`搜索“${query}”，等待抖音返回结果`);
        await navigateDouyinPage(
          page,
          `https://www.douyin.com/search/${encodeURIComponent(query)}?type=video`,
        );
        for (let round = 0; round <= maxScrolls; round++) {
          await delay(round === 0 ? 6500 : 1500, job.signal);
          captured.check();
          const block = await this.blocked(page);
          if (block) throw new Error(block);
          if (captured.videos.size >= limit || round === maxScrolls) break;
          await delay(20_000, job.signal);
          captured.check();
          const blockBeforeScroll = await this.blocked(page);
          if (blockBeforeScroll) throw new Error(blockBeforeScroll);
          await page.mouse.wheel(0, 900);
        }
        await captured.finish();
        const videos = [...captured.videos.values()];
        if (!videos.length) {
          if (process.env.DOUYIN_DIAGNOSTICS_DIR) {
            try {
              await fs.promises.mkdir(process.env.DOUYIN_DIAGNOSTICS_DIR, { recursive: true, mode: 0o700 });
              await fs.promises.writeFile(
                path.join(process.env.DOUYIN_DIAGNOSTICS_DIR, `${job.job.id}-responses.json`),
                JSON.stringify(captured.responses, null, 2),
                { mode: 0o600 },
              );
            } catch {
              /* Optional diagnostics must not replace the search failure. */
            }
          }
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
          captured.check();
          const block = await this.blocked(page);
          if (block) throw new Error(block);
          const id = page.url().match(/(?:\/video\/|modal_id=)(\d{8,30})/)?.[1];
          if (id && captured.videos.get(id)?.mediaUrls.length) break;
        }
        await captured.finish();
        const id = resolveDetailId(url, page.url());
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
        const requestedPage = new URL(url);
        return {
          ...video,
          detailContext: {
            requestedUrl: `${requestedPage.origin}${requestedPage.pathname}`,
            resolvedUrl: `https://www.douyin.com/video/${id}`,
            observedAt: new Date().toISOString(),
            observationBasis: 'detail_result_assembly',
          },
        };
      } finally {
        captured.stop();
      }
    });
  }

  async comments(
    videoId: string,
    limit: number,
    maxScrolls: number,
    job: JobContext,
  ): Promise<CommentCollection> {
    return this.page(job, async (page) => {
      const comments = new Map<string, CommentRecord>();
      const pages: CommentPage[] = [];
      const pending = new Set<Promise<void>>();
      let failure: Error | undefined;
      const listener = (response: Response) => {
        if (!isCommentResponse(response.url(), videoId)) return;
        if ([401, 403, 412, 429, 461, 471].includes(response.status())) {
          failure = new Error(`评论读取需要人工验证（HTTP ${response.status()}），停止访问`);
          return;
        }
        if (pages.length >= maxScrolls + 1 || failure) return;
        const task = (async () => {
          try {
            if (!response.ok()) throw new Error(`评论接口 HTTP ${response.status()}`);
            const result = parseCommentPage(
              await readCommentBody(() => response.body()),
              videoId,
              new Date().toISOString(),
            );
            if (resolveDetailId(`https://www.douyin.com/video/${videoId}`, page.url()) !== videoId)
              throw new Error('评论页跳转到其他作品');
            if (!pages.some((entry) => entry.bodySha256 === result.bodySha256)) pages.push(result);
            for (const comment of result.comments)
              if (!comments.has(comment.id)) comments.set(comment.id, comment);
          } catch (error) {
            failure = error instanceof Error ? error : new Error('评论解析失败');
          }
        })();
        pending.add(task);
        void task.finally(() => pending.delete(task));
      };
      page.on('response', listener);
      try {
        await navigateDouyinPage(page, `https://www.douyin.com/video/${videoId}`);
        await delay(1500, job.signal);
        const block = await this.blocked(page);
        if (block) throw new Error(block);
        if (failure) throw failure;
        const trigger = page.locator('[data-e2e="comment-icon"]').first();
        if (await trigger.isVisible().catch(() => false)) await trigger.click();
        for (let scroll = 0; scroll <= maxScrolls; scroll++) {
          await delay(1500, job.signal);
          await Promise.all([...pending]);
          const block = await this.blocked(page);
          if (block) throw new Error(block);
          if (failure) throw failure;
          if (pages.length && (!pages.at(-1)!.hasMore || comments.size >= limit)) {
            return {
              videoId,
              comments: [...comments.values()].slice(0, limit),
              pages,
              endReason: !pages.at(-1)!.hasMore ? 'entry_exhausted' : 'limit',
              coverage: 'bounded_top_level_comments',
            };
          }
          if (scroll === maxScrolls) break;
          const container = page.locator('[data-e2e="comment-list"]').first();
          if (!(await container.isVisible().catch(() => false))) break;
          // Scroll only the comment list, never use a private API or change identity.
          await delay(20_000, job.signal);
          const blockBeforeScroll = await this.blocked(page);
          if (blockBeforeScroll) throw new Error(blockBeforeScroll);
          if (failure) throw failure;
          await container.hover();
          await page.mouse.wheel(0, 1000);
        }
        if (!pages.length) throw new Error('未读到本作品评论响应；页面结构或访问条件尚未支持');
        return {
          videoId,
          comments: [...comments.values()].slice(0, limit),
          pages,
          endReason: maxScrolls ? 'no_new_page' : 'scroll_budget',
          coverage: 'bounded_top_level_comments',
        };
      } finally {
        page.off('response', listener);
        await Promise.all([...pending]);
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
        captured.check();
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

export function resolveDetailId(requestedUrl: string, resolvedUrl: string): string {
  const requested = parseVideoInput(requestedUrl)?.match(/\/video\/(\d{8,30})$/)?.[1];
  const resolved = parseVideoInput(resolvedUrl)?.match(/\/video\/(\d{8,30})$/)?.[1];
  if (!resolved) throw new Error('分享链接没有跳转到视频详情，请复制完整视频链接重试。');
  if (requested && requested !== resolved)
    throw new Error('详情页作品 ID 与请求不一致，停止关联；请检查原链接。');
  return resolved;
}

export function isKeywordSearchResponse(value: string, query: string): boolean {
  const url = new URL(value);
  if (url.hostname !== 'douyin.com' && !url.hostname.endsWith('.douyin.com')) return false;
  if (!/\/search(?:\/|$)/i.test(url.pathname)) return false;
  const keyword = url.searchParams.get('keyword');
  return keyword === null || keyword === query;
}

export function detectDouyinBlock(url: string, title: string, visible: string): string | null {
  if (/passport|\/login\b/.test(url)) return '抖音要求重新登录，请打开登录窗口完成扫码。';
  // Some platform verification screens render in an iframe, leaving the top-level body blank.
  if (
    /^(验证码中间页|安全验证|验证中心|验证页面)$/.test(title.trim()) ||
    /请完成下方验证|请完成验证后|拖动滑块完成|请按顺序点击|验证码验证|点击两个形状相同的物体|访问过于频繁|操作频繁/.test(
      visible,
    )
  )
    return '页面需要人工验证或暂时限制访问，请在抖音浏览器中完成处理后重试。';
  if (/页面不见了|页面不见啦|视频已删除|作品已删除|视频暂时无法查看|该视频已下架/.test(visible))
    return '视频或页面已不可用，请换一个视频链接。';
  return null;
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
