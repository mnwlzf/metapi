import { describe, expect, it } from 'vitest';
import { parseUsageKeys, parseUsageModels, parseUsageStats, usageNumber } from './usageDashboard.js';

describe('upstream consumption parsing', () => {
  it('keeps actual charges distinct from original cost, preserving upstream precision', () => {
    const data = parseUsageStats({ today_actual_cost: 4.0684342128, today_cost: 22.92669474,
      today_requests: 291, today_tokens: 54461775, total_actual_cost: 242.9943880052,
      total_tokens: 7518625226, by_platform: [{ platform: 'deepseek', today_actual_cost: 1.4672645328, today_requests: 98 }] });
    expect(data.today.actualCost).toBe(4.0684342128);
    expect(data.today.originalCost).toBe(22.92669474);
    expect(data.total.totalTokens).toBe(7518625226);
    expect(data.platforms[0].today.actualCost).toBe(1.4672645328);
    expect(data.today.cacheReadTokens).toBeNull();
  });

  it('preserves free usage while rejecting missing or malformed actual amounts', () => {
    expect(usageNumber(0)).toBe(0);
    for (const value of [null, undefined, '', false, -1, Infinity, 'NaN']) expect(usageNumber(value)).toBeNull();
    expect(parseUsageKeys({ stats: { '53': { api_key_id: 53, today_actual_cost: 0, total_actual_cost: 0 } } })[0].todayActualCost).toBe(0);
    expect(() => parseUsageStats({ today_cost: 10 })).toThrow();
    expect(() => parseUsageModels({ models: [{ model: 'a', cost: 10 }] })).toThrow();
  });

  it('accepts an empty confirmed model period and never invents absent token fields', () => {
    expect(parseUsageModels({ models: [] })).toEqual([]);
    const [model] = parseUsageModels({ models: [{ model: 'deepseek', requests: 2, actual_cost: 0.00000012345, total_tokens: 42 }] });
    expect(model.actualCost).toBe(0.00000012345);
    expect(model.totalTokens).toBe(42);
    expect(model.cacheCreationTokens).toBeNull();
  });
});
