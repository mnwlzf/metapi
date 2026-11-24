import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

type DbModule = typeof import('../db/index.js');
type TokenRouterModule = typeof import('./tokenRouter.js');
type PricingModule = typeof import('./modelPricingService.js');

/**
 * End-to-end rate ceiling: the group ratio comes from the same `/api/pricing`
 * catalog that billing uses, the guard reads it during routing, and a key that
 * declares 0.6 must never be dispatched through a 0.8 group.
 */
describe('TokenRouter upstream rate ceiling', () => {
  let db: DbModule['db'];
  let schema: DbModule['schema'];
  let TokenRouter: TokenRouterModule['TokenRouter'];
  let invalidateTokenRouterCache: TokenRouterModule['invalidateTokenRouterCache'];
  let fetchModelPricingCatalog: PricingModule['fetchModelPricingCatalog'];
  let server: ReturnType<typeof createServer>;
  let siteUrl = '';
  let dataDir = '';
  let siteSeq = 0;

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'metapi-token-router-rate-cap-'));
    process.env.DATA_DIR = dataDir;

    server = createServer((_request, response) => {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({
        data: [{ model_name: 'gpt-4o-mini', model_ratio: 1, completion_ratio: 1, quota_type: 0 }],
        group_ratio: { default: 1, grp06: 0.6, grp07: 0.7, grp08: 0.8 },
      }));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    siteUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    await import('../db/migrate.js');
    const dbModule = await import('../db/index.js');
    const tokenRouterModule = await import('./tokenRouter.js');
    const pricingModule = await import('./modelPricingService.js');
    db = dbModule.db;
    schema = dbModule.schema;
    TokenRouter = tokenRouterModule.TokenRouter;
    invalidateTokenRouterCache = tokenRouterModule.invalidateTokenRouterCache;
    fetchModelPricingCatalog = pricingModule.fetchModelPricingCatalog;
  });

  beforeEach(async () => {
    await db.delete(schema.routeChannels).run();
    await db.delete(schema.tokenRoutes).run();
    await db.delete(schema.accountTokens).run();
    await db.delete(schema.accounts).run();
    await db.delete(schema.sites).run();
    invalidateTokenRouterCache();
  });

  afterAll(async () => {
    invalidateTokenRouterCache();
    delete process.env.DATA_DIR;
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  async function seedChannel(modelPattern: string, tokenGroup: string | null, tokenValue: string) {
    siteSeq += 1;
    const site = await db.insert(schema.sites).values({
      name: `rate-site-${siteSeq}`,
      // Distinct path per site: (platform, url) is unique, and the stub answers
      // every path anyway.
      url: `${siteUrl}/s${siteSeq}`,
      platform: 'new-api',
      status: 'active',
    }).returning().get();

    const account = await db.insert(schema.accounts).values({
      siteId: site.id,
      username: `user-${siteSeq}`,
      accessToken: 'session=abc',
      apiToken: null,
      status: 'active',
    }).returning().get();

    const token = await db.insert(schema.accountTokens).values({
      accountId: account.id,
      name: `tok-${tokenGroup ?? 'none'}-${siteSeq}`,
      token: tokenValue,
      tokenGroup,
      enabled: true,
      isDefault: true,
    }).returning().get();

    const route = await db.insert(schema.tokenRoutes).values({
      modelPattern,
      enabled: true,
    }).returning().get();

    const channel = await db.insert(schema.routeChannels).values({
      routeId: route.id,
      accountId: account.id,
      tokenId: token.id,
      priority: 0,
      weight: 10,
      enabled: true,
    }).returning().get();

    // Prime the pricing cache exactly the way the billing path does, so the
    // guard resolves the group ratio from real catalog data.
    await fetchModelPricingCatalog({
      site: { id: site.id, url: site.url, platform: site.platform },
      account: { id: account.id, accessToken: account.accessToken, apiToken: account.apiToken },
      modelName: 'gpt-4o-mini',
    });

    return { site, account, token, route, channel };
  }

  const policy = (overrides: Record<string, unknown> = {}) => ({
    supportedModels: [],
    modelMappings: [],
    allowedRouteIds: [],
    siteWeightMultipliers: {},
    allowedSiteIds: [],
    allowedCredentialRefs: [],
    maxUpstreamRate: null,
    ...overrides,
  }) as any;

  it('never dispatches a 0.6 key to a 0.8 group', async () => {
    const cheap = await seedChannel('gpt-4o-mini', 'grp06', 'sk-cheap');
    const pricey = await seedChannel('gpt-4o-mini', 'grp08', 'sk-pricey');
    const sharedPolicy = policy({
      allowedRouteIds: [cheap.route.id, pricey.route.id],
      maxUpstreamRate: 0.6,
    });

    const router = new TokenRouter();
    const pick = await router.selectChannel('gpt-4o-mini', sharedPolicy);
    expect(pick?.channel.id).toBe(cheap.channel.id);

    const decision = await router.explainSelectionForRoute(pricey.route.id, 'gpt-4o-mini', [], sharedPolicy);
    const denied = decision.candidates.find((item) => item.channelId === pricey.channel.id);
    expect(denied?.eligible).toBe(false);
    expect(denied?.reasonCodes).toContain('upstream_rate_exceeded');
    expect(denied?.reason).toContain('0.8');
  });

  it('keeps every rate tier available when the key declares no ceiling', async () => {
    const cheap = await seedChannel('gpt-4o-mini', 'grp06', 'sk-cheap');
    const pricey = await seedChannel('gpt-4o-mini', 'grp08', 'sk-pricey');
    const openPolicy = policy({ allowedRouteIds: [cheap.route.id, pricey.route.id] });

    const router = new TokenRouter();
    const decision = await router.explainSelectionForRoute(pricey.route.id, 'gpt-4o-mini', [], openPolicy);
    const candidate = decision.candidates.find((item) => item.channelId === pricey.channel.id);

    expect(candidate?.eligible).toBe(true);
    expect(candidate?.reasonCodes ?? []).not.toContain('upstream_rate_exceeded');
  });

  it('refuses a channel whose group rate is unknown (fail closed)', async () => {
    const unknown = await seedChannel('gpt-4o-mini', 'group-not-in-catalog', 'sk-unknown');
    const strictPolicy = policy({
      allowedRouteIds: [unknown.route.id],
      maxUpstreamRate: 0.6,
    });

    const router = new TokenRouter();
    expect(await router.selectChannel('gpt-4o-mini', strictPolicy)).toBeNull();

    const decision = await router.explainSelectionForRoute(unknown.route.id, 'gpt-4o-mini', [], strictPolicy);
    const denied = decision.candidates.find((item) => item.channelId === unknown.channel.id);
    expect(denied?.eligible).toBe(false);
    expect(denied?.reasonCodes).toContain('upstream_rate_exceeded');
    expect(denied?.reason).toContain('未知');
  });

  it('falls back to the default group for a token with no bound group', async () => {
    const ungrouped = await seedChannel('gpt-4o-mini', null, 'sk-default-group');
    const defaultOnlyPolicy = policy({
      allowedRouteIds: [ungrouped.route.id],
      maxUpstreamRate: 1,
    });

    const router = new TokenRouter();
    const pick = await router.selectChannel('gpt-4o-mini', defaultOnlyPolicy);
    expect(pick?.channel.id).toBe(ungrouped.channel.id);

    const stricterPolicy = policy({
      allowedRouteIds: [ungrouped.route.id],
      maxUpstreamRate: 0.9,
    });
    expect(await router.selectChannel('gpt-4o-mini', stricterPolicy)).toBeNull();
  });
});
