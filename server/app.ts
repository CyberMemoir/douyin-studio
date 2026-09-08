import express, { type Request, type Response, type NextFunction } from 'express';
import fs from 'node:fs/promises';
import { ZodError } from 'zod';
import { publicVideo, type Connection } from '../shared/types.js';
import { DouyinBrowser } from './browser.js';
import { JobQueue } from './jobs.js';
import { Store } from './store.js';
import { searchSchema, downloadSchema, parseVideoInput, localFile } from './validation.js';
import { saveVideo } from './download.js';

export function createApp(store: Store, browser: DouyinBrowser, queue: JobQueue) {
  const app = express();
  app.disable('x-powered-by');
  app.use((req, res, next) => {
    const host = req.headers.host || '';
    if (!/^(localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/.test(host)) {
      res.status(403).json({ error: '只允许本机访问' });
      return;
    }
    const origin = req.headers.origin;
    if ((origin && origin !== `http://${host}`) || req.headers['sec-fetch-site'] === 'cross-site') {
      res.status(403).json({ error: '不允许跨站访问本机工作台' });
      return;
    }
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Frame-Options', 'DENY');
    if (req.path.startsWith('/api/')) {
      res.setHeader('Cache-Control', 'no-store');
      if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) && req.headers['x-studio-client'] !== '1') {
        res.status(403).json({ error: '缺少本机请求标记' });
        return;
      }
    }
    next();
  });
  app.use(express.json({ limit: '16kb' }));
  app.get('/api/health', (_req, res) => res.json({ ok: true, name: 'Douyin Studio', version: '0.1.0' }));
  app.get('/api/state', (_req, res) => res.json(store.snapshot()));
  app.get('/api/events', (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();
    let pending: ReturnType<typeof setTimeout> | undefined;
    const send = () => {
      pending = undefined;
      res.write(`data: ${JSON.stringify(store.snapshot())}\n\n`);
    };
    const update = () => {
      if (!pending) pending = setTimeout(send, 150);
    };
    send();
    store.on('change', update);
    const heartbeat = setInterval(() => res.write(': keepalive\n\n'), 20000);
    req.on('close', () => {
      clearInterval(heartbeat);
      clearTimeout(pending);
      store.off('change', update);
    });
  });
  const setConnection = (connection: Connection) => {
    store.connection = connection;
    store.changed();
  };
  for (const action of ['check', 'login'] as const) {
    app.post(`/api/browser/${action}`, (_req, res) => {
      const existing = store.jobs.find((j) => j.type === action && ['queued', 'running'].includes(j.status));
      if (existing) {
        res.status(202).json(existing);
        return;
      }
      const job = queue.enqueue(
        action,
        action === 'login' ? '打开扫码登录窗口' : '检查浏览器连接',
        async (ctx) => {
          ctx.log(action === 'login' ? '正在打开抖音登录窗口' : '正在检查浏览器连接');
          try {
            const connection = await (action === 'login' ? browser.login() : browser.status());
            setConnection(connection);
            ctx.update({ result: { connection } });
            ctx.log(connection.message);
          } catch (error) {
            setConnection({
              connected: false,
              login: 'unknown',
              message: error instanceof Error ? error.message : '浏览器连接失败',
              checkedAt: new Date().toISOString(),
            });
            throw error;
          }
        },
      );
      res.status(202).json(job);
    });
  }
  app.post('/api/search', (req, res) => {
    const { query, limit } = searchSchema.parse(req.body);
    const url = parseVideoInput(query);
    const job = queue.enqueue(
      url ? 'resolve' : 'search',
      url ? '解析视频链接' : `搜索：${query}`,
      async (ctx) => {
        const videos = url ? [await browser.resolve(url, ctx)] : await browser.search(query, limit, ctx);
        store.addVideos(videos);
        ctx.update({ result: { videos: videos.map(publicVideo), fetchedAt: new Date().toISOString() } });
        // A late status check must not turn a successfully collected result into a failure.
        const connection = await browser.status().catch(() => null);
        if (connection) setConnection(connection);
      },
    );
    res.status(202).json(job);
  });
  app.post('/api/trends', (_req, res) => {
    const existing = store.jobs.find((j) => j.type === 'trends' && ['queued', 'running'].includes(j.status));
    if (existing) {
      res.status(202).json(existing);
      return;
    }
    const job = queue.enqueue('trends', '刷新抖音热榜', async (ctx) => {
      const trends = await browser.trends(ctx);
      store.trends = trends;
      store.trendsAt = new Date().toISOString();
      store.changed();
      ctx.update({ result: { trends, fetchedAt: store.trendsAt } });
    });
    res.status(202).json(job);
  });
  app.post('/api/downloads', (req, res) => {
    const { ids } = downloadSchema.parse(req.body);
    const unique = [...new Set(ids)];
    for (const id of unique)
      if (!store.videos.has(id)) {
        res.status(404).json({ error: '请先搜索或解析视频，再加入下载任务' });
        return;
      }
    if (store.jobs.filter((j) => j.status === 'queued').length + unique.length > 60) {
      res.status(429).json({ error: '下载队列已满，请等待当前任务完成' });
      return;
    }
    const jobs = unique.map((id) => {
      const video = store.videos.get(id)!;
      const existing = store.jobs.find(
        (j) =>
          j.type === 'download' &&
          j.video?.id === id &&
          ['queued', 'running', 'completed'].includes(j.status),
      );
      if (existing) return existing;
      return queue.enqueue(
        'download',
        video.title,
        async (ctx) => {
          let ready = video;
          if (!ready.mediaUrls.length) {
            ready = await browser.resolve(video.url, ctx);
            store.addVideos([ready]);
          }
          ctx.update({ video: publicVideo(ready) });
          try {
            await saveVideo(ready, store.downloads, ctx);
          } catch (error) {
            ctx.signal.throwIfAborted();
            if (!/HTTP 40[134]|所有可用视频源/.test(error instanceof Error ? error.message : '')) throw error;
            ctx.log('视频地址可能已过期，重新解析一次');
            ready = await browser.resolve(video.url, ctx);
            store.addVideos([ready]);
            await saveVideo(ready, store.downloads, ctx);
          }
        },
        publicVideo(video),
      );
    });
    res.status(202).json({ jobs });
  });
  app.post('/api/jobs/:id/cancel', (req, res) => {
    if (!queue.cancel(String(req.params.id))) {
      res.status(409).json({ error: '任务已结束或不存在' });
      return;
    }
    res.json({ ok: true });
  });
  app.get('/api/downloads/:id/file', async (req, res) => {
    const job = store.jobs.find(
      (j) => j.id === req.params.id && j.type === 'download' && j.status === 'completed',
    );
    if (!job?.fileName) {
      res.status(404).json({ error: '下载尚未完成或文件不存在' });
      return;
    }
    const file = localFile(store.downloads, job.fileName);
    const stat = await fs.lstat(file).catch(() => null);
    if (!stat?.isFile() || stat.isSymbolicLink()) {
      res.status(404).json({ error: '本地文件已被移动或删除' });
      return;
    }
    // The private data directory begins with a dot. Allow only this indexed MP4,
    // not a static mount of .data (which also contains session-related metadata).
    if (req.query.inline === '1') res.sendFile(file, { dotfiles: 'allow' });
    else res.download(file, job.fileName, { dotfiles: 'allow' });
  });
  app.get('/api/jobs/:id/export', (req, res) => {
    const job = store.jobs.find((j) => j.id === req.params.id);
    if (!job?.result?.videos) {
      res.status(404).json({ error: '没有可导出的搜索结果' });
      return;
    }
    res.setHeader('Content-Disposition', 'attachment; filename="douyin-search.json"');
    res.json({ query: job.title, fetchedAt: job.result.fetchedAt, videos: job.result.videos });
  });
  app.use('/api', (_req, res) => {
    res.status(404).json({ error: '接口不存在' });
  });
  return app;
}

export function errorHandler(error: unknown, _req: Request, res: Response, _next: NextFunction) {
  if (res.headersSent) return;
  if (error instanceof ZodError) {
    res.status(400).json({ error: '输入格式不正确，请检查关键词、结果数量或视频 ID。' });
    return;
  }
  const message = error instanceof Error ? error.message : '服务发生错误';
  res.status(error instanceof SyntaxError ? 400 : 500).json({ error: message.slice(0, 700) });
}
