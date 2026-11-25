import { and, eq } from 'drizzle-orm';
import {
  db,
  schema,
  hasProxyLogBillingDetailsColumn,
  hasProxyLogCacheTokensColumns,
  hasProxyLogClientColumns,
  hasProxyLogReasoningEffortColumn,
  hasProxyLogResponseModelColumn,
  hasProxyLogDownstreamApiKeyIdColumn,
  hasProxyLogStreamTimingColumns,
  hasProxyLogRequestTraceIdColumn,
  hasProxyLogTokenGroupRateColumn,
  hasProxyLogTokenIdColumn,
} from '../db/index.js';
import { canonicalizeModelName } from '../shared/modelCanonicalization.js';
import { emitProxyLogCreated } from './proxyLogEventBus.js';
import { getCurrentReasoningEffort } from './reasoningEffort.js';
import { getUpstreamResponseModel } from './upstreamResponseModel.js';
import { isHardConnectivityFailure } from './routeConnectivityLookup.js';
import { emptyConnectivityHealth, recordConnectivityAttempt, shouldMarkDisconnected } from './routeConnectivityPolicy.js';

export type ProxyLogInsertInput = {
  routeId?: number | null;
  channelId?: number | null;
  accountId?: number | null;
  downstreamApiKeyId?: number | null;
  modelRequested?: string | null;
  modelActual?: string | null;
  responseModel?: string | null;
  status?: string | null;
  httpStatus?: number | null;
  isStream?: boolean | null;
  firstByteLatencyMs?: number | null;
  latencyMs?: number | null;
  promptTokens?: number | null;
  completionTokens?: number | null;
  totalTokens?: number | null;
  cacheReadTokens?: number | null;
  cacheCreationTokens?: number | null;
  reasoningEffort?: string | null;
  /**
   * The token group's upstream multiplier this request billed at. Defaults to
   * whatever the billing payload recorded, so call sites that already compute
   * billing do not have to thread it through.
   */
  tokenGroupRate?: number | null;
  estimatedCost?: number | null;
  billingDetails?: unknown;
  clientFamily?: string | null;
  clientAppId?: string | null;
  clientAppName?: string | null;
  clientConfidence?: string | null;
  errorMessage?: string | null;
  requestTraceId?: string | null;
  tokenId?: number | null;
  retryCount?: number | null;
  createdAt?: string | null;
};

function buildProxyLogCoreSelectFields() {
  return {
    id: schema.proxyLogs.id,
    routeId: schema.proxyLogs.routeId,
    channelId: schema.proxyLogs.channelId,
    accountId: schema.proxyLogs.accountId,
    downstreamApiKeyId: schema.proxyLogs.downstreamApiKeyId,
    modelRequested: schema.proxyLogs.modelRequested,
    modelActual: schema.proxyLogs.modelActual,
    status: schema.proxyLogs.status,
    httpStatus: schema.proxyLogs.httpStatus,
    latencyMs: schema.proxyLogs.latencyMs,
    promptTokens: schema.proxyLogs.promptTokens,
    completionTokens: schema.proxyLogs.completionTokens,
    totalTokens: schema.proxyLogs.totalTokens,
    estimatedCost: schema.proxyLogs.estimatedCost,
    errorMessage: schema.proxyLogs.errorMessage,
    retryCount: schema.proxyLogs.retryCount,
    createdAt: schema.proxyLogs.createdAt,
  };
}

function buildProxyLogClientSelectFields() {
  return {
    clientFamily: schema.proxyLogs.clientFamily,
    clientAppId: schema.proxyLogs.clientAppId,
    clientAppName: schema.proxyLogs.clientAppName,
    clientConfidence: schema.proxyLogs.clientConfidence,
  };
}

function buildProxyLogStreamTimingSelectFields() {
  return {
    isStream: schema.proxyLogs.isStream,
    firstByteLatencyMs: schema.proxyLogs.firstByteLatencyMs,
  };
}

function buildProxyLogRequestTraceSelectFields() {
  return {
    requestTraceId: schema.proxyLogs.requestTraceId,
  };
}

function buildProxyLogTokenSelectFields() {
  return {
    tokenId: schema.proxyLogs.tokenId,
  };
}

type ProxyLogSelectFieldOptions = {
  includeBillingDetails?: boolean;
  includeCacheTokens?: boolean;
  includeClientFields?: boolean;
  includeStreamTimingFields?: boolean;
  includeRequestTraceId?: boolean;
  includeTokenGroupRate?: boolean;
  includeTokenId?: boolean;
};

function buildProxyLogSelectFields(options?: ProxyLogSelectFieldOptions) {
  return {
    ...buildProxyLogCoreSelectFields(),
    ...(options?.includeCacheTokens ? {
      cacheReadTokens: schema.proxyLogs.cacheReadTokens,
      cacheCreationTokens: schema.proxyLogs.cacheCreationTokens,
      reasoningEffort: schema.proxyLogs.reasoningEffort,
      responseModel: schema.proxyLogs.responseModel,
    } : {}),
    ...(options?.includeTokenGroupRate ? { tokenGroupRate: schema.proxyLogs.tokenGroupRate } : {}),
    ...(options?.includeStreamTimingFields ? buildProxyLogStreamTimingSelectFields() : {}),
    ...(options?.includeClientFields ? buildProxyLogClientSelectFields() : {}),
    ...(options?.includeBillingDetails ? { billingDetails: schema.proxyLogs.billingDetails } : {}),
    ...(options?.includeRequestTraceId ? buildProxyLogRequestTraceSelectFields() : {}),
    ...(options?.includeTokenId ? buildProxyLogTokenSelectFields() : {}),
  };
}

export function getProxyLogBaseSelectFields() {
  return buildProxyLogCoreSelectFields();
}

export type ProxyLogSelectFields = ReturnType<typeof buildProxyLogSelectFields>;

export type ResolvedProxyLogSelectFields = {
  includeBillingDetails: boolean;
  includeCacheTokens: boolean;
  includeClientFields: boolean;
  includeStreamTimingFields: boolean;
  includeRequestTraceId: boolean;
  includeTokenGroupRate: boolean;
  includeTokenId: boolean;
  fields: ProxyLogSelectFields;
};

/**
 * Derive the select-field set from the enabled capabilities.
 *
 * The fields are always a function of the flags, never hand-assembled: a legacy
 * retry path that rebuilt them by hand silently dropped whatever capability was
 * added last.
 */
function buildResolvedSelection(
  flags: Omit<ResolvedProxyLogSelectFields, 'fields'>,
): ResolvedProxyLogSelectFields {
  return { ...flags, fields: buildProxyLogSelectFields(flags) };
}

export async function resolveProxyLogSelectFields(options?: ProxyLogSelectFieldOptions) {
  const includeBillingDetails = options?.includeBillingDetails === true
    && await hasProxyLogBillingDetailsColumn();
  const includeCacheTokens = options?.includeCacheTokens !== false
    && await hasProxyLogCacheTokensColumns();
  const includeClientFields = options?.includeClientFields !== false
    && await hasProxyLogClientColumns();
  const includeStreamTimingFields = options?.includeStreamTimingFields !== false
    && await hasProxyLogStreamTimingColumns();
  const includeRequestTraceId = options?.includeRequestTraceId !== false
    && await hasProxyLogRequestTraceIdColumn();
  const includeTokenGroupRate = options?.includeTokenGroupRate !== false
    && await hasProxyLogTokenGroupRateColumn();
  const includeTokenId = options?.includeTokenId !== false
    && await hasProxyLogTokenIdColumn();

  return buildResolvedSelection({
    includeBillingDetails,
    includeCacheTokens,
    includeClientFields,
    includeStreamTimingFields,
    includeRequestTraceId,
    includeTokenGroupRate,
    includeTokenId,
  });
}

export async function withProxyLogSelectFields<T>(
  runner: (selection: ResolvedProxyLogSelectFields) => Promise<T>,
  options?: ProxyLogSelectFieldOptions,
): Promise<T> {
  let selection = await resolveProxyLogSelectFields(options);

  while (true) {
    try {
      return await runner(selection);
    } catch (error) {
      // A legacy database can predate any one of these columns. Drop exactly the
      // capability that failed and retry, keeping the rest of the selection.
      if (selection.includeBillingDetails && isMissingBillingDetailsColumnError(error)) {
        selection = buildResolvedSelection({ ...selection, includeBillingDetails: false });
        continue;
      }

      if (selection.includeCacheTokens && isMissingProxyLogCacheTokensColumnsError(error)) {
        selection = buildResolvedSelection({ ...selection, includeCacheTokens: false });
        continue;
      }

      if (selection.includeTokenGroupRate && isMissingProxyLogTokenGroupRateColumnError(error)) {
        selection = buildResolvedSelection({ ...selection, includeTokenGroupRate: false });
        continue;
      }

      if (selection.includeClientFields && isMissingProxyLogClientColumnsError(error)) {
        selection = buildResolvedSelection({ ...selection, includeClientFields: false });
        continue;
      }

      if (selection.includeStreamTimingFields && isMissingProxyLogStreamTimingColumnsError(error)) {
        selection = buildResolvedSelection({ ...selection, includeStreamTimingFields: false });
        continue;
      }

      if (selection.includeRequestTraceId && isMissingProxyLogRequestTraceIdColumnError(error)) {
        selection = buildResolvedSelection({ ...selection, includeRequestTraceId: false });
        continue;
      }

      if (selection.includeTokenId && isMissingProxyLogTokenIdColumnError(error)) {
        selection = buildResolvedSelection({ ...selection, includeTokenId: false });
        continue;
      }

      throw error;
    }
  }
}

export function parseProxyLogBillingDetails(value: unknown): Record<string, unknown> | null {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  if (typeof value !== 'string' || value.trim().length === 0) return null;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

export type ProxyLogBillingGroupRateSnapshot = {
  rate: number;
  source: 'pricing' | 'catalog';
  groupKey: string;
};

/**
 * Read the group multiplier the request was actually billed at out of a stored
 * `billing_details` payload.
 *
 * The multiplier is resolved from upstream metadata caches with a 5-10 minute
 * TTL, so a read-time re-resolution answers "unknown" for basically every
 * historical row. The value recorded while billing is the only stable answer,
 * which is why it is snapshotted there. Returns null when the row has no
 * snapshot (written before this was recorded, or the rate was genuinely
 * unknown at billing time) — never fall back to 1x.
 */
export function readProxyLogBillingGroupRate(value: unknown): ProxyLogBillingGroupRateSnapshot | null {
  const details = parseProxyLogBillingDetails(value);
  const raw = details?.tokenGroupRate;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  const rate = typeof record.rate === 'number' ? record.rate : Number.NaN;
  // 0 is a legitimate free-group multiplier; reject only unusable values.
  if (!Number.isFinite(rate) || rate < 0) return null;
  const source = record.source === 'pricing' || record.source === 'catalog'
    ? record.source
    : null;
  if (!source) return null;
  return {
    rate,
    source,
    groupKey: typeof record.groupKey === 'string' ? record.groupKey : '',
  };
}

function toNonNegativeIntOrNull(value: unknown): number | null {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.trunc(n);
}

function normalizeProxyLogStoreErrorMessage(error: unknown): string {
  const message = typeof error === 'object' && error && 'message' in error
    ? String((error as { message?: unknown }).message || '')
    : String(error || '');
  return message.toLowerCase();
}

export function isMissingBillingDetailsColumnError(error: unknown): boolean {
  const lowered = normalizeProxyLogStoreErrorMessage(error);
  return lowered.includes('billing_details')
    && (
      lowered.includes('does not exist')
      || lowered.includes('unknown column')
      || lowered.includes('no such column')
      || lowered.includes('has no column named')
    );
}

export function isMissingProxyLogCacheTokensColumnsError(error: unknown): boolean {
  const lowered = normalizeProxyLogStoreErrorMessage(error);
  return lowered.includes('cache_read_tokens')
    && (
      lowered.includes('does not exist')
      || lowered.includes('unknown column')
      || lowered.includes('no such column')
      || lowered.includes('has no column named')
    );
}

export function isMissingProxyLogReasoningEffortColumnError(error: unknown): boolean {
  const lowered = normalizeProxyLogStoreErrorMessage(error);
  return lowered.includes('reasoning_effort')
    && (
      lowered.includes('does not exist')
      || lowered.includes('unknown column')
      || lowered.includes('no such column')
      || lowered.includes('has no column named')
    );
}

export function isMissingProxyLogResponseModelColumnError(error: unknown): boolean {
  const lowered = normalizeProxyLogStoreErrorMessage(error);
  return lowered.includes('response_model')
    && (
      lowered.includes('does not exist')
      || lowered.includes('unknown column')
      || lowered.includes('no such column')
      || lowered.includes('has no column named')
    );
}

export function isMissingDownstreamApiKeyIdColumnError(error: unknown): boolean {
  const lowered = normalizeProxyLogStoreErrorMessage(error);
  return lowered.includes('downstream_api_key_id')
    && (
      lowered.includes('does not exist')
      || lowered.includes('unknown column')
      || lowered.includes('no such column')
      || lowered.includes('has no column named')
    );
}

export function isMissingProxyLogClientColumnsError(error: unknown): boolean {
  const lowered = normalizeProxyLogStoreErrorMessage(error);
  const hasClientColumnReference = [
    'client_family',
    'client_app_id',
    'client_app_name',
    'client_confidence',
  ].some((columnName) => lowered.includes(columnName));

  return hasClientColumnReference
    && (
      lowered.includes('does not exist')
      || lowered.includes('unknown column')
      || lowered.includes('no such column')
      || lowered.includes('has no column named')
    );
}

export function isMissingProxyLogStreamTimingColumnsError(error: unknown): boolean {
  const lowered = normalizeProxyLogStoreErrorMessage(error);
  const hasStreamTimingColumnReference = [
    'is_stream',
    'first_byte_latency_ms',
  ].some((columnName) => lowered.includes(columnName));

  return hasStreamTimingColumnReference
    && (
      lowered.includes('does not exist')
      || lowered.includes('unknown column')
      || lowered.includes('no such column')
      || lowered.includes('has no column named')
    );
}

export function isMissingProxyLogRequestTraceIdColumnError(error: unknown): boolean {
  const lowered = normalizeProxyLogStoreErrorMessage(error);
  return lowered.includes('request_trace_id')
    && (
      lowered.includes('does not exist')
      || lowered.includes('unknown column')
      || lowered.includes('no such column')
      || lowered.includes('has no column named')
    );
}

export function isMissingProxyLogTokenGroupRateColumnError(error: unknown): boolean {
  const lowered = normalizeProxyLogStoreErrorMessage(error);
  return lowered.includes('token_group_rate')
    && (
      lowered.includes('does not exist')
      || lowered.includes('unknown column')
      || lowered.includes('no such column')
      || lowered.includes('has no column named')
    );
}

export function isMissingProxyLogTokenIdColumnError(error: unknown): boolean {
  const lowered = normalizeProxyLogStoreErrorMessage(error);
  return lowered.includes('token_id')
    && (
      lowered.includes('does not exist')
      || lowered.includes('unknown column')
      || lowered.includes('no such column')
      || lowered.includes('has no column named')
    );
}


/**
 * Serialize the read-modify-write per (account, model). Concurrent proxy
 * requests for the same model used to race — each read the same window and
 * overwrote the other's update, so failure evidence was systematically lost
 * and a hard-broken channel could keep its connectivity bonus forever.
 */
const connectivityUpdateChains = new Map<string, Promise<void>>();

function updateModelConnectivityFromProxyLog(input: ProxyLogInsertInput): void {
  const accountId = Number(input.accountId);
  if (!Number.isFinite(accountId) || accountId <= 0) return;

  const status = String(input.status || '').toLowerCase();
  if (status !== 'success' && status !== 'failed') return;
  if (status === 'failed' && !isHardConnectivityFailure(status, input.httpStatus, input.errorMessage)) return;

  const modelName = String(input.modelActual || input.modelRequested || '').trim();
  if (!modelName) return;

  const key = `${accountId}\u0000${modelName}`;
  const previous = connectivityUpdateChains.get(key) ?? Promise.resolve();
  const next = previous
    .catch(() => undefined)
    .then(() => applyModelConnectivityUpdate(input))
    .catch(() => undefined)
    .finally(() => {
      if (connectivityUpdateChains.get(key) === next) connectivityUpdateChains.delete(key);
    });
  connectivityUpdateChains.set(key, next);
}

async function applyModelConnectivityUpdate(input: ProxyLogInsertInput): Promise<void> {
  const accountId = Number(input.accountId);
  if (!Number.isFinite(accountId) || accountId <= 0) return;

  const status = String(input.status || '').toLowerCase();
  if (status !== 'success' && status !== 'failed') return;

  // Only transport-level failures say anything about reachability; 4xx/429 are
  // request-shape or policy rejections already handled by the channel cooldown.
  if (status === 'failed' && !isHardConnectivityFailure(status, input.httpStatus, input.errorMessage)) return;

  const modelName = String(input.modelActual || input.modelRequested || '').trim();
  if (!modelName) return;

  const available = status === 'success';
  const latencyMs = typeof input.latencyMs === 'number' && Number.isFinite(input.latencyMs)
    ? Math.max(0, Math.round(input.latencyMs))
    : null;
  const checkedAt = input.createdAt || new Date().toISOString();

  try {
    const existing = await db.select({
      id: schema.modelAvailability.id,
      connectivity: schema.modelAvailability.connectivity,
      consecutiveHardFailures: schema.modelAvailability.consecutiveHardFailures,
      consecutiveSuccesses: schema.modelAvailability.consecutiveSuccesses,
      hardFailureBits: schema.modelAvailability.hardFailureBits,
      hardFailureSamples: schema.modelAvailability.hardFailureSamples,
    })
      .from(schema.modelAvailability)
      .where(and(
        eq(schema.modelAvailability.accountId, accountId),
        eq(schema.modelAvailability.modelName, modelName),
      ))
      .get();

    if (existing?.id) {
      const nextHealth = recordConnectivityAttempt({
        consecutiveHardFailures: existing.consecutiveHardFailures ?? 0,
        consecutiveSuccesses: existing.consecutiveSuccesses ?? 0,
        hardFailureBits: existing.hardFailureBits ?? 0,
        hardFailureSamples: existing.hardFailureSamples ?? 0,
      }, available ? 'success' : 'hard_failure');
      // A success is positive proof. A hard failure only flips the flag once the
      // streak/window policy says the channel is actually unreachable; a single
      // hiccup must not take a healthy channel out for the whole TTL.
      const nextConnectivity = available
        ? true
        : (shouldMarkDisconnected(nextHealth)
          ? false
          : (existing.connectivity === false ? false : (existing.connectivity ?? null)));
      await db.update(schema.modelAvailability)
        .set({
          connectivity: nextConnectivity,
          ...nextHealth,
          ...(latencyMs != null ? { latencyMs } : {}),
          checkedAt,
        })
        .where(eq(schema.modelAvailability.id, existing.id))
        .run();
      return;
    }

    // Create listing + connectivity only when traffic proves the model works.
    if (available) {
      await db.insert(schema.modelAvailability).values({
        accountId,
        modelName,
        available: true,
        connectivity: true,
        latencyMs,
        checkedAt,
        ...recordConnectivityAttempt(emptyConnectivityHealth(), 'success'),
      }).run();
    }
  } catch {
    // best-effort; never break proxy logging
  }
}

export async function insertProxyLog(input: ProxyLogInsertInput): Promise<void> {
  // Normalize the downstream-requested model name so provider prefixes
  // (e.g. "mimo/mimo-v2.5") and free/date aliases are collapsed to the
  // canonical key before persisting. model_actual keeps its raw upstream
  // name because that is what the channel forwards to the provider.
  const modelRequested = input.modelRequested
    ? (canonicalizeModelName(input.modelRequested) || input.modelRequested)
    : null;
  const baseValues = {
    routeId: input.routeId ?? null,
    channelId: input.channelId ?? null,
    accountId: input.accountId ?? null,
    modelRequested,
    modelActual: input.modelActual ?? null,
    status: input.status ?? null,
    httpStatus: input.httpStatus ?? null,
    latencyMs: input.latencyMs ?? null,
    promptTokens: input.promptTokens ?? null,
    completionTokens: input.completionTokens ?? null,
    totalTokens: input.totalTokens ?? null,
    estimatedCost: input.estimatedCost ?? null,
    errorMessage: input.errorMessage ?? null,
    retryCount: input.retryCount ?? 0,
    createdAt: input.createdAt ?? null,
  };
  const serializedBillingDetails = input.billingDetails == null
    ? null
    : JSON.stringify(input.billingDetails);
  const includeBillingDetails = serializedBillingDetails !== null
    && await hasProxyLogBillingDetailsColumn();
  // Cache split: prefer an explicit value, otherwise lift it from the billing
  // details the proxy surfaces already record (usage.cacheReadTokens /
  // cacheCreationTokens), so the usage log list can show real input without
  // threading the value through every record call site.
  const billingUsage = (input.billingDetails as {
    usage?: { cacheReadTokens?: unknown; cacheCreationTokens?: unknown };
  } | null | undefined)?.usage;
  const cacheReadTokens = input.cacheReadTokens ?? toNonNegativeIntOrNull(billingUsage?.cacheReadTokens);
  const cacheCreationTokens = input.cacheCreationTokens ?? toNonNegativeIntOrNull(billingUsage?.cacheCreationTokens);
  // Group multiplier: an explicit value wins, otherwise lift the one the billing
  // step resolved into its payload. It is persisted per row because upstream
  // reprices groups over time — a read-time re-derivation would answer "unknown"
  // for older rows and, worse, relabel a 0.01x request with today's 0.20x.
  const tokenGroupRate = input.tokenGroupRate
    ?? readProxyLogBillingGroupRate(input.billingDetails)?.rate
    ?? null;
  // Reasoning effort: an explicit value wins, otherwise use whatever the proxy
  // router captured for this request (chat: reasoning_effort, responses:
  // reasoning.effort).
  const reasoningEffort = input.reasoningEffort ?? getCurrentReasoningEffort();
  // Response model: the `model` the upstream itself reported for this request
  // (captured in upstreamResponseModel.ts while the payload was parsed).
  const responseModel = input.responseModel ?? getUpstreamResponseModel();
  const requestedCacheTokens = cacheReadTokens != null || cacheCreationTokens != null;
  const includeCacheTokens = requestedCacheTokens
    && await hasProxyLogCacheTokensColumns();
  const includeDownstreamApiKeyId = input.downstreamApiKeyId != null
    && await hasProxyLogDownstreamApiKeyIdColumn();
  const requestedClientFields = [
    input.clientFamily,
    input.clientAppId,
    input.clientAppName,
    input.clientConfidence,
  ].some((value) => value != null && String(value).trim().length > 0);
  const includeClientFields = requestedClientFields
    && await hasProxyLogClientColumns();
  const requestedStreamTimingFields = input.isStream != null || input.firstByteLatencyMs != null;
  const includeStreamTimingFields = requestedStreamTimingFields
    && await hasProxyLogStreamTimingColumns();
  const includeRequestTraceId = Boolean(input.requestTraceId && String(input.requestTraceId).trim())
    && await hasProxyLogRequestTraceIdColumn();
  const includeTokenId = input.tokenId != null && input.tokenId > 0
    && await hasProxyLogTokenIdColumn();
  const includeTokenGroupRate = tokenGroupRate != null
    && await hasProxyLogTokenGroupRateColumn();

  let allowBillingDetails = includeBillingDetails;
  let allowCacheTokens = includeCacheTokens;
  let allowReasoningEffort = reasoningEffort != null && await hasProxyLogReasoningEffortColumn();
  let allowResponseModel = responseModel != null && await hasProxyLogResponseModelColumn();
  let allowDownstreamApiKeyId = includeDownstreamApiKeyId;
  let allowClientFields = includeClientFields;
  let allowStreamTimingFields = includeStreamTimingFields;
  let allowRequestTraceId = includeRequestTraceId;
  let allowTokenId = includeTokenId;
  let allowTokenGroupRate = includeTokenGroupRate;

  while (true) {
    const values = {
      ...baseValues,
      ...(allowRequestTraceId
        ? { requestTraceId: input.requestTraceId ?? null }
        : {}),
      ...(allowTokenId ? { tokenId: input.tokenId } : {}),
      ...(allowStreamTimingFields
        ? {
          isStream: input.isStream ?? null,
          firstByteLatencyMs: input.firstByteLatencyMs ?? null,
        }
        : {}),
      ...(allowBillingDetails ? { billingDetails: serializedBillingDetails } : {}),
      ...(allowCacheTokens
        ? {
          cacheReadTokens,
          cacheCreationTokens,
        }
        : {}),
      ...(allowReasoningEffort ? { reasoningEffort } : {}),
      ...(allowResponseModel ? { responseModel } : {}),
      ...(allowTokenGroupRate ? { tokenGroupRate } : {}),
      ...(allowDownstreamApiKeyId ? { downstreamApiKeyId: input.downstreamApiKeyId } : {}),
      ...(allowClientFields
        ? {
          clientFamily: input.clientFamily ?? null,
          clientAppId: input.clientAppId ?? null,
          clientAppName: input.clientAppName ?? null,
          clientConfidence: input.clientConfidence ?? null,
        }
        : {}),
    };

    try {
      await db.insert(schema.proxyLogs).values(values).run();
      void updateModelConnectivityFromProxyLog(input);
      emitProxyLogCreated({
        id: 0,
        siteId: null,
        modelRequested: input.modelRequested ?? null,
        status: input.status ?? null,
        createdAt: input.createdAt ?? null,
      });
      return;
    } catch (error) {
      if (allowBillingDetails && isMissingBillingDetailsColumnError(error)) {
        allowBillingDetails = false;
        continue;
      }

      if (allowReasoningEffort && isMissingProxyLogReasoningEffortColumnError(error)) {
        allowReasoningEffort = false;
        continue;
      }

      if (allowResponseModel && isMissingProxyLogResponseModelColumnError(error)) {
        allowResponseModel = false;
        continue;
      }

      if (allowTokenGroupRate && isMissingProxyLogTokenGroupRateColumnError(error)) {
        allowTokenGroupRate = false;
        continue;
      }

      if (allowCacheTokens && isMissingProxyLogCacheTokensColumnsError(error)) {
        allowCacheTokens = false;
        continue;
      }

      if (allowDownstreamApiKeyId && isMissingDownstreamApiKeyIdColumnError(error)) {
        allowDownstreamApiKeyId = false;
        continue;
      }

      if (allowClientFields && isMissingProxyLogClientColumnsError(error)) {
        allowClientFields = false;
        continue;
      }

      if (allowStreamTimingFields && isMissingProxyLogStreamTimingColumnsError(error)) {
        allowStreamTimingFields = false;
        continue;
      }

      if (allowRequestTraceId && isMissingProxyLogRequestTraceIdColumnError(error)) {
        allowRequestTraceId = false;
        continue;
      }

      if (allowTokenId && isMissingProxyLogTokenIdColumnError(error)) {
        allowTokenId = false;
        continue;
      }

      throw error;
    }
  }
}
