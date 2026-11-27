import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_USAGE_POLICY, type UsageOverview } from '../shared/upstreamUsage.js';
vi.mock('./usageCollectionService.js', () => ({ getUsageOverview: vi.fn() }));
import { summarizeUsageFinances } from './usageFinancialSummary.js';

describe('actual financial summary', () => {
  it('preserves actual zero, excludes duplicate identities and marks missing accounts', () => {
    const overview: UsageOverview = {
      timeZone: 'Asia/Shanghai', today: '2026-11-27',
      accounts: [1, 2, 3].map((id) => ({ accountId: id, siteId: 1, siteName: 'site', accountName: 'a', balance: 1, supported: true, duplicateOf: id === 3 ? 1 : null, reason: null, policy: DEFAULT_USAGE_POLICY, state: null })),
      records: [{ accountId: 1, kind: 'stats', day: '2026-11-27', timeZone: 'Asia/Shanghai', fetchedAt: '2026-11-27T01:00:00Z', data: { today: { actualCost: 0 }, total: { actualCost: 1.000000123 }, platforms: [] } as never }],
    };
    const summary = summarizeUsageFinances(overview);
    expect(summary.todaySpend).toBe(0); expect(summary.totalUsed).toBe(1.000000123);
    expect(summary.covered).toBe(1); expect(summary.expected).toBe(2);
    expect(summary.sites[1]).toMatchObject({ amount: 0, covered: 1, expected: 2 });
  });
  it('never carries yesterday’s daily charge into today', () => {
    const overview: UsageOverview = { today: '2026-11-27', timeZone: 'Asia/Shanghai', accounts: [{ accountId: 1, siteId: 1, duplicateOf: null } as never], records: [{ accountId: 1, kind: 'stats', day: '2026-11-26', fetchedAt: '2026-11-26T01:00:00Z', data: { today: { actualCost: 5 }, total: { actualCost: 7 } } } as never] };
    expect(summarizeUsageFinances(overview)).toMatchObject({ todaySpend: null, totalUsed: 7, covered: 0 });
  });
  it('does not plot incomplete daily totals as full daily consumption', () => {
    const overview: UsageOverview = { today: '2026-11-27', timeZone: 'Asia/Shanghai', accounts: [1, 2].map((accountId) => ({ accountId, siteId: 1, duplicateOf: null } as never)), records: [ { accountId: 1, kind: 'models', day: '2026-11-26', fetchedAt: '2026-11-27T01:00:00Z', data: [{ actualCost: 3 }] } as never ] };
    expect(summarizeUsageFinances(overview).dailyTrend).toEqual([]);
    overview.records.push({ ...overview.records[0], accountId: 2, data: [] });
    expect(summarizeUsageFinances(overview).dailyTrend[0].spend).toBe(3);
  });
});
