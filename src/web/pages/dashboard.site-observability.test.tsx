import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, create, type ReactTestInstance } from 'react-test-renderer';
import { MemoryRouter } from 'react-router-dom';
import { ToastProvider } from '../components/Toast.js';
import Dashboard from './Dashboard.js';
import { installDashboardSnapshotCompat } from './testApiCompat.js';

const { apiMock } = vi.hoisted(() => ({
  apiMock: {
    getDashboard: vi.fn(),
    getDesktopInfo: vi.fn().mockResolvedValue({ baseUrl: 'http://127.0.0.1:5000', port: 5000 }),
    getDashboardSnapshot: vi.fn(),
    getDashboardInsights: vi.fn(),
    getSiteSnapshot: vi.fn(),
    getSiteDistribution: vi.fn(),
    getSiteTrend: vi.fn(),
    getSites: vi.fn(),
    getTunnelStatus: vi.fn().mockResolvedValue({ tunnel: { enabled: false } }),
  },
}));

vi.mock('../api.js', () => ({
  api: apiMock,
}));

function collectText(node: ReactTestInstance): string {
  return (node.children || []).map((child) => {
    if (typeof child === 'string') return child;
    return collectText(child);
  }).join('');
}

async function flushMicrotasks() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe('Dashboard site observability panel', () => {
  const originalDocument = globalThis.document;

  beforeEach(() => {
    vi.clearAllMocks();
    installDashboardSnapshotCompat(apiMock);
    apiMock.getDashboard.mockResolvedValue({
      totalBalance: 0,
      totalUsed: 0,
      todaySpend: 0,
      todayReward: 0,
      activeAccounts: 0,
      totalAccounts: 0,
      todayCheckin: { success: 0, total: 0 },
      proxy24h: { success: 0, total: 0, totalTokens: 0 },
      performance: { windowSeconds: 60, requestsPerMinute: 0, tokensPerMinute: 0 },
      siteAvailability: [{
        siteId: 1,
        siteName: 'Demo Site',
        siteUrl: 'https://example.com',
        platform: 'new-api',
        totalRequests: 8,
        successCount: 6,
        failedCount: 2,
        availabilityPercent: 75,
        averageLatencyMs: 320,
        buckets: Array.from({ length: 24 }, (_, index) => ({
          startUtc: new Date(Date.UTC(2026, 2, 11, index, 0, 0)).toISOString(),
          label: `2026-03-11 ${String(index).padStart(2, '0')}:00:00`,
          totalRequests: index < 8 ? 1 : 0,
          successCount: index < 6 ? 1 : 0,
          failedCount: index >= 6 && index < 8 ? 1 : 0,
          availabilityPercent: index < 6 ? 100 : index < 8 ? 0 : null,
          averageLatencyMs: index < 8 ? 320 : null,
        })),
      }],
      modelAvailability: [{
        model: 'gpt-4o',
        totalRequests: 5,
        successCount: 4,
        failedCount: 1,
        availabilityPercent: 80,
        averageLatencyMs: 200,
        buckets: Array.from({ length: 24 }, (_, index) => ({
          startUtc: new Date(Date.UTC(2026, 2, 11, index, 0, 0)).toISOString(),
          label: `2026-03-11 ${String(index).padStart(2, '0')}:00:00`,
          totalRequests: index < 5 ? 1 : 0,
          successCount: index < 4 ? 1 : 0,
          failedCount: index === 4 ? 1 : 0,
          availabilityPercent: index < 4 ? 100 : index === 4 ? 0 : null,
          averageLatencyMs: index < 5 ? 200 : null,
        })),
      }],
      modelAnalysis: null,
    });
    apiMock.getSiteDistribution.mockResolvedValue({ distribution: [] });
    apiMock.getSiteTrend.mockResolvedValue({ trend: [] });
    apiMock.getSites.mockResolvedValue([]);
    globalThis.document = {
      visibilityState: 'visible',
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      getElementById: vi.fn(() => null),
    } as unknown as Document;
  });

  afterEach(() => {
    globalThis.document = originalDocument;
    vi.clearAllMocks();
  });

  it('keeps the overview focused and navigates to details without stacking every panel', async () => {
    let root!: WebTestRenderer;
    try {
      await act(async () => {
        root = create(<MemoryRouter><ToastProvider><Dashboard /></ToastProvider></MemoryRouter>);
      });
      await flushMicrotasks();
      expect(root.root.findAllByProps({ 'aria-label': '运行总览' })).toHaveLength(1);
      expect(root.root.findAllByProps({ 'aria-label': '服务接入' })).toHaveLength(0);
      expect(root.root.findAllByProps({ 'aria-label': '消费分析维度' })).toHaveLength(0);
      expect(root.root.findAllByProps({ 'aria-label': '站点与模型分析' })).toHaveLength(1);
      const visit = async (href: string) => {
        const link = root.root.findAllByType('a').find((node) => node.props.href === href)!;
        await act(async () => link.props.onClick({ button: 0, defaultPrevented: false, preventDefault: vi.fn(), metaKey: false, altKey: false, ctrlKey: false, shiftKey: false }));
        await flushMicrotasks();
      };
      expect(root.root.findAllByType('a').some((node) => node.props.href === '/?tab=health')).toBe(false);
      expect(root.root.findAllByProps({ 'aria-label': '站点与模型分析' })).toHaveLength(1);
      await visit('/?tab=access');
      expect(root.root.findAllByProps({ 'aria-label': '站点与模型分析' })).toHaveLength(0);
      expect(collectText(root.root)).toContain('服务地址');
      await visit('/');
      expect(root.root.findAllByProps({ 'aria-label': '运行总览' })).toHaveLength(1);
      expect(root.root.findAllByProps({ 'aria-label': '服务接入' })).toHaveLength(0);
    } finally { root?.unmount(); }
  });

  it.each([{ width: 1280, size: 6 }, { width: 390, size: 4 }])('paginates availability cards at viewport width $width', async ({ width, size }) => {
    const originalWidth = window.innerWidth;
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: width });
    const snapshot = await apiMock.getDashboard();
    apiMock.getDashboard.mockResolvedValue({ ...snapshot, siteAvailability: Array.from({ length: 14 }, (_, index) => ({ ...snapshot.siteAvailability[0], siteId: index + 1, siteName: `站点-${index + 1}` })) });
    let root!: WebTestRenderer;
    try {
      await act(async () => { root = create(<MemoryRouter initialEntries={['/?tab=health']}><ToastProvider><Dashboard /></ToastProvider></MemoryRouter>); });
      await flushMicrotasks();
      const cards = () => root.root.findAll((node) => node.type === 'div' && /^site-observability-card(?:\s|$)/.test(node.props.className || ''));
      expect(cards()).toHaveLength(size);
      expect(collectText(cards()[0])).toContain('站点-1');
      const next = root.root.findAllByType('button').find((node) => collectText(node) === '下一页')!;
      await act(async () => next.props.onClick());
      expect(cards()).toHaveLength(size);
      expect(collectText(cards()[0])).toContain(`站点-${size + 1}`);
    } finally {
      root?.unmount();
      Object.defineProperty(window, 'innerWidth', { configurable: true, value: originalWidth });
    }
  });

  it('renders site availability strips and summary metrics', async () => {
    let root!: WebTestRenderer;

    try {
      await act(async () => {
        root = create(
          <MemoryRouter initialEntries={['/?tab=health']}>
            <ToastProvider>
              <Dashboard />
            </ToastProvider>
          </MemoryRouter>,
        );
      });
      await flushMicrotasks();

      const panel = root!.root.find((node) => (
        typeof node.props.className === 'string'
        && node.props.className.includes('site-observability-panel')
      ));

      const cells = panel.findAll((node) => (
        node.type === 'a'
        && typeof node.props.className === 'string'
        && node.props.className.includes('site-availability-cell')
      ));

      const logLink = panel.find((node) => (
        node.type === 'a'
        && typeof node.props.className === 'string'
        && node.props.className.includes('site-observability-log-link')
      ));

      expect(collectText(panel)).toContain('站点与模型分析');
      expect(collectText(panel)).toContain('Demo Site');
      expect(collectText(panel)).toContain('75%');
      expect(collectText(panel)).toContain('320ms');
      expect(logLink.props.title).toBe('查看日志');
      expect(cells).toHaveLength(8);
      expect(String(cells[0]?.props.title || '')).toContain('可用性 100%');
      expect(String(cells[7]?.props.title || '')).toContain('可用性 0%');
      expect(String(cells[0]?.props['data-tooltip'] || '')).toContain('时间：');
      expect(String(cells[0]?.props['data-tooltip'] || '')).toContain('可用性：100%');
      expect(String(cells[0]?.props['data-tooltip'] || '')).toContain('成功/失败：1/0');
      expect(String(logLink.props.href || logLink.props.to || '')).toContain('/logs?siteId=1');
    } finally {
      root?.unmount();
    }
  });

  it('switches to model availability tab', async () => {
    let root!: WebTestRenderer;

    try {
      await act(async () => {
        root = create(
          <MemoryRouter initialEntries={['/?tab=health']}>
            <ToastProvider>
              <Dashboard />
            </ToastProvider>
          </MemoryRouter>,
        );
      });
      await flushMicrotasks();

      const panel = root!.root.find((node) => (
        typeof node.props.className === 'string'
        && node.props.className.includes('site-observability-panel')
      ));
      const modelTab = panel.find((node) => (
        node.type === 'button' && collectText(node).includes('模型')
      ));
      await act(async () => {
        modelTab.props.onClick();
      });
      await flushMicrotasks();

      expect(collectText(panel)).toContain('gpt-4o');
      expect(collectText(panel)).toContain('80%');
      const logLink = panel.find((node) => (
        node.type === 'a'
        && typeof node.props.className === 'string'
        && node.props.className.includes('site-observability-log-link')
      ));
      expect(String(logLink.props.href || logLink.props.to || '')).toContain('/logs?model=gpt-4o');
    } finally {
      root?.unmount();
    }
  });
});
