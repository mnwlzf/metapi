import { and, eq, inArray } from 'drizzle-orm';
import { db, schema } from '../db/index.js';
import { getNewModelPolicyFromExtraConfig, requiresManagedAccountTokens } from './accountExtraConfig.js';
import { setAccountNewModelPolicy } from './accountNewModelPolicy.js';
import { rebuildTokenRoutesFromAvailability } from './modelService.js';
import { invalidateTokenRouterCache } from './tokenRouterRouteCache.js';
import { invalidateSiteProxyCache } from './siteProxy.js';
import { clearModelsMarketplaceCache } from './modelsMarketplaceCache.js';
import { matchesDisabledModelName } from './siteDisabledModels.js';

export class AccountModelScopeError extends Error {
  constructor(message: string, public statusCode = 404) { super(message); }
}

async function resolveScope(accountId: number, tokenId: number) {
  const row = await db.select().from(schema.accounts)
    .innerJoin(schema.sites, eq(schema.accounts.siteId, schema.sites.id))
    .where(eq(schema.accounts.id, accountId)).get();
  if (!row) throw new AccountModelScopeError('账号不存在');
  const tokens = await db.select({
    id: schema.accountTokens.id, name: schema.accountTokens.name,
    tokenGroup: schema.accountTokens.tokenGroup,
  }).from(schema.accountTokens).where(eq(schema.accountTokens.accountId, accountId)).all() as Array<{ id: number; name: string | null; tokenGroup: string | null }>;
  if (tokenId > 0 && !tokens.some((token) => token.id === tokenId)) {
    throw new AccountModelScopeError('该 key 不属于此账号');
  }
  return { ...row, tokens: requiresManagedAccountTokens(row.accounts) ? tokens : [] };
}

function scopeWhere(siteId: number, accountId: number, tokenId: number) {
  return and(eq(schema.siteDisabledModels.siteId, siteId),
    eq(schema.siteDisabledModels.accountId, accountId), eq(schema.siteDisabledModels.tokenId, tokenId));
}

export async function getAccountModelList(accountId: number, tokenId = 0) {
  const { accounts: account, sites: site, tokens } = await resolveScope(accountId, tokenId);
  const modelRows: Array<{ modelName: string; available: boolean; latencyMs: number | null; isManual?: boolean }> = tokenId > 0
    ? await db.select({ modelName: schema.tokenModelAvailability.modelName,
      available: schema.tokenModelAvailability.available, latencyMs: schema.tokenModelAvailability.latencyMs })
      .from(schema.tokenModelAvailability).where(eq(schema.tokenModelAvailability.tokenId, tokenId)).all()
    : await db.select({ modelName: schema.modelAvailability.modelName,
      available: schema.modelAvailability.available, latencyMs: schema.modelAvailability.latencyMs,
      isManual: schema.modelAvailability.isManual })
      .from(schema.modelAvailability).where(eq(schema.modelAvailability.accountId, accountId)).all();
  if (tokenId === 0 && tokens.length > 0) {
    const tokenRows = await db.select({ modelName: schema.tokenModelAvailability.modelName,
      available: schema.tokenModelAvailability.available, latencyMs: schema.tokenModelAvailability.latencyMs })
      .from(schema.tokenModelAvailability).innerJoin(schema.accountTokens,
        eq(schema.tokenModelAvailability.tokenId, schema.accountTokens.id))
      .where(eq(schema.accountTokens.accountId, accountId)).all();
    modelRows.push(...tokenRows);
  }
  const disabledRows = await db.select().from(schema.siteDisabledModels)
    .where(and(eq(schema.siteDisabledModels.siteId, site.id), eq(schema.siteDisabledModels.accountId, accountId),
      inArray(schema.siteDisabledModels.tokenId, tokenId > 0 ? [0, tokenId] : [0]))).all();
  const rows = new Map<string, { name: string; latencyMs: number | null; isManual: boolean }>();
  for (const row of modelRows) {
    const existing = rows.get(row.modelName);
    if (!existing || (row.available && existing.latencyMs == null)) {
      rows.set(row.modelName, { name: row.modelName, latencyMs: row.latencyMs,
        isManual: !!row.isManual || !!existing?.isManual });
    }
  }
  for (const row of disabledRows) {
    if (!rows.has(row.modelName)) rows.set(row.modelName, { name: row.modelName, latencyMs: null, isManual: false });
  }
  const models = [...rows.values()].filter((row) => (
    modelRows.some((model) => model.modelName === row.name && model.available)
    || disabledRows.some((disabled) => disabled.modelName === row.name)
  )).map((row) => {
    const matches = disabledRows.filter((disabled) => (
      matchesDisabledModelName(disabled.modelName, row.name)
    ));
    const sticky = matches.find((disabled) => disabled.source === 'manual' || disabled.source === 'policy');
    return { ...row, disabled: matches.length > 0, manualDisabled: !!sticky,
      disabledSource: sticky?.source ?? (matches.length ? 'probe' : null),
      inherited: tokenId > 0 && matches.some((disabled) => disabled.tokenId === 0 && (disabled.source === 'manual' || disabled.source === 'policy')) };
  }).sort((a, b) => a.name.localeCompare(b.name));
  return { siteId: site.id, siteName: site.name, tokenId, tokens, models,
    totalCount: models.length, disabledCount: models.filter((row) => row.disabled).length,
    newModelPolicy: getNewModelPolicyFromExtraConfig(account.extraConfig) };
}

async function convergeModelDisables() {
  invalidateSiteProxyCache();
  invalidateTokenRouterCache();
  clearModelsMarketplaceCache();
  try {
    await rebuildTokenRoutesFromAvailability();
    return true;
  } catch (error) {
    console.warn('[models] route rebuild after model disable failed', error);
    return false;
  } finally {
    invalidateTokenRouterCache();
    clearModelsMarketplaceCache();
  }
}

export async function replaceAccountManualDisabledModels(input: {
  accountId: number; tokenId: number; models: string[]; newModelPolicy?: 'auto' | 'disable';
}) {
  const { accounts: account } = await resolveScope(input.accountId, input.tokenId);
  const models = [...new Set(input.models.map((name) => name.trim()).filter(Boolean))];
  await db.transaction(async (tx) => {
    const existing = await tx.select().from(schema.siteDisabledModels)
      .where(scopeWhere(account.siteId, account.id, input.tokenId)).all();
    // Preserve probe verdicts that the operator did not explicitly ban. Merely
    // opening and saving this editor must never convert them to sticky intent.
    const remove = existing.filter((row) => row.source === 'manual' || row.source === 'policy'
      || models.some((name) => matchesDisabledModelName(name, row.modelName)));
    if (remove.length) await tx.delete(schema.siteDisabledModels).where(inArray(schema.siteDisabledModels.id, remove.map((row) => row.id))).run();
    if (models.length) await tx.insert(schema.siteDisabledModels).values(models.map((modelName) => ({
      siteId: account.siteId, accountId: account.id, tokenId: input.tokenId, modelName, source: 'manual',
    }))).run();
  });
  if (input.newModelPolicy) await setAccountNewModelPolicy(account.id, input.newModelPolicy);
  const rebuilt = await convergeModelDisables();
  return { accountId: account.id, siteId: account.siteId, tokenId: input.tokenId, models, rebuilt };
}

export async function setAccountModelDisabled(input: {
  accountId: number; tokenId: number; modelName: string; disabled: boolean;
}) {
  const { accounts: account } = await resolveScope(input.accountId, input.tokenId);
  await db.transaction(async (tx) => {
    const existing = await tx.select().from(schema.siteDisabledModels)
      .where(scopeWhere(account.siteId, account.id, input.tokenId)).all();
    const matches = existing.filter((row) => matchesDisabledModelName(row.modelName, input.modelName));
    if (matches.length) await tx.delete(schema.siteDisabledModels).where(inArray(schema.siteDisabledModels.id, matches.map((row) => row.id))).run();
    if (input.disabled) await tx.insert(schema.siteDisabledModels).values({
      siteId: account.siteId, accountId: account.id, tokenId: input.tokenId,
      modelName: input.modelName.trim(), source: 'manual',
    }).run();
  });
  return { success: true, rebuilt: await convergeModelDisables() };
}
