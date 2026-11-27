import { and, desc, eq, gte, lt, sql } from 'drizzle-orm';
import { db, schema } from '../db/index.js';
import { parseCheckinRewardAmount } from './checkinRewardParser.js';
import {
  formatUtcSqlDateTime,
  getLocalDayRangeUtc,
  getLocalHourAnchor,
  getLocalHourRangeStartUtc,
  getLocalRangeStartDayKey,
  toLocalDayKeyFromStoredUtc,
} from './localTimeService.js';
import {
  readSnapshotCache,
  type SnapshotEnvelope,
} from './snapshotCacheService.js';
import {buildSiteAvailabilitySummariesFromHourlyAggregates, buildModelAvailabilitySummaries, type SiteAvailabilitySiteRow, toRoundedMicroNumber} from './statsShared.js';
import { estimateRewardWithTodayIncomeFallback } from './todayIncomeRewardService.js';
import { createAdminSnapshotPersistence } from './adminSnapshotStore.js';
import { runUsageAggregationProjectionPass } from './usageAggregationService.js';
import { calculateProxyQualityMetrics } from './proxyQualityMetrics.js';
import { getUpstreamModelAnalysis, getUsageFinancialSummary } from './usageFinancialSummary.js';

export type DashboardSummaryPayload = {
  totalBalance: number;
  totalUsed: number | null;
  todaySpend: number | null;
  actualCostCoverage?: { covered: number; expected: number };
  todayReward: number;
  activeAccounts: number;
  totalAccounts: number;
  todayCheckin: { success: number; failed: number; total: number };
  dailyTrend: Array<{ day: string; spend: number; calls: number; tokens: number }>;
  dailyCheckin: Array<{ day: string; success: number; failed: number }>;
  proxy24h: {
    success: number;
    failed: number;
    total: number;
    totalTokens: number;
  };
  performance: {
    windowSeconds: number;
    requestsPerMinute: number;
    tokensPerMinute: number;
    qualityWindowHours: number;
    qualitySampleCount: number;
    successRatePercent: number | null;
    p95FirstByteLatencyMs: number | null;
    p95LatencyMs: number | null;
    qualitySparse: boolean;
  };
};

export type DashboardInsightsPayload = {
  siteAvailability: ReturnType<
    typeof buildSiteAvailabilitySummariesFromHourlyAggregates
  >;
  modelAvailability: ReturnType<
    typeof buildModelAvailabilitySummaries
  >;
  modelAnalysis: Awaited<ReturnType<typeof getUpstreamModelAnalysis>>;
};

const DASHBOARD_SUMMARY_TTL_MS = 12_000;
const DASHBOARD_INSIGHTS_TTL_MS = 20_000;
const SITE_AVAILABILITY_BUCKET_COUNT = 24;
const dashboardSummaryPersistence =
  createAdminSnapshotPersistence<DashboardSummaryPayload>({
    namespace: 'dashboard-summary-actual-v1',
    key: 'default',
  });
const dashboardInsightsPersistence =
  createAdminSnapshotPersistence<DashboardInsightsPayload>({
    namespace: 'dashboard-insights-actual-v1',
    key: 'default',
  });

async function loadDashboardSummaryPayload(): Promise<DashboardSummaryPayload> {
  await runUsageAggregationProjectionPass();

  const accountRows = await db
    .select()
    .from(schema.accounts)
    .innerJoin(schema.sites, eq(schema.accounts.siteId, schema.sites.id))
    .all();
  const accounts = accountRows.map((row: any) => row.accounts);
  const totalBalance = accounts.reduce(
    (sum: any, account: any) => sum + (account.balance || 0),
    0,
  );
  const activeCount = accounts.filter(
    (account: any) => account.status === 'active',
  ).length;

  const {
    localDay: today,
    startUtc: todayStartUtc,
    endUtc: todayEndUtc,
  } = getLocalDayRangeUtc();
  const nowTs = Date.now();
  const last24hDate = formatUtcSqlDateTime(new Date(nowTs - 86_400_000));
  const lastMinuteDate = formatUtcSqlDateTime(new Date(nowTs - 60_000));

  const [
    todayCheckinRows,
    proxy24hRow,
    proxyPerformanceRow,
    proxyQualityRows,
  ] = await Promise.all([
    db
      .select()
      .from(schema.checkinLogs)
      .innerJoin(
        schema.accounts,
        eq(schema.checkinLogs.accountId, schema.accounts.id),
      )
      .innerJoin(schema.sites, eq(schema.accounts.siteId, schema.sites.id))
      .where(
        and(
          gte(schema.checkinLogs.createdAt, todayStartUtc),
          lt(schema.checkinLogs.createdAt, todayEndUtc),
          eq(schema.sites.status, 'active'),
        ),
      )
      .all(),
    db
      .select({
        total: sql<number>`count(*)`,
        success: sql<number>`coalesce(sum(case when ${schema.proxyLogs.status} = 'success' then 1 else 0 end), 0)`,
        failed: sql<number>`coalesce(sum(case when ${schema.proxyLogs.status} = 'success' then 0 else 1 end), 0)`,
        totalTokens: sql<number>`coalesce(sum(coalesce(${schema.proxyLogs.totalTokens}, 0)), 0)`,
      })
      .from(schema.proxyLogs)
      .innerJoin(
        schema.accounts,
        eq(schema.proxyLogs.accountId, schema.accounts.id),
      )
      .innerJoin(schema.sites, eq(schema.accounts.siteId, schema.sites.id))
      .where(
        and(
          gte(schema.proxyLogs.createdAt, last24hDate),
          eq(schema.sites.status, 'active'),
        ),
      )
      .get(),
    db
      .select({
        total: sql<number>`count(*)`,
        totalTokens: sql<number>`coalesce(sum(coalesce(${schema.proxyLogs.totalTokens}, 0)), 0)`,
      })
      .from(schema.proxyLogs)
      .innerJoin(
        schema.accounts,
        eq(schema.proxyLogs.accountId, schema.accounts.id),
      )
      .innerJoin(schema.sites, eq(schema.accounts.siteId, schema.sites.id))
      .where(
        and(
          gte(schema.proxyLogs.createdAt, lastMinuteDate),
          eq(schema.sites.status, 'active'),
        ),
      )
      .get(),
    db
      .select({
        status: schema.proxyLogs.status,
        firstByteLatencyMs: schema.proxyLogs.firstByteLatencyMs,
        latencyMs: schema.proxyLogs.latencyMs,
      })
      .from(schema.proxyLogs)
      .innerJoin(
        schema.accounts,
        eq(schema.proxyLogs.accountId, schema.accounts.id),
      )
      .innerJoin(schema.sites, eq(schema.accounts.siteId, schema.sites.id))
      .where(
        and(
          gte(schema.proxyLogs.createdAt, last24hDate),
          eq(schema.sites.status, 'active'),
        ),
      )
      .orderBy(desc(schema.proxyLogs.createdAt))
      .limit(5000)
      .all(),
  ]);

  // Site-level checkin stats: one site counts once today.
  // Repeat attempts only refresh that site's outcome (success if any success/skipped).
  const siteCheckinOutcome = new Map<number, 'success' | 'failed'>();
  const rewardByAccount: Record<number, number> = {};
  const successCountByAccount: Record<number, number> = {};
  const parsedRewardCountByAccount: Record<number, number> = {};
  for (const row of todayCheckinRows) {
    const checkin = row.checkin_logs;
    const siteId = row.sites.id;
    const status = String(checkin.status || '');
    const isSuccessLike = status === 'success' || status === 'skipped';
    const prev = siteCheckinOutcome.get(siteId);
    if (isSuccessLike) {
      siteCheckinOutcome.set(siteId, 'success');
    } else if (status === 'failed' && prev !== 'success') {
      siteCheckinOutcome.set(siteId, 'failed');
    } else if (!prev) {
      siteCheckinOutcome.set(siteId, 'failed');
    }

    if (checkin.status !== 'success') continue;
    const accountId = row.accounts.id;
    successCountByAccount[accountId] =
      (successCountByAccount[accountId] || 0) + 1;
    const rewardValue =
      parseCheckinRewardAmount(checkin.reward) ||
      parseCheckinRewardAmount(checkin.message);
    if (rewardValue <= 0) continue;
    rewardByAccount[accountId] =
      (rewardByAccount[accountId] || 0) + rewardValue;
    parsedRewardCountByAccount[accountId] =
      (parsedRewardCountByAccount[accountId] || 0) + 1;
  }
  let checkinSuccess = 0;
  let checkinFailed = 0;
  for (const outcome of siteCheckinOutcome.values()) {
    if (outcome === 'success') checkinSuccess += 1;
    else checkinFailed += 1;
  }
  const checkinTotal = siteCheckinOutcome.size;

  const proxySuccess = Number(proxy24hRow?.success || 0);
  const proxyFailed = Number(proxy24hRow?.failed || 0);
  const proxyTotal = Number(proxy24hRow?.total || 0);
  const totalTokens = Number(proxy24hRow?.totalTokens || 0);
  const requestsPerMinute = Number(proxyPerformanceRow?.total || 0);
  const tokensPerMinute = Number(proxyPerformanceRow?.totalTokens || 0);
  const proxyQuality = calculateProxyQualityMetrics(proxyQualityRows);
  const todayReward = accounts.reduce(
    (sum: any, account: any) =>
      sum +
      estimateRewardWithTodayIncomeFallback({
        day: today,
        successCount: successCountByAccount[account.id] || 0,
        parsedRewardCount: parsedRewardCountByAccount[account.id] || 0,
        rewardSum: rewardByAccount[account.id] || 0,
        extraConfig: account.extraConfig,
      }),
    0,
  );

  // 7-day daily trend for the dashboard sparklines. Spend/calls/tokens come
  // from the model-day usage projection; check-in counts from checkin_logs.
  const trendSinceDay = getLocalRangeStartDayKey(6);
  const trendSinceUtc = new Date(Date.now() - 7 * 86400000)
    .toISOString().slice(0, 19).replace('T', ' ');
  const [dailyCheckinRows] = await Promise.all([
    db
      .select({
        createdAt: schema.checkinLogs.createdAt,
        status: schema.checkinLogs.status,
      })
      .from(schema.checkinLogs)
      .where(gte(schema.checkinLogs.createdAt, trendSinceUtc))
      .all(),
  ]);

  const actual = await getUsageFinancialSummary();
  return {
    totalBalance,
    totalUsed: actual.totalUsed,
    todaySpend: actual.todaySpend,
    actualCostCoverage: { covered: actual.covered, expected: actual.expected },
    todayReward: toRoundedMicroNumber(todayReward),
    activeAccounts: activeCount,
    totalAccounts: accounts.length,
    todayCheckin: {
      success: checkinSuccess,
      failed: checkinFailed,
      total: checkinTotal,
    },
    dailyTrend: actual.dailyTrend.filter((row) => row.day >= trendSinceDay),
    dailyCheckin: (() => {
      // checkin_logs.created_at is stored UTC; dailyTrend uses local-day keys.
      // Bucketing the check-ins by the UTC date string shifted every check-in
      // made between 00:00 and 08:00 Asia/Shanghai into the previous day, so
      // the two series on the same chart disagreed. Aggregate in local time.
      const byDay = new Map<string, { success: number; failed: number }>();
      for (const row of dailyCheckinRows as Array<{ createdAt: string | null; status: string | null }>) {
        const day = toLocalDayKeyFromStoredUtc(row.createdAt);
        if (!day) continue;
        const bucket = byDay.get(day) ?? { success: 0, failed: 0 };
        if (row.status === 'success') bucket.success += 1;
        else if (row.status === 'failed') bucket.failed += 1;
        byDay.set(day, bucket);
      }
      return Array.from(byDay.entries())
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([day, counts]) => ({ day, ...counts }));
    })(),
    proxy24h: {
      success: proxySuccess,
      failed: proxyFailed,
      total: proxyTotal,
      totalTokens,
    },
    performance: {
      windowSeconds: 60,
      requestsPerMinute,
      tokensPerMinute,
      qualityWindowHours: 24,
      qualitySampleCount: proxyQuality.sampleCount,
      successRatePercent: proxyQuality.successRatePercent,
      p95FirstByteLatencyMs: proxyQuality.p95FirstByteLatencyMs,
      p95LatencyMs: proxyQuality.p95LatencyMs,
      qualitySparse: proxyQuality.sparse,
    },
  };
}

async function loadDashboardInsightsPayload(): Promise<DashboardInsightsPayload> {
  const siteAvailabilityNow = getLocalHourAnchor();
  const siteAvailabilitySinceUtc = getLocalHourRangeStartUtc(
    SITE_AVAILABILITY_BUCKET_COUNT,
    siteAvailabilityNow,
  );
  await runUsageAggregationProjectionPass();

  const [activeSites, siteAvailabilityRows, modelAnalysis, modelAvailabilityLogs] =
    await Promise.all([
      db
        .select({
          id: schema.sites.id,
          name: schema.sites.name,
          url: schema.sites.url,
          platform: schema.sites.platform,
          sortOrder: schema.sites.sortOrder,
          isPinned: schema.sites.isPinned,
        })
        .from(schema.sites)
        .where(eq(schema.sites.status, 'active'))
        .all(),
      db
        .select()
        .from(schema.siteHourUsage)
        .where(gte(schema.siteHourUsage.bucketStartUtc, siteAvailabilitySinceUtc))
        .all(),
      getUpstreamModelAnalysis(),
      db
        .select({
          modelActual: schema.proxyLogs.modelActual,
          modelRequested: schema.proxyLogs.modelRequested,
          createdAt: schema.proxyLogs.createdAt,
          status: schema.proxyLogs.status,
          latencyMs: schema.proxyLogs.latencyMs,
        })
        .from(schema.proxyLogs)
        .where(gte(schema.proxyLogs.createdAt, siteAvailabilitySinceUtc))
        .all(),
    ]);

  const sortedSites = activeSites.sort(
    (left: SiteAvailabilitySiteRow, right: SiteAvailabilitySiteRow) => {
      const leftPinned = left.isPinned ? 1 : 0;
      const rightPinned = right.isPinned ? 1 : 0;
      if (leftPinned !== rightPinned) return rightPinned - leftPinned;
      const leftOrder = Number(left.sortOrder || 0);
      const rightOrder = Number(right.sortOrder || 0);
      if (leftOrder !== rightOrder) return leftOrder - rightOrder;
      return String(left.name || '').localeCompare(String(right.name || ''));
    },
  );
  const activeSiteIdSet = new Set(sortedSites.map((site: any) => site.id));

  return {
    siteAvailability: buildSiteAvailabilitySummariesFromHourlyAggregates(
      sortedSites,
      siteAvailabilityRows
        .filter((row: any) => activeSiteIdSet.has(row.siteId))
        .map((row: any) => ({
          siteId: row.siteId,
          hourStartUtc: row.bucketStartUtc,
          totalRequests: row.totalCalls,
          successCount: row.successCalls,
          failedCount: row.failedCalls,
          totalLatencyMs: row.totalLatencyMs,
          latencyCount: row.latencyCount,
        })),
      siteAvailabilityNow,
    ),
    modelAvailability: buildModelAvailabilitySummaries(
      modelAvailabilityLogs.map((row: any) => ({
        model: String(row.modelActual || row.modelRequested || '').trim() || null,
        createdAt: row.createdAt,
        status: row.status,
        latencyMs: row.latencyMs,
      })),
      siteAvailabilityNow,
    ),
    modelAnalysis,
  };
}

export async function getDashboardSummarySnapshot(options?: {
  forceRefresh?: boolean;
}): Promise<SnapshotEnvelope<DashboardSummaryPayload>> {
  return readSnapshotCache({
    namespace: 'dashboard-summary-actual-v1',
    key: 'default',
    ttlMs: DASHBOARD_SUMMARY_TTL_MS,
    forceRefresh: options?.forceRefresh,
    persistence: dashboardSummaryPersistence,
    loader: loadDashboardSummaryPayload,
  });
}

export async function getDashboardInsightsSnapshot(options?: {
  forceRefresh?: boolean;
}): Promise<SnapshotEnvelope<DashboardInsightsPayload>> {
  return readSnapshotCache({
    namespace: 'dashboard-insights-actual-v1',
    key: 'default',
    ttlMs: DASHBOARD_INSIGHTS_TTL_MS,
    forceRefresh: options?.forceRefresh,
    persistence: dashboardInsightsPersistence,
    loader: loadDashboardInsightsPayload,
  });
}
