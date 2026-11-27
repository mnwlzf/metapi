import { describe, expect, it } from 'vitest';
import { DEFAULT_USAGE_POLICY } from '../shared/upstreamUsage.js';
import { nextUsageCollectionAt, shiftUsageDay, usageDay, validateUsageConfig, validateUsageRange } from './usageCollectionPolicy.js';

describe('consumption collection policy', () => {
  it('applies independently randomized intervals at both configured bounds', () => {
    expect(nextUsageCollectionAt(100, 60, 20, () => 0)).toBe(100 + 48 * 60_000);
    expect(nextUsageCollectionAt(100, 60, 20, () => 1)).toBe(100 + 72 * 60_000);
    expect(nextUsageCollectionAt(100, 60, 0, () => 0)).toBe(100 + 60 * 60_000);
  });
  it('rejects unbounded polling, inverted gaps and malformed site overrides', () => {
    const config = { defaults: DEFAULT_USAGE_POLICY, sites: {} };
    expect(validateUsageConfig(config)).toEqual({ ...config, timeZone: 'Asia/Shanghai' });
    expect(() => validateUsageConfig({ ...config, defaults: { statsMinutes: 0 } })).toThrow();
    expect(() => validateUsageConfig({ ...config, sites: { '1': { gapMinSeconds: 100, gapMaxSeconds: 20 } } })).toThrow();
    expect(() => validateUsageConfig({ ...config, sites: { '__proto__': null, bad: {} } })).toThrow();
    expect(() => validateUsageConfig({ ...config, sites: { '1': { concurrency: 3 } } })).toThrow();
    expect(() => validateUsageConfig({ ...config, timeZone: 'invalid/zone' })).toThrow();
    expect(validateUsageConfig({ ...config, timeZone: 'UTC', sites: { '1': { statsMinutes: 120, enabled: false } } }).sites['1']).toEqual({ statsMinutes: 120, enabled: false });
  });
  it('uses an explicit timezone at midnight and bounds historical requests', () => {
    expect(usageDay(new Date('2026-11-26T16:01:00Z'), 'Asia/Shanghai')).toBe('2026-11-27');
    expect(shiftUsageDay('2026-03-01', -1)).toBe('2026-02-28');
    expect(() => validateUsageRange('2026-11-21', '2026-11-27', '2026-11-27')).not.toThrow();
    expect(() => validateUsageRange('2026-02-30', '2026-11-27', '2026-11-27')).toThrow();
    expect(() => validateUsageRange('2026-11-28', '2026-11-28', '2026-11-27')).toThrow();
  });
});
