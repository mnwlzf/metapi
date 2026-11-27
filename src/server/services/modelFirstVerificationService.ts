import { and, eq, gte, like } from 'drizzle-orm';
import { db, schema } from '../db/index.js';
import { upsertSetting } from '../db/upsertSetting.js';
import {
  DEFAULT_FIRST_VERIFICATION_SETTINGS,
  classifyProbeModel,
  isLowPriorityVerification,
  parseFirstVerificationSettings,
  type FirstVerificationSettings,
} from './modelProbeQueuePolicy.js';

const SETTING_KEY = 'model_first_verification_settings';
const attempts = new Map<string, Array<{ at: number; media: boolean }>>();
const retryAfter = new Map<string, number>();
const runningCells = new Set<string>();
let reservationTail: Promise<unknown> = Promise.resolve();
let running = false;
let lastBatch: { finishedAt: string; probed: number; supported: number; notConfirmed: number } | null = null;

export async function getFirstVerificationSettings(): Promise<FirstVerificationSettings> {
  const row = await db.select({ value: schema.settings.value }).from(schema.settings)
    .where(eq(schema.settings.key, SETTING_KEY)).get();
  try { return parseFirstVerificationSettings(JSON.parse(row?.value || '{}')); }
  catch { return { ...DEFAULT_FIRST_VERIFICATION_SETTINGS }; }
}

export async function saveFirstVerificationSettings(value: unknown) {
  const settings = parseFirstVerificationSettings(value);
  await upsertSetting(SETTING_KEY, settings);
  return settings;
}

export function canRetryFirstVerification(cellKey: string): boolean {
  const after = retryAfter.get(cellKey) ?? 0;
  if (after > Date.now()) return false;
  retryAfter.delete(cellKey);
  return true;
}
export function finishFirstVerificationCell(cellKey: string) { runningCells.delete(cellKey); }
export function setFirstVerificationRunning(value: boolean) { running = value; }
export function finishFirstVerificationBatch(result: { probed: number; supported: number; notConfirmed: number }) {
  lastBatch = { ...result, finishedAt: new Date().toISOString() };
}

export async function getFirstVerificationBudget(settings?: FirstVerificationSettings) {
  const limits = settings ?? await getFirstVerificationSettings();
  const now = Date.now();
  for (const [key, until] of retryAfter) if (until <= now) retryAfter.delete(key);
  const hourStart = new Date(now - 60 * 60_000).toISOString();
  const day = new Date(now); day.setUTCHours(0, 0, 0, 0);
  // Query a calendar-date lower bound, then compare timestamps in JS. Logs
  // contain both SQL and ISO dates and this must work on every DB dialect.
  const start = new Date(Math.min(day.getTime(), now - 60 * 60_000));
  const rows = await db.select({
    runId: schema.probeLogs.runId,
    createdAt: schema.probeLogs.createdAt,
    category: schema.probeLogs.questionCategory,
    modelName: schema.probeLogs.modelName,
    cost: schema.probeLogs.estimatedCost,
  }).from(schema.probeLogs).where(and(
    like(schema.probeLogs.runId, 'fv-%'),
    gte(schema.probeLogs.createdAt, start.toISOString().slice(0, 10)),
  )).all();
  const counts = new Map<string, { hourly: number; media: number }>();
  let dailyCostUsd = 0;
  let unknownCostCount = 0;
  for (const row of rows) {
    const value = String(row.createdAt || '');
    const at = Date.parse(value.includes('T') ? value : `${value.replace(' ', 'T')}Z`);
    if (at >= Date.parse(hourStart)) {
      const count = counts.get(row.runId!) ?? { hourly: 0, media: 0 };
      count.hourly++;
      if (row.category === 'image' || row.category === 'video' || isLowPriorityVerification(classifyProbeModel(row.modelName))) count.media++;
      counts.set(row.runId!, count);
    }
    if (at >= day.getTime()) {
      dailyCostUsd += Number(row.cost || 0);
      if (row.cost == null) unknownCostCount++;
    }
  }
  for (const [runId, reservations] of attempts) {
    const recent = reservations.filter((attempt) => now - attempt.at < 60 * 60_000);
    if (!recent.length) { attempts.delete(runId); continue; }
    attempts.set(runId, recent);
    const recorded = counts.get(runId);
    counts.set(runId, {
      hourly: Math.max(recorded?.hourly ?? 0, recent.length),
      media: Math.max(recorded?.media ?? 0, recent.filter((attempt) => attempt.media).length),
    });
  }
  const hourlyUsed = [...counts.values()].reduce((sum, item) => sum + item.hourly, 0);
  const mediaHourlyUsed = [...counts.values()].reduce((sum, item) => sum + item.media, 0);
  const pauseReason = hourlyUsed >= limits.hourlyLimit ? '已达到每小时验证上限'
    : dailyCostUsd >= limits.dailyCostLimitUsd ? '已达到每日已记录费用上限' : null;
  return { hourlyUsed, mediaHourlyUsed, dailyCostUsd, unknownCostCount, pauseReason, running, lastBatch };
}

/** Reserve immediately before dispatch. All entry points share this guard. */
export function reserveFirstVerification(input: {
  runId: string; cellKey: string; media: boolean; settings: FirstVerificationSettings;
}): Promise<boolean> {
  const reservation = reservationTail.then(async () => {
    if (runningCells.has(input.cellKey) || !canRetryFirstVerification(input.cellKey)) return false;
    const list = attempts.get(input.runId) ?? [];
    const budget = await getFirstVerificationBudget(input.settings);
    if (budget.pauseReason || (input.media && budget.mediaHourlyUsed >= input.settings.mediaHourlyLimit)) return false;
    list.push({ at: Date.now(), media: input.media });
    attempts.set(input.runId, list);
    retryAfter.set(input.cellKey, Date.now() + 10 * 60_000);
    runningCells.add(input.cellKey);
    return true;
  });
  reservationTail = reservation.catch(() => {});
  return reservation;
}
