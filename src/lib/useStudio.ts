import { useCallback, useEffect, useState } from 'react';
import type { Snapshot } from '../../shared/types';
import { api } from './api';

const initial: Snapshot = {
  jobs: [],
  trends: [],
  trendsAt: null,
  connection: { connected: false, login: 'unknown', checkedAt: null, message: '尚未检查浏览器连接' },
};
export function useStudio() {
  const [state, setState] = useState<Snapshot>(initial);
  const [online, setOnline] = useState(true);
  const refresh = useCallback(async () => {
    try {
      setState(await api<Snapshot>('/state'));
      setOnline(true);
    } catch {
      setOnline(false);
    }
  }, []);
  useEffect(() => {
    void refresh();
    const events = new EventSource('/api/events');
    events.onmessage = (event) => {
      try {
        setState(JSON.parse(event.data));
        setOnline(true);
      } catch {
        /* Next event refreshes state. */
      }
    };
    events.onerror = () => {
      setOnline(false);
    };
    const fallback = setInterval(() => {
      if (events.readyState !== EventSource.OPEN) void refresh();
    }, 5000);
    return () => {
      events.close();
      clearInterval(fallback);
    };
  }, [refresh]);
  return { state, online, refresh };
}
