import { useState } from 'react';
import ResponsiveFilterPanel from '../../components/ResponsiveFilterPanel.js';
import { useIsMobile } from '../../components/useIsMobile.js';
import type { UsageAccountView } from '../../../server/shared/upstreamUsage.js';

export function shiftConsumptionDay(day: string, offset: number): string {
  return new Date(Date.parse(`${day}T12:00:00Z`) + offset * 86400_000).toISOString().slice(0, 10);
}

type Props = {
  accounts: UsageAccountView[];
  today: string;
  start: string;
  end: string;
  siteId: string;
  accountId: string;
  showDates: boolean;
  change: (values: Record<string, string>) => void;
};

export default function ConsumptionFilters({ accounts, today, start, end, siteId, accountId, showDates, change }: Props) {
  const [open, setOpen] = useState(false);
  const mobile = useIsMobile();
  const sites = [...new Map(accounts.map((account) => [account.siteId, account.siteName])).entries()];
  const controls = <div className="consumption-scope-controls">
    <label>站点<select aria-label="筛选站点" value={siteId} onChange={(event) => change({ siteId: event.target.value, accountId: '' })}><option value="">全部站点</option>{sites.map(([id, name]) => <option key={id} value={id}>{name}</option>)}</select></label>
    <label>账号<select aria-label="筛选账号" value={accountId} onChange={(event) => {
      const account = accounts.find((row) => String(row.accountId) === event.target.value);
      change({ accountId: event.target.value, ...(account ? { siteId: String(account.siteId) } : {}) });
    }}><option value="">全部账号</option>{accounts.filter((account) => !account.duplicateOf && (!siteId || String(account.siteId) === siteId)).map((account) => <option key={account.accountId} value={account.accountId}>{account.accountName} · {account.siteName}</option>)}</select></label>
    {showDates && <><label>开始日期<input aria-label="开始日期" type="date" value={start} min={shiftConsumptionDay(today, -30)} max={end} onChange={(event) => change({ start: event.target.value, platform: '' })} /></label><span className="consumption-date-divider">至</span><label>结束日期<input aria-label="结束日期" type="date" value={end} min={start} max={today} onChange={(event) => change({ end: event.target.value, platform: '' })} /></label></>}
  </div>;
  return <div className="card consumption-scope">
    <div className="consumption-scope-top"><div><strong>统计范围</strong><span>{showDates ? `${start} ～ ${end}` : '按站点与账号查看，不受日期及模型筛选影响'}</span></div>
      {showDates && <div className="consumption-presets" role="group" aria-label="快捷日期">{([
        ['今天', today, today], ['昨天', shiftConsumptionDay(today, -1), shiftConsumptionDay(today, -1)], ['近 7 天', shiftConsumptionDay(today, -6), today], ['近 30 天', shiftConsumptionDay(today, -29), today],
      ] as const).map(([label, from, to]) => <button type="button" key={label} aria-pressed={start === from && end === to} onClick={() => change({ start: from, end: to, platform: '' })}>{label}</button>)}</div>}
    </div>
    <ResponsiveFilterPanel isMobile={mobile} mobileOpen={open} onMobileOpen={() => setOpen(true)} onMobileClose={() => setOpen(false)} mobileTitle="消费分析筛选" mobileTriggerLabel="筛选站点、账号与日期" mobileContent={controls} desktopContent={controls} />
  </div>;
}
