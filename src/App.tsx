import { useEffect, useRef, useState } from 'react';
import { ExternalLink, X, CheckCircle2, AlertCircle, Monitor, RefreshCw, LogIn } from 'lucide-react';
import type { Job } from '../shared/types';
import { api, time } from './lib/api';
import { useStudio } from './lib/useStudio';
import { Sidebar, viewNames, type View } from './components/Sidebar';
import { SearchView } from './components/SearchView';
import { TrendPanel } from './components/TrendPanel';
import { DownloadsView } from './components/DownloadsView';
import { GuideView } from './components/GuideView';
import { Button, ErrorNotice, Modal } from './components/ui';

export default function App() {
  const { state, online } = useStudio();
  const [view, setView] = useState<View>('search');
  const [query, setQuery] = useState('');
  const [limit, setLimit] = useState(20);
  const [searchId, setSearchId] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [connectionOpen, setConnectionOpen] = useState(false);
  const [toast, setToast] = useState<{ text: string; error: boolean } | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const notify = (text: string, error = false) => {
    clearTimeout(toastTimer.current);
    setToast({ text, error });
    toastTimer.current = setTimeout(() => setToast(null), error ? 9000 : 4500);
  };
  useEffect(() => () => clearTimeout(toastTimer.current), []);
  const searchJob = state.jobs.find((j) => j.id === searchId);
  const browserJob = state.jobs.find((j) => ['check', 'login'].includes(j.type));
  const browserBusy = !!browserJob && ['queued', 'running'].includes(browserJob.status);
  const search = async (value: string) => {
    if (submitting || (searchJob && ['queued', 'running'].includes(searchJob.status))) {
      notify('当前搜索仍在进行，请等待完成。');
      return;
    }
    setView('search');
    setQuery(value);
    setSubmitting(true);
    try {
      const job = await api<Job>('/search', { query: value.trim(), limit });
      setSearchId(job.id);
    } catch (error) {
      notify((error as Error).message, true);
    } finally {
      setSubmitting(false);
    }
  };
  const connect = async (action: 'check' | 'login') => {
    setConnectionOpen(true);
    try {
      await api(`/browser/${action}`, {});
    } catch (error) {
      notify((error as Error).message, true);
    }
  };
  const trends = async () => {
    try {
      await api('/trends', {});
    } catch (error) {
      notify((error as Error).message, true);
    }
  };
  const download = async (ids: string[]) => {
    setDownloading(true);
    try {
      const result = await api<{ jobs: Job[] }>('/downloads', { ids });
      notify(`${result.jobs.length} 条视频已加入下载中心`);
      setView('downloads');
    } catch (error) {
      notify((error as Error).message, true);
    } finally {
      setDownloading(false);
    }
  };
  const cancel = async (id: string) => {
    try {
      await api(`/jobs/${id}/cancel`, {});
    } catch (error) {
      notify((error as Error).message, true);
    }
  };
  return (
    <div className="app-shell">
      <Sidebar
        view={view}
        onView={setView}
        connection={state.connection}
        onConnect={() => void connect('check')}
        busy={browserBusy}
        activeDownloads={
          state.jobs.filter((j) => j.type === 'download' && ['running', 'queued'].includes(j.status)).length
        }
      />
      <div className="workspace">
        <header className="topbar">
          <div>
            工作台<span>/</span>
            <strong>{viewNames[view]}</strong>
          </div>
          <a href="https://github.com/CyberMemoir/douyin-studio" target="_blank" rel="noreferrer">
            GitHub
            <ExternalLink size={21} />
          </a>
        </header>
        <main>
          {!online && <ErrorNotice>与本地服务的连接暂时中断，正在重连。请保持后台运行。</ErrorNotice>}
          {view === 'search' && (
            <SearchView
              query={query}
              setQuery={setQuery}
              limit={limit}
              setLimit={setLimit}
              onSearch={(value) => void search(value)}
              searchJob={searchJob}
              submitting={submitting}
              state={state}
              onTrends={() => void trends()}
              onDownload={download}
              downloading={downloading}
              onLogin={() => {
                setConnectionOpen(true);
              }}
            />
          )}{' '}
          {view === 'trends' && (
            <>
              <div className="page-intro">
                <h1>跟上此刻，正在发生的事。</h1>
                <p>从真实热榜出发，找到你关心的话题和相关视频。</p>
              </div>
              <TrendPanel
                full
                trends={state.trends}
                fetchedAt={state.trendsAt}
                job={state.jobs.find((j) => j.type === 'trends')}
                onRefresh={() => void trends()}
                onSearch={(value) => void search(value)}
              />
              <p className="privacy-note">热榜显示最近一次成功获取的内容，点击刷新获取最新数据。</p>
            </>
          )}{' '}
          {view === 'downloads' && (
            <DownloadsView
              jobs={state.jobs}
              onCancel={(id) => void cancel(id)}
              onRetry={(id) => void download([id])}
              onSearch={() => setView('search')}
            />
          )}{' '}
          {view === 'guide' && <GuideView onLogin={() => void connect('login')} />}
        </main>
      </div>
      {toast && (
        <div className={`toast ${toast.error ? 'toast-error' : ''}`} role="status">
          {toast.error ? <AlertCircle size={20} /> : <CheckCircle2 size={20} />}
          <span>{toast.text}</span>
          <button onClick={() => setToast(null)} aria-label="关闭提示">
            <X size={18} />
          </button>
        </div>
      )}
      {connectionOpen && (
        <Modal title="浏览器连接" onClose={() => setConnectionOpen(false)}>
          <div className="connection-detail">
            <Monitor size={44} strokeWidth={1.4} />
            <h3>{state.connection.connected ? '已连接本地浏览器' : '连接你的抖音账号'}</h3>
            <p>{state.connection.message}</p>
            <small>
              {state.connection.checkedAt
                ? `上次检查 ${time(state.connection.checkedAt)}`
                : '登录窗口与本工作台分开显示'}
            </small>
          </div>
          {browserBusy && <p className="connection-progress">{browserJob.phase}</p>}
          {browserJob?.status === 'failed' && <ErrorNotice>{browserJob.error}</ErrorNotice>}
          <div className="modal-actions">
            <Button onClick={() => void connect('check')} busy={browserBusy}>
              <RefreshCw size={17} />
              检查连接
            </Button>
            <Button tone="primary" onClick={() => void connect('login')} disabled={browserBusy}>
              <LogIn size={17} />
              打开扫码登录
            </Button>
          </div>
          <p className="modal-footnote">
            在弹出的 Chrome 中扫码后，回到这里再次检查连接。不要在聊天中分享 Cookie。
          </p>
        </Modal>
      )}
    </div>
  );
}
