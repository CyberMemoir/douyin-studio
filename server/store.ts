import fs from 'node:fs/promises';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import type { Job, Snapshot, StoredVideo } from '../shared/types.js';

export class Store extends EventEmitter {
  jobs: Job[] = [];
  videos = new Map<string, StoredVideo>();
  trends: Snapshot['trends'] = [];
  trendsAt: string | null = null;
  connection: Snapshot['connection'] = {
    connected: false,
    login: 'unknown',
    message: '尚未检查浏览器连接',
    checkedAt: null,
  };
  private timer?: ReturnType<typeof setTimeout>;
  private writes: Promise<unknown> = Promise.resolve();
  private revision = 0;
  constructor(readonly root: string) {
    super();
  }
  get downloads() {
    return path.join(this.root, 'downloads');
  }
  async init() {
    await fs.mkdir(this.downloads, { recursive: true, mode: 0o700 });
    try {
      const data = JSON.parse(await fs.readFile(path.join(this.root, 'state.json'), 'utf8'));
      this.jobs = Array.isArray(data.jobs) ? data.jobs : [];
      this.videos = new Map(
        (Array.isArray(data.videos) ? data.videos : []).map((v: StoredVideo) => [v.id, v]),
      );
      this.trends = data.trends || [];
      this.trendsAt = data.trendsAt || null;
      for (const job of this.jobs)
        if (job.status === 'running' || job.status === 'queued') {
          job.status = 'failed';
          job.error = '应用已重启，未完成的任务已停止，请重新创建任务。';
          job.phase = '任务中断';
        }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
        throw new Error('无法读取本地 state.json；请保留文件并检查格式或权限。');
    }
    this.changed();
  }
  snapshot(): Snapshot {
    return { jobs: this.jobs, trends: this.trends, trendsAt: this.trendsAt, connection: this.connection };
  }
  addVideos(videos: StoredVideo[]) {
    for (const v of videos) this.videos.set(v.id, v);
    while (this.videos.size > 5000) this.videos.delete(this.videos.keys().next().value!);
    this.changed();
  }
  changed() {
    this.revision++;
    this.emit('change');
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      void this.flush().catch((error) => console.error('State persistence failed:', error.message));
    }, 200);
  }
  async flush() {
    clearTimeout(this.timer);
    const payload = JSON.stringify({
      version: 1,
      jobs: this.jobs,
      videos: [...this.videos.values()],
      trends: this.trends,
      trendsAt: this.trendsAt,
    });
    const file = path.join(this.root, 'state.json');
    this.writes = this.writes
      .catch(() => {})
      .then(async () => {
        await fs.writeFile(`${file}.tmp`, payload, { mode: 0o600 });
        await fs.rename(`${file}.tmp`, file);
      });
    await this.writes;
  }
}
