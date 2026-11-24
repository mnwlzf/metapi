import { eq } from 'drizzle-orm';
import { db, schema } from '../db/index.js';
import { getAdapter } from './platforms/index.js';
import type { UserGroupInfo } from './platforms/base.js';
import {
  getCredentialModeFromExtraConfig,
  getProxyUrlFromExtraConfig,
  resolvePlatformUserId,
} from './accountExtraConfig.js';
import { withAccountProxyOverride } from './siteProxy.js';

/**
 * Group catalog for UI display.
 *
 * Tokens store the upstream group *key* (`account_tokens.token_group`), which on
 * sub2api is a numeric group id. Rendering the key directly is what made the
 * token list show "320" instead of a group name, with no status or multiplier.
 * The upstream catalog endpoint already returns all three, so this module keeps
 * one short-lived cache per account and resolves keys to display metadata.
 *
 * Caching matters: the token list may show tokens from several accounts, and the
 * data (name/status/multiplier) changes rarely, while an uncached lookup costs
 * one management-API round trip per account per list request.
 */

const CATALOG_TTL_MS = 5 * 60 * 1000;
const CATALOG_LOAD_TIMEOUT_MS = 8_000;

type CatalogCacheEntry = {
  expiresAt: number;
  catalog: UserGroupInfo[];
};

const catalogCache = new Map<number, CatalogCacheEntry>();
const catalogInflight = new Map<number, Promise<UserGroupInfo[]>>();

export function __resetAccountGroupCatalogCacheForTests(): void {
  catalogCache.clear();
  catalogInflight.clear();
  catalogWarmupAttempts.clear();
}

function withTimeout<T>(task: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`group catalog timeout after ${timeoutMs}ms`)), timeoutMs);
    task.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function isApiKeyConnection(account: typeof schema.accounts.$inferSelect): boolean {
  const explicit = getCredentialModeFromExtraConfig(account.extraConfig);
  if (explicit && explicit !== 'auto') return explicit === 'apikey';
  return !(account.accessToken || '').trim();
}

async function fetchAccountGroupCatalog(accountId: number): Promise<UserGroupInfo[]> {
  const row = await db.select()
    .from(schema.accounts)
    .innerJoin(schema.sites, eq(schema.accounts.siteId, schema.sites.id))
    .where(eq(schema.accounts.id, accountId))
    .get();

  if (!row) return [];
  const account = row.accounts;
  const site = row.sites;
  if (isApiKeyConnection(account)) return [];

  const adapter = getAdapter(site.platform);
  const fetchCatalog = adapter?.getUserGroupCatalog;
  if (!adapter || !fetchCatalog) return [];

  const platformUserId = resolvePlatformUserId(account.extraConfig, account.username);
  return await withAccountProxyOverride(
    getProxyUrlFromExtraConfig(account.extraConfig),
    () => fetchCatalog.call(adapter, site.url, account.accessToken, platformUserId),
  );
}

/**
 * Load (or reuse) the group catalog of one account.
 *
 * Failures degrade to an empty catalog: display enrichment must never turn a
 * token-list request into an error, and stale-but-recent data is preferred over
 * none.
 */
export async function loadAccountGroupCatalog(accountId: number): Promise<UserGroupInfo[]> {
  const cached = catalogCache.get(accountId);
  if (cached && cached.expiresAt > Date.now()) return cached.catalog;

  const running = catalogInflight.get(accountId);
  if (running) return running;

  const task = (async () => {
    try {
      const catalog = await withTimeout(fetchAccountGroupCatalog(accountId), CATALOG_LOAD_TIMEOUT_MS);
      if (catalog.length > 0) {
        catalogCache.set(accountId, { expiresAt: Date.now() + CATALOG_TTL_MS, catalog });
      }
      return catalog;
    } catch {
      return [];
    } finally {
      catalogInflight.delete(accountId);
    }
  })();

  catalogInflight.set(accountId, task);
  return task;
}

/**
 * Read the catalog without waiting on the network.
 *
 * Routing runs synchronously, so an eligibility rule that depends on a group's
 * rate multiplier can only consult what is already cached. null means "we do
 * not know yet" — deliberately distinct from an empty catalog, which is a real
 * (if useless) answer.
 */
export function peekAccountGroupCatalog(accountId: number): UserGroupInfo[] | null {
  const cached = catalogCache.get(accountId);
  if (!cached) return null;
  if (cached.expiresAt <= Date.now()) return null;
  return cached.catalog;
}

const CATALOG_WARMUP_RETRY_MS = 60 * 1000;
const catalogWarmupAttempts = new Map<number, number>();

/**
 * Populate the cache in the background after a routing pass found it empty.
 * Failures are not cached by `loadAccountGroupCatalog`, so without a retry
 * window every request would fire its own management call.
 */
export function requestAccountGroupCatalogWarmup(accountId: number): void {
  if (!Number.isFinite(accountId) || accountId <= 0) return;
  if (peekAccountGroupCatalog(accountId)) return;
  const now = Date.now();
  const lastAttempt = catalogWarmupAttempts.get(accountId) ?? 0;
  if (now - lastAttempt < CATALOG_WARMUP_RETRY_MS) return;
  catalogWarmupAttempts.set(accountId, now);
  void loadAccountGroupCatalog(accountId).catch(() => {});
}

export type TokenGroupStatus = 'active' | 'inactive' | 'removed' | 'unknown';
export type TokenGroupDisplay = {
  /** Human-readable group name; null when the key could not be resolved. */
  name: string | null;
  status: TokenGroupStatus;
  rateMultiplier: number | null;
};

/**
 * Resolve a stored group key to display metadata.
 *
 * A key that is absent from a *non-empty* catalog is reported as `removed`:
 * upstream no longer lists that group (deleted or taken offline), which is the
 * signal the token list surfaces. An empty catalog means we could not read the
 * catalog at all, so nothing is claimed about the group.
 */
export function resolveTokenGroupDisplay(
  catalog: UserGroupInfo[],
  tokenGroup: string | null | undefined,
): TokenGroupDisplay {
  const key = String(tokenGroup ?? '').trim();
  if (!key || catalog.length === 0) {
    return { name: null, status: 'unknown', rateMultiplier: null };
  }

  const hit = catalog.find((group) => group.id === key) || catalog.find((group) => group.name === key);
  if (!hit) return { name: null, status: 'removed', rateMultiplier: null };
  return { name: hit.name, status: hit.status, rateMultiplier: hit.rateMultiplier };
}
