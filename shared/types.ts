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
};

export type StoredVideo = Video & { mediaUrls: string[] };
export type Trend = { word: string; rank: number; heat: number | null; label: string };
export type Connection = {
  connected: boolean;
  login: 'likely' | 'required' | 'unknown';
  message: string;
  checkedAt: string | null;
};
export type JobType = 'search' | 'resolve' | 'trends' | 'download' | 'login' | 'check';
export type JobStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';
export type Job = {
  id: string;
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
  result?: { videos?: Video[]; trends?: Trend[]; connection?: Connection; fetchedAt?: string; note?: string };
};
export type Snapshot = { jobs: Job[]; trends: Trend[]; trendsAt: string | null; connection: Connection };

export function publicVideo(video: StoredVideo): Video {
  const { mediaUrls: _private, ...result } = video;
  return result;
}
