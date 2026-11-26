import React from 'react';
import CenteredModal from '../../components/CenteredModal.js';
import ResponsiveBatchActionBar from '../../components/ResponsiveBatchActionBar.js';
import { useIsMobile } from '../../components/useIsMobile.js';
import { fuzzyMatch } from '../helpers/fuzzySearch.js';
import { tr } from '../../i18n.js';
import AccountModelList from './AccountModelList.js';
import AccountModelAdvancedSettings from './AccountModelAdvancedSettings.js';
import { applyManualAction, getManualChanges, getModelProbeStatus, isSavedManualDisabled, type AccountModelRow } from './modelManagementState.js';
import './accountModels.css';

type AccountModelModalState = {
  open: boolean;
  newModelPolicy?: 'auto' | 'disable';
  initialNewModelPolicy?: 'auto' | 'disable';
  account: any | null;
  tokenId?: number;
  keyRequired?: boolean;
  tokens?: Array<{ id: number; name: string; tokenGroup?: string | null }>;
  models: AccountModelRow[];
  pendingDisabled: Set<string>;
  loading: boolean;
  saving: boolean;
  siteName: string;
  manualModelsInput: string;
  addingManualModels: boolean;
};

type AccountModelsModalProps = {
  modelModal: AccountModelModalState;
  inputStyle: React.CSSProperties;
  onClose: () => void;
  onSave: () => void;
  onTokenChange?: (tokenId: number) => void;
  onRefresh: () => Promise<void> | void;
  onToggleModelDisabled: (modelName: string) => void;
  onNewModelPolicyChange: (policy: 'auto' | 'disable') => void;
  onSetPendingDisabled: (pendingDisabled: Set<string>) => void;
  onManualInputChange: (value: string) => void;
  onAddManualModels: () => Promise<void> | void;
  onRemoveManualModel: (modelName: string) => Promise<void> | void;
  removingManualModelName: string | null;
};

type ModelFilter = 'all' | 'unavailable' | 'manual' | 'automatic' | 'changed';

export default function AccountModelsModal(props: AccountModelsModalProps) {
  const { modelModal: state, onClose, onSave, onTokenChange, onRefresh } = props;
  const isMobile = useIsMobile();
  const [search, setSearch] = React.useState('');
  const [filter, setFilter] = React.useState<ModelFilter>('all');
  const [selected, setSelected] = React.useState<Set<string>>(new Set());
  const [confirmClose, setConfirmClose] = React.useState(false);
  React.useEffect(() => {
    setSearch(''); setFilter('all'); setSelected(new Set()); setConfirmClose(false);
  }, [state.open, state.account?.id, state.tokenId]);

  const changes = getManualChanges(state.models, state.pendingDisabled);
  const policyChanged = (state.tokenId ?? 0) === 0 && (state.newModelPolicy ?? 'auto') !== (state.initialNewModelPolicy ?? 'auto');
  const dirty = changes.ban.length + changes.release.length > 0 || policyChanged;
  const busy = state.saving || state.loading || state.addingManualModels || props.removingManualModelName !== null;
  const missingKey = !!state.keyRequired && (state.tokenId ?? 0) <= 0;
  const banned = (model: AccountModelRow) => !!model.inherited || state.pendingDisabled.has(model.name);
  const changed = (model: AccountModelRow) => !model.inherited && banned(model) !== isSavedManualDisabled(model);
  const filters: Array<{ id: ModelFilter; label: string; count: number }> = [
    { id: 'all', label: tr('全部模型'), count: state.models.length },
    { id: 'unavailable', label: tr('检测不可用'), count: state.models.filter((model) => getModelProbeStatus(model) === 'unavailable').length },
    { id: 'manual', label: tr('手动禁用'), count: state.models.filter(banned).length },
    { id: 'automatic', label: tr('自动检测'), count: state.models.filter((model) => !banned(model)).length },
    { id: 'changed', label: tr('待保存'), count: state.models.filter(changed).length },
  ];
  const filtered = state.models.filter((model) => {
    if (search.trim() && !fuzzyMatch(model.name, search.trim())) return false;
    if (filter === 'unavailable') return getModelProbeStatus(model) === 'unavailable';
    if (filter === 'manual') return banned(model);
    if (filter === 'automatic') return !banned(model);
    if (filter === 'changed') return changed(model);
    return true;
  });
  const selectedModels = state.models.filter((model) => selected.has(model.name) && !model.inherited);
  const requestClose = () => {
    if (busy) return;
    if (dirty) setConfirmClose(true);
    else onClose();
  };
  const undo = () => {
    props.onSetPendingDisabled(new Set(state.models.filter(isSavedManualDisabled).map((model) => model.name)));
    props.onNewModelPolicyChange(state.initialNewModelPolicy ?? 'auto');
    setConfirmClose(false);
  };
  const bulk = (disabled: boolean) => {
    props.onSetPendingDisabled(applyManualAction(state.models, state.pendingDisabled, selected, disabled));
    setSelected(new Set());
  };
  const health = state.account?.runtimeHealth;
  const stale = health?.source === 'model-discovery' && ['unhealthy', 'degraded'].includes(health.state);
  const token = state.tokens?.find((item) => item.id === state.tokenId);

  return <CenteredModal open={state.open} onClose={requestClose} maxWidth={980} className="account-models-modal"
    showCloseButton={!busy} title={state.siteName ? `${tr('模型管理')} · ${state.siteName}` : tr('模型管理')}
    footer={<>
      <div className="account-models-save-summary" role="status">
        {dirty ? <>{tr('待手动禁用')} {changes.ban.length} · {tr('待解除禁用')} {changes.release.length}
          {policyChanged ? ` · ${tr('新模型策略已修改')}` : ''}</> : tr('修改仅影响当前 Key')}
      </div>
      {dirty ? <button type="button" className="btn btn-ghost" disabled={busy} onClick={undo}>{tr('撤销更改')}</button> : null}
      <button type="button" className="btn btn-ghost" disabled={busy} onClick={requestClose}>{tr('取消')}</button>
      <button type="button" className="btn btn-primary" disabled={busy || !dirty || missingKey} onClick={onSave}>
        {state.saving ? <><span className="spinner spinner-sm" />{tr('保存中...')}</> : tr('保存更改')}
      </button>
    </>}>
    <div className="account-models-content">
      {confirmClose ? <div className="account-models-notice" role="alert">
        <span>{tr('还有未保存的更改，确定放弃吗？')}</span>
        <button type="button" className="btn btn-ghost btn-sm" onClick={() => setConfirmClose(false)}>{tr('继续编辑')}</button>
        <button type="button" className="btn btn-soft-danger btn-sm" onClick={onClose}>{tr('放弃更改并关闭')}</button>
      </div> : null}
      <div className="account-models-scope">
        <div className="account-models-scope-field"><label htmlFor="account-model-key">{tr('目标 Key')}</label>
          {state.tokens?.length ? <select id="account-model-key" style={props.inputStyle} value={state.tokenId}
            disabled={busy || dirty} onChange={(event) => onTokenChange?.(Number(event.target.value))}>
            {state.tokens.map((item) => <option key={item.id} value={item.id}>{item.name} #{item.id}{item.tokenGroup ? ` · ${item.tokenGroup}` : ''}</option>)}
          </select> : <div id="account-model-key" className="account-models-current-key">{missingKey ? tr('暂无可管理的 Key') : tr('当前连接的 API Key')}</div>}
        </div>
        <div className="account-models-scope-info">
          <strong>{state.account?.username || `#${state.account?.id ?? ''}`}{token ? ` · Key #${token.id}` : ''}</strong>
          <span>{tr('手动禁用后停止探活和路由；其他 Key 的同名模型不受影响。')}</span>
        </div>
        <button type="button" className="btn btn-ghost" disabled={busy || dirty} onClick={() => void onRefresh()}>{tr('刷新模型列表')}</button>
      </div>
      {dirty ? <div className="account-models-hint">{tr('更改尚未生效。请先保存或撤销，再切换 Key、刷新列表或管理手动添加的模型。')}</div> : null}
      <div className="account-models-explanation">
        <div><strong>{tr('自动检测')}</strong><span>{tr('检测不可用时暂不路由，后续继续探活，成功后自动恢复。')}</span></div>
        <div><strong>{tr('手动禁用')}</strong><span>{tr('无论检测结果如何都不再探活，直到你解除禁用。')}</span></div>
      </div>
      {stale ? <div className="account-models-notice">{tr('刷新失败，显示上次结果')}{health.reason ? `：${health.reason}` : ''}</div> : null}
      {state.loading ? <div className="account-models-empty"><span className="spinner" />{tr('加载模型列表...')}</div> : missingKey ? <div className="account-models-empty">{tr('请先同步或添加上游 Key，再管理该 Key 的模型。')}</div> : <>
        <div className="account-models-toolbar">
          <input type="search" value={search} placeholder={tr('搜索模型名称')} aria-label={tr('搜索模型名称')}
            style={props.inputStyle} onChange={(event) => { setSearch(event.target.value); setSelected(new Set()); }} />
          <div className="account-models-filters" role="group" aria-label={tr('筛选模型')}>
            {filters.map((item) => <button type="button" key={item.id} className={`btn btn-sm ${filter === item.id ? 'btn-soft-primary' : 'btn-ghost'}`}
              aria-pressed={filter === item.id} onClick={() => { setFilter(item.id); setSelected(new Set()); }}>{item.label} {item.count}</button>)}
          </div>
        </div>
        {selectedModels.length > 0 ? <ResponsiveBatchActionBar isMobile={isMobile}
          info={<>{tr('已选择')} {selectedModels.length}</>} desktopStyle={{ padding: 8 }}>
          <button type="button" className="btn btn-soft-danger btn-sm" disabled={busy || selectedModels.every(banned)} onClick={() => bulk(true)}>{tr('手动禁用所选')}</button>
          <button type="button" className="btn btn-ghost btn-sm" disabled={busy || selectedModels.every((model) => !banned(model))} onClick={() => bulk(false)}>{tr('解除所选禁用')}</button>
          <button type="button" className="btn btn-ghost btn-sm" disabled={busy} onClick={() => setSelected(new Set())}>{tr('清除选择')}</button>
        </ResponsiveBatchActionBar> : <div className="account-models-hint">{tr('复选框仅用于批量选择；也可直接使用每行的操作按钮。')}</div>}
        {filtered.length ? <AccountModelList models={filtered} pendingDisabled={state.pendingDisabled} selected={selected}
          busy={busy} isMobile={isMobile} hasChanges={dirty} removingManualModelName={props.removingManualModelName}
          onSelect={(name) => setSelected((current) => {
            const next = new Set(current); if (next.has(name)) next.delete(name); else next.add(name); return next;
          })}
          onSelectVisible={() => setSelected((current) => {
            const editable = filtered.filter((model) => !model.inherited);
            const all = editable.every((model) => current.has(model.name));
            const next = new Set(current);
            for (const model of editable) { if (all) next.delete(model.name); else next.add(model.name); }
            return next;
          })} onToggle={props.onToggleModelDisabled} onRemove={(name) => void props.onRemoveManualModel(name)} />
          : <div className="account-models-empty">{state.models.length ? tr('没有匹配的模型') : tr('暂无模型记录，请先刷新模型列表。')}</div>}
        <AccountModelAdvancedSettings {...props} busy={busy} hasChanges={dirty} />
      </>}
    </div>
  </CenteredModal>;
}
