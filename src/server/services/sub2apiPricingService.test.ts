import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * sub2api publishes absolute per-token prices and a per-group rate multiplier;
 * it has no new-api ratio table. The estimate must therefore be
 * `tokens x price x rate`, not the ratio arithmetic.
 */
const prices = [
  { modelName: 'deepseek-v4-pro', input: 9e-6, output: 2.7e-5, cacheRead: 3e-7, cacheWrite: 0 },
  { modelName: 'deepseek-v4.1-flash', input: 2e-6, output: 8e-6, cacheRead: 5e-8, cacheWrite: 0 },
];
const groups = [
  { id: '270', name: 'Deepseek（0.12倍率）', status: 'active' as const, rateMultiplier: 0.12 },
];

vi.mock('./platforms/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./platforms/index.js')>();
  return {
    ...actual,
    getAdapter: (platform: string) => (
      platform === 'sub2api'
        ? { getModelPriceCatalog: async () => prices }
        : actual.getAdapter(platform)
    ),
  };
});

vi.mock('./accountGroupCatalogService.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./accountGroupCatalogService.js')>();
  return { ...actual, loadAccountGroupCatalog: async () => groups };
});

const { buildProxyBillingDetails, estimateProxyCost } = await import('./modelPricingService.js');
const { __resetSub2apiPricingCacheForTests } = await import('./sub2apiPricingService.js');

const input = {
  site: { id: 2, url: 'https://sub.sailapi.top', platform: 'sub2api' },
  account: { id: 2, accessToken: 'jwt-token' },
  modelName: 'deepseek-v4-pro',
  promptTokens: 31,
  completionTokens: 36,
  totalTokens: 67,
  tokenGroup: '270',
};

beforeEach(() => {
  __resetSub2apiPricingCacheForTests();
});

describe('sub2api native pricing', () => {
  it('computes per-token price x group multiplier', async () => {
    const details = await buildProxyBillingDetails(input);

    expect(details).not.toBeNull();
    expect(details!.basis).toBe('sub2api-per-token');
    expect(details!.estimateBasis).toBe('sub2api-per-token');
    expect(details!.perToken).toMatchObject({
      inputPerMillion: 9,
      outputPerMillion: 27,
      groupRate: 0.12,
      source: 'catalog',
    });
    // 31 x 9e-6 x 0.12 + 36 x 2.7e-5 x 0.12 = 0.000150, the amount the site
    // actually charged for the same request.
    expect(details!.breakdown.totalCost).toBeCloseTo(0.00015, 6);
    // No ratio table was involved, so none is reported.
    expect(details!.pricing).toBeUndefined();
  });

  it('uses the same numbers for the standalone estimate', async () => {
    await expect(estimateProxyCost(input)).resolves.toBeCloseTo(0.00015, 6);
  });

  it('falls back to the ratio path when the model has no published price', async () => {
    __resetSub2apiPricingCacheForTests();
    const details = await buildProxyBillingDetails({ ...input, modelName: 'unknown-model-x' });
    // Either the ratio path returns something or nothing is known — the point is
    // that it must not invent sub2api per-token numbers for an unpriced model.
    expect(details?.basis).not.toBe('sub2api-per-token');
  });

  it('leaves non-sub2api platforms on the ratio path', async () => {
    __resetSub2apiPricingCacheForTests();
    const details = await buildProxyBillingDetails({
      ...input,
      site: { id: 3, url: 'https://new-api.example.com', platform: 'new-api' },
    });
    expect(details?.basis).not.toBe('sub2api-per-token');
  });
});
