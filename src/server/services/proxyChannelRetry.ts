import { config } from '../config.js';
import {
  classifyProxyFailure,
  isLowValueFailoverFailureClass,
  type ProxyFailureClass,
} from './siteFailureClassification.js';

/** Soft ceiling so huge free-pool models (20+ channels) cannot thrash for minutes. */
export const PROXY_CHANNEL_FAILOVER_SOFT_ATTEMPT_CAP_DEFAULT = 8;
/** Probe timeout floor: avoid being too aggressive when full timeout is very small. */
export const PROXY_CHANNEL_FAILOVER_PROBE_FIRST_BYTE_TIMEOUT_FLOOR_MS = 10_000;
/** Probe timeout ceiling: avoid waiting too long when full timeout is very large. */
export const PROXY_CHANNEL_FAILOVER_PROBE_FIRST_BYTE_TIMEOUT_CAP_MS = 30_000;
/** Stop after this many consecutive low-value failure classes (WAF/model/quota/ambiguous). */
export const PROXY_CHANNEL_FAILOVER_LOW_VALUE_STREAK_STOP_DEFAULT = 2;

export function getProxyMaxChannelAttempts(): number {
  const attempts = Math.trunc(config.proxyMaxChannelAttempts || 0);
  return attempts > 0 ? attempts : 1;
}

/**
 * Soft cap for live multi-channel failover.
 * Env: PROXY_CHANNEL_FAILOVER_MAX_ATTEMPTS (default 8). Always at least 1.
 */
export function getProxyChannelFailoverSoftAttemptCap(): number {
  const raw = Math.trunc(
    (config as { proxyChannelFailoverMaxAttempts?: number }).proxyChannelFailoverMaxAttempts
      ?? PROXY_CHANNEL_FAILOVER_SOFT_ATTEMPT_CAP_DEFAULT,
  );
  return raw > 0 ? raw : PROXY_CHANNEL_FAILOVER_SOFT_ATTEMPT_CAP_DEFAULT;
}

/**
 * Total channel attempts (not retries) for a known eligible candidate pool.
 * Uses min(pool, softCap) so exhaustive walk still covers small pools fully.
 */
export function getProxyEffectiveMaxChannelAttempts(candidateCount: number): number {
  const count = Math.max(0, Math.trunc(candidateCount || 0));
  if (count <= 0) return getProxyMaxChannelAttempts();
  return Math.min(count, getProxyChannelFailoverSoftAttemptCap());
}

/**
 * Retry budget (maxRetries) scaled to the candidate pool.
 * Surfaces loop with `while (retryCount <= maxRetries)`.
 */
export function getProxyEffectiveMaxChannelRetries(candidateCount: number): number {
  return Math.max(0, getProxyEffectiveMaxChannelAttempts(candidateCount) - 1);
}

export function getProxyMaxChannelRetries(): number {
  return Math.max(0, getProxyMaxChannelAttempts() - 1);
}

/**
 * Configured aggregate wall-clock budget (ms). 0 means "use soft default on live path".
 * Set PROXY_CHANNEL_FAILOVER_BUDGET_MS explicitly to override.
 */
export function getProxyChannelFailoverBudgetMs(): number {
  const budget = Math.trunc((config as { proxyChannelFailoverBudgetMs?: number }).proxyChannelFailoverBudgetMs || 0);
  return budget > 0 ? budget : 0;
}
/**
 * Live-path wall-clock budget:
 * - single candidate → 0 (no multi-channel wait)
 * - multi candidate → explicit env budget if >0, else derived from first-byte
 *   timeout as `full + 2 * probe` so the first attempt plus two probe attempts
 *   fit before we give up.
 */
export function getProxyEffectiveFailoverBudgetMs(candidateCount: number): number {
  const count = Math.max(0, Math.trunc(candidateCount || 0));
  if (count <= 1) return 0;
  const explicit = getProxyChannelFailoverBudgetMs();
  if (explicit > 0) return explicit;
  return resolveProxyFailoverDerivedBudgetMs();
}

export function canRetryProxyChannel(
  retryCount: number,
  maxRetries: number = getProxyMaxChannelRetries(),
): boolean {
  return retryCount < Math.max(0, Math.trunc(maxRetries));
}

/**
 * Channel failover gate: attempt count + optional wall-clock budget so clients
 * do not wait through every slow channel until they time out themselves.
 */
export function canRetryProxyChannelWithBudget(
  retryCount: number,
  elapsedMs?: number | null,
  budgetMs: number = getProxyChannelFailoverBudgetMs(),
  maxRetries: number = getProxyMaxChannelRetries(),
): boolean {
  if (!canRetryProxyChannel(retryCount, maxRetries)) return false;
  if (!budgetMs || budgetMs <= 0) return true;
  if (typeof elapsedMs !== 'number' || !Number.isFinite(elapsedMs)) return true;
  return elapsedMs < budgetMs;
}

/**
 * First-byte timeout for channel attempt N.
 *
 * - Base window = the configured ceiling (`PROXY_FIRST_BYTE_TIMEOUT_SEC`).
 * - Adaptive window: when the site has a trusted recent first-byte EWMA, use
 *   `5 x EWMA` clamped to [30s, ceiling]. Scaling from each site's own history
 *   replaces the old fixed "fast if <=6s" gate: production 7-day site means
 *   span 4.6-33.5s, so the fixed gate almost never matched (it was effectively
 *   dead code). The 5x multiplier keeps ~99.5% of successful streaming
 *   requests (measured over 9.7k successes / 7 days) while cutting stalled
 *   attempts well before the 90s ceiling.
 * - full<=0 (disabled): returns 0 so explicit opt-out is respected
 *   end-to-end.
 */
export function resolveProxyChannelFirstByteTimeoutMs(
  _retryCount: number,
  observedTtftMs?: number | null,
): number {
  const fullMs = Math.max(0, Math.trunc((config.proxyFirstByteTimeoutSec || 0) * 1000));
  if (fullMs <= 0) return 0;
  // Adaptive try: scale from the site's own recent first-byte EWMA. The old
  // fixed gate (EWMA <= 6s -> 30s) was degenerate: max(30s, 3 x EWMA) can
  // never exceed 30s for EWMA <= 6s, and almost no real site met the gate.
  if (typeof observedTtftMs === 'number' && Number.isFinite(observedTtftMs)
    && observedTtftMs > 0) {
    const adaptiveMs = Math.trunc(observedTtftMs * PROXY_FIRST_BYTE_ADAPTIVE_MULTIPLIER);
    return Math.min(fullMs, Math.max(resolveProxyFirstByteFloorMs(), adaptiveMs));
  }
  return fullMs;
}

/**
 * The first-byte window floor, in ms.
 *
 * Provider set the default (30s) and the settings page can override it
 * (`proxy_first_byte_window_floor_sec`). Read per call, not at boot, because the
 * settings API mutates it at runtime. A saved value of 0 means "no floor" — the
 * adaptive estimate decides on its own.
 */
export function resolveProxyFirstByteFloorMs(): number {
  const configuredSec = Number((config as { proxyFirstByteWindowFloorSec?: number }).proxyFirstByteWindowFloorSec);
  if (Number.isFinite(configuredSec) && configuredSec >= 0) return Math.trunc(configuredSec * 1000);
  return PROXY_FIRST_BYTE_ADAPTIVE_FLOOR_MS;
}

/** Multiplier applied to a site's own first-byte EWMA. */
export const PROXY_FIRST_BYTE_ADAPTIVE_MULTIPLIER = 5;
/** Floor used when the configured window floor is unavailable (see resolveProxyFirstByteFloorMs). */
export const PROXY_FIRST_BYTE_ADAPTIVE_FLOOR_MS = 30_000;
/**
 * Historical hard-coded floor for the survival-curve estimator.
 *
 * Replaced by the settings-owned `proxy_first_byte_window_floor_sec` (default
 * 30s, see config.proxyFirstByteWindowFloorSec) after production evidence that
 * 8s cut reasoning models off before their first token and the resulting 408 was
 * indistinguishable from an upstream failure. Kept only so old references and
 * tests keep a name for the old value.
 */
export const PROXY_FIRST_BYTE_WINDOW_FLOOR_MS = 8_000;
/** Consecutive TIMEOUT failures tolerated before abandoning channel failover.
 *  Timeouts are the failure class that failover helps most; the 2-strike rule
 *  used for credential/model errors killed healthy candidates at peak load. */
export const PROXY_TIMEOUT_FAILOVER_STREAK_STOP_DEFAULT = 4;
/** Samples required before a site's TTFT profile is trusted. */
export const PROXY_FIRST_BYTE_ADAPTIVE_MIN_SAMPLES = 5;

/**
 * Derived failover budget when env does not pin an explicit value:
 * `full + probe` covers the first attempt plus one failover target that may
 * be slow-but-alive (first-byte probe timeout equals the full timeout, so a
 * relay site that legitimately needs 30-60s for the first byte is not killed
 * by a halved probe timeout). Total ≈ 2× the first-byte timeout, which fits
 * inside common client-side disconnect thresholds (60-120s).
 */
export function resolveProxyFailoverDerivedBudgetMs(): number {
  const fullMs = Math.max(0, Math.trunc((config.proxyFirstByteTimeoutSec || 0) * 1000));
  if (fullMs <= 0) return 0;
  return fullMs + resolveProxyChannelFirstByteTimeoutMs(1);
}

export type FailoverStreakState = {
  lowValueStreak: number;
  lastClass: ProxyFailureClass | null;
};

export function createFailoverStreakState(): FailoverStreakState {
  return { lowValueStreak: 0, lastClass: null };
}

/**
 * Update streak from a channel failure. Returns whether failover should stop
 * (no more channel switches) even if attempt budget remains.
 */
export function noteFailoverFailureAndShouldStop(
  state: FailoverStreakState,
  status: number,
  errorText?: string | null,
  stopAfter: number = PROXY_CHANNEL_FAILOVER_LOW_VALUE_STREAK_STOP_DEFAULT,
): boolean {
  const decision = classifyProxyFailure({ status, errorText });
  state.lastClass = decision.class;
  if (isLowValueFailoverFailureClass(decision.class)) {
    state.lowValueStreak += 1;
  } else {
    state.lowValueStreak = 0;
  }
  // Timeouts get a looser limit: a slow relay at peak load is exactly the case
  // channel failover fixes, so two of them must not end the request.
  const limit = decision.class === 'timeout'
    ? Math.max(1, Math.trunc(PROXY_TIMEOUT_FAILOVER_STREAK_STOP_DEFAULT))
    : Math.max(1, Math.trunc(stopAfter));
  return state.lowValueStreak >= limit;
}
