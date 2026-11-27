import { DEFAULT_USAGE_POLICY, type UsageCollectionConfig, type UsageCollectionPolicy, type UsageTaskKind } from '../shared/upstreamUsage.js';

const limits: Record<Exclude<keyof UsageCollectionPolicy, 'enabled'>, [number, number]> = {
  statsMinutes: [5, 10080], keysMinutes: [5, 10080], modelsMinutes: [5, 10080],
  jitterPercent: [0, 80], gapMinSeconds: [2, 300], gapMaxSeconds: [2, 600],
  concurrency: [1, 4], accountHourlyBudget: [1, 120], originHourlyBudget: [1, 240],
  historyDays: [0, 30], historyDailyBudget: [0, 60], correctionHours: [6, 168],
};

export function validateUsagePolicy(input: unknown, partial = false): Partial<UsageCollectionPolicy> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('采集设置格式无效');
  const row = input as Record<string, unknown>;
  const output: Record<string, unknown> = partial ? {} : { ...DEFAULT_USAGE_POLICY };
  for (const [key, value] of Object.entries(row)) {
    if (key === 'enabled') {
      if (typeof value !== 'boolean') throw new Error('采集开关必须为布尔值');
    } else {
      const range = limits[key as keyof typeof limits];
      if (!range || typeof value !== 'number' || !Number.isInteger(value) || value < range[0] || value > range[1]) {
        throw new Error(`采集设置 ${key} 超出允许范围`);
      }
    }
    output[key] = value;
  }
  return output;
}

export function validateUsageConfig(input: unknown): UsageCollectionConfig {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('采集设置格式无效');
  const row = input as Record<string, unknown>;
  const timeZone = row.timeZone === undefined ? 'Asia/Shanghai' : row.timeZone;
  if (typeof timeZone !== 'string' || timeZone.length > 80) throw new Error('统计时区无效');
  try { new Intl.DateTimeFormat('en', { timeZone }).resolvedOptions(); } catch { throw new Error('统计时区无效'); }
  const defaults = validateUsagePolicy(row.defaults) as UsageCollectionPolicy;
  const sites: UsageCollectionConfig['sites'] = {};
  if (!row.sites || typeof row.sites !== 'object' || Array.isArray(row.sites)) throw new Error('站点设置格式无效');
  const entries = Object.entries(row.sites);
  if (entries.length > 1000) throw new Error('站点设置过多');
  for (const [id, value] of entries) {
    if (!/^[1-9]\d*$/.test(id)) throw new Error('站点 ID 无效');
    sites[id] = validateUsagePolicy(value, true);
    if (sites[id].concurrency !== undefined) throw new Error('跨站点并发只能在全局设置中修改');
  }
  for (const policy of [defaults, ...Object.values(sites).map((site) => ({ ...defaults, ...site }))]) {
    if (policy.gapMaxSeconds < policy.gapMinSeconds) throw new Error('随机请求间隔上限不能小于下限');
  }
  return { timeZone, defaults, sites };
}

export function nextUsageCollectionAt(now: number, minutes: number, jitterPercent: number, random = Math.random): number {
  return now + Math.round(minutes * 60_000 * (1 + (random() * 2 - 1) * jitterPercent / 100));
}

export function usageTaskInterval(kind: UsageTaskKind, policy: UsageCollectionPolicy): number {
  return kind === 'catalog' ? 1440 : policy[`${kind}Minutes`];
}

export function usageDay(now: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now);
  return ['year', 'month', 'day'].map((key) => parts.find((part) => part.type === key)!.value).join('-');
}

export function shiftUsageDay(day: string, offset: number): string {
  const date = new Date(`${day}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + offset);
  return date.toISOString().slice(0, 10);
}

export function validateUsageRange(start: string, end: string, today: string): void {
  const valid = (day: string) => /^\d{4}-\d{2}-\d{2}$/.test(day) && Number.isFinite(Date.parse(`${day}T12:00:00Z`)) && shiftUsageDay(day, 0) === day;
  if (!valid(start) || !valid(end) || start > end || end > today || start < shiftUsageDay(today, -30)) {
    throw new Error('请选择最近 31 天内的有效日期范围');
  }
}
