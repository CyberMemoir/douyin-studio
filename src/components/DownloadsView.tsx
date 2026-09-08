import { useState } from 'react';
import {
  Download,
  Check,
  CircleAlert,
  LoaderCircle,
  X,
  FileVideo,
  Play,
  Clock3,
  RotateCcw,
} from 'lucide-react';
import type { Job } from '../../shared/types';
import { bytes, time } from '../lib/api';
import { Button, EmptyState, Modal } from './ui';

const labels = {
  queued: '等待中',
  running: '下载中',
  completed: '已完成',
  failed: '失败',
  cancelled: '已取消',
};
export function DownloadsView({
  jobs,
  onCancel,
  onRetry,
  onSearch,
}: {
  jobs: Job[];
  onCancel: (id: string) => void;
  onRetry: (id: string) => void;
  onSearch: () => void;
}) {
  const [filter, setFilter] = useState('all');
  const [preview, setPreview] = useState<Job | null>(null);
  const [details, setDetails] = useState<Job | null>(null);
  const all = jobs.filter((j) => j.type === 'download');
  const visible = all.filter(
    (j) =>
      filter === 'all' ||
      (filter === 'active'
        ? ['running', 'queued'].includes(j.status)
        : filter === 'completed'
          ? j.status === 'completed'
          : ['failed', 'cancelled'].includes(j.status)),
  );
  const detailJob = jobs.find((j) => j.id === details?.id) || details;
  return (
    <>
      <div className="page-intro">
        <h1>把好内容，留在手边。</h1>
        <p>查看下载进度，预览视频，管理保存在本机的内容。</p>
      </div>
      <div className="tab-row" role="tablist" aria-label="下载状态">
        {[
          ['all', '全部任务'],
          ['active', '进行中'],
          ['completed', '已完成'],
          ['failed', '未完成'],
        ].map(([id, title]) => (
          <button
            key={id}
            role="tab"
            aria-selected={filter === id}
            className={filter === id ? 'active' : ''}
            onClick={() => setFilter(id)}
          >
            {title}
            {id === 'all' && <span>{all.length}</span>}
          </button>
        ))}
      </div>
      <section className="panel downloads-panel">
        {!visible.length ? (
          <EmptyState
            icon={<Download size={64} strokeWidth={1.2} />}
            title={all.length ? '这个分类还没有任务' : '把下一份灵感，保存下来'}
            description="搜索并选中视频后，下载任务会显示在这里。"
          >
            <Button onClick={onSearch}>去搜索视频</Button>
          </EmptyState>
        ) : (
          visible.map((job) => (
            <article key={job.id} className="download-row">
              <div className={`download-type ${job.status}`}>
                <FileVideo size={27} strokeWidth={1.5} />
              </div>
              <div className="download-content">
                <h3>{job.video?.title || job.title}</h3>
                <div className="download-meta">
                  <span className={`job-status ${job.status}`}>
                    {job.status === 'completed' ? (
                      <Check size={14} />
                    ) : job.status === 'running' ? (
                      <LoaderCircle size={14} className="spin" />
                    ) : job.status === 'failed' ? (
                      <CircleAlert size={14} />
                    ) : (
                      <Clock3 size={14} />
                    )}{' '}
                    {labels[job.status]}
                  </span>
                  <span>
                    {job.bytes
                      ? `${bytes(job.bytes)}${job.totalBytes && job.status !== 'completed' ? ` / ${bytes(job.totalBytes)}` : ''}`
                      : time(job.createdAt)}
                  </span>
                  <button className="text-link" onClick={() => setDetails(job)}>
                    任务日志
                  </button>
                </div>
                {job.status === 'running' && (
                  <>
                    <div
                      className={`progress-track ${job.progress === null ? 'indeterminate' : ''}`}
                      role="progressbar"
                      aria-valuenow={job.progress ?? undefined}
                      aria-label="下载进度"
                    >
                      <span style={{ width: job.progress === null ? '35%' : `${job.progress}%` }} />
                    </div>
                    <p className="download-phase">
                      {job.phase}
                      {job.progress !== null ? ` · ${job.progress}%` : ''}
                    </p>
                  </>
                )}
                {job.error && <p className="download-error">{job.error}</p>}
              </div>
              <div className="download-actions">
                {job.status === 'completed' ? (
                  <>
                    <Button className="icon-button" onClick={() => setPreview(job)} aria-label="预览视频">
                      <Play size={17} />
                    </Button>
                    <a className="button" href={`/api/downloads/${job.id}/file`}>
                      <Download size={16} />
                      保存文件
                    </a>
                  </>
                ) : ['queued', 'running'].includes(job.status) ? (
                  <Button className="icon-button" onClick={() => onCancel(job.id)} aria-label="取消下载">
                    <X size={18} />
                  </Button>
                ) : job.video ? (
                  <Button
                    className="icon-button"
                    onClick={() => onRetry(job.video!.id)}
                    aria-label="重新下载"
                  >
                    <RotateCcw size={18} />
                  </Button>
                ) : null}
              </div>
            </article>
          ))
        )}
      </section>
      <p className="privacy-note">
        视频保存在项目的 .data/downloads/ 目录；“保存文件”可另存到浏览器下载目录。
      </p>
      {preview && (
        <Modal title="视频预览" onClose={() => setPreview(null)}>
          <video
            className="preview-video"
            src={`/api/downloads/${preview.id}/file?inline=1`}
            controls
            autoPlay
            playsInline
          />
          <p className="modal-description">{preview.video?.title}</p>
        </Modal>
      )}
      {detailJob && (
        <Modal title="任务日志" onClose={() => setDetails(null)}>
          <p className="modal-description">{detailJob.title}</p>
          <ol className="job-logs">
            {detailJob.logs.map((log, index) => (
              <li key={index}>
                <time>{time(log.time)}</time>
                <span>{log.text}</span>
              </li>
            ))}
          </ol>
        </Modal>
      )}
    </>
  );
}
