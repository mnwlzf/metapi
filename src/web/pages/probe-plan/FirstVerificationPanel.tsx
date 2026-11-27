import { useState } from 'react';
import { api } from '../../api.js';
import { useToast } from '../../components/Toast.js';
import { tr } from '../../i18n.js';

type VerificationData = Awaited<ReturnType<typeof api.getModelProbePlan>>['firstVerification'];
type Settings = VerificationData['settings'];

export default function FirstVerificationPanel({ data, pendingCount, onRefresh }: {
  data: VerificationData; pendingCount: number; onRefresh: () => Promise<void>;
}) {
  const toast = useToast();
  const [submitting, setSubmitting] = useState(false);
  const { settings, budget } = data;
  async function run() {
    setSubmitting(true);
    try {
      await api.runFirstVerification();
      toast.success(tr('已安排下一批首次验证，可在任务中心查看结果'));
      await onRefresh();
    } catch (error) { toast.error(error instanceof Error ? error.message : tr('安排验证失败')); }
    finally { setSubmitting(false); }
  }
  return (
    <section className="first-verification-panel" aria-label={tr('首次验证队列')}>
      <div className="first-verification-heading">
        <div><h2>{tr('首次验证队列')}</h2><p>{tr('新发现的 Key × 模型通过验证后加入路由，每分钟检查一次队列。')}</p></div>
        <span className={`probe-plan-state${budget.running ? ' is-available' : ''}`}>
          {budget.running ? tr('正在验证') : budget.pauseReason ? tr('额度暂停') : settings.enabled ? tr('自动运行') : tr('自动验证已暂停')}
        </span>
      </div>
      <div className="first-verification-metrics">
        <div><span>{tr('待验证组合')}</span><strong>{pendingCount.toLocaleString()} <small>Key × {tr('模型')}</small></strong></div>
        <div><span>{tr('近一小时组合验证')}</span><strong>{budget.hourlyUsed} <small>/ {settings.hourlyLimit}</small></strong></div>
        <div><span>{tr('图片 / 视频验证')}</span><strong>{budget.mediaHourlyUsed} <small>/ {settings.mediaHourlyLimit} · {tr('每小时')}</small></strong></div>
        <div><span>{tr('今日已记录费用（UTC）')}</span><strong>${budget.dailyCostUsd.toFixed(4)} <small>/ ${settings.dailyCostLimitUsd}</small></strong></div>
      </div>
      {budget.pauseReason && <p className="first-verification-note">{budget.pauseReason}</p>}
      {budget.lastBatch && <p className="first-verification-note" role="status">
        {tr('最近一批')}：{budget.lastBatch.probed} {tr('已处理')} · {budget.lastBatch.supported} {tr('验证成功')} · {budget.lastBatch.notConfirmed} {tr('未确认可用')}
      </p>}
      <div className="first-verification-actions">
        <span>{tr('每批')} {settings.batchSize} · {tr('并发')} {settings.concurrency} · {tr('同账号分组间隔')} {settings.groupIntervalSeconds}s</span>
        <button className="btn btn-primary btn-sm" type="button" onClick={() => void run()}
          disabled={submitting || budget.running || pendingCount === 0 || !!budget.pauseReason}>
          {submitting ? tr('安排中...') : tr('验证下一批')}
        </button>
      </div>
      <details className="first-verification-settings"><summary>{tr('调整首次验证设置')}</summary>
        <SettingsForm key={JSON.stringify(settings)} settings={settings} onRefresh={onRefresh} />
      </details>
      <p className="first-verification-note">{tr('费用保护依据探测日志中的已记录费用，并非上游账单硬限额；未知费用及正在执行的验证可能造成超额。验证数按 Key × 模型计，一次验证可能尝试多个接口。')}
        {budget.unknownCostCount > 0 && ` ${budget.unknownCostCount} ${tr('条记录费用未知。')}`}
      </p>
    </section>
  );
}

function SettingsForm({ settings, onRefresh }: { settings: Settings; onRefresh: () => Promise<void> }) {
  const [draft, setDraft] = useState(settings);
  const [saving, setSaving] = useState(false);
  const toast = useToast();
  const fields = [
    ['batchSize', tr('每批验证数'), 1, 20, 1],
    ['hourlyLimit', tr('每小时组合验证上限'), 1, 1000, 1],
    ['concurrency', tr('最大并发'), 1, 4, 1],
    ['groupIntervalSeconds', tr('同账号分组间隔（秒）'), 0, 60, 1],
    ['mediaHourlyLimit', tr('图片 / 视频每小时上限（0 为暂停）'), 0, 100, 1],
    ['dailyCostLimitUsd', tr('每日已记录费用上限（美元）'), 0.01, 1000, 0.01],
  ] as const;
  return <form onSubmit={(event) => {
    event.preventDefault();
    setSaving(true);
    void api.saveFirstVerificationSettings(draft).then(async () => {
      toast.success(tr('首次验证设置已保存')); await onRefresh();
    }).catch((error: unknown) => toast.error(error instanceof Error ? error.message : tr('保存失败')))
      .finally(() => setSaving(false));
  }}>
    <label className="first-verification-toggle"><input type="checkbox" checked={draft.enabled}
      onChange={(event) => setDraft({ ...draft, enabled: event.target.checked })} />{tr('自动验证新发现的组合')}</label>
    <div className="first-verification-fields">{fields.map(([key, label, min, max, step]) => <label key={key}>
      <span>{label}</span><input type="number" required min={min} max={max} step={step} value={draft[key]}
        onChange={(event) => setDraft({ ...draft, [key]: Number(event.target.value) })} />
    </label>)}</div>
    <button type="submit" className="btn btn-primary btn-sm" disabled={saving}>{saving ? tr('保存中...') : tr('保存设置')}</button>
  </form>;
}
