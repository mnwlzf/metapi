import { MobileCard, MobileField } from '../../components/MobileCard.js';
import { StatusPill } from '../../components/StatusText.js';
import { tr } from '../../i18n.js';
import { getModelProbeStatus, isSavedManualDisabled, type AccountModelRow } from './modelManagementState.js';

type Props = {
  models: AccountModelRow[];
  pendingDisabled: Set<string>;
  selected: Set<string>;
  isMobile: boolean;
  busy: boolean;
  onSelect: (name: string) => void;
  onSelectVisible: () => void;
  onToggle: (name: string) => void;
  onRemove: (name: string) => void;
  removingManualModelName: string | null;
  hasChanges: boolean;
};

export default function AccountModelList(props: Props) {
  const { models, pendingDisabled, selected, isMobile, busy, onSelect, onSelectVisible, onToggle } = props;
  const selectable = models.filter((model) => !model.inherited);
  const selectedCount = selectable.filter((model) => selected.has(model.name)).length;
  const selectAll = (
    <input type="checkbox" aria-label={tr('选择当前列表全部模型')}
      checked={selectable.length > 0 && selectedCount === selectable.length}
      disabled={busy || selectable.length === 0}
      ref={(el) => { if (el) el.indeterminate = selectedCount > 0 && selectedCount < selectable.length; }}
      onChange={onSelectVisible} />
  );
  const selection = (model: AccountModelRow) => (
    <input type="checkbox" aria-label={`${tr('选择模型')} ${model.name}`} checked={selected.has(model.name)}
      disabled={busy || model.inherited} onChange={() => onSelect(model.name)} />
  );
  const probe = (model: AccountModelRow) => {
    const status = getModelProbeStatus(model);
    return <StatusPill tone={status === 'available' ? 'success' : status === 'unavailable' ? 'warning' : 'muted'}>
      {status === 'available' ? tr('检测可用') : status === 'unavailable' ? tr('检测不可用') : tr('尚未检测')}
    </StatusPill>;
  };
  const policy = (model: AccountModelRow) => {
    const banned = pendingDisabled.has(model.name) || !!model.inherited;
    const changed = !model.inherited && banned !== isSavedManualDisabled(model);
    return <div className="account-models-policy">
      <StatusPill tone={banned ? 'danger' : 'info'}>
        {model.inherited ? tr('账号级禁用') : changed ? (banned ? tr('待手动禁用') : tr('待解除禁用'))
          : banned ? tr('手动禁用') : tr('自动检测')}
      </StatusPill>
      <span className="account-models-hint">{banned ? tr('不探活、不路由') : tr('允许探活，结果决定是否路由')}</span>
    </div>;
  };
  const actions = (model: AccountModelRow) => model.inherited ? (
    <span className="account-models-hint">{tr('受已有账号禁用策略限制')}</span>
  ) : <div className="account-models-row-actions">
    <button type="button" className={pendingDisabled.has(model.name) ? 'btn btn-ghost btn-sm' : 'btn btn-soft-danger btn-sm'}
      disabled={busy} aria-label={`${pendingDisabled.has(model.name) ? tr('解除禁用') : tr('手动禁用')} ${model.name}`}
      onClick={() => onToggle(model.name)}>
      {pendingDisabled.has(model.name) ? tr('解除禁用') : tr('手动禁用')}
    </button>
    {model.isManual ? <button type="button" className="btn btn-ghost btn-sm"
      disabled={busy || props.hasChanges || props.removingManualModelName !== null}
      aria-label={`${tr('删除手动模型')} ${model.name}`} onClick={() => props.onRemove(model.name)}>
      {props.removingManualModelName === model.name ? tr('删除中...') : tr('删除手动模型')}
    </button> : null}
  </div>;
  const modelName = (model: AccountModelRow) => <div className="account-models-name">
    <span>{model.name}</span>
    {model.latencyMs != null ? <span className="account-models-hint">{model.latencyMs} ms</span> : null}
    {model.isManual ? <span className="account-models-hint">{tr('手动添加')}</span> : null}
  </div>;

  if (isMobile) return <div className="account-models-list">
    <label className="account-models-select-all">{selectAll}{tr('选择当前列表全部模型')}</label>
    <div className="mobile-card-list">{models.map((model) => <MobileCard key={model.name} compact
      title={<label className="account-models-mobile-name">{selection(model)}{modelName(model)}</label>}
      footerActions={actions(model)}>
      <MobileField label={tr('检测结果')} value={probe(model)} />
      <MobileField label={tr('使用策略')} value={policy(model)} />
    </MobileCard>)}</div>
  </div>;

  return <div className="account-models-list"><table className="account-models-table">
    <thead><tr><th>{selectAll}</th><th>{tr('模型')}</th><th>{tr('检测结果')}</th><th>{tr('使用策略')}</th><th>{tr('操作')}</th></tr></thead>
    <tbody>{models.map((model) => <tr key={model.name} data-model-name={model.name}>
      <td>{selection(model)}</td><td>{modelName(model)}</td><td>{probe(model)}</td><td>{policy(model)}</td><td>{actions(model)}</td>
    </tr>)}</tbody>
  </table></div>;
}
