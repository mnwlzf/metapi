import type { UsageMetrics } from '../../../server/shared/upstreamUsage.js';
import { count, money, percent, type ConsumptionRow } from './consumptionModel.js';

export function ConsumptionMetric({ label, value, detail, primary = false }: { label: string; value: string; detail: string; primary?: boolean }) {
  return <div className={`card consumption-summary-metric${primary ? ' is-primary' : ''}`}><span>{label}</span><strong>{value}</strong><small>{detail}</small></div>;
}

type Props = { totals: UsageMetrics; covered: number; expected: number; days: ConsumptionRow[]; accounts: number; onDay: (day: string) => void };
export default function ConsumptionSummary({ totals, covered, expected, days, accounts, onDay }: Props) {
  const incomplete = covered < expected;
  const values = days.map((day) => ({ day: day.key, amount: accounts > 0 && day.coverage === accounts ? day.metrics.actualCost : null }));
  const maximum = Math.max(0.000001, ...values.map((row) => row.amount ?? 0));
  return <>
    <div className="consumption-summary-grid">
      <ConsumptionMetric primary label="实际消费 · USD" value={money(totals.actualCost)} detail={incomplete ? '当前为已获取部分合计' : '上游实际计费金额'} />
      <ConsumptionMetric label="请求数" value={count(totals.requests)} detail="所选范围的上游请求" />
      <ConsumptionMetric label="总 Token" value={count(totals.totalTokens)} detail="包含上游返回的缓存用量" />
      <ConsumptionMetric label="数据覆盖" value={`${covered} / ${expected}`} detail="已同步账号日 / 应同步账号日" />
    </div>
    <section className="card consumption-section" aria-label="每日消费趋势">
      <div className="consumption-section-header"><div><h3>每日实际消费</h3><p>点击日期查看当天明细 · 未齐的日期保留空缺</p></div><span className="consumption-source-badge">USD · 上游实际金额</span></div>
      <div className="consumption-daily-chart" style={{ gridTemplateColumns: `repeat(${Math.max(1, values.length)}, minmax(88px, 1fr))` }}>{values.map(({ day, amount }) => <button type="button" className="consumption-chart-day" key={day} title={`${day} ${amount === null ? '数据未齐' : money(amount)}`} aria-label={`${day} 实际消费 ${amount === null ? '数据未齐' : money(amount)}`} onClick={() => onDay(day)}><span>{amount === null ? '—' : money(amount)}</span><span className={`consumption-chart-track${amount === null ? ' is-missing' : ''}`}>{amount !== null && <span style={{ height: amount === 0 ? 2 : `${Math.max(3, amount / maximum * 100)}%` }} />}</span><small>{day.slice(5)}</small></button>)}</div>
      {values.length === 0 && <div className="consumption-empty">所选日期暂无可展示趋势。</div>}
    </section>
    <details className="card consumption-metric-details"><summary>Token 与单位成本明细<span>输入、输出、缓存、平均费用</span></summary><div className="consumption-details-grid">{([
      ['输入 Token', count(totals.inputTokens)], ['输出 Token', count(totals.outputTokens)], ['缓存读取', count(totals.cacheReadTokens)], ['缓存写入', count(totals.cacheCreationTokens)],
      ['平均每次请求', money(totals.requests && totals.actualCost !== null ? totals.actualCost / totals.requests : null)], ['每百万 Token', money(totals.totalTokens && totals.actualCost !== null ? totals.actualCost / totals.totalTokens * 1e6 : null)], ['缓存读取占比', percent(totals.cacheReadTokens, totals.totalTokens)], ['原始费用', money(totals.originalCost)],
    ] as const).map(([label, value]) => <div key={label}><span>{label}</span><strong>{value}</strong></div>)}</div></details>
  </>;
}
