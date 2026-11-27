import { describe, expect, it } from 'vitest';
import postcss from 'postcss';
import { readAllCss } from './readStyles.testutil.js';

describe('route card grid layout', () => {
  it('keeps details beside their summary in document order instead of below every summary', () => {
    const styles = postcss.parse(readAllCss());
    let detailRuleFound = false;

    styles.walkRules((rule) => {
      if (!/\.route-(?:detail-panel-presence|card-collapsed)\b/.test(rule.selector)) return;
      if (rule.selector.includes('.route-detail-panel-presence')) detailRuleFound = true;
      // Grid sorts by order before placing items. A different order moves an
      // otherwise adjacent detail panel to the very end of a long route list.
      rule.walkDecls('order', (declaration) => {
        expect(declaration.value, rule.selector).toBe('0');
      });
    });

    expect(detailRuleFound).toBe(true);
  });
});
