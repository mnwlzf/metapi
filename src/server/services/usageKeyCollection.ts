import type { UsageAccountState, UsageCollectedRecord, UsageKey, UsageKeyCatalog } from '../shared/upstreamUsage.js';

export function needsUsageKeyCatalog(state: UsageAccountState, catalog: UsageCollectedRecord | undefined): boolean {
  if (state.keyScan) return false;
  return !!state.catalogScan || !catalog || catalog.fetchedAt !== state.catalogCompleteAt
    || Date.parse(catalog.fetchedAt) <= Date.parse(state.tasks.keys.lastSuccessAt || '1970-01-01');
}

export function appendUsageCatalogPage(state: UsageAccountState, items: UsageKeyCatalog[], nextPage: number | null): UsageKeyCatalog[] | null {
  const scan = state.catalogScan ?? { page: 1, items: [] };
  const combined = [...scan.items, ...items];
  if (new Set(combined.map((key) => key.upstreamId)).size !== combined.length
    || combined.length > 10_000 || (nextPage !== null && (nextPage !== scan.page + 1 || nextPage > 100))) {
    delete state.catalogScan;
    throw new Error('上游 Key 目录分页不完整或重复');
  }
  if (nextPage !== null) { state.catalogScan = { page: nextPage, items: combined }; return null; }
  delete state.catalogScan;
  return combined;
}

export function usageKeyBatch(state: UsageAccountState, catalog: UsageCollectedRecord | undefined, day: string, timeZone: string): number[] {
  if (state.keyScan && (state.keyScan.day !== day || state.keyScan.timeZone !== timeZone)) delete state.keyScan;
  if (!state.keyScan) {
    if (!catalog || catalog.fetchedAt !== state.catalogCompleteAt) throw new Error('请先完成上游 Key 目录采集');
    const ids = (catalog.data as UsageKeyCatalog[]).map((key) => key.upstreamId);
    state.keyScan = { day, timeZone, ids, cursor: 0, items: [] };
  }
  return state.keyScan.ids.slice(state.keyScan.cursor, state.keyScan.cursor + 100);
}

export function appendUsageKeyBatch(state: UsageAccountState, ids: number[], items: UsageKey[]): UsageKey[] | null {
  const scan = state.keyScan!;
  if (items.length !== ids.length || new Set(items.map((key) => key.upstreamId)).size !== ids.length
    || items.some((key) => !ids.includes(key.upstreamId))) throw new Error('上游未返回完整 Key 消费批次');
  scan.items.push(...items); scan.cursor += ids.length;
  if (scan.cursor < scan.ids.length) return null;
  const result = scan.items;
  delete state.keyScan;
  return result;
}
