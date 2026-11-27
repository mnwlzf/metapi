import { eq } from 'drizzle-orm';
import { db, schema } from '../db/index.js';
import { shiftUsageDay } from './usageCollectionPolicy.js';
import {
  readSnapshotCache,
  type SnapshotEnvelope,
} from './snapshotCacheService.js';
import { createAdminSnapshotPersistence } from './adminSnapshotStore.js';
import { getUsageOverview } from './usageCollectionService.js';
import { summarizeUsageFinances } from './usageFinancialSummary.js';
import type { UsageModel } from '../shared/upstreamUsage.js';

export type SiteStatsSnapshotPayload = {
  distribution: Array<{
    siteId: number;
    siteName: string;
    platform: string | null;
    totalBalance: number;
    totalSpend: number | null;
    todaySpend: number | null;
    accountCount: number;
  }>;
  trend: Array<{
    date: string;
    sites: Record<string, { spend: number; calls: number }>;
  }>;
  granularity: 'hour' | 'day';
  sites: Array<typeof schema.sites.$inferSelect>;
};

const SITE_STATS_TTL_MS = 15_000;

async function loadSiteStatsSnapshotPayload(
  days: number,
): Promise<SiteStatsSnapshotPayload> {
  const overview = await getUsageOverview();
  const actual = summarizeUsageFinances(overview);
  const sinceDay = shiftUsageDay(overview.today, -(days - 1));
  const sites = await db.select().from(schema.sites).where(eq(schema.sites.status, 'active')).all();
  const eligible = overview.accounts.filter((account) => !account.duplicateOf);
  const distribution = sites.map((site: typeof schema.sites.$inferSelect) => {
    const accounts = eligible.filter((account) => account.siteId === site.id);
    const values = overview.records.filter((row) => accounts.some((account) => account.accountId === row.accountId) && row.kind === 'models' && row.day >= sinceDay);
    const spend = values.flatMap((row) => row.data as UsageModel[]).reduce((sum, row) => sum + (row.actualCost ?? 0), 0);
    return {
      siteId: site.id, siteName: site.name, platform: site.platform,
      totalBalance: accounts.reduce((sum, account) => sum + (account.balance ?? 0), 0),
      totalSpend: values.length && values.length === accounts.length * days ? spend : null,
      todaySpend: actual.sites[site.id]?.covered === accounts.length ? actual.sites[site.id]?.amount ?? null : null, accountCount: accounts.length,
    };
  });
  const frame = new Map<string, Record<string, { spend: number; calls: number }>>();
  for (const record of overview.records.filter((row) => row.kind === 'models' && row.day >= sinceDay)) {
    const account = eligible.find((account) => account.accountId === record.accountId);
    if (!account) continue;
    const siteAccounts = eligible.filter((row) => row.siteId === account.siteId);
    const coverage = overview.records.filter((row) => row.kind === 'models' && row.day === record.day && siteAccounts.some((item) => item.accountId === row.accountId));
    if (coverage.length !== siteAccounts.length) continue;
    const sites = frame.get(record.day) || {};
    const value = sites[account.siteName] ||= { spend: 0, calls: 0 };
    for (const model of record.data as UsageModel[]) { value.spend += model.actualCost ?? 0; value.calls += model.requests ?? 0; }
    frame.set(record.day, sites);
  }
  return {
    distribution,
    trend: [...frame.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([date, sites]) => ({ date, sites })),
    granularity: 'day', sites,
  };
}

export async function getSiteStatsSnapshot(options?: {
  days?: number;
  forceRefresh?: boolean;
}): Promise<SnapshotEnvelope<SiteStatsSnapshotPayload>> {
  const days = Math.max(1, Math.trunc(options?.days || 7));
  return readSnapshotCache({
    namespace: 'site-stats-actual-v1',
    key: JSON.stringify({ days }),
    ttlMs: SITE_STATS_TTL_MS,
    forceRefresh: options?.forceRefresh,
    persistence: createAdminSnapshotPersistence<SiteStatsSnapshotPayload>({
      namespace: 'site-stats-actual-v1',
      key: JSON.stringify({ days }),
    }),
    loader: async () => loadSiteStatsSnapshotPayload(days),
  });
}
