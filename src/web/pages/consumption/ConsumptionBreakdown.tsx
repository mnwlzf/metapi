import { useState } from 'react';
import PaginationControls from '../../components/PaginationControls.js';
import { useClientPagination } from '../../components/useClientPagination.js';
import { useIsMobile } from '../../components/useIsMobile.js';
import { MobileCard, MobileField } from '../../components/MobileCard.js';
import { count, money, percent, type ConsumptionRow } from './consumptionModel.js';

export type ConsumptionDimension = 'sites' | 'accounts' | 'models' | 'platforms';
export const consumptionDimensions: Array<[ConsumptionDimension, string]> = [['sites', '站点'], ['accounts', '账号'], ['models', '模型'], ['platforms', '厂商']];

type Props = { dimension: ConsumptionDimension; rows: ConsumptionRow[]; resetKey: string; onDimension: (dimension: ConsumptionDimension) => void; onDrill: (row: ConsumptionRow) => void; notice?: string };

export default function ConsumptionBreakdown({ dimension, rows, resetKey, onDimension, onDrill, notice }: Props) {
  const [search, setSearch] = useState('');
  const [sort, setSort] = useState('cost');
  const mobile = useIsMobile();
  const visible = rows.filter((row) => row.label.toLowerCase().includes(search.trim().toLowerCase())).sort((a, b) => sort === 'name' ? a.label.localeCompare(b.label) : (sort === 'requests' ? (b.metrics.requests ?? -1) - (a.metrics.requests ?? -1) : (b.metrics.actualCost ?? -1) - (a.metrics.actualCost ?? -1)));
  const pagination = useClientPagination(visible, `${resetKey}:${dimension}:${search}:${sort}`, mobile ? 5 : 10);
  const total = rows.reduce((sum, row) => sum + (row.metrics.actualCost ?? 0), 0);
  return <section className="card consumption-section" aria-label="消费明细">
    <div className="consumption-section-header"><div><h3>费用明细</h3><p>选择维度查看构成，点击名称继续下钻</p></div><div className="consumption-dimensions" role="group" aria-label="消费分析维度">{consumptionDimensions.map(([key, label]) => <button type="button" key={key} aria-pressed={dimension === key} onClick={() => { setSearch(''); onDimension(key); }}>{label}</button>)}</div></div>
    <div className="consumption-table-toolbar"><input aria-label="搜索费用明细" placeholder="搜索名称…" value={search} onChange={(event) => setSearch(event.target.value)} /><div><span>{visible.length} 项 · 本表合计 {money(rows.some((row) => row.metrics.actualCost !== null) ? total : null)}</span><select aria-label="费用明细排序" value={sort} onChange={(event) => setSort(event.target.value)}><option value="cost">消费从高到低</option><option value="requests">请求从多到少</option><option value="name">名称排序</option></select></div></div>
    {notice && <div className="consumption-inline-note">{notice}</div>}
    {visible.length === 0 ? <div className="consumption-empty">{search ? '没有匹配的记录，请调整搜索条件。' : '所选范围尚无明细，等待采集完成后即可查看。'}</div> : mobile ? pagination.pagedItems.map((row) => <MobileCard key={row.key} title={<button className="consumption-link" onClick={() => onDrill(row)}>{row.label} →</button>}><MobileField label="实际消费" value={money(row.metrics.actualCost)} /><MobileField label="请求数" value={count(row.metrics.requests)} /><MobileField label="总 Token" value={count(row.metrics.totalTokens)} /><MobileField label="本表占比" value={percent(row.metrics.actualCost, total)} /></MobileCard>) : <div className="consumption-table-wrap"><table className="data-table"><thead><tr><th>名称</th><th>实际消费 / USD</th><th>请求数</th><th>输入 / 输出 Token</th><th>总 Token</th><th>本表占比</th></tr></thead><tbody>{pagination.pagedItems.map((row) => <tr key={row.key}><td><button className="consumption-link" onClick={() => onDrill(row)}>{row.label}<span aria-hidden="true"> ↗</span></button></td><td className="consumption-amount">{money(row.metrics.actualCost)}</td><td>{count(row.metrics.requests)}</td><td>{count(row.metrics.inputTokens)} / {count(row.metrics.outputTokens)}</td><td>{count(row.metrics.totalTokens)}</td><td><div className="consumption-share"><span style={{ width: `${total ? Math.min(100, (row.metrics.actualCost ?? 0) / total * 100) : 0}%` }} /></div>{percent(row.metrics.actualCost, total)}</td></tr>)}</tbody></table></div>}
    <PaginationControls page={pagination.page} totalPages={pagination.totalPages} onPageChange={pagination.setPage} totalItems={visible.length} pageSize={pagination.pageSize} visible={pagination.showControls} />
  </section>;
}
