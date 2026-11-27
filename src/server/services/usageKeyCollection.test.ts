import { describe, expect, it } from 'vitest';
import type { UsageAccountState, UsageCollectedRecord } from '../shared/upstreamUsage.js';
import { appendUsageCatalogPage, appendUsageKeyBatch, needsUsageKeyCatalog, usageKeyBatch } from './usageKeyCollection.js';

function state(): UsageAccountState {
  return { tasks: Object.fromEntries(['stats', 'keys', 'models', 'catalog'].map((kind) => [kind, { nextAt: 0, failures: 0 }])) as UsageAccountState['tasks'], cooldownUntil: 0, requestTimes: [], historyRequests: 0, pendingDays: [] };
}

describe('batched Key usage collection', () => {
  it('publishes a catalog only when every page has been gathered without duplicate IDs', () => {
    const value = state();
    const first = appendUsageCatalogPage(value, [{ upstreamId: 1, name: 'one', group: null, localTokenId: null }], 2);
    expect(first).toBeNull(); expect(value.catalogScan?.page).toBe(2);
    const complete = appendUsageCatalogPage(value, [{ upstreamId: 2, name: 'two', group: null, localTokenId: null }], null);
    expect(complete?.map((key) => key.upstreamId)).toEqual([1, 2]); expect(value.catalogScan).toBeUndefined();
    appendUsageCatalogPage(value, [{ upstreamId: 1, name: 'one', group: null, localTokenId: null }], 2);
    expect(() => appendUsageCatalogPage(value, [{ upstreamId: 1, name: 'duplicate', group: null, localTokenId: null }], null)).toThrow();
  });
  it('requires a fresh completed catalog and resumes Key IDs in bounded batches', () => {
    const value = state(); const record = { accountId: 1, kind: 'catalog', day: '2026-11-27', timeZone: 'Asia/Shanghai', fetchedAt: '2026-11-27T00:00:00Z', data: Array.from({ length: 205 }, (_, index) => ({ upstreamId: index + 1, name: 'key', group: null, localTokenId: null })) } as UsageCollectedRecord;
    expect(needsUsageKeyCatalog(value, record)).toBe(true);
    value.catalogCompleteAt = record.fetchedAt;
    expect(needsUsageKeyCatalog(value, record)).toBe(false);
    const first = usageKeyBatch(value, record, '2026-11-27', 'Asia/Shanghai');
    expect(first).toHaveLength(100); expect(appendUsageKeyBatch(value, first, first.map((upstreamId) => ({ upstreamId, todayActualCost: 0, recentActualCost: 0 })))).toBeNull();
    const second = usageKeyBatch(value, record, '2026-11-27', 'Asia/Shanghai');
    expect(second).toHaveLength(100); expect(appendUsageKeyBatch(value, second, second.map((upstreamId) => ({ upstreamId, todayActualCost: 1, recentActualCost: 2 })))).toBeNull();
    const third = usageKeyBatch(value, record, '2026-11-27', 'Asia/Shanghai');
    expect(third).toHaveLength(5); expect(appendUsageKeyBatch(value, third, third.map((upstreamId) => ({ upstreamId, todayActualCost: 0, recentActualCost: 0 })))).toHaveLength(205);
    expect(value.keyScan).toBeUndefined();
    expect(() => usageKeyBatch(value, undefined, '2026-11-27', 'Asia/Shanghai')).toThrow();
  });
  it('validates returned IDs before a batch can advance', () => {
    const value = state(); const record = { accountId: 1, kind: 'catalog', day: '2026-11-27', timeZone: 'Asia/Shanghai', fetchedAt: 'now', data: [{ upstreamId: 2, name: 'key', group: null, localTokenId: null }] } as UsageCollectedRecord;
    value.catalogCompleteAt = 'now'; const ids = usageKeyBatch(value, record, '2026-11-27', 'Asia/Shanghai');
    expect(() => appendUsageKeyBatch(value, ids, [{ upstreamId: 3, todayActualCost: 0, recentActualCost: 0 }])).toThrow();
  });
});
