import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, create } from 'react-test-renderer';
import { MemoryRouter } from 'react-router-dom';
import { ToastProvider } from '../components/Toast.js';
import { TokensPanel } from './Tokens.js';
import { installAccountsSnapshotCompat } from './testApiCompat.js';

const { apiMock } = vi.hoisted(() => ({
  apiMock: {
    getAccounts: vi.fn(),
    getAccountsSnapshot: vi.fn(),
    getSites: vi.fn(),
    getAccountTokens: vi.fn(),
    getAccountTokenValue: vi.fn(),
    getAccountTokenGroups: vi.fn(),
    syncAccountTokens: vi.fn(),
    updateAccountToken: vi.fn(),
  },
}));

vi.mock('../api.js', () => ({
  api: apiMock,
}));

async function flushMicrotasks() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

function buildTokensRoot() {
  return create(
    <MemoryRouter initialEntries={['/accounts?segment=tokens']}>
      <ToastProvider>
        <TokensPanel />
      </ToastProvider>
    </MemoryRouter>,
    {
      createNodeMock: (element) => {
        if (element.type === 'tr' || element.type === 'div') {
          return { scrollIntoView: () => undefined };
        }
        return {};
      },
    },
  );
}

describe('TokensPanel group display', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    installAccountsSnapshotCompat(apiMock);
    apiMock.getAccounts.mockResolvedValue([
      {
        id: 1,
        username: 'session-user',
        accessToken: 'session-token',
        status: 'active',
        credentialMode: 'session',
        site: { id: 10, name: 'Sub Site', platform: 'sub2api', status: 'active', url: 'https://sub.example.com' },
      },
    ]);
    apiMock.getSites.mockResolvedValue([
      { id: 10, name: 'Sub Site', platform: 'sub2api', status: 'active' },
    ]);
    apiMock.getAccountTokens.mockResolvedValue([
      {
        id: 1,
        name: 'resolved-token',
        tokenMasked: 'sk-a****',
        valueStatus: 'ready',
        enabled: true,
        isDefault: false,
        updatedAt: '2026-11-24 09:00:00',
        accountId: 1,
        tokenGroup: '295',
        groupName: '福利pro不降智（0.1倍率）',
        groupStatus: 'active',
        groupRateMultiplier: 0.1,
        groupFetchedAt: Date.now(),
        account: { username: 'session-user' },
        site: { name: 'Sub Site', url: 'https://sub.example.com' },
      },
      {
        id: 2,
        name: 'unresolved-token',
        tokenMasked: 'sk-b****',
        valueStatus: 'ready',
        enabled: true,
        isDefault: false,
        updatedAt: '2026-11-24 09:00:00',
        accountId: 1,
        tokenGroup: '320',
        groupName: null,
        groupStatus: 'removed',
        groupRateMultiplier: null,
        account: { username: 'session-user' },
        site: { name: 'Sub Site', url: 'https://sub.example.com' },
      },
      {
        id: 3,
        name: 'inactive-group-token',
        tokenMasked: 'sk-c****',
        valueStatus: 'ready',
        enabled: true,
        isDefault: false,
        updatedAt: '2026-11-24 09:00:00',
        accountId: 1,
        tokenGroup: '42',
        groupName: '生图分组',
        groupStatus: 'inactive',
        groupRateMultiplier: 1,
        // Read 20 minutes ago: upstream may have repriced the group since, so
        // the badge must say so instead of implying the multiplier is live.
        groupFetchedAt: Date.now() - 20 * 60 * 1000,
        account: { username: 'session-user' },
        site: { name: 'Sub Site', url: 'https://sub.example.com' },
      },
    ]);
    apiMock.getAccountTokenGroups.mockResolvedValue({ success: true, groups: [], groupDetails: [] });
    apiMock.syncAccountTokens.mockResolvedValue({ success: true });
    apiMock.updateAccountToken.mockResolvedValue({ success: true });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('shows the group name, multiplier and availability instead of the raw id', async () => {
    let root!: ReturnType<typeof buildTokensRoot>;
    try {
      await act(async () => {
        root = buildTokensRoot();
      });
      await flushMicrotasks();

      const rendered = JSON.stringify(root.toJSON());
      // Resolved id → name + multiplier.
      expect(rendered).toContain('福利pro不降智（0.1倍率）');
      expect(rendered).toContain('×0.1');
      // Unresolved key stays visible as an id rather than a fabricated name,
      // and is flagged as deleted because upstream no longer lists it.
      expect(rendered).toContain('#320');
      expect(rendered).toContain('已删除');
      // An inactive upstream group is flagged.
      expect(rendered).toContain('生图分组');
      expect(rendered).toContain('不可用');
    } finally {
      root?.unmount();
    }
  });

  it('labels how old the multiplier is and flags a stale one', async () => {
    let root!: ReturnType<typeof buildTokensRoot>;
    try {
      await act(async () => {
        root = buildTokensRoot();
      });
      await flushMicrotasks();

      const rendered = JSON.stringify(root.toJSON());
      // Every row carries the age of the upstream read behind its multiplier.
      expect(rendered).toContain('倍率更新于');
      // A multiplier read 20 minutes ago is visually marked as possibly stale.
      expect(rendered).toContain('token-group-rate is-stale');
      expect(rendered).toContain('分组倍率可能已过期');
    } finally {
      root?.unmount();
    }
  });
});
