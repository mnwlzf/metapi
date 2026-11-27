import Fastify from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_USAGE_POLICY } from '../../shared/upstreamUsage.js';

const mocks = vi.hoisted(() => ({ overview: vi.fn(), config: vi.fn(), update: vi.fn(), sync: vi.fn() }));
vi.mock('../../services/usageCollectionStore.js', () => ({ getUsageCollectionConfig: mocks.config }));
vi.mock('../../services/usageCollectionService.js', () => ({ getUsageOverview: mocks.overview, updateUsageCollectionConfig: mocks.update, queueUsageSync: mocks.sync }));
import { usageCollectionRoutes } from './usageCollection.js';

describe('consumption API adapters', () => {
  const apps: ReturnType<typeof Fastify>[] = [];
  async function app() { const instance = Fastify(); apps.push(instance); await instance.register(usageCollectionRoutes); return instance; }
  afterEach(async () => { await Promise.all(apps.splice(0).map((instance) => instance.close())); vi.resetAllMocks(); });

  it('serves persisted overview and settings without scheduling collection', async () => {
    const instance = await app(); mocks.overview.mockResolvedValue({ records: [] });
    mocks.config.mockResolvedValue({ defaults: DEFAULT_USAGE_POLICY, sites: {} });
    expect((await instance.inject('/api/consumption')).json()).toEqual({ records: [] });
    expect((await instance.inject('/api/consumption/settings')).json().defaults.statsMinutes).toBe(30);
    expect(mocks.sync).not.toHaveBeenCalled();
  });
  it('delegates validated settings to the service and reports validation failures', async () => {
    const instance = await app(); const body = { defaults: DEFAULT_USAGE_POLICY, sites: {}, timeZone: 'Asia/Shanghai' };
    mocks.update.mockResolvedValue(body);
    expect((await instance.inject({ method: 'PUT', url: '/api/consumption/settings', payload: body })).json()).toEqual(body);
    expect(mocks.update).toHaveBeenCalledWith(body);
    mocks.update.mockRejectedValue(new Error('统计时区无效'));
    expect((await instance.inject({ method: 'PUT', url: '/api/consumption/settings', payload: { timeZone: 'invalid' } })).statusCode).toBe(400);
  });
  it('queues manual backfill and resume without bypassing the scheduler', async () => {
    const instance = await app(); mocks.sync.mockResolvedValue({ queued: 2 });
    const payload = { siteId: 1, start: '2026-11-26', end: '2026-11-27', resume: true };
    expect((await instance.inject({ method: 'POST', url: '/api/consumption/sync', payload })).json()).toEqual({ queued: 2 });
    expect(mocks.sync).toHaveBeenCalledWith(payload);
  });
  it('rejects malformed bodies instead of silently scheduling all accounts', async () => {
    const instance = await app();
    for (const payload of [[], { siteId: '1' }, { start: 123 }, { end: false }, { resume: 'true' }]) {
      expect((await instance.inject({ method: 'POST', url: '/api/consumption/sync', payload })).statusCode).toBe(400);
    }
    expect(mocks.sync).not.toHaveBeenCalled();
  });
});
