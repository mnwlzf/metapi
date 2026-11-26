import { Fragment, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../api.js';
import { useToast } from '../components/Toast.js';
import { MobileCard, MobileField } from '../components/MobileCard.js';
import { useIsMobile } from '../components/useIsMobile.js';
import ListPage from '../components/ListPage.js';
import { tr } from '../i18n.js';

type ProbeModelType = 'text' | 'image' | 'embedding' | 'rerank' | 'audio' | 'video' | 'other';
type ProbePlanModel = {
  modelName: string;
  type: ProbeModelType;
  recentCalls: number;
  intervalHours: number;
  automaticIntervalHours: number;
  overridden: boolean;
  keyResults: Array<{
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
    routeState: 'manual-disabled' | 'policy-disabled' | 'probe-disabled' | 'available' | 'unavailable' | 'unknown';
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
  }>;
};

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
  const [overrideFilter, setOverrideFilter] = useState<'all' | 'automatic' | 'custom'>('all');
  const [savingModel, setSavingModel] = useState('');
  const [expandedModel, setExpandedModel] = useState<string | null>(null);
  const planQuery = useQuery({
    queryKey: ['model-probe-plan'],
    queryFn: () => api.getModelProbePlan(),
    staleTime: 30_000,
  });
  const models = planQuery.data?.models ?? [];
  const typeCounts = useMemo(() => models.reduce((counts, model) => {
    counts[model.type] = (counts[model.type] || 0) + 1;
    return counts;
  }, {} as Partial<Record<ProbeModelType, number>>), [models]);
  const customCount = models.filter((model) => model.overridden).length;
  const filteredModels = useMemo(() => {
    const query = search.trim().toLowerCase();
    return models.filter((model) => {
      if (query && !model.modelName.toLowerCase().includes(query)) return false;
      if (typeFilter !== 'all' && model.type !== typeFilter) return false;
      if (overrideFilter === 'automatic' && model.overridden) return false;
      if (overrideFilter === 'custom' && !model.overridden) return false;
      return true;
    });
  }, [models, overrideFilter, search, typeFilter]);

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

  function renderIntervalControl(model: ProbePlanModel) {
    return (
      <select
        className="probe-plan-frequency"
        value={model.overridden ? String(model.intervalHours) : 'auto'}
        disabled={savingModel === model.modelName}
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
          <div className="probe-plan-summary" aria-label={tr('模型探测概览')}>
            <SummaryMetric label={tr('模型总数')} value={models.length} />
            <SummaryMetric label={tr('自动调度')} value={models.length - customCount} />
            <SummaryMetric label={tr('手动覆盖')} value={customCount} accent={customCount > 0} />
            <SummaryMetric label={tr('图片模型')} value={typeCounts.image || 0} />
            <SummaryMetric label={tr('向量与重排')} value={(typeCounts.embedding || 0) + (typeCounts.rerank || 0)} />
          </div>

          <div className="probe-plan-policy">
            <span className="probe-plan-policy-mark" aria-hidden="true">i</span>
            <span>{tr('自动频率根据近 7 天请求量调整；图片、视频及其他非文本模型默认每 72 小时探测。选择具体间隔可覆盖自动建议，选择自动可恢复。')}</span>
          </div>

          <div className="probe-plan-controls">
            <div className="probe-plan-type-tabs" role="group" aria-label={tr('按模型类型筛选')}>
              <FilterTab active={typeFilter === 'all'} onClick={() => setTypeFilter('all')} label={tr('全部')} count={models.length} />
              {TYPE_ORDER.filter((type) => (typeCounts[type] || 0) > 0).map((type) => (
                <FilterTab key={type} active={typeFilter === type} onClick={() => setTypeFilter(type)} label={TYPE_LABELS[type]} count={typeCounts[type] || 0} />
              ))}
            </div>
            <div className="probe-plan-filter-row">
              <label className="probe-plan-search">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><circle cx="10.8" cy="10.8" r="6.3" /><path strokeLinecap="round" d="m16 16 4.2 4.2" /></svg>
                <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder={tr('搜索模型名称')} aria-label={tr('搜索模型名称')} />
              </label>
              <label className="probe-plan-override-filter">
                <span>{tr('频率设置')}</span>
                <select value={overrideFilter} onChange={(event) => setOverrideFilter(event.target.value as typeof overrideFilter)} aria-label={tr('按频率设置筛选')}>
                  <option value="all">{tr('全部模型')}</option>
                  <option value="automatic">{tr('自动调度')}</option>
                  <option value="custom">{tr('手动覆盖')}</option>
                </select>
              </label>
              <div className="probe-plan-result-count">{tr('显示')} <strong>{filteredModels.length}</strong> / {models.length}</div>
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
              footerActions={<div className="probe-plan-mobile-frequency"><span>{tr('探测频率')}</span>{renderIntervalControl(model)}</div>}
            >
              <MobileField label={tr('近 7 天请求')} value={model.recentCalls.toLocaleString()} />
              <MobileField label={tr('自动建议')} value={formatInterval(model.automaticIntervalHours)} />
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
                <th>{tr('自动建议')}</th>
                <th>{tr('当前探测频率')}</th>
                <th>{tr('模式')}</th>
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
                    </button>
                  </td>
                  <td><TypeBadge type={model.type} /></td>
                  <td className="is-numeric probe-plan-calls">{model.recentCalls.toLocaleString()}</td>
                  <td className="probe-plan-auto-value">{formatInterval(model.automaticIntervalHours)}</td>
                  <td>{renderIntervalControl(model)}</td>
                  <td><span className={`probe-plan-mode${model.overridden ? ' is-custom' : ''}`}>{model.overridden ? tr('手动') : tr('自动')}</span></td>
                  </tr>
                  {expandedModel === model.modelName && <tr className="probe-plan-detail-row"><td colSpan={6}><KeyDetails model={model} /></td></tr>}
                </Fragment>
              ))}
              {filteredModels.length === 0 && <tr><td colSpan={6} className="probe-plan-no-results">{tr('没有匹配的模型')}</td></tr>}
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

function KeyDetails({ model }: { model: ProbePlanModel }) {
  const keys = model.keyResults;
  const availableCount = keys.filter((key) => key.routeState === 'available').length;
  const unavailableCount = keys.filter((key) => key.routeState === 'unavailable' || key.routeState === 'probe-disabled').length;
  const manualDisabledCount = keys.filter((key) => key.routeState === 'manual-disabled').length;
  const policyDisabledCount = keys.filter((key) => key.routeState === 'policy-disabled').length;
  const unprobedCount = keys.filter((key) => !key.lastProbe).length;
  return (
    <div className="probe-plan-key-details">
      <div className="probe-plan-key-detail-heading">
        <strong>{tr('各 Key 探测详情')}</strong>
        <div className="probe-plan-key-summary">
          <span className="is-good">{availableCount} {tr('可路由')}</span>
          <span className="is-bad">{unavailableCount} {tr('不可用')}</span>
          <span>{manualDisabledCount} {tr('手动禁用')}</span>
          {policyDisabledCount > 0 && <span>{policyDisabledCount} {tr('策略禁用')}</span>}
          <span>{unprobedCount} {tr('未探测')}</span>
        </div>
      </div>
      {keys.length === 0 ? (
        <div className="probe-plan-key-empty">{tr('没有可用的上游 Key 模型记录')}</div>
      ) : (
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
      )}
    </div>
  );
}

function StateBadge({ state }: { state: ProbePlanModel['keyResults'][number]['routeState'] }) {
  const labels = {
    'manual-disabled': tr('手动禁用'),
    'policy-disabled': tr('策略禁用'),
    'probe-disabled': tr('探测禁用'),
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
