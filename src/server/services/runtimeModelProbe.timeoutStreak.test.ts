import { describe, expect, it } from 'vitest';

// A probe that TIMES OUT three times in a row must stop being 'inconclusive':
// the report distinguishes "the site answered and rejected this model" from
// "the site never answered", and the timeout streak is the evidence for the
// latter (prod: account 182/263 at 0% over 7 days, 28+4 models still
// available=1). The verdict is derived from probe_logs, and that row is
// written BEFORE the read, so the streak includes the current attempt.
describe('isProbeTimeoutStreakUnsupported', () => {
  it('requires the most recent probes to be timeouts, latest first', async () => {
    const { isProbeTimeoutStreakUnsupported } = await import('./runtimeModelProbe.js');
    expect(isProbeTimeoutStreakUnsupported(['timeout', 'timeout', 'timeout'])).toBe(true);
    expect(isProbeTimeoutStreakUnsupported(['timeout', 'timeout', 'success'])).toBe(false);
    expect(isProbeTimeoutStreakUnsupported(['timeout', 'failed', 'timeout'])).toBe(false);
    expect(isProbeTimeoutStreakUnsupported(['success'])).toBe(false);
    expect(isProbeTimeoutStreakUnsupported([])).toBe(false);
    expect(isProbeTimeoutStreakUnsupported([null, null, null])).toBe(false);
  });
});
