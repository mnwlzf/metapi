import Fastify, { type FastifyInstance } from 'fastify';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('dotenv/config', () => ({}));
const { probeMock } = vi.hoisted(() => ({ probeMock: vi.fn() }));
vi.mock('../../services/runtimeModelProbe.js', () => ({ probeRuntimeModel: probeMock }));

type DbModule = typeof import('../../db/index.js');
describe('key-scoped manual model bans across discovery, probes and routing', () => {
  let app: FastifyInstance;
  let db: DbModule['db'];
  let schema: DbModule['schema'];
  let closeDb: DbModule['closeDbConnections'];
  let models: typeof import('../../services/modelService.js');
  let router: typeof import('../../services/tokenRouter.js');
  let stats: typeof import('./stats.js');
  let dataDir: string;

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'metapi-key-model-ban-'));
    vi.stubEnv('DATA_DIR', dataDir);
    vi.stubEnv('DB_TYPE', 'sqlite');
    vi.stubEnv('DB_URL', join(dataDir, 'hub.db'));
    await import('../../db/migrate.js');
    ({ db, schema, closeDbConnections: closeDb } = await import('../../db/index.js'));
    models = await import('../../services/modelService.js');
    router = await import('../../services/tokenRouter.js');
    stats = await import('./stats.js');
    app = Fastify();
    (await import('./accountsModelsRoutes.js')).registerAccountModelRoutes(app);
    await app.register(stats.statsRoutes);
    await app.register((await import('./tokens.js')).tokensRoutes);
    await app.register((await import('./sites.js')).sitesRoutes);
  });

  beforeEach(async () => {
    probeMock.mockReset().mockResolvedValue({ status: 'supported', latencyMs: 10, reason: 'ok' });
    stats.clearModelsMarketplaceCache();
    router.invalidateTokenRouterCache();
    (await import('../../middleware/requestRateLimit.js')).resetRequestRateLimitStore();
    for (const table of [schema.probeLogs, schema.routeChannels, schema.tokenRoutes,
      schema.siteDisabledModels, schema.tokenModelAvailability, schema.modelAvailability,
      schema.accountTokens, schema.accounts, schema.sites]) await db.delete(table).run();
  });

  afterAll(async () => {
    await app?.close();
    await closeDb?.();
    vi.unstubAllEnvs();
    if (dataDir) rmSync(dataDir, { recursive: true, force: true });
  });

  async function seed() {
    const site = await db.insert(schema.sites).values({ name: 'ban-site', url: 'https://ban.invalid', platform: 'new-api', status: 'active' }).returning().get();
    const account = await db.insert(schema.accounts).values({ siteId: site.id, accessToken: 'session', status: 'active' }).returning().get();
    const a = await db.insert(schema.accountTokens).values({ accountId: account.id, name: 'A', token: 'sk-a', enabled: true }).returning().get();
    const b = await db.insert(schema.accountTokens).values({ accountId: account.id, name: 'B', token: 'sk-b', enabled: true }).returning().get();
    await db.insert(schema.modelAvailability).values({ accountId: account.id, modelName: 'gpt-4o', available: true }).run();
    await db.insert(schema.tokenModelAvailability).values([a, b].map((token) => ({ tokenId: token.id, modelName: 'gpt-4o', available: true }))).run();
    await models.rebuildTokenRoutesFromAvailability();
    return { site, account, a, b };
  }

  async function ban(accountId: number, tokenId: number, disabled = true) {
    const response = await app.inject({ method: 'PATCH', url: `/api/accounts/${accountId}/models/disabled`, payload: { tokenId, modelName: 'gpt-4o', disabled } });
    expect(response.statusCode).toBe(200);
    expect(response.json().rebuilt).toBe(true);
  }

  async function get(url: string) {
    const response = await app.inject({ method: 'GET', url });
    expect(response.statusCode).toBe(200);
    return response.json();
  }

  it('keeps the model supplied by B, then hides it everywhere when the last supplier is banned', async () => {
    const { site, account, a, b } = await seed();
    await ban(account.id, a.id);
    expect((await db.select().from(schema.routeChannels).all()).map((row) => row.tokenId)).toEqual([b.id]);
    const market = await get('/api/models/marketplace');
    expect(market.models[0].accounts[0].tokens.map((token: { id: number }) => token.id)).toEqual([b.id]);
    const candidates = await get('/api/models/token-candidates');
    expect(JSON.stringify(candidates)).not.toContain('"tokenId":' + a.id + ',');
    expect((await get(`/api/sites/${site.id}/available-models`)).models).toContain('gpt-4o');
    expect((await get('/api/routes/lite?availableOnly=1')).map((row: { modelPattern: string }) => row.modelPattern)).toContain('gpt-4o');
    expect((await router.tokenRouter.explainSelection('gpt-4o', [])).selectedChannelId).toBeDefined();
    await ban(account.id, b.id);
    expect((await get('/api/models/marketplace')).models).toEqual([]);
    expect((await get(`/api/sites/${site.id}/available-models`)).models).toEqual([]);
    expect(await get('/api/routes/lite?availableOnly=1')).toEqual([]);
    expect(await router.tokenRouter.getAvailableModels()).toEqual([]);
    expect((await router.tokenRouter.explainSelection('gpt-4o', [])).selectedChannelId).toBeFalsy();
    await ban(account.id, a.id, false);
    expect((await get('/api/models/marketplace')).models).toHaveLength(1);
    expect((await db.select().from(schema.routeChannels).all()).map((row) => row.tokenId)).toEqual([a.id]);
  });

  it('skips manual bans even when forced, but re-probes and recovers automatic bans for the other key', async () => {
    const { site, account, a, b } = await seed();
    await ban(account.id, a.id);
    await db.insert(schema.siteDisabledModels).values({ siteId: site.id, accountId: account.id, tokenId: b.id, modelName: 'gpt-4o', source: 'probe' }).run();
    await db.update(schema.tokenModelAvailability).set({ available: false }).where(eq(schema.tokenModelAvailability.tokenId, b.id)).run();
    const result = await models.probeSiteModels(site.id, { scope: 'all', force: true });
    expect(probeMock.mock.calls.map(([input]) => input.tokenId)).toEqual([b.id]);
    expect(result.recovered).toBe(1);
    const remaining = await db.select().from(schema.siteDisabledModels).all();
    expect(remaining).toHaveLength(1);
    expect(remaining[0]).toMatchObject({ tokenId: a.id, source: 'manual' });
    expect((await db.select().from(schema.routeChannels).all()).map((row) => row.tokenId)).toEqual([b.id]);
  });

  it('hides manually banned key-model pairs from probe-plan details but keeps other keys', async () => {
    const { site, account, a, b } = await seed();
    await ban(account.id, a.id);
    await db.insert(schema.siteDisabledModels).values({
      siteId: site.id, accountId: account.id, tokenId: b.id, modelName: 'gpt-4o', source: 'probe',
    }).run();

    const { getModelProbePlan } = await import('../../services/modelProbePlanService.js');
    const plan = await getModelProbePlan();
    const model = plan.models.find((item) => item.modelName === 'gpt-4o');
    expect(model?.keyResults.map((key) => key.keyId)).toEqual([b.id]);
    expect(model?.keyResults[0]?.routeState).toBe('probe-disabled');
  });

  it('preserves probe provenance on save and converts only explicit bans to manual', async () => {
    const { site, account, a, b } = await seed();
    await db.insert(schema.siteDisabledModels).values([a, b].map((token) => ({ siteId: site.id, accountId: account.id, tokenId: token.id, modelName: 'gpt-4o', source: 'probe' })) ).run();
    const detail = await get(`/api/accounts/${account.id}/models?tokenId=${a.id}`);
    expect(detail.models[0]).toMatchObject({ disabled: true, manualDisabled: false, disabledSource: 'probe' });
    expect((await app.inject({ method: 'PUT', url: `/api/accounts/${account.id}/models/disabled`, payload: { tokenId: a.id, models: [] } })).statusCode).toBe(200);
    expect((await db.select().from(schema.siteDisabledModels).all()).map((row) => row.source)).toEqual(['probe', 'probe']);
    await ban(account.id, a.id);
    expect((await db.select().from(schema.siteDisabledModels).where(and(eq(schema.siteDisabledModels.accountId, account.id), eq(schema.siteDisabledModels.tokenId, a.id))).get())?.source).toBe('manual');
    expect((await db.select().from(schema.siteDisabledModels).where(eq(schema.siteDisabledModels.tokenId, b.id)).get())?.source).toBe('probe');
  });

  it('does not show account-wide probe failures in a key model list', async () => {
    const { site, account, a } = await seed();
    await db.insert(schema.siteDisabledModels).values([
      { siteId: site.id, accountId: account.id, tokenId: 0, modelName: 'gpt-only-account-probe', source: 'probe' },
      { siteId: site.id, accountId: account.id, tokenId: 0, modelName: 'account-policy-model', source: 'manual' },
      { siteId: site.id, accountId: account.id, tokenId: a.id, modelName: 'gpt-image-stale-probe', source: 'probe' },
      { siteId: site.id, accountId: account.id, tokenId: a.id, modelName: 'gpt-4o', source: 'probe' },
    ]).run();

    const detail = await get(`/api/accounts/${account.id}/models?tokenId=${a.id}`);
    const byName = new Map(detail.models.map((model: { name: string }) => [model.name, model]));
    expect(byName.has('gpt-only-account-probe')).toBe(false);
    expect(byName.has('gpt-image-stale-probe')).toBe(false);
    expect(byName.get('account-policy-model')).toMatchObject({ inherited: true, disabled: true });
    expect(byName.get('gpt-4o')).toMatchObject({ inherited: false, disabled: true, disabledSource: 'probe' });
  });

  it('does not probe stale per-key automatic failures outside the key model list', async () => {
    const { site, account, a } = await seed();
    await db.insert(schema.siteDisabledModels).values({
      siteId: site.id, accountId: account.id, tokenId: a.id, modelName: 'gpt-image-stale-probe', source: 'probe',
    }).run();

    await models.probeSiteModels(site.id, { scope: 'all', force: true });
    expect(probeMock.mock.calls.map(([input]) => input.modelName)).toEqual(['gpt-4o', 'gpt-4o']);
  });

  it('keeps unavailable records editable before and after promoting a probe ban to manual', async () => {
    const { site, account, a, b } = await seed();
    await db.update(schema.tokenModelAvailability).set({ available: false, connectivity: false })
      .where(eq(schema.tokenModelAvailability.tokenId, a.id)).run();
    await db.insert(schema.tokenModelAvailability).values({ tokenId: a.id, modelName: 'unlisted-failure', available: false, connectivity: false }).run();
    await db.insert(schema.siteDisabledModels).values({ siteId: site.id, accountId: account.id, tokenId: a.id, modelName: 'gpt-4o', source: 'probe' }).run();
    const url = `/api/accounts/${account.id}/models?tokenId=${a.id}`;
    const before = await get(url);
    expect(before.keyRequired).toBe(true);
    expect(before.models).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'gpt-4o', probeStatus: 'unavailable', manualDisabled: false }),
      expect.objectContaining({ name: 'unlisted-failure', probeStatus: 'unavailable', disabled: false }),
    ]));
    const save = await app.inject({ method: 'PUT', url: `/api/accounts/${account.id}/models/disabled`,
      payload: { tokenId: a.id, models: ['gpt-4o'] } });
    expect(save.statusCode).toBe(200);
    expect((await get(url)).models.find((model: { name: string }) => model.name === 'gpt-4o'))
      .toMatchObject({ manualDisabled: true, disabledSource: 'manual', probeStatus: 'unavailable' });
    expect((await get(`/api/accounts/${account.id}/models?tokenId=${b.id}`)).models[0])
      .toMatchObject({ manualDisabled: false, disabledSource: null, probeStatus: 'unknown' });
    await ban(account.id, a.id, false);
    expect((await get(url)).models.find((model: { name: string }) => model.name === 'gpt-4o'))
      .toMatchObject({ manualDisabled: false, disabledSource: null, probeStatus: 'unavailable' });
    expect((await db.select().from(schema.routeChannels).all()).map((row) => row.tokenId)).toEqual([b.id]);
  });

  it('preserves configured groups and source identities while removing their banned channels', async () => {
    const { account, a, b } = await seed();
    const source = await db.select().from(schema.tokenRoutes).get();
    const group = await db.insert(schema.tokenRoutes).values({ modelPattern: 'my-group', routeMode: 'explicit_group' }).returning().get();
    await db.insert(schema.routeGroupSources).values({ groupRouteId: group.id, sourceRouteId: source!.id }).run();
    await ban(account.id, a.id);
    await ban(account.id, b.id);
    expect((await db.select().from(schema.tokenRoutes).all()).map((row) => row.id)).toEqual(expect.arrayContaining([source!.id, group.id]));
    expect(await db.select().from(schema.routeChannels).all()).toEqual([]);
    expect(await get('/api/routes/lite?availableOnly=1')).toEqual([]);
    expect(await router.tokenRouter.getAvailableModels()).toEqual([]);
  });

  it('enforces bans on wildcard requests and mapped upstream models without deleting their configuration', async () => {
    const { account, a, b } = await seed();
    await ban(account.id, a.id);
    await ban(account.id, b.id);
    const wildcard = await db.insert(schema.tokenRoutes).values({ modelPattern: 'gpt-*' }).returning().get();
    const mapped = await db.insert(schema.tokenRoutes).values({ modelPattern: 'public-model',
      modelMapping: JSON.stringify({ 'public-model': 'gpt-4o' }) }).returning().get();
    await db.insert(schema.routeChannels).values([wildcard, mapped].map((route) => ({
      routeId: route.id, accountId: account.id, tokenId: a.id, sourceModel: null, manualOverride: true,
    }))).run();
    router.invalidateTokenRouterCache();
    expect(await router.tokenRouter.selectChannel('gpt-4o')).toBeNull();
    expect(await router.tokenRouter.selectChannel('public-model')).toBeNull();
    expect(await router.tokenRouter.getAvailableModels()).not.toContain('public-model');
    expect(await db.select().from(schema.tokenRoutes).where(eq(schema.tokenRoutes.id, mapped.id)).get()).toBeTruthy();
  });

  it('restores probe eligibility after unbanning a model that was previously unavailable', async () => {
    const { site, account, a } = await seed();
    await db.update(schema.tokenModelAvailability).set({ available: false })
      .where(eq(schema.tokenModelAvailability.tokenId, a.id)).run();
    await ban(account.id, a.id);
    await ban(account.id, a.id, false);
    await models.probeSiteModels(site.id, { scope: 'single', modelName: 'gpt-4o', tokenId: a.id, force: true });
    expect(probeMock).toHaveBeenCalledWith(expect.objectContaining({ tokenId: a.id }));
    expect((await db.select().from(schema.routeChannels).all()).some((row) => row.tokenId === a.id)).toBe(true);
  });

  it('marketplace probing skips a manually banned key and recovers the automatic ban of another key', async () => {
    const { site, account, a, b } = await seed();
    await ban(account.id, a.id);
    await db.insert(schema.siteDisabledModels).values({ siteId: site.id, accountId: account.id,
      tokenId: b.id, modelName: 'gpt-4o', source: 'probe' }).run();
    await db.update(schema.tokenModelAvailability).set({ available: false })
      .where(eq(schema.tokenModelAvailability.tokenId, b.id)).run();
    const probe = await import('../../services/modelMarketplaceProbeService.js');
    expect((await probe.probeSingleModelAvailability('gpt-4o')).ok).toBe(true);
    expect(probeMock.mock.calls.map(([input]) => input.tokenId)).toEqual([b.id]);
    expect((await db.select().from(schema.siteDisabledModels).all())).toEqual([
      expect.objectContaining({ tokenId: a.id, source: 'manual' }),
    ]);
    expect((await get('/api/models/marketplace')).models).toHaveLength(1);
  });

  it('rejects keys from another account without changing either scope', async () => {
    const { site, account, a } = await seed();
    const other = await db.insert(schema.accounts).values({ siteId: site.id, accessToken: 'other-session' }).returning().get();
    const response = await app.inject({ method: 'PATCH', url: `/api/accounts/${other.id}/models/disabled`, payload: { tokenId: a.id, modelName: 'gpt-4o', disabled: true } });
    expect(response.statusCode).toBe(404);
    expect(await db.select().from(schema.siteDisabledModels).all()).toEqual([]);
    expect(account.id).not.toBe(other.id);
  });
});
