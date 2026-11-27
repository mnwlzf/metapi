import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import Fastify from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_FIRST_VERIFICATION_SETTINGS, isPendingFirstVerification, parseFirstVerificationSettings } from './modelProbeQueuePolicy.js';

vi.mock('dotenv/config', () => ({}));
const { probeMock } = vi.hoisted(() => ({ probeMock: vi.fn() }));
vi.mock('./runtimeModelProbe.js', () => ({ probeRuntimeModel: probeMock }));
type DbModule = typeof import('../db/index.js');
type ProbeInput = Parameters<typeof import('./runtimeModelProbe.js').probeRuntimeModel>[0];

describe('first verification queue and routing admission', () => {
  let db: DbModule['db'];
  let schema: DbModule['schema'];
  let closeDb: DbModule['closeDbConnections'];
  let models: typeof import('./modelService.js');
  let verification: typeof import('./modelFirstVerificationService.js');
  let plan: typeof import('./modelProbePlanService.js');
  let dataDir: string;
  let clock = Date.UTC(2026, 10, 20);
  let siteSequence = 0;
  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'metapi-first-verification-'));
    vi.stubEnv('DATA_DIR', dataDir);
    vi.stubEnv('DB_TYPE', 'sqlite');
    vi.stubEnv('DB_URL', join(dataDir, 'hub.db'));
    await import('../db/migrate.js');
    ({ db, schema, closeDbConnections: closeDb } = await import('../db/index.js'));
    models = await import('./modelService.js');
    verification = await import('./modelFirstVerificationService.js');
    plan = await import('./modelProbePlanService.js');
    vi.useFakeTimers({ toFake: ['Date'] });
  });
  beforeEach(async () => {
    clock += 2 * 60 * 60_000;
    vi.setSystemTime(clock);
    for (const table of [schema.probeLogs, schema.routeChannels, schema.tokenRoutes,
      schema.siteDisabledModels, schema.tokenModelAvailability, schema.modelAvailability,
      schema.accountTokens, schema.accounts, schema.sites, schema.settings]) await db.delete(table).run();
    await verification.saveFirstVerificationSettings({ ...DEFAULT_FIRST_VERIFICATION_SETTINGS, groupIntervalSeconds: 0 });
    probeMock.mockReset().mockImplementation(async (input: ProbeInput) => {
      await record(input, 'success', 0.001);
      return { status: 'supported', latencyMs: 10, reason: 'ok' };
    });
  });
  afterAll(async () => {
    vi.useRealTimers();
    await closeDb?.();
    vi.unstubAllEnvs();
    if (dataDir) rmSync(dataDir, { recursive: true, force: true });
  });
  async function record(input: ProbeInput, status: string, cost: number | null) {
    await db.insert(schema.probeLogs).values({
      siteId: input.site.id, accountId: input.account.id, tokenId: input.tokenId,
      modelName: input.modelName, runId: input.runId, status,
      questionCategory: /image/.test(input.modelName) ? 'image' : 'text', questionText: 'test',
      estimatedCost: cost, createdAt: new Date().toISOString(),
    }).run();
  }
  async function seed(names = ['gpt-5.2'], direct = false) {
    const site = await db.insert(schema.sites).values({ name: 'test', url: `https://first-${++siteSequence}.invalid`, platform: 'new-api', status: 'active' }).returning().get();
    const account = await db.insert(schema.accounts).values({ siteId: site.id, accessToken: 'session', apiToken: direct ? 'sk-direct' : null,
      extraConfig: direct ? JSON.stringify({ credentialMode: 'apikey' }) : null, status: 'active' }).returning().get();
    const token = await db.insert(schema.accountTokens).values({ accountId: account.id, name: 'test-key', token: 'sk-test', enabled: true }).returning().get();
    await db.insert(schema.modelAvailability).values(names.map((modelName) => ({ accountId: account.id, modelName, available: false }))).run();
    await db.insert(schema.tokenModelAvailability).values(names.map((modelName) => ({ tokenId: token.id, modelName, available: false }))).run();
    return { site, account, token };
  }
  it('admits only a successful Key × model, preserving existing good channels', async () => {
    const { token, account } = await seed();
    const good = await db.insert(schema.accountTokens).values({ accountId: account.id, name: 'already-good', token: 'sk-good' }).returning().get();
    await db.insert(schema.tokenModelAvailability).values({ tokenId: good.id, modelName: 'gpt-5.2', available: true, connectivity: true }).run();
    await models.rebuildTokenRoutesFromAvailability();
    expect((await db.select().from(schema.routeChannels).all()).map((row) => row.tokenId)).toEqual([good.id]);
    const before = await plan.getModelProbePlan();
    expect(before.models[0].pendingVerificationCount).toBe(1);
    expect(before.models[0].keyResults.map((key) => key.routeState).sort()).toEqual(['available', 'pending-verification']);
    expect(await models.runFirstVerificationBatch()).toMatchObject({ probed: 1, supported: 1 });
    expect(probeMock.mock.calls[0][0].tokenId).toBe(token.id);
    expect((await db.select().from(schema.routeChannels).all()).map((row) => row.tokenId).sort()).toEqual([token.id, good.id].sort());
    expect((await plan.getModelProbePlan()).models[0].pendingVerificationCount).toBe(0);
  });
  it('does not let the regular scheduler consume unverified combinations', async () => {
    await seed();
    await models.runScheduledModelProbeBatch();
    expect(probeMock).not.toHaveBeenCalled();
    await models.runFirstVerificationBatch();
    expect(probeMock).toHaveBeenCalledTimes(1);
  });
  it.each(['manual', 'policy', 'probe'])('excludes %s disables from first verification', async (source) => {
    const { site, account, token } = await seed();
    await db.insert(schema.siteDisabledModels).values({ siteId: site.id, accountId: account.id, tokenId: token.id, modelName: 'gpt-5.2', source }).run();
    await models.runFirstVerificationBatch();
    expect(probeMock).not.toHaveBeenCalled();
    expect((await plan.getModelProbePlan()).models[0].pendingVerificationCount).toBe(0);
    if (source === 'probe') {
      await models.runScheduledModelProbeBatch();
      expect(probeMock).toHaveBeenCalledTimes(1);
    }
  });
  it('leaves failed combinations excluded, then recovers them through regular rechecks', async () => {
    const { token, site } = await seed();
    probeMock.mockImplementationOnce(async (input: ProbeInput) => {
      await record(input, 'failed', 0);
      return { status: 'unsupported', latencyMs: 1, reason: 'model not found' };
    });
    expect(await models.runFirstVerificationBatch()).toMatchObject({ supported: 0, notConfirmed: 1 });
    expect(await db.select().from(schema.routeChannels).all()).toHaveLength(0);
    await models.runFirstVerificationBatch();
    expect(probeMock).toHaveBeenCalledTimes(1);
    await models.probeSiteModels(site.id, { queue: 'regular', force: true });
    expect((await db.select().from(schema.tokenModelAvailability).where(eq(schema.tokenModelAvailability.tokenId, token.id)).get())?.available).toBe(true);
  });
  it('honors batch and hourly limits across sites and manual runs', async () => {
    await seed(['gpt-a', 'gpt-b', 'gpt-c']);
    await seed(['deepseek-a', 'deepseek-b', 'deepseek-c']);
    await verification.saveFirstVerificationSettings({ batchSize: 3, hourlyLimit: 4, groupIntervalSeconds: 0 });
    expect((await models.runFirstVerificationBatch()).probed).toBe(3);
    expect((await models.runFirstVerificationBatch({ manual: true })).probed).toBe(1);
    expect((await models.runFirstVerificationBatch({ manual: true })).probed).toBe(0);
    expect(probeMock).toHaveBeenCalledTimes(4);
    expect((await verification.getFirstVerificationBudget()).hourlyUsed).toBe(4);
  });
  it('counts reservations once and stops media verification at its independent limit', async () => {
    await seed(['gpt-image-a', 'gpt-image-b', 'gpt-image-c']);
    await verification.saveFirstVerificationSettings({ mediaHourlyLimit: 2, groupIntervalSeconds: 0 });
    await models.runFirstVerificationBatch();
    await models.runFirstVerificationBatch();
    expect((await verification.getFirstVerificationBudget()).mediaHourlyUsed).toBe(2);
    await models.runFirstVerificationBatch({ manual: true });
    expect(probeMock).toHaveBeenCalledTimes(2);
  });
  it('verifies text across sites before low-priority images', async () => {
    await seed(['gpt-image-1']);
    await seed(['deepseek-chat']);
    await models.runFirstVerificationBatch();
    expect(probeMock.mock.calls.map(([input]) => input.modelName)).toEqual(['deepseek-chat', 'gpt-image-1']);
  });
  it('pauses on recorded cost while showing unknown costs explicitly', async () => {
    await seed(['gpt-a', 'gpt-b']);
    probeMock.mockImplementationOnce(async (input: ProbeInput) => {
      await record(input, 'success', 1.2);
      return { status: 'supported', latencyMs: 1 };
    });
    await verification.saveFirstVerificationSettings({ concurrency: 1, groupIntervalSeconds: 0 });
    await models.runFirstVerificationBatch();
    expect(probeMock).toHaveBeenCalledTimes(1);
    expect((await verification.getFirstVerificationBudget()).pauseReason).toContain('费用');
    const log = await db.select().from(schema.probeLogs).get();
    await db.update(schema.probeLogs).set({ estimatedCost: null }).where(eq(schema.probeLogs.id, log!.id)).run();
    expect((await verification.getFirstVerificationBudget()).unknownCostCount).toBe(1);
  });
  it('shares one automatic pass and queues a manual model selection after it', async () => {
    await seed(['gpt-a', 'gpt-b']);
    await verification.saveFirstVerificationSettings({ batchSize: 1, groupIntervalSeconds: 0 });
    const first = models.runFirstVerificationBatch();
    expect(models.runFirstVerificationBatch()).toBe(first);
    const manual = models.runFirstVerificationBatch({ modelName: 'gpt-b', manual: true });
    await Promise.all([first, manual]);
    expect(probeMock.mock.calls.map(([input]) => input.modelName)).toEqual(['gpt-a', 'gpt-b']);
  });
  it('uses the account credential for direct accounts despite legacy managed keys', async () => {
    const { account } = await seed(['gpt-5.2'], true);
    await models.runFirstVerificationBatch();
    expect(probeMock).toHaveBeenCalledTimes(1);
    expect(probeMock.mock.calls[0][0]).toMatchObject({ tokenId: null, tokenValue: 'sk-direct' });
    expect((await db.select().from(schema.modelAvailability).where(eq(schema.modelAvailability.accountId, account.id)).get())?.available).toBe(true);
    expect((await plan.getModelProbePlan()).models[0].keyResults).toHaveLength(1);
  });
  it('does not activate skipped specialized probes', async () => {
    await seed(['whisper-large']);
    probeMock.mockImplementationOnce(async (input: ProbeInput) => {
      await record(input, 'skipped', 0);
      return { status: 'skipped', latencyMs: null };
    });
    await models.runFirstVerificationBatch();
    expect(await db.select().from(schema.routeChannels).all()).toHaveLength(0);
    expect((await db.select().from(schema.tokenModelAvailability).get())?.available).toBe(false);
  });
  it('persists the automatic switch while permitting manual batches', async () => {
    await seed();
    await verification.saveFirstVerificationSettings({ enabled: false });
    expect((await verification.getFirstVerificationSettings()).enabled).toBe(false);
    await models.runFirstVerificationBatch();
    expect(probeMock).not.toHaveBeenCalled();
    await models.runFirstVerificationBatch({ manual: true });
    expect(probeMock).toHaveBeenCalledTimes(1);
  });
  it('backs off the entire upstream group on rate limiting', async () => {
    const { site } = await seed(['gpt-a', 'gpt-b', 'gpt-c']);
    probeMock.mockImplementationOnce(async (input: ProbeInput) => {
      await record(input, 'failed', 0);
      return { status: 'inconclusive', latencyMs: 1, reason: 'HTTP 429 rate limit' };
    });
    await models.runFirstVerificationBatch();
    await models.runFirstVerificationBatch();
    expect(probeMock).toHaveBeenCalledTimes(1);
    // Group backoff expires; previously attempted A belongs to regular rechecks.
    vi.setSystemTime(Date.now() + 61 * 60_000);
    await models.runFirstVerificationBatch({ modelName: 'gpt-b', manual: true });
    expect(probeMock).toHaveBeenCalledTimes(2);
    expect(probeMock.mock.calls[1][0].site.id).toBe(site.id);
  });
  it('retries a pre-log exception after cooldown without spinning every minute', async () => {
    await seed();
    probeMock.mockRejectedValueOnce(new Error('before dispatch'));
    await models.runFirstVerificationBatch();
    await models.runFirstVerificationBatch();
    expect(probeMock).toHaveBeenCalledTimes(1);
    vi.setSystemTime(Date.now() + 11 * 60_000);
    await models.runFirstVerificationBatch();
    expect(probeMock).toHaveBeenCalledTimes(2);
  });
  it('derives persisted media limits from the model when the log category is unknown', async () => {
    const { site, account, token } = await seed(['sora-video']);
    await db.insert(schema.probeLogs).values({ siteId: site.id, accountId: account.id, tokenId: token.id,
      modelName: 'gpt-image-legacy', runId: 'fv-persisted', questionCategory: 'unknown', questionText: '',
      status: 'failed', estimatedCost: 0.1, createdAt: new Date().toISOString().replace('T', ' ').slice(0, 19) }).run();
    await verification.saveFirstVerificationSettings({ mediaHourlyLimit: 1, groupIntervalSeconds: 0 });
    expect((await verification.getFirstVerificationBudget()).mediaHourlyUsed).toBe(1);
    await models.runFirstVerificationBatch();
    expect(probeMock).not.toHaveBeenCalled();
  });
  it('does not fall back to account-wide probing when every managed key is disabled', async () => {
    const { token } = await seed();
    await db.update(schema.accountTokens).set({ enabled: false }).where(eq(schema.accountTokens.id, token.id)).run();
    await models.runFirstVerificationBatch();
    expect(probeMock).not.toHaveBeenCalled();
    expect((await plan.getModelProbePlan()).models.every((model) => model.pendingVerificationCount === 0)).toBe(true);
  });
  it('includes direct-account catalog models even when a different model was auto-disabled', async () => {
    const { site, account } = await seed(['gpt-a', 'gpt-b'], true);
    await db.insert(schema.siteDisabledModels).values({ siteId: site.id, accountId: account.id,
      tokenId: 0, modelName: 'gpt-a', source: 'probe' }).run();
    await models.runFirstVerificationBatch();
    expect(probeMock.mock.calls.map(([input]) => input.modelName)).toEqual(['gpt-b']);
  });
  it('exposes settings and validates updates through the API adapter', async () => {
    const app = Fastify();
    const { registerModelsRoutes } = await import('../routes/api/modelsRoutes.js');
    registerModelsRoutes(app);
    const get = await app.inject({ method: 'GET', url: '/api/models/probe-plan/first-verification' });
    expect(get.statusCode).toBe(200);
    expect(get.json().settings).toMatchObject({ enabled: true, batchSize: 4 });
    const bad = await app.inject({ method: 'PUT', url: '/api/models/probe-plan/first-verification', payload: { batchSize: 0 } });
    expect(bad.statusCode).toBe(400);
    const good = await app.inject({ method: 'PUT', url: '/api/models/probe-plan/first-verification', payload: { ...DEFAULT_FIRST_VERIFICATION_SETTINGS, batchSize: 2 } });
    expect(good.statusCode).toBe(200);
    expect(good.json().settings.batchSize).toBe(2);
    const queued = await app.inject({ method: 'POST', url: '/api/models/probe-plan/first-verification', payload: { modelName: 'gpt-5.2' } });
    expect(queued.statusCode).toBe(200);
    expect(queued.json().queued).toBe(true);
    await app.close();
  });
});

describe('first verification policy', () => {
  it('requires a new, unverified and enabled combination', () => {
    const pending = { available: false, connectivity: null, hasProbe: false };
    expect(isPendingFirstVerification(pending)).toBe(true);
    for (const overrides of [{ disabled: true }, { connectivity: false }, { available: true }, { hasProbe: true }]) {
      expect(isPendingFirstVerification({ ...pending, ...overrides })).toBe(false);
    }
  });
  it.each([{ batchSize: 0 }, { concurrency: 5 }, { hourlyLimit: 1.5 }, { dailyCostLimitUsd: NaN }, { enabled: 'true' }, { mediaHourlyLimit: -1 }])('rejects invalid settings %j', (value) => {
    expect(() => parseFirstVerificationSettings(value)).toThrow();
  });
});
