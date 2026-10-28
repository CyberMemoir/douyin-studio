import { createHash } from 'node:crypto';
import type { Job, CommentCollection } from '../shared/types.js';
import { parseCommentPage } from './comments.js';

const hash = (value: string) => createHash('sha256').update(value).digest('hex');
type NativeComment = {
  cid: string;
  aweme_id: string | null;
  text: string;
  user: { uid: string | null };
  create_time: number | null;
  digg_count: number | null;
};

export function commentEvidence(job: Job) {
  // collect.ts persists the collection directly in result; API jobs wrap it.
  const collection =
    job.result?.commentCollection ?? (job.result as unknown as CommentCollection | undefined);
  if (!collection) {
    if (job.status === 'completed') throw new Error('Completed comments job omitted collection');
    return { pages: [], rows: [], cursor: null, complete: false, endReason: job.status };
  }
  if (
    !/^\d{8,30}$/.test(collection.videoId) ||
    collection.coverage !== 'bounded_top_level_comments' ||
    !Array.isArray(collection.pages) ||
    !Array.isArray(collection.comments)
  )
    throw new Error('Comment collection requires stable video ID/pages/comments');
  const pages = collection.pages.map((page) => {
    if (
      page.videoId !== collection.videoId ||
      !/([zZ]|[+-]\d\d:\d\d)$/.test(page.observedAt) ||
      !Number.isFinite(Date.parse(page.observedAt))
    )
      throw new Error('Comment page identity/observation time mismatch');
    const parsed = parseCommentPage(Buffer.from(page.rawBody), collection.videoId, page.observedAt);
    if (
      parsed.bodySha256 !== page.bodySha256 ||
      parsed.cursor !== page.cursor ||
      parsed.hasMore !== page.hasMore
    )
      throw new Error('Comment page body/cursor metadata mismatch');
    const body = JSON.parse(page.rawBody);
    const comments: NativeComment[] = body.comments.map((row: Record<string, unknown>) => ({
      cid: row.cid,
      aweme_id: row.aweme_id === undefined ? null : String(row.aweme_id),
      text: row.text,
      user: {
        uid:
          typeof (row.user as { uid?: unknown } | null)?.uid === 'string'
            ? (row.user as { uid: string }).uid
            : null,
      },
      create_time: typeof row.create_time === 'number' ? row.create_time : null,
      digg_count: typeof row.digg_count === 'number' ? row.digg_count : null,
    })) as NativeComment[];
    return {
      video_id: collection.videoId,
      observed_at: page.observedAt,
      source_body_sha256: page.bodySha256,
      evidence_basis: 'allowlisted_native_comment_json_view',
      has_more_raw: body.has_more,
      cursor_raw: parsed.cursor,
      comments,
    };
  });
  const allVersions = new Set(pages.flatMap((page) => page.comments.map((row) => hash(JSON.stringify(row)))));
  const selectedVersions = new Set<string>(),
    seenIds = new Set<string>();
  const rows = collection.comments.map((comment) => {
    const pageIndex = pages.findIndex((page) => page.source_body_sha256 === comment.bodySha256);
    const index = /^\/comments\/(0|[1-9]\d*)\/text$/.exec(comment.locator)?.[1];
    const row = index === undefined ? undefined : pages[pageIndex]?.comments[Number(index)];
    if (
      !row ||
      comment.videoId !== collection.videoId ||
      row.cid !== comment.id ||
      row.text !== comment.text ||
      comment.observedAt !== pages[pageIndex].observed_at ||
      seenIds.has(comment.id)
    )
      throw new Error('Comment original text/CID/video/pointer/observation mismatch');
    seenIds.add(comment.id);
    selectedVersions.add(hash(JSON.stringify(row)));
    return {
      video_id: collection.videoId,
      comment_id: row.cid,
      text: row.text,
      author_id: row.user.uid,
      published_at_raw: row.create_time,
      likes: row.digg_count,
      observed_at: pages[pageIndex].observed_at,
      locator: `/comment_pages/${pageIndex}/comments/${index}`,
    };
  });
  const cursors = pages.map((page) => page.cursor_raw).filter((value) => value !== null);
  const repeatedCursor = new Set(cursors.map((value) => JSON.stringify(value))).size < cursors.length;
  const unexported = [...allVersions].filter((value) => !selectedVersions.has(value)).length;
  const last = pages.at(-1);
  const hasMore = last ? last.has_more_raw === 1 || last.has_more_raw === true : null;
  const complete =
    !!last &&
    hasMore === false &&
    unexported === 0 &&
    !repeatedCursor &&
    collection.endReason === 'entry_exhausted';
  return {
    pages,
    rows,
    complete,
    endReason: collection.endReason,
    cursor: {
      scope: 'bounded_top_level_comments',
      raw_value: last?.cursor_raw ?? null,
      has_more: hasMore,
      page_evidence_sha: last?.source_body_sha256 ?? null,
      unexported_comment_versions: unexported,
      repeated_cursor: repeatedCursor,
      requires_page_replay: unexported > 0 || repeatedCursor,
      native_resume_implemented: false,
      continuation_gap: 'reader_has_bounded_UI_scrolls_but_no_restartable_native_cursor_request',
    },
  };
}
