import { and, eq, inArray, sql } from 'drizzle-orm';
import { db, schema } from '../db/index.js';
import { applyNewModelPolicyForAccount } from './accountNewModelPolicy.js';
import { getInsertedRowId } from '../db/insertHelpers.js';
import { getAdapter } from './platforms/index.js';
import {
  ACCOUNT_TOKEN_VALUE_STATUS_READY,
  ensureDefaultTokenForAccount,
  getPreferredAccountToken,
  isMaskedTokenValue,
  isUsableAccountToken,
} from './accountTokenService.js';
import {resolveProxyUrlFromExtraConfig, requiresManagedAccountTokens, resolvePlatformUserId, supportsDirectAccountRoutingConnection} from './accountExtraConfig.js';
import { invalidateTokenRouterCache } from './tokenRouter.js';
import { resolveModelAvailabilityProbeTimeoutMs } from '../config.js';
import { setAccountRuntimeHealth } from './accountHealthService.js';
import { clearAllRouteDecisionSnapshots } from './routeDecisionSnapshotStore.js';
import { rebuildAllPatternRouteChannels } from './patternRouteChannelSyncService.js';
import { withAccountProxyOverride } from './siteProxy.js';
import {
  recordSiteApiEndpointSuccessByBaseUrl,
  requireSiteApiBaseUrl,
} from './siteApiEndpointService.js';
import { probeRuntimeModel, type RuntimeModelProbeStatus } from './runtimeModelProbe.js';
import { isGroupScopedModelRejection } from './probeFailureClassification.js';
import { canonicalizeModelName } from '../shared/modelCanonicalization.js';
import { canonicalRouteAlias, collectGroupNameOwners, resolveExposedRouteName } from '../shared/routeGroupName.js';
import { isCodexGatedPlatform } from '../shared/codexGatedPlatforms.js';
import {
  clearAutoDisabledModels,
  isModelDisabledForSite,
  loadSiteDisabledModelsIndex,
} from './siteDisabledModels.js';

const API_TOKEN_DISCOVERY_TIMEOUT_MS = 8_000;
const MODEL_DISCOVERY_TIMEOUT_MS = 12_000;
const MODEL_REFRESH_BATCH_SIZE = 3;
// 仅导入型 OAuth 平台（9router 同款）：无平台 adapter，模型发现走 provider registry
let inFlightRefreshModelsAndRebuildRoutes: Promise<{
  refresh: ModelRefreshResult[];
  rebuild: Awaited<ReturnType<typeof rebuildTokenRoutesFromAvailability>>;
}> | null = null;
let inFlightRefreshModelsAndRebuildRoutesHeartbeatMs = 0;
// A refresh pass can wedge on an unbounded upstream call; the single-flight
// guard must not hand that stale pass to every later caller forever. After
// this much time WITHOUT PROGRESS, later callers start a fresh pass while the
// stale one drains in the background (2026-09-12: a wedged pass stayed pending
// 15h and hung both the scheduler and every request that awaited the refresh).
//
// Progress is tracked by heartbeat (each finished account batch bumps it), not
// by the pass start time: a healthy multi-account pass can legitimately run
// longer than 10 minutes (N batches x 8-12s discovery timeouts + full route
// rebuild). Age-based staleness would overlap a slow-but-advancing pass with a
// second one, double-writing route/channel tables; heartbeat-based staleness
// only fires when the pass is genuinely wedged.
const REFRESH_INFLIGHT_MAX_IDLE_MS = 5 * 60_000;

type ModelRefreshErrorCode = 'timeout' | 'unauthorized' | 'empty_models' | 'unknown';
type ModelRefreshSkipCode = 'site_disabled' | 'adapter_or_status';

export type ModelRefreshAccountNotFoundResult = {
  accountId: number;
  refreshed: false;
  status: 'failed';
  errorCode: 'account_not_found';
  errorMessage: '账号不存在';
  modelCount: 0;
  modelsPreview: string[];
  reason: 'account_not_found';
};

export type ModelRefreshSkippedResult = {
  accountId: number;
  refreshed: false;
  status: 'skipped';
  errorCode: ModelRefreshSkipCode;
  errorMessage: string;
  modelCount: 0;
  modelsPreview: string[];
  reason: ModelRefreshSkipCode;
};

export type ModelRefreshFailureResult = {
  accountId: number;
  refreshed: true;
  status: 'failed';
  errorCode: ModelRefreshErrorCode;
  errorMessage: string;
  modelCount: 0;
  modelsPreview: string[];
  tokenScanned: number;
  discoveredByCredential: boolean;
  discoveredApiToken: boolean;
};

export type ModelRefreshSuccessResult = {
  accountId: number;
  refreshed: true;
  status: 'success';
  errorCode: null;
  errorMessage: '';
  modelCount: number;
  modelsPreview: string[];
  tokenScanned: number;
  discoveredByCredential: boolean;
  discoveredApiToken: boolean;
  postProbeResult?: {
    scope: 'single' | 'all';
    probed: number;
    unsupported: number;
    inconclusive: number;
    details: Array<{
      modelName: string;
      status: RuntimeModelProbeStatus;
      latencyMs: number | null;
    }>;
  };
};

export type ModelRefreshResult =
  | ModelRefreshAccountNotFoundResult
  | ModelRefreshSkippedResult
  | ModelRefreshFailureResult
  | ModelRefreshSuccessResult;

function looksLikeHtmlJsonParseError(message: string): boolean {
  const lowered = String(message || '').trim().toLowerCase();
  return (
    lowered.includes('unexpected token')
    && lowered.includes('not valid json')
    && (lowered.includes('<html') || lowered.includes('<script'))
  );
}

function looksLikeShieldChallenge(message: string): boolean {
  const lowered = String(message || '').trim().toLowerCase();
  return (
    lowered.includes('acw_sc__v2')
    || lowered.includes('var arg1')
    || lowered.includes('captcha')
    || lowered.includes('challenge')
    || lowered.includes('cloudflare tunnel error')
  );
}

function classifyModelDiscoveryError(message: string): ModelRefreshErrorCode {
  const lowered = message.toLowerCase();
  if (lowered.includes('timeout') || lowered.includes('timed out') || lowered.includes('请求超时')) return 'timeout';
  if (lowered.includes('http 401') || lowered.includes('http 403')
    || lowered.includes('unauthorized') || lowered.includes('invalid')
    || lowered.includes('无权') || lowered.includes('未提供令牌')) return 'unauthorized';
  return 'unknown';
}

function modelDiscoveryFailureHealthState(code: ModelRefreshErrorCode): 'unhealthy' | 'degraded' {
  // Only confirmed credential/permission failures make the connection unhealthy.
  // Timeouts, 429/5xx, empty lists and shield/network failures are often transient.
  return code === 'unauthorized' ? 'unhealthy' : 'degraded';
}

function buildModelFailureMessage(code: ModelRefreshErrorCode, fallback?: string, platform?: string | null) {
  const raw = String(fallback || '').trim();
  if (looksLikeHtmlJsonParseError(raw) || looksLikeShieldChallenge(raw)) {
    const normalizedPlatform = String(platform || '').trim().toLowerCase();
    if (normalizedPlatform === 'new-api') {
      return '模型获取失败：站点返回了防护页面，请在目标站点创建 API Key 后再同步模型';
    }
    return '模型获取失败：站点返回了网页而不是 JSON 响应';
  }
  if (code === 'timeout') return '模型获取失败（请求超时）';
  if (code === 'unauthorized') return '模型获取失败，API Key 已无效';
  if (code === 'empty_models') return '模型获取失败：未获取到可用模型';
  return fallback || '模型获取失败';
}

function isSiteDisabled(status?: string | null): boolean {
  return (status || 'active') === 'disabled';
}

function normalizeModels(models: string[]): string[] {
  const normalizedModels: string[] = [];
  const seen = new Set<string>();

  for (const rawModel of models) {
    if (typeof rawModel !== 'string') continue;
    const modelName = rawModel.trim();
    if (!modelName) continue;

    // Keep app/database behavior stable across SQLite/MySQL by deduping with a
    // case-insensitive key after trimming whitespace.
    const dedupeKey = modelName.toLowerCase();
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    normalizedModels.push(modelName);
  }

  return normalizedModels;
}

function isExactModelPattern(modelPattern: string): boolean {
  const normalized = modelPattern.trim();
  if (!normalized) return false;
  if (normalized.toLowerCase().startsWith('re:')) return false;
  return !/[\*\?]/.test(normalized);
}

async function withTimeout<T>(fn: () => Promise<T>, timeoutMs: number, timeoutMessage: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      fn(),
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(timeoutMessage)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function buildAccountNotFoundRefreshResult(accountId: number): ModelRefreshAccountNotFoundResult {
  return {
    accountId,
    refreshed: false,
    status: 'failed',
    errorCode: 'account_not_found',
    errorMessage: '账号不存在',
    modelCount: 0,
    modelsPreview: [],
    reason: 'account_not_found',
  };
}

function buildSkippedRefreshResult(
  accountId: number,
  code: ModelRefreshSkipCode,
  errorMessage: string,
): ModelRefreshSkippedResult {
  return {
    accountId,
    refreshed: false,
    status: 'skipped',
    errorCode: code,
    errorMessage,
    modelCount: 0,
    modelsPreview: [],
    reason: code,
  };
}

function buildFailedRefreshResult(input: {
  accountId: number;
  errorCode: ModelRefreshErrorCode;
  errorMessage: string;
  tokenScanned: number;
  discoveredByCredential: boolean;
  discoveredApiToken: boolean;
}): ModelRefreshFailureResult {
  return {
    accountId: input.accountId,
    refreshed: true,
    status: 'failed',
    errorCode: input.errorCode,
    errorMessage: input.errorMessage,
    modelCount: 0,
    modelsPreview: [],
    tokenScanned: input.tokenScanned,
    discoveredByCredential: input.discoveredByCredential,
    discoveredApiToken: input.discoveredApiToken,
  };
}

function buildSuccessfulRefreshResult(input: {
  accountId: number;
  modelCount: number;
  modelsPreview: string[];
  tokenScanned: number;
  discoveredByCredential: boolean;
  discoveredApiToken: boolean;
  postProbeResult?: ModelRefreshSuccessResult['postProbeResult'];
}): ModelRefreshSuccessResult {
  return {
    accountId: input.accountId,
    refreshed: true,
    status: 'success',
    errorCode: null,
    errorMessage: '',
    modelCount: input.modelCount,
    modelsPreview: input.modelsPreview,
    tokenScanned: input.tokenScanned,
    discoveredByCredential: input.discoveredByCredential,
    discoveredApiToken: input.discoveredApiToken,
    postProbeResult: input.postProbeResult,
  };
}

export type ProbeSiteModelsResult = {
  success: boolean;
  error?: string;
  scope: 'single' | 'all';
  /** Probe cells executed (account × key × model). */
  probed: number;
  supported: number;
  unsupported: number;
  inconclusive: number;
  /**
   * Cells the upstream refused for *this group* rather than for the model. They
   * are not a verdict: another key of the same account may serve the model, so
   * no account-wide disable is written for them.
   */
  notApplicable: number;
  /** Cells whose probe-written disable row was reverted because they answered. */
  recovered: number;
  /** What this run spent upstream (USD, this instance's price model). */
  estimatedCost: number;
  details: Array<{
    modelName: string;
    status: RuntimeModelProbeStatus | 'not-applicable';
    latencyMs: number | null;
    reason?: string;
    tokenId?: number | null;
    tokenName?: string | null;
    tokenGroup?: string | null;
  }>;
};

export type ProbeSiteModelsProgress =
  | { type: 'start'; scope: 'single' | 'all'; modelsCount: number; modelsToProbe: string[]; tokensCount: number; cellsCount: number }
  | { type: 'model'; modelName: string; status: RuntimeModelProbeStatus | 'not-applicable'; latencyMs: number | null; latencyExceeded?: true; reason?: string; tokenId?: number | null; tokenName?: string | null; tokenGroup?: string | null }
  | { type: 'action'; modelName: string; action: 'disabled' | 'enabled'; tokenId?: number | null; tokenName?: string | null; tokenGroup?: string | null };

/** One unit of probing: a model served (or not) by one upstream key's group. */
type ProbeCell = {
  account: typeof schema.accounts.$inferSelect;
  tokenId: number;
  tokenName: string;
  tokenGroup: string | null;
  tokenValue: string;
  modelName: string;
};

export type ProbeSiteModelsOptions = {
  scope?: 'single' | 'all';
  modelName?: string;
  concurrency?: number;
  latencyThresholdMs?: number;
  signal?: AbortSignal;
  /** Restrict the run to one upstream key. */
  tokenId?: number | null;
  /** Ignore the per-cell cooldown, e.g. right after editing a key. */
  force?: boolean;
  trigger?: 'manual' | 'post-refresh';
};

/**
 * Probe cadence control.
 *
 * Every probe is a real, billed upstream call: repeating the same cell too often
 * both wastes money and looks like abuse to the relay. The cooldown is per
 * (account, key, model) and is answered from `probe_logs` — the same rows the log
 * page shows — so no second source of truth has to be kept in sync.
 */
function resolveProbeCellCooldownMs(): number {
  const raw = Number.parseInt(String(process.env.PROBE_CELL_COOLDOWN_MS ?? ''), 10);
  return Number.isFinite(raw) && raw >= 0 ? raw : 10 * 60 * 1000;
}

/** Hard cap per run so a wide account cannot turn one click into thousands of calls. */
function resolveProbeMaxCellsPerRun(): number {
  const raw = Number.parseInt(String(process.env.PROBE_MAX_CELLS_PER_RUN ?? ''), 10);
  return Number.isFinite(raw) && raw > 0 ? raw : 400;
}

function buildProbeRunId(): string {
  return `pr_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Serialise probes that share an upstream group.
 *
 * Relays publish a per-group `rpm_limit`; firing every key/model of one group at
 * once trips it, and the resulting errors look like model failures.
 */
function createGroupSerializer() {
  const chains = new Map<string, Promise<void>>();
  return async function run<T>(groupKey: string, task: () => Promise<T>): Promise<T> {
    const previous = chains.get(groupKey) ?? Promise.resolve();
    let release = () => {};
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const next = previous.then(() => gate);
    chains.set(groupKey, next);
    await previous;
    try {
      return await task();
    } finally {
      release();
      void next.then(() => {
        if (chains.get(groupKey) === next) chains.delete(groupKey);
      });
    }
  };
}

/**
 * Build the cells for one probe run.
 *
 * The candidate set comes from the token-level model list, not the account-level
 * one: which models a key can serve is decided by that key's upstream group, and
 * `token_model_availability` is exactly that (it is also what route channels are
 * built from). Probing the account-level union with one arbitrary key is what
 * made a model served by group A look unavailable because group B was asked.
 */
async function buildProbeCells(params: {
  site: typeof schema.sites.$inferSelect;
  modelName?: string;
  tokenId?: number | null;
  scope: 'single' | 'all';
}): Promise<{ cells: ProbeCell[]; modelsToProbe: string[]; tokensCount: number }> {
  const { site } = params;
  const accounts = await db.select().from(schema.accounts)
    .where(and(eq(schema.accounts.siteId, site.id), eq(schema.accounts.status, 'active')))
    .all();
  // Deliberately not filtered on credentials: probing a public site (no auth on
  // /v1/chat/completions) is supported, which is why runtimeModelProbe accepts an
  // empty token. Filtering here made such accounts silently unprobeable.
  const usableAccounts = accounts;
  if (usableAccounts.length === 0) return { cells: [], modelsToProbe: [], tokensCount: 0 };

  const cells: ProbeCell[] = [];
  const modelOrder: string[] = [];
  const seenModels = new Set<string>();
  const wantedTokenId = params.tokenId == null ? null : Number(params.tokenId);
  const wanted = params.scope === 'single' ? String(params.modelName ?? '').trim().toLowerCase() : '';
  let tokensCount = 0;

  for (const account of usableAccounts) {
    // Has per-key discovery ever produced rows for this account? When it has not
    // (brand-new account, key added after the last refresh), the account-level
    // list is the only evidence and the default key is the only sensible probe —
    // better than reporting "nothing to probe" forever.
    const accountTokenIds = (await db.select({ id: schema.accountTokens.id })
      .from(schema.accountTokens)
      .where(eq(schema.accountTokens.accountId, account.id))
      .all()).map((row) => row.id);
    const accountHasNoTokenLevelRows = accountTokenIds.length === 0
      || (await db.select({ id: schema.tokenModelAvailability.id })
        .from(schema.tokenModelAvailability)
        .where(inArray(schema.tokenModelAvailability.tokenId, accountTokenIds))
        .all()).length === 0;
    const tokens = await db.select({
      id: schema.accountTokens.id,
      name: schema.accountTokens.name,
      token: schema.accountTokens.token,
      tokenGroup: schema.accountTokens.tokenGroup,
    })
      .from(schema.accountTokens)
      .where(and(
        eq(schema.accountTokens.accountId, account.id),
        eq(schema.accountTokens.enabled, true),
      ))
      .all();
    // An account with no managed keys still has to be probeable (public sites,
    // key-less imports): probe with the account credential and record the verdict
    // account-wide (token_id 0), the only scope available in that case.
    const allTokens = tokens.length > 0
      ? tokens
      : [{
        id: 0,
        name: '账号默认',
        token: String(account.apiToken || account.accessToken || ''),
        tokenGroup: null as string | null,
      }];
    const scopedTokens = wantedTokenId != null && Number.isFinite(wantedTokenId) && wantedTokenId > 0
      ? allTokens.filter((token) => token.id === wantedTokenId)
      : allTokens;

    for (const token of scopedTokens) {
      // Empty is legitimate: a public site answers without a credential, and the
      // probe treats "no token" as "send no Authorization header".
      const tokenValue = String(token.token || '').trim();

      // What this key advertised, plus what is currently disabled for it — a
      // disabled cell has to stay probeable, otherwise it can never recover.
      const advertised = await db.select({ modelName: schema.tokenModelAvailability.modelName })
        .from(schema.tokenModelAvailability)
        .where(and(
          eq(schema.tokenModelAvailability.tokenId, token.id),
          eq(schema.tokenModelAvailability.available, true),
        ))
        .all();
      const disabled = await db.select({ modelName: schema.siteDisabledModels.modelName })
        .from(schema.siteDisabledModels)
        .where(and(
          eq(schema.siteDisabledModels.siteId, site.id),
          eq(schema.siteDisabledModels.accountId, account.id),
          inArray(schema.siteDisabledModels.tokenId, [0, token.id]),
        ))
        .all();

      const tokenModels = new Map<string, string>();
      for (const row of [...advertised, ...disabled]) {
        const name = String(row.modelName || '').trim();
        if (!name) continue;
        const key = name.toLowerCase();
        if (!tokenModels.has(key)) tokenModels.set(key, name);
      }

      // No per-key discovery yet (a fresh account, or a key added after the last
      // refresh): the account-level list is the only evidence available, so probe
      // it with the account's default key. Group-scoped rejections are still
      // classified as "not applicable", so this cannot disable models another
      // group serves.
      if (tokenModels.size === 0 && accountHasNoTokenLevelRows) {
        const accountLevel = await db.select({ modelName: schema.modelAvailability.modelName })
          .from(schema.modelAvailability)
          .where(and(
            eq(schema.modelAvailability.accountId, account.id),
            eq(schema.modelAvailability.available, true),
          ))
          .all();
        const accountDisabled = await db.select({ modelName: schema.siteDisabledModels.modelName })
          .from(schema.siteDisabledModels)
          .where(and(
            eq(schema.siteDisabledModels.siteId, site.id),
            eq(schema.siteDisabledModels.accountId, account.id),
          ))
          .all();
        for (const row of [...accountLevel, ...accountDisabled]) {
          const name = String(row.modelName || '').trim();
          if (!name) continue;
          const key = name.toLowerCase();
          if (!tokenModels.has(key)) tokenModels.set(key, name);
        }
      }
      if (tokenModels.size === 0) continue;

      tokensCount += 1;
      for (const [key, modelName] of tokenModels) {
        if (wanted && key !== wanted) continue;
        if (!seenModels.has(key)) {
          seenModels.add(key);
          modelOrder.push(modelName);
        }
        cells.push({
          account,
          tokenId: token.id,
          tokenName: String(token.name || `#${token.id}`),
          tokenGroup: token.tokenGroup ? String(token.tokenGroup) : null,
          tokenValue,
          modelName,
        });
      }
    }
  }

  return { cells, modelsToProbe: modelOrder, tokensCount };
}

function parseProbeLogTimeMs(value: unknown): number {
  const text = String(value || '').trim();
  if (!text) return 0;
  const parsed = Date.parse(text.includes('T') ? text : `${text.replace(' ', 'T')}Z`);
  return Number.isFinite(parsed) ? parsed : 0;
}

/** Last probe time per (account, key, model), read from the log itself. */
async function loadRecentProbeTimes(accountIds: number[]): Promise<Map<string, number>> {
  const result = new Map<string, number>();
  if (accountIds.length === 0) return result;
  const rows = await db.select({
    accountId: schema.probeLogs.accountId,
    tokenId: schema.probeLogs.tokenId,
    modelName: schema.probeLogs.modelName,
    createdAt: schema.probeLogs.createdAt,
  })
    .from(schema.probeLogs)
    .where(inArray(schema.probeLogs.accountId, accountIds))
    .all();
  for (const row of rows) {
    const parsed = parseProbeLogTimeMs(row.createdAt);
    if (!parsed) continue;
    const key = `${row.accountId}:${row.tokenId ?? 0}:${String(row.modelName || '').trim().toLowerCase()}`;
    if (parsed > (result.get(key) ?? 0)) result.set(key, parsed);
  }
  return result;
}

/** Record "this key serves this model" on the table routing actually reads. */
async function markCellAvailable(cell: ProbeCell, latencyMs: number | null): Promise<void> {
  await db.update(schema.tokenModelAvailability)
    .set({
      available: true,
      connectivity: true,
      ...(latencyMs != null ? { latencyMs } : {}),
      checkedAt: new Date().toISOString(),
    })
    .where(and(
      eq(schema.tokenModelAvailability.tokenId, cell.tokenId),
      eq(schema.tokenModelAvailability.modelName, cell.modelName),
    ))
    .run();
}

/** Record "this key cannot serve this model", for that key only. */
async function markCellUnavailable(cell: ProbeCell): Promise<void> {
  await db.update(schema.tokenModelAvailability)
    .set({ available: false, connectivity: false, checkedAt: new Date().toISOString() })
    .where(and(
      eq(schema.tokenModelAvailability.tokenId, cell.tokenId),
      eq(schema.tokenModelAvailability.modelName, cell.modelName),
    ))
    .run();
}

export async function probeSiteModels(
  siteId: number,
  options?: ProbeSiteModelsOptions,
  onProgress?: (event: ProbeSiteModelsProgress) => void,
): Promise<ProbeSiteModelsResult> {
  const empty = (scope: 'single' | 'all', error: string): ProbeSiteModelsResult => ({
    success: false,
    error,
    scope,
    probed: 0,
    supported: 0,
    unsupported: 0,
    inconclusive: 0,
    notApplicable: 0,
    recovered: 0,
    estimatedCost: 0,
    details: [],
  });

  const site = await db.select().from(schema.sites).where(eq(schema.sites.id, siteId)).get();
  if (!site) return empty('single', '站点不存在');

  const scope = options?.scope ?? (options?.modelName !== undefined
    ? 'single'
    : site.postRefreshProbeScope === 'all' ? 'all' : 'single');

  if (scope === 'single' && options?.modelName !== undefined && !String(options.modelName).trim()) {
    return empty(scope, 'modelName 必须是非空模型名称');
  }

  let built = await buildProbeCells({
    site,
    scope,
    modelName: options?.modelName ?? site.postRefreshProbeModel ?? undefined,
    tokenId: options?.tokenId ?? null,
  });
  if (built.modelsToProbe.length === 0 && scope === 'single' && options?.modelName === undefined) {
    // The site's configured probe model is gone from the catalog: probe the first
    // advertised model instead of failing the whole pass. A stale setting must not
    // silently stop probing.
    const fallback = await buildProbeCells({ site, scope: 'all', tokenId: options?.tokenId ?? null });
    const firstModel = fallback.modelsToProbe[0];
    if (firstModel) {
      built = {
        cells: fallback.cells.filter((cell) => cell.modelName.toLowerCase() === firstModel.toLowerCase()),
        modelsToProbe: [firstModel],
        tokensCount: fallback.tokensCount,
      };
    }
  }
  // "Single" means one model even when the configured name is blank: otherwise an
  // empty setting silently turned the pass into a full sweep.
  if (scope === 'single' && built.modelsToProbe.length > 1) {
    const firstModel = built.modelsToProbe[0]!;
    built = {
      cells: built.cells.filter((cell) => cell.modelName.toLowerCase() === firstModel.toLowerCase()),
      modelsToProbe: [firstModel],
      tokensCount: built.tokensCount,
    };
  }
  if (built.modelsToProbe.length === 0) {
    if (options?.tokenId) return empty(scope, '该令牌暂无可探测的模型，请先刷新模型列表');
    const requested = String(options?.modelName ?? site.postRefreshProbeModel ?? '').trim();
    return empty(scope, requested
      ? `指定模型 "${requested}" 不在该站点的令牌模型列表中，请先刷新模型列表`
      : '该站点暂无已发现模型，请先刷新模型列表');
  }

  const runId = buildProbeRunId();
  const cooldownMs = resolveProbeCellCooldownMs();
  const maxCells = resolveProbeMaxCellsPerRun();
  const nowMs = Date.now();
  const recent = options?.force
    ? new Map<string, number>()
    : await loadRecentProbeTimes(Array.from(new Set(built.cells.map((cell) => cell.account.id))));
  const withinCooldown = (cell: ProbeCell): boolean => {
    if (options?.force || cooldownMs <= 0) return false;
    const last = recent.get(`${cell.account.id}:${cell.tokenId}:${cell.modelName.trim().toLowerCase()}`) ?? 0;
    return last > 0 && nowMs - last < cooldownMs;
  };
  const skippedByCooldown = built.cells.filter(withinCooldown).length;
  const cells = built.cells.filter((cell) => !withinCooldown(cell)).slice(0, maxCells);

  onProgress?.({
    type: 'start',
    scope,
    modelsCount: built.modelsToProbe.length,
    modelsToProbe: built.modelsToProbe,
    tokensCount: built.tokensCount,
    cellsCount: cells.length,
  });

  if (cells.length === 0) {
    return {
      success: true,
      scope,
      probed: 0,
      supported: 0,
      unsupported: 0,
      inconclusive: 0,
      notApplicable: 0,
      recovered: 0,
      estimatedCost: 0,
      details: [],
      error: skippedByCooldown > 0
        ? `全部 ${skippedByCooldown} 个探测单元都在冷却期内（${Math.round(cooldownMs / 60000)} 分钟内不重复探测），可勾选强制重探`
        : undefined,
    };
  }

  const threshold = options?.latencyThresholdMs ?? 0;
  const concurrency = Math.max(1, options?.concurrency ?? 10);
  const runInGroup = createGroupSerializer();

  let supportedCount = 0;
  let unsupportedCount = 0;
  let inconclusiveCount = 0;
  let notApplicableCount = 0;
  let recoveredCount = 0;
  let routeRebuildNeeded = false;
  const details: ProbeSiteModelsResult['details'] = [];

  let cursor = 0;
  async function worker() {
    while (cursor < cells.length) {
      if (options?.signal?.aborted) break;
      const cell = cells[cursor++];
      const groupKey = `${cell.account.id}:${cell.tokenGroup ?? cell.tokenId}`;
      let result: Awaited<ReturnType<typeof probeRuntimeModel>> | null = null;
      try {
        result = await runInGroup(groupKey, () => probeRuntimeModel({
          site,
          account: cell.account,
          modelName: cell.modelName,
          timeoutMs: resolveModelAvailabilityProbeTimeoutMs(),
          tokenValue: cell.tokenValue,
          // token_id 0 means "account-wide" in the disable table, but probe_logs
          // keeps a real foreign key to account_tokens: log no key instead.
          tokenId: cell.tokenId > 0 ? cell.tokenId : null,
          tokenGroup: cell.tokenGroup,
          runId,
        }));
      } catch (error) {
        const reason = error instanceof Error ? error.message : '探测异常';
        console.warn(`[probe] account ${cell.account.id} token ${cell.tokenId} ${cell.modelName} failed`, error);
        inconclusiveCount += 1;
        details.push({ modelName: cell.modelName, status: 'inconclusive', latencyMs: null, reason, tokenId: cell.tokenId, tokenName: cell.tokenName, tokenGroup: cell.tokenGroup });
        onProgress?.({ type: 'model', modelName: cell.modelName, status: 'inconclusive', latencyMs: null, reason, tokenId: cell.tokenId, tokenName: cell.tokenName, tokenGroup: cell.tokenGroup });
        continue;
      }

      const latencyExceeded = (
        result.status === 'supported'
        && threshold > 0
        && result.latencyMs != null
        && result.latencyMs > threshold
      );
      const groupScoped = result.status !== 'supported' && isGroupScopedModelRejection(result.reason);
      const status: ProbeSiteModelsResult['details'][number]['status'] = latencyExceeded
        ? 'unsupported'
        : groupScoped ? 'not-applicable' : result.status;
      const reason = latencyExceeded
        ? `响应延迟 ${result.latencyMs}ms 超过阈值 ${threshold}ms`
        : result.reason;

      details.push({
        modelName: cell.modelName,
        status,
        latencyMs: result.latencyMs,
        reason,
        tokenId: cell.tokenId,
        tokenName: cell.tokenName,
        tokenGroup: cell.tokenGroup,
      });
      onProgress?.(latencyExceeded
        ? { type: 'model', modelName: cell.modelName, status, latencyMs: result.latencyMs, latencyExceeded: true, reason, tokenId: cell.tokenId, tokenName: cell.tokenName, tokenGroup: cell.tokenGroup }
        : { type: 'model', modelName: cell.modelName, status, latencyMs: result.latencyMs, reason, tokenId: cell.tokenId, tokenName: cell.tokenName, tokenGroup: cell.tokenGroup });

      if (status === 'skipped') continue;

      if (status === 'supported') {
        supportedCount += 1;
        await markCellAvailable(cell, result.latencyMs);
        const recovered = await clearAutoDisabledModels({
          siteId: site.id,
          accountId: cell.account.id,
          tokenId: cell.tokenId,
          modelNames: [cell.modelName],
        });
        if (recovered.length > 0) {
          recoveredCount += recovered.length;
          routeRebuildNeeded = true;
          onProgress?.({ type: 'action', modelName: cell.modelName, action: 'enabled', tokenId: cell.tokenId, tokenName: cell.tokenName, tokenGroup: cell.tokenGroup });
        }
        continue;
      }

      if (status === 'not-applicable') {
        // This group does not serve the model. Correct the advertisement for this
        // key (routing reads it) but never write an account-wide verdict: another
        // key of the account may serve it perfectly well.
        notApplicableCount += 1;
        await markCellUnavailable(cell);
        routeRebuildNeeded = true;
        continue;
      }

      if (status === 'unsupported') unsupportedCount += 1;
      else inconclusiveCount += 1;
      await markCellUnavailable(cell);
      const inserted = await db.insert(schema.siteDisabledModels)
        .values({
          siteId: site.id,
          accountId: cell.account.id,
          tokenId: cell.tokenId,
          modelName: cell.modelName,
          source: 'probe',
        })
        .onConflictDoNothing()
        .run();
      if (Number((inserted as { changes?: number | bigint } | undefined)?.changes ?? 0) > 0) {
        routeRebuildNeeded = true;
        onProgress?.({ type: 'action', modelName: cell.modelName, action: 'disabled', tokenId: cell.tokenId, tokenName: cell.tokenName, tokenGroup: cell.tokenGroup });
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, cells.length) }, worker));

  // One rebuild for the whole run: rebuilding per cell thrashes the route tables
  // and, on a wide account, costs more time than the probing itself.
  if (routeRebuildNeeded && !options?.signal?.aborted) {
    invalidateTokenRouterCache();
    rebuildTokenRoutesFromAvailability().catch((err) => {
      console.warn('[probe] route rebuild failed', err);
    });
  }

  if (unsupportedCount + inconclusiveCount > 0) {
    const failed = unsupportedCount + inconclusiveCount;
    const sample = details.filter((detail) => detail.status === 'unsupported' || detail.status === 'inconclusive').slice(0, 3);
    await setAccountRuntimeHealth(cells[0]!.account.id, {
      state: 'unhealthy',
      reason: `探测未通过：${failed} 个单元未确认可用（${sample.map((detail) => detail.modelName).join('、')}${failed > 3 ? '…' : ''}）`,
      source: options?.trigger === 'post-refresh' ? 'post-refresh-probe' : 'manual-probe',
      checkedAt: new Date().toISOString(),
    });
  }

  // Cost of the run: the per-probe rows are the ledger, so aggregating them here
  // keeps "what did this run spend" identical to what the log page shows.
  const runCost = await db.select({ total: sql<number>`coalesce(sum(${schema.probeLogs.estimatedCost}), 0)` })
    .from(schema.probeLogs)
    .where(eq(schema.probeLogs.runId, runId))
    .get()
    .catch(() => null);

  return {
    success: true,
    scope,
    probed: details.length,
    supported: supportedCount,
    unsupported: unsupportedCount,
    inconclusive: inconclusiveCount,
    notApplicable: notApplicableCount,
    recovered: recoveredCount,
    estimatedCost: Math.round(Number(runCost?.total ?? 0) * 1_000_000) / 1_000_000,
    details,
  };
}

async function runPostRefreshProbeIfEnabled(params: {
  account: typeof schema.accounts.$inferSelect;
  site: typeof schema.sites.$inferSelect;
  discoveredModels: string[];
}): Promise<ModelRefreshSuccessResult['postProbeResult']> {
  if (!params.site.postRefreshProbeEnabled) return undefined;
  if (params.discoveredModels.length === 0) return undefined;

  // One probe implementation for both triggers: the per-key cell builder already
  // knows which models each key advertises, and re-deriving that here is how the
  // two paths drifted apart (this one used to write account-wide verdicts).
  const result = await probeSiteModels(params.site.id, {
    scope: params.site.postRefreshProbeScope === 'all' ? 'all' : 'single',
    modelName: params.site.postRefreshProbeScope === 'all'
      ? undefined
      : (params.site.postRefreshProbeModel || params.discoveredModels[0]),
    latencyThresholdMs: params.site.postRefreshProbeLatencyThresholdMs ?? 0,
    trigger: 'post-refresh',
  });
  if (!result.success) return undefined;

  return {
    scope: result.scope,
    probed: result.probed,
    unsupported: result.unsupported,
    inconclusive: result.inconclusive,
    details: result.details.map((detail) => ({
      modelName: detail.modelName,
      // `not-applicable` is not a model verdict: report it as unproven so the
      // summary never claims the model itself was rejected.
      status: (detail.status === 'not-applicable' ? 'inconclusive' : detail.status) as RuntimeModelProbeStatus,
      latencyMs: detail.latencyMs,
    })),
  };
}

// Per-account in-flight guard: concurrent refreshes of the same account
// (manual UI refresh + proxy-triggered full refresh) race on
// delete-then-insert of model_availability and hit the
// (account_id, model_name) unique index. Reuse the running refresh instead.
const modelRefreshInFlight = new Map<string, Promise<ModelRefreshResult>>();

export function refreshModelsForAccount(
  accountId: number,
  options?: { allowInactive?: boolean },
): Promise<ModelRefreshResult> {
  const key = `${accountId}:${options?.allowInactive === true}`;
  const existing = modelRefreshInFlight.get(key);
  if (existing) return existing;

  const run = doRefreshModelsForAccount(accountId, options).then(async (result) => {
    // Apply the account's new-model policy only after a successful refresh: the
    // baseline is compared with what discovery actually found.
    if (result?.refreshed === true) {
      try {
        await applyNewModelPolicyForAccount(accountId);
      } catch (err) {
        console.warn(
          '[new-model-policy] apply failed',
          accountId,
          err instanceof Error ? err.message : String(err),
        );
      }
    }
    return result;
  });
  modelRefreshInFlight.set(key, run);
  run.finally(() => {
    modelRefreshInFlight.delete(key);
  }).catch(() => {
    // finality handled by caller; keep the map clean
  });
  return run;
}

async function doRefreshModelsForAccount(
  accountId: number,
  options?: { allowInactive?: boolean },
): Promise<ModelRefreshResult> {
  const row = await db.select().from(schema.accounts)
    .innerJoin(schema.sites, eq(schema.accounts.siteId, schema.sites.id))
    .where(eq(schema.accounts.id, accountId))
    .get();

  if (!row) {
    return buildAccountNotFoundRefreshResult(accountId);
  }

  const account = row.accounts;
  const site = row.sites;
  const adapter = getAdapter(site.platform);
  const accountProxyUrl = resolveProxyUrlFromExtraConfig(account.extraConfig);

  // A failed refresh must not silently look like a successful one, but it also
  // must not destroy a working routing table: only a confirmed credential
  // failure (401/403) makes the discovered list meaningless and clears it.
  // Every other verdict (timeout, shield page, empty list, 5xx) keeps the
  // previous rows so traffic keeps flowing; the account is marked degraded with
  // source 'model-discovery', which the selection engine reads to demote it and
  // the UI reads to label the list as a previous result.
  const snapshotAvailability = async () => ({
    models: await db.select()
      .from(schema.modelAvailability)
      .where(and(
        eq(schema.modelAvailability.accountId, accountId),
        eq(schema.modelAvailability.isManual, false),
      ))
      .all(),
    tokens: (await Promise.all(
      (await db.select({ id: schema.accountTokens.id })
        .from(schema.accountTokens)
        .where(eq(schema.accountTokens.accountId, accountId))
        .all()).map(async (token: any) => db.select()
        .from(schema.tokenModelAvailability)
        .where(eq(schema.tokenModelAvailability.tokenId, token.id))
        .all()),
    )).flat(),
  });
  const clearExistingAvailability = async () => {
    await db.delete(schema.modelAvailability)
      .where(and(
        eq(schema.modelAvailability.accountId, accountId),
        eq(schema.modelAvailability.isManual, false),
      ))
      .run();

    const currentAccountTokens = await db.select({ id: schema.accountTokens.id })
      .from(schema.accountTokens)
      .where(eq(schema.accountTokens.accountId, accountId))
      .all();

    const tokenIds = currentAccountTokens.map((token) => token.id);
    if (tokenIds.length > 0) {
      await db.delete(schema.tokenModelAvailability)
        .where(inArray(schema.tokenModelAvailability.tokenId, tokenIds))
        .run();
    }
  };

  const restorePreviousAvailabilityUnlessCredentialFailure = async (
    errorCode: ModelRefreshErrorCode,
    previous: Awaited<ReturnType<typeof snapshotAvailability>>,
  ) => {
    // A revoked/invalid key means the discovered list no longer describes what
    // this account can route, so it must go. Everything else keeps the list:
    // those rows are what keeps traffic alive through a metadata blip, and the
    // account health write below is what stops them from looking current.
    if (errorCode === 'unauthorized') return;
    if (previous.models.length === 0 && previous.tokens.length === 0) return;
    if (previous.models.length > 0) {
      await db.insert(schema.modelAvailability).values(
        previous.models.map(({ id: _id, ...row }: any) => row),
      ).onConflictDoNothing().run();
    }
    if (previous.tokens.length > 0) {
      await db.insert(schema.tokenModelAvailability).values(
        previous.tokens.map(({ id: _id, ...row }: any) => row),
      ).onConflictDoNothing().run();
    }
  };

  // Collect manual model names so discovered models that collide are skipped (unique index).
  const manualModelNames = new Set(
    (await db.select({ modelName: schema.modelAvailability.modelName })
      .from(schema.modelAvailability)
      .where(and(
        eq(schema.modelAvailability.accountId, accountId),
        eq(schema.modelAvailability.isManual, true),
      ))
      .all()
    ).map((r: any) => r.modelName.toLowerCase()),
  );

  if (isSiteDisabled(site.status)) {
    return buildSkippedRefreshResult(accountId, 'site_disabled', '站点已禁用');
  }

  if (account.status !== 'active' && !options?.allowInactive) {
    return buildSkippedRefreshResult(accountId, 'adapter_or_status', '平台不可用或账号未激活');
  }

  // Only wipe the previous availability once we know this refresh will run:
  // the skip paths above must not leave the account with zero models (and
  // therefore zero routes) until the next full pass.
  const previousAvailability = await snapshotAvailability();
  await clearExistingAvailability();

  if (!adapter) {
    return buildSkippedRefreshResult(accountId, 'adapter_or_status', '平台不可用或账号未激活');
  }

  const platformUserId = resolvePlatformUserId(account.extraConfig, account.username);
  let discoveredApiToken: string | null = null;

  if (!account.apiToken && account.accessToken) {
    try {
      discoveredApiToken = await withTimeout(
        () => withAccountProxyOverride(accountProxyUrl,
          () => adapter.getApiToken(site.url, account.accessToken, platformUserId)),
        API_TOKEN_DISCOVERY_TIMEOUT_MS,
        `api token discovery timeout (${Math.round(API_TOKEN_DISCOVERY_TIMEOUT_MS / 1000)}s)`,
      );
      if (discoveredApiToken && !isMaskedTokenValue(discoveredApiToken)) {
        await ensureDefaultTokenForAccount(account.id, discoveredApiToken, { name: 'default', source: 'sync' });
        await db.update(schema.accounts).set({
          apiToken: discoveredApiToken,
          updatedAt: new Date().toISOString(),
        }).where(eq(schema.accounts.id, account.id)).run();
      } else {
        discoveredApiToken = null;
      }
    } catch { }
  }

  const usesManagedTokens = requiresManagedAccountTokens(account);
  let enabledTokens = usesManagedTokens
    ? await db.select()
      .from(schema.accountTokens)
      .where(and(
        eq(schema.accountTokens.accountId, account.id),
        eq(schema.accountTokens.enabled, true),
        eq(schema.accountTokens.valueStatus, ACCOUNT_TOKEN_VALUE_STATUS_READY),
      ))
      .all()
    : [];
  enabledTokens = enabledTokens.filter(isUsableAccountToken);

  // Last fallback: if still no managed token but account has a legacy apiToken, mirror it into token table.
  if (usesManagedTokens && enabledTokens.length === 0) {
    const fallback = discoveredApiToken || account.apiToken || null;
    if (fallback) {
      await ensureDefaultTokenForAccount(account.id, fallback, { name: 'default', source: 'legacy' });
      enabledTokens = await db.select()
        .from(schema.accountTokens)
        .where(and(
          eq(schema.accountTokens.accountId, account.id),
          eq(schema.accountTokens.enabled, true),
          eq(schema.accountTokens.valueStatus, ACCOUNT_TOKEN_VALUE_STATUS_READY),
        ))
        .all();
      enabledTokens = enabledTokens.filter(isUsableAccountToken);
    }
  }

  let aiBaseUrl: string;
  try {
    aiBaseUrl = await requireSiteApiBaseUrl(site);
  } catch (err) {
    const rawMessage = (err as { message?: string })?.message || '模型获取失败';
    const errorCode = classifyModelDiscoveryError(rawMessage);
    const errorMessage = rawMessage;
    await restorePreviousAvailabilityUnlessCredentialFailure(errorCode, previousAvailability);
    await setAccountRuntimeHealth(account.id, {
      state: modelDiscoveryFailureHealthState(errorCode),
      reason: errorMessage,
      source: 'model-discovery',
      checkedAt: new Date().toISOString(),
    });
    return buildFailedRefreshResult({
      accountId,
      errorCode,
      errorMessage,
      tokenScanned: 0,
      discoveredByCredential: false,
      discoveredApiToken: !!discoveredApiToken,
    });
  }

  // Codex-gated NewAPI-class platforms reject /v1/models unless the caller
  // presents the Codex CLI client fingerprint — verified on AgentRouter
  // (401 "unauthorized client detected" without it, full model list with it).
  // Identity is face/platform-driven (no user-facing site switch): discovery
  // carries the fingerprint automatically on gated platforms.
  const codexClientFingerprint = isCodexGatedPlatform(site.platform);

  const accountModels = new Map<string, string>();   // lowercase key → original name (first-wins)
  const modelLatency = new Map<string, number | null>();
  let scannedTokenCount = 0;
  let discoveredByCredential = false;
  const attemptedCredentials = new Set<string>();
  const failureMessages: string[] = [];
  const recordFailure = (err: unknown) => {
    const message = (err as { message?: string })?.message || String(err || '');
    if (message) failureMessages.push(message);
  };

  const mergeDiscoveredModels = (models: string[], latencyMs: number | null) => {
    for (const modelName of models) {
      const key = modelName.toLowerCase();
      if (!accountModels.has(key)) accountModels.set(key, modelName);
      const prev = modelLatency.get(key);
      if (prev === undefined || prev === null) {
        modelLatency.set(key, latencyMs);
        continue;
      }
      if (latencyMs === null) continue;
      if (latencyMs < prev) modelLatency.set(key, latencyMs);
    }
  };

  const discoverModelsWithCredential = async (credentialRaw: string | null | undefined, options?: { allowEmpty?: boolean }) => {
    const credential = (credentialRaw || '').trim();
    if (!credential && !options?.allowEmpty) return;
    if (isMaskedTokenValue(credential)) return;
    if (attemptedCredentials.has(credential)) return;
    attemptedCredentials.add(credential);

    const startedAt = Date.now();
    let models: string[] = [];
    try {
      models = normalizeModels(
        await withTimeout(
          () => withAccountProxyOverride(accountProxyUrl,
            () => (codexClientFingerprint
              ? adapter.getModels(aiBaseUrl, credential, platformUserId, { requireCodexClient: true })
              : adapter.getModels(aiBaseUrl, credential, platformUserId))),
          MODEL_DISCOVERY_TIMEOUT_MS,
          `model discovery timeout (${Math.round(MODEL_DISCOVERY_TIMEOUT_MS / 1000)}s)`,
        ),
      );
    } catch (err) {
      recordFailure(err);
      models = [];
    }
    if (models.length === 0) return;
    discoveredByCredential = true;
    const latencyMs = Date.now() - startedAt;
    mergeDiscoveredModels(models, latencyMs);
  };

  // Prefer account-level credential discovery so model availability does not rely
  // on managed tokens — but when usable managed tokens exist, do NOT discover via
  // the session access token first. NewAPI-class `/api/user/models` returns every
  // model the login can access across groups, which overstates what each API key
  // can actually route after group binding (e.g. sk in "grok" group → only grok-*).
  const preferManagedTokenDiscovery = usesManagedTokens && enabledTokens.length > 0;

  await discoverModelsWithCredential(account.apiToken);
  await discoverModelsWithCredential(discoveredApiToken);
  if (!preferManagedTokenDiscovery) {
    await discoverModelsWithCredential(account.accessToken);
  }

  for (const token of enabledTokens) {
    const startedAt = Date.now();
    let models: string[] = [];

    try {
      models = normalizeModels(
        await withTimeout(
          () => withAccountProxyOverride(accountProxyUrl,
            () => (codexClientFingerprint
              ? adapter.getModels(aiBaseUrl, token.token, platformUserId, { requireCodexClient: true })
              : adapter.getModels(aiBaseUrl, token.token, platformUserId))),
          MODEL_DISCOVERY_TIMEOUT_MS,
          `model discovery timeout (${Math.round(MODEL_DISCOVERY_TIMEOUT_MS / 1000)}s)`,
        ),
      );
    } catch (err) {
      recordFailure(err);
      models = [];
    }

    if (models.length === 0) continue;

    const latencyMs = Date.now() - startedAt;
    const checkedAt = new Date().toISOString();

    await db.insert(schema.tokenModelAvailability).values(
      models.map((modelName) => ({
        tokenId: token.id,
        modelName,
        available: true,
        latencyMs,
        checkedAt,
      })),
    ).onConflictDoNothing().run();

    scannedTokenCount++;
    mergeDiscoveredModels(models, latencyMs);
  }

  // Sync token group binding from upstream so billing uses the correct
  // group ratio (e.g. a key bound to "vercel glm" at 0.1× instead of the
  // model's first enableGroup "default" at 4×).
  if (usesManagedTokens && enabledTokens.length > 0) {
    await syncTokenGroupsFromUpstream(adapter, site, account, enabledTokens, accountProxyUrl);
  }

  // Last resort: managed-token discovery produced nothing (masked keys / network).
  // Fall back to session models so the account is not left empty.
  if (preferManagedTokenDiscovery && accountModels.size === 0) {
    await discoverModelsWithCredential(account.accessToken);
  }

  // 公开站兜底：账号无任何凭据时也尝试一次空凭据发现（free.empero.org 这类
  // 站点 /v1/models 无需鉴权即可返回目录，否则系统内永远获取不到模型）。
  // 需要鉴权的站点返回 401 时无副作用（仅记入 failureMessages，模型仍为空）。
  if (accountModels.size === 0
    && !discoveredApiToken
    && !account.apiToken
    && !account.accessToken
    && enabledTokens.length === 0) {
    await discoverModelsWithCredential('', { allowEmpty: true });
  }

  if (accountModels.size === 0) {
    const firstMessage = failureMessages[0] || '';
    const errorCode = firstMessage ? classifyModelDiscoveryError(firstMessage) : 'empty_models';
    const errorMessage = buildModelFailureMessage(errorCode, firstMessage, site.platform);
    await restorePreviousAvailabilityUnlessCredentialFailure(errorCode, previousAvailability);
    await setAccountRuntimeHealth(account.id, {
      state: modelDiscoveryFailureHealthState(errorCode),
      reason: errorMessage,
      source: 'model-discovery',
      checkedAt: new Date().toISOString(),
    });
    return buildFailedRefreshResult({
      accountId,
      errorCode,
      errorMessage,
      tokenScanned: scannedTokenCount,
      discoveredByCredential,
      discoveredApiToken: !!discoveredApiToken,
    });
  }

  const checkedAt = new Date().toISOString();
  const newAccountModels = Array.from(accountModels.values()).filter((m) => !manualModelNames.has(m.toLowerCase()));
  if (newAccountModels.length > 0) {
    await db.insert(schema.modelAvailability).values(
      newAccountModels.map((modelName) => ({
        accountId: account.id,
        modelName,
        available: true,
        latencyMs: modelLatency.get(modelName.toLowerCase()) ?? null,
        checkedAt,
      })),
    ).onConflictDoNothing().run();
  }

  await setAccountRuntimeHealth(account.id, {
    state: 'healthy',
    reason: '模型探测成功',
    source: 'model-discovery',
    checkedAt,
  });
  await recordSiteApiEndpointSuccessByBaseUrl(site.id, aiBaseUrl, checkedAt);

  const modelsPreview = Array.from(accountModels.values()).slice(0, 10);
  const standardPostProbeResult = await runPostRefreshProbeIfEnabled({
    account,
    site,
    discoveredModels: Array.from(accountModels.values()),
  });
  return buildSuccessfulRefreshResult({
    accountId,
    modelCount: accountModels.size,
    modelsPreview,
    tokenScanned: scannedTokenCount,
    discoveredByCredential,
    discoveredApiToken: !!discoveredApiToken,
    postProbeResult: standardPostProbeResult,
  });
}

/**
 * Pulls each API key's bound group from the upstream NewAPI `/api/token/`
 * endpoint and persists it to `account_tokens.token_group`.
 *
 * This group binding determines which `group_ratio` entry applies at billing
 * time. Without it, the billing code falls back to the model's first
 * `enableGroups` entry — which may be "default" (4×) when the token is
 * actually bound to "vercel glm" (0.1×), overcharging by 40×.
 */
async function syncTokenGroupsFromUpstream(
  adapter: any,
  site: any,
  account: any,
  enabledTokens: any[],
  accountProxyUrl: string | null,
): Promise<void> {
  try {
    const tokenInfos = await withAccountProxyOverride(accountProxyUrl,
      () => adapter.getApiTokens(site.url, account.accessToken, resolvePlatformUserId(account.extraConfig, account.username)),
    );
    if (!Array.isArray(tokenInfos) || tokenInfos.length === 0) return;

    // Build key → group map. Keys from upstream are full; local tokens may be
    // masked — match on the last 8 chars as a fallback.
    const groupByKey = new Map<string, string>();
    for (const info of tokenInfos) {
      if (info.key && info.tokenGroup) {
        groupByKey.set(info.key, info.tokenGroup);
      }
    }
    if (groupByKey.size === 0) return;

    const now = new Date().toISOString();
    for (const token of enabledTokens) {
      let group = groupByKey.get(token.token);
      // Fallback: match on key suffix (upstream returns full key, local may be masked).
      if (!group) {
        for (const [upstreamKey, g] of groupByKey) {
          if (upstreamKey.length > 8 && token.token.length > 8
            && upstreamKey.slice(-8) === token.token.slice(-8)) {
            group = g;
            break;
          }
        }
      }
      if (group && group !== token.tokenGroup) {
        await db.update(schema.accountTokens)
          .set({ tokenGroup: group, updatedAt: now })
          .where(eq(schema.accountTokens.id, token.id))
          .run();
      }
    }
  } catch {
    // Non-fatal: group sync is a billing-accuracy enhancement, not a discovery gate.
  }
}

async function refreshModelsForAllActiveAccounts(): Promise<ModelRefreshResult[]> {
  const accounts = await db.select({ id: schema.accounts.id }).from(schema.accounts)
    .where(eq(schema.accounts.status, 'active'))
    .all();

  const results: ModelRefreshResult[] = [];
  for (let offset = 0; offset < accounts.length; offset += MODEL_REFRESH_BATCH_SIZE) {
    const batch = accounts.slice(offset, offset + MODEL_REFRESH_BATCH_SIZE);
    const batchResults = await Promise.all(batch.map(async (account: any) => refreshModelsForAccount(account.id)));
    results.push(...batchResults);
    // Heartbeat: a finished batch means this pass is advancing, not wedged.
    // The single-flight staleness guard keys off this timestamp so a healthy
    // slow pass (N batches x discovery timeouts) is never overlapped by a
    // second pass mid-run. Uses the injectable clock so tests can drive the
    // heartbeat/staleness relationship deterministically.
    inFlightRefreshModelsAndRebuildRoutesHeartbeatMs = refreshInflightNow();
  }
  return results;
}

export async function rebuildTokenRoutesFromAvailability() {
  const tokenRows = await db.select().from(schema.tokenModelAvailability)
    .innerJoin(schema.accountTokens, eq(schema.tokenModelAvailability.tokenId, schema.accountTokens.id))
    .innerJoin(schema.accounts, eq(schema.accountTokens.accountId, schema.accounts.id))
    .innerJoin(schema.sites, eq(schema.accounts.siteId, schema.sites.id))
    .where(
      and(
        eq(schema.tokenModelAvailability.available, true),
        eq(schema.accountTokens.enabled, true),
        eq(schema.accountTokens.valueStatus, ACCOUNT_TOKEN_VALUE_STATUS_READY),
        eq(schema.accounts.status, 'active'),
        eq(schema.sites.status, 'active'),
      ),
    )
    .all();
  const usableTokenRows = tokenRows.filter((row: any) => (
    isUsableAccountToken(row.account_tokens)
    && requiresManagedAccountTokens(row.accounts)
  ));

  const accountRows = await db.select().from(schema.modelAvailability)
    .innerJoin(schema.accounts, eq(schema.modelAvailability.accountId, schema.accounts.id))
    .innerJoin(schema.sites, eq(schema.accounts.siteId, schema.sites.id))
    .where(
      and(
        eq(schema.modelAvailability.available, true),
        eq(schema.accounts.status, 'active'),
        eq(schema.sites.status, 'active'),
      ),
    )
    .all();

  // Load site-level disabled models (raw + canonical match)
  const disabledModelsIndex = await loadSiteDisabledModelsIndex();

  const modelCandidates = new Map<string, Map<string, {
    accountId: number;
    tokenId: number | null;
    sourceModel: string;
  }>>();
  const buildCandidateKey = (input: {
    accountId: number;
    tokenId: number | null;
    sourceModel: string | null;
  }) => {
    const sourceModel = (input.sourceModel || '').trim().toLowerCase();
    return `${input.accountId}:${input.tokenId ?? 'account'}::${sourceModel}`;
  };
  const buildChannelKey = (channel: typeof schema.routeChannels.$inferSelect) => (
    `${channel.accountId}:${channel.tokenId ?? 'account'}::${(channel.sourceModel || '').trim().toLowerCase()}`
  );
  const addModelCandidate = (
    modelNameRaw: string | null | undefined,
    accountId: number,
    tokenId: number | null,
    siteId: number,
  ) => {
    const sourceModel = (modelNameRaw || '').trim();
    if (!sourceModel) return;
    if (isModelDisabledForSite(disabledModelsIndex, siteId, sourceModel, accountId)) return;
    const modelName = canonicalizeModelName(sourceModel) || sourceModel;
    if (!modelCandidates.has(modelName)) modelCandidates.set(modelName, new Map());
    const candidate = { accountId, tokenId, sourceModel };
    modelCandidates.get(modelName)!.set(buildCandidateKey(candidate), candidate);
  };

  for (const row of usableTokenRows) {
    addModelCandidate(row.token_model_availability.modelName, row.accounts.id, row.account_tokens.id, row.accounts.siteId);
  }

  for (const row of accountRows) {
    if (!supportsDirectAccountRoutingConnection(row.accounts)) continue;
    addModelCandidate(row.model_availability.modelName, row.accounts.id, null, row.accounts.siteId);
  }

  const routes = await db.select().from(schema.tokenRoutes).all();
  const channels = await db.select().from(schema.routeChannels).all();

  let createdRoutes = 0;
  let createdChannels = 0;
  let removedChannels = 0;
  let removedRoutes = 0;

  // accountId -> siteId for disabled-model force removal: one query for the
  // whole rebuild. It used to run inside the per-model loop, turning a rebuild
  // over 1000 models into 1000 full accounts scans.
  const accountSiteIds = new Map<number, number>();
  const allAccounts = await db.select({
    id: schema.accounts.id,
    siteId: schema.accounts.siteId,
  }).from(schema.accounts).all();
  for (const row of allAccounts) {
    accountSiteIds.set(row.id, row.siteId);
  }
  const channelsByRouteId = new Map<number, typeof channels>();
  for (const channel of channels) {
    const list = channelsByRouteId.get(channel.routeId);
    if (list) list.push(channel);
    else channelsByRouteId.set(channel.routeId, [channel]);
  }

  // Public names an enabled explicit group owns. A group resolves traffic
  // through its source routes and its own route_channels stay empty, so the
  // byte-equal lookup below cannot see it — the old behavior inserted an exact
  // twin for the same public name (the "duplicate group" symptom: the twin
  // hides under the group card, gets deleted, and rebuilds it back).
  // Ownership/alias rules live in shared/routeGroupName.ts so this rebuild, the
  // API guard and the editor dialog cannot drift apart. A group without any
  // source rows does NOT own the name — that is the recovery path when all of
  // its sources died upstream.
  const groupSourceIdsByRouteId = new Map<number, number[]>();
  for (const row of await db.select().from(schema.routeGroupSources).all()) {
    const list = groupSourceIdsByRouteId.get(row.groupRouteId);
    if (list) list.push(row.sourceRouteId);
    else groupSourceIdsByRouteId.set(row.groupRouteId, [row.sourceRouteId]);
  }
  const groupOwnedModelNames = new Set(
    collectGroupNameOwners((routes as any[]).map((route) => ({
      ...route,
      sourceRouteIds: groupSourceIdsByRouteId.get(route.id) ?? [],
    })))
      .map((route) => canonicalRouteAlias(resolveExposedRouteName(route)))
      .filter((alias) => alias.length > 0),
  );

  for (const [modelName, candidateMap] of modelCandidates.entries()) {
    let route = routes.find((r: any) => (r.routeMode || 'pattern') !== 'explicit_group' && r.modelPattern === modelName);
    if (!route && groupOwnedModelNames.has(canonicalRouteAlias(modelName))) {
      // The live group already answers for this alias; creating an exact route
      // would fork a second card with the same public name and double-register
      // channels. Its candidates stay reachable through the group's sources.
      continue;
    }
    if (!route) {
      const inserted = await db.insert(schema.tokenRoutes).values({
        modelPattern: modelName,
        enabled: true,
      }).run();
      const insertedId = getInsertedRowId(inserted);
      route = insertedId != null
        ? await db.select().from(schema.tokenRoutes).where(eq(schema.tokenRoutes.id, insertedId)).get()
        : undefined;
      if (!route) continue;
      routes.push(route);
      createdRoutes++;
    }

    const routeChannels = channelsByRouteId.get(route.id) ?? [];
    const desiredKeys = new Set(Array.from(candidateMap.keys()));

    for (const [candidateKey, candidate] of candidateMap.entries()) {
      const exists = routeChannels.some((channel: any) => buildChannelKey(channel) === candidateKey);
      if (exists) continue;

      const inserted = await db.insert(schema.routeChannels).values({
        routeId: route.id,
        accountId: candidate.accountId,
        tokenId: candidate.tokenId,
        sourceModel: candidate.sourceModel,
        priority: 0,
        weight: 10,
        enabled: true,
        manualOverride: false,
      }).run();
      const insertedId = getInsertedRowId(inserted);
      if (insertedId == null) continue;
      const created = await db.select().from(schema.routeChannels).where(eq(schema.routeChannels.id, insertedId)).get();
      if (!created) continue;
      channels.push(created);
      const routeChannelList = channelsByRouteId.get(route.id);
      if (routeChannelList) routeChannelList.push(created);
      else channelsByRouteId.set(route.id, [created]);
      createdChannels++;
      desiredKeys.add(candidateKey);
    }

    for (const channel of routeChannels) {
      const channelKey = buildChannelKey(channel);
      const channelSiteId = accountSiteIds.get(channel.accountId) ?? null;
      const forceRemoveDisabled = isModelDisabledForSite(
        disabledModelsIndex,
        channelSiteId,
        channel.sourceModel,
        channel.accountId,
        // Channels are per (account, token, model): a verdict about one key's
        // upstream group must not delete another key's channel.
        channel.tokenId,
      );
      if (desiredKeys.has(channelKey) && !forceRemoveDisabled) {
        continue;
      }

      if (!forceRemoveDisabled && !channel.tokenId) {
        const preferred = await getPreferredAccountToken(channel.accountId);
        // Reuse the one channel-key builder: a hand-built key that omitted the
        // `::sourceModel` suffix was always false, so this branch never ran and
        // every rebuild deleted + recreated the channel (resetting its stats).
        if (preferred && desiredKeys.has(buildChannelKey({ ...channel, tokenId: preferred.id }))) {
          await db.update(schema.routeChannels)
            .set({ tokenId: preferred.id })
            .where(eq(schema.routeChannels.id, channel.id))
            .run();
          continue;
        }
      }

      if (forceRemoveDisabled || !channel.manualOverride) {
        await db.delete(schema.routeChannels).where(eq(schema.routeChannels.id, channel.id)).run();
        removedChannels++;
      }
    }
  }

  const latestModelNames = new Set<string>(Array.from(modelCandidates.keys()));
  for (const route of routes) {
    if ((route.routeMode || 'pattern') === 'explicit_group') {
      continue;
    }
    const modelPattern = (route.modelPattern || '').trim();
    if (!modelPattern || !isExactModelPattern(modelPattern) || latestModelNames.has(modelPattern)) {
      continue;
    }

    const routeChannelCount = (channelsByRouteId.get(route.id) ?? []).length;
    if (routeChannelCount > 0) {
      removedChannels += routeChannelCount;
    }

    const deleted = (await db.delete(schema.tokenRoutes).where(eq(schema.tokenRoutes.id, route.id)).run()).changes;
    if (deleted > 0) {
      removedRoutes += deleted;
    }
  }

  const exactRouteTopologyChanged = createdRoutes > 0 || createdChannels > 0 || removedChannels > 0 || removedRoutes > 0;
  const patternRouteSync = exactRouteTopologyChanged
    ? await rebuildAllPatternRouteChannels()
    : {
      rebuiltRoutes: 0,
      routeIds: [],
      removedChannels: 0,
      createdChannels: 0,
      updatedChannels: 0,
    };
  createdChannels += patternRouteSync.createdChannels;
  removedChannels += patternRouteSync.removedChannels;

  if (exactRouteTopologyChanged
    || patternRouteSync.createdChannels > 0
    || patternRouteSync.removedChannels > 0
    || patternRouteSync.updatedChannels > 0) {
    await clearAllRouteDecisionSnapshots();
  }

  invalidateTokenRouterCache();

  return {
    models: modelCandidates.size,
    createdRoutes,
    createdChannels,
    removedChannels,
    removedRoutes,
    rebuiltPatternRoutes: patternRouteSync.rebuiltRoutes,
    patternRouteCreatedChannels: patternRouteSync.createdChannels,
    patternRouteRemovedChannels: patternRouteSync.removedChannels,
    patternRouteUpdatedChannels: patternRouteSync.updatedChannels,
  };
}

async function runRefreshModelsAndRebuildRoutes() {
  const refresh = await refreshModelsForAllActiveAccounts();
  const rebuild = await rebuildTokenRoutesFromAvailability();
  return { refresh, rebuild };
}

// Injectable clock for tests (single-flight staleness uses wall time).
let refreshInflightNow: () => number = () => Date.now();
let refreshInflightStaleTakeoversForTests = 0;

/** Test hook: override the clock used by the single-flight staleness guard. */
export function __setRefreshInflightClockForTests(clock: { now: () => number }): void {
  refreshInflightNow = clock.now;
}

/** Test hook: number of times a fresh pass took over an in-flight (stale) pass. */
export function __getAndResetRefreshInflightStaleTakeoversForTests(): number {
  const value = refreshInflightStaleTakeoversForTests;
  refreshInflightStaleTakeoversForTests = 0;
  return value;
}

export async function refreshModelsAndRebuildRoutes() {
  const nowMs = refreshInflightNow();
  if (
    inFlightRefreshModelsAndRebuildRoutes
    && nowMs - inFlightRefreshModelsAndRebuildRoutesHeartbeatMs < REFRESH_INFLIGHT_MAX_IDLE_MS
  ) {
    return inFlightRefreshModelsAndRebuildRoutes;
  }
  if (inFlightRefreshModelsAndRebuildRoutes) {
    refreshInflightStaleTakeoversForTests += 1;
  }

  let run!: Promise<{
    refresh: ModelRefreshResult[];
    rebuild: Awaited<ReturnType<typeof rebuildTokenRoutesFromAvailability>>;
  }>;
  run = (async () => {
    try {
      return await runRefreshModelsAndRebuildRoutes();
    } finally {
      // Identity guard: never clear a newer run that replaced a stale one.
      if (inFlightRefreshModelsAndRebuildRoutes === run) {
        inFlightRefreshModelsAndRebuildRoutes = null;
      }
    }
  })();
  inFlightRefreshModelsAndRebuildRoutes = run;
  inFlightRefreshModelsAndRebuildRoutesHeartbeatMs = nowMs;
  return run;
}
