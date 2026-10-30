import { createHash } from 'node:crypto';
import { normalizeVideo } from './normalize.js';
import type { StoredVideo } from '../shared/types.js';

export const SEARCH_PATH = '/aweme/v1/web/general/search/single/';
export const RELATED_PATH = '/aweme/v1/web/aweme/related/';
import type { NativeInput, NativePage } from '../shared/native-pages.js';
export type { NativeInput, NativePage } from '../shared/native-pages.js';

export function nativeAccessIssue(payload: unknown, kind: NativeInput['kind']): string | null {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
  const value = payload as {
    status_code?: unknown;
    search_nil_info?: { search_nil_type?: unknown; search_nil_item?: unknown };
  };
  if (
    kind === 'search_page' &&
    [value.search_nil_info?.search_nil_type, value.search_nil_info?.search_nil_item].includes('verify_check')
  )
    return '读取需要人工验证（search_nil_info.verify_check），停止访问';
  return value.status_code === 2483 ? '读取需要重新登录（native status_code 2483）' : null;
}

export function nativeRequest(input: NativeInput) {
  if (!Number.isInteger(input.count) || input.count < 1 || input.count > 50)
    throw new Error('Native page count must be 1..50');
  const params = new URLSearchParams({ device_platform: 'webapp', aid: '6383', count: String(input.count) });
  if (input.kind === 'search_page') {
    if (
      !input.query.trim() ||
      input.query.trim().length > 400 ||
      !Number.isSafeInteger(input.cursor) ||
      input.cursor < 0 ||
      input.searchId.length > 200
    )
      throw new Error('Invalid native search input');
    params.set('keyword', input.query.trim());
    params.set('offset', String(input.cursor));
    params.set('search_id', input.searchId);
    params.set('search_channel', 'aweme_general');
    params.set('search_source', 'normal_search');
  } else {
    if (
      !/^\d{8,30}$/.test(input.videoId) ||
      input.excludedIds.length > 1000 ||
      !input.excludedIds.every((id) => /^\d{8,30}$/.test(id))
    )
      throw new Error('Invalid related parent/filter IDs');
    params.set('aweme_id', input.videoId);
    params.set('filterGids', [...new Set([input.videoId, ...input.excludedIds])].join(','));
  }
  const path = input.kind === 'search_page' ? SEARCH_PATH : RELATED_PATH;
  return { path, query: params.toString() };
}

export function parseNativePage(
  body: Buffer,
  input: NativeInput,
  observedAt: string,
): { videos: StoredVideo[]; nativePage: NativePage } {
  nativeRequest(input);
  if (body.length > 12_000_000) throw new Error('Native metadata response exceeds byte budget');
  const value = JSON.parse(body.toString('utf8'));
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Native response object missing');
  const accessIssue = nativeAccessIssue(value, input.kind);
  if (accessIssue) throw new Error(accessIssue);
  if (value.status_code !== 0)
    throw new Error(`Native reader returned status_code ${value.status_code}; no automatic retry`);
  if (
    input.kind === 'search_page' &&
    typeof value.global_doodle_config?.keyword === 'string' &&
    value.global_doodle_config.keyword !== input.query
  )
    throw new Error('Native response keyword differs from requested query');
  const rows = input.kind === 'search_page' ? value.data : value.aweme_list;
  if (!Array.isArray(rows)) throw new Error('Native item list contract missing; no cursor advance');
  if (rows.length > 1000) throw new Error('Native item budget exceeded; no truncation/cursor advance');
  let unparsedRows = 0;
  const videos = new Map<string, StoredVideo>();
  const responsePath = 'https://www.douyin.com' + (input.kind === 'search_page' ? SEARCH_PATH : RELATED_PATH);
  const bodySha256 = createHash('sha256').update(body).digest('hex');
  for (const row of rows) {
    // General search's aweme_info and related's direct aweme_list are separate contracts.
    const video = normalizeVideo(input.kind === 'search_page' ? row?.aweme_info : row);
    if (!video) {
      unparsedRows++;
      continue;
    }
    if (input.kind === 'related' && video.id === input.videoId) continue;
    if (input.kind === 'search_page')
      video.searchContext = {
        requestedQuery: input.query,
        responseKeyword: input.query,
        keywordMatches: true,
        responsePath,
        pagePath: 'https://www.douyin.com/search/',
        observedAt,
      };
    else video.relatedContext = { parentVideoId: input.videoId, responsePath, bodySha256, observedAt };
    videos.set(video.id, video);
  }
  return {
    videos: [...videos.values()],
    nativePage: {
      request: input,
      responsePath,
      observedAt,
      bodySha256,
      ids: [...videos.keys()],
      cursor: Number.isSafeInteger(value.cursor) && value.cursor >= 0 ? value.cursor : null,
      cursorRaw: typeof value.cursor === 'string' || typeof value.cursor === 'number' ? value.cursor : null,
      hasMore: [0, 1, true, false].includes(value.has_more)
        ? value.has_more === 1 || value.has_more === true
        : null,
      hasMoreRaw: [0, 1, true, false].includes(value.has_more) ? value.has_more : null,
      searchId: typeof value.extra?.logid === 'string' && value.extra.logid ? value.extra.logid : null,
      unparsedRows,
      contractBasis: 'pinned_public_client_not_live_verified',
    },
  };
}
