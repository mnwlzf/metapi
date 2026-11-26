import { useState, type ComponentProps } from 'react';
import { act, create, type ReactTestInstance } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import AccountModelsModal from './AccountModelsModal.js';

type Props = ComponentProps<typeof AccountModelsModal>;
const models: Props['modelModal']['models'] = [
  { name: 'failed', latencyMs: null, disabled: true, manualDisabled: false, disabledSource: 'probe', probeStatus: 'unavailable' },
  { name: 'healthy', latencyMs: 42, disabled: false, manualDisabled: false, probeStatus: 'available' },
  { name: 'banned', latencyMs: null, disabled: true, manualDisabled: true, disabledSource: 'manual', probeStatus: 'unavailable' },
];

function text(node: ReactTestInstance): string {
  return node.children.map((child) => typeof child === 'string' ? child : text(child)).join('');
}

describe('Key model policy editor', () => {
  let root: ReturnType<typeof create>;
  let onClose: ReturnType<typeof vi.fn>;
  let onSave: ReturnType<typeof vi.fn>;
  let onTokenChange: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    onClose = vi.fn(); onSave = vi.fn(); onTokenChange = vi.fn();
    vi.stubGlobal('innerWidth', 1024);
  });
  afterEach(() => {
    act(() => root?.unmount());
    vi.unstubAllGlobals();
  });

  function render(overrides: Partial<Props['modelModal']> = {}) {
    function Harness() {
      const [state, setState] = useState<Props['modelModal']>({
        open: true, account: { id: 1, username: 'alpha' }, siteName: 'Site', tokenId: 11,
        tokens: [{ id: 11, name: 'A' }, { id: 12, name: 'B' }], keyRequired: true,
        models, pendingDisabled: new Set(['banned']), newModelPolicy: 'auto', initialNewModelPolicy: 'auto',
        loading: false, saving: false, manualModelsInput: '', addingManualModels: false, ...overrides,
      });
      return <AccountModelsModal modelModal={state} inputStyle={{}} onClose={onClose}
        onSave={() => onSave(state.tokenId, [...state.pendingDisabled])} onTokenChange={onTokenChange}
        onRefresh={vi.fn()} onToggleModelDisabled={(name) => setState((s) => {
          const next = new Set(s.pendingDisabled);
          if (next.has(name)) next.delete(name); else next.add(name);
          return { ...s, pendingDisabled: next };
        })} onSetPendingDisabled={(pendingDisabled) => setState((s) => ({ ...s, pendingDisabled }))}
        onNewModelPolicyChange={(newModelPolicy) => setState((s) => ({ ...s, newModelPolicy }))}
        onManualInputChange={vi.fn()} onAddManualModels={vi.fn()} onRemoveManualModel={vi.fn()}
        removingManualModelName={null} />;
    }
    act(() => { root = create(<Harness />); });
  }

  function button(label: string) {
    return root.root.find((node) => node.type === 'button' && text(node) === label);
  }
  function click(label: string) {
    act(() => button(label).props.onClick());
  }

  it('allows a failed probe to become a manual ban and saves only the current Key', () => {
    render();
    const action = root.root.findByProps({ 'aria-label': '手动禁用 failed' });
    expect(action.props.disabled).toBe(false);
    expect(root.root.findByProps({ 'aria-label': '选择模型 failed' }).props.disabled).toBeFalsy();
    act(() => action.props.onClick());
    const row = root.root.findByProps({ 'data-model-name': 'failed' });
    expect(text(row)).toContain('检测不可用');
    expect(text(row)).toContain('待手动禁用');
    expect(root.root.findByProps({ id: 'account-model-key' }).props.disabled).toBe(true);
    expect(button('刷新模型列表').props.disabled).toBe(true);
    click('保存更改');
    expect(onSave).toHaveBeenCalledWith(11, ['banned', 'failed']);
  });

  it('uses checkboxes only for selection and bulk edits only the selected models', () => {
    render();
    act(() => root.root.findByProps({ 'aria-label': '选择模型 failed' }).props.onChange());
    expect(button('保存更改').props.disabled).toBe(true);
    click('手动禁用所选');
    expect(text(root.root.findByProps({ 'data-model-name': 'failed' }))).toContain('待手动禁用');
    expect(text(root.root.findByProps({ 'data-model-name': 'healthy' }))).toContain('自动检测');
    expect(text(root.root.findByProps({ 'data-model-name': 'healthy' }))).not.toContain('待手动禁用');
    click('保存更改');
    expect(onSave).toHaveBeenCalledWith(11, ['banned', 'failed']);
    click('撤销更改');
    expect(button('保存更改').props.disabled).toBe(true);
    expect(root.root.findByProps({ id: 'account-model-key' }).props.disabled).toBe(false);
  });

  it('releases a ban without presenting a failed model as healthy', () => {
    render();
    act(() => root.root.findByProps({ 'aria-label': '解除禁用 banned' }).props.onClick());
    const row = root.root.findByProps({ 'data-model-name': 'banned' });
    expect(text(row)).toContain('检测不可用');
    expect(text(row)).toContain('待解除禁用');
    expect(text(row)).toContain('允许探活');
    click('保存更改');
    expect(onSave).toHaveBeenCalledWith(11, []);
  });

  it('requires an explicit discard before closing with unsaved changes', () => {
    render();
    act(() => root.root.findByProps({ 'aria-label': '手动禁用 failed' }).props.onClick());
    click('取消');
    expect(onClose).not.toHaveBeenCalled();
    expect(root.root.findByProps({ role: 'alert' })).toBeTruthy();
    click('继续编辑');
    expect(root.root.findAllByProps({ role: 'alert' })).toHaveLength(0);
    click('取消');
    click('放弃更改并关闭');
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('supports the same explicit failed-model action on mobile', () => {
    vi.stubGlobal('innerWidth', 390);
    render();
    expect(root.root.findAllByType('table')).toHaveLength(0);
    act(() => root.root.findByProps({ 'aria-label': '手动禁用 failed' }).props.onClick());
    click('保存更改');
    expect(onSave).toHaveBeenCalledWith(11, ['banned', 'failed']);
  });

  it('does not expose account scope or account policy when a managed account has no Keys', () => {
    render({ tokenId: 0, tokens: [], models: [], pendingDisabled: new Set() });
    expect(JSON.stringify(root.toJSON())).toContain('请先同步或添加上游 Key');
    expect(root.root.findAllByType('select')).toHaveLength(0);
    expect(button('保存更改').props.disabled).toBe(true);
  });

  it('keeps the direct connection policy editable after changing it and lets undo restore it', () => {
    render({ tokenId: 0, tokens: [], keyRequired: false });
    act(() => root.root.findByProps({ id: 'account-model-new-policy' }).props.onChange({ target: { value: 'disable' } }));
    expect(root.root.findByProps({ id: 'account-model-new-policy' }).props.disabled).toBe(false);
    expect(button('保存更改').props.disabled).toBe(false);
    click('撤销更改');
    expect(root.root.findByProps({ id: 'account-model-new-policy' }).props.value).toBe('auto');
    expect(button('保存更改').props.disabled).toBe(true);
  });
});
