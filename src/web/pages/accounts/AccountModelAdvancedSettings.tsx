import React from 'react';
import { tr } from '../../i18n.js';

type Props = {
  modelModal: {
    tokenId?: number;
    keyRequired?: boolean;
    newModelPolicy?: 'auto' | 'disable';
    manualModelsInput: string;
    addingManualModels: boolean;
  };
  inputStyle: React.CSSProperties;
  busy: boolean;
  hasChanges: boolean;
  onNewModelPolicyChange: (policy: 'auto' | 'disable') => void;
  onManualInputChange: (value: string) => void;
  onAddManualModels: () => Promise<void> | void;
};

export default function AccountModelAdvancedSettings(props: Props) {
  const { modelModal: state } = props;
  if ((state.tokenId ?? 0) > 0 || state.keyRequired) return null;
  return <details className="account-models-advanced">
    <summary>{tr('新模型策略与手动添加')}</summary>
    <div className="account-models-advanced-fields">
      <label htmlFor="account-model-new-policy">{tr('新模型默认策略')}</label>
      <select id="account-model-new-policy" style={props.inputStyle} value={state.newModelPolicy ?? 'auto'}
        disabled={props.busy} onChange={(event) => props.onNewModelPolicyChange(event.target.value as 'auto' | 'disable')}>
        <option value="auto">{tr('自动检测')}</option>
        <option value="disable">{tr('默认禁用，手动解除')}</option>
      </select>
      <label htmlFor="account-model-manual-input">{tr('手动添加模型')}</label>
      <div className="account-models-add">
        <input id="account-model-manual-input" style={props.inputStyle} value={state.manualModelsInput}
          disabled={props.busy || props.hasChanges} placeholder={tr('多个模型用英文逗号分隔')}
          onChange={(event) => props.onManualInputChange(event.target.value)} />
        <button type="button" className="btn btn-ghost" disabled={props.busy || props.hasChanges || !state.manualModelsInput.trim()}
          onClick={() => void props.onAddManualModels()}>{state.addingManualModels ? tr('添加中...') : tr('添加模型')}</button>
      </div>
    </div>
  </details>;
}
