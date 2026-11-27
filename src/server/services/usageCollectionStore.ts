import { eq } from 'drizzle-orm';
import { db, schema } from '../db/index.js';
import { upsertSetting } from '../db/upsertSetting.js';
import { readAdminSnapshot, writeAdminSnapshot } from './adminSnapshotStore.js';
import { DEFAULT_USAGE_POLICY, type UsageCollectedRecord, type UsageCollectionConfig, type UsageAccountState } from '../shared/upstreamUsage.js';
import { validateUsageConfig } from './usageCollectionPolicy.js';

export const USAGE_COLLECTION_NAMESPACE = 'upstream-consumption';
const CONFIG_KEY = 'usage_collection_config';

export async function readUsageSetting<T>(key: string): Promise<T | null> {
  const row = await db.select({ value: schema.settings.value }).from(schema.settings).where(eq(schema.settings.key, key)).get();
  try { return row?.value ? JSON.parse(row.value) as T : null; } catch { return null; }
}

export async function getUsageCollectionConfig(): Promise<UsageCollectionConfig> {
  const saved = await readUsageSetting<UsageCollectionConfig>(CONFIG_KEY);
  return saved ? validateUsageConfig(saved) : { timeZone: 'Asia/Shanghai', defaults: { ...DEFAULT_USAGE_POLICY }, sites: {} };
}

export async function storeUsageCollectionConfig(config: UsageCollectionConfig): Promise<void> {
  await upsertSetting(CONFIG_KEY, config);
}

export async function readUsageAccountState(accountId: number): Promise<UsageAccountState | null> {
  return readUsageSetting<UsageAccountState>(`usage_collection_state_${accountId}`);
}

export async function storeUsageAccountState(accountId: number, state: UsageAccountState): Promise<void> {
  await upsertSetting(`usage_collection_state_${accountId}`, state);
}

function snapshotKey(record: Pick<UsageCollectedRecord, 'accountId' | 'kind' | 'day' | 'timeZone'>): string {
  return `${record.accountId}:${record.timeZone}:${record.kind}:${record.day}`;
}

export async function storeUsageCollectedRecord(record: UsageCollectedRecord): Promise<void> {
  // Reuse durable admin snapshots. History is retained independently of the 20s UI cache.
  const retainedUntil = new Date(Date.parse(record.fetchedAt) + 400 * 86400_000).toISOString();
  await writeAdminSnapshot({ namespace: USAGE_COLLECTION_NAMESPACE, key: snapshotKey(record) }, {
    payload: record, generatedAt: record.fetchedAt, expiresAt: retainedUntil, staleUntil: retainedUntil,
  });
}

export async function readUsageCollectedRecord(identity: Pick<UsageCollectedRecord, 'accountId' | 'kind' | 'day' | 'timeZone'>) {
  return (await readAdminSnapshot<UsageCollectedRecord>({ namespace: USAGE_COLLECTION_NAMESPACE, key: snapshotKey(identity) }))?.payload ?? null;
}

export async function listUsageCollectedRecords(): Promise<UsageCollectedRecord[]> {
  const rows = await db.select({ payload: schema.adminSnapshots.payload }).from(schema.adminSnapshots)
    .where(eq(schema.adminSnapshots.namespace, USAGE_COLLECTION_NAMESPACE)).all();
  return rows.flatMap((row: { payload: string }) => {
    try { return [JSON.parse(row.payload) as UsageCollectedRecord]; } catch { return []; }
  });
}
