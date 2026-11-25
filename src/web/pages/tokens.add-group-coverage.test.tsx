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
    await Promise.resolve();
  });
}

function buildAddFormRoot() {
  // `create=1&accountId=1` opens the add form on that account, which is the
  // state where the group picker has to answer "which groups still need a token".
  return create(
    <MemoryRouter initialEntries={['/accounts?segment=tokens&create=1&accountId=1']}>
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

describe('TokensPanel add-token group picker', () => {
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
    // Two tokens already exist, on groups 295 and 42; the upstream catalog also
    // lists 221 and 55, which have no token yet.
    apiMock.getAccountTokens.mockResolvedValue([
      {
        id: 1,
        name: 'has-token-1',
        tokenMasked: 'sk-a****',
        valueStatus: 'ready',
        enabled: true,
        isDefault: false,
        updatedAt: '2026-11-24 09:00:00',
        accountId: 1,
        tokenGroup: '295',
        groupName: '福利pro不降智',
        groupStatus: 'active',
        groupRateMultiplier: 0.1,
        groupFetchedAt: Date.now(),
        account: { username: 'session-user' },
        site: { name: 'Sub Site', url: 'https://sub.example.com' },
      },
      {
        id: 2,
        name: 'has-token-2',
        tokenMasked: 'sk-b****',
        valueStatus: 'ready',
        enabled: true,
        isDefault: false,
        updatedAt: '2026-11-24 09:00:00',
        accountId: 1,
        tokenGroup: '42',
        groupName: '生图分组',
        groupStatus: 'active',
        groupRateMultiplier: 1,
        groupFetchedAt: Date.now(),
        account: { username: 'session-user' },
        site: { name: 'Sub Site', url: 'https://sub.example.com' },
      },
      // Same account id, different site is impossible; a token on ANOTHER
      // account must not mark this account's groups as covered.
      {
        id: 3,
        name: 'other-account-token',
        tokenMasked: 'sk-c****',
        valueStatus: 'ready',
        enabled: true,
        isDefault: false,
        updatedAt: '2026-11-24 09:00:00',
        accountId: 99,
        tokenGroup: '221',
        groupName: '别的账号的分组',
        groupStatus: 'active',
        groupRateMultiplier: 0.05,
        groupFetchedAt: Date.now(),
        account: { username: 'other-user' },
        site: { name: 'Sub Site', url: 'https://sub.example.com' },
      },
    ]);
    apiMock.getAccountTokenGroups.mockResolvedValue({
      success: true,
      groups: ['295', '42', '221'],
      groupDetails: [
        { id: '295', name: '福利pro不降智', status: 'active', rateMultiplier: 0.1, vendor: 'openai' },
        { id: '42', name: '生图分组', status: 'active', rateMultiplier: 1, vendor: 'openai' },
        { id: '221', name: '福利分组', status: 'active', rateMultiplier: 0.05, vendor: 'deepseek' },
      ],
    });
    apiMock.syncAccountTokens.mockResolvedValue({ success: true });
    apiMock.updateAccountToken.mockResolvedValue({ success: true });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('marks which groups already have a token and which still need one', async () => {
    let root!: ReturnType<typeof buildAddFormRoot>;
    try {
      await act(async () => {
        root = buildAddFormRoot();
      });
      await flushMicrotasks();

      const rendered = JSON.stringify(root.toJSON());
      // Groups 295 and 42 have a token on THIS account.
      expect(rendered).toContain('已创建令牌');
      // 221 belongs to another account only, so it is still a gap here.
      expect(rendered).toContain('未创建令牌');
      // Vendor travels with the option label.
      expect(rendered).toContain('deepseek');
      // Exact coverage: 3 catalog groups, exactly 1 without a token on this
      // account. If the other account's token were counted, this line would
      // disappear (pending would be 0).
      expect(rendered).toContain('共 3 个分组，1 个还没有令牌');
    } finally {
      root?.unmount();
    }
  });
});
