import { useEffect, useState, type FormEvent } from 'react';
import {
  Search,
  ChevronRight,
  Download,
  ExternalLink,
  Heart,
  LoaderCircle,
  FileDown,
  Square,
  CheckSquare,
  Film,
} from 'lucide-react';
import type { Job, Snapshot, Video } from '../../shared/types';
import { duration, number, time } from '../lib/api';
import { Button, EmptyState, ErrorNotice, FilmSearchIcon } from './ui';
import { TrendPanel } from './TrendPanel';

type Props = {
  query: string;
  setQuery: (query: string) => void;
  limit: number;
  setLimit: (limit: number) => void;
  onSearch: (query: string) => void;
  searchJob?: Job;
  submitting: boolean;
  state: Snapshot;
  onTrends: () => void;
  onDownload: (ids: string[]) => Promise<void>;
  downloading: boolean;
  onLogin: () => void;
};
export function SearchView(props: Props) {
  const {
    query,
    setQuery,
    limit,
    setLimit,
    onSearch,
    searchJob,
    submitting,
    state,
    onTrends,
    onDownload,
    downloading,
    onLogin,
  } = props;
  const busy = submitting || (!!searchJob && ['queued', 'running'].includes(searchJob.status));
  const videos = searchJob?.result?.videos || [];
  const [selected, setSelected] = useState<Set<string>>(new Set());
  useEffect(() => {
    setSelected(new Set());
  }, [searchJob?.id]);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (query.trim()) onSearch(query);
  };
  const toggle = (id: string) => {
    setSelected((previous) => {
      const next = new Set(previous);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };
  return (
    <>
      <div className="page-intro">
        <h1>找到值得收藏的内容。</h1>
        <p>搜索抖音视频，追踪实时热点，把灵感保存到本地。</p>
      </div>
      <form className="search-form" onSubmit={submit}>
        <div className="search-input">
          <Search size={24} strokeWidth={1.7} />
          <input
            aria-label="搜索关键词或抖音视频链接"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="搜索关键词，或粘贴抖音视频链接"
            maxLength={400}
          />
          {query && (
            <button type="button" className="clear-input" aria-label="清空搜索" onClick={() => setQuery('')}>
              ×
            </button>
          )}
        </div>
        <Button tone="primary" type="submit" busy={busy} disabled={!query.trim()}>
          搜索
        </Button>
      </form>
      <div className="search-options">
        <label>
          结果数量
          <select aria-label="结果数量" value={limit} onChange={(e) => setLimit(Number(e.target.value))}>
            <option value={10}>10 条</option>
            <option value={20}>20 条</option>
            <option value={30}>30 条</option>
            <option value={50}>50 条</option>
          </select>
        </label>
        <button className="text-link muted" onClick={onLogin}>
          登录后搜索更完整
        </button>
      </div>
      <div className="discovery-grid">
        <section className="panel results-panel">
          <header className="panel-header">
            <div>
              <h2>搜索结果</h2>
              <p>
                {busy
                  ? searchJob?.phase || '正在创建搜索任务'
                  : videos.length
                    ? `${videos.length} 条视频 · ${time(searchJob?.result?.fetchedAt || null)} 获取`
                    : searchJob?.status === 'failed'
                      ? '本次搜索未完成'
                      : '等待搜索'}
              </p>
            </div>
            {videos.length > 0 && (
              <a
                href={`/api/jobs/${searchJob!.id}/export`}
                className="button icon-button"
                title="导出 JSON"
                aria-label="导出搜索结果"
              >
                <FileDown size={18} />
              </a>
            )}
          </header>
          {searchJob?.status === 'failed' && <ErrorNotice>{searchJob.error}</ErrorNotice>}
          {busy ? (
            <EmptyState
              icon={<LoaderCircle size={56} className="spin" strokeWidth={1.4} />}
              title="让好内容，慢慢浮现"
              description="正在读取抖音页面，通常需要 10–30 秒。"
            />
          ) : videos.length ? (
            <>
              <div className="selection-bar">
                <button
                  className="text-link"
                  onClick={() =>
                    setSelected(
                      selected.size === videos.length ? new Set() : new Set(videos.map((v) => v.id)),
                    )
                  }
                >
                  {selected.size === videos.length ? <CheckSquare size={18} /> : <Square size={18} />}{' '}
                  {selected.size ? `已选 ${selected.size} 条` : '全选'}
                </button>
                <Button
                  tone="primary"
                  className="small"
                  disabled={!selected.size}
                  busy={downloading}
                  onClick={() => void onDownload([...selected])}
                >
                  <Download size={16} />
                  下载所选
                </Button>
              </div>
              <div className="video-list">
                {videos.map((video) => (
                  <VideoRow
                    key={video.id}
                    video={video}
                    selected={selected.has(video.id)}
                    onToggle={() => toggle(video.id)}
                    onDownload={() => void onDownload([video.id])}
                    downloading={downloading}
                  />
                ))}
              </div>
            </>
          ) : (
            <>
              <EmptyState
                icon={<FilmSearchIcon />}
                title="下一份灵感，从这里开始"
                description="输入关键词探索视频，或粘贴分享链接直接解析。"
              >
                <div className="suggestions">
                  {['AI 工具', '旅行灵感', '摄影技巧'].map((word) => (
                    <Button key={word} onClick={() => onSearch(word)}>
                      {word}
                    </Button>
                  ))}
                </div>
              </EmptyState>
              <div className="workflow-steps">
                <button onClick={onLogin}>
                  <strong>01</strong>
                  <span>扫码登录</span>
                </button>
                <ChevronRight size={20} />
                <div>
                  <strong>02</strong>
                  <span>搜索或粘贴</span>
                </div>
                <ChevronRight size={20} />
                <div>
                  <strong>03</strong>
                  <span>保存到本地</span>
                </div>
              </div>
            </>
          )}
        </section>
        <TrendPanel
          trends={state.trends}
          fetchedAt={state.trendsAt}
          job={state.jobs.find((j) => j.type === 'trends')}
          onRefresh={onTrends}
          onSearch={onSearch}
        />
      </div>
      <p className="privacy-note">内容与登录数据保存在这台电脑，不上传到服务器。</p>
    </>
  );
}

function VideoRow({
  video,
  selected,
  onToggle,
  onDownload,
  downloading,
}: {
  video: Video;
  selected: boolean;
  onToggle: () => void;
  onDownload: () => void;
  downloading: boolean;
}) {
  const [imageFailed, setImageFailed] = useState(false);
  return (
    <article className={`video-row ${selected ? 'is-selected' : ''}`}>
      <input type="checkbox" aria-label={`选择视频：${video.title}`} checked={selected} onChange={onToggle} />
      <a
        className="video-cover"
        href={video.url}
        target="_blank"
        rel="noreferrer"
        aria-label={`在抖音查看：${video.title}`}
      >
        {video.cover && !imageFailed ? (
          <img
            src={video.cover}
            alt=""
            loading="lazy"
            referrerPolicy="no-referrer"
            onError={() => setImageFailed(true)}
          />
        ) : (
          <Film size={27} strokeWidth={1.2} />
        )}
        <span>{duration(video.duration)}</span>
      </a>
      <div className="video-info">
        <a href={video.url} target="_blank" rel="noreferrer" className="video-title">
          {video.title}
        </a>
        <p>@{video.author}</p>
        <div className="video-meta">
          <span>
            <Heart size={13} />
            {number(video.likes)}
          </span>
          {video.createdAt && <span>{new Date(video.createdAt * 1000).toLocaleDateString('zh-CN')}</span>}
        </div>
      </div>
      <div className="video-actions">
        <Button
          className="icon-button"
          onClick={onDownload}
          disabled={downloading}
          aria-label={`下载：${video.title}`}
          title="下载视频"
        >
          <Download size={19} />
        </Button>
        <a
          href={video.url}
          className="external-video"
          target="_blank"
          rel="noreferrer"
          aria-label="打开抖音视频"
        >
          <ExternalLink size={16} />
        </a>
      </div>
    </article>
  );
}
