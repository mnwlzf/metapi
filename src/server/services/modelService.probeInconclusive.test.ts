import { vi } from 'vitest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { and, eq } from 'drizzle-orm';
import { probeRuntimeModel } from './runtimeModelProbe.js';

// Hoisted mock: probeRuntimeModel returns an inconclusive result (no verdict).
// Plain factory on purpose: importing the real module would open a DB handle
// before DATA_DIR points at this test's temp directory.
vi.mock('./runtimeModelProbe.js', () => ({
  probeRuntimeModel: vi.fn().mockResolvedValue({
    status: 'inconclusive',
    latencyMs: 100,
    reason: 'mock: cannot reach endpoint',
  }),
}));

type DbModule = typeof import('../db/index.js');
type ModelServiceModule = typeof import('./modelService.js');

/**
 * Policy: only a confirmed "usable" answer keeps a model in the routing pool.
 * A probe that reached no conclusion is not evidence of usability, so it takes
 * the model out too — and the next successful probe puts it back.
 */
describe('probeSiteModels disables every model it could not confirm', () => {
  let db: DbModule['db'];
  let schema: DbModule['schema'];
  let probeSiteModels: ModelServiceModule['probeSiteModels'];
  let dataDir = '';

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'metapi-probe-inconclusive-'));
    process.env.DATA_DIR = dataDir;
    await import('../db/migrate.js');
    const dbModule = await import('../db/index.js');
    const modelService = await import('./modelService.js');
    db = dbModule.db;
    schema = dbModule.schema;
    probeSiteModels = modelService.probeSiteModels;
  });

  beforeEach(async () => {
    await db.delete(schema.siteDisabledModels).run();
    await db.delete(schema.modelAvailability).run();
    await db.delete(schema.tokenModelAvailability).run();
    await db.delete(schema.accountTokens).run();
    await db.delete(schema.accounts).run();
    await db.delete(schema.sites).run();
  });

  afterAll(async () => {
    delete process.env.DATA_DIR;
  });

  async function seedSite() {
    const site = await db.insert(schema.sites).values({
      name: 'Inconclusive Site',
      url: 'http://127.0.0.1:1/',
      platform: 'new-api',
      status: 'active',
    }).run();
    const siteId = Number(site.lastInsertRowid);

    const account = await db.insert(schema.accounts).values({
      siteId,
      accessToken: 'tok',
      status: 'active',
    }).run();
    const accountId = Number(account.lastInsertRowid);

    const token = await db.insert(schema.accountTokens).values({
      accountId,
      name: 'test-token',
      token: 'test-token-val',
    }).run();
    const tokenId = Number(token.lastInsertRowid);

    await db.insert(schema.modelAvailability).values({
      accountId,
      modelName: 'gpt-4o',
      available: true,
    }).run();

    await db.insert(schema.tokenModelAvailability).values({
      tokenId,
      modelName: 'gpt-4o',
      available: true,
    }).run();

    return { siteId, accountId, tokenId };
  }

  it('disables a model whose probe reached no conclusion', async () => {
    const { siteId, accountId, tokenId } = await seedSite();

    const result = await probeSiteModels(siteId, { scope: 'all' });

    expect(result.inconclusive).toBeGreaterThan(0);
    expect(result.unsupported).toBe(0);

    const disabled = await db.select().from(schema.siteDisabledModels).all();
    expect(disabled).toHaveLength(1);
    expect(disabled[0]).toMatchObject({ modelName: 'gpt-4o', source: 'probe' });

    // Availability is per key: that is what routing builds channels from, and the
    // account-level flag is only an aggregate refreshed by discovery.
    const tokenRow = await db.select().from(schema.tokenModelAvailability)
      .where(eq(schema.tokenModelAvailability.tokenId, tokenId))
      .get();
    expect(tokenRow?.available).toBe(false);
  });

  it('clears a stale connectivity=false when a probe confirms the model works', async () => {
    const { siteId, accountId, tokenId } = await seedSite();
    await db.update(schema.modelAvailability)
      .set({ connectivity: false })
      .where(eq(schema.modelAvailability.accountId, accountId))
      .run();

    vi.mocked(probeRuntimeModel).mockResolvedValueOnce({
      status: 'supported',
      latencyMs: 12,
    } as never);

    const result = await probeSiteModels(siteId, { scope: 'all' });
    expect(result.unsupported).toBe(0);

    const row = await db.select().from(schema.tokenModelAvailability)
      .where(eq(schema.tokenModelAvailability.tokenId, tokenId))
      .get();
    expect(row?.connectivity).toBe(true);
    expect(row?.available).toBe(true);
    // A confirmed answer also leaves the disabled list.
    expect(await db.select().from(schema.siteDisabledModels).all()).toHaveLength(0);
  });
});
