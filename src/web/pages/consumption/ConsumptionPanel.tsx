import { useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api } from '../../api.js';
import { useToast } from '../../components/Toast.js';
import { buildAccountFocusPath } from '../helpers/navigationFocus.js';
import { analyzeConsumption, when, type ConsumptionRow } from './consumptionModel.js';
import { useConsumption } from './useConsumption.js';
import ConsumptionFilters from './ConsumptionFilters.js';
import ConsumptionSummary from './ConsumptionSummary.js';
import ConsumptionBreakdown, { consumptionDimensions, type ConsumptionDimension } from './ConsumptionBreakdown.js';
import KeyUsagePanel from './KeyUsagePanel.js';
import CollectionStatusPanel from './CollectionStatusPanel.js';
import './consumption.css';
import './workspace.css';

function validDay(day: string) {
  const timestamp = Date.parse(day);
  return /^\d{4}-\d{2}-\d{2}$/.test(day) && Number.isFinite(timestamp) && new Date(timestamp).toISOString().slice(0, 10) === day;
}

export default function ConsumptionPanel() {
  const { data, error, reload } = useConsumption();
  const [params, setParams] = useSearchParams();
  const [busy, setBusy] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const toast = useToast();
  const today = data?.today || new Intl.DateTimeFormat('en-CA').format(new Date());
  const view = params.get('view') || 'sites';
  const section = view === 'keys' ? 'keys' : view === 'sync' ? 'sync' : 'overview';
  const dimension = (consumptionDimensions.some(([key]) => key === view) ? view : 'sites') as ConsumptionDimension;
  const start = params.get('start') || today;
  const end = params.get('end') || today;
  const siteId = params.get('siteId') || '';
  const accountId = params.get('accountId') || '';
  const platform = section === 'overview' ? params.get('platform') || '' : '';
  const model = section === 'overview' ? params.get('model') || '' : '';
  const days = (Date.parse(end) - Date.parse(start)) / 86400_000 + 1;
  const invalidRange = section === 'overview' && (!validDay(start) || !validDay(end) || !Number.isInteger(days) || days < 1 || days > 31 || end > today || start < new Date(Date.parse(`${today}T12:00:00Z`) - 30 * 86400_000).toISOString().slice(0, 10));
  const analysis = useMemo(() => data && !invalidRange ? analyzeConsumption(data, { start: section === 'overview' ? start : today, end: section === 'overview' ? end : today, siteId, accountId, platform, model }) : null, [data, invalidRange, section, start, end, today, siteId, accountId, platform, model]);
  const change = (values: Record<string, string>) => {
    const next = new URLSearchParams(params);
    for (const [key, value] of Object.entries(values)) { if (value) next.set(key, value); else next.delete(key); }
    if (dimension === 'platforms' && !values.view && (values.start || values.end)) next.set('view', 'sites');
    setParams(next);
  };
  const sync = async (history = false) => {
    setBusy(true);
    try {
      const result = await api.syncConsumption({ ...(siteId ? { siteId: Number(siteId) } : {}), ...(history ? { start, end } : {}) });
      toast.success(result.queued ? `已为 ${result.queued} 个账号安排${history ? '历史补齐' : '采集'}，将按间隔与预算执行` : '没有可采集账号，请检查采集状态或凭证');
      await reload();
    } catch (error) { toast.error(error instanceof Error ? error.message : '安排失败'); }
    finally { setBusy(false); }
  };
  const selectDimension = (next: ConsumptionDimension) => change({ view: next, ...(next === 'models' ? { platform: '' } : {}), ...(next === 'platforms' ? { start: today, end: today, model: '' } : {}) });
  const drill = (row: ConsumptionRow) => {
    if (row.accountId) change({ siteId: String(row.siteId), accountId: String(row.accountId), platform: '', view: 'models' });
    else if (row.siteId) change({ siteId: String(row.siteId), accountId: '', view: 'accounts' });
    else if (row.platform) change({ platform: row.platform, model: '', view: 'sites', start: today, end: today });
    else if (row.model) change({ model: row.model, platform: '', view: 'sites' });
  };
  const scopedAccounts = data?.accounts.filter((account) => (!siteId || String(account.siteId) === siteId) && (!accountId || String(account.accountId) === accountId)) || [];
  const accounts = scopedAccounts.filter((account) => !account.duplicateOf);
  const records = data?.records.filter((record) => accounts.some((account) => account.accountId === record.accountId) && record.day >= start && record.day <= end && record.kind === (model || start !== today || end !== today ? 'models' : 'stats')) || [];
  const oldest = records.map((record) => record.fetchedAt).sort()[0];
  const stale = records.some((record) => {
    const account = accounts.find((account) => account.accountId === record.accountId)!;
    return record.day === today && Date.now() - Date.parse(record.fetchedAt) > (record.kind === 'models' ? account.policy.modelsMinutes : account.policy.statsMinutes) * (1 + account.policy.jitterPercent / 100) * 60_000 + 60_000;
  });
  const settingsUrl = `/settings?tab=consumption${siteId ? `&siteId=${siteId}` : ''}`;
  const rows = analysis ? dimension === 'models' ? analysis.models : dimension === 'platforms' ? analysis.platforms : dimension === 'accounts' ? analysis.accountRows : analysis.sites : [];
  const chips: Array<{ key: string; label: string; clear: Record<string, string> }> = [
    { key: 'siteId', label: data?.accounts.find((a) => String(a.siteId) === siteId)?.siteName || (siteId ? `站点 #${siteId}` : ''), clear: { siteId: '', accountId: '' } },
    { key: 'accountId', label: data?.accounts.find((a) => String(a.accountId) === accountId)?.accountName || (accountId ? `账号 #${accountId}` : ''), clear: { accountId: '' } },
    { key: 'model', label: model, clear: { model: '' } }, { key: 'platform', label: platform, clear: { platform: '' } },
  ];
  const activeChips = chips.filter((chip) => chip.label);
  return <>
    <header className="consumption-page-header"><div><div className="consumption-eyebrow">CONSUMPTION</div><h2>消费分析</h2><p>上游实际费用，多维度查看与下钻 <span>USD · {data?.timeZone || '加载中'}</span></p></div><div className="consumption-actions"><button type="button" className="btn btn-ghost" disabled={refreshing} onClick={async () => { setRefreshing(true); try { await reload(); } finally { setRefreshing(false); } }}>{refreshing ? '读取中…' : '刷新数据'}</button><Link className="btn btn-ghost" to={settingsUrl}>采集设置</Link><button type="button" className="btn btn-primary" disabled={busy || !data} onClick={() => void sync()}>{busy ? '安排中…' : '安排同步'}</button></div></header>
    <nav className="consumption-workspace-nav" aria-label="消费分析工作区">{([['overview', '消费总览', 'sites'], ['keys', 'Key 费用', 'keys'], ['sync', '采集状态', 'sync']] as const).map(([key, label, target]) => <button type="button" key={key} aria-current={section === key ? 'page' : undefined} onClick={() => change({ view: target })}>{label}</button>)}</nav>
    {error && <div role="alert" className="consumption-notice">{error}{data ? '，当前保留上次成功数据。' : ''}<button type="button" className="btn btn-ghost" onClick={() => void reload()}>重新读取</button></div>}
    {!data ? <div className="card consumption-empty">{error ? '暂时无法读取消费数据。' : '正在读取已保存的消费数据…'}</div> : <>
      <ConsumptionFilters accounts={data.accounts} today={today} start={start} end={end} siteId={siteId} accountId={accountId} showDates={section === 'overview'} change={change} />
      {activeChips.length > 0 && <div className="consumption-filter-chips"><span>当前筛选</span>{activeChips.map((chip) => <button type="button" key={chip.key} aria-label={`移除${chip.label}筛选`} onClick={() => change(chip.clear)}>{chip.label} <span aria-hidden="true">×</span></button>)}<button type="button" onClick={() => change({ siteId: '', accountId: '', model: '', platform: '' })}>清除筛选</button></div>}
      {invalidRange ? <div role="alert" className="consumption-notice">日期范围无效，请选择最近 31 天内的日期。<button type="button" className="btn btn-ghost" onClick={() => change({ start: '', end: '' })}>回到今天</button></div> : section === 'overview' && analysis && <>
        <div className="consumption-coverage-line"><span className={`consumption-status-badge is-${analysis.covered < analysis.expected || stale ? 'warning' : 'success'}`}>{analysis.covered < analysis.expected ? '数据未齐' : stale ? '等待更新' : analysis.expected ? '数据已齐' : '暂无账号'}</span><span>{analysis.todayOnly && !model ? '按账号总览汇总' : '按每日模型汇总'} · 最早更新时间 {when(oldest)}</span><Link to={`/consumption?${new URLSearchParams({ view: 'sync', ...(siteId ? { siteId } : {}), ...(accountId ? { accountId } : {}) })}`}>查看同步情况 →</Link></div>
        {platform && (!analysis.todayOnly || model) ? <div className="consumption-notice">厂商只支持今日账号汇总。<button type="button" className="btn btn-ghost" onClick={() => change({ platform: '' })}>移除厂商筛选</button></div> : <>
          <ConsumptionSummary totals={analysis.totals} covered={analysis.covered} expected={analysis.expected} days={analysis.days} accounts={analysis.accounts.length} onDay={(day) => change({ start: day, end: day })} />
          {dimension === 'platforms' && (!analysis.todayOnly || model) ? <div className="consumption-notice">厂商明细仅支持今日，且不能与模型条件组合。<button type="button" className="btn btn-ghost" onClick={() => selectDimension('platforms')}>查看今日厂商</button><button type="button" className="btn btn-ghost" onClick={() => selectDimension('sites')}>改按站点查看</button></div> : <ConsumptionBreakdown dimension={dimension} rows={rows} resetKey={`${start}:${end}:${siteId}:${accountId}:${model}:${platform}`} onDimension={selectDimension} onDrill={drill} notice={dimension === 'models' ? '模型汇总独立于账号总览采集，今日本表合计可能存在更新时间差。' : dimension === 'platforms' ? '厂商维度仅支持今日，按上游明确返回的厂商统计，不推测模型归属。' : undefined} />}
        </>}
        <div className="consumption-bottom-actions"><span>未同步不按零计算，不用估算费用补齐。历史费用来自每日模型汇总。</span><button type="button" className="btn btn-ghost" disabled={busy || !!platform} onClick={() => void sync(true)}>补齐所选日期</button></div>
      </>}
      {section === 'keys' && <KeyUsagePanel data={data} accounts={accounts} />}
      {section === 'sync' && <CollectionStatusPanel accounts={scopedAccounts} />}
      <footer className="consumption-page-footer"><span>数据读取与上游采集分开执行。同步按站点排队，账号筛选只影响展示。</span><div className="consumption-actions">{accountId && accounts[0] && <Link to={buildAccountFocusPath(Number(accountId), { siteId: accounts[0].siteId })}>账号管理 ↗</Link>}<Link to={siteId ? `/sites/${siteId}` : '/sites'}>站点管理 ↗</Link>{siteId && <Link to={`/sites/${siteId}?segment=tokens`}>令牌管理 ↗</Link>}</div></footer>
    </>}
  </>;
}
