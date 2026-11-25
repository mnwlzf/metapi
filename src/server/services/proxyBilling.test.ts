import { beforeEach, describe, expect, it, vi } from 'vitest';

const estimateProxyCostMock = vi.fn();
const buildProxyBillingDetailsMock = vi.fn();

const { resolveUpstreamGroupRateMock } = vi.hoisted(() => ({
  resolveUpstreamGroupRateMock: vi.fn(),
}));

vi.mock('./modelPricingService.js', () => ({
  estimateProxyCost: (...args: unknown[]) => estimateProxyCostMock(...args),
  buildProxyBillingDetails: (...args: unknown[]) => buildProxyBillingDetailsMock(...args),
}));

vi.mock('./upstreamGroupRateResolver.js', () => ({
  resolveUpstreamGroupRate: (...args: unknown[]) => resolveUpstreamGroupRateMock(...args),
}));

import { resolveProxyLogBilling } from './proxyBilling.js';

const UNKNOWN_GROUP_RATE = { known: false, rate: null, source: null, groupKey: 'default' };

beforeEach(() => {
  resolveUpstreamGroupRateMock.mockReset();
  resolveUpstreamGroupRateMock.mockReturnValue(UNKNOWN_GROUP_RATE);
});

describe('resolveProxyLogBilling', () => {
  it('uses billing breakdown total when the standalone estimate is zero', async () => {
    estimateProxyCostMock.mockResolvedValue(0);
    buildProxyBillingDetailsMock.mockResolvedValue({
      usage: {
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        billablePromptTokens: 55_347,
      },
      pricing: {
        modelRatio: 0.1,
        completionRatio: 2,
        cacheRatio: 0.2,
        cacheCreationRatio: 1,
        groupRatio: 1,
      },
      breakdown: {
        inputPerMillion: 0.2,
        outputPerMillion: 0.4,
        cacheReadPerMillion: 0.04,
        cacheCreationPerMillion: 0.2,
        totalCost: 0.011132,
      },
    });

    const result = await resolveProxyLogBilling({
      site: {
        id: 138,
        url: 'https://aitoken.forum',
        platform: 'new-api',
      },
      account: { id: 1 },
      modelName: 'DeepSeek-V4-Flash-0731',
      parsedUsage: {
        promptTokens: 55_347,
        completionTokens: 158,
        totalTokens: 55_505,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        promptTokensIncludeCache: true,
      },
      resolvedUsage: {
        promptTokens: 55_347,
        completionTokens: 158,
        totalTokens: 55_505,
        recoveredFromSelfLog: false,
        estimatedCostFromQuota: 0,
        selfLogBillingMeta: null,
      },
    });

    expect(result.estimatedCost).toBe(0.011132);
    expect(result.billingDetails?.breakdown.totalCost).toBe(0.011132);
    // No quota was reported → the recorded amount is this instance's estimate.
    expect(result.billingDetails).toMatchObject({
      basis: 'new-api-ratio',
      platform: 'new-api',
      computedTotalCost: 0.011132,
    });
    expect(result.billingDetails?.quota).toBeUndefined();
  });

  it('uses self-log billing metadata for detail breakdown while preserving quota-derived total cost', async () => {
    estimateProxyCostMock.mockResolvedValue(0.010001);
    buildProxyBillingDetailsMock.mockResolvedValue({
      usage: {
        cacheReadTokens: 145692,
        cacheCreationTokens: 945,
        billablePromptTokens: 1,
      },
      pricing: {
        modelRatio: 2.5,
        completionRatio: 5,
        cacheRatio: 0.1,
        cacheCreationRatio: 1.25,
        groupRatio: 1,
      },
      breakdown: {
        inputPerMillion: 5,
        outputPerMillion: 25,
        cacheReadPerMillion: 0.5,
        cacheCreationPerMillion: 6.25,
        totalCost: 0.083057,
      },
    });

    const result = await resolveProxyLogBilling({
      site: {
        id: 1,
        url: 'https://new-api.example.com',
        platform: 'new-api',
      },
      account: {
        id: 2,
      },
      modelName: 'claude-haiku-4-5-20251001',
      parsedUsage: {
        promptTokens: 146638,
        completionTokens: 172,
        totalTokens: 146810,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        promptTokensIncludeCache: null,
      },
      resolvedUsage: {
        promptTokens: 146638,
        completionTokens: 172,
        totalTokens: 146810,
        recoveredFromSelfLog: true,
        estimatedCostFromQuota: 0.083056,
        selfLogBillingMeta: {
          modelRatio: 2.5,
          completionRatio: 5,
          cacheRatio: 0.1,
          cacheCreationRatio: 1.25,
          groupRatio: 1,
          cacheReadTokens: 145692,
          cacheCreationTokens: 945,
          promptTokensIncludeCache: true,
        },
      },
    });

    expect(estimateProxyCostMock).toHaveBeenCalledWith(expect.objectContaining({
      cacheReadTokens: 145692,
      cacheCreationTokens: 945,
      promptTokensIncludeCache: true,
      billingPricingOverride: {
        modelRatio: 2.5,
        completionRatio: 5,
        cacheRatio: 0.1,
        cacheCreationRatio: 1.25,
        groupRatio: 1,
      },
    }));
    expect(result.estimatedCost).toBe(0.083056);
    expect(result.billingDetails).toMatchObject({
      basis: 'upstream-quota',
      platform: 'new-api',
      computedTotalCost: 0.083057,
      quota: { amount: 0.083056, applied: true },
      usage: {
        cacheReadTokens: 145692,
        cacheCreationTokens: 945,
        billablePromptTokens: 1,
      },
      pricing: {
        modelRatio: 2.5,
        completionRatio: 5,
        cacheRatio: 0.1,
        cacheCreationRatio: 1.25,
        groupRatio: 1,
      },
      breakdown: {
        inputPerMillion: 5,
        outputPerMillion: 25,
        cacheReadPerMillion: 0.5,
        cacheCreationPerMillion: 6.25,
        totalCost: 0.083057,
      },
    });
  });

  it('records the upstream quota as the basis for sub2api and keeps the local estimate beside it', async () => {
    // sub2api bills per-token × group multiplier, so the local new-api-style
    // ratio estimate is a different price basis. The recorded amount must be the
    // upstream's quota, and the mismatch must stay visible in the detail row.
    estimateProxyCostMock.mockResolvedValue(0.000091);
    buildProxyBillingDetailsMock.mockResolvedValue({
      usage: {
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        billablePromptTokens: 31,
      },
      pricing: { modelRatio: 0.33, completionRatio: 3, cacheRatio: 0.0333, cacheCreationRatio: 1, groupRatio: 1 },
      breakdown: {
        inputPerMillion: 0.66,
        outputPerMillion: 1.98,
        cacheReadPerMillion: 0.022,
        cacheCreationPerMillion: 0.66,
        totalCost: 0.000091,
      },
    });

    const result = await resolveProxyLogBilling({
      site: { id: 2, url: 'https://sub.sailapi.top', platform: 'sub2api' },
      account: { id: 2 },
      modelName: 'deepseek-v4-pro',
      parsedUsage: {
        promptTokens: 31,
        completionTokens: 36,
        totalTokens: 67,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        promptTokensIncludeCache: true,
      },
      resolvedUsage: {
        promptTokens: 31,
        completionTokens: 36,
        totalTokens: 67,
        recoveredFromSelfLog: true,
        estimatedCostFromQuota: 0.00015,
        selfLogBillingMeta: null,
      },
    });

    expect(result.estimatedCost).toBe(0.00015);
    expect(result.billingDetails).toMatchObject({
      basis: 'upstream-quota',
      platform: 'sub2api',
      computedTotalCost: 0.000091,
      quota: { amount: 0.00015, applied: true },
    });
  });

  it('snapshots the group multiplier resolved while billing', async () => {
    resolveUpstreamGroupRateMock.mockReturnValue({
      known: true,
      rate: 0.12,
      source: 'catalog',
      groupKey: '270',
    });
    estimateProxyCostMock.mockResolvedValue(0.000221);
    buildProxyBillingDetailsMock.mockResolvedValue({
      basis: 'sub2api-per-token',
      estimateBasis: 'sub2api-per-token',
      perToken: {
        inputPerMillion: 0.9,
        outputPerMillion: 2.7,
        cacheReadPerMillion: 0.09,
        cacheCreationPerMillion: 0.9,
        groupRate: 0.12,
        source: 'catalog',
      },
      usage: {
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        billablePromptTokens: 1200,
      },
      breakdown: {
        inputPerMillion: 0.108,
        outputPerMillion: 0.324,
        cacheReadPerMillion: 0.0108,
        cacheCreationPerMillion: 0.108,
        totalCost: 0.000221,
      },
    });

    const result = await resolveProxyLogBilling({
      site: { id: 3, url: 'https://sub.sailapi.top', platform: 'sub2api' },
      account: { id: 4 },
      modelName: 'deepseek-v4.1-flash',
      tokenGroup: '270',
      parsedUsage: {
        promptTokens: 1200,
        completionTokens: 400,
        totalTokens: 1600,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        promptTokensIncludeCache: true,
      },
      resolvedUsage: {
        promptTokens: 1200,
        completionTokens: 400,
        totalTokens: 1600,
        recoveredFromSelfLog: false,
        estimatedCostFromQuota: 0,
        selfLogBillingMeta: null,
      },
    });

    expect(resolveUpstreamGroupRateMock).toHaveBeenCalledWith({
      site: { id: 3 },
      account: { id: 4 },
      token: { tokenGroup: '270' },
    });
    // The caches that hold a group multiplier expire in 5-10 minutes, so the log
    // row keeps its own answer instead of rendering "?" minutes later.
    expect(result.billingDetails?.tokenGroupRate).toEqual({
      rate: 0.12,
      source: 'catalog',
      groupKey: '270',
    });
  });

  it('records nothing rather than assuming 1x when the group multiplier is unknown', async () => {
    estimateProxyCostMock.mockResolvedValue(0.01);
    buildProxyBillingDetailsMock.mockResolvedValue({
      usage: {
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        billablePromptTokens: 100,
      },
      pricing: {
        modelRatio: 1,
        completionRatio: 1,
        cacheRatio: 1,
        cacheCreationRatio: 1,
        groupRatio: 1,
      },
      breakdown: {
        inputPerMillion: 1,
        outputPerMillion: 1,
        cacheReadPerMillion: 1,
        cacheCreationPerMillion: 1,
        totalCost: 0.01,
      },
    });

    const result = await resolveProxyLogBilling({
      site: { id: 5, url: 'https://api.example.com', platform: 'new-api' },
      account: { id: 6 },
      modelName: 'gpt-5',
      tokenGroup: 'mystery',
      parsedUsage: {
        promptTokens: 100,
        completionTokens: 0,
        totalTokens: 100,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        promptTokensIncludeCache: true,
      },
      resolvedUsage: {
        promptTokens: 100,
        completionTokens: 0,
        totalTokens: 100,
        recoveredFromSelfLog: false,
        estimatedCostFromQuota: 0,
        selfLogBillingMeta: null,
      },
    });

    expect(result.billingDetails?.tokenGroupRate).toBeUndefined();
  });
});
