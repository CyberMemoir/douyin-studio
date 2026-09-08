import path from 'node:path';
import { z } from 'zod';

export const searchSchema = z.object({
  query: z.string().trim().min(1).max(400),
  limit: z.number().int().min(1).max(50).default(20),
});
export const downloadSchema = z.object({
  ids: z
    .array(z.string().regex(/^\d{8,30}$/))
    .min(1)
    .max(30),
});

export function parseVideoInput(value: string): string | null {
  const text = value.trim();
  if (/^\d{8,30}$/.test(text)) return `https://www.douyin.com/video/${text}`;
  const raw = text.match(/https?:\/\/[^\s<>"“”]+/)?.[0]?.replace(/[，。！!）)]+$/, '');
  if (!raw) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('视频链接格式不正确');
  }
  if (
    !['https:', 'http:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    (url.port && !['80', '443'].includes(url.port))
  )
    throw new Error('仅支持抖音视频链接');
  if (!['www.douyin.com', 'douyin.com', 'v.douyin.com', 'www.iesdouyin.com'].includes(url.hostname))
    throw new Error('请粘贴 douyin.com 的视频或分享链接');
  if (url.hostname === 'v.douyin.com') return url.href;
  const id =
    url.pathname.match(/\/(?:video|note|share\/video)\/(\d{8,30})(?:\/|$)/)?.[1] ||
    url.searchParams.get('modal_id');
  if (!id || !/^\d{8,30}$/.test(id)) throw new Error('这个链接不是视频详情页，请复制视频分享链接');
  return `https://www.douyin.com/video/${id}`;
}

const MEDIA_DOMAINS = [
  'douyinvod.com',
  'douyin.com',
  'bytecdn.cn',
  'bytecdn.com',
  'bytedance.com',
  'bytedance.net',
  'pstatp.com',
  'snssdk.com',
  'byteimg.com',
  'ibytedtos.com',
  'ibyteimg.com',
  'bytegoofy.com',
  'akamaized.net',
];
export function mediaUrl(value: string): URL {
  const url = new URL(value);
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    (url.port && url.port !== '443') ||
    !MEDIA_DOMAINS.some((domain) => url.hostname === domain || url.hostname.endsWith(`.${domain}`))
  ) {
    throw new Error('视频地址不在受支持的抖音媒体域名中');
  }
  return url;
}

export function safeFileName(title: string, id: string): string {
  const clean = title
    .normalize('NFKC')
    .replace(/[\p{Cc}\p{Cf}<>:"/\\|?*]/gu, '')
    .replace(/\s+/g, ' ')
    .replace(/^\.+|[. ]+$/g, '')
    .trim();
  return `${[...clean].slice(0, 55).join('') || '抖音视频'}_${id.replace(/[^a-zA-Z0-9-]/g, '').slice(0, 40)}.mp4`;
}

export function localFile(root: string, name: string): string {
  if (!name || path.basename(name) !== name || name.startsWith('.') || !name.endsWith('.mp4'))
    throw new Error('下载文件路径不正确');
  return path.join(root, name);
}

export function localCdpUrl(value: string): string {
  const url = new URL(value);
  if (
    !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) ||
    url.protocol !== 'http:' ||
    url.username ||
    url.password ||
    url.pathname !== '/' ||
    url.search ||
    url.hash
  ) {
    throw new Error('DOUYIN_CDP_URL 必须是本机 http://127.0.0.1:端口 地址');
  }
  return url.origin;
}
