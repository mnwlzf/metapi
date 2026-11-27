import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DEFAULT_USAGE_POLICY } from '../shared/upstreamUsage.js';
import { UsageDashboardError } from './platforms/usageDashboard.js';

const mocks = vi.hoisted(() => ({ fetch: vi.fn(), catalog: vi.fn(), refresh: vi.fn() }));
vi.mock('./platforms/index.js', () => ({ getAdapter: (platform: string) => platform === 'sub2api' ? { getUsageDashboard: mocks.fetch, getUsageKeyCatalog: mocks.catalog } : {} }));
vi.mock('./sub2apiRefreshSingleflight.js', () => ({ refreshSub2ApiManagedSessionSingleflight: mocks.refresh }));

describe('background consumption collection', () => {
  let db: typeof import('../db/index.js')['db'];
  let schema: typeof import('../db/index.js')['schema'];
  let service: typeof import('./usageCollectionService.js');
  let store: typeof import('./usageCollectionStore.js');
  const originalDataDir = process.env.DATA_DIR;
  beforeAll(async () => {
    process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'metapi-consumption-'));
    await import('../db/migrate.js');
    ({ db, schema } = await import('../db/index.js'));
    service = await import('./usageCollectionService.js');
    store = await import('./usageCollectionStore.js');
  });
  beforeEach(async () => {
    vi.restoreAllMocks(); vi.clearAllMocks();
    await db.delete(schema.adminSnapshots).run(); await db.delete(schema.settings).run();
    await db.delete(schema.accounts).run(); await db.delete(schema.sites).run();
    await db.insert(schema.sites).values({ id: 1, name: 'test', url: 'https://offline.invalid', platform: 'sub2api' }).run();
    await db.insert(schema.accounts).values({ id: 1, siteId: 1, accessToken: 'offline-session', extraConfig: JSON.stringify({ credentialMode: 'session', platformUserId: 13 }) }).run();
    mocks.fetch.mockResolvedValue({ today: { actualCost: 0.123456789 }, total: { actualCost: 3 }, platforms: [] });
    mocks.catalog.mockResolvedValue([]);
  });
  afterAll(async () => {
    await service.stopUsageCollectionScheduler();
    if (originalDataDir === undefined) delete process.env.DATA_DIR; else process.env.DATA_DIR = originalDataDir;
  });
  async function due() {
    await service.runUsageCollectionPass();
    const state = (await store.readUsageAccountState(1))!;
    for (const task of Object.values(state.tasks)) task.nextAt = Date.now() + 86400_000;
    state.tasks.stats.nextAt = 0;
    await store.storeUsageAccountState(1, state);
    return state;
  }
  it('never contacts upstream on reads, settings saves or queued manual sync', async () => {
    await service.getUsageOverview();
    await service.updateUsageCollectionConfig({ defaults: DEFAULT_USAGE_POLICY, sites: {} });
    await service.queueUsageSync({ siteId: 1 });
    expect(mocks.fetch).not.toHaveBeenCalled(); expect(mocks.catalog).not.toHaveBeenCalled();
  });
  it('collects once for concurrent passes and retains durable amounts without local estimates', async () => {
    await due();
    await Promise.all([service.runUsageCollectionPass(), service.runUsageCollectionPass()]);
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
    const overview = await service.getUsageOverview();
    expect(overview.records).toHaveLength(1);
    expect(overview.records[0].data).toMatchObject({ today: { actualCost: 0.123456789 } });
    expect((await store.readUsageAccountState(1))!.tasks.stats.nextAt).toBeGreaterThan(Date.now());
  });
  it('deduplicates an account connected twice using upstream identity', async () => {
    await db.insert(schema.accounts).values({ id: 2, siteId: 1, accessToken: 'different-session', extraConfig: JSON.stringify({ credentialMode: 'session', platformUserId: 13 }) }).run();
    await due(); await service.runUsageCollectionPass();
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
    expect((await service.getUsageOverview()).accounts.find((account) => account.accountId === 2)?.duplicateOf).toBe(1);
  });
  it('honors persisted budget even for manually queued requests', async () => {
    const state = await due(); state.requestTimes = [Date.now()];
    await store.storeUsageAccountState(1, state);
    await store.storeUsageCollectionConfig({ defaults: { ...DEFAULT_USAGE_POLICY, accountHourlyBudget: 1 }, sites: {} });
    await service.queueUsageSync({ siteId: 1 }); await service.runUsageCollectionPass();
    expect(mocks.fetch).not.toHaveBeenCalled();
  });
  it('respects Retry-After and does not erase a previously successful snapshot', async () => {
    await due(); await service.runUsageCollectionPass();
    const saved = (await service.getUsageOverview()).records;
    const state = (await store.readUsageAccountState(1))!; state.tasks.stats.nextAt = 0;
    await store.storeUsageAccountState(1, state);
    const { upsertSetting } = await import('../db/upsertSetting.js');
    await upsertSetting('usage_collection_origins', {});
    mocks.fetch.mockRejectedValue(new UsageDashboardError(429, 7200_000));
    const before = Date.now(); await service.runUsageCollectionPass();
    const after = (await store.readUsageAccountState(1))!;
    expect(after.cooldownUntil).toBeGreaterThanOrEqual(before + 7200_000);
    expect((await service.getUsageOverview()).records).toEqual(saved);
    await service.queueUsageSync({ siteId: 1 }); await service.runUsageCollectionPass();
    expect(mocks.fetch).toHaveBeenCalledTimes(2);
  });
  it('pauses a forbidden origin rather than retrying on each pass', async () => {
    await due(); mocks.fetch.mockRejectedValue(new UsageDashboardError(403));
    await service.runUsageCollectionPass(); await service.runUsageCollectionPass();
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
    expect((await store.readUsageAccountState(1))!.blocked).toBeTruthy();
  });
  it('does not treat unsupported platforms as free usage', async () => {
    await db.insert(schema.sites).values({ id: 2, name: 'unsupported', url: 'https://other.invalid', platform: 'openai' }).run();
    await db.insert(schema.accounts).values({ id: 2, siteId: 2, accessToken: 'offline' }).run();
    const overview = await service.getUsageOverview();
    expect(overview.accounts.find((account) => account.accountId === 2)?.supported).toBe(false);
    expect(overview.records).toEqual([]);
  });
  it('rotates accounts at the same origin and enforces spacing between requests', async () => {
    await db.insert(schema.accounts).values({ id: 2, siteId: 1, accessToken: 'second-session', extraConfig: JSON.stringify({ platformUserId: 14 }) }).run();
    await due();
    const second = (await store.readUsageAccountState(2))!;
    second.tasks.stats.nextAt = 0;
    await store.storeUsageAccountState(2, second);
    await service.runUsageCollectionPass();
    await service.runUsageCollectionPass();
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
    const { upsertSetting } = await import('../db/upsertSetting.js');
    await upsertSetting('usage_collection_origins', {});
    await service.runUsageCollectionPass();
    expect(mocks.fetch).toHaveBeenCalledTimes(2);
    expect(mocks.fetch.mock.calls.map((args) => args[1])).toEqual(['offline-session', 'second-session']);
  });
  it('replaces historical daily snapshots instead of adding repeated backfill amounts', async () => {
    const state = await due();
    for (const task of Object.values(state.tasks)) task.nextAt = Date.now() + 86400_000;
    await store.storeUsageAccountState(1, state);
    const today = (await service.getUsageOverview()).today;
    const { shiftUsageDay } = await import('./usageCollectionPolicy.js');
    const day = shiftUsageDay(today, -1);
    mocks.fetch.mockResolvedValue([{ model: 'offline', actualCost: 0.1 }]);
    await service.queueUsageSync({ start: day, end: day });
    await service.runUsageCollectionPass();
    const { upsertSetting } = await import('../db/upsertSetting.js');
    await upsertSetting('usage_collection_origins', {});
    mocks.fetch.mockResolvedValue([{ model: 'offline', actualCost: 0.2 }]);
    await service.queueUsageSync({ start: day, end: day });
    await service.runUsageCollectionPass();
    const records = (await service.getUsageOverview()).records.filter((row) => row.day === day && row.kind === 'models');
    expect(records).toHaveLength(1);
    expect(records[0].data).toEqual([{ model: 'offline', actualCost: 0.2 }]);
    expect((await store.readUsageAccountState(1))!.historyRequests).toBe(2);
  });
  it('budgets a credential refresh separately and waits before the next usage read', async () => {
    const { eq } = await import('drizzle-orm');
    await db.update(schema.accounts).set({ extraConfig: JSON.stringify({ platformUserId: 13, sub2apiAuth: { refreshToken: 'offline-refresh' } }) }).where(eq(schema.accounts.id, 1)).run();
    await due();
    mocks.fetch.mockRejectedValueOnce(new UsageDashboardError(401));
    await service.runUsageCollectionPass();
    expect(mocks.refresh).not.toHaveBeenCalled();
    const state = (await store.readUsageAccountState(1))!;
    expect(state.authRefreshPending).toBe(true);
    await service.runUsageCollectionPass();
    expect(mocks.refresh).not.toHaveBeenCalled();
    state.cooldownUntil = 0; state.tasks.stats.nextAt = 0;
    await store.storeUsageAccountState(1, state);
    const { upsertSetting } = await import('../db/upsertSetting.js');
    await upsertSetting('usage_collection_origins', {});
    await service.runUsageCollectionPass();
    expect(mocks.refresh).toHaveBeenCalledTimes(1);
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
    expect((await store.readUsageAccountState(1))!.requestTimes).toHaveLength(2);
    await service.runUsageCollectionPass();
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
  });
});
