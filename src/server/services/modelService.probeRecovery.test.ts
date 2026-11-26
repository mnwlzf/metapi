import { vi } from 'vitest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { and, eq } from 'drizzle-orm';
import { probeRuntimeModel } from './runtimeModelProbe.js';

// Hoisted mock: the probe answers with whatever the individual test queued.
// Deliberately a plain factory: importing the real module here would open a DB
// handle before DATA_DIR points at the test's temp directory.
vi.mock('./runtimeModelProbe.js', () => ({
  probeRuntimeModel: vi.fn(),
}));

type DbModule = typeof import('../db/index.js');
type ModelServiceModule = typeof import('./modelService.js');

/**
 * A disable row used to be one-way: the probe could add it, and nothing — not a
 * later successful probe, not the periodic refresh, not a route rebuild — ever
 * removed it. These cases pin the recovery half: a model that answers again
 * leaves the disabled list, while operator/policy intent survives.
 */
describe('probeSiteModels auto-recovers models that answer again', () => {
  let db: DbModule['db'];
  let schema: DbModule['schema'];
  let probeSiteModels: ModelServiceModule['probeSiteModels'];
  let dataDir = '';

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'metapi-probe-recovery-'));
    process.env.DATA_DIR = dataDir;
    await import('../db/migrate.js');
    const dbModule = await import('../db/index.js');
    const modelService = await import('./modelService.js');
    db = dbModule.db;
    schema = dbModule.schema;
    probeSiteModels = modelService.probeSiteModels;
  });

  beforeEach(async () => {
    vi.mocked(probeRuntimeModel).mockReset();
    vi.mocked(probeRuntimeModel).mockResolvedValue({ status: 'supported', latencyMs: 20 } as never);
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

  async function seedSite(modelNames: string[]) {
    const site = await db.insert(schema.sites).values({
      name: `Recovery Site ${Math.random().toString(36).slice(2, 8)}`,
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

    // A probe runs per upstream key: the cell comes from the key's own model list.
    const token = await db.insert(schema.accountTokens).values({
      accountId,
      name: 'recovery-key',
      token: 'sk-recovery-key',
      tokenGroup: '30',
      enabled: true,
    }).run();
    const tokenId = Number(token.lastInsertRowid);

    for (const modelName of modelNames) {
      // A disabled model keeps its availability row (flipped to false), which is
      // why the probe has to look at the disabled list as well.
      await db.insert(schema.modelAvailability).values({
        accountId,
        modelName,
        available: false,
      }).run();
      await db.insert(schema.tokenModelAvailability).values({
        tokenId,
        modelName,
        available: false,
      }).run();
    }

    return { siteId, accountId, tokenId };
  }

  it('removes the disable row a probe wrote once that model answers', async () => {
    const { siteId, accountId, tokenId } = await seedSite(['gpt-4o']);
    await db.insert(schema.siteDisabledModels).values({
      siteId,
      accountId,
      modelName: 'gpt-4o',
      source: 'probe',
    }).run();

    const result = await probeSiteModels(siteId, { scope: 'all' });

    expect(result.recovered).toBe(1);
    expect(result.unsupported).toBe(0);
    expect(await db.select().from(schema.siteDisabledModels).all()).toHaveLength(0);
    const availability = await db.select().from(schema.tokenModelAvailability)
      .where(eq(schema.tokenModelAvailability.tokenId, tokenId))
      .get();
    expect(availability?.available).toBe(true);
  });

  it('also recovers legacy rows that predate the provenance column', async () => {
    const { siteId, accountId, tokenId } = await seedSite(['gpt-4o']);
    await db.insert(schema.siteDisabledModels).values({
      siteId,
      accountId,
      modelName: 'gpt-4o',
      // Rows written before `source` existed: same writer, unknown label.
      source: null,
    }).run();

    const result = await probeSiteModels(siteId, { scope: 'all' });

    expect(result.recovered).toBe(1);
    expect(await db.select().from(schema.siteDisabledModels).all()).toHaveLength(0);
  });

  it.each(['manual', 'policy'])('keeps %s disables even when the model answers', async (source) => {
    const { siteId, accountId, tokenId } = await seedSite(['gpt-4o']);
    await db.insert(schema.siteDisabledModels).values({
      siteId,
      accountId,
      modelName: 'gpt-4o',
      source,
    }).run();

    const result = await probeSiteModels(siteId, { scope: 'all' });

    expect(result.recovered).toBe(0);
    const remaining = await db.select().from(schema.siteDisabledModels).all();
    expect(remaining).toHaveLength(1);
    expect(remaining[0]?.source).toBe(source);
  });

  it('reports the recovery to the progress stream', async () => {
    const { siteId, accountId, tokenId } = await seedSite(['gpt-4o']);
    await db.insert(schema.siteDisabledModels).values({
      siteId,
      accountId,
      modelName: 'gpt-4o',
      source: 'probe',
    }).run();

    const events: Array<{ type: string; action?: string; modelName?: string }> = [];
    await probeSiteModels(siteId, { scope: 'all' }, (event) => {
      events.push(event as { type: string; action?: string; modelName?: string });
    });

    expect(events).toContainEqual(expect.objectContaining({
      type: 'action',
      action: 'enabled',
      modelName: 'gpt-4o',
    }));
  });
});
