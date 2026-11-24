import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./modelPricingService.js', () => ({
  getCachedGroupRate: vi.fn(),
  requestRoutingReferenceCostWarmup: vi.fn(),
}));

vi.mock('./accountGroupCatalogService.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./accountGroupCatalogService.js')>();
  return {
    ...actual,
    peekAccountGroupCatalog: vi.fn(),
    requestAccountGroupCatalogWarmup: vi.fn(),
  };
});

const { getCachedGroupRate, requestRoutingReferenceCostWarmup } = await import('./modelPricingService.js');
const { peekAccountGroupCatalog, requestAccountGroupCatalogWarmup } = await import('./accountGroupCatalogService.js');
const {
  evaluateUpstreamRateLimit,
  requestUpstreamGroupRateWarmup,
  resolveUpstreamGroupRate,
} = await import('./upstreamGroupRateResolver.js');

const catalogOf = (groups: Array<{ id: string; name: string; rateMultiplier: number | null; status?: string }>) => (
  groups.map((group) => ({
    id: group.id,
    name: group.name,
    status: group.status ?? 'active',
    rateMultiplier: group.rateMultiplier,
  })) as any
);

const candidate = (tokenGroup: string | null) => ({
  site: { id: 7, url: 'https://up.example.com', platform: 'new-api', apiKey: null },
  account: { id: 11, accessToken: 'session=abc', apiToken: 'sk-up' },
  token: { tokenGroup },
  channel: { sourceModel: 'gpt-4o-mini' },
});

beforeEach(() => {
  vi.mocked(getCachedGroupRate).mockReset();
  vi.mocked(peekAccountGroupCatalog).mockReset();
  vi.mocked(requestRoutingReferenceCostWarmup).mockReset();
  vi.mocked(requestAccountGroupCatalogWarmup).mockReset();
});

describe('resolveUpstreamGroupRate', () => {
  it('reads the group ratio from the pricing catalog first', () => {
    vi.mocked(getCachedGroupRate).mockReturnValue(0.8);

    const resolution = resolveUpstreamGroupRate(candidate('vip'));

    expect(resolution).toEqual({ known: true, rate: 0.8, source: 'pricing', groupKey: 'vip' });
    expect(getCachedGroupRate).toHaveBeenCalledWith({ siteId: 7, accountId: 11, groupKey: 'vip' });
    // The catalog is only consulted when pricing has no answer.
    expect(peekAccountGroupCatalog).not.toHaveBeenCalled();
  });

  it('falls back to the sub2api group catalog by numeric id', () => {
    vi.mocked(getCachedGroupRate).mockReturnValue(null);
    vi.mocked(peekAccountGroupCatalog).mockReturnValue(catalogOf([
      { id: '295', name: '福利pro不降智', rateMultiplier: 0.6 },
    ]));

    const resolution = resolveUpstreamGroupRate(candidate('295'));

    expect(resolution).toEqual({ known: true, rate: 0.6, source: 'catalog', groupKey: '295' });
  });

  it('resolves a named group through the catalog too', () => {
    vi.mocked(getCachedGroupRate).mockReturnValue(null);
    vi.mocked(peekAccountGroupCatalog).mockReturnValue(catalogOf([
      { id: '310', name: 'vip', rateMultiplier: 0.7 },
    ]));

    expect(resolveUpstreamGroupRate(candidate('vip'))).toEqual({
      known: true,
      rate: 0.7,
      source: 'catalog',
      groupKey: 'vip',
    });
  });

  it('treats an unbound token as the default group', () => {
    vi.mocked(getCachedGroupRate).mockReturnValue(1);
    vi.mocked(peekAccountGroupCatalog).mockReturnValue(null);

    const resolution = resolveUpstreamGroupRate(candidate(null));

    expect(resolution).toEqual({ known: true, rate: 1, source: 'pricing', groupKey: 'default' });
    expect(getCachedGroupRate).toHaveBeenCalledWith({ siteId: 7, accountId: 11, groupKey: 'default' });
  });

  it('reports unknown when neither source knows the group', () => {
    vi.mocked(getCachedGroupRate).mockReturnValue(null);
    vi.mocked(peekAccountGroupCatalog).mockReturnValue(null);

    expect(resolveUpstreamGroupRate(candidate('mystery'))).toEqual({
      known: false,
      rate: null,
      source: null,
      groupKey: 'mystery',
    });
  });

  it('does not treat an empty catalog as a 1x answer', () => {
    vi.mocked(getCachedGroupRate).mockReturnValue(null);
    vi.mocked(peekAccountGroupCatalog).mockReturnValue([]);

    expect(resolveUpstreamGroupRate(candidate('vip')).known).toBe(false);
  });
});

describe('requestUpstreamGroupRateWarmup', () => {
  it('warms both metadata sources', () => {
    requestUpstreamGroupRateWarmup(candidate('vip'));

    expect(requestAccountGroupCatalogWarmup).toHaveBeenCalledWith(11);
    expect(requestRoutingReferenceCostWarmup).toHaveBeenCalledWith(expect.objectContaining({
      site: expect.objectContaining({ id: 7, url: 'https://up.example.com', platform: 'new-api' }),
      account: expect.objectContaining({ id: 11 }),
      modelName: 'gpt-4o-mini',
    }));
  });

  it('skips the pricing warm-up when the site has no usable url', () => {
    requestUpstreamGroupRateWarmup({
      site: { id: 7, url: '', platform: 'new-api' },
      account: { id: 11 },
      token: { tokenGroup: 'vip' },
    });

    expect(requestAccountGroupCatalogWarmup).toHaveBeenCalledWith(11);
    expect(requestRoutingReferenceCostWarmup).not.toHaveBeenCalled();
  });
});

describe('evaluateUpstreamRateLimit', () => {
  it('allows everything when no ceiling is declared', () => {
    expect(evaluateUpstreamRateLimit(candidate('vip'), null)).toEqual({ allowed: true });
    expect(getCachedGroupRate).not.toHaveBeenCalled();
  });

  it('allows a hop priced exactly at the ceiling', () => {
    vi.mocked(getCachedGroupRate).mockReturnValue(0.6);

    expect(evaluateUpstreamRateLimit(candidate('vip'), 0.6)).toEqual({ allowed: true });
  });

  it('refuses a hop above the ceiling and names both rates', () => {
    vi.mocked(getCachedGroupRate).mockReturnValue(0.8);

    const verdict = evaluateUpstreamRateLimit(candidate('vip'), 0.6);

    expect(verdict.allowed).toBe(false);
    if (verdict.allowed) throw new Error('unreachable');
    expect(verdict.message).toContain('0.8');
    expect(verdict.message).toContain('0.6');
    expect(verdict.details).toMatchObject({
      upstreamRateLimit: 0.6,
      upstreamRate: 0.8,
      upstreamRateSource: 'pricing',
      upstreamRateUnknown: false,
    });
  });

  it('refuses unknown rates and asks for a warm-up', () => {
    vi.mocked(getCachedGroupRate).mockReturnValue(null);
    vi.mocked(peekAccountGroupCatalog).mockReturnValue(null);

    const verdict = evaluateUpstreamRateLimit(candidate('mystery'), 0.6);

    expect(verdict.allowed).toBe(false);
    if (verdict.allowed) throw new Error('unreachable');
    expect(verdict.message).toContain('未知');
    expect(verdict.details).toMatchObject({ upstreamRate: null, upstreamRateUnknown: true });
    expect(requestAccountGroupCatalogWarmup).toHaveBeenCalledWith(11);
  });

  it('treats 0 as a real ceiling (free groups only), not as "unset"', () => {
    vi.mocked(getCachedGroupRate).mockReturnValue(0.5);

    expect(evaluateUpstreamRateLimit(candidate('vip'), 0).allowed).toBe(false);

    vi.mocked(getCachedGroupRate).mockReturnValue(0);
    expect(evaluateUpstreamRateLimit(candidate('free'), 0)).toEqual({ allowed: true });
  });
});
