export type Video = {
  id: string;
  title: string;
  author: string;
  url: string;
  cover: string;
  duration: number;
  likes: number | null;
  comments: number | null;
  createdAt: number | null;
  source: 'network' | 'page';
  detailContext?: {
    requestedUrl: string;
    resolvedUrl: string;
    observedAt: string;
    observationBasis: 'detail_result_assembly';
  };
  searchContext?: {
    responsePath: string;
    pagePath: string;
    requestedQuery: string;
    responseKeyword: string | null;
    keywordMatches: boolean | null;
    observedAt: string;
  };
};

export type SubtitleTrack = { url: string; language: string; label: string; kind: string };
export type SourceMedia = {
  schemaVersion: 1;
  videoId: string;
  canonicalUrl: string;
  observedAt: string;
  durationSeconds: number;
  mediaUrls: string[];
  subtitleTracks: SubtitleTrack[];
  subtitleCoverage: 'page_tracks_only';
};
export type StoredVideo = Video & {
  mediaUrls: string[];
  sourceMediaUrls?: string[];
  subtitleTracks?: SubtitleTrack[];
};
export type Trend = { word: string; rank: number; heat: number | null; label: string };
export type Connection = {
  connected: boolean;
  login: 'likely' | 'required' | 'unknown';
  message: string;
  checkedAt: string | null;
};
export type CommentRecord = {
  id: string;
  videoId: string;
  text: string;
  authorId: string | null;
  createdAt: number | null;
  likes: number | null;
  observedAt: string;
  bodySha256: string;
  locator: string;
  isActualSearchLog: false;
};
export type CommentPage = {
  videoId: string;
  comments: CommentRecord[];
  observedAt: string;
  bodySha256: string;
  rawBody: string;
  hasMore: boolean;
  cursor: string | number | null;
};
export type CommentCollection = {
  videoId: string;
  comments: CommentRecord[];
  pages: CommentPage[];
  endReason: 'entry_exhausted' | 'limit' | 'scroll_budget' | 'no_new_page';
  coverage: 'bounded_top_level_comments';
};
export type JobType = 'search' | 'resolve' | 'trends' | 'comments' | 'download' | 'login' | 'check';
export type JobStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';
export type Job = {
  id: string;
  idempotencyKey?: string;
  type: JobType;
  status: JobStatus;
  title: string;
  createdAt: string;
  updatedAt: string;
  progress: number | null;
  phase: string;
  logs: { time: string; text: string }[];
  error?: string;
  video?: Video;
  fileName?: string;
  bytes?: number;
  totalBytes?: number;
  result?: {
    videos?: Video[];
    trends?: Trend[];
    connection?: Connection;
    fetchedAt?: string;
    note?: string;
    commentCollection?: CommentCollection;
  };
};
export type Snapshot = { jobs: Job[]; trends: Trend[]; trendsAt: string | null; connection: Connection };

export function publicVideo(video: StoredVideo): Video {
  const { mediaUrls: _private, sourceMediaUrls: _sourcePrivate, subtitleTracks: _tracks, ...result } = video;
  return result;
}
