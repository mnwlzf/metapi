export type ModelProbeStatus = 'available' | 'unavailable' | 'unknown';

export type AccountModelRow = {
  name: string;
  latencyMs: number | null;
  disabled: boolean;
  manualDisabled?: boolean;
  disabledSource?: string | null;
  probeStatus?: ModelProbeStatus;
  inherited?: boolean;
  isManual?: boolean;
};

export function isSavedManualDisabled(model: AccountModelRow): boolean {
  return model.manualDisabled ?? (model.disabled && model.disabledSource !== 'probe');
}

export function getModelProbeStatus(model: AccountModelRow): ModelProbeStatus {
  return model.probeStatus ?? (model.disabledSource === 'probe' ? 'unavailable' : 'unknown');
}

export function getManualChanges(models: AccountModelRow[], pendingDisabled: Set<string>) {
  const editable = models.filter((model) => !model.inherited);
  return {
    ban: editable.filter((model) => pendingDisabled.has(model.name) && !isSavedManualDisabled(model)),
    release: editable.filter((model) => !pendingDisabled.has(model.name) && isSavedManualDisabled(model)),
  };
}

/** Bulk selection never changes inherited account policy or automatic verdicts. */
export function applyManualAction(models: AccountModelRow[], pendingDisabled: Set<string>, selected: Set<string>, disabled: boolean) {
  const next = new Set(pendingDisabled);
  for (const model of models) {
    if (model.inherited || !selected.has(model.name)) continue;
    if (disabled) next.add(model.name);
    else next.delete(model.name);
  }
  return next;
}
