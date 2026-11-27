import { eq } from 'drizzle-orm';
import { db, schema } from '../db/index.js';
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

const READ_WARMUP_RETRY_MS = 60 * 1000;
const readWarmupAttempts = new Map<number, number>();

export function __resetUpstreamGroupRateReadWarmupForTests(): void {
  readWarmupAttempts.clear();
}

/**
 * Warm the same two sources from a *read* path (the usage log), where only the
 * account id is at hand.
 *
 * Routing warms on its own miss, but log rendering used to only peek at the
 * caches: after a restart, or once the 5-10 minute TTLs lapsed, every page load
 * re-read the same cold cache and the multiplier stayed unknown forever. This
 * loads the account/site row once and hands it to `requestUpstreamGroupRateWarmup`.
 *
 * Frequency is bounded twice on purpose:
 * - this throttle allows at most one attempt per account per minute, so a page
 *   of 50 log rows costs one attempt (and re-rendering costs none);
 * - both callees skip the fetch entirely while their own TTL is still valid, so
 *   the upstream is actually queried at most once per TTL, not once per minute.
 * A live multiplier is preferred over any stored value precisely because
 * upstream may reprice a group at any time; that is also why this refreshes
 * instead of trusting whatever was recorded at billing time.
 */
export function requestUpstreamGroupRateReadWarmup(accountId: number): void {
  const id = Number(accountId);
  if (!Number.isFinite(id) || id <= 0) return;
  const now = Date.now();
  const lastAttempt = readWarmupAttempts.get(id) ?? 0;
  if (now - lastAttempt < READ_WARMUP_RETRY_MS) return;
  readWarmupAttempts.set(id, now);

  void (async () => {
    const row = await db
      .select({
        siteId: schema.sites.id,
        siteUrl: schema.sites.url,
        sitePlatform: schema.sites.platform,
        accessToken: schema.accounts.accessToken,
        apiToken: schema.accounts.apiToken,
      })
      .from(schema.accounts)
      .innerJoin(schema.sites, eq(schema.accounts.siteId, schema.sites.id))
      .where(eq(schema.accounts.id, id))
      .get();

    if (!row) {
      // Account gone: the catalog source is still worth a try (it looks the row
      // up again itself and no-ops when it is missing).
      requestAccountGroupCatalogWarmup(id);
      return;
    }

    requestUpstreamGroupRateWarmup({
      site: {
        id: Number(row.siteId),
        url: row.siteUrl ?? null,
        platform: row.sitePlatform ?? null,
      },
      account: {
        id,
        accessToken: row.accessToken ?? null,
        apiToken: row.apiToken ?? null,
      },
    });
  })().catch(() => {});
}

/** Comparison tolerance: multipliers are decimal ratios published by upstream. */
const RATE_EPSILON = 1e-9;

export type UpstreamRateLimitVerdict =
  | { allowed: true }
  | { allowed: false; message: string; details: Record<string, unknown> };

/** A configured range is a hard eligibility rule; unknown rates fail closed. */
export function evaluateUpstreamRateRange(
  input: UpstreamGroupRateInput,
  minimum: number | null,
  maximum: number | null,
): UpstreamRateLimitVerdict {
  const min = minimum !== null && Number.isFinite(minimum) && minimum >= 0 ? minimum : null;
  const max = maximum !== null && Number.isFinite(maximum) && maximum >= 0 ? maximum : null;
  if (min === null && max === null) return { allowed: true };
  const rangeText = `${min === null ? '不限下限' : formatRate(min)} 至 ${max === null ? '不限上限' : formatRate(max)}`;

  const resolution = resolveUpstreamGroupRate(input);
  if (!resolution.known) {
    requestUpstreamGroupRateWarmup(input);
    return {
      allowed: false,
      message: `上游分组倍率未知（分组=${resolution.groupKey}，密钥范围=${rangeText}），已按保守策略排除`,
      details: {
        upstreamRateMinimum: min,
        upstreamRateMaximum: max,
        upstreamRate: null,
        upstreamRateSource: null,
        upstreamGroupKey: resolution.groupKey,
        upstreamRateUnknown: true,
      },
    };
  }

  if (min !== null && resolution.rate < min - RATE_EPSILON) {
    return {
      allowed: false,
      message: `上游分组倍率 ${formatRate(resolution.rate)} < 密钥下限 ${formatRate(min)}（分组=${resolution.groupKey}）`,
      details: {
        upstreamRateMinimum: min,
        upstreamRateMaximum: max,
        upstreamRate: resolution.rate,
        upstreamRateSource: resolution.source,
        upstreamGroupKey: resolution.groupKey,
        upstreamRateUnknown: false,
      },
    };
  }

  if (max !== null && resolution.rate > max + RATE_EPSILON) {
    return {
      allowed: false,
      message: `上游分组倍率 ${formatRate(resolution.rate)} > 密钥上限 ${formatRate(max)}（分组=${resolution.groupKey}）`,
      details: {
        upstreamRateMinimum: min,
        upstreamRateMaximum: max,
        upstreamRate: resolution.rate,
        upstreamRateSource: resolution.source,
        upstreamGroupKey: resolution.groupKey,
        upstreamRateUnknown: false,
      },
    };
  }

  return { allowed: true };
}

/** Backward-compatible ceiling-only helper. */
export function evaluateUpstreamRateLimit(input: UpstreamGroupRateInput, limit: number | null): UpstreamRateLimitVerdict {
  const verdict = evaluateUpstreamRateRange(input, null, limit);
  if (verdict.allowed) return verdict;
  return {
    ...verdict,
    details: { ...verdict.details, upstreamRateLimit: limit },
  };
}

function formatRate(value: number): string {
  return Number.isInteger(value) ? String(value) : String(Number(value.toFixed(4)));
}
