import type { UsageOverview, UsageStats, UsageModel } from '../shared/upstreamUsage.js';
import { getUsageOverview } from './usageCollectionService.js';

/** Never fills missing upstream amounts with local estimates. */
export function summarizeUsageFinances(overview: UsageOverview) {
  const accounts = overview.accounts.filter((account) => !account.duplicateOf);
  const amounts: number[] = []; const totals: number[] = [];
  const sites: Record<number, { amount: number | null; covered: number; expected: number; updatedAt: string | null }> = {};
  for (const account of accounts) {
    const site = sites[account.siteId] ||= { amount: null, covered: 0, expected: 0, updatedAt: null };
    site.expected++;
    const record = overview.records.find((row) => row.accountId === account.accountId && row.kind === 'stats' && row.day === overview.today);
    const data = record?.data as UsageStats | undefined;
    if (typeof data?.today.actualCost === 'number') {
      site.amount = (site.amount ?? 0) + data.today.actualCost; site.covered++;
      site.updatedAt = !site.updatedAt || record!.fetchedAt < site.updatedAt ? record!.fetchedAt : site.updatedAt;
      amounts.push(data.today.actualCost);
    }
    const latest = overview.records.filter((row) => row.accountId === account.accountId && row.kind === 'stats').sort((a, b) => b.fetchedAt.localeCompare(a.fetchedAt))[0]?.data as UsageStats | undefined;
    if (typeof latest?.total.actualCost === 'number') totals.push(latest.total.actualCost);
  }
  const daily = new Map<string, { day: string; spend: number; calls: number; tokens: number; covered: number }>();
  for (const record of overview.records.filter((row) => row.kind === 'models')) {
    const models = record.data as UsageModel[];
    if (!models.every((model) => model.actualCost !== null)) continue;
    const entry = daily.get(record.day) || { day: record.day, spend: 0, calls: 0, tokens: 0, covered: 0 };
    entry.covered++;
    for (const model of models) { entry.spend += model.actualCost!; entry.calls += model.requests ?? 0; entry.tokens += model.totalTokens ?? 0; }
    daily.set(record.day, entry);
  }
  return {
    todaySpend: amounts.length ? amounts.reduce((sum, amount) => sum + amount, 0) : null,
    totalUsed: totals.length ? totals.reduce((sum, amount) => sum + amount, 0) : null,
    covered: amounts.length, expected: accounts.length, sites,
    dailyTrend: [...daily.values()].filter((row) => row.covered === accounts.length).sort((a, b) => a.day.localeCompare(b.day)),
  };
}

export async function getUsageFinancialSummary() { return summarizeUsageFinances(await getUsageOverview()); }

export async function getUpstreamModelAnalysis() {
  const overview = await getUsageOverview();
  const models = new Map<string, { model: string; spend: number; calls: number; tokens: number; successRate: null; avgLatencyMs: null }>();
  for (const record of overview.records.filter((row) => row.kind === 'models' && row.day === overview.today)) {
    for (const item of record.data as UsageModel[]) {
      const row = models.get(item.model) || { model: item.model, spend: 0, calls: 0, tokens: 0, successRate: null, avgLatencyMs: null };
      row.spend += item.actualCost ?? 0; row.calls += item.requests ?? 0; row.tokens += item.totalTokens ?? 0;
      models.set(item.model, row);
    }
  }
  const ranking = [...models.values()].sort((a, b) => b.spend - a.spend);
  const totals = ranking.reduce((total, row) => ({ spend: total.spend + row.spend, calls: total.calls + row.calls, tokens: total.tokens + row.tokens }), { spend: 0, calls: 0, tokens: 0 });
  return {
    window: { start: overview.today, end: overview.today, days: 1 }, totals,
    spendDistribution: ranking.map(({ model, spend, calls }) => ({ model, spend, calls })),
    spendTrend: models.size ? [{ day: overview.today, spend: totals.spend }] : [],
    callsDistribution: ranking.map(({ model, calls }) => ({ model, calls, share: totals.calls ? calls / totals.calls * 100 : 0 })),
    callRanking: ranking,
  };
}
