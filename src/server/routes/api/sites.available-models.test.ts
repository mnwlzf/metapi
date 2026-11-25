import Fastify, { type FastifyInstance } from 'fastify';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// No upstream traffic: this endpoint only reads local tables.
vi.mock('dotenv/config', () => ({}));
vi.mock('undici', async (importOriginal) => ({
  ...await importOriginal<typeof import('undici')>(),
  fetch: vi.fn().mockRejectedValue(new Error('Unexpected network request in available-models test')),
}));

type DbModule = typeof import('../../db/index.js');

/**
 * The site panel's model list answers "what can this site actually be used
 * for". Availability rows only record what upstream last advertised, so a model
 * the probe disabled (or the operator disabled) stayed listed right after the
 * probe — the panel kept showing the full pre-probe set.
 */
describe('GET /api/sites/:id/available-models', () => {
  let app: FastifyInstance;
  let db: DbModule['db'];
  let schema: DbModule['schema'];
  let closeDbConnections: DbModule['closeDbConnections'];
  let dataDir = '';
  let siteId: number;
  let accountId: number;

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'metapi-available-models-'));
    vi.stubEnv('DATA_DIR', dataDir);
    vi.stubEnv('DB_TYPE', 'sqlite');
    vi.stubEnv('DB_URL', join(dataDir, 'hub.db'));

    await import('../../db/migrate.js');
    ({ db, schema, closeDbConnections } = await import('../../db/index.js'));
    app = Fastify();
    await app.register((await import('./sites.js')).sitesRoutes);
  });

  beforeEach(async () => {
    await db.delete(schema.siteDisabledModels).run();
    await db.delete(schema.tokenModelAvailability).run();
    await db.delete(schema.modelAvailability).run();
    await db.delete(schema.accountTokens).run();
    await db.delete(schema.accounts).run();
    await db.delete(schema.sites).run();

    const site = await db.insert(schema.sites).values({
      name: 'models-site',
      url: 'https://models.example.invalid',
      platform: 'new-api',
      status: 'active',
    }).returning().get();
    siteId = site.id;

    const account = await db.insert(schema.accounts).values({
      siteId,
      username: 'models-user',
      accessToken: 'token',
      status: 'active',
    }).returning().get();
    accountId = account.id;

    const token = await db.insert(schema.accountTokens).values({
      accountId,
      name: 'key',
      token: 'sk-key',
      tokenGroup: '295',
    }).returning().get();

    // Upstream still advertises all three models, at both levels.
    await db.insert(schema.modelAvailability).values([
      { accountId, modelName: 'gpt-4o', available: true },
      { accountId, modelName: 'gpt-4o-mini', available: true },
      { accountId, modelName: 'claude-opus-5', available: true },
    ]).run();
    await db.insert(schema.tokenModelAvailability).values([
      { tokenId: token.id, modelName: 'gpt-4o', available: true },
      { tokenId: token.id, modelName: 'gpt-4o-mini', available: true },
      { tokenId: token.id, modelName: 'claude-opus-5', available: true },
    ]).run();
  });

  afterAll(async () => {
    await app?.close();
    await closeDbConnections?.();
    vi.unstubAllEnvs();
    if (dataDir) rmSync(dataDir, { recursive: true, force: true });
  });

  async function listModels() {
    const response = await app.inject({ method: 'GET', url: `/api/sites/${siteId}/available-models` });
    expect(response.statusCode).toBe(200);
    return (response.json() as { models: string[] }).models;
  }

  it('lists every advertised model while nothing is disabled', async () => {
    expect(await listModels()).toEqual(['claude-opus-5', 'gpt-4o', 'gpt-4o-mini']);
  });

  it('drops models that are disabled for this key, even though upstream still advertises them', async () => {
    await db.insert(schema.siteDisabledModels).values([
      { siteId, accountId, modelName: 'gpt-4o', source: 'probe' },
      { siteId, accountId, modelName: 'gpt-4o-mini', source: 'manual' },
    ]).run();

    // The token-level rows still say available — that is exactly the state the
    // probe leaves behind, and it used to reintroduce the disabled models here.
    expect(await listModels()).toEqual(['claude-opus-5']);
  });

  it('keeps a model that another key of the same site can still use', async () => {
    const second = await db.insert(schema.accounts).values({
      siteId,
      username: 'models-user-2',
      accessToken: 'token-2',
      status: 'active',
    }).returning().get();
    await db.insert(schema.modelAvailability).values({
      accountId: second.id, modelName: 'gpt-4o', available: true,
    }).run();
    await db.insert(schema.siteDisabledModels).values({
      siteId, accountId, modelName: 'gpt-4o', source: 'probe',
    }).run();

    expect(await listModels()).toEqual(['claude-opus-5', 'gpt-4o', 'gpt-4o-mini']);
  });
});
