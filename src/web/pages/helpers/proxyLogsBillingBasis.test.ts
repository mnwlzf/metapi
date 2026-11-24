import { describe, expect, it } from 'vitest';
import {
  buildBillingProcessLines,
  formatBillingDetailSummary,
  resolveRateCapDisplay,
  type ProxyLogRenderItem,
} from './proxyLogsHelpers.js';

const usage = {
  promptTokens: 31,
  completionTokens: 36,
  totalTokens: 67,
  cacheReadTokens: 0,
  cacheCreationTokens: 0,
  billablePromptTokens: 31,
  promptTokensIncludeCache: true,
};

const breakdown = {
  inputPerMillion: 0.66,
  outputPerMillion: 1.98,
  cacheReadPerMillion: 0.022,
  cacheCreationPerMillion: 0.66,
  inputCost: 0.00002,
  outputCost: 0.000071,
  cacheReadCost: 0,
  cacheCreationCost: 0,
  totalCost: 0.000091,
};

const ratioPricing = {
  modelRatio: 0.33,
  completionRatio: 3,
  cacheRatio: 0.03333333333333333,
  cacheCreationRatio: 1,
  groupRatio: 1,
};

function logWith(billingDetails: ProxyLogRenderItem['billingDetails']): ProxyLogRenderItem {
  return { billingDetails } as ProxyLogRenderItem;
}

describe('billing detail display by basis', () => {
  it('shows the upstream charge first for a quota-based sub2api row', () => {
    const log = logWith({
      basis: 'upstream-quota',
      platform: 'sub2api',
      computedTotalCost: 0.000091,
      quota: { amount: 0.00015, applied: true },
      quotaType: 0,
      usage,
      pricing: ratioPricing,
      breakdown,
    });

    const summary = formatBillingDetailSummary(log) ?? '';
    expect(summary).toContain('实际扣费 $0.000150');
    expect(summary).toContain('本地推演 $0.000091');
    expect(summary).toContain('sub2api');
    expect(summary).not.toContain('模型倍率');

    const lines = buildBillingProcessLines(log);
    expect(lines[0]).toContain('站点实收：$0.000150');
    expect(lines[1]).toContain('折算单价');
    expect(lines.join('\n')).toContain('本地推演：$0.000091');
    // A quota-backed row must never be presented as "the ratio arithmetic".
    expect(lines.join('\n')).not.toContain('提示价格');
  });

  it('does not invent an estimate line when the two amounts agree', () => {
    const log = logWith({
      basis: 'upstream-quota',
      platform: 'new-api',
      computedTotalCost: 0.00015,
      quota: { amount: 0.00015, applied: true },
      quotaType: 0,
      usage,
      pricing: ratioPricing,
      breakdown,
    });

    const summary = formatBillingDetailSummary(log) ?? '';
    expect(summary).toContain('实际扣费 $0.000150');
    expect(summary).not.toContain('本地推演');
    expect(buildBillingProcessLines(log).join('\n')).not.toContain('本地推演');
  });

  it('keeps the ratio arithmetic for a locally estimated new-api row and labels it', () => {
    const log = logWith({
      basis: 'new-api-ratio',
      platform: 'new-api',
      quotaType: 0,
      usage,
      pricing: ratioPricing,
      breakdown,
    });

    const summary = formatBillingDetailSummary(log) ?? '';
    expect(summary).toContain('模型倍率 0.33');
    expect(summary).toContain('本地估算');
    expect(summary).not.toContain('sub2api');

    const lines = buildBillingProcessLines(log);
    expect(lines[0]).toContain('提示价格');
    expect(lines[lines.length - 1]).toContain('实际以站点扣费为准');
  });

  it('treats rows written before the basis existed as ratio-based, and warns on sub2api', () => {
    const legacy = logWith({
      platform: 'sub2api',
      quotaType: 0,
      usage,
      pricing: ratioPricing,
      breakdown,
    } as ProxyLogRenderItem['billingDetails']);

    const summary = formatBillingDetailSummary(legacy) ?? '';
    expect(summary).toContain('模型倍率 0.33');
    expect(summary).toContain('sub2api 站点口径不同');

    const lines = buildBillingProcessLines(legacy).join('\n');
    expect(lines).toContain('本地估算：sub2api 站点按站点单价 × 分组倍率计费');
  });

  it('renders the sub2api per-token basis as price x group multiplier', () => {
    const log = logWith({
      basis: 'sub2api-per-token',
      estimateBasis: 'sub2api-per-token',
      platform: 'sub2api',
      computedTotalCost: 0.00015,
      perToken: {
        inputPerMillion: 9,
        outputPerMillion: 27,
        cacheReadPerMillion: 0.3,
        cacheCreationPerMillion: 0,
        groupRate: 0.12,
        source: 'catalog',
      },
      quotaType: 0,
      usage,
      breakdown: {
        ...breakdown,
        inputPerMillion: 1.08,
        outputPerMillion: 3.24,
        totalCost: 0.00015,
      },
    });

    const summary = formatBillingDetailSummary(log) ?? '';
    expect(summary).toContain('站点单价');
    expect(summary).toContain('分组倍率 0.12');
    expect(summary).not.toContain('模型倍率');

    const lines = buildBillingProcessLines(log).join('\n');
    expect(lines).toContain('计价口径：sub2api 站点单价 × 分组倍率（0.12）');
    expect(lines).toContain('提示 $9 / 1M × 0.12 = $1.08 / 1M');
    expect(lines).toContain('补全 $27 / 1M × 0.12 = $3.24 / 1M');
    expect(lines).toContain('= $0.000150');
  });

  it('summarises the rate check for the list column', () => {
    expect(resolveRateCapDisplay({ tokenGroupRate: 0.12, downstreamKeyMaxUpstreamRate: 0.3 } as ProxyLogRenderItem))
      .toEqual({ label: '0.12 / <=0.3', tone: 'ok' });
    expect(resolveRateCapDisplay({ tokenGroupRate: 0.5, downstreamKeyMaxUpstreamRate: 0.3 } as ProxyLogRenderItem).tone)
      .toBe('over');
    expect(resolveRateCapDisplay({ tokenGroupRate: null, downstreamKeyMaxUpstreamRate: 0.3 } as ProxyLogRenderItem).tone)
      .toBe('unknown');
    expect(resolveRateCapDisplay({ tokenGroupRate: 0.12, downstreamKeyMaxUpstreamRate: null } as ProxyLogRenderItem))
      .toEqual({ label: '0.12 / 不限', tone: 'unknown' });
    expect(resolveRateCapDisplay({} as ProxyLogRenderItem)).toEqual({ label: '--', tone: 'unknown' });
  });

  it('returns nothing to render when the row has no billing details', () => {
    expect(formatBillingDetailSummary(logWith(null))).toBeNull();
    expect(buildBillingProcessLines(logWith(null))).toEqual([]);
  });
});
