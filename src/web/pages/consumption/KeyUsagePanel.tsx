import { useState } from 'react';
import { Link } from 'react-router-dom';
import PaginationControls from '../../components/PaginationControls.js';
import { useClientPagination } from '../../components/useClientPagination.js';
import { useIsMobile } from '../../components/useIsMobile.js';
import { MobileCard, MobileField } from '../../components/MobileCard.js';
import { buildTokenFocusPath } from '../helpers/navigationFocus.js';
import type { UsageAccountView, UsageOverview, UsageKey, UsageKeyCatalog, UsageStats } from '../../../server/shared/upstreamUsage.js';
import { money, when } from './consumptionModel.js';
import { ConsumptionMetric } from './ConsumptionSummary.js';

export default function KeyUsagePanel({ data, accounts }: { data: UsageOverview; accounts: UsageAccountView[] }) {
  const [search, setSearch] = useState('');
  const [sort, setSort] = useState('today');
  const mobile = useIsMobile();
  const rows = accounts.flatMap((account) => {
    const record = data.records.find((row) => row.accountId === account.accountId && row.day === data.today && row.kind === 'keys');
    const catalog = data.records.filter((row) => row.accountId === account.accountId && row.kind === 'catalog').sort((a, b) => b.fetchedAt.localeCompare(a.fetchedAt))[0]?.data as UsageKeyCatalog[] | undefined;
    return ((record?.data as UsageKey[] | undefined) || []).map((key) => ({ ...key, account, fetchedAt: record!.fetchedAt, info: catalog?.find((item) => item.upstreamId === key.upstreamId) }));
  });
  const visible = rows.filter((row) => `${row.account.siteName} ${row.account.accountName} ${row.info?.name || ''} ${row.upstreamId} ${row.info?.group || ''}`.toLowerCase().includes(search.toLowerCase().trim())).sort((a, b) => sort === 'today' ? (b.todayActualCost ?? -1) - (a.todayActualCost ?? -1) : (b.recentActualCost ?? -1) - (a.recentActualCost ?? -1));
  const pagination = useClientPagination(visible, `${accounts.map((a) => a.accountId)}:${search}:${sort}`, mobile ? 5 : 10);
  const sum = (field: 'todayActualCost' | 'recentActualCost') => rows.some((row) => row[field] !== null) ? rows.reduce((total, row) => total + (row[field] ?? 0), 0) : null;
  const synced = accounts.filter((account) => data.records.some((row) => row.accountId === account.accountId && row.day === data.today && row.kind === 'keys')).length;
  const title = (row: typeof rows[number]) => row.info?.localTokenId ? <Link to={buildTokenFocusPath(row.info.localTokenId, row.account.siteId)}>{row.info.name} ↗</Link> : row.info?.name || `上游 Key #${row.upstreamId}`;
  return <>
    <div className="consumption-inline-note">Key 费用固定展示今日与上游累计汇总，按站点和账号筛选。日期、模型及厂商条件不应用于此视图。</div>
    <div className="consumption-summary-grid"><ConsumptionMetric primary label="今日 Key 消费 · USD" value={money(sum('todayActualCost'))} detail="已采集 Key 的金额合计" /><ConsumptionMetric label="上游累计消费 · USD" value={money(sum('recentActualCost'))} detail="统计范围由上游接口定义" /><ConsumptionMetric label="已采集 Key" value={String(rows.length)} detail="同一 ID 按账号区分" /><ConsumptionMetric label="账号覆盖" value={`${synced} / ${accounts.length}`} detail="今日已同步 Key 费用的账号" /></div>
    <section className="card consumption-section"><div className="consumption-section-header"><div><h3>Key 费用明细</h3><p>点击已关联的 Key 可进入令牌管理</p></div></div><div className="consumption-table-toolbar"><input aria-label="搜索 Key" placeholder="搜索 Key、账号、分组或 ID…" value={search} onChange={(event) => setSearch(event.target.value)} /><select aria-label="Key 费用排序" value={sort} onChange={(event) => setSort(event.target.value)}><option value="today">今日消费从高到低</option><option value="recent">上游累计消费从高到低</option></select></div>
      {visible.length === 0 ? <div className="consumption-empty">{search ? '没有匹配的 Key。' : '所选账号暂无今日 Key 费用，等待同步后查看。'}</div> : mobile ? pagination.pagedItems.map((row) => <MobileCard key={`${row.account.accountId}:${row.upstreamId}`} title={title(row)} subtitle={`${row.account.siteName} · ${row.account.accountName}`}><MobileField label="今日消费" value={money(row.todayActualCost)} /><MobileField label="上游累计" value={money(row.recentActualCost)} /><MobileField label="分组" value={row.info?.group || '—'} /><MobileField label="更新时间" value={when(row.fetchedAt)} /></MobileCard>) : <div className="consumption-table-wrap"><table className="data-table"><thead><tr><th>Key / ID</th><th>站点 / 账号</th><th>分组</th><th>今日消费</th><th>上游累计消费</th><th>更新时间</th></tr></thead><tbody>{pagination.pagedItems.map((row) => <tr key={`${row.account.accountId}:${row.upstreamId}`}><td>{title(row)}<small className="consumption-cell-meta">ID {row.upstreamId}</small></td><td>{row.account.siteName}<small className="consumption-cell-meta">{row.account.accountName}</small></td><td>{row.info?.group || '—'}</td><td className="consumption-amount">{money(row.todayActualCost)}</td><td>{money(row.recentActualCost)}</td><td>{when(row.fetchedAt)}</td></tr>)}</tbody></table></div>}
      <PaginationControls page={pagination.page} totalPages={pagination.totalPages} onPageChange={pagination.setPage} pageSize={pagination.pageSize} totalItems={visible.length} visible={pagination.showControls} />
    </section>
    <details className="card consumption-metric-details"><summary>核对账号总览与 Key 合计<span>采集时间和范围差异</span></summary><div className="consumption-reconciliation">{accounts.map((account) => {
      const stats = data.records.find((row) => row.accountId === account.accountId && row.day === data.today && row.kind === 'stats');
      const keys = data.records.find((row) => row.accountId === account.accountId && row.day === data.today && row.kind === 'keys');
      const items = keys?.data as UsageKey[] | undefined;
      const total = items && items.every((key) => key.todayActualCost !== null) ? items.reduce((sum, key) => sum + key.todayActualCost!, 0) : null;
      const actual = (stats?.data as UsageStats | undefined)?.today.actualCost;
      return <div key={account.accountId}><strong>{account.siteName} · {account.accountName}</strong><p>账号 {money(actual)} · Key 合计 {money(total)} · 差额 {money(actual == null || total === null ? null : Math.abs(actual - total))}</p><small>总览：{when(stats?.fetchedAt)} · Key：{when(keys?.fetchedAt)}</small></div>;
    })}<p className="consumption-subtitle">金额差异可能来自采集时间、已删除 Key 或上游统计范围，不自动修正费用。</p></div></details>
  </>;
}
