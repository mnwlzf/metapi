import { describe, expect, it, vi } from 'vitest';
import { NewApiAdapter } from './newApi.js';

/**
 * new-api sites publish their group ratio on the same endpoints that list the
 * user's groups. The generic adapter keeps only the names, which left the
 * account-token list showing a group with no multiplier. These tests pin the
 * adapter-level merge: names come from `getUserGroups`, multipliers from the
 * ratio payload, and an unreadable ratio degrades to "unknown" (null) rather
 * than inventing 1x.
 */
describe('NewApiAdapter.getUserGroupCatalog', () => {
  const buildAdapter = (overrides: {
    groups: string[];
    ratioPayload?: unknown;
    ratioError?: Error;
  }) => {
    const adapter = new NewApiAdapter() as any;
    adapter.getUserGroups = vi.fn(async () => overrides.groups);
    adapter.discoverUserId = vi.fn(async () => 7);
    adapter.fetchJson = vi.fn(async () => {
      if (overrides.ratioError) throw overrides.ratioError;
      return overrides.ratioPayload;
    });
    return adapter;
  };

  it('attaches the upstream ratio to each group name', async () => {
    const adapter = buildAdapter({
      groups: ['default', 'vip'],
      ratioPayload: { success: true, data: { default: { ratio: 1 }, vip: { ratio: 0.8 } } },
    });

    await expect(adapter.getUserGroupCatalog('https://new.example.com', 'token'))
      .resolves.toEqual([
        { id: null, name: 'default', status: 'unknown', rateMultiplier: 1 },
        { id: null, name: 'vip', status: 'unknown', rateMultiplier: 0.8 },
      ]);
  });

  it('runs the auth path once and reports unknown for groups absent from the ratio payload', async () => {
    const adapter = buildAdapter({
      groups: ['default', 'legacy'],
      ratioPayload: { success: true, data: { default: { ratio: 1 } } },
    });

    const catalog = await adapter.getUserGroupCatalog('https://new.example.com', 'token');

    expect(catalog).toEqual([
      { id: null, name: 'default', status: 'unknown', rateMultiplier: 1 },
      { id: null, name: 'legacy', status: 'unknown', rateMultiplier: null },
    ]);
    expect(adapter.discoverUserId).toHaveBeenCalledWith('https://new.example.com', 'token');
  });

  it('keeps the group list usable when the ratio read fails', async () => {
    const adapter = buildAdapter({
      groups: ['default'],
      ratioError: new Error('HTTP 500'),
    });

    await expect(adapter.getUserGroupCatalog('https://new.example.com', 'token'))
      .resolves.toEqual([{ id: null, name: 'default', status: 'unknown', rateMultiplier: null }]);
  });

  it('flags a group whose schedule is enabled but currently inactive', async () => {
    const adapter = buildAdapter({
      groups: ['夜间-限时', '全天-特价'],
      ratioPayload: {
        success: true,
        data: {
          '夜间-限时': { ratio: 0.2, schedule_enabled: true, schedule_active: false },
          '全天-特价': { ratio: 0.5, schedule_enabled: true, schedule_active: true },
        },
      },
    });

    await expect(adapter.getUserGroupCatalog('https://new.example.com', 'token'))
      .resolves.toEqual([
        { id: null, name: '夜间-限时', status: 'inactive', rateMultiplier: 0.2 },
        { id: null, name: '全天-特价', status: 'unknown', rateMultiplier: 0.5 },
      ]);
  });
});
