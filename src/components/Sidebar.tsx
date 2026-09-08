import { Search, Flame, Download, BookOpen, Play } from 'lucide-react';
import type { Connection } from '../../shared/types';
import { Button } from './ui';

export type View = 'search' | 'trends' | 'downloads' | 'guide';
export const viewNames: Record<View, string> = {
  search: '视频搜索',
  trends: '实时热点',
  downloads: '下载中心',
  guide: '使用指南',
};
const nav = [
  { id: 'search', icon: Search },
  { id: 'trends', icon: Flame },
  { id: 'downloads', icon: Download },
  { id: 'guide', icon: BookOpen },
] as const;
export function Sidebar({
  view,
  onView,
  connection,
  onConnect,
  busy,
  activeDownloads,
}: {
  view: View;
  onView: (view: View) => void;
  connection: Connection;
  onConnect: () => void;
  busy: boolean;
  activeDownloads: number;
}) {
  const ready = connection.connected;
  return (
    <aside className="sidebar">
      <a
        className="brand"
        href="#search"
        onClick={(e) => {
          e.preventDefault();
          onView('search');
        }}
      >
        <span className="brand-mark">
          <Play size={25} fill="white" strokeWidth={1} />
        </span>
        <span>
          <strong>Douyin Studio</strong>
          <small>内容探索工作台</small>
        </span>
      </a>
      <nav aria-label="主要导航">
        {nav.map(({ id, icon: Icon }) => (
          <button
            key={id}
            className={`nav-item ${view === id ? 'selected' : ''} ${id === 'guide' ? 'nav-guide' : ''}`}
            onClick={() => onView(id)}
            aria-current={view === id ? 'page' : undefined}
          >
            <Icon size={24} strokeWidth={1.6} />
            <span>{viewNames[id]}</span>
            {id === 'downloads' && activeDownloads > 0 && (
              <span className="nav-count">{activeDownloads}</span>
            )}
          </button>
        ))}
      </nav>
      <div className="connection-card">
        <div className="connection-heading">
          <span className={`status-dot ${ready ? 'green' : ''}`} />
          <span>{ready ? '浏览器已连接' : '浏览器未连接'}</span>
        </div>
        <p>仅在本机运行</p>
        <Button onClick={onConnect} busy={busy}>
          检查连接
        </Button>
      </div>
    </aside>
  );
}
