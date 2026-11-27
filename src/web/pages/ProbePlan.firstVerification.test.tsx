import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import ProbePlan from './ProbePlan.js';

const { state, run, save, refetch } = vi.hoisted(() => ({
  state: { data: null as unknown, mobile: false }, run: vi.fn(async () => ({})),
  save: vi.fn(async () => ({})), refetch: vi.fn(async () => ({})),
}));
vi.mock('@tanstack/react-query', () => ({ useQuery: () => ({ data: state.data, refetch, isLoading: false, isFetching: false }) }));
vi.mock('../api.js', () => ({ api: { runFirstVerification: run, saveFirstVerificationSettings: save } }));
vi.mock('../components/useIsMobile.js', () => ({ useIsMobile: () => state.mobile }));
vi.mock('../components/Toast.js', () => ({ useToast: () => ({ success: vi.fn(), error: vi.fn() }) }));

describe('first verification controls in probe plan', () => {
  let view: ReactTestRenderer;
  afterEach(() => { act(() => view?.unmount()); vi.clearAllMocks(); });
  function mount(mobile = false) {
    state.mobile = mobile;
    const key = { keyId: 1, keyName: 'pending-key', accountId: 1, accountName: 'account', siteId: 1,
      siteName: 'site', platform: 'new-api', available: false, connectivity: null, recentCalls: 0, lastProbe: null, routeState: 'pending-verification' };
    const model = { modelName: 'gpt-5.2', type: 'text', tab: 'probeable', recentCalls: 0, intervalHours: 24,
      automaticIntervalHours: 24, overridden: false, pendingVerificationCount: 1, keyResults: [key], manualExcludedKeys: [], policyExcludedKeys: [] };
    state.data = {
      intervals: [1, 6, 24, 72], models: [model, { ...model, modelName: 'disabled-model', tab: 'manual-disabled', pendingVerificationCount: 0,
        keyResults: [], manualExcludedKeys: [{ ...key, keyId: 2, routeState: 'manual-disabled' }] }],
      firstVerification: {
        settings: { enabled: true, batchSize: 4, hourlyLimit: 48, dailyCostLimitUsd: 1, concurrency: 2, mediaHourlyLimit: 2, groupIntervalSeconds: 2 },
        budget: { running: false, pauseReason: null, hourlyUsed: 0, mediaHourlyUsed: 0, dailyCostUsd: 0, unknownCostCount: 0, lastBatch: null },
      },
    };
    act(() => { view = create(<ProbePlan />); });
  }
  it.each([false, true])('selects only models with pending combinations and schedules the selected model (mobile=%s)', async (mobile) => {
    mount(mobile);
    const pendingTab = view.root.findAllByProps({ role: 'tab' }).find((node) =>
      node.findAllByType('span').some((span) => span.children.join('') === '待首次验证'))!;
    act(() => pendingTab.props.onClick());
    expect(JSON.stringify(view.toJSON())).not.toContain('disabled-model');
    const button = view.root.findAllByType('button').find((node) => node.props.className === 'btn btn-ghost btn-sm');
    await act(async () => { await button!.props.onClick(); });
    expect(run).toHaveBeenCalledWith('gpt-5.2');
  });
  it('saves edited limits and the automatic switch together', async () => {
    mount();
    const form = view.root.findByType('form');
    const inputs = form.findAllByType('input');
    act(() => inputs[0].props.onChange({ target: { checked: false } }));
    act(() => inputs[1].props.onChange({ target: { value: '8' } }));
    await act(async () => { form.props.onSubmit({ preventDefault() {} }); await Promise.resolve(); });
    expect(save).toHaveBeenCalledWith(expect.objectContaining({ enabled: false, batchSize: 8 }));
    expect(refetch).toHaveBeenCalled();
  });
});
