/** Monetary amounts are upstream USD values; null means unknown, never zero. */
export type UsageTaskKind = 'stats' | 'keys' | 'models' | 'catalog';
export type UsageMetrics = {
  actualCost: number | null;
  originalCost: number | null;
  requests: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadTokens: number | null;
  cacheCreationTokens: number | null;
  totalTokens: number | null;
};
export type UsageStats = {
  today: UsageMetrics;
  total: UsageMetrics;
  platforms: Array<{ platform: string; today: UsageMetrics; total: UsageMetrics }>;
};
export type UsageModel = UsageMetrics & { model: string };
export type UsageKey = { upstreamId: number; todayActualCost: number | null; recentActualCost: number | null };
export type UsageKeyCatalog = { upstreamId: number; name: string; group: string | null; localTokenId: number | null };
export type UsageDataset = UsageStats | UsageModel[] | UsageKey[] | UsageKeyCatalog[];
export type UsageCollectionPolicy = {
  enabled: boolean;
  statsMinutes: number;
  keysMinutes: number;
  modelsMinutes: number;
  jitterPercent: number;
  gapMinSeconds: number;
  gapMaxSeconds: number;
  concurrency: number;
  accountHourlyBudget: number;
  originHourlyBudget: number;
  historyDays: number;
  historyDailyBudget: number;
  correctionHours: number;
};
export type UsageCollectionConfig = {
  timeZone?: string;
  defaults: UsageCollectionPolicy;
  sites: Record<string, Partial<UsageCollectionPolicy>>;
};
export const DEFAULT_USAGE_POLICY: UsageCollectionPolicy = {
  enabled: true, statsMinutes: 30, keysMinutes: 30, modelsMinutes: 60,
  jitterPercent: 30, gapMinSeconds: 8, gapMaxSeconds: 20, concurrency: 2,
  accountHourlyBudget: 20, originHourlyBudget: 40, historyDays: 7,
  historyDailyBudget: 12, correctionHours: 24,
};
export type UsageTaskState = {
  nextAt: number;
  lastSuccessAt?: string;
  lastAttemptAt?: string;
  failures: number;
  error?: string;
  paused?: boolean;
};
export type UsageAccountState = {
  tasks: Record<UsageTaskKind, UsageTaskState>;
  cooldownUntil: number;
  blocked?: string;
  requestTimes: number[];
  historyDay?: string;
  historyRequests: number;
  pendingDays: string[];
  authRefreshPending?: boolean;
  authRefreshAttempted?: boolean;
};
export type UsageCollectedRecord = {
  accountId: number;
  kind: UsageTaskKind;
  day: string;
  timeZone: string;
  fetchedAt: string;
  data: UsageDataset;
};
export type UsageAccountView = {
  accountId: number;
  siteId: number;
  siteName: string;
  accountName: string;
  balance: number | null;
  supported: boolean;
  duplicateOf: number | null;
  reason: string | null;
  policy: UsageCollectionPolicy;
  state: UsageAccountState | null;
};
export type UsageOverview = {
  timeZone: string;
  today: string;
  accounts: UsageAccountView[];
  records: UsageCollectedRecord[];
};
