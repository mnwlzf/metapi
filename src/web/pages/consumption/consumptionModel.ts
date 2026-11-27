import type { UsageMetrics, UsageModel, UsageOverview, UsageStats } from '../../../server/shared/upstreamUsage.js';

export const metricKeys = ['actualCost', 'originalCost', 'requests', 'inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheCreationTokens', 'totalTokens'] as const;
export function emptyMetrics(): UsageMetrics { return Object.fromEntries(metricKeys.map((key) => [key, null])) as UsageMetrics; }
export function addMetrics(target: UsageMetrics, row: UsageMetrics): void {
  for (const key of metricKeys) if (row[key] !== null) target[key] = (target[key] ?? 0) + row[key]!;
}
export function money(value: number | null | undefined): string {
  return value == null ? '—' : `$${value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 6 })}`;
}
export function count(value: number | null | undefined): string { return value == null ? '—' : value.toLocaleString('zh-CN'); }
export function when(value: string | number | null | undefined): string { return value ? new Date(value).toLocaleString('zh-CN', { hour12: false }) : '尚未同步'; }
export function percent(part: number | null, total: number | null): string { return part !== null && total !== null && total > 0 ? `${(part / total * 100).toFixed(1)}%` : '—'; }

export type ConsumptionFilter = { start: string; end: string; siteId: string; accountId?: string; platform: string; model: string };
export type ConsumptionRow = { key: string; label: string; siteId?: number; accountId?: number; platform?: string; model?: string; metrics: UsageMetrics; coverage: number; expected: number };

export function analyzeConsumption(data: UsageOverview, filter: ConsumptionFilter) {
  const accounts = data.accounts.filter((account) => !account.duplicateOf && (!filter.siteId || String(account.siteId) === filter.siteId) && (!filter.accountId || String(account.accountId) === filter.accountId));
  const ids = new Set(accounts.map((account) => account.accountId));
  const records = data.records.filter((row) => ids.has(row.accountId));
  const todayOnly = filter.start === data.today && filter.end === data.today;
  const totals = emptyMetrics();
  const sites = new Map<string, ConsumptionRow>(); const models = new Map<string, ConsumptionRow>();
  const accountRows = new Map<string, ConsumptionRow>();
  const platforms = new Map<string, ConsumptionRow>(); const days = new Map<string, ConsumptionRow>();
  const covered = new Set<string>();
  const zeroMetrics = () => Object.fromEntries(metricKeys.map((key) => [key, 0])) as UsageMetrics;
  const unsupportedScope = !!filter.platform && (!todayOnly || !!filter.model);
  const ensure = (map: Map<string, ConsumptionRow>, key: string, label: string, extra: Partial<ConsumptionRow> = {}) => {
    let row = map.get(key);
    if (!row) { row = { key, label, metrics: emptyMetrics(), coverage: 0, expected: accounts.length, ...extra }; map.set(key, row); }
    return row;
  };
  for (const account of accounts) {
    const site = ensure(sites, String(account.siteId), account.siteName, { siteId: account.siteId });
    const accountRow = ensure(accountRows, String(account.accountId), `${account.siteName} · ${account.accountName}`, { accountId: account.accountId, siteId: account.siteId, expected: 1 });
    const stats = records.find((row) => row.accountId === account.accountId && row.kind === 'stats' && row.day === data.today)?.data as UsageStats | undefined;
    if (stats && !filter.model) for (const vendor of stats.platforms) {
      if (filter.platform && vendor.platform !== filter.platform) continue;
      const row = ensure(platforms, vendor.platform, vendor.platform, { platform: vendor.platform });
      addMetrics(row.metrics, vendor.today); row.coverage++;
    }
    const dailyModels = records.filter((row) => row.accountId === account.accountId && row.kind === 'models' && row.day >= filter.start && row.day <= filter.end);
    for (const record of dailyModels) {
      for (const model of record.data as UsageModel[]) {
        if (filter.model && model.model !== filter.model) continue;
        addMetrics(ensure(models, model.model, model.model, { model: model.model }).metrics, model);
      }
      if ((!todayOnly || filter.model) && !unsupportedScope) {
        const day = ensure(days, record.day, record.day);
        const matching = (record.data as UsageModel[]).filter((model) => !filter.model || model.model === filter.model);
        if (matching.length === 0) {
          const zero = zeroMetrics();
          addMetrics(totals, zero); addMetrics(site.metrics, zero); addMetrics(day.metrics, zero); addMetrics(accountRow.metrics, zero);
        }
        for (const model of matching) {
          addMetrics(totals, model); addMetrics(site.metrics, model); addMetrics(day.metrics, model); addMetrics(accountRow.metrics, model);
        }
        covered.add(`${account.accountId}:${record.day}`); day.coverage++;
        site.coverage++; accountRow.coverage++;
      }
    }
    if (todayOnly && !filter.model && stats && !unsupportedScope) {
      const selected = filter.platform ? stats.platforms.find((vendor) => vendor.platform === filter.platform)?.today : stats.today;
      if (selected) {
        addMetrics(totals, selected); addMetrics(site.metrics, selected); addMetrics(accountRow.metrics, selected);
        const day = ensure(days, data.today, data.today);
        addMetrics(day.metrics, selected);
        if (selected.actualCost !== null) {
          day.coverage++;
          covered.add(`${account.accountId}:${data.today}`); site.coverage++; accountRow.coverage++;
        }
      }
    }
  }
  // A vendor filter is only supported by today's stats, never inferred from model names.
  if (filter.platform) models.clear();
  const daysCount = Math.round((Date.parse(filter.end) - Date.parse(filter.start)) / 86400_000) + 1;
  if (Number.isFinite(daysCount) && daysCount > 0 && daysCount <= 31) {
    for (let index = 0; index < daysCount; index++) {
      const day = new Date(Date.parse(`${filter.start}T12:00:00Z`) + index * 86400_000).toISOString().slice(0, 10);
      ensure(days, day, day);
    }
  }
  const expected = accounts.length * daysCount;
  const sort = (map: Map<string, ConsumptionRow>) => [...map.values()].sort((a, b) => (b.metrics.actualCost ?? -1) - (a.metrics.actualCost ?? -1));
  return { accounts, totals, sites: sort(sites), accountRows: sort(accountRows), models: sort(models), platforms: sort(platforms), days: [...days.values()].sort((a, b) => a.key.localeCompare(b.key)), covered: covered.size, expected, todayOnly };
}
