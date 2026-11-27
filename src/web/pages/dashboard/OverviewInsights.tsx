import { useState } from 'react';
import { Link } from 'react-router-dom';
import { formatCompactTokenMetric } from '../../numberFormat.js';
import { money } from '../consumption/consumptionModel.js';

type TrendDay = { day: string; spend: number | null; calls: number | null };
type OverviewInsightsProps = {
  trend: TrendDay[];
  coverage?: { covered: number; expected: number };
  requests?: { total: number; success: number; failed: number; totalTokens: number };
};

export default function OverviewInsights({ trend, coverage, requests }: OverviewInsightsProps) {
  const [metric, setMetric] = useState<'spend' | 'calls'>('spend');
  const days = Array.from({ length: 7 }, (_, index) => {
    const date = new Date();
    date.setHours(12, 0, 0, 0);
    date.setDate(date.getDate() - 6 + index);
    const day = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
    const row = trend.find((item) => item.day === day);
    const raw = row?.[metric];
    return { day, value: typeof raw === 'number' && Number.isFinite(raw) && raw >= 0 ? raw : null };
  });
  const maximum = Math.max(1, ...days.map((row) => row.value ?? 0));
  const format = (value: number) => metric === 'spend' ? money(value) : value.toLocaleString('zh-CN');
  const synchronized = days.filter((row) => row.value !== null).length;
  const covered = coverage?.covered ?? 0;
  const expected = coverage?.expected ?? 0;
  const ratio = expected > 0 ? Math.min(100, covered / expected * 100) : 0;
  return <div className="dashboard-insights-grid">
    <section className="card dashboard-overview-card" aria-label="近七天上游趋势">
      <div className="dashboard-overview-card-heading">
        <div><h3>近 7 天上游趋势</h3><p>上游实际汇总 · 已同步 {synchronized} / 7 天</p></div>
        <div className="dashboard-trend-toggle" role="group" aria-label="趋势指标">
          <button type="button" aria-pressed={metric === 'spend'} onClick={() => setMetric('spend')}>实际消费</button>
          <button type="button" aria-pressed={metric === 'calls'} onClick={() => setMetric('calls')}>调用量</button>
        </div>
      </div>
      <div className="dashboard-week-bars">
        {days.map(({ day, value }) => <Link key={day} className="dashboard-day-bar" to={`/consumption?start=${day}&end=${day}`} aria-label={`${day} ${metric === 'spend' ? '实际消费' : '调用量'} ${value === null ? '待同步' : format(value)}`}>
          <span className="dashboard-day-value">{value === null ? '—' : format(value)}</span>
          <span className={`dashboard-day-track${value === null ? ' is-missing' : ''}`}>
            {value !== null && <span className="dashboard-day-fill" style={{ height: value === 0 ? 2 : `${Math.max(3, value / maximum * 100)}%` }} />}
          </span>
          <span className="dashboard-day-label">{day.slice(5)}</span>
        </Link>)}
      </div>
      <div className="dashboard-overview-card-note">点击日期查看明细 · 未同步日期保留空缺，不按零计算</div>
    </section>
    <section className="card dashboard-overview-card" aria-label="请求与同步概况">
      <div className="dashboard-overview-card-heading"><div><h3>最近 24 小时请求</h3><p>通过本系统转发的请求</p></div><Link to="/logs">使用日志 →</Link></div>
      <div className="dashboard-request-metrics">
        {([
          ['请求总数', requests?.total, ''], ['成功', requests?.success, 'is-success'], ['失败', requests?.failed, 'is-danger'],
        ] as const).map(([label, value, color]) => <div key={label}><span>{label}</span><strong className={color}>{value == null ? '—' : value.toLocaleString('zh-CN')}</strong></div>)}
      </div>
      <div className="dashboard-sync-summary">
        <div><span>总 Token</span><strong>{requests?.totalTokens == null ? '—' : formatCompactTokenMetric(requests.totalTokens)}</strong></div>
        <div><span>今日费用同步</span><Link to="/settings?tab=consumption">{expected ? `${covered} / ${expected} 个账号` : '暂无可统计账号'} →</Link></div>
        <div className="dashboard-sync-track" role="progressbar" aria-label="今日费用同步覆盖率" aria-valuemin={0} aria-valuemax={100} aria-valuenow={ratio}><span style={{ width: `${ratio}%` }} /></div>
      </div>
    </section>
  </div>;
}
