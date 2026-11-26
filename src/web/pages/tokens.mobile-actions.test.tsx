import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, create } from 'react-test-renderer';
import { MemoryRouter } from 'react-router-dom';
import { ToastProvider } from '../components/Toast.js';
import { TokensPanel } from './tokens/TokensPanel.js';

const { apiMock } = vi.hoisted(() => ({
  apiMock: {
    getAccountTokens: vi.fn(),
    getAccounts: vi.fn(),
    getAccountsSnapshot: vi.fn(),
    getSites: vi.fn(),
    batchUpdateAccountTokens: vi.fn(),
  },
}));

vi.mock('../api.js', () => ({
  api: apiMock,
}));

vi.mock('../components/useIsMobile.js', () => ({
  useIsMobile: () => true,
}));

async function flushMicrotasks() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe('Tokens mobile multi-select removal', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    apiMock.getSites.mockResolvedValue([{ id: 1, name: 'Site A', platform: 'new-api', status: 'active' }]);
    apiMock.getAccounts.mockResolvedValue([{ id: 1, siteId: 1, username: 'alpha', status: 'active' }]);
    apiMock.getAccountsSnapshot.mockResolvedValue({ accounts: [{
      id: 1, siteId: 1, username: 'alpha', status: 'active', credentialMode: 'session',
      site: { id: 1, name: 'Site A', status: 'active' },
    }] });
    apiMock.getAccountTokens.mockResolvedValue([
      { id: 1, name: 'Token A', siteId: 1, accountId: 1, status: 'active', value: 'sk-a' },
    ]);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('does not render mobile select-all', async () => {
    let root!: WebTestRenderer;
    try {
      await act(async () => {
        root = create(
          <MemoryRouter initialEntries={['/accounts?segment=tokens']}>
            <ToastProvider>
              <TokensPanel />
            </ToastProvider>
          </MemoryRouter>,
        );
      });
      await flushMicrotasks();

      expect(() => root.root.find((node) => node.props['data-testid'] === 'tokens-mobile-select-all')).toThrow();
    } finally {
      root?.unmount();
    }
  });

  it('opens model management directly from a token row', async () => {
    const onManageTokenModels = vi.fn();
    let root!: WebTestRenderer;
    try {
      await act(async () => {
        root = create(
          <MemoryRouter initialEntries={['/accounts?segment=tokens']}>
            <ToastProvider>
              <TokensPanel onManageTokenModels={onManageTokenModels} />
            </ToastProvider>
          </MemoryRouter>,
        );
      });
      await flushMicrotasks();

      act(() => root.root.findByProps({ 'data-testid': 'token-manage-models-1' }).props.onClick());
      expect(onManageTokenModels).toHaveBeenCalledWith({ id: 1, accountId: 1 });
    } finally {
      root?.unmount();
    }
  });
});
