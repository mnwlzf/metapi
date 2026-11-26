import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('model disable policy boundaries', () => {
  it('keeps model override persistence and convergence in the service', () => {
    const route = readFileSync(new URL('../routes/api/accountsModelsRoutes.ts', import.meta.url), 'utf8');
    const policyEndpoints = route.slice(0, route.indexOf('// Remove manually added models'));
    expect(policyEndpoints).toContain('accountModelManagementService.js');
    expect(policyEndpoints).not.toMatch(/db\.(insert|update|delete|transaction)\(/);
    const service = readFileSync(new URL('./accountModelManagementService.ts', import.meta.url), 'utf8');
    expect(service).not.toMatch(/from ['"].*routes\//);
    expect(service).toContain('matchesDisabledModelName');
  });

  it('shares disable policy between routing and all probe families', () => {
    for (const file of ['modelService.ts', 'modelMarketplaceProbeService.ts', 'runtimeModelProbe.ts', 'channelRecoveryProbeService.ts']) {
      const source = readFileSync(new URL(file, import.meta.url), 'utf8');
      expect(source).toContain('STICKY_DISABLE_SOURCES');
      expect(source).toContain('isModelDisabledForSite');
    }
    for (const file of ['tokenRouterRouteCache.ts', 'patternRouteChannelSyncService.ts']) {
      expect(readFileSync(new URL(file, import.meta.url), 'utf8')).toContain('isModelDisabledForSite');
    }
  });
});
