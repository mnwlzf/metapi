import { peekAccountGroupCatalog, requestAccountGroupCatalogWarmup, resolveTokenGroupDisplay } from './accountGroupCatalogService.js';
import { getCachedGroupRate, requestRoutingReferenceCostWarmup } from './modelPricingService.js';

/**
 * Resolve the upstream group consumption multiplier (上游消耗倍率) a routing
 * candidate would actually bill at.
 *
 * A token's multiplier is not stored on the token: `account_tokens.token_group`
 * holds the upstream group *key* (a group name on new-api/one-api, a numeric id
 * on sub2api), and the multiplier lives in whichever metadata source that
 * platform publishes:
 *
 * - `/api/pricing` → `group_ratio[groupName]` (new-api family),
 * - `/api/v1/groups/available` → `rate_multiplier` per group id (sub2api).
 *
 * Both are fetched for other purposes and cached in memory, so this module only
 * *reads* those caches. Routing is synchronous; waiting on a fetch is not an
 * option, and a cache miss therefore means "unknown" — the caller decides what
 * that costs, and `requestUpstreamGroupRateWarmup()` makes sure the miss is
 * transient instead of permanent.
 */

export type UpstreamGroupRateSource = 'pricing' | 'catalog';

export type UpstreamGroupRateResolution =
  | { known: true; rate: number; source: UpstreamGroupRateSource; groupKey: string }
  | { known: false; rate: null; source: null; groupKey: string };

/** The part of a routing candidate this resolver needs. */
export type UpstreamGroupRateInput = {
  site: {
    id: number;
    url?: string | null;
    platform?: string | null;
    apiKey?: string | null;
  };
  account: {
    id: number;
    accessToken?: string | null;
    apiToken?: string | null;
  };
  token?: { tokenGroup?: string | null } | null;
  channel?: { sourceModel?: string | null } | null;
  modelName?: string | null;
};

/**
 * A token with no bound group consumes the upstream's default group, which both
 * platforms publish under `default`. Resolving it as an unknown group instead
 * would make every ungrouped token unusable for rate-limited keys.
 */
export const DEFAULT_UPSTREAM_GROUP_KEY = 'default';

export function resolveUpstreamGroupRate(input: UpstreamGroupRateInput): UpstreamGroupRateResolution {
  const groupKey = String(input.token?.tokenGroup ?? '').trim() || DEFAULT_UPSTREAM_GROUP_KEY;

  const pricedRate = getCachedGroupRate({
    siteId: input.site.id,
    accountId: input.account.id,
    groupKey,
  });
  if (pricedRate !== null) {
    return { known: true, rate: pricedRate, source: 'pricing', groupKey };
  }

  const catalog = peekAccountGroupCatalog(input.account.id);
  if (catalog && catalog.length > 0) {
    // Matches by group id first, then by name, so a numeric key from sub2api and
    // a named key from new-api both resolve against the same catalog shape.
    const display = resolveTokenGroupDisplay(catalog, groupKey);
    if (display.rateMultiplier !== null) {
      return { known: true, rate: display.rateMultiplier, source: 'catalog', groupKey };
    }
  }

  return { known: false, rate: null, source: null, groupKey };
}

/**
 * Ask both metadata sources to load in the background. Called only when a
 * resolution failed, so a healthy cache costs nothing here.
 */
export function requestUpstreamGroupRateWarmup(input: UpstreamGroupRateInput): void {
  requestAccountGroupCatalogWarmup(input.account.id);

  const url = String(input.site.url ?? '').trim();
  if (!url || !String(input.site.platform ?? '').trim()) return;
  requestRoutingReferenceCostWarmup({
    site: {
      id: input.site.id,
      url,
      platform: String(input.site.platform),
      apiKey: input.site.apiKey ?? null,
    },
    account: {
      id: input.account.id,
      accessToken: input.account.accessToken ?? null,
      apiToken: input.account.apiToken ?? null,
    },
    modelName: String(input.modelName ?? input.channel?.sourceModel ?? '').trim(),
  });
}

/** Comparison tolerance: multipliers are decimal ratios published by upstream. */
const RATE_EPSILON = 1e-9;

export type UpstreamRateLimitVerdict =
  | { allowed: true }
  | { allowed: false; message: string; details: Record<string, unknown> };

/**
 * The rate ceiling rule itself: a key declaring `limit` may only be dispatched
 * to groups whose multiplier is `<= limit`. Unknown multipliers are refused —
 * the whole point of declaring a ceiling is not to route on hope.
 */
export function evaluateUpstreamRateLimit(
  input: UpstreamGroupRateInput,
  limit: number | null,
): UpstreamRateLimitVerdict {
  if (limit === null || !Number.isFinite(limit) || limit < 0) return { allowed: true };

  const resolution = resolveUpstreamGroupRate(input);
  if (!resolution.known) {
    requestUpstreamGroupRateWarmup(input);
    return {
      allowed: false,
      message: `上游分组倍率未知（分组=${resolution.groupKey}，密钥上限=${formatRate(limit)}），已按保守策略排除`,
      details: {
        upstreamRateLimit: limit,
        upstreamRate: null,
        upstreamRateSource: null,
        upstreamGroupKey: resolution.groupKey,
        upstreamRateUnknown: true,
      },
    };
  }

  if (resolution.rate > limit + RATE_EPSILON) {
    return {
      allowed: false,
      message: `上游分组倍率 ${formatRate(resolution.rate)} > 密钥上限 ${formatRate(limit)}（分组=${resolution.groupKey}）`,
      details: {
        upstreamRateLimit: limit,
        upstreamRate: resolution.rate,
        upstreamRateSource: resolution.source,
        upstreamGroupKey: resolution.groupKey,
        upstreamRateUnknown: false,
      },
    };
  }

  return { allowed: true };
}

function formatRate(value: number): string {
  return Number.isInteger(value) ? String(value) : String(Number(value.toFixed(4)));
}
