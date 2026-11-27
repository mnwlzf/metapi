import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, create, type ReactTestRenderer, type ReactTestInstance } from 'react-test-renderer';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { DEFAULT_USAGE_POLICY, type UsageOverview } from '../../../server/shared/upstreamUsage.js';
import ConsumptionPanel from './ConsumptionPanel.js';
import { collectionStatus } from './CollectionStatusPanel.js';
import { emptyMetrics } from './consumptionModel.js';

const mocks = vi.hoisted(() => ({ get: vi.fn(), sync: vi.fn(), success: vi.fn(), error: vi.fn(), mobile: false }));
vi.mock('../../api.js', () => ({ api: { getConsumption: mocks.get, syncConsumption: mocks.sync } }));
vi.mock('../../components/Toast.js', () => ({ useToast: () => ({ success: mocks.success, error: mocks.error }) }));
vi.mock('../../components/useIsMobile.js', () => ({ useIsMobile: () => mocks.mobile }));

function fixture(): UsageOverview {
  const metrics = { ...emptyMetrics(), actualCost: 1.5, requests: 30, totalTokens: 12000 };
  return {
    today: '2026-11-27', timeZone: 'Asia/Shanghai',
    accounts: [1, 2].map((id) => ({ accountId: id, siteId: id, siteName: `站点${id}`, accountName: `账号${id}`, supported: true, duplicateOf: null, balance: 10, reason: null, policy: { ...DEFAULT_USAGE_POLICY }, state: null })),
    records: [1, 2].flatMap((id) => [
      { accountId: id, day: '2026-11-27', timeZone: 'Asia/Shanghai', fetchedAt: '2026-11-27T01:00:00Z', kind: 'stats' as const, data: { today: metrics, total: metrics, platforms: [{ platform: 'deepseek', today: metrics, total: metrics }] } },
      { accountId: id, day: '2026-11-27', timeZone: 'Asia/Shanghai', fetchedAt: '2026-11-27T01:00:00Z', kind: 'models' as const, data: [{ ...metrics, model: 'deepseek-chat' }] },
      { accountId: id, day: '2026-11-26', timeZone: 'Asia/Shanghai', fetchedAt: '2026-11-27T01:00:00Z', kind: 'models' as const, data: [{ ...metrics, model: 'deepseek-chat' }] },
      { accountId: id, day: '2026-11-27', timeZone: 'Asia/Shanghai', fetchedAt: '2026-11-27T01:00:00Z', kind: 'keys' as const, data: [{ upstreamId: 13, todayActualCost: id, recentActualCost: id * 3 }] },
      { accountId: id, day: '2026-11-27', timeZone: 'Asia/Shanghai', fetchedAt: '2026-11-27T01:00:00Z', kind: 'catalog' as const, data: [{ upstreamId: 13, name: `Key${id}`, group: '默认', localTokenId: id }] },
    ]),
  };
}

function Location() { return <output data-location>{useLocation().search}</output>; }
function textOf(node: ReactTestInstance): string { return node.children.map((child) => typeof child === 'string' ? child : textOf(child)).join(''); }
let renderer: ReactTestRenderer;
async function mount(path = '/consumption') {
  await act(async () => { renderer = create(<MemoryRouter initialEntries={[path]}><ConsumptionPanel /><Location /></MemoryRouter>); });
}
function button(label: string) { return renderer.root.findAllByType('button').find((node) => textOf(node) === label)!; }
function query() { return new URLSearchParams(textOf(renderer.root.findByProps({ 'data-location': true }))); }
async function click(label: string) { await act(async () => { await button(label).props.onClick(); }); }

beforeEach(() => {
  mocks.mobile = false;
  mocks.get.mockResolvedValue(fixture());
  mocks.sync.mockResolvedValue({ queued: 2 });
});
afterEach(() => { if (renderer) act(() => renderer.unmount()); vi.clearAllMocks(); });

describe('consumption workspace interactions', () => {
  it('keeps Key fees independent from date/model/vendor scope and links to the matching local token', async () => {
    await mount('/consumption?start=2026-11-26&end=2026-11-26&accountId=1&model=missing&platform=deepseek');
    await click('Key 费用');
    expect(renderer.root.findAllByProps({ 'aria-label': '开始日期' })).toHaveLength(0);
    expect(textOf(renderer.root)).toContain('Key1');
    expect(textOf(renderer.root)).not.toContain('Key2');
    expect(renderer.root.findAllByType('a').some((node) => node.props.href === '/sites/1?segment=tokens&focusTokenId=1')).toBe(true);
    expect(textOf(renderer.root)).not.toContain('近 30 天');
    await click('采集状态');
    expect(renderer.root.findAllByProps({ 'aria-label': '采集任务状态' })).toHaveLength(1);
    expect(renderer.root.findAllByProps({ 'aria-label': '每日消费趋势' })).toHaveLength(0);
  });

  it('drills site → account → model, and removing a site also clears its account', async () => {
    await mount();
    await click('站点1 ↗');
    expect(query().get('view')).toBe('accounts');
    expect(query().get('siteId')).toBe('1');
    await click('站点1 · 账号1 ↗');
    expect(query().get('accountId')).toBe('1');
    expect(query().get('view')).toBe('models');
    await click('deepseek-chat ↗');
    expect(query().get('model')).toBe('deepseek-chat');
    await act(async () => { renderer.root.findByProps({ 'aria-label': '移除站点1筛选' }).props.onClick(); });
    expect(query().has('siteId')).toBe(false);
    expect(query().has('accountId')).toBe(false);
    expect(query().get('model')).toBe('deepseek-chat');
  });

  it('does not display today vendor fees as historical results', async () => {
    await mount('/consumption?view=platforms&start=2026-11-26&end=2026-11-26');
    expect(renderer.root.findAllByProps({ 'aria-label': '消费明细' })).toHaveLength(0);
    await click('查看今日厂商');
    expect(query().get('start')).toBe('2026-11-27');
    expect(renderer.root.findAllByProps({ 'aria-label': '消费明细' })).toHaveLength(1);
    await click('近 7 天');
    expect(query().get('view')).toBe('sites');
    expect(query().get('start')).toBe('2026-11-21');
  });

  it('refreshes saved data locally and queues collection by site without applying the account display filter', async () => {
    await mount('/consumption?siteId=1&accountId=1');
    expect(mocks.get).toHaveBeenCalledTimes(1);
    expect(mocks.sync).not.toHaveBeenCalled();
    await click('刷新数据');
    expect(mocks.get).toHaveBeenCalledTimes(2);
    expect(mocks.sync).not.toHaveBeenCalled();
    await click('安排同步');
    expect(mocks.sync).toHaveBeenCalledWith({ siteId: 1 });
    await click('补齐所选日期');
    expect(mocks.sync).toHaveBeenLastCalledWith({ siteId: 1, start: '2026-11-27', end: '2026-11-27' });
  });

  it('selecting an account also scopes its site and selecting a new site clears the old account', async () => {
    await mount();
    await act(async () => { renderer.root.findByProps({ 'aria-label': '筛选账号' }).props.onChange({ target: { value: '2' } }); });
    expect(query().get('siteId')).toBe('2');
    expect(query().get('accountId')).toBe('2');
    await act(async () => { renderer.root.findByProps({ 'aria-label': '筛选站点' }).props.onChange({ target: { value: '1' } }); });
    expect(query().get('siteId')).toBe('1');
    expect(query().has('accountId')).toBe(false);
  });

  it('searches and sorts a paged table, resetting the page after filtering', async () => {
    const data = fixture();
    data.accounts = Array.from({ length: 12 }, (_, i) => ({ ...data.accounts[0], accountId: i + 1, siteId: i + 1, siteName: `Site-${String(i + 1).padStart(2, '0')}` }));
    data.records = [];
    mocks.get.mockResolvedValue(data);
    await mount();
    const table = renderer.root.findByType('table');
    expect(table.findByType('tbody').findAllByType('tr')).toHaveLength(10);
    await click('下一页');
    expect(table.findByType('tbody').findAllByType('tr')).toHaveLength(2);
    await act(async () => { renderer.root.findByProps({ 'aria-label': '搜索费用明细' }).props.onChange({ target: { value: 'Site-01' } }); });
    expect(table.findByType('tbody').findAllByType('tr')).toHaveLength(1);
    expect(textOf(table)).toContain('Site-01');
    await act(async () => { renderer.root.findByProps({ 'aria-label': '搜索费用明细' }).props.onChange({ target: { value: '' } }); renderer.root.findByProps({ 'aria-label': '费用明细排序' }).props.onChange({ target: { value: 'name' } }); });
    expect(textOf(table.findByType('tbody').findAllByType('tr')[0])).toContain('Site-01');
  });

  it('uses mobile cards and hides desktop tables', async () => {
    mocks.mobile = true;
    await mount();
    expect(renderer.root.findAllByType('table')).toHaveLength(0);
    expect(renderer.root.findAllByProps({ className: 'mobile-card' })).toHaveLength(2);
    expect(button('筛选站点、账号与日期')).toBeDefined();
  });

  it('rejects an impossible calendar date with a reset action', async () => {
    await mount('/consumption?start=2026-02-30&end=2026-11-27');
    expect(textOf(renderer.root.findByProps({ role: 'alert' }))).toContain('日期范围无效');
    await click('回到今天');
    expect(renderer.root.findAllByProps({ role: 'alert' })).toHaveLength(0);
  });
});

describe('collection status meaning', () => {
  it('separates unsupported, duplicate, manual pause, cooldown and credential errors', () => {
    const account = fixture().accounts[0];
    const task = { nextAt: Date.now() + 60000, failures: 0, lastSuccessAt: '2026-11-27T01:00:00Z' };
    const state = { tasks: { stats: task, keys: task, models: task, catalog: task }, cooldownUntil: 0, requestTimes: [], historyRequests: 0, pendingDays: [] };
    expect(collectionStatus({ ...account, supported: false }).label).toBe('不支持');
    expect(collectionStatus({ ...account, duplicateOf: 2 }).label).toBe('已去重');
    expect(collectionStatus({ ...account, policy: { ...account.policy, enabled: false } }).label).toBe('已暂停');
    expect(collectionStatus({ ...account, state: { ...state, cooldownUntil: Date.now() + 10000 } }).label).toBe('冷却中');
    expect(collectionStatus({ ...account, state: { ...state, blocked: '凭证过期' } }).detail).toBe('凭证过期');
    expect(collectionStatus({ ...account, state }).label).toBe('正常采集');
    expect(collectionStatus(account).label).toBe('待首次同步');
  });
});
