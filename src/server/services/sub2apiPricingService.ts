import { getAdapter } from './platforms/index.js';
import type { ModelPriceCatalogEntry } from './platforms/base.js';
import { loadAccountGroupCatalog } from './accountGroupCatalogService.js';

/**
 * sub2api price catalog: per-token model prices plus per-group rate multipliers.
 *
 * sub2api does not publish new-api's `model_ratio` table; it publishes absolute
 * per-token prices (`input_price`, `output_price`, `cache_read_price`,
 * `cache_write_price`) and a per-group `rate_multiplier`. An estimate for this
 * platform therefore has to be `tokens x price x rate`, and reusing the new-api
 * ratio table would be a different price basis entirely (measured ~1.6x off on a
 * live site), not a missing multiplier.
 *
 * One cache per account: the group catalog comes from the endpoint that already
 * caches it (`accountGroupCatalogService`), the model prices from the same
 * upstream payload via the adapter capability. Both refresh on a 5 minute TTL.
 */

const CATALOG_TTL_MS = 5 * 60 * 1000;

export type Sub2apiPricingCatalog = {
  /** group id or name → rate_multiplier */
  rates: Map<string, number>;
  /** lowercase model name → per-token USD prices at 1x */
  models: Map<string, ModelPriceCatalogEntry>;
};

type CacheEntry = Sub2apiPricingCatalog & { expiresAt: number };

const cache = new Map<number, CacheEntry>();
const inflight = new Map<number, Promise<Sub2apiPricingCatalog | null>>();

export function __resetSub2apiPricingCacheForTests(): void {
  cache.clear();
  inflight.clear();
}

export function peekSub2apiPricingCatalog(accountId: number): Sub2apiPricingCatalog | null {
  const entry = cache.get(accountId);
  if (!entry) return null;
  if (entry.expiresAt <= Date.now()) return null;
  return { rates: entry.rates, models: entry.models };
}

export function isSub2apiPlatform(platform: string | null | undefined): boolean {
  return String(platform || '').trim().toLowerCase() === 'sub2api';
}

function buildRateMap(groups: Array<{ id: string | null; name: string; rateMultiplier: number | null }>): Map<string, number> {
  const rates = new Map<string, number>();
  for (const group of groups) {
    if (typeof group.rateMultiplier !== 'number' || !Number.isFinite(group.rateMultiplier)) continue;
    if (group.id) rates.set(String(group.id).trim(), group.rateMultiplier);
    const name = String(group.name || '').trim();
    if (name) rates.set(name, group.rateMultiplier);
  }
  return rates;
}

async function loadCatalog(input: {
  accountId: number;
  siteUrl: string;
  accessToken?: string | null;
}): Promise<Sub2apiPricingCatalog | null> {
  const adapter = getAdapter('sub2api');
  const fetchPrices = adapter?.getModelPriceCatalog;
  const accessToken = String(input.accessToken || '').trim();
  const siteUrl = String(input.siteUrl || '').trim();
  if (!adapter || !fetchPrices || !accessToken || !siteUrl) return null;

  const [prices, groups] = await Promise.all([
    fetchPrices.call(adapter, siteUrl, accessToken).catch(() => [] as ModelPriceCatalogEntry[]),
    loadAccountGroupCatalog(input.accountId).catch(() => []),
  ]);

  const models = new Map<string, ModelPriceCatalogEntry>();
  for (const entry of prices) {
    const key = String(entry.modelName || '').trim().toLowerCase();
    if (!key) continue;
    models.set(key, entry);
  }

  if (models.size === 0 && groups.length === 0) return null;
  return { rates: buildRateMap(groups), models };
}

/**
 * Load (or reuse) the catalog for one account. Failures degrade to null so a
 * pricing lookup can never turn a completed request into an error.
 */
export async function loadSub2apiPricingCatalog(input: {
  accountId: number;
  siteUrl: string;
  accessToken?: string | null;
}): Promise<Sub2apiPricingCatalog | null> {
  const cached = peekSub2apiPricingCatalog(input.accountId);
  if (cached) return cached;

  const running = inflight.get(input.accountId);
  if (running) return running;

  const task = (async () => {
    try {
      const catalog = await loadCatalog(input);
      if (catalog) cache.set(input.accountId, { ...catalog, expiresAt: Date.now() + CATALOG_TTL_MS });
      return catalog;
    } catch {
      return null;
    } finally {
      inflight.delete(input.accountId);
    }
  })();

  inflight.set(input.accountId, task);
  return task;
}

/**
 * Resolve the group rate for a token. An unbound token consumes the upstream's
 * default group, mirroring how new-api resolves `default`.
 */
export function resolveSub2apiGroupRate(
  catalog: Sub2apiPricingCatalog,
  tokenGroup: string | null | undefined,
): number | null {
  const key = String(tokenGroup ?? '').trim() || 'default';
  if (catalog.rates.has(key)) return catalog.rates.get(key)!;
  // sub2api keys are bound by numeric id; a stored name still resolves by name.
  for (const [candidate, rate] of catalog.rates.entries()) {
    if (candidate.toLowerCase() === key.toLowerCase()) return rate;
  }
  return null;
}

export function findSub2apiModelPrice(
  catalog: Sub2apiPricingCatalog,
  modelName: string | null | undefined,
): ModelPriceCatalogEntry | null {
  const key = String(modelName || '').trim().toLowerCase();
  if (!key) return null;
  const direct = catalog.models.get(key);
  if (direct) return direct;
  // Tolerate vendor-prefixed aliases ("anthropic/claude-x") used by some relays.
  for (const [candidate, price] of catalog.models.entries()) {
    if (candidate.endsWith(`/${key}`) || key.endsWith(`/${candidate}`)) return price;
  }
  return null;
}
