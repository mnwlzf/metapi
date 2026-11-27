import type { UsageMetrics, UsageModel, UsageStats, UsageKey } from '../../shared/upstreamUsage.js';

export class UsageDashboardError extends Error {
  constructor(public readonly status: number, public readonly retryAfterMs = 0) {
    super(status === 429 ? '上游限流，采集已退避' : `上游消费接口返回 HTTP ${status}`);
  }
}

export function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export function usageNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === '' || typeof value === 'boolean') return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function metrics(row: Record<string, unknown>, prefix = ''): UsageMetrics {
  const get = (key: string) => usageNumber(row[`${prefix}${key}`]);
  return {
    actualCost: get('actual_cost'), originalCost: get('cost'), requests: get('requests'),
    inputTokens: get('input_tokens'), outputTokens: get('output_tokens'),
    cacheReadTokens: get('cache_read_tokens'), cacheCreationTokens: get('cache_creation_tokens'),
    totalTokens: get('tokens'),
  };
}

export function parseUsageStats(payload: unknown): UsageStats {
  const row = record(payload);
  if (usageNumber(row.today_actual_cost) === null) throw new Error('上游未提供今日实际消费');
  const total = metrics(row, 'total_');
  // stats uses total_tokens, whereas model rows use total_tokens without a prefix.
  return {
    today: metrics(row, 'today_'), total,
    platforms: (Array.isArray(row.by_platform) ? row.by_platform : []).map((value) => {
      const item = record(value);
      return { platform: String(item.platform || 'unknown'), today: metrics(item, 'today_'), total: metrics(item, 'total_') };
    }),
  };
}

export function parseUsageModels(payload: unknown): UsageModel[] {
  const row = record(payload);
  if (!Array.isArray(row.models)) throw new Error('上游模型汇总格式不完整');
  return row.models.map((value) => {
    const item = record(value);
    if (!item.model || usageNumber(item.actual_cost) === null) throw new Error('上游模型记录缺少名称或实际费用');
    return { ...metrics(item), totalTokens: usageNumber(item.total_tokens), model: String(item.model) };
  });
}

export function parseUsageKeys(payload: unknown): UsageKey[] {
  const row = record(payload);
  if (!row.stats || typeof row.stats !== 'object' || Array.isArray(row.stats)) throw new Error('上游 Key 汇总格式不完整');
  return Object.entries(record(row.stats)).map(([id, value]) => {
    const item = record(value);
    const upstreamId = Number(item.api_key_id ?? id);
    if (!Number.isSafeInteger(upstreamId) || upstreamId <= 0) throw new Error('上游 Key ID 无效');
    return { upstreamId, todayActualCost: usageNumber(item.today_actual_cost), recentActualCost: usageNumber(item.total_actual_cost) };
  });
}
