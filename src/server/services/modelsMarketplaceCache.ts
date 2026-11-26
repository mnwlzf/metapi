type CacheEntry = { expiresAt: number; models: any[] };
const cache = new Map<'base' | 'pricing', CacheEntry>();

export function readModelsMarketplaceCache(includePricing: boolean): any[] | null {
  const key = includePricing ? 'pricing' : 'base';
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() >= entry.expiresAt) {
    cache.delete(key);
    return null;
  }
  return entry.models;
}

export function writeModelsMarketplaceCache(includePricing: boolean, models: any[]): void {
  cache.set(includePricing ? 'pricing' : 'base', {
    expiresAt: Date.now() + (includePricing ? 90_000 : 15_000),
    models,
  });
}

export function clearModelsMarketplaceCache(): void {
  cache.clear();
}
