import { and, eq, inArray, isNull } from 'drizzle-orm';
import { db, schema } from '../db/index.js';
import { canonicalizeModelName } from '../shared/modelCanonicalization.js';

/**
 * Provenance of a disable row.
 *
 * `probe` rows are a *verdict about reachability* and are reverted automatically
 * once the model answers again; `manual` (operator intent) and `policy`
 * (new-model policy) are not.
 */
export type SiteDisabledModelSource = 'probe' | 'manual' | 'policy';

/** Disable rows a successful probe is allowed to undo: its own, plus legacy
 *  rows written before provenance was recorded (same writer, unknown label). */
export const AUTO_RECOVERABLE_DISABLE_SOURCES = ['probe'] as const;
export const STICKY_DISABLE_SOURCES: SiteDisabledModelSource[] = ['manual', 'policy'];

export type SiteDisabledModelsIndex = Map<number, {
  // Legacy site-wide rows (account_id NULL) — kept for backward compatibility;
  // after the v1.8 boot-time fan-out all such rows are deleted so this is empty.
  raw: Set<string>;
  canonicalFree: Set<string>;
  canonicalNonFree: Set<string>;
  // Per-account rows (account_id set): keyed by account id.
  byAccount: Map<number, {
    raw: Set<string>;
    canonicalFree: Set<string>;
    canonicalNonFree: Set<string>;
    /**
     * Verdicts that belong to ONE upstream key (`token_id`), keyed by token id.
     * A model is served by the token's group, so one key's "not supported" says
     * nothing about the account's other keys — the account-level sets above hold
     * only account-wide rows (token_id = 0).
     */
    byToken: Map<number, {
      raw: Set<string>;
      canonicalFree: Set<string>;
      canonicalNonFree: Set<string>;
    }>;
  }>;
}>;

/** `site_disabled_models.token_id` value meaning "the whole account". */
export const ACCOUNT_WIDE_DISABLE_TOKEN_ID = 0;

function normalizeRawModelName(modelName: string): string {
  return String(modelName || '').trim().toLowerCase();
}

function hasFreeSuffix(modelName: string): boolean {
  return /:free$/i.test(String(modelName || '').trim()) || /-free$/i.test(String(modelName || '').trim());
}

/** The same alias/free-variant rules used by the disable index. */
export function matchesDisabledModelName(disabledName: string, modelName: string): boolean {
  if (normalizeRawModelName(disabledName) === normalizeRawModelName(modelName)) return true;
  return hasFreeSuffix(disabledName) === hasFreeSuffix(modelName)
    && !!canonicalizeModelName(disabledName)
    && canonicalizeModelName(disabledName) === canonicalizeModelName(modelName);
}

/**
 * Canonical lookup key that KEEPS the free label: drops the provider prefix
 * (so `stepfun/step-5-preview` and `step-5-preview` collapse to one key, like
 * `canonicalizeModelName`) but unlike it preserves `:free` / `-free`.
 *
 * Needed because the disabled index stores free and non-free entries in
 * disjoint canonical sets (`canonicalFree` / `canonicalNonFree`): passing a
 * free-stripped key makes the lookup hit the wrong set, letting a non-free
 * disable wrongly block its free sibling (and vice versa). Mirror the
 * prefix-drop rule of `canonicalizeModelName` (only the last '/'-segment is
 * the model, ollama's default `:latest` tag is the untagged artifact) and
 * stop before the free strip.
 */
export function canonicalLookupKeyPreservingFree(modelName: string): string {
  let value = normalizeRawModelName(modelName);
  if (!value) return '';
  const slashParts = value.split('/').filter(Boolean);
  if (slashParts.length > 1) value = slashParts[slashParts.length - 1]!;
  value = value.replace(/:latest$/i, '');
  return value;
}

function makeEntry() {
  return { raw: new Set<string>(), canonicalFree: new Set<string>(), canonicalNonFree: new Set<string>() };
}

type DisableMatchEntry = ReturnType<typeof makeEntry>;
type AccountDisableEntry = DisableMatchEntry & { byToken: Map<number, DisableMatchEntry> };

function makeAccountEntry(): AccountDisableEntry {
  return { ...makeEntry(), byToken: new Map() };
}

/**
 * Migrate legacy site-wide disabled-model rows (account_id IS NULL) to
 * per-key rows for every account of the owning site, then remove the originals.
 *
 * Idempotent — after the first run there are no NULL rows left.
 */
export async function fanoutSiteWideDisabledModels(): Promise<void> {
  const siteWideRows = await db.select({
    siteId: schema.siteDisabledModels.siteId,
    modelName: schema.siteDisabledModels.modelName,
    // Provenance must survive the fan-out: a probe-written site-wide row that
    // lost its source would become permanently sticky.
    source: schema.siteDisabledModels.source,
  }).from(schema.siteDisabledModels)
    .where(isNull(schema.siteDisabledModels.accountId))
    .all();

  if (siteWideRows.length === 0) return;

  // Group by site.
  const bySite = new Map<number, Array<{ modelName: string; source: string | null }>>();
  for (const row of siteWideRows) {
    const siteId = Number(row.siteId);
    if (!Number.isFinite(siteId) || siteId <= 0) continue;
    const models = bySite.get(siteId) ?? [];
    models.push({ modelName: row.modelName, source: row.source ?? null });
    bySite.set(siteId, models);
  }

  for (const [siteId, fanoutRows] of bySite) {
    const accounts = await db.select({ id: schema.accounts.id })
      .from(schema.accounts)
      .where(eq(schema.accounts.siteId, siteId))
      .all();
    if (accounts.length === 0) {
      // Orphaned rows (no accounts for this site) — delete them.
      await db.delete(schema.siteDisabledModels)
        .where(and(eq(schema.siteDisabledModels.siteId, siteId), isNull(schema.siteDisabledModels.accountId)))
        .run();
      continue;
    }

    // Collect existing per-key rows to avoid duplicates.
    const accountIds = accounts.map((a) => a.id);
    const existingRows = await db.select({
      accountId: schema.siteDisabledModels.accountId,
      modelName: schema.siteDisabledModels.modelName,
    }).from(schema.siteDisabledModels)
      .where(and(
        eq(schema.siteDisabledModels.siteId, siteId),
        inArray(schema.siteDisabledModels.accountId, accountIds),
      ))
      .all();
    const existing = new Set(
      existingRows
        .filter((r) => r.accountId != null)
        .map((r) => `${r.accountId}::${normalizeRawModelName(r.modelName)}`),
    );

    // Fan out.
    const values: Array<{ siteId: number; accountId: number; modelName: string; source: string | null }> = [];
    for (const account of accounts) {
      for (const row of fanoutRows) {
        if (existing.has(`${account.id}::${normalizeRawModelName(row.modelName)}`)) continue;
        values.push({ siteId, accountId: account.id, modelName: row.modelName, source: row.source });
      }
    }
    if (values.length > 0) {
      await db.insert(schema.siteDisabledModels).values(values);
    }

    // Delete the original site-wide rows.
    await db.delete(schema.siteDisabledModels)
      .where(and(eq(schema.siteDisabledModels.siteId, siteId), isNull(schema.siteDisabledModels.accountId)));
  }
}

/**
 * Load all site_disabled_models rows into an in-memory index.
 *
 * After the v1.8 boot-time fan-out, only per-key rows exist (account_id set).
 * Legacy site-wide rows (account_id NULL) are deleted by the fan-out, but the
 * index still accepts them for backward compatibility during the transition.
 */
export async function loadSiteDisabledModelsIndex(options?: { sources: SiteDisabledModelSource[] }): Promise<SiteDisabledModelsIndex> {
  const rows = await db.select({
    siteId: schema.siteDisabledModels.siteId,
    accountId: schema.siteDisabledModels.accountId,
    tokenId: schema.siteDisabledModels.tokenId,
    modelName: schema.siteDisabledModels.modelName,
    source: schema.siteDisabledModels.source,
  }).from(schema.siteDisabledModels).all();

  const index: SiteDisabledModelsIndex = new Map();
  for (const row of rows) {
    if (options && !options.sources.includes(row.source as SiteDisabledModelSource)) continue;
    const siteId = Number(row.siteId);
    if (!Number.isFinite(siteId) || siteId <= 0) continue;
    const raw = normalizeRawModelName(row.modelName);
    if (!raw) continue;

    let entry = index.get(siteId);
    if (!entry) {
      entry = { raw: new Set(), canonicalFree: new Set(), canonicalNonFree: new Set(), byAccount: new Map() };
      index.set(siteId, entry);
    }

    const accountId = row.accountId == null ? null : Number(row.accountId);
    if (accountId == null || !Number.isFinite(accountId) || accountId <= 0) {
      // Legacy site-wide row: applies to every key of the site.
      entry.raw.add(raw);
      const canonical = canonicalizeModelName(row.modelName);
      if (canonical) {
        if (hasFreeSuffix(row.modelName)) entry.canonicalFree.add(canonical);
        else entry.canonicalNonFree.add(canonical);
      }
      continue;
    }

    const accountEntry = entry.byAccount.get(accountId)
      ?? (entry.byAccount.set(accountId, makeAccountEntry()), entry.byAccount.get(accountId)!);
    const tokenId = Number(row.tokenId ?? 0);
    // token_id 0 = the whole account; anything else narrows the verdict to that
    // one upstream key.
    const target = tokenId > 0
      ? (accountEntry.byToken.get(tokenId)
        ?? (accountEntry.byToken.set(tokenId, makeEntry()), accountEntry.byToken.get(tokenId)!))
      : accountEntry;

    target.raw.add(raw);
    const canonical = canonicalizeModelName(row.modelName);
    if (canonical) {
      if (hasFreeSuffix(row.modelName)) {
        target.canonicalFree.add(canonical);
      } else {
        target.canonicalNonFree.add(canonical);
      }
    }
  }
  return index;
}

/**
 * Undo probe-written disables for models that just answered.
 *
 * A disable row used to be one-way: the probe could add it, but nothing — not a
 * later successful probe, not the periodic model refresh, not a route rebuild —
 * ever removed it. The model stayed out of routing even after it recovered, and
 * only the per-key editor could put it back. A confirmed success is the same
 * kind of evidence the disable was based on, so it now reverts exactly the rows
 * the probe wrote ('probe', plus NULL from before provenance existed) and leaves
 * operator/policy intent alone.
 *
 * Exact-name matching is deliberate: these rows are written from the very model
 * list the probe iterates, so the spelling is identical (canonical matching
 * would risk reverting a differently-named sibling).
 *
 * Scope is the key that just succeeded plus account-wide (token_id = 0) rows: an
 * account-wide verdict was drawn without knowing which key serves the model, so
 * per-key success supersedes it. Another key's verdict is never touched — it
 * describes a different upstream group.
 */
export async function clearAutoDisabledModels(input: {
  siteId: number;
  accountId?: number | null;
  /** The key that just answered. Omit for account-wide (legacy) semantics. */
  tokenId?: number | null;
  modelNames: string[];
}): Promise<string[]> {
  const siteId = Number(input.siteId);
  if (!Number.isFinite(siteId) || siteId <= 0) return [];

  const modelNames = Array.from(new Set(
    input.modelNames
      .map((name) => String(name || '').trim())
      .filter((name) => name.length > 0),
  ));
  if (modelNames.length === 0) return [];

  const rawAccountId = input.accountId == null ? null : Number(input.accountId);
  const accountScope = rawAccountId != null && Number.isFinite(rawAccountId) && rawAccountId > 0
    ? eq(schema.siteDisabledModels.accountId, rawAccountId)
    : isNull(schema.siteDisabledModels.accountId);

  const rawTokenId = input.tokenId == null ? null : Number(input.tokenId);
  const tokenScope = rawTokenId != null && Number.isFinite(rawTokenId) && rawTokenId > 0
    ? inArray(schema.siteDisabledModels.tokenId, [ACCOUNT_WIDE_DISABLE_TOKEN_ID, rawTokenId])
    : eq(schema.siteDisabledModels.tokenId, ACCOUNT_WIDE_DISABLE_TOKEN_ID);

  // Read first, then delete by id: `DELETE ... RETURNING` is not portable across
  // the supported dialects, and the caller wants the names for its progress log.
  const candidates = await db.select({
    id: schema.siteDisabledModels.id,
    modelName: schema.siteDisabledModels.modelName,
    source: schema.siteDisabledModels.source,
  })
    .from(schema.siteDisabledModels)
    .where(and(
      eq(schema.siteDisabledModels.siteId, siteId),
      accountScope,
      tokenScope,
      inArray(schema.siteDisabledModels.modelName, modelNames),
    ))
    .all();

  const removable = candidates.filter((row) => (
    row.source == null || row.source === AUTO_RECOVERABLE_DISABLE_SOURCES[0]
  ));
  if (removable.length === 0) return [];

  await db.delete(schema.siteDisabledModels)
    .where(inArray(schema.siteDisabledModels.id, removable.map((row) => row.id)))
    .run();

  return removable.map((row) => String(row.modelName));
}

function matches(entry: { raw: Set<string>; canonicalFree: Set<string>; canonicalNonFree: Set<string> }, modelName: string): boolean {
  const raw = normalizeRawModelName(modelName);
  if (!raw) return false;
  if (entry.raw.has(raw)) return true;
  const free = hasFreeSuffix(modelName);
  const canonical = canonicalizeModelName(modelName);
  if (!canonical) return false;
  const canonicalSet = free ? entry.canonicalFree : entry.canonicalNonFree;
  return canonicalSet.has(canonical);
}

/**
 * Whether a model is disabled for a site, and optionally for a specific key.
 *
 * Per-key rows (account_id set) are matched when `accountId` is provided, and a
 * row scoped to one upstream key (token_id > 0) only matches when that same key
 * is being evaluated — a verdict about one group must not silence another.
 * Legacy site-wide rows (account_id NULL) match every key of the site.
 *
 * Pass `tokenId` from every context that knows which key will carry the request
 * (route channels, per-token availability); omit it when the question is "is
 * this blocked for the account as a whole".
 */
export function isModelDisabledForSite(
  index: SiteDisabledModelsIndex | null | undefined,
  siteId: number | null | undefined,
  modelName: string | null | undefined,
  accountId?: number | null,
  tokenId?: number | null,
): boolean {
  if (!index || siteId == null || !Number.isFinite(siteId) || siteId <= 0) return false;
  const entry = index.get(siteId);
  if (!entry) return false;

  // Legacy site-wide rows (NULL account_id) — empty after migration.
  if (matches(entry, modelName || '')) return true;

  if (accountId == null || !Number.isFinite(accountId) || accountId <= 0) return false;
  const perAccount = entry.byAccount.get(accountId);
  if (!perAccount) return false;

  // Account-wide verdicts apply to every key of this account.
  if (matches(perAccount, modelName || '')) return true;

  const rawTokenId = tokenId == null ? null : Number(tokenId);
  if (rawTokenId != null && Number.isFinite(rawTokenId) && rawTokenId > 0) {
    const perToken = perAccount.byToken.get(rawTokenId);
    return !!perToken && matches(perToken, modelName || '');
  }

  // No key given: a single key's verdict does not make the model unavailable to
  // the account, so only account-wide rows count here.
  return false;
}

/**
 * Per-key verdicts for one model, for callers that must distinguish "this model
 * is gone" from "these keys cannot serve it".
 */
export function getDisabledTokenIds(
  index: SiteDisabledModelsIndex | null | undefined,
  siteId: number | null | undefined,
  modelName: string | null | undefined,
  accountId: number | null | undefined,
): Set<number> {
  const disabledTokens = new Set<number>();
  if (!index || siteId == null || !Number.isFinite(siteId) || siteId <= 0) return disabledTokens;
  const entry = index.get(siteId);
  if (!entry) return disabledTokens;
  if (matches(entry, modelName || '')) return disabledTokens;

  const rawAccountId = accountId == null ? null : Number(accountId);
  if (rawAccountId == null || !Number.isFinite(rawAccountId) || rawAccountId <= 0) return disabledTokens;
  const perAccount = entry.byAccount.get(rawAccountId);
  if (!perAccount || matches(perAccount, modelName || '')) return disabledTokens;

  for (const [tokenId, tokenEntry] of perAccount.byToken) {
    if (matches(tokenEntry, modelName || '')) disabledTokens.add(tokenId);
  }
  return disabledTokens;
}

/** An account catalog is a union, not an additional supplier. Once a key has
 * a model-specific verdict, callers must use the surviving per-key rows rather
 * than resurrecting that model through the account-level catalog. */
export function isAccountModelFallbackDisabled(
  index: SiteDisabledModelsIndex,
  siteId: number,
  modelName: string,
  accountId: number,
): boolean {
  return isModelDisabledForSite(index, siteId, modelName, accountId)
    || getDisabledTokenIds(index, siteId, modelName, accountId).size > 0;
}
