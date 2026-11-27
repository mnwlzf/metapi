import { describe, expect, it } from 'vitest';
import { act, create } from 'react-test-renderer';
import { MemoryRouter } from 'react-router-dom';
import OverviewInsights from './OverviewInsights.js';

describe('Dashboard overview insights', () => {
  it('switches between upstream spend and calls, leaves missing days blank and shows sync coverage', async () => {
    const today = new Date();
    today.setHours(12, 0, 0, 0);
    const day = (offset: number) => {
      const date = new Date(today);
      date.setDate(date.getDate() + offset);
      return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
    };
    let root!: WebTestRenderer;
    await act(async () => {
      root = create(<MemoryRouter><OverviewInsights trend={[
        { day: day(-6), spend: 1.25, calls: 120 },
        { day: day(-5), spend: 2.5, calls: 240 },
        { day: day(-3), spend: 4, calls: 360 },
        { day: day(-2), spend: 0, calls: 0 },
        { day: day(-1), spend: 3.125, calls: 72 },
        { day: day(0), spend: 5, calls: 500 },
      ]} coverage={{ covered: 3, expected: 4 }} requests={{ total: 1340, success: 1320, failed: 20, totalTokens: 2_700_000 }} /></MemoryRouter>);
    });
    const bar = (offset: number) => root.root.findAllByType('a').find((node) => String(node.props['aria-label']).startsWith(`${day(offset)} `))!;
    try {
      expect(root.root.findByProps({ 'aria-label': '近七天上游趋势' })).toBeTruthy();
      expect(bar(-5).props['aria-label']).toContain('$2.50');
      expect(bar(-4).props['aria-label']).toContain('待同步');
      expect(root.root.findAllByProps({ 'aria-valuenow': 75 })).toHaveLength(1);
      expect(root.root.findAll((node) => node.type === 'strong' && node.children.join('') === '1,340')).toHaveLength(1);
      const calls = root.root.findAllByType('button').find((node) => node.children.join('') === '调用量')!;
      await act(async () => calls.props.onClick());
      expect(bar(-5).props['aria-label']).toContain('240');
      expect(bar(-4).props['aria-label']).toContain('待同步');
    } finally { root.unmount(); }
  });
});
