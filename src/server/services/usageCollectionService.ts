import { createHash } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { db, schema } from '../db/index.js';
import { upsertSetting } from '../db/upsertSetting.js';
import type { UsageAccountState, UsageAccountView, UsageCollectionConfig, UsageCollectionPolicy, UsageDataset, UsageKeyCatalog, UsageOverview, UsageTaskKind } from '../shared/upstreamUsage.js';
import { getAdapter } from './platforms/index.js';
import { UsageDashboardError } from './platforms/usageDashboard.js';
import { getCredentialModeFromExtraConfig, getPlatformUserIdFromExtraConfig, getSub2ApiAuthFromExtraConfig, resolveProxyUrlFromExtraConfig } from './accountExtraConfig.js';
import { withAccountProxyOverride } from './siteProxy.js';
import { refreshSub2ApiManagedSessionSingleflight } from './sub2apiRefreshSingleflight.js';
import { getUsageCollectionConfig, listUsageCollectedRecords, readUsageAccountState, readUsageSetting, storeUsageAccountState, storeUsageCollectedRecord, storeUsageCollectionConfig } from './usageCollectionStore.js';
import { nextUsageCollectionAt, shiftUsageDay, usageDay, usageTaskInterval, validateUsageConfig, validateUsageRange } from './usageCollectionPolicy.js';

type Account = typeof schema.accounts.$inferSelect;
type Site = typeof schema.sites.$inferSelect;
type Candidate = { account: Account; site: Site; origin: string; identity: string; policy: UsageCollectionPolicy; duplicateOf: number | null; reason: string | null };
type OriginState = { requestTimes: number[]; nextAt: number; cooldownUntil: number; blocked?: string };
const kinds: UsageTaskKind[] = ['stats', 'keys', 'models', 'catalog'];
const ORIGINS_KEY = 'usage_collection_origins';
let timer: ReturnType<typeof setTimeout> | null = null;
let inFlight: Promise<void> | null = null;
let stopping = false;
let mutationQueue: Promise<unknown> = Promise.resolve();
let originWrites: Promise<unknown> = Promise.resolve();

function persistOrigins(origins: Record<string, OriginState>): Promise<void> {
  const pending = originWrites.then(() => upsertSetting(ORIGINS_KEY, origins));
  originWrites = pending.catch(() => undefined);
  return pending;
}

function serializeMutation<T>(callback: () => Promise<T>): Promise<T> {
  const pending = mutationQueue.then(callback, callback);
  mutationQueue = pending.catch(() => undefined);
  return pending;
}

function initialState(now: number): UsageAccountState {
  return {
    tasks: Object.fromEntries(kinds.map((kind, index) => [kind, { nextAt: now + 30_000 + Math.random() * 150_000 + index * 20_000, failures: 0 }])) as UsageAccountState['tasks'],
    cooldownUntil: 0, requestTimes: [], historyRequests: 0, pendingDays: [],
  };
}

function upstreamIdentity(account: Account): string {
  const configured = getPlatformUserIdFromExtraConfig(account.extraConfig);
  if (configured) return `user:${configured}`;
  // Claims are used only to prevent double counting, never as authentication.
  try {
    const claims = JSON.parse(Buffer.from(account.accessToken.split('.')[1], 'base64url').toString());
    const id = claims.sub ?? claims.user_id;
    if (typeof id === 'string' || typeof id === 'number') return `user:${id}`;
  } catch { /* opaque session credential */ }
  return `credential:${createHash('sha256').update(account.accessToken || String(account.id)).digest('hex')}`;
}

async function candidates(config: UsageCollectionConfig): Promise<Candidate[]> {
  const rows = await db.select().from(schema.accounts).innerJoin(schema.sites, eq(schema.accounts.siteId, schema.sites.id)).all();
  const seen = new Map<string, number>();
  return rows.filter((row: { accounts: Account; sites: Site }) => row.accounts.status === 'active' && row.sites.status !== 'disabled')
    .sort((a: { accounts: Account }, b: { accounts: Account }) => a.accounts.id - b.accounts.id)
    .map((row: { accounts: Account; sites: Site }) => {
      const account = row.accounts; const site = row.sites;
      let origin: string;
      try { origin = new URL(site.url).origin.toLowerCase(); } catch { origin = site.url; }
      const identity = `${origin}:${upstreamIdentity(account)}`;
      const adapter = getAdapter(site.platform);
      const reason = !adapter?.getUsageDashboard ? '该平台尚不支持实际消费汇总' :
        getCredentialModeFromExtraConfig(account.extraConfig) === 'apikey' || !account.accessToken ? '需要账号登录凭证，API Key 连接无法读取账号汇总' : null;
      const duplicateOf = reason ? null : seen.get(identity) ?? null;
      if (!reason && !duplicateOf) seen.set(identity, account.id);
      return { account, site, origin, identity, policy: { ...config.defaults, ...config.sites[String(site.id)] }, duplicateOf, reason };
    });
}

export async function getUsageOverview(): Promise<UsageOverview> {
  const config = await getUsageCollectionConfig();
  const timeZone = config.timeZone || 'Asia/Shanghai';
  const rows = await candidates(config);
  const records = await listUsageCollectedRecords();
  const origins = await readUsageSetting<Record<string, OriginState>>(ORIGINS_KEY) || {};
  const ids = new Set(rows.filter((row) => !row.duplicateOf && !row.reason).map((row) => row.account.id));
  const accounts: UsageAccountView[] = await Promise.all(rows.map(async (row) => ({
    accountId: row.account.id, siteId: row.site.id, siteName: row.site.name,
    accountName: row.account.username || `账号 ${row.account.id}`, balance: row.account.balance,
    supported: !row.reason, duplicateOf: row.duplicateOf, reason: row.reason, policy: row.policy,
    state: await (async () => {
      const state = await readUsageAccountState(row.account.id);
      if (!state) return null;
      const origin = origins[row.origin];
      state.cooldownUntil = Math.max(state.cooldownUntil, origin?.cooldownUntil || 0);
      state.blocked ||= origin?.blocked;
      const now = Date.now();
      const accountTimes = recent(state.requestTimes, now);
      const originTimes = recent(origin?.requestTimes || [], now);
      const budgetAt = Math.max(
        accountTimes.length >= row.policy.accountHourlyBudget ? accountTimes[0] + 3600_000 : 0,
        originTimes.length >= row.policy.originHourlyBudget ? originTimes[0] + 3600_000 : 0,
      );
      for (const task of Object.values(state.tasks)) task.nextAt = Math.max(task.nextAt, state.cooldownUntil, origin?.nextAt || 0, budgetAt);
      return state;
    })(),
  })));
  return {
    timeZone, today: usageDay(new Date(), timeZone), accounts,
    records: records.filter((record) => ids.has(record.accountId) && record.timeZone === timeZone && record.day >= shiftUsageDay(usageDay(new Date(), timeZone), -30)),
  };
}

async function updateConfig(input: unknown): Promise<UsageCollectionConfig> {
  const config = validateUsageConfig(input);
  const previous = await getUsageCollectionConfig();
  await storeUsageCollectionConfig(config);
  for (const row of await candidates(config)) {
    const state = await readUsageAccountState(row.account.id);
    if (!state) continue;
    const oldPolicy = { ...previous.defaults, ...previous.sites[String(row.site.id)] };
    if (previous.timeZone === config.timeZone && JSON.stringify(oldPolicy) === JSON.stringify(row.policy)) continue;
    for (const kind of kinds) state.tasks[kind].nextAt = nextUsageCollectionAt(Date.now(), usageTaskInterval(kind, row.policy), row.policy.jitterPercent);
    await storeUsageAccountState(row.account.id, state);
  }
  return config;
}

async function queueSync(input: { siteId?: number; start?: string; end?: string; resume?: boolean }): Promise<{ queued: number }> {
  const config = await getUsageCollectionConfig();
  const timeZone = config.timeZone || 'Asia/Shanghai'; const today = usageDay(new Date(), timeZone);
  if (input.start || input.end) validateUsageRange(input.start || '', input.end || '', today);
  const origins = await readUsageSetting<Record<string, OriginState>>(ORIGINS_KEY) || {};
  let queued = 0;
  for (const row of await candidates(config)) {
    if (row.reason || row.duplicateOf || !row.policy.enabled || (input.siteId && row.site.id !== input.siteId)) continue;
    const state = await readUsageAccountState(row.account.id) || initialState(Date.now());
    if (input.resume) {
      delete state.blocked;
      delete state.authRefreshPending; delete state.authRefreshAttempted;
      for (const task of Object.values(state.tasks)) { delete task.paused; delete task.error; }
      if (origins[row.origin]) delete origins[row.origin].blocked;
    }
    if (state.blocked || origins[row.origin]?.blocked) continue;
    if (input.start && input.end) {
      for (let day = input.start; day <= input.end; day = shiftUsageDay(day, 1)) {
        if (!state.pendingDays.includes(day)) state.pendingDays.push(day);
      }
    } else {
      // Repeated clicks retain the existing earlier task rather than multiplying requests.
      for (const kind of kinds) state.tasks[kind].nextAt = Math.min(state.tasks[kind].nextAt, Date.now() + 5000 + Math.random() * 25_000);
    }
    await storeUsageAccountState(row.account.id, state); queued++;
  }
  await persistOrigins(origins);
  return { queued };
}

function recent(times: number[], now: number): number[] { return times.filter((time) => time > now - 3600_000); }

async function collectOne(row: Candidate, state: UsageAccountState, origins: Record<string, OriginState>, kind: UsageTaskKind, day: string, history: boolean, timeZone: string) {
  const now = Date.now();
  const origin = origins[row.origin]; const task = state.tasks[kind];
  state.requestTimes = recent(state.requestTimes, now); origin.requestTimes = recent(origin.requestTimes, now);
  if (state.requestTimes.length >= row.policy.accountHourlyBudget || origin.requestTimes.length >= row.policy.originHourlyBudget) return;
  // Persist reservation before sending so a restart cannot reset the hourly budget.
  state.requestTimes.push(now); origin.requestTimes.push(now);
  origin.nextAt = now + (row.policy.gapMinSeconds + Math.random() * (row.policy.gapMaxSeconds - row.policy.gapMinSeconds)) * 1000;
  if (history) state.historyRequests++;
  task.lastAttemptAt = new Date(now).toISOString();
  await storeUsageAccountState(row.account.id, state);
  await persistOrigins(origins);
  try {
    if (state.authRefreshPending) {
      await withAccountProxyOverride(resolveProxyUrlFromExtraConfig(row.account.extraConfig), () => refreshSub2ApiManagedSessionSingleflight({
        account: row.account, site: row.site, currentAccessToken: row.account.accessToken, currentExtraConfig: row.account.extraConfig,
      }));
      state.authRefreshPending = false; state.authRefreshAttempted = true;
      // The original read remains queued; refresh is its own budgeted, spaced request.
      return;
    }
    const adapter = getAdapter(row.site.platform)!;
    let data: UsageDataset;
    await withAccountProxyOverride(resolveProxyUrlFromExtraConfig(row.account.extraConfig), async () => {
      if (kind === 'catalog') {
        const catalog = await adapter.getUsageKeyCatalog!(row.site.url, row.account.accessToken);
        const local = await db.select().from(schema.accountTokens).where(eq(schema.accountTokens.accountId, row.account.id)).all();
        data = catalog.filter((key) => key.upstreamId).map((key): UsageKeyCatalog => ({
          upstreamId: key.upstreamId!, name: key.name, group: key.tokenGroup || null,
          // Never link by name alone. Masked or ambiguous values stay unlinked.
          localTokenId: local.filter((token: { token: string }) => token.token === key.key).length === 1
            ? local.find((token: { token: string }) => token.token === key.key)!.id : null,
        }));
      } else {
        data = await adapter.getUsageDashboard!(row.site.url, row.account.accessToken, { kind, day, timeZone });
      }
    });
    const fetchedAt = new Date().toISOString();
    if ((kind === 'stats' || kind === 'keys') && usageDay(new Date(fetchedAt), timeZone) !== day) {
      throw new Error('采集跨越统计日期边界，等待下一轮重新获取');
    }
    await storeUsageCollectedRecord({ accountId: row.account.id, kind, day, timeZone, fetchedAt, data: data! });
    task.lastSuccessAt = fetchedAt; task.failures = 0; delete task.error;
    delete state.authRefreshAttempted;
    if (!history) task.nextAt = nextUsageCollectionAt(Date.now(), usageTaskInterval(kind, row.policy), row.policy.jitterPercent);
    else state.pendingDays = state.pendingDays.filter((pending) => pending !== day);
  } catch (error) {
    if (state.authRefreshPending) {
      state.blocked = '登录凭证刷新失败，请更新凭证后恢复采集';
      state.authRefreshPending = false;
    }
    task.failures++;
    task.error = error instanceof UsageDashboardError ? error.message : '消费采集失败，请检查上游连接、凭证或响应格式';
    const status = error instanceof UsageDashboardError ? error.status : /HTTP (401|403|404|429)/.exec(String(error))?.[1];
    if (Number(status) === 404 || Number(status) === 405) { task.paused = true; task.error = '上游不支持此汇总接口，可在修复后恢复采集'; }
    else if (Number(status) === 403) { origin.blocked = '上游拒绝访问，采集已暂停'; state.blocked = origin.blocked; }
    else if (Number(status) === 401) {
      // Queue the managed singleflight as a separate spaced request.
      const auth = getSub2ApiAuthFromExtraConfig(row.account.extraConfig);
      if (auth?.refreshToken && !state.authRefreshAttempted && !state.blocked) state.authRefreshPending = true;
      else state.blocked = '登录凭证已失效，请更新凭证后恢复采集';
    }
    const delay = Math.min(6 * 3600_000, 5 * 60_000 * 2 ** Math.min(task.failures - 1, 6)) * (1 + Math.random() * 0.3);
    const retryAfter = error instanceof UsageDashboardError ? error.retryAfterMs : 0;
    origin.cooldownUntil = Date.now() + Math.max(delay, retryAfter);
    state.cooldownUntil = origin.cooldownUntil;
    task.nextAt = Math.max(task.nextAt, origin.cooldownUntil);
  } finally {
    origin.nextAt = Date.now() + (row.policy.gapMinSeconds + Math.random() * (row.policy.gapMaxSeconds - row.policy.gapMinSeconds)) * 1000;
    await storeUsageAccountState(row.account.id, state);
    await persistOrigins(origins);
  }
}

async function runPass(): Promise<void> {
  const config = await getUsageCollectionConfig(); const now = Date.now();
  const timeZone = config.timeZone || 'Asia/Shanghai'; const today = usageDay(new Date(now), timeZone);
  const origins = await readUsageSetting<Record<string, OriginState>>(ORIGINS_KEY) || {};
  const records = await listUsageCollectedRecords();
  const jobs: Array<() => Promise<void>> = []; const claimed = new Set<string>();
  const ordered = await Promise.all((await candidates(config)).map(async (row) => ({ row, state: await readUsageAccountState(row.account.id) })));
  for (const { row } of ordered) {
    const sameOrigin = ordered.filter((other) => other.row.origin === row.origin && !other.row.reason && !other.row.duplicateOf);
    row.policy.originHourlyBudget = Math.min(...sameOrigin.map((other) => other.row.policy.originHourlyBudget));
  }
  ordered.sort((a, b) => {
    const latest = (state: UsageAccountState | null) => Math.max(0, ...Object.values(state?.tasks || {}).map((task) => Date.parse(task.lastAttemptAt || '') || 0));
    return latest(a.state) - latest(b.state);
  });
  for (const { row, state } of ordered) {
    if (row.reason || row.duplicateOf || !row.policy.enabled || claimed.has(row.origin)) continue;
    if (!state) { await storeUsageAccountState(row.account.id, initialState(now)); continue; }
    const origin = origins[row.origin] ||= { requestTimes: [], nextAt: 0, cooldownUntil: 0 };
    if (state.blocked || origin.blocked || state.cooldownUntil > now || origin.cooldownUntil > now || origin.nextAt > now) continue;
    if (recent(state.requestTimes, now).length >= row.policy.accountHourlyBudget || recent(origin.requestTimes, now).length >= row.policy.originHourlyBudget) continue;
    if (state.historyDay !== today) { state.historyDay = today; state.historyRequests = 0; }
    let kind = kinds.filter((key) => !state.tasks[key].paused && state.tasks[key].nextAt <= now)
      .sort((a, b) => state.tasks[a].nextAt - state.tasks[b].nextAt)[0];
    let day = today; let history = false;
    if (!kind && !state.tasks.models.paused && state.historyRequests < row.policy.historyDailyBudget) {
      const accountRecords = records.filter((r) => r.accountId === row.account.id && r.kind === 'models' && r.timeZone === timeZone);
      const wanted = [...state.pendingDays];
      for (let offset = 1; offset <= row.policy.historyDays; offset++) {
        const date = shiftUsageDay(today, -offset);
        const saved = accountRecords.find((r) => r.day === date);
        if (!saved || (offset <= 3 && now - Date.parse(saved.fetchedAt) > row.policy.correctionHours * 3600_000)) wanted.push(date);
      }
      const historicalDay = wanted.find((date) => date >= shiftUsageDay(today, -30) && date <= today);
      if (historicalDay) { kind = 'models'; day = historicalDay; history = true; }
    }
    if (!kind) continue;
    claimed.add(row.origin);
    jobs.push(() => collectOne(row, state, origins, kind, day, history, timeZone));
    if (jobs.length >= config.defaults.concurrency) break;
  }
  // Reservations for each origin have separate account states, but the shared
  // origin budget is written through one serial persistence chain.
  await Promise.all(jobs.map((job) => job()));
}

export function runUsageCollectionPass(): Promise<void> {
  if (inFlight) return inFlight;
  inFlight = serializeMutation(runPass).finally(() => { inFlight = null; });
  return inFlight;
}

export function updateUsageCollectionConfig(input: unknown): Promise<UsageCollectionConfig> {
  return serializeMutation(() => updateConfig(input));
}

export function queueUsageSync(input: { siteId?: number; start?: string; end?: string; resume?: boolean }): Promise<{ queued: number }> {
  return serializeMutation(() => queueSync(input));
}

export function startUsageCollectionScheduler(): void {
  if (timer) return;
  stopping = false;
  const tick = async () => {
    try { await runUsageCollectionPass(); } catch { console.warn('[Consumption] 后台采集调度失败，下轮重试'); }
    if (!stopping) timer = setTimeout(() => void tick(), 5000);
  };
  timer = setTimeout(() => void tick(), 5000);
}

export async function stopUsageCollectionScheduler(): Promise<void> {
  stopping = true; if (timer) clearTimeout(timer); timer = null;
  if (inFlight) await inFlight;
}
