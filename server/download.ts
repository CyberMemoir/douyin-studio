import fs from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { StoredVideo } from '../shared/types.js';
import type { JobContext } from './jobs.js';
import { localFile, mediaUrl, safeFileName } from './validation.js';

const MAX_BYTES = 2 * 1024 * 1024 * 1024;

export async function fetchMedia(value: string, signal: AbortSignal): Promise<Response> {
  let url = mediaUrl(value);
  for (let redirects = 0; redirects < 5; redirects++) {
    const response = await fetch(url, {
      signal,
      redirect: 'manual',
      headers: {
        Referer: 'https://www.douyin.com/',
        'User-Agent':
          'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36',
      },
    });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const next = response.headers.get('location');
      await response.body?.cancel();
      if (!next) throw new Error('媒体跳转缺少目标地址');
      url = mediaUrl(new URL(next, url).href); // Revalidate every redirect; never accept arbitrary URLs.
      continue;
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`视频源返回 HTTP ${response.status}`);
    }
    const type = response.headers.get('content-type') || '';
    if (/text\/|json|html|mpegurl|dash\+xml/.test(type)) {
      await response.body?.cancel();
      throw new Error('页面没有提供可直接保存的 MP4 视频流');
    }
    const size = Number(response.headers.get('content-length') || 0);
    if (size > MAX_BYTES) {
      await response.body?.cancel();
      throw new Error('单个视频超过 2 GB 下载上限');
    }
    return response;
  }
  throw new Error('视频源跳转次数过多');
}

export function mp4Validator(onBytes: (bytes: number) => void, maxBytes = MAX_BYTES) {
  let bytes = 0;
  let first = Buffer.alloc(0);
  let checked = false;
  return new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      bytes += chunk.length;
      if (bytes > maxBytes) {
        callback(new Error('视频超过下载大小上限'));
        return;
      }
      if (!checked) {
        first = Buffer.concat([first, chunk]);
        if (first.length < 12) {
          callback();
          return;
        }
        if (first.toString('ascii', 4, 8) !== 'ftyp') {
          callback(new Error('返回内容不是可保存的 MP4 视频'));
          return;
        }
        checked = true;
        this.push(first);
        first = Buffer.alloc(0);
      } else this.push(chunk);
      onBytes(bytes);
      callback();
    },
    flush(callback) {
      callback(checked ? undefined : new Error('视频内容为空或不完整'));
    },
  });
}

export async function saveVideo(video: StoredVideo, directory: string, job: JobContext): Promise<void> {
  if (!video.mediaUrls.length)
    throw new Error(
      '页面没有提供可下载的视频源。请在抖音中确认该作品可播放；图文、直播和加密分段流暂不支持。',
    );
  const name = safeFileName(video.title, `${video.id}-${job.job.id.slice(0, 8)}`);
  const finalPath = localFile(directory, name);
  const partialPath = `${finalPath}.part`;
  const signal = AbortSignal.any([job.signal, AbortSignal.timeout(10 * 60 * 1000)]);
  let lastError: unknown;
  for (const candidate of video.mediaUrls.slice(0, 4)) {
    signal.throwIfAborted();
    let response: Response | undefined;
    try {
      job.log('连接视频源，开始保存到本地');
      response = await fetchMedia(candidate, signal);
      if (!response.body) throw new Error('视频源没有返回内容');
      const total = Number(response.headers.get('content-length') || 0);
      let received = 0;
      let lastTick = 0;
      job.update({ progress: total ? 0 : null, bytes: 0, totalBytes: total || undefined });
      const validator = mp4Validator((bytes) => {
        received = bytes;
        if (Date.now() - lastTick > 200) {
          lastTick = Date.now();
          job.update({
            bytes,
            progress: total ? Math.min(99, Math.round((bytes / total) * 100)) : null,
            phase: '正在下载',
          });
        }
      });
      await pipeline(
        Readable.fromWeb(response.body as never),
        validator,
        createWriteStream(partialPath, { flags: 'wx', mode: 0o600 }),
        { signal },
      );
      if (total && received !== total) throw new Error('视频传输不完整，请重试');
      signal.throwIfAborted();
      await fs.rename(partialPath, finalPath);
      job.update({ bytes: received, totalBytes: received, fileName: name, progress: 100 });
      job.log('视频已完整保存，可以预览或下载文件');
      return;
    } catch (error) {
      lastError = error;
      await response?.body?.cancel().catch(() => {});
      await fs.rm(partialPath, { force: true });
      signal.throwIfAborted();
    }
  }
  throw lastError instanceof Error ? lastError : new Error('所有可用视频源均下载失败');
}
