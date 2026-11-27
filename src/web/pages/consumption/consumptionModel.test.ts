import { describe, expect, it } from 'vitest';
import type { UsageOverview, UsageMetrics } from '../../../server/shared/upstreamUsage.js';
import { DEFAULT_USAGE_POLICY } from '../../../server/shared/upstreamUsage.js';
import { analyzeConsumption, emptyMetrics, money } from './consumptionModel.js';

function fixture(): UsageOverview {
  const metrics: UsageMetrics = { ...emptyMetrics(), actualCost: 0.1, requests: 10, totalTokens: 100 };
  return {
    today: '2026-11-27', timeZone: 'Asia/Shanghai',
    accounts: [1, 2].map((id) => ({ accountId: id, siteId: id, siteName: `site-${id}`, accountName: 'account', balance: 3, supported: true, duplicateOf: null, reason: null, policy: DEFAULT_USAGE_POLICY, state: null })),
    records: [
      { accountId: 1, day: '2026-11-27', kind: 'stats', timeZone: 'Asia/Shanghai', fetchedAt: '2026-11-27T01:00:00Z', data: { today: metrics, total: metrics, platforms: [{ platform: 'deepseek', today: metrics, total: metrics }] } },
      { accountId: 1, day: '2026-11-26', kind: 'models', timeZone: 'Asia/Shanghai', fetchedAt: '2026-11-27T01:00:00Z', data: [{ ...metrics, model: 'a' }] },
      { accountId: 1, day: '2026-11-27', kind: 'models', timeZone: 'Asia/Shanghai', fetchedAt: '2026-11-27T01:00:00Z', data: [{ ...metrics, model: 'a' }, { ...metrics, actualCost: 0.2, model: 'b' }] },
    ],
  };
}
const filter = { start: '2026-11-27', end: '2026-11-27', siteId: '', platform: '', model: '' };

describe('consumption analysis scope', () => {
  it('uses account stats for today and never adds model or key totals to it', () => {
    const result = analyzeConsumption(fixture(), filter);
    expect(result.totals.actualCost).toBe(0.1);
    expect(result.covered).toBe(1); expect(result.expected).toBe(2);
    expect(result.sites.find((site) => site.siteId === 2)?.metrics.actualCost).toBeNull();
  });
  it('retains missing dates and account coverage for historical windows', () => {
    const result = analyzeConsumption(fixture(), { ...filter, start: '2026-11-25' });
    expect(result.expected).toBe(6); expect(result.covered).toBe(2);
    expect(result.days[0].metrics.actualCost).toBeNull();
    expect(result.totals.actualCost).toBeCloseTo(0.4);
  });
  it('carries site/model filters without guessing vendor-model relations', () => {
    const result = analyzeConsumption(fixture(), { ...filter, siteId: '1', model: 'b' });
    expect(result.totals.actualCost).toBe(0.2); expect(result.expected).toBe(1);
    const vendor = analyzeConsumption(fixture(), { ...filter, platform: 'deepseek' });
    expect(vendor.totals.actualCost).toBe(0.1); expect(vendor.models).toEqual([]);
  });
  it('distinguishes confirmed empty zero periods from missing periods', () => {
    const data = fixture(); data.records = [ { ...data.records[1], data: [] } ];
    const result = analyzeConsumption(data, { ...filter, siteId: '1', start: '2026-11-26', end: '2026-11-26' });
    expect(result.totals.actualCost).toBe(0); expect(result.covered).toBe(1);
    expect(money(null)).toBe('—'); expect(money(0)).toBe('$0.00');
  });
  it('shows zero for an absent model in a complete upstream model snapshot', () => {
    const result = analyzeConsumption(fixture(), { ...filter, siteId: '1', model: 'absent' });
    expect(result.totals.actualCost).toBe(0);
    expect(result.covered).toBe(1);
  });
  it('keeps vendor and model scopes separate, including URL combinations', () => {
    const data = fixture();
    expect(analyzeConsumption(data, { ...filter, model: 'a' }).platforms).toEqual([]);
    const invalid = analyzeConsumption(data, { ...filter, platform: 'deepseek', start: '2026-11-26' });
    expect(invalid.totals.actualCost).toBeNull(); expect(invalid.covered).toBe(0);
    const vendor = analyzeConsumption(data, { ...filter, platform: 'unknown' });
    expect(vendor.platforms).toEqual([]);
  });
  it('drills down to one account without adding other accounts at the same site', () => {
    const data = fixture(); data.accounts[1].siteId = 1;
    const result = analyzeConsumption(data, { ...filter, accountId: '1' });
    expect(result.accounts).toHaveLength(1); expect(result.expected).toBe(1);
    expect(result.accountRows[0].metrics.actualCost).toBe(0.1);
    expect(analyzeConsumption(data, { ...filter, accountId: '2' }).totals.actualCost).toBeNull();
  });
});
