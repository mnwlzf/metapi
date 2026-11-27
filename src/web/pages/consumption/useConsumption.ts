import { useCallback, useEffect, useState } from 'react';
import { api } from '../../api.js';
import type { UsageOverview } from '../../../server/shared/upstreamUsage.js';

export function useConsumption() {
  const [data, setData] = useState<UsageOverview | null>(null);
  const [error, setError] = useState('');
  const reload = useCallback(async () => {
    try { setData(await api.getConsumption()); setError(''); }
    catch (error) { setError(error instanceof Error ? error.message : '消费数据加载失败'); }
  }, []);
  useEffect(() => {
    void reload();
    const timer = window.setInterval(() => { if (!document.hidden) void reload(); }, 30_000);
    return () => window.clearInterval(timer);
  }, [reload]);
  return { data, error, reload };
}
