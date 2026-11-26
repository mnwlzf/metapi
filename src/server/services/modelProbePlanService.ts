import { and, eq, gte, sql } from 'drizzle-orm';
import { db, schema } from '../db/index.js';
import { upsertSetting } from '../db/upsertSetting.js';

export const MODEL_PROBE_PLAN_SETTING_KEY = 'model_probe_plan_overrides';
export const MODEL_PROBE_INTERVALS_HOURS = [1, 6, 12, 24, 72] as const;
export type ModelProbeIntervalHours = typeof MODEL_PROBE_INTERVALS_HOURS[number];
export type ProbeModelType = 'text' | 'image' | 'embedding' | 'rerank' | 'audio' | 'video' | 'other';

export function classifyProbeModel(modelName: string): ProbeModelType {
  const name = String(modelName || '').trim();
  if (/(^|[-_/])rerank(er)?($|[-_/])/i.test(name)) return 'rerank';
  if (/(^|[-_/])embedding(s)?($|[-_/])|(^|[-_/])embed($|[-_/])|(^|[-_/])(?:bge-(?!rerank)|gte-|e5-|voyage-)/i.test(name)) return 'embedding';
  if (/(^|[-_/])image(s)?($|[-_/])|dall[-_]?e|imagen|stable[-_]?diffusion|sdxl|flux|recraft|ideogram|playground/i.test(name)) return 'image';
  if (/(^|[-_/])(?:audio|tts|speech|whisper|transcri(?:be|ption)|voice)(?=$|[-_/])/i.test(name)) return 'audio';
  if (/(^|[-_/])(?:video|veo|sora|cogvideo)(?=$|[-_/])/i.test(name)) return 'video';
  if (!name || name.startsWith('__') || /(^|[-_/])moderation($|[-_/])/i.test(name)) return 'other';
  return 'text';
}

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
  const names = await db.select({ modelName: schema.tokenModelAvailability.modelName })
    .from(schema.tokenModelAvailability)
    .innerJoin(schema.accountTokens, eq(schema.tokenModelAvailability.tokenId, schema.accountTokens.id))
    .innerJoin(schema.accounts, eq(schema.accountTokens.accountId, schema.accounts.id))
    .innerJoin(schema.sites, eq(schema.accounts.siteId, schema.sites.id))
    .where(and(eq(schema.accountTokens.enabled, true), eq(schema.accounts.status, 'active'), eq(schema.sites.status, 'active')))
    .groupBy(schema.tokenModelAvailability.modelName).all();
  const accountNames = await db.select({ modelName: schema.modelAvailability.modelName })
    .from(schema.modelAvailability)
    .innerJoin(schema.accounts, eq(schema.modelAvailability.accountId, schema.accounts.id))
    .innerJoin(schema.sites, eq(schema.accounts.siteId, schema.sites.id))
    .where(and(eq(schema.accounts.status, 'active'), eq(schema.sites.status, 'active')))
    .groupBy(schema.modelAvailability.modelName).all();
  const models = Array.from(new Set([...names, ...accountNames]
    .map((row) => String(row.modelName || '').trim()).filter(Boolean)));
  if (models.length === 0) return { models: [], intervals: [...MODEL_PROBE_INTERVALS_HOURS] };
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
  return {
    intervals: [...MODEL_PROBE_INTERVALS_HOURS],
    models: models.map((modelName) => {
      const recentCalls = usage.get(modelName.toLowerCase()) || 0;
      const override = overrides[modelName.toLowerCase()] ?? null;
      return {
        modelName,
        type: classifyProbeModel(modelName),
        recentCalls,
        intervalHours: override ?? getDefaultProbeIntervalHours(modelName, recentCalls),
        automaticIntervalHours: getDefaultProbeIntervalHours(modelName, recentCalls),
        overridden: override !== null,
      };
    }).sort((a, b) => a.type.localeCompare(b.type) || a.modelName.localeCompare(b.modelName)),
  };
}
