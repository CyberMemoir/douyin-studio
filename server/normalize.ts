import type { StoredVideo, Trend } from '../shared/types.js';
import { mediaUrl } from './validation.js';

type RecordValue = Record<string, unknown>;
const record = (value: unknown): RecordValue =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as RecordValue) : {};
const string = (value: unknown): string => (typeof value === 'string' ? value : '');
const numeric = (value: unknown): number | null =>
  value !== null && value !== undefined && value !== '' && Number.isFinite(Number(value))
    ? Number(value)
    : null;

function urls(value: unknown): string[] {
  const list = record(value).url_list;
  return Array.isArray(list)
    ? list
        .filter((url): url is string => typeof url === 'string' && /^https?:\/\//.test(url))
        .map((url) => url.replace(/^http:/, 'https:'))
    : [];
}

export function normalizeVideo(value: unknown): StoredVideo | null {
  const raw = record(value);
  const id = string(raw.aweme_id) || string(raw.awemeId);
  if (!/^\d{8,30}$/.test(id)) return null;
  const video = record(raw.video);
  const statistics = record(raw.statistics);
  const author = record(raw.author);
  const candidates = [...urls(video.play_addr), ...urls(video.play_addr_h264), ...urls(video.play_addr_265)];
  const bitRates = Array.isArray(video.bit_rate) ? video.bit_rate : [];
  for (const rate of bitRates) candidates.push(...urls(record(rate).play_addr));
  const mediaUrls = [...new Set(candidates)].filter((url) => {
    try {
      mediaUrl(url);
      return true;
    } catch {
      return false;
    }
  });
  // Photo notes / live rooms are not downloadable video results.
  if (!Object.keys(video).length && !string(raw.desc)) return null;
  return {
    id,
    title: string(raw.desc) || string(raw.caption) || '未命名视频',
    author: string(author.nickname) || string(raw.authorName) || '未知作者',
    url: `https://www.douyin.com/video/${id}`,
    cover: urls(video.cover)[0] || urls(video.origin_cover)[0] || urls(video.dynamic_cover)[0] || '',
    duration: Math.round((numeric(video.duration) || numeric(raw.duration) || 0) / 1000),
    likes: numeric(statistics.digg_count),
    comments: numeric(statistics.comment_count),
    createdAt: numeric(raw.create_time),
    source: 'network',
    mediaUrls,
  };
}

export function extractPayload(payload: unknown): { videos: StoredVideo[]; trends: Trend[] } {
  const videos = new Map<string, StoredVideo>();
  const trends = new Map<string, Trend>();
  const stack: { item: unknown; depth: number }[] = [{ item: payload, depth: 0 }];
  let visited = 0;
  while (stack.length && visited++ < 20000) {
    const { item, depth } = stack.pop()!;
    if (!item || typeof item !== 'object' || depth > 14) continue;
    if (Array.isArray(item)) {
      for (let i = item.length - 1; i >= 0; i--) stack.push({ item: item[i], depth: depth + 1 });
      continue;
    }
    const raw = record(item);
    const video = normalizeVideo(raw);
    if (video) {
      if (!videos.has(video.id) || video.mediaUrls.length > videos.get(video.id)!.mediaUrls.length)
        videos.set(video.id, video);
      continue;
    }
    if (typeof raw.word === 'string' && ('hot_value' in raw || 'position' in raw || 'sentence_id' in raw)) {
      const word = raw.word.trim();
      if (word && !trends.has(word))
        trends.set(word, {
          word,
          rank: numeric(raw.position) ?? trends.size + 1,
          heat: numeric(raw.hot_value),
          label: typeof raw.label === 'string' ? raw.label : '',
        });
    }
    for (const child of Object.values(raw))
      if (child && typeof child === 'object') stack.push({ item: child, depth: depth + 1 });
  }
  return { videos: [...videos.values()], trends: [...trends.values()].sort((a, b) => a.rank - b.rank) };
}
