import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../api.js';
import { useToast } from '../components/Toast.js';
import ListPage from '../components/ListPage.js';
import { tr } from '../i18n.js';

const TYPE_LABELS: Record<string, string> = {
  text: tr('文本'), image: tr('图片'), embedding: tr('向量'), rerank: tr('重排'),
  audio: tr('音频'), video: tr('视频'), other: tr('其他'),
};

export default function ProbePlan() {
  const toast = useToast();
  const [search, setSearch] = useState('');
  const [savingModel, setSavingModel] = useState('');
  const planQuery = useQuery({
    queryKey: ['model-probe-plan'],
    queryFn: () => api.getModelProbePlan(),
    staleTime: 30_000,
  });
  const models = planQuery.data?.models ?? [];
  const filteredModels = useMemo(() => {
    const query = search.trim().toLowerCase();
    return query ? models.filter((item) => item.modelName.toLowerCase().includes(query)) : models;
  }, [models, search]);

  async function updateInterval(modelName: string, intervalHours: number | null) {
    setSavingModel(modelName);
    try {
      await api.setModelProbeInterval(modelName, intervalHours);
      await planQuery.refetch();
      toast.success(tr('探测频率已保存'));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : tr('保存探测频率失败'));
    } finally {
      setSavingModel('');
    }
  }

  return (
    <ListPage
      title={tr('模型探测计划')}
      subtitle={tr('查看每个模型的分类、近 7 天使用量和探测频率；自动模式按使用热度调整，手动频率会覆盖自动建议。')}
      loading={planQuery.isLoading}
      isEmpty={!planQuery.isLoading && models.length === 0}
      emptyTitle={tr('暂无已发现模型')}
      emptyDesc={tr('先刷新站点的模型列表，模型出现后即可在这里调整探测频率。')}
      beforeList={(
        <div style={{ display: 'flex', gap: 12, alignItems: 'center', justifyContent: 'space-between', marginBottom: 14, flexWrap: 'wrap' }}>
          <div style={{ fontSize: 13, color: 'var(--color-text-secondary)' }}>
            {tr('图片、视频和其他非文本模型默认每 72 小时探测一次；手动选择“自动”可恢复按使用量调整。')}
          </div>
          <input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder={tr('搜索模型')}
            aria-label={tr('搜索模型')}
            style={{ minWidth: 220, maxWidth: '100%' }}
          />
        </div>
      )}
      cardStyle={{ padding: 0 }}
    >
      <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 700 }}>
        <thead>
          <tr>
            {[tr('模型'), tr('分类'), tr('近 7 天请求'), tr('自动建议'), tr('当前探测频率')].map((heading) => (
              <th key={heading} style={{ textAlign: 'left', padding: '12px 14px', borderBottom: '1px solid var(--color-border)', color: 'var(--color-text-secondary)', fontSize: 12, whiteSpace: 'nowrap' }}>{heading}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {filteredModels.map((model) => (
            <tr key={model.modelName}>
              <td style={{ padding: '12px 14px', borderBottom: '1px solid var(--color-border)', fontWeight: 550 }}>{model.modelName}</td>
              <td style={{ padding: '12px 14px', borderBottom: '1px solid var(--color-border)' }}>{TYPE_LABELS[model.type] || TYPE_LABELS.other}</td>
              <td style={{ padding: '12px 14px', borderBottom: '1px solid var(--color-border)', fontVariantNumeric: 'tabular-nums' }}>{model.recentCalls.toLocaleString()}</td>
              <td style={{ padding: '12px 14px', borderBottom: '1px solid var(--color-border)', whiteSpace: 'nowrap' }}>{formatInterval(model.automaticIntervalHours)}</td>
              <td style={{ padding: '8px 14px', borderBottom: '1px solid var(--color-border)' }}>
                <select
                  value={model.overridden ? String(model.intervalHours) : 'auto'}
                  disabled={savingModel === model.modelName}
                  aria-label={`${model.modelName} ${tr('探测频率')}`}
                  onChange={(event) => void updateInterval(model.modelName, event.target.value === 'auto' ? null : Number(event.target.value))}
                  style={{ minWidth: 145 }}
                >
                  <option value="auto">{tr('自动')}（{formatInterval(model.automaticIntervalHours)}）</option>
                  {(planQuery.data?.intervals ?? []).map((hours) => (
                    <option key={hours} value={hours}>{formatInterval(hours)}</option>
                  ))}
                </select>
              </td>
            </tr>
          ))}
          {filteredModels.length === 0 && models.length > 0 && (
            <tr><td colSpan={5} style={{ padding: 24, textAlign: 'center', color: 'var(--color-text-muted)' }}>{tr('没有匹配的模型')}</td></tr>
          )}
        </tbody>
      </table>
    </ListPage>
  );
}

function formatInterval(hours: number): string {
  if (hours < 24) return `${hours} ${tr('小时')}`;
  return `${hours / 24} ${tr('天')}`;
}
