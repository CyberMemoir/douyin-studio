import { Flame, RefreshCw, ArrowUpRight, LoaderCircle } from 'lucide-react';
import type { Job, Trend } from '../../shared/types';
import { number, time } from '../lib/api';
import { Button, EmptyState, ErrorNotice } from './ui';

export function TrendPanel({
  trends,
  fetchedAt,
  job,
  onRefresh,
  onSearch,
  full = false,
}: {
  trends: Trend[];
  fetchedAt: string | null;
  job?: Job;
  onRefresh: () => void;
  onSearch: (word: string) => void;
  full?: boolean;
}) {
  const busy = !!job && ['queued', 'running'].includes(job.status);
  return (
    <section className={`panel trend-panel ${full ? 'full-trends' : ''}`}>
      <header className="panel-header">
        <div>
          <h2>
            <Flame size={24} className="coral" strokeWidth={1.7} />
            此刻热榜
          </h2>
          <p>来自抖音实时热榜{fetchedAt ? ` · ${time(fetchedAt)} 更新` : ''}</p>
        </div>
        <Button className="icon-button" onClick={onRefresh} disabled={busy} aria-label="刷新热榜">
          <RefreshCw size={19} className={busy ? 'spin' : ''} />
        </Button>
      </header>
      {job?.status === 'failed' && <ErrorNotice>{job.error}</ErrorNotice>}
      {!trends.length ? (
        <EmptyState
          icon={
            busy ? (
              <LoaderCircle size={52} className="spin" strokeWidth={1.3} />
            ) : (
              <Flame size={57} strokeWidth={1.2} />
            )
          }
          title={busy ? '正在寻找此刻热点' : '热点正在等你发现'}
          description={busy ? job?.phase : undefined}
        >
          {!busy && <Button onClick={onRefresh}>获取热榜</Button>}
        </EmptyState>
      ) : (
        <ol className="trend-list">
          {trends.slice(0, full ? 50 : 8).map((trend, i) => (
            <li key={trend.word}>
              <button onClick={() => onSearch(trend.word)} title={`搜索：${trend.word}`}>
                <span className={`rank ${i < 3 ? 'top' : ''}`}>
                  {trend.rank === 0 ? '置顶' : String(trend.rank).padStart(2, '0')}
                </span>
                <span className="trend-word">
                  {trend.word}
                  {full && trend.heat !== null && <small>热度 {number(trend.heat)}</small>}
                </span>
                {full ? (
                  <span className="trend-search">
                    搜索视频 <ArrowUpRight size={16} />
                  </span>
                ) : (
                  <ArrowUpRight size={16} className="muted" />
                )}
              </button>
            </li>
          ))}
        </ol>
      )}
      <footer className="trend-footer">点击话题，一键搜索相关视频</footer>
    </section>
  );
}
