import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const getUserGroupCatalogMock = vi.fn();

vi.mock('../../services/platforms/index.js', () => ({
  getAdapter: () => ({
    getUserGroupCatalog: (...args: unknown[]) => getUserGroupCatalogMock(...args),
  }),
}));

type DbModule = typeof import('../../db/index.js');
type CatalogModule = typeof import('../../services/accountGroupCatalogService.js');

/**
 * A token row only changes when its owner edits it, but the group name/status/
 * multiplier behind it is provider-owned data. These tests pin the contract that
 * makes that difference visible to the UI: the age of the upstream read travels
 * with the row, and an explicit refresh is the only thing that bypasses the
 * catalog cache.
 */
describe('account token group catalog freshness', { timeout: 20_000 }, () => {
  let app: FastifyInstance;
  let db: DbModule['db'];
  let schema: DbModule['schema'];
  let catalog: CatalogModule;
  let seedId = 0;

  const seedToken = async (tokenGroup: string | null) => {
    seedId += 1;
    const site = await db.insert(schema.sites).values({
      name: `site-${seedId}`,
      url: `https://site-${seedId}.example.com`,
      platform: 'sub2api',
      status: 'active',
    }).returning().get();

    const account = await db.insert(schema.accounts).values({
      siteId: site.id,
      username: `user-${seedId}`,
      accessToken: `acc-token-${seedId}`,
      status: 'active',
    }).returning().get();

    const token = await db.insert(schema.accountTokens).values({
      accountId: account.id,
      name: `token-${seedId}`,
      token: `sk-live-token-${seedId}`,
      tokenGroup,
      valueStatus: 'ready',
      isDefault: true,
    }).returning().get();

    return { site, account, token };
  };

  const readTokens = async (query = '') => {
    const response = await app.inject({
      method: 'GET',
      url: `/api/account-tokens${query}`,
    });
    expect(response.statusCode).toBe(200);
    return response.json() as Array<{
      id: number;
      groupName: string | null;
      groupStatus: string;
      groupRateMultiplier: number | null;
      groupFetchedAt: number | null;
    }>;
  };

  beforeAll(async () => {
    process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'metapi-token-groups-'));
    await import('../../db/migrate.js');
    const dbModule = await import('../../db/index.js');
    catalog = await import('../../services/accountGroupCatalogService.js');
    db = dbModule.db;
    schema = dbModule.schema;

    app = Fastify();
    await app.register((await import('./accountTokens.js')).accountTokensRoutes);
  });

  beforeEach(async () => {
    getUserGroupCatalogMock.mockReset();
    seedId = 0;
    catalog.__resetAccountGroupCatalogCacheForTests();
    await db.delete(schema.accountTokens).run();
    await db.delete(schema.accounts).run();
    await db.delete(schema.sites).run();
  });

  afterAll(async () => {
    await app.close();
    delete process.env.DATA_DIR;
  });

  it('reports the multiplier with the timestamp of the upstream read behind it', async () => {
    const { token } = await seedToken('295');
    getUserGroupCatalogMock.mockResolvedValue([
      { id: '295', name: '福利pro不降智', status: 'active', rateMultiplier: 0.1 },
    ]);

    const before = Date.now();
    const [row] = await readTokens();

    expect(row).toMatchObject({
      id: token.id,
      groupName: '福利pro不降智',
      groupStatus: 'active',
      groupRateMultiplier: 0.1,
    });
    expect(typeof row.groupFetchedAt).toBe('number');
    expect(row.groupFetchedAt as number).toBeGreaterThanOrEqual(before);
  });

  it('serves the cached catalog until refreshGroups=1 asks upstream again', async () => {
    await seedToken('295');
    getUserGroupCatalogMock.mockResolvedValue([
      { id: '295', name: '福利pro不降智', status: 'active', rateMultiplier: 0.1 },
    ]);

    const [first] = await readTokens();
    expect(getUserGroupCatalogMock).toHaveBeenCalledTimes(1);

    // Within the TTL the catalog is reused: a page reload must not fire a
    // management-API call per account.
    await readTokens();
    expect(getUserGroupCatalogMock).toHaveBeenCalledTimes(1);

    getUserGroupCatalogMock.mockResolvedValue([
      { id: '295', name: '福利pro不降智', status: 'active', rateMultiplier: 0.25 },
    ]);
    const [refreshed] = await readTokens('?refreshGroups=1');

    expect(getUserGroupCatalogMock).toHaveBeenCalledTimes(2);
    expect(refreshed.groupRateMultiplier).toBe(0.25);
    expect(refreshed.groupFetchedAt as number).toBeGreaterThan(first.groupFetchedAt as number);
  });

  it('keeps the last known multiplier when a forced refresh fails', async () => {
    await seedToken('295');
    getUserGroupCatalogMock.mockResolvedValue([
      { id: '295', name: '福利pro不降智', status: 'active', rateMultiplier: 0.1 },
    ]);
    const [cached] = await readTokens();

    getUserGroupCatalogMock.mockRejectedValue(new Error('upstream down'));
    const [afterFailure] = await readTokens('?refreshGroups=1');

    // A transient failure degrades to the previous value (and its original
    // timestamp) instead of blanking the multiplier the user was shown.
    expect(afterFailure.groupRateMultiplier).toBe(0.1);
    expect(afterFailure.groupFetchedAt).toBe(cached.groupFetchedAt);
  });
});
