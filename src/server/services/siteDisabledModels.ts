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
  }>;
}>;

function normalizeRawModelName(modelName: string): string {
  return String(modelName || '').trim().toLowerCase();
}

function hasFreeSuffix(modelName: string): boolean {
  return /:free$/i.test(String(modelName || '').trim()) || /-free$/i.test(String(modelName || '').trim());
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
export async function loadSiteDisabledModelsIndex(): Promise<SiteDisabledModelsIndex> {
  const rows = await db.select({
    siteId: schema.siteDisabledModels.siteId,
    accountId: schema.siteDisabledModels.accountId,
    modelName: schema.siteDisabledModels.modelName,
  }).from(schema.siteDisabledModels).all();

  const index: SiteDisabledModelsIndex = new Map();
  for (const row of rows) {
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
    const target = accountId != null && Number.isFinite(accountId) && accountId > 0
      ? (entry.byAccount.get(accountId) ?? (entry.byAccount.set(accountId, makeEntry()), entry.byAccount.get(accountId)!))
      : entry;

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
 */
export async function clearAutoDisabledModels(input: {
  siteId: number;
  accountId?: number | null;
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
 * Whether a model is disabled for a site and optionally for a specific key.
 *
 * Per-key rows (account_id set) are matched when `accountId` is provided.
 * Legacy site-wide rows (account_id NULL), if any exist after the v1.8 boot
 * migration, match every key of the site for backward compatibility.
 *
 * Callers should always pass `accountId` when querying from a per-key context.
 * Without it, only legacy site-wide rows are checked (empty after migration).
 */
export function isModelDisabledForSite(
  index: SiteDisabledModelsIndex | null | undefined,
  siteId: number | null | undefined,
  modelName: string | null | undefined,
  accountId?: number | null,
): boolean {
  if (!index || siteId == null || !Number.isFinite(siteId) || siteId <= 0) return false;
  const entry = index.get(siteId);
  if (!entry) return false;

  // Legacy site-wide rows (NULL account_id) — empty after migration.
  if (matches(entry, modelName || '')) return true;

  // Per-key rows apply only when evaluating that key.
  if (accountId != null && Number.isFinite(accountId) && accountId > 0) {
    const perAccount = entry.byAccount.get(accountId);
    if (perAccount && matches(perAccount, modelName || '')) return true;
  }
  return false;
}