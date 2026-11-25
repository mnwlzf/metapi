import { describe, expect, it } from 'vitest';
import { resolveTokenGroupDisplay } from './accountGroupCatalogService.js';
import type { UserGroupInfo } from './platforms/base.js';

const catalog: UserGroupInfo[] = [
  { id: '295', name: '福利pro不降智（0.1倍率）', status: 'active', rateMultiplier: 0.1, vendor: 'openai' },
  { id: '320', name: '已停用分组', status: 'inactive', rateMultiplier: 1, vendor: 'deepseek' },
  { id: '330', name: '无厂商分组', status: 'active', rateMultiplier: 0.5, vendor: null },
];

describe('resolveTokenGroupDisplay', () => {
  it('resolves a numeric group id to its name, status, multiplier and vendor', () => {
    expect(resolveTokenGroupDisplay(catalog, '295')).toEqual({
      name: '福利pro不降智（0.1倍率）',
      status: 'active',
      rateMultiplier: 0.1,
      vendor: 'openai',
    });
  });

  it('resolves a group that is stored by name', () => {
    expect(resolveTokenGroupDisplay(catalog, '已停用分组')).toEqual({
      name: '已停用分组',
      status: 'inactive',
      rateMultiplier: 1,
      vendor: 'deepseek',
    });
  });

  it('reports no vendor when upstream does not publish one', () => {
    expect(resolveTokenGroupDisplay(catalog, '330')).toEqual({
      name: '无厂商分组',
      status: 'active',
      rateMultiplier: 0.5,
      vendor: null,
    });
  });

  it('marks a key missing from a non-empty catalog as removed', () => {
    expect(resolveTokenGroupDisplay(catalog, '999')).toEqual({
      name: null,
      status: 'removed',
      rateMultiplier: null,
      vendor: null,
    });
  });

  it('treats an empty key or unreadable catalog as unknown instead of removed', () => {
    expect(resolveTokenGroupDisplay(catalog, '')).toEqual({
      name: null,
      status: 'unknown',
      rateMultiplier: null,
      vendor: null,
    });
    expect(resolveTokenGroupDisplay([], '295')).toEqual({
      name: null,
      status: 'unknown',
      rateMultiplier: null,
      vendor: null,
    });
  });
});
