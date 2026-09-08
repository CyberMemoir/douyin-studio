export async function api<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(`/api${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: body === undefined ? {} : { 'Content-Type': 'application/json', 'X-Studio-Client': '1' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const data = await response.json().catch(() => ({ error: '服务没有返回有效数据' }));
  if (!response.ok) throw new Error(data.error || `请求失败 (${response.status})`);
  return data;
}

export function number(value: number | null): string {
  if (value === null) return '—';
  if (value >= 1e8) return `${(value / 1e8).toFixed(1)}亿`;
  if (value >= 1e4) return `${(value / 1e4).toFixed(1)}万`;
  return value.toLocaleString('zh-CN');
}
export function bytes(value = 0): string {
  if (value >= 1024 ** 3) return `${(value / 1024 ** 3).toFixed(2)} GB`;
  if (value >= 1024 ** 2) return `${(value / 1024 ** 2).toFixed(1)} MB`;
  return `${(value / 1024).toFixed(0)} KB`;
}
export function duration(value: number): string {
  if (!value) return '视频';
  return `${Math.floor(value / 60)
    .toString()
    .padStart(2, '0')}:${(value % 60).toString().padStart(2, '0')}`;
}
export function time(value: string | null): string {
  return value
    ? new Date(value).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
    : '尚未更新';
}
