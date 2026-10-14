import { createHash } from 'node:crypto';
import type { CommentPage, CommentRecord } from '../shared/types.js';

export async function readCommentBody(read: () => Promise<Buffer>, timeoutMs = 10_000): Promise<Buffer> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      read(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('评论响应读取超时；停止任务')), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

const object = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('评论响应结构无效');
  return value as Record<string, unknown>;
};

export function isCommentResponse(url: string, videoId: string): boolean {
  const parsed = new URL(url);
  return (
    parsed.protocol === 'https:' &&
    (parsed.hostname === 'douyin.com' || parsed.hostname.endsWith('.douyin.com')) &&
    parsed.pathname === '/aweme/v1/web/comment/list/' &&
    parsed.searchParams.get('aweme_id') === videoId
  );
}

export function parseCommentPage(body: Buffer, videoId: string, observedAt: string): CommentPage {
  if (body.length > 4_000_000) throw new Error('评论响应超过大小限制');
  const payload = object(JSON.parse(body.toString('utf8')));
  if (payload.status_code !== 0 || !Array.isArray(payload.comments))
    throw new Error('评论接口失败或结构变化；不标为空成功');
  if (![true, false, 0, 1].includes(payload.has_more as number | boolean))
    throw new Error('评论分页结束标志缺失');
  const bodySha256 = createHash('sha256').update(body).digest('hex');
  const comments: CommentRecord[] = payload.comments.map((raw, index) => {
    const row = object(raw);
    if (typeof row.cid !== 'string' || !/^\d{1,30}$/.test(row.cid) || typeof row.text !== 'string')
      throw new Error('评论缺少稳定ID或原文');
    if (row.aweme_id !== undefined && String(row.aweme_id) !== videoId)
      throw new Error('评论绑定了其他作品；停止关联');
    const user = row.user === null || row.user === undefined ? {} : object(row.user);
    return {
      id: row.cid,
      videoId,
      text: row.text,
      authorId: typeof user.uid === 'string' ? user.uid : null,
      createdAt: typeof row.create_time === 'number' ? row.create_time : null,
      likes: typeof row.digg_count === 'number' ? row.digg_count : null,
      observedAt,
      bodySha256,
      locator: `/comments/${index}/text`,
      isActualSearchLog: false,
    };
  });
  return {
    videoId,
    comments,
    observedAt,
    bodySha256,
    rawBody: body.toString('utf8'),
    hasMore: payload.has_more === true || payload.has_more === 1,
    cursor: typeof payload.cursor === 'string' || typeof payload.cursor === 'number' ? payload.cursor : null,
  };
}
