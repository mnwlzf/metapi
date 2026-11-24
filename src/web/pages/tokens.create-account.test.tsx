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

function findButton(root: ReturnType<typeof buildTokensRoot>, label: string) {
  return root.root
    .findAll((node) => node.type === 'button')
    .find((node) => (node.children || []).some((child) => typeof child === 'string' && child.includes(label)));
}

function baseAccount(overrides: Record<string, unknown> = {}) {
  return {
    id: 1,
    username: 'session-user',
    accessToken: 'session-token',
    status: 'active',
    credentialMode: 'session',
    site: { id: 10, name: 'Sub Site', platform: 'sub2api', status: 'active', url: 'https://sub.example.com' },
    ...overrides,
  };
}

describe('TokensPanel add-token account picker', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    installAccountsSnapshotCompat(apiMock);
    apiMock.getSites.mockResolvedValue([{ id: 10, name: 'Sub Site', platform: 'sub2api', status: 'active' }]);
    apiMock.getAccountTokens.mockResolvedValue([]);
    apiMock.getAccountTokenGroups.mockResolvedValue({ success: true, groups: [], groupDetails: [] });
    apiMock.syncAccountTokens.mockResolvedValue({ success: true });
    apiMock.updateAccountToken.mockResolvedValue({ success: true });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('offers an expired session account instead of leaving the picker empty', async () => {
    apiMock.getAccounts.mockResolvedValue([baseAccount({ status: 'expired' })]);
    let root!: ReturnType<typeof buildTokensRoot>;
    try {
      await act(async () => {
        root = buildTokensRoot();
      });
      await flushMicrotasks();

      const addButton = findButton(root, '新增令牌');
      expect(addButton).toBeTruthy();
      await act(async () => {
        addButton!.props.onClick();
      });
      await flushMicrotasks();

      const rendered = JSON.stringify(root.toJSON());
      // Account is selectable and labelled with its state.
      expect(rendered).toContain('session-user @ Sub Site');
      expect(rendered).toContain('会话已过期');
      // And the operator is told what that implies.
      expect(rendered).toContain('该账号会话已过期');
    } finally {
      root?.unmount();
    }
  });

  it('explains why the picker is empty when the site has no session account', async () => {
    apiMock.getAccounts.mockResolvedValue([
      baseAccount({ credentialMode: 'apikey', status: 'active' }),
    ]);
    let root!: ReturnType<typeof buildTokensRoot>;
    try {
      await act(async () => {
        root = buildTokensRoot();
      });
      await flushMicrotasks();

      const addButton = findButton(root, '新增令牌');
      await act(async () => {
        addButton!.props.onClick();
      });
      await flushMicrotasks();

      const rendered = JSON.stringify(root.toJSON());
      expect(rendered).toContain('该站点下没有可用的会话账号');
    } finally {
      root?.unmount();
    }
  });
});
