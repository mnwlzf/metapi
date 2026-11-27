import { useState } from 'react';
import { Link } from 'react-router-dom';
import type { UsageAccountView, UsageTaskKind } from '../../../server/shared/upstreamUsage.js';
import PaginationControls from '../../components/PaginationControls.js';
import { useClientPagination } from '../../components/useClientPagination.js';
import { useIsMobile } from '../../components/useIsMobile.js';
import { when } from './consumptionModel.js';

export function collectionStatus(account: UsageAccountView) {
  if (account.duplicateOf) return { label: '已去重', tone: 'muted', detail: `与账号 ${account.duplicateOf} 对应同一上游身份，不重复采集` };
  if (!account.supported || account.reason) return { label: '不支持', tone: 'muted', detail: account.reason || '上游未提供消费汇总' };
  if (!account.policy.enabled) return { label: '已暂停', tone: 'muted', detail: '自动采集已关闭，可在采集设置中启用' };
  const tasks = Object.values(account.state?.tasks || {});
  if (account.state?.blocked) return { label: '需处理', tone: 'danger', detail: account.state.blocked };
  if (tasks.some((task) => task.paused)) return { label: '部分暂停', tone: 'warning', detail: tasks.find((task) => task.paused)?.error || '有采集任务暂停，请检查后恢复' };
  if ((account.state?.cooldownUntil || 0) > Date.now()) return { label: '冷却中', tone: 'warning', detail: `冷却至 ${when(account.state?.cooldownUntil)}` };
  if (tasks.some((task) => task.error)) return { label: '等待重试', tone: 'warning', detail: tasks.find((task) => task.error)!.error! };
  if (!tasks.some((task) => task.lastSuccessAt)) return { label: '待首次同步', tone: 'muted', detail: '任务已排队，按间隔与预算执行' };
  return { label: '正常采集', tone: 'success', detail: '按配置间隔自动错峰采集' };
}

export default function CollectionStatusPanel({ accounts }: { accounts: UsageAccountView[] }) {
  const [search, setSearch] = useState('');
  const [onlyIssues, setOnlyIssues] = useState(false);
  const mobile = useIsMobile();
  const withStatus = accounts.map((account) => ({ account, status: collectionStatus(account) }));
  const issues = withStatus.filter(({ status }) => status.tone === 'danger' || status.tone === 'warning').length;
  const visible = withStatus.filter(({ account, status }) => `${account.siteName} ${account.accountName}`.toLowerCase().includes(search.toLowerCase().trim()) && (!onlyIssues || status.tone === 'danger' || status.tone === 'warning'));
  const pagination = useClientPagination(visible, `${accounts.map((a) => a.accountId)}:${search}:${onlyIssues}`, mobile ? 5 : 10);
  return <section className="card consumption-section" aria-label="采集任务状态">
    <div className="consumption-section-header"><div><h3>采集任务</h3><p>共 {accounts.length} 个账号 · {issues} 个账号需要关注</p></div><Link className="btn btn-ghost" to="/settings?tab=consumption">管理采集频率 →</Link></div>
    <div className="consumption-table-toolbar"><input aria-label="搜索采集账号" value={search} placeholder="搜索站点或账号…" onChange={(event) => setSearch(event.target.value)} /><label className="consumption-checkbox"><input type="checkbox" checked={onlyIssues} onChange={(event) => setOnlyIssues(event.target.checked)} />仅看需关注</label></div>
    {pagination.pagedItems.map(({ account, status }) => {
      const tasks = Object.values(account.state?.tasks || {});
      const last = tasks.map((task) => task.lastSuccessAt).filter(Boolean).sort().at(-1);
      const next = tasks.filter((task) => !task.paused).map((task) => task.nextAt);
      return <details className="consumption-status-account" key={account.accountId}><summary><div><strong>{account.siteName}</strong><span>{account.accountName}</span></div><span className={`consumption-status-badge is-${status.tone}`}>{status.label}</span><span className="consumption-status-time">最近成功 {when(last)}</span></summary>
        <div className="consumption-status-body"><div className="consumption-inline-note">{status.detail}</div><div className="consumption-table-wrap"><table className="data-table"><thead><tr><th>任务</th><th>状态</th><th>最近成功</th><th>下次计划</th></tr></thead><tbody>{(['stats', 'keys', 'models', 'catalog'] as UsageTaskKind[]).map((kind) => {
          const task = account.state?.tasks[kind];
          const canRun = account.supported && account.policy.enabled && !account.reason && !account.state?.blocked && !account.duplicateOf && !task?.paused;
          const label = !canRun ? task?.paused ? '已暂停' : status.label : (account.state?.cooldownUntil || 0) > Date.now() ? '冷却中' : task?.error ? '等待重试' : task?.lastSuccessAt ? '正常' : '待同步';
          return <tr key={kind}><td>{{ stats: '费用总览', keys: 'Key 费用', models: '模型汇总', catalog: 'Key 目录' }[kind]}</td><td>{label}{task?.error && <small className="consumption-cell-meta">{task.error}</small>}</td><td>{when(task?.lastSuccessAt)}</td><td>{canRun ? when(task?.nextAt) : '—'}</td></tr>;
        })}</tbody></table></div><div className="consumption-status-footer"><span>下次任务：{next.length && account.supported && account.policy.enabled && !account.reason && !account.state?.blocked && !account.duplicateOf ? when(Math.min(...next)) : '暂无可执行计划'}</span><Link to={`/settings?tab=consumption&siteId=${account.siteId}`}>该站点采集设置 →</Link></div></div>
      </details>;
    })}
    {visible.length === 0 && <div className="consumption-empty">{onlyIssues ? '当前筛选范围没有需要关注的账号。' : '没有匹配的采集账号。'}</div>}
    <PaginationControls page={pagination.page} totalPages={pagination.totalPages} onPageChange={pagination.setPage} pageSize={pagination.pageSize} totalItems={visible.length} visible={pagination.showControls} />
  </section>;
}
