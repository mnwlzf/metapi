import { and, desc, eq, gte, inArray, sql } from 'drizzle-orm';
import { db, schema } from '../db/index.js';
import { upsertSetting } from '../db/upsertSetting.js';
import { matchesDisabledModelName } from './siteDisabledModels.js';
import { classifyProbeModel, isPendingFirstVerification } from './modelProbeQueuePolicy.js';
import { getFirstVerificationBudget, getFirstVerificationSettings } from './modelFirstVerificationService.js';
import { requiresManagedAccountTokens } from './accountExtraConfig.js';
import { ACCOUNT_TOKEN_VALUE_STATUS_READY } from './accountTokenService.js';

export const MODEL_PROBE_PLAN_SETTING_KEY = 'model_probe_plan_overrides';
export const MODEL_PROBE_INTERVALS_HOURS = [1, 6, 12, 24, 72] as const;
export type ModelProbeIntervalHours = typeof MODEL_PROBE_INTERVALS_HOURS[number];
export { classifyProbeModel, type ProbeModelType } from './modelProbeQueuePolicy.js';

export function getDefaultProbeIntervalHours(modelName: string, recentCalls: number): ModelProbeIntervalHours {
  const type = classifyProbeModel(modelName);
  if (type === 'image' || type === 'video' || type === 'other') return 72;
  if (recentCalls >= 50) return 1;
  if (recentCalls >= 5) return 6;
  return 24;
}

let overrideCache: Record<string, ModelProbeIntervalHours> = {};
let overridesLoaded = false;

export async function getModelProbeIntervalOverrides(): Promise<Record<string, ModelProbeIntervalHours>> {
  if (overridesLoaded) return { ...overrideCache };
  const row = await db.select({ value: schema.settings.value })
    .from(schema.settings).where(eq(schema.settings.key, MODEL_PROBE_PLAN_SETTING_KEY)).get();
  try {
    const parsed: unknown = JSON.parse(String(row?.value || '{}'));
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      for (const [model, interval] of Object.entries(parsed)) {
        if ((MODEL_PROBE_INTERVALS_HOURS as readonly unknown[]).includes(interval)) {
          overrideCache[model.toLowerCase()] = interval as ModelProbeIntervalHours;
        }
      }
    }
  } catch { /* malformed legacy setting falls back to automatic intervals */ }
  overridesLoaded = true;
  return { ...overrideCache };
}

export async function saveModelProbeIntervalOverride(modelName: string, intervalHours: number | null): Promise<void> {
  const model = String(modelName || '').trim();
  if (!model) throw new Error('Model name is required');
  if (intervalHours !== null && !(MODEL_PROBE_INTERVALS_HOURS as readonly number[]).includes(intervalHours)) {
    throw new Error('Invalid probe interval');
  }
  const overrides = await getModelProbeIntervalOverrides();
  if (intervalHours === null) delete overrides[model.toLowerCase()];
  else overrides[model.toLowerCase()] = intervalHours as ModelProbeIntervalHours;
  overrideCache = overrides;
  overridesLoaded = true;
  await upsertSetting(MODEL_PROBE_PLAN_SETTING_KEY, overrides);
}

export async function getModelProbePlan() {
  const settings = await getFirstVerificationSettings();
  const firstVerification = { settings, budget: await getFirstVerificationBudget(settings) };
  const accounts = await db.select().from(schema.accounts).all();
  const directAccountIds = new Set(accounts.filter((account) => !requiresManagedAccountTokens(account)).map((account) => account.id));
  const names = await db.select({ modelName: schema.tokenModelAvailability.modelName })
    .from(schema.tokenModelAvailability)
    .innerJoin(schema.accountTokens, eq(schema.tokenModelAvailability.tokenId, schema.accountTokens.id))
    .innerJoin(schema.accounts, eq(schema.accountTokens.accountId, schema.accounts.id))
    .innerJoin(schema.sites, eq(schema.accounts.siteId, schema.sites.id))
    .where(and(eq(schema.accountTokens.enabled, true), eq(schema.accountTokens.valueStatus, ACCOUNT_TOKEN_VALUE_STATUS_READY), eq(schema.accounts.status, 'active'), eq(schema.sites.status, 'active')))
    .groupBy(schema.tokenModelAvailability.modelName).all();
  const accountNames = await db.select({ modelName: schema.modelAvailability.modelName })
    .from(schema.modelAvailability)
    .innerJoin(schema.accounts, eq(schema.modelAvailability.accountId, schema.accounts.id))
    .innerJoin(schema.sites, eq(schema.accounts.siteId, schema.sites.id))
    .where(and(eq(schema.accounts.status, 'active'), eq(schema.sites.status, 'active')))
    .groupBy(schema.modelAvailability.modelName).all();
  const models = Array.from(new Set([...names, ...accountNames]
    .map((row) => String(row.modelName || '').trim()).filter(Boolean)));
  if (models.length === 0) return { models: [], intervals: [...MODEL_PROBE_INTERVALS_HOURS], firstVerification };
  const cutoff = new Date(Date.now() - 7 * 24 * 60 * 60_000).toISOString();
  const usageRows = await db.select({
    requested: schema.proxyLogs.modelRequested,
    actual: schema.proxyLogs.modelActual,
    calls: sql<number>`count(*)`,
  }).from(schema.proxyLogs).where(gte(schema.proxyLogs.createdAt, cutoff))
    .groupBy(schema.proxyLogs.modelRequested, schema.proxyLogs.modelActual).all();
  const usage = new Map<string, number>();
  for (const row of usageRows) {
    const calls = Number(row.calls || 0);
    for (const key of new Set([row.requested, row.actual].map((value) => String(value || '').trim().toLowerCase()).filter(Boolean))) {
      usage.set(key, (usage.get(key) || 0) + calls);
    }
  }
  const overrides = await getModelProbeIntervalOverrides();
  const keyRows = (await db.select({
    tokenId: schema.tokenModelAvailability.tokenId,
    modelName: schema.tokenModelAvailability.modelName,
    available: schema.tokenModelAvailability.available,
    connectivity: schema.tokenModelAvailability.connectivity,
    latencyMs: schema.tokenModelAvailability.latencyMs,
    checkedAt: schema.tokenModelAvailability.checkedAt,
    keyName: schema.accountTokens.name,
    keyGroup: schema.accountTokens.tokenGroup,
    accountId: schema.accounts.id,
    accountName: schema.accounts.username,
    siteId: schema.sites.id,
    siteName: schema.sites.name,
    platform: schema.sites.platform,
  }).from(schema.tokenModelAvailability)
    .innerJoin(schema.accountTokens, eq(schema.tokenModelAvailability.tokenId, schema.accountTokens.id))
    .innerJoin(schema.accounts, eq(schema.accountTokens.accountId, schema.accounts.id))
    .innerJoin(schema.sites, eq(schema.accounts.siteId, schema.sites.id))
    .where(and(
      inArray(schema.tokenModelAvailability.modelName, models),
      eq(schema.accountTokens.enabled, true),
      eq(schema.accountTokens.valueStatus, ACCOUNT_TOKEN_VALUE_STATUS_READY),
      eq(schema.accounts.status, 'active'),
      eq(schema.sites.status, 'active'),
    )).all()).filter((row) => !directAccountIds.has(row.accountId));
  const tokenMetaRows = (await db.select({
    tokenId: schema.accountTokens.id,
    keyName: schema.accountTokens.name,
    keyGroup: schema.accountTokens.tokenGroup,
    accountId: schema.accounts.id,
    accountName: schema.accounts.username,
    siteId: schema.sites.id,
    siteName: schema.sites.name,
    platform: schema.sites.platform,
  }).from(schema.accountTokens)
    .innerJoin(schema.accounts, eq(schema.accountTokens.accountId, schema.accounts.id))
    .innerJoin(schema.sites, eq(schema.accounts.siteId, schema.sites.id))
    .where(and(
      eq(schema.accountTokens.enabled, true),
      eq(schema.accountTokens.valueStatus, ACCOUNT_TOKEN_VALUE_STATUS_READY),
      eq(schema.accounts.status, 'active'),
      eq(schema.sites.status, 'active'),
    )).all()).filter((row) => !directAccountIds.has(row.accountId));
  const managedTokenOwners = await db.select({ accountId: schema.accountTokens.accountId })
    .from(schema.accountTokens)
    .innerJoin(schema.accounts, eq(schema.accountTokens.accountId, schema.accounts.id))
    .innerJoin(schema.sites, eq(schema.accounts.siteId, schema.sites.id))
    .where(and(
      eq(schema.accounts.status, 'active'),
      eq(schema.sites.status, 'active'),
    )).groupBy(schema.accountTokens.accountId).all();
  const accountsWithManagedTokens = new Set(managedTokenOwners.map((row) => row.accountId));
  const accountOnlyRows = (await db.select({
      accountId: schema.modelAvailability.accountId,
      modelName: schema.modelAvailability.modelName,
      available: schema.modelAvailability.available,
      connectivity: schema.modelAvailability.connectivity,
      latencyMs: schema.modelAvailability.latencyMs,
      checkedAt: schema.modelAvailability.checkedAt,
      accountName: schema.accounts.username,
      siteId: schema.sites.id,
      siteName: schema.sites.name,
      platform: schema.sites.platform,
    }).from(schema.modelAvailability)
      .innerJoin(schema.accounts, eq(schema.modelAvailability.accountId, schema.accounts.id))
      .innerJoin(schema.sites, eq(schema.accounts.siteId, schema.sites.id))
      .where(and(
        inArray(schema.modelAvailability.modelName, models),
        eq(schema.accounts.status, 'active'),
        eq(schema.sites.status, 'active'),
      )).all()
  ).filter((row) => directAccountIds.has(row.accountId) || !accountsWithManagedTokens.has(row.accountId));
  const activeAccountIds = Array.from(new Set([
    ...tokenMetaRows.map((row) => row.accountId),
    ...accountOnlyRows.map((row) => row.accountId),
  ]));
  const keyUsageRows = activeAccountIds.length === 0 ? [] : await db.select({
    accountId: schema.proxyLogs.accountId,
    tokenId: schema.proxyLogs.tokenId,
    requested: schema.proxyLogs.modelRequested,
    actual: schema.proxyLogs.modelActual,
    calls: sql<number>`count(*)`,
  }).from(schema.proxyLogs).where(and(
    inArray(schema.proxyLogs.accountId, activeAccountIds),
    gte(schema.proxyLogs.createdAt, cutoff),
  )).groupBy(
    schema.proxyLogs.accountId,
    schema.proxyLogs.tokenId,
    schema.proxyLogs.modelRequested,
    schema.proxyLogs.modelActual,
  ).all();
  const keyUsage = new Map<string, number>();
  const accountUsage = new Map<string, number>();
  for (const row of keyUsageRows) {
    if (row.accountId == null) continue;
    const calls = Number(row.calls || 0);
    for (const key of new Set([row.requested, row.actual].map((value) => String(value || '').trim().toLowerCase()).filter(Boolean))) {
      if (row.tokenId == null) {
        const accountKey = `${row.accountId}:${key}`;
        accountUsage.set(accountKey, (accountUsage.get(accountKey) || 0) + calls);
        continue;
      }
      const usageKey = `${row.accountId}:${row.tokenId}:${key}`;
      keyUsage.set(usageKey, (keyUsage.get(usageKey) || 0) + calls);
    }
  }
  const latestProbeRows = await db.select({
    id: sql<number>`max(${schema.probeLogs.id})`,
    tokenId: schema.probeLogs.tokenId,
    accountId: schema.probeLogs.accountId,
    modelName: schema.probeLogs.modelName,
  }).from(schema.probeLogs).where(inArray(schema.probeLogs.modelName, models))
    .groupBy(schema.probeLogs.tokenId, schema.probeLogs.accountId, schema.probeLogs.modelName).all();
  const latestProbeIds = latestProbeRows.map((row) => Number(row.id)).filter((id) => id > 0);
  const latestProbes = latestProbeIds.length === 0 ? [] : await db.select({
    id: schema.probeLogs.id,
    tokenId: schema.probeLogs.tokenId,
    accountId: schema.probeLogs.accountId,
    modelName: schema.probeLogs.modelName,
    status: schema.probeLogs.status,
    latencyMs: schema.probeLogs.latencyMs,
    tokensUsed: schema.probeLogs.tokensUsed,
    estimatedCost: schema.probeLogs.estimatedCost,
    errorMessage: schema.probeLogs.errorMessage,
    questionCategory: schema.probeLogs.questionCategory,
    createdAt: schema.probeLogs.createdAt,
  }).from(schema.probeLogs).where(inArray(schema.probeLogs.id, latestProbeIds))
    .orderBy(desc(schema.probeLogs.id)).all();
  const latestProbeByCell = new Map(latestProbes.map((probe) => [
    probe.tokenId != null
      ? `token:${probe.tokenId}:${probe.modelName.toLowerCase()}`
      : `account:${probe.accountId}:${probe.modelName.toLowerCase()}`,
    probe,
  ]));
  const disabledRows = await db.select({
    siteId: schema.siteDisabledModels.siteId,
    accountId: schema.siteDisabledModels.accountId,
    tokenId: schema.siteDisabledModels.tokenId,
    modelName: schema.siteDisabledModels.modelName,
    source: schema.siteDisabledModels.source,
  }).from(schema.siteDisabledModels).all();
  const tokenMetaById = new Map<number, (typeof tokenMetaRows)[number]>();
  for (const row of tokenMetaRows) tokenMetaById.set(row.tokenId, row);
  const candidateRows = [...keyRows];
  const candidateCells = new Set(candidateRows.map((row) => `${row.tokenId}:${String(row.modelName).toLowerCase()}`));
  const addCandidate = (tokenId: number, modelName: string) => {
    const meta = tokenMetaById.get(tokenId);
    const displayModelName = models.find((known) => matchesDisabledModelName(modelName, known));
    const cell = `${tokenId}:${(displayModelName || modelName).toLowerCase()}`;
    if (!meta || candidateCells.has(cell) || !displayModelName) return;
    candidateCells.add(cell);
    candidateRows.push({
      ...meta,
      modelName: displayModelName,
      available: null,
      connectivity: null,
      latencyMs: null,
      checkedAt: null,
    });
  };
  for (const row of disabledRows) {
    // A probe verdict is historical state, not evidence that this Key still
    // advertises the model. Current probeable/available combinations already
    // exist in tokenModelAvailability (including unavailable rows). Only sticky
    // operator/policy intent may add a display candidate when discovery has no
    // row; otherwise an old account-wide probe disable is fanned out to every
    // Key and can keep a manually disabled model in the probe plan forever.
    if (row.source !== 'manual' && row.source !== 'policy') continue;
    if (row.tokenId && row.tokenId > 0) {
      const tokenMeta = tokenMetaById.get(row.tokenId);
      if (!tokenMeta || tokenMeta.siteId !== row.siteId || (row.accountId != null && tokenMeta.accountId !== row.accountId)) continue;
      addCandidate(row.tokenId, row.modelName);
      continue;
    }
    for (const meta of tokenMetaRows) {
      if (row.accountId != null && row.accountId !== meta.accountId) continue;
      if (row.siteId !== meta.siteId) continue;
      addCandidate(meta.tokenId, row.modelName);
    }
  }
  const getMatchingDisables = (row: typeof candidateRows[number], modelName: string) => disabledRows.filter((item) => (
    (item.siteId === row.siteId)
    && (item.accountId == null || item.accountId === row.accountId)
    && (item.tokenId === 0 || item.tokenId === row.tokenId)
    && matchesDisabledModelName(String(item.modelName || ''), modelName)
  ));
  const attachKeyDetails = (row: typeof candidateRows[number]) => {
    const modelName = String(row.modelName || '');
    const matchingDisables = getMatchingDisables(row, modelName);
    const disable = matchingDisables.find((item) => item.source === 'manual')
      ?? matchingDisables.find((item) => item.source === 'policy')
      ?? matchingDisables[0];
    const probe = latestProbeByCell.get(`token:${row.tokenId}:${modelName.toLowerCase()}`) ?? null;
    const routeState = disable?.source === 'policy'
      ? 'policy-disabled'
      : disable?.source === 'manual'
        ? 'manual-disabled'
      : disable ? 'probe-disabled'
        : isPendingFirstVerification({ available: row.available, connectivity: row.connectivity, hasProbe: !!probe })
          ? 'pending-verification'
        : row.available === true ? 'available'
          : row.available === false ? 'unavailable' : 'unknown';
    return {
      keyId: row.tokenId,
      keyName: row.keyName,
      keyGroup: row.keyGroup,
      accountId: row.accountId,
      accountName: row.accountName,
      siteId: row.siteId,
      siteName: row.siteName,
      platform: row.platform,
      available: row.available,
      connectivity: row.connectivity,
      availabilityLatencyMs: row.latencyMs,
      availabilityCheckedAt: row.checkedAt,
      routeState,
      lastProbe: probe,
      recentCalls: keyUsage.get(`${row.accountId}:${row.tokenId}:${modelName.toLowerCase()}`) || 0,
    };
  };
  const detailsByModel = new Map<string, ReturnType<typeof attachKeyDetails>[]>();
  const manualExcludedByModel = new Map<string, ReturnType<typeof attachKeyDetails>[]>();
  const policyExcludedByModel = new Map<string, ReturnType<typeof attachKeyDetails>[]>();
  for (const row of candidateRows) {
    const key = String(row.modelName || '').toLowerCase();
    const detail = attachKeyDetails(row);
    const target = detail.routeState === 'manual-disabled'
      ? manualExcludedByModel
      : detail.routeState === 'policy-disabled'
        ? policyExcludedByModel
        : detailsByModel;
    const rows = target.get(key) ?? [];
    rows.push(detail);
    target.set(key, rows);
  }
  for (const row of accountOnlyRows) {
    const key = String(row.modelName || '').toLowerCase();
    const matchingAccountDisables = disabledRows.filter((item) => (
      item.siteId === row.siteId
      && (item.accountId == null || item.accountId === row.accountId)
      && item.tokenId === 0
      && matchesDisabledModelName(String(item.modelName || ''), String(row.modelName || ''))
    ));
    const accountDisable = matchingAccountDisables.find((item) => item.source === 'manual')
      ?? matchingAccountDisables.find((item) => item.source === 'policy')
      ?? matchingAccountDisables[0];
    const accountProbe = latestProbeByCell.get(`account:${row.accountId}:${String(row.modelName || '').toLowerCase()}`) ?? null;
    const detail = {
      keyId: null,
      keyName: '账号级凭据',
      keyGroup: null,
      accountId: row.accountId,
      accountName: row.accountName,
      siteId: row.siteId,
      siteName: row.siteName,
      platform: row.platform,
      available: row.available,
      connectivity: row.connectivity,
      availabilityLatencyMs: row.latencyMs,
      availabilityCheckedAt: row.checkedAt,
      routeState: accountDisable?.source === 'manual'
        ? 'manual-disabled' as const
        : accountDisable?.source === 'policy'
          ? 'policy-disabled' as const
          : accountDisable ? 'probe-disabled' as const
          : isPendingFirstVerification({ available: row.available, connectivity: row.connectivity, hasProbe: !!accountProbe })
            ? 'pending-verification' as const
          : row.available === true ? 'available' as const : row.available === false ? 'unavailable' as const : 'unknown' as const,
      lastProbe: accountProbe,
      recentCalls: accountUsage.get(`${row.accountId}:${String(row.modelName || '').toLowerCase()}`) || 0,
    };
    const target = detail.routeState === 'manual-disabled'
      ? manualExcludedByModel
      : detail.routeState === 'policy-disabled'
        ? policyExcludedByModel
        : detailsByModel;
    const rows = target.get(key) ?? [];
    rows.push(detail);
    target.set(key, rows);
  }
  return {
    firstVerification,
    intervals: [...MODEL_PROBE_INTERVALS_HOURS],
    models: models.map((modelName) => {
      const recentCalls = usage.get(modelName.toLowerCase()) || 0;
      const override = overrides[modelName.toLowerCase()] ?? null;
      const keyResults = detailsByModel.get(modelName.toLowerCase()) ?? [];
      const manualExcludedKeys = manualExcludedByModel.get(modelName.toLowerCase()) ?? [];
      const policyExcludedKeys = policyExcludedByModel.get(modelName.toLowerCase()) ?? [];
      const tab = keyResults.length > 0 ? 'probeable'
        : manualExcludedKeys.length > 0 && policyExcludedKeys.length === 0 ? 'manual-disabled'
          : policyExcludedKeys.length > 0 ? 'policy-disabled'
            : 'probeable';
      return {
        modelName,
        type: classifyProbeModel(modelName),
        tab,
        recentCalls,
        intervalHours: override ?? getDefaultProbeIntervalHours(modelName, recentCalls),
        automaticIntervalHours: getDefaultProbeIntervalHours(modelName, recentCalls),
        overridden: override !== null,
        pendingVerificationCount: [...keyResults, ...manualExcludedKeys, ...policyExcludedKeys]
          .filter((key) => key.routeState === 'pending-verification').length,
        keyResults: keyResults.sort((a, b) => (
          String(a.siteName || '').localeCompare(String(b.siteName || ''))
          || String(a.accountName || '').localeCompare(String(b.accountName || ''))
          || String(a.keyName || '').localeCompare(String(b.keyName || ''))
        )),
        manualExcludedKeys: manualExcludedKeys.sort((a, b) => (
          String(a.siteName || '').localeCompare(String(b.siteName || ''))
          || String(a.accountName || '').localeCompare(String(b.accountName || ''))
          || String(a.keyName || '').localeCompare(String(b.keyName || ''))
        )),
        policyExcludedKeys: policyExcludedKeys.sort((a, b) => (
          String(a.siteName || '').localeCompare(String(b.siteName || ''))
          || String(a.accountName || '').localeCompare(String(b.accountName || ''))
          || String(a.keyName || '').localeCompare(String(b.keyName || ''))
        )),
      };
    }).filter((model) => model.keyResults.length + model.manualExcludedKeys.length + model.policyExcludedKeys.length > 0)
      .sort((a, b) => a.type.localeCompare(b.type) || a.modelName.localeCompare(b.modelName)),
  };
}
