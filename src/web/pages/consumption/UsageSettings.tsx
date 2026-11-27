import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api } from '../../api.js';
import { useToast } from '../../components/Toast.js';
import CenteredModal from '../../components/CenteredModal.js';
import { useIsMobile } from '../../components/useIsMobile.js';
import { MobileCard, MobileField } from '../../components/MobileCard.js';
import type { UsageCollectionConfig, UsageCollectionPolicy } from '../../../server/shared/upstreamUsage.js';
import { DEFAULT_USAGE_POLICY } from '../../../server/shared/upstreamUsage.js';
import { useConsumption } from './useConsumption.js';
import { when } from './consumptionModel.js';
import './consumption.css';

const fields: Array<{ key: Exclude<keyof UsageCollectionPolicy, 'enabled'>; label: string; min: number; max: number; hint: string }> = [
  { key: 'statsMinutes', label: '总览基础间隔（分钟）', min: 5, max: 10080, hint: '实际消费、请求与厂商统计' },
  { key: 'keysMinutes', label: 'Key 基础间隔（分钟）', min: 5, max: 10080, hint: '今日与上游累计 Key 消费' },
  { key: 'modelsMinutes', label: '模型基础间隔（分钟）', min: 5, max: 10080, hint: '当天模型费用与 Token 汇总' },
  { key: 'jitterPercent', label: '随机摆动（±%）', min: 0, max: 80, hint: '每轮独立随机，避免同时集中请求' },
  { key: 'gapMinSeconds', label: '请求间隔下限（秒）', min: 2, max: 300, hint: '同一上游地址内串行错峰' },
  { key: 'gapMaxSeconds', label: '请求间隔上限（秒）', min: 2, max: 600, hint: '上下限之间随机等待' },
  { key: 'accountHourlyBudget', label: '每账号每小时请求上限', min: 1, max: 120, hint: '包含采集、重试和采集触发的鉴权刷新' },
  { key: 'originHourlyBudget', label: '同上游地址每小时上限', min: 1, max: 240, hint: '多个站点指向同一地址时共同限频' },
  { key: 'historyDays', label: '自动补齐历史天数', min: 0, max: 30, hint: '0 关闭；历史模型数据低优先级补齐' },
  { key: 'historyDailyBudget', label: '每账号每日历史请求上限', min: 0, max: 60, hint: '手动补齐同样遵守此预算' },
  { key: 'correctionHours', label: '历史复核间隔（小时）', min: 6, max: 168, hint: '复核最近三天，接收延迟计费修正' },
];

function PolicyForm({ value, onChange, global = false }: { value: UsageCollectionPolicy; onChange: (value: UsageCollectionPolicy) => void; global?: boolean }) {
  return <>
    <label className="consumption-actions"><input type="checkbox" checked={value.enabled} onChange={(event) => onChange({ ...value, enabled: event.target.checked })} />启用自动消费采集</label>
    <div className="consumption-form">
      {fields.map((field) => <label key={field.key}>{field.label}<input type="number" required min={field.min} max={field.max} step="1" value={value[field.key]} onChange={(event) => onChange({ ...value, [field.key]: Number(event.target.value) })} /><small>{field.hint}</small></label>)}
      {global && <label>全局跨站点并发<input type="number" required min={1} max={4} step="1" value={value.concurrency} onChange={(event) => onChange({ ...value, concurrency: Number(event.target.value) })} /><small>同一上游地址始终串行，默认最多 2 个地址并行</small></label>}
    </div>
    <div className="consumption-notice">总览实际间隔：{(value.statsMinutes * (1 - value.jitterPercent / 100)).toFixed(1)}～{(value.statsMinutes * (1 + value.jitterPercent / 100)).toFixed(1)} 分钟。<br />正常采集约 {(60 / value.statsMinutes + 60 / value.keysMinutes + 60 / value.modelsMinutes).toFixed(1)} 次／账号／小时，另有低频 Key 目录和历史任务，均受预算限制。预算不足时会排队。</div>
  </>;
}

export default function UsageSettings() {
  const { data, error, reload } = useConsumption();
  const [config, setConfig] = useState<UsageCollectionConfig | null>(null);
  const [saving, setSaving] = useState(false);
  const [params, setParams] = useSearchParams();
  const siteId = params.get('siteId');
  const [draft, setDraft] = useState<UsageCollectionPolicy>({ ...DEFAULT_USAGE_POLICY });
  const [inherit, setInherit] = useState(true);
  const toast = useToast(); const mobile = useIsMobile();
  useEffect(() => { api.getConsumptionSettings().then(setConfig).catch((error) => toast.error(String(error))); }, []);
  useEffect(() => {
    if (config && siteId) { setInherit(!config.sites[siteId]); setDraft({ ...config.defaults, ...config.sites[siteId] }); }
  }, [siteId, config]);
  const save = async (next: UsageCollectionConfig) => {
    setSaving(true);
    try { setConfig(await api.saveConsumptionSettings(next)); toast.success('采集设置已保存，下一次时间已重新安排'); await reload(); }
    catch (error) { toast.error(error instanceof Error ? error.message : '保存失败'); }
    finally { setSaving(false); }
  };
  const close = () => { const next = new URLSearchParams(params); next.delete('siteId'); setParams(next); };
  if (!config) return <div className="consumption-empty">正在加载采集设置…</div>;
  const sites = [...new Map((data?.accounts || []).map((account) => [account.siteId, { id: account.siteId, name: account.siteName }])).values()];
  return <div>
    {error && <div role="alert" className="consumption-notice">{error}</div>}
    <form className="card consumption-panel" onSubmit={(event) => { event.preventDefault(); void save(config); }}>
      <div className="consumption-heading"><div><h3>全局默认配置</h3><div className="consumption-subtitle">页面刷新只读取本地数据；这里控制后台访问上游的频率。统计时区：{data?.timeZone || '加载中'}</div></div><Link to="/consumption" className="btn btn-ghost">查看消费分析 →</Link></div>
      <PolicyForm value={config.defaults} onChange={(defaults) => setConfig({ ...config, defaults })} global />
      <div className="consumption-form"><label>统计时区<input required value={config.timeZone || 'Asia/Shanghai'} onChange={(event) => setConfig({ ...config, timeZone: event.target.value })} /><small>使用 IANA 时区，例如 Asia/Shanghai；切换时区后数据分别保存，需要重新采集。</small></label></div>
      <div className="consumption-footer"><span className="consumption-subtitle">保存只重新排期，不会立即请求上游；手动同步仍遵守预算与冷却。</span><button className="btn btn-primary" disabled={saving}>{saving ? '保存中…' : '保存全局设置'}</button></div>
    </form>
    <div className="card consumption-panel"><div className="consumption-heading"><div><h3>站点采集状态</h3><div className="consumption-subtitle">站点可继承全局，或单独调整间隔、预算及暂停状态。</div></div></div>
      {sites.map((site) => {
        const accounts = data!.accounts.filter((account) => account.siteId === site.id);
        const policy = { ...config.defaults, ...config.sites[String(site.id)] };
        const tasks = accounts.flatMap((account) => Object.values(account.state?.tasks || {}));
        const last = tasks.map((task) => task.lastSuccessAt).filter(Boolean).sort().at(-1);
        const next = Math.min(...tasks.filter((task) => !task.paused).map((task) => task.nextAt));
        const status = !policy.enabled ? '已暂停' : config.sites[String(site.id)] ? '自定义' : '继承全局';
        const details = accounts.map((account) => account.reason || (account.duplicateOf ? `账号 ${account.accountId} 与 ${account.duplicateOf} 重复，已去重` : account.state?.blocked || Object.values(account.state?.tasks || {}).find((task) => task.error)?.error)).filter(Boolean);
        const body = <><div className="consumption-heading"><div><strong>{site.name}</strong> <span className="badge badge-muted">{status}</span></div><div className="consumption-actions"><Link to={`/consumption?siteId=${site.id}`}>消费分析</Link><button className="btn btn-ghost" onClick={() => { const next = new URLSearchParams(params); next.set('siteId', String(site.id)); setParams(next); }}>采集设置</button><button className="btn btn-ghost" onClick={async () => { try { const result = await api.syncConsumption({ siteId: site.id, resume: true }); toast.success(`已安排 ${result.queued} 个账号，仍遵守冷却与限频`); await reload(); } catch (error) { toast.error(String(error)); } }}>恢复并同步</button></div></div><div className="consumption-subtitle">总览 {policy.statsMinutes} 分钟 · Key {policy.keysMinutes} 分钟 · 模型 {policy.modelsMinutes} 分钟 · 摆动 ±{policy.jitterPercent}%<br />最近成功：{when(last)}　下次计划：{Number.isFinite(next) ? when(next) : '尚未安排'}{details.length > 0 && <><br /><span style={{ color: 'var(--color-warning)' }}>{details.join('；')}</span></>}</div></>;
        return mobile ? <MobileCard key={site.id} title={site.name}><MobileField label="站点采集" value={body} /></MobileCard> : <div className="consumption-mobile-row" key={site.id}>{body}</div>;
      })}
      {sites.length === 0 && <div className="consumption-empty">添加账号后，这里会显示采集状态。</div>}
    </div>
    <CenteredModal open={!!siteId} onClose={close} title={`${sites.find((site) => String(site.id) === siteId)?.name || '站点'} · 消费采集设置`} maxWidth={820} closeOnEscape>
      <form onSubmit={async (event) => { event.preventDefault(); const sites = { ...config.sites }; const { concurrency: _concurrency, ...sitePolicy } = draft; if (inherit) delete sites[siteId!]; else sites[siteId!] = sitePolicy; await save({ ...config, sites }); }}>
        <label className="consumption-actions" style={{ marginBottom: 18 }}><input type="checkbox" checked={inherit} onChange={(event) => setInherit(event.target.checked)} />继承全局配置</label>
        {inherit ? <div className="consumption-notice">该站点跟随全局设置。关闭继承后，可以单独调整或暂停采集。</div> : <PolicyForm value={draft} onChange={setDraft} />}
        <div className="consumption-actions"><button className="btn btn-primary" disabled={saving}>{saving ? '保存中…' : inherit ? '恢复继承并保存' : '保存站点配置'}</button><button type="button" className="btn btn-ghost" onClick={close}>关闭</button></div>
      </form>
    </CenteredModal>
  </div>;
}
