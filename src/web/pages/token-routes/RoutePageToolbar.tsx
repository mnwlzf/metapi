import { useEffect, useRef, type ReactNode } from 'react';
import ModernSelect from '../../components/ModernSelect.js';
import { tr } from '../../i18n.js';
import type { EnabledFilter } from './RouteFilterBar.js';
import type { RouteSortBy, RouteSortDir } from './types.js';

type RoutePageToolbarProps = {
  search: string;
  onSearchChange: (value: string) => void;
  sortBy: RouteSortBy;
  sortDir: RouteSortDir;
  onSortChange: (value: RouteSortBy) => void;
  onToggleSortDir: () => void;
  enabledFilter: EnabledFilter;
  onEnabledFilterChange: (value: EnabledFilter) => void;
  counts: { enabled: number; disabled: number; cooling?: number };
  totalCount: number;
  primaryActions: ReactNode;
  secondaryActions: ReactNode;
  statusHint: ReactNode;
};

export default function RoutePageToolbar(props: RoutePageToolbarProps) {
  const moreRef = useRef<HTMLDetailsElement>(null);
  useEffect(() => {
    const closeOutside = (event: PointerEvent) => {
      if (moreRef.current && !moreRef.current.contains(event.target as Node)) moreRef.current.open = false;
    };
    document.addEventListener('pointerdown', closeOutside);
    return () => document.removeEventListener('pointerdown', closeOutside);
  }, []);

  const filters: Array<{ value: EnabledFilter; label: string; count: number }> = [
    { value: 'all', label: tr('全部'), count: props.totalCount },
    { value: 'enabled', label: tr('启用'), count: props.counts.enabled },
    { value: 'cooling', label: tr('冷却中'), count: props.counts.cooling ?? 0 },
    { value: 'disabled', label: tr('禁用'), count: props.counts.disabled },
  ];

  return (
    <>
      <header className="route-page-header">
        <div className="route-page-heading">
          <span className="route-page-mark" aria-hidden>M</span>
          <div>
            <h2>{tr('模型路由')}</h2>
            <p>{tr('查看模型的可用通道，并按需展开账号配置')}</p>
          </div>
        </div>
        <div className="route-page-actions">{props.primaryActions}</div>
      </header>
      <div className="route-page-toolbar">
        <label className="toolbar-search route-page-search">
          <svg width="14" height="14" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden>
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
          </svg>
          <input value={props.search} onChange={(event) => props.onSearchChange(event.target.value)} placeholder={tr('搜索模型路由...')} aria-label={tr('搜索模型路由...')} />
        </label>
        <div className="route-page-status-filters" role="group" aria-label={tr('状态')}>
          {filters.map((filter) => (
            <button key={filter.value} type="button" className={`route-status-filter ${props.enabledFilter === filter.value ? 'is-active' : ''}`} aria-pressed={props.enabledFilter === filter.value} onClick={() => props.onEnabledFilterChange(filter.value)}>
              {filter.label}<span>{filter.count}</span>
            </button>
          ))}
        </div>
        <div className="route-page-sort">
          <ModernSelect size="sm" value={props.sortBy} onChange={(value) => props.onSortChange(value as RouteSortBy)} options={[
            { value: 'modelPattern', label: tr('模型名称') },
            { value: 'channelCount', label: tr('通道数量') },
          ]} placeholder={tr('排序字段')} />
          <button type="button" className="btn btn-ghost route-toolbar-button" onClick={props.onToggleSortDir} data-tooltip={tr('切换排序方向')} aria-label={tr('切换排序方向')}>{props.sortDir === 'asc' ? tr('升序 ↑') : tr('降序 ↓')}</button>
        </div>
        <details ref={moreRef} className="route-page-more" onKeyDown={(event) => {
          if (event.key === 'Escape' && moreRef.current?.open) {
            moreRef.current.open = false;
            moreRef.current.querySelector('summary')?.focus();
          }
        }}>
          <summary className="btn btn-ghost route-toolbar-button">{tr('更多操作')}<span aria-hidden>⌄</span></summary>
          <div className="route-page-more-actions" onClick={(event) => {
            const button = (event.target as HTMLElement).closest('button');
            if (button && !button.disabled && moreRef.current) moreRef.current.open = false;
          }}>{props.secondaryActions}</div>
        </details>
      </div>
      <div className="route-page-status-hint">{props.statusHint}</div>
    </>
  );
}
