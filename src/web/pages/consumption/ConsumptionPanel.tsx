import { useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { VChart } from '@visactor/react-vchart';
import { api } from '../../api.js';
import { useToast } from '../../components/Toast.js';
import ResponsiveFilterPanel from '../../components/ResponsiveFilterPanel.js';
import { MobileCard, MobileField } from '../../components/MobileCard.js';
import { useIsMobile } from '../../components/useIsMobile.js';
import { useThemeLabelColor } from '../../components/useThemeLabelColor.js';
import { buildAccountFocusPath, buildTokenFocusPath } from '../helpers/navigationFocus.js';
import type { UsageKey, UsageKeyCatalog, UsageMetrics, UsageStats } from '../../../server/shared/upstreamUsage.js';
import { analyzeConsumption, count, money, percent, when, type ConsumptionRow } from './consumptionModel.js';
import { useConsumption } from './useConsumption.js';
import './consumption.css';

type Tab = 'sites' | 'accounts' | 'platforms' | 'models' | 'keys' | 'sync';
const tabs: Array<[Tab, string]> = [['sites', '站点'], ['accounts', '账号'], ['platforms', '厂商'], ['models', '模型'], ['keys', 'Key'], ['sync', '同步状态']];

function MetricCard({ label, value, detail }: { label: string; value: string; detail: string }) {
  return <div className="consumption-metric"><span className="consumption-subtitle">{label}</span><strong>{value}</strong><small>{detail}</small></div>;
}

function TokenDetails({ metrics }: { metrics: UsageMetrics }) {
  return <div className="consumption-token-grid">{([
    ['输入 Token', metrics.inputTokens], ['输出 Token', metrics.outputTokens], ['缓存读取', metrics.cacheReadTokens], ['缓存写入', metrics.cacheCreationTokens],
  ] as const).map(([label, value]) => <div key={label}>{label}<strong>{count(value)}</strong></div>)}</div>;
}

export default function ConsumptionPanel({ compact = false }: { compact?: boolean }) {
  const { data, error, reload } = useConsumption();
  const [params, setParams] = useSearchParams();
  const [filterOpen, setFilterOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const mobile = useIsMobile(); const toast = useToast(); const labelColor = useThemeLabelColor();
  const today = data?.today || new Intl.DateTimeFormat('en-CA').format(new Date());
  const start = params.get('start') || today; const end = params.get('end') || today;
  const siteId = params.get('siteId') || ''; const platform = params.get('platform') || ''; const model = params.get('model') || '';
  const accountId = params.get('accountId') || '';
  const tab = (tabs.some(([key]) => key === params.get('view')) ? params.get('view') : 'sites') as Tab;
  const analysis = useMemo(() => data ? analyzeConsumption(data, { start, end, siteId, accountId, platform, model }) : null, [data, start, end, siteId, accountId, platform, model]);
  const set = (values: Record<string, string>) => {
    const next = new URLSearchParams(params);
    for (const [key, value] of Object.entries(values)) { if (value) next.set(key, value); else next.delete(key); }
    setParams(next);
  };
  const sync = async (history = false) => {
    setBusy(true);
    try {
      const result = await api.syncConsumption({ ...(siteId ? { siteId: Number(siteId) } : {}), ...(history ? { start, end } : {}) });
      toast.success(result.queued ? `已为 ${result.queued} 个账号安排${history ? '历史补齐' : '采集'}，按预算错峰执行` : '没有可采集账号，请检查暂停、支持状态或凭证');
      await reload();
    } catch (error) { toast.error(error instanceof Error ? error.message : '安排失败'); }
    finally { setBusy(false); }
  };
  if (!data || !analysis) return <section className="card consumption-panel"><h3>上游实际消费</h3><div className="consumption-empty">{error || '正在读取本地消费快照…'}{error && <button className="btn btn-ghost" onClick={() => void reload()}>重试</button>}</div></section>;
  const selected = analysis.accounts;
  const siteOptions = [...new Map(data.accounts.map((account) => [account.siteId, account.siteName])).entries()];
  const settingsUrl = `/settings?tab=consumption${siteId ? `&siteId=${siteId}` : ''}`;
  const amounts = analysis.totals;
  const incomplete = analysis.covered < analysis.expected;
  const balance = selected.reduce((sum, account) => sum + (account.balance ?? 0), 0);
  const todayRecords = data.records.filter((record) => selected.some((account) => account.accountId === record.accountId) && record.day === today && record.kind === 'stats');
  const oldest = todayRecords.map((record) => record.fetchedAt).sort()[0];
  const modelRecords = data.records.filter((record) => record.kind === 'models' && record.day >= start && record.day <= end && selected.some((account) => account.accountId === record.accountId));
  const oldestModel = modelRecords.map((record) => record.fetchedAt).sort()[0];
  const reconciliation = selected.flatMap((account) => {
    const statsRecord = todayRecords.find((record) => record.accountId === account.accountId);
    const stats = statsRecord?.data as UsageStats | undefined;
    const keysRecord = data.records.find((record) => record.accountId === account.accountId && record.day === today && record.kind === 'keys');
    const keys = keysRecord?.data as UsageKey[] | undefined;
    if (!stats || !keys || keys.some((key) => key.todayActualCost === null)) return [];
    const total = keys.reduce((sum, key) => sum + key.todayActualCost!, 0);
    return [{ account, total, actual: stats.today.actualCost, statsTime: statsRecord!.fetchedAt, keysTime: keysRecord!.fetchedAt }];
  });
  const requestedDays = Math.round((Date.parse(end) - Date.parse(start)) / 86400_000) + 1;
  const invalidRange = !Number.isFinite(requestedDays) || requestedDays < 1 || requestedDays > 31 || end > today;
  const stale = todayRecords.some((record) => {
    const account = selected.find((account) => account.accountId === record.accountId)!;
    return Date.now() - Date.parse(record.fetchedAt) > account.policy.statsMinutes * (1 + account.policy.jitterPercent / 100) * 60_000 + 60_000;
  });
  const filterControls = <div className="consumption-filters">
    <label>开始日期<input type="date" value={start} min={new Date(Date.parse(`${today}T12:00:00Z`) - 30 * 86400_000).toISOString().slice(0, 10)} max={end} onChange={(event) => set({ start: event.target.value, platform: '' })} /></label>
    <label>结束日期<input type="date" value={end} min={start} max={today} onChange={(event) => set({ end: event.target.value, platform: '' })} /></label>
    <label>站点<select value={siteId} onChange={(event) => set({ siteId: event.target.value, accountId: '' })}><option value="">全部站点</option>{siteOptions.map(([id, name]) => <option value={id} key={id}>{name}</option>)}</select></label>
    <label>账号<select value={accountId} onChange={(event) => set({ accountId: event.target.value })}><option value="">全部账号</option>{data.accounts.filter((account) => !account.duplicateOf && (!siteId || String(account.siteId) === siteId)).map((account) => <option value={account.accountId} key={account.accountId}>{account.siteName} · {account.accountName}</option>)}</select></label>
    <button className="btn btn-ghost" onClick={() => set({ start: '', end: '', siteId: '', accountId: '', platform: '', model: '' })}>回到今日总览</button>
  </div>;
  const drill = (row: ConsumptionRow) => {
    if (row.accountId) set({ siteId: String(row.siteId), accountId: String(row.accountId), platform: '', view: model ? 'keys' : 'models' });
    else if (row.siteId) set({ siteId: String(row.siteId), accountId: '', view: model ? 'accounts' : platform ? 'accounts' : 'models' });
    else if (row.platform) set({ platform: row.platform, model: '', view: 'sites', start: today, end: today });
    else if (row.model) set({ model: row.model, platform: '', view: 'sites' });
  };
  const rows = tab === 'models' ? analysis.models : tab === 'platforms' ? analysis.platforms : tab === 'accounts' ? analysis.accountRows : analysis.sites;
  const rowTotal = rows.reduce((sum, row) => sum + (row.metrics.actualCost ?? 0), 0);
  const chartValues = analysis.days.map((row) => ({ day: row.key, spend: row.coverage === selected.length ? row.metrics.actualCost : null }));
  const chartSpec = {
    type: 'line', height: 210, background: 'transparent', padding: { top: 15, right: 20, bottom: 8, left: 8 },
    data: { id: 'actual-consumption', values: chartValues }, xField: 'day', yField: 'spend',
    color: ['#5b7cfa'], line: { style: { lineWidth: 2, curveType: 'linear' } }, point: { visible: true },
    axes: [
      { orient: 'bottom', label: { style: { fill: labelColor, fontSize: 11 } }, grid: { visible: false } },
      { orient: 'left', min: 0, label: { style: { fill: labelColor, fontSize: 11 }, formatMethod: (value: number) => `$${Number(value).toFixed(2)}` }, grid: { style: { stroke: labelColor, strokeOpacity: 0.1 } } },
    ],
    tooltip: { mark: { title: { value: (datum: { day: string }) => datum.day }, content: [{ key: '上游实际消费', value: (datum: { spend: number }) => money(datum.spend) }] } },
  };
  return <section className="card consumption-panel">
    <div className="consumption-heading"><div><h3>上游实际消费{compact ? '' : '分析'}</h3><div className="consumption-subtitle">上游账号全部使用 · USD · {data.timeZone} · {start} ～ {end}<br />今日总览最早更新时间：{when(oldest)}</div></div><div className="consumption-actions">{compact && <Link className="btn btn-soft-primary" to={`/consumption?${params}`}>完整分析 ↗</Link>}<Link className="btn btn-ghost" to={settingsUrl}>采集设置</Link><button className="btn btn-ghost" disabled={busy} onClick={() => void sync()}>安排同步</button></div></div>
    {error && <div role="alert" className="consumption-notice">{error}，保留上次成功数据。</div>}
    {invalidRange && <div role="alert" className="consumption-notice">日期范围无效，请选择最近 31 天内的日期。</div>}
    <ResponsiveFilterPanel isMobile={mobile} mobileOpen={filterOpen} onMobileOpen={() => setFilterOpen(true)} onMobileClose={() => setFilterOpen(false)} mobileTitle="消费筛选" mobileContent={filterControls} desktopContent={filterControls} />
    {(siteId || accountId || platform || model) && <div className="consumption-actions" style={{ marginTop: 12 }}><span className="consumption-subtitle">筛选：</span>{[['siteId', siteOptions.find(([id]) => String(id) === siteId)?.[1]], ['accountId', data.accounts.find((account) => String(account.accountId) === accountId)?.accountName], ['platform', platform], ['model', model]].filter(([, value]) => value).map(([key, value]) => <button className="btn btn-ghost" key={key} onClick={() => set({ [key!]: '' })}>{value} ×</button>)}</div>}
    <div className="consumption-notice">覆盖 {analysis.covered}／{analysis.expected} 个账号日{incomplete ? '，当前合计不完整' : ''}{stale ? '；今日部分数据已过期，等待后台采集' : ''}。未同步不按零计算，实际费用不使用估算补齐。{!analysis.todayOnly && ' 历史区间按每日模型汇总，未取得的日期保留缺口。'}{model && ' 当前仅统计所选模型。'}{platform && ' 厂商筛选仅支持今日账号汇总，模型和 Key 不提供未经确认的交叉拆分。'}</div>
    <div className="consumption-metrics"><MetricCard label="所选范围实际消费" value={money(amounts.actualCost)} detail={incomplete ? '已获取部分合计' : '上游实际计费金额'} /><MetricCard label="请求数" value={count(amounts.requests)} detail="与实际消费对应的上游范围" /><MetricCard label="总 Token" value={count(amounts.totalTokens)} detail="含上游报告的缓存用量" /><MetricCard label="所选账号当前余额" value={selected.length ? money(balance) : '—'} detail="账号余额，不随模型或厂商筛选拆分" /></div>
    <TokenDetails metrics={amounts} />
    <div className="consumption-subtitle">平均每次请求：{money(amounts.requests && amounts.actualCost !== null ? amounts.actualCost / amounts.requests : null)}　每百万总 Token：{money(amounts.totalTokens && amounts.actualCost !== null ? amounts.actualCost / amounts.totalTokens * 1e6 : null)}　缓存读取占比：{percent(amounts.cacheReadTokens, amounts.totalTokens)}<br />上游原始费用：{money(amounts.originalCost)}　实际／原始费用比例：{percent(amounts.actualCost, amounts.originalCost)}（不等同于 Key 倍率）</div>
    {!compact && <div style={{ marginTop: 24 }}><strong style={{ fontSize: 13 }}>每日实际消费 · 点击日期下钻</strong><div className="consumption-subtitle">账号未齐的日期保留缺口，不将部分金额画作完整日消费。</div>{chartValues.some((row) => row.spend !== null) ? <VChart spec={chartSpec as never} onClick={(event: { datum?: { day?: string } }) => { if (event.datum?.day) set({ start: event.datum.day, end: event.datum.day }); }} /> : <div className="consumption-empty">尚无完整日期数据，可安排历史补齐。</div>}</div>}
    <div className="consumption-tabs" role="tablist" aria-label="消费分析维度">{tabs.map(([key, label]) => <button role="tab" aria-selected={key === tab} key={key} onClick={() => set({ view: key })}>{label}</button>)}</div>
    {tab === 'models' && <div className="consumption-subtitle">模型汇总最早更新时间：{when(oldestModel)}。模型与总览独立采集，今日金额可能存在时间差。</div>}
    {(tab === 'sites' || tab === 'accounts' || tab === 'models' || tab === 'platforms') && <>
      {tab === 'platforms' && model ? <div className="consumption-empty">上游未提供模型与厂商的交叉关系，请移除模型筛选查看厂商。</div> : tab === 'platforms' && !analysis.todayOnly ? <div className="consumption-empty">当前接口仅提供今日及上游累计厂商汇总。请选择今日查看厂商分析。</div> : tab === 'models' && platform ? <div className="consumption-empty">上游未提供厂商与模型的交叉关系，请移除厂商筛选查看模型。</div> : rows.length ? mobile ? rows.map((row) => <MobileCard key={row.key} title={<button className="consumption-link" onClick={() => drill(row)}>{row.label} →</button>}><MobileField label="实际消费" value={money(row.metrics.actualCost)} /><MobileField label="请求数" value={count(row.metrics.requests)} /><MobileField label="总 Token" value={count(row.metrics.totalTokens)} /></MobileCard>) : <div className="consumption-table-wrap"><table className="data-table"><thead><tr><th>名称</th><th>实际消费</th><th>请求数</th><th>输入 / 输出</th><th>缓存读取 / 写入</th><th>总 Token</th><th>本表消费占比</th></tr></thead><tbody>{rows.map((row) => <tr key={row.key}><td><button className="consumption-link" onClick={() => drill(row)}>{row.label} →</button></td><td>{money(row.metrics.actualCost)}</td><td>{count(row.metrics.requests)}</td><td>{count(row.metrics.inputTokens)} / {count(row.metrics.outputTokens)}</td><td>{count(row.metrics.cacheReadTokens)} / {count(row.metrics.cacheCreationTokens)}</td><td>{count(row.metrics.totalTokens)}</td><td>{percent(row.metrics.actualCost, rowTotal)}</td></tr>)}</tbody></table></div> : <div className="consumption-empty">尚无该范围数据，请等待采集或安排补齐。</div>}
    </>}
    {tab === 'keys' && <><div className="consumption-notice">Key 固定展示今日与近 30 天费用，仅跟随站点筛选；不随上方日期、厂商、模型拆分。上游 Key ID 按账号区分，未匹配本地令牌时仍展示消费。</div><div className="consumption-table-wrap"><table className="data-table"><thead><tr><th>站点 / 账号</th><th>Key</th><th>分组</th><th>今日实际消费</th><th>近 30 天实际消费</th><th>更新时间</th></tr></thead><tbody>{selected.flatMap((account) => {
      const record = data.records.find((row) => row.accountId === account.accountId && row.kind === 'keys' && row.day === today);
      const catalog = data.records.filter((row) => row.accountId === account.accountId && row.kind === 'catalog').sort((a, b) => b.fetchedAt.localeCompare(a.fetchedAt))[0]?.data as UsageKeyCatalog[] | undefined;
      return ((record?.data as UsageKey[] | undefined) || []).map((key) => { const info = catalog?.find((item) => item.upstreamId === key.upstreamId); return <tr key={`${account.accountId}:${key.upstreamId}`}><td>{account.siteName}<div className="consumption-subtitle">{account.accountName}</div></td><td>{info?.localTokenId ? <Link to={buildTokenFocusPath(info.localTokenId, account.siteId)}>{info.name} ↗</Link> : info?.name || `上游 Key #${key.upstreamId}`}<div className="consumption-subtitle">ID {key.upstreamId}</div></td><td>{info?.group || '—'}</td><td>{money(key.todayActualCost)}</td><td>{money(key.recentActualCost)}</td><td>{when(record?.fetchedAt)}</td></tr>; });
    })}</tbody></table></div>{!data.records.some((record) => record.kind === 'keys' && record.day === today && selected.some((account) => account.accountId === record.accountId) && (record.data as UsageKey[]).length > 0) && <div className="consumption-empty">所选账号暂无今日 Key 费用记录。</div>}</>}
    {tab === 'sync' && <div>{selected.map((account) => <div className="consumption-mobile-row" key={account.accountId}><div className="consumption-heading"><strong>{account.siteName} · {account.accountName}</strong><Link to={`/settings?tab=consumption&siteId=${account.siteId}`}>采集设置 →</Link></div><div className="consumption-subtitle">{account.reason || account.state?.blocked || (!account.policy.enabled ? '已暂停' : '自动采集已启用')}{Object.entries(account.state?.tasks || {}).map(([kind, task]) => <div key={kind}>{{ stats: '总览', keys: 'Key', models: '模型', catalog: 'Key 目录' }[kind]}：成功 {when(task.lastSuccessAt)} · 下次 {when(task.nextAt)}{task.error ? ` · ${task.error}` : ''}</div>)}{account.state?.cooldownUntil && account.state.cooldownUntil > Date.now() ? <div>冷却至：{when(account.state.cooldownUntil)}</div> : null}</div></div>)}</div>}
    {tab === 'keys' && reconciliation.length > 0 && <details style={{ marginTop: 18 }}><summary style={{ cursor: 'pointer', fontSize: 13 }}>今日金额核对 · 账号总览与 Key 合计</summary>{reconciliation.map((row) => <div className="consumption-notice" key={row.account.accountId}>{row.account.siteName} · {row.account.accountName}：账号 {money(row.actual)}，Key 合计 {money(row.total)}，差额 {money(row.actual == null ? null : Math.abs(row.actual - row.total))}。<br />总览更新：{when(row.statsTime)}；Key 更新：{when(row.keysTime)}。差异可能来自采集时间、已删除 Key 或上游统计范围，不自动修正金额。</div>)}</details>}
    <div className="consumption-footer"><div className="consumption-actions"><Link to="/">仪表盘</Link>{accountId && selected[0] && <Link to={buildAccountFocusPath(Number(accountId), { siteId: selected[0].siteId })}>账号管理 ↗</Link>}<Link to={siteId ? `/sites/${siteId}` : '/sites'}>站点管理 ↗</Link>{siteId && <Link to={`/sites/${siteId}?segment=tokens`}>令牌管理 ↗</Link>}</div><button className="btn btn-ghost" disabled={busy || !!platform || invalidRange} onClick={() => void sync(true)}>补齐所选日期的模型汇总</button></div>
  </section>;
}
