import { Fragment, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../api.js';
import { useToast } from '../components/Toast.js';
import { MobileCard, MobileField } from '../components/MobileCard.js';
import { useIsMobile } from '../components/useIsMobile.js';
import ListPage from '../components/ListPage.js';
import { tr } from '../i18n.js';
import FirstVerificationPanel from './probe-plan/FirstVerificationPanel.js';

type ProbeModelType = 'text' | 'image' | 'embedding' | 'rerank' | 'audio' | 'video' | 'other';
type ProbePlanKeyResult = {
  keyId: number | null;
  keyName: string;
  keyGroup: string | null;
  accountId: number;
  accountName: string | null;
  siteId: number;
  siteName: string;
  platform: string;
  available: boolean | null;
  connectivity: boolean | null;
  availabilityLatencyMs: number | null;
  availabilityCheckedAt: string | null;
  routeState: 'manual-disabled' | 'policy-disabled' | 'probe-disabled' | 'pending-verification' | 'available' | 'unavailable' | 'unknown';
  recentCalls: number;
  lastProbe: {
    status: string;
    latencyMs: number | null;
    tokensUsed: number | null;
    estimatedCost: number | null;
    errorMessage: string | null;
    questionCategory: string;
    createdAt: string | null;
  } | null;
};
type ProbePlanModel = {
  modelName: string;
  type: ProbeModelType;
  tab: 'probeable' | 'manual-disabled' | 'policy-disabled';
  recentCalls: number;
  intervalHours: number;
  automaticIntervalHours: number;
  overridden: boolean;
  pendingVerificationCount: number;
  keyResults: ProbePlanKeyResult[];
  manualExcludedKeys: ProbePlanKeyResult[];
  policyExcludedKeys: ProbePlanKeyResult[];
};
type ProbePlanTab = ProbePlanModel['tab'] | 'pending-verification';

const TYPE_LABELS: Record<ProbeModelType, string> = {
  text: tr('文本'), image: tr('图片'), embedding: tr('向量'), rerank: tr('重排'),
  audio: tr('音频'), video: tr('视频'), other: tr('其他'),
};
const TYPE_ORDER: ProbeModelType[] = ['text', 'image', 'embedding', 'rerank', 'audio', 'video', 'other'];

export default function ProbePlan() {
  const toast = useToast();
  const isMobile = useIsMobile();
  const [search, setSearch] = useState('');
  const [typeFilter, setTypeFilter] = useState<ProbeModelType | 'all'>('all');
  const [planTab, setPlanTab] = useState<ProbePlanTab>('probeable');
  const isProbeView = planTab === 'probeable' || planTab === 'pending-verification';
  const [overrideFilter, setOverrideFilter] = useState<'all' | 'automatic' | 'custom'>('all');
  const [savingModel, setSavingModel] = useState('');
  const [probingModel, setProbingModel] = useState('');
  const [expandedModel, setExpandedModel] = useState<string | null>(null);
  const planQuery = useQuery({
    queryKey: ['model-probe-plan'],
    queryFn: () => api.getModelProbePlan(),
    staleTime: 30_000,
    refetchInterval: 10_000,
  });
  const models = planQuery.data?.models ?? [];
  const tabCounts = useMemo(() => models.reduce((counts, model) => {
    counts[model.tab] = (counts[model.tab] || 0) + 1;
    return counts;
  }, { probeable: 0, 'manual-disabled': 0, 'policy-disabled': 0 }), [models]);
  const pendingModels = models.filter((model) => model.pendingVerificationCount > 0);
  const tabModels = useMemo(() => models.filter((model) => planTab === 'pending-verification'
    ? model.pendingVerificationCount > 0 : model.tab === planTab), [models, planTab]);
  const typeCounts = useMemo(() => tabModels.reduce((counts, model) => {
    counts[model.type] = (counts[model.type] || 0) + 1;
    return counts;
  }, {} as Partial<Record<ProbeModelType, number>>), [tabModels]);
  const customCount = models.filter((model) => model.tab === 'probeable' && model.overridden).length;
  const filteredModels = useMemo(() => {
    const query = search.trim().toLowerCase();
    return tabModels.filter((model) => {
      if (query && !model.modelName.toLowerCase().includes(query)) return false;
      if (typeFilter !== 'all' && model.type !== typeFilter) return false;
      if (planTab === 'probeable' && overrideFilter === 'automatic' && model.overridden) return false;
      if (planTab === 'probeable' && overrideFilter === 'custom' && !model.overridden) return false;
      return true;
    });
  }, [overrideFilter, planTab, search, tabModels, typeFilter]);

  async function updateInterval(modelName: string, intervalHours: number | null) {
    setSavingModel(modelName);
    try {
      await api.setModelProbeInterval(modelName, intervalHours);
      await planQuery.refetch();
      toast.success(tr('探测频率已保存'));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : tr('保存探测频率失败'));
    } finally {
      setSavingModel('');
    }
  }

  async function probeModelNow(model: ProbePlanModel) {
    const siteIds = [...new Set(model.keyResults.map((key) => key.siteId))].filter((siteId) => siteId > 0);
    if (siteIds.length === 0) {
      toast.error(tr('没有可探测的 Key'));
      return;
    }
    setProbingModel(model.modelName);
    try {
      let probed = 0;
      let supported = 0;
      let unavailable = 0;
      let estimatedCost = 0;
      for (const siteId of siteIds) {
        const result = await api.probeSiteNow(siteId, {
          scope: 'single',
          modelName: model.modelName,
          force: true,
        }) as {
          success: boolean;
          error?: string;
          probed?: number;
          supported?: number;
          unsupported?: number;
          inconclusive?: number;
          estimatedCost?: number;
        };
        if (!result.success) throw new Error(result.error || tr('探测失败'));
        probed += Number(result.probed || 0);
        supported += Number(result.supported || 0);
        unavailable += Number(result.unsupported || 0) + Number(result.inconclusive || 0);
        estimatedCost += Number(result.estimatedCost || 0);
      }
      await planQuery.refetch();
      toast.success(`${tr('探测完成')}：${supported}/${probed} ${tr('可用')}，${unavailable} ${tr('不可用或未确认')}，${tr('费用')} ${formatCost(estimatedCost)}`);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : tr('探测失败'));
      await planQuery.refetch();
    } finally {
      setProbingModel('');
    }
  }

  function renderProbeButton(model: ProbePlanModel) {
    if (planTab === 'pending-verification' || model.pendingVerificationCount > 0) return (
      <button type="button" className="btn btn-ghost btn-sm"
        aria-label={`${tr('首次验证下一批')} ${model.modelName}`}
        disabled={!!probingModel || planQuery.data?.firstVerification?.budget.running || !!planQuery.data?.firstVerification?.budget.pauseReason}
        onClick={() => void verifyModel(model.modelName)}>{tr('验证下一批')}</button>
    );
    const isProbing = probingModel === model.modelName;
    return (
      <button
        type="button"
        className="btn btn-ghost btn-sm probe-plan-probe-button"
        disabled={!!probingModel || model.keyResults.length === 0}
        title={model.keyResults.length === 0 ? tr('没有可探测的 Key') : tr('探测此模型')}
        aria-label={`${tr('探测此模型')} ${model.modelName}`}
        onClick={() => void probeModelNow(model)}
      >
        {isProbing ? <span className="spinner spinner-sm" /> : <ProbeIcon />}
        <span>{isProbing ? tr('探测中...') : tr('手动探测')}</span>
      </button>
    );
  }

  async function verifyModel(modelName: string) {
    setProbingModel(modelName);
    try {
      await api.runFirstVerification(modelName);
      toast.success(tr('已安排首次验证，将按额度分批处理，可在任务中心查看结果'));
      await planQuery.refetch();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : tr('安排验证失败'));
    } finally { setProbingModel(''); }
  }

  function renderIntervalControl(model: ProbePlanModel) {
    return (
      <select
        className="probe-plan-frequency"
        value={model.overridden ? String(model.intervalHours) : 'auto'}
        disabled={savingModel === model.modelName || model.keyResults.length === 0}
        aria-label={`${model.modelName} ${tr('探测频率')}`}
        onChange={(event) => void updateInterval(model.modelName, event.target.value === 'auto' ? null : Number(event.target.value))}
      >
        <option value="auto">{tr('自动')} · {formatInterval(model.automaticIntervalHours)}</option>
        {(planQuery.data?.intervals ?? []).map((hours) => (
          <option key={hours} value={hours}>{formatInterval(hours)}</option>
        ))}
      </select>
    );
  }

  function toggleModelDetails(modelName: string) {
    setExpandedModel((current) => current === modelName ? null : modelName);
  }

  return (
    <ListPage
      className="probe-plan-page"
      title={tr('模型探测计划')}
      subtitle={tr('探测按上游 Key 与模型分别执行；此处频率覆盖按模型生效，会应用于所有提供该模型的 Key。')}
      actions={(
        <button type="button" className="btn btn-ghost probe-plan-refresh" onClick={() => void planQuery.refetch()} disabled={planQuery.isFetching}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><path strokeLinecap="round" strokeLinejoin="round" d="M20 7v5h-5M4 17v-5h5m11-1a8 8 0 0 0-14.9-3M4 13a8 8 0 0 0 14.9 3" /></svg>
          {tr('刷新')}
        </button>
      )}
      loading={planQuery.isLoading}
      loadingFallback={<div className="probe-plan-loading"><span className="spinner" />{tr('正在加载探测计划')}</div>}
      isEmpty={!planQuery.isLoading && models.length === 0}
      emptyTitle={tr('暂无已发现模型')}
      emptyDesc={tr('先刷新站点的模型列表，模型出现后即可在这里调整探测频率。')}
      beforeList={(
        <>
          {planQuery.data?.firstVerification && <FirstVerificationPanel
            data={planQuery.data.firstVerification}
            pendingCount={models.reduce((sum, model) => sum + model.pendingVerificationCount, 0)}
            onRefresh={async () => { await planQuery.refetch(); }}
          />}
          <div className="probe-plan-summary" aria-label={tr('模型探测概览')}>
            <SummaryMetric label={tr('模型总数')} value={models.length} />
            <SummaryMetric label={tr('自动调度')} value={tabCounts.probeable - customCount} />
            <SummaryMetric label={tr('手动覆盖')} value={customCount} accent={customCount > 0} />
            <SummaryMetric label={tr('图片模型')} value={typeCounts.image || 0} />
            <SummaryMetric label={tr('向量与重排')} value={(typeCounts.embedding || 0) + (typeCounts.rerank || 0)} />
          </div>

          <div className="probe-plan-policy">
            <span className="probe-plan-policy-mark" aria-hidden="true">i</span>
            <span>{tr('自动频率根据近 7 天请求量调整；图片、视频及其他非文本模型默认每 72 小时探测。选择具体间隔可覆盖自动建议，选择自动可恢复。')}</span>
          </div>

          <div className="probe-plan-controls">
            <div className="probe-plan-status-tabs" role="tablist" aria-label={tr('按模型状态筛选')}>
              <StatusTab active={planTab === 'probeable'} onClick={() => setPlanTab('probeable')} label={tr('探测计划')} count={tabCounts.probeable} />
              <StatusTab active={planTab === 'pending-verification'} onClick={() => { setPlanTab('pending-verification'); setTypeFilter('all'); }} label={tr('待首次验证')} count={pendingModels.length} />
              <StatusTab active={planTab === 'manual-disabled'} onClick={() => setPlanTab('manual-disabled')} label={tr('手动禁用')} count={tabCounts['manual-disabled']} />
              <StatusTab active={planTab === 'policy-disabled'} onClick={() => setPlanTab('policy-disabled')} label={tr('策略禁用')} count={tabCounts['policy-disabled']} />
            </div>
            {planTab === 'pending-verification' && <div className="probe-plan-policy">{tr('此处仅验证尚未确认的 Key × 模型；已有可用 Key 继续参与路由。首次验证独立于下方常规复测频率，失败后按常规计划复测。')}</div>}
            {!isProbeView && (
              <div className={`probe-plan-status-note is-${planTab}`}>
                {planTab === 'manual-disabled'
                  ? tr('这些模型的所有 Key 都已手动禁用，因此不会参与探测或路由。')
                  : tr('这些模型当前没有可探测的 Key，包含策略排除，也可能包含手动禁用。')}
              </div>
            )}
            <div className="probe-plan-type-tabs" role="group" aria-label={tr('按模型类型筛选')}>
              <FilterTab active={typeFilter === 'all'} onClick={() => setTypeFilter('all')} label={tr('全部')} count={tabModels.length} />
              {TYPE_ORDER.filter((type) => (typeCounts[type] || 0) > 0).map((type) => (
                <FilterTab key={type} active={typeFilter === type} onClick={() => setTypeFilter(type)} label={TYPE_LABELS[type]} count={typeCounts[type] || 0} />
              ))}
            </div>
            <div className="probe-plan-filter-row">
              <label className="probe-plan-search">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><circle cx="10.8" cy="10.8" r="6.3" /><path strokeLinecap="round" d="m16 16 4.2 4.2" /></svg>
                <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder={tr('搜索模型名称')} aria-label={tr('搜索模型名称')} />
              </label>
              {planTab === 'probeable' && <label className="probe-plan-override-filter">
                <span>{tr('频率设置')}</span>
                <select value={overrideFilter} onChange={(event) => setOverrideFilter(event.target.value as typeof overrideFilter)} aria-label={tr('按频率设置筛选')}>
                  <option value="all">{tr('全部模型')}</option>
                  <option value="automatic">{tr('自动调度')}</option>
                  <option value="custom">{tr('手动覆盖')}</option>
                </select>
              </label>}
              <div className="probe-plan-result-count">{tr('显示')} <strong>{filteredModels.length}</strong> / {tabModels.length}</div>
            </div>
          </div>
        </>
      )}
      cardStyle={{ padding: 0 }}
    >
      {isMobile ? (
        <div className="probe-plan-mobile-list">
          {filteredModels.map((model) => (
            <MobileCard
              key={model.modelName}
              compact
              title={(
                <button type="button" className="probe-plan-expand-button" aria-expanded={expandedModel === model.modelName} onClick={() => toggleModelDetails(model.modelName)}>
                  <Chevron expanded={expandedModel === model.modelName} />
                  <span className="probe-plan-model-name">{model.modelName}</span>
                </button>
              )}
              headerActions={<TypeBadge type={model.type} />}
              footerActions={(
                <div className="probe-plan-mobile-actions">
                  {isProbeView ? <>
                    <div className="probe-plan-mobile-frequency"><span>{tr('探测频率')}</span>{renderIntervalControl(model)}</div>
                    {renderProbeButton(model)}
                  </> : <StateBadge state={planTab} />}
                </div>
              )}
            >
              <MobileField label={tr('近 7 天请求')} value={model.recentCalls.toLocaleString()} />
              {isProbeView && <MobileField label={tr('待首次验证')} value={`${model.pendingVerificationCount} Key`} />}
              {expandedModel === model.modelName && <KeyDetails model={model} />}
            </MobileCard>
          ))}
          {filteredModels.length === 0 && <div className="probe-plan-no-results">{tr('没有匹配的模型')}</div>}
        </div>
      ) : (
        <div className="probe-plan-table-scroll">
          <table className="probe-plan-table">
            <thead>
              <tr>
                <th>{tr('模型')}</th>
                <th>{tr('分类')}</th>
                <th className="is-numeric">{tr('近 7 天请求')}</th>
                {isProbeView && <>
                  <th>{tr('自动建议')}</th>
                  <th>{tr('常规复测频率')}</th>
                  <th>{tr('模式')}</th>
                  <th>{tr('手动探测')}</th>
                </>}
                {!isProbeView && <th>{tr('状态')}</th>}
              </tr>
            </thead>
            <tbody>
              {filteredModels.map((model) => (
                <Fragment key={model.modelName}>
                  <tr>
                  <td>
                    <button type="button" className="probe-plan-expand-button" aria-expanded={expandedModel === model.modelName} onClick={() => toggleModelDetails(model.modelName)}>
                      <Chevron expanded={expandedModel === model.modelName} />
                      <span className="probe-plan-model-name">{model.modelName}</span>
                      {model.pendingVerificationCount > 0 && <span className="probe-plan-pending-count">{model.pendingVerificationCount} {tr('待验证')}</span>}
                    </button>
                  </td>
                  <td><TypeBadge type={model.type} /></td>
                  <td className="is-numeric probe-plan-calls">{model.recentCalls.toLocaleString()}</td>
                  {isProbeView ? <>
                    <td className="probe-plan-auto-value">{formatInterval(model.automaticIntervalHours)}</td>
                    <td>{renderIntervalControl(model)}</td>
                    <td><span className={`probe-plan-mode${model.overridden ? ' is-custom' : ''}`}>{model.overridden ? tr('手动') : tr('自动')}</span></td>
                    <td>{renderProbeButton(model)}</td>
                  </> : <td className="probe-plan-status-cell"><StateBadge state={planTab} /></td>}
                  </tr>
                  {expandedModel === model.modelName && <tr className="probe-plan-detail-row"><td colSpan={isProbeView ? 7 : 4}><KeyDetails model={model} /></td></tr>}
                </Fragment>
              ))}
              {filteredModels.length === 0 && <tr><td colSpan={isProbeView ? 7 : 4} className="probe-plan-no-results">{tr('没有匹配的模型')}</td></tr>}
            </tbody>
          </table>
        </div>
      )}
    </ListPage>
  );
}

function SummaryMetric({ label, value, accent = false }: { label: string; value: number; accent?: boolean }) {
  return (
    <div className="probe-plan-metric">
      <span className="probe-plan-metric-value" data-accent={accent || undefined}>{value.toLocaleString()}</span>
      <span className="probe-plan-metric-label">{label}</span>
    </div>
  );
}

function FilterTab({ active, label, count, onClick }: { active: boolean; label: string; count: number; onClick: () => void }) {
  return (
    <button type="button" aria-pressed={active} className={`probe-plan-tab${active ? ' is-active' : ''}`} onClick={onClick}>
      <span>{label}</span><span className="probe-plan-tab-count">{count}</span>
    </button>
  );
}

function StatusTab({ active, label, count, onClick }: { active: boolean; label: string; count: number; onClick: () => void }) {
  return (
    <button type="button" role="tab" aria-selected={active} className={`probe-plan-status-tab${active ? ' is-active' : ''}`} onClick={onClick}>
      <span>{label}</span><span className="probe-plan-status-count">{count}</span>
    </button>
  );
}

function TypeBadge({ type }: { type: ProbeModelType }) {
  return <span className={`probe-plan-type-badge type-${type}`}>{TYPE_LABELS[type]}</span>;
}

function Chevron({ expanded }: { expanded: boolean }) {
  return (
    <svg className={`probe-plan-chevron${expanded ? ' is-expanded' : ''}`} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true">
      <path strokeLinecap="round" strokeLinejoin="round" d="m5 6 3 3 3-3" />
    </svg>
  );
}

function ProbeIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
      <path strokeLinecap="round" strokeLinejoin="round" d="M12 3v3m0 12v3M3 12h3m12 0h3M5.64 5.64l2.12 2.12m8.48 8.48 2.12 2.12m0-12.72-2.12 2.12m-8.48 8.48-2.12 2.12" />
      <circle cx="12" cy="12" r="4" />
    </svg>
  );
}

function KeyDetails({ model }: { model: ProbePlanModel }) {
  const keys = model.keyResults;
  const availableCount = keys.filter((key) => key.routeState === 'available').length;
  const unavailableCount = keys.filter((key) => key.routeState === 'unavailable' || key.routeState === 'probe-disabled').length;
  const unprobedCount = keys.filter((key) => !key.lastProbe).length;
  return (
    <div className="probe-plan-key-details">
      <div className="probe-plan-key-detail-heading">
        <strong>{tr('各 Key 探测详情')}</strong>
        <div className="probe-plan-key-summary">
          <span className="is-good">{availableCount} {tr('可路由')}</span>
          <span className="is-bad">{unavailableCount} {tr('不可用')}</span>
          <span>{model.manualExcludedKeys.length} {tr('手动排除')}</span>
          <span>{model.policyExcludedKeys.length} {tr('策略排除')}</span>
          <span>{unprobedCount} {tr('未探测')}</span>
        </div>
      </div>
      {keys.length > 0 && <KeyResultSection title={tr('探测对象')} keys={keys} />}
      {model.manualExcludedKeys.length > 0 && <KeyResultSection title={tr('手动禁用的 Key')} keys={model.manualExcludedKeys} />}
      {model.policyExcludedKeys.length > 0 && <KeyResultSection title={tr('策略排除的 Key')} keys={model.policyExcludedKeys} />}
      {keys.length === 0 && model.manualExcludedKeys.length === 0 && model.policyExcludedKeys.length === 0 && (
        <div className="probe-plan-key-empty">{tr('没有上游 Key 模型记录')}</div>
      )}
    </div>
  );
}

function KeyResultSection({ title, keys }: { title: string; keys: ProbePlanKeyResult[] }) {
  return (
    <section className="probe-plan-key-section">
      <h3>{title}<span>{keys.length}</span></h3>
      <div className="probe-plan-key-list">
        {keys.map((key) => (
            <section className="probe-plan-key-row" key={`${key.siteId}:${key.accountId}:${key.keyId ?? 'account'}`}>
              <div className="probe-plan-key-identity">
                <div className="probe-plan-key-primary">{key.siteName}<span>{key.platform}</span></div>
                <div className="probe-plan-key-secondary">
                  {key.accountName || `${tr('账号')} #${key.accountId}`} · {key.keyName}
                  {key.keyGroup ? ` · ${key.keyGroup}` : ''}
                </div>
              </div>
              <div className="probe-plan-key-status-cell">
                <div className="probe-plan-key-label">{tr('路由状态')}</div>
                <StateBadge state={key.routeState} />
              </div>
              <div className="probe-plan-key-probe-cell">
                <div className="probe-plan-key-label">{tr('最近探测')}</div>
                <div className="probe-plan-key-probe-line">
                  <ProbeStatus status={key.lastProbe?.status ?? null} />
                  <span>{key.lastProbe?.createdAt ? formatDate(key.lastProbe.createdAt) : '—'}</span>
                </div>
              </div>
              <div className="probe-plan-key-metrics">
                <div><span>{tr('延迟')}</span><strong>{formatLatency(key.lastProbe?.latencyMs ?? key.availabilityLatencyMs)}</strong></div>
                <div><span>{tr('探测费用')}</span><strong>{formatCost(key.lastProbe?.estimatedCost)}</strong></div>
                <div><span>{tr('近 7 天请求')}</span><strong>{key.recentCalls.toLocaleString()}</strong></div>
                <div><span>{tr('Token')}</span><strong>{key.lastProbe?.tokensUsed == null ? '—' : key.lastProbe.tokensUsed.toLocaleString()}</strong></div>
              </div>
              {key.lastProbe?.errorMessage && (
                <div className="probe-plan-key-error" title={key.lastProbe.errorMessage}>{key.lastProbe.errorMessage}</div>
              )}
              {!key.lastProbe && key.availabilityCheckedAt && (
                <div className="probe-plan-key-footnote">{tr('可用性更新于')} {formatDate(key.availabilityCheckedAt)}</div>
              )}
            </section>
        ))}
      </div>
    </section>
  );
}

function StateBadge({ state }: { state: ProbePlanTab | ProbePlanKeyResult['routeState'] }) {
  const labels = {
    probeable: tr('可探测'),
    'manual-disabled': tr('手动禁用'),
    'policy-disabled': tr('策略禁用'),
    'probe-disabled': tr('探测禁用'),
    'pending-verification': tr('待首次验证'),
    available: tr('可路由'),
    unavailable: tr('不可用'),
    unknown: tr('状态未知'),
  };
  return <span className={`probe-plan-state is-${state}`}>{labels[state]}</span>;
}

function ProbeStatus({ status }: { status: string | null }) {
  const label = status === 'success' ? tr('成功')
    : status === 'failed' ? tr('失败')
      : status === 'timeout' ? tr('超时')
        : status === 'skipped' ? tr('跳过') : tr('未探测');
  return <span className={`probe-plan-probe-status${status ? ` is-${status}` : ''}`}>{label}</span>;
}

function formatDate(value: string): string {
  const date = new Date(value.includes('T') ? value : `${value.replace(' ', 'T')}Z`);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

function formatLatency(value: number | null | undefined): string {
  return value == null ? '—' : `${value.toLocaleString()} ms`;
}

function formatCost(value: number | null | undefined): string {
  return value == null ? tr('未知') : `$${value.toFixed(6)}`;
}

function formatInterval(hours: number): string {
  if (hours < 24) return `${hours} ${tr('小时')}`;
  return `${hours / 24} ${tr('天')}`;
}
