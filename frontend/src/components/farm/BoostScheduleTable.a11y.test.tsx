/**
 * A11Y-R06 — the Boost Schedule says one true thing at both breakpoints.
 *
 * The desktop branch declared role="table" over role="row" divs holding plain
 * <span>s — no role="cell" anywhere, so the announced table was empty — and put
 * aria-selected on a row, which is only valid inside a grid/treegrid. The
 * mobile branch already used a list with aria-current. Both assertions below
 * fail on the pre-change component.
 */
import { describe, it, expect } from 'vitest';
import { renderWithProviders } from '../../test-utils/render';
import { BoostScheduleTable } from './BoostScheduleTable';
import { LOCK_OPTIONS } from '../../lib/constants';

describe('BoostScheduleTable', () => {
  it('declares no table role and no row without cells', () => {
    const { container } = renderWithProviders(
      <BoostScheduleTable selectedLockLabel={LOCK_OPTIONS[0]!.label} />,
    );
    for (const row of container.querySelectorAll('[role="row"]')) {
      expect(
        row.querySelector('[role="cell"], [role="gridcell"], [role="columnheader"]'),
        'a role="row" with no cell descendant is an empty table to a screen reader',
      ).not.toBeNull();
    }
    expect(container.querySelectorAll('[role="table"]')).toHaveLength(0);
    // aria-selected is only valid on option/row-in-grid/tab — never on this.
    expect(container.querySelectorAll('[aria-selected]')).toHaveLength(0);
  });

  it('marks the selected lock with aria-current in both breakpoint branches', () => {
    const selected = LOCK_OPTIONS[1]!;
    const { container } = renderWithProviders(
      <BoostScheduleTable selectedLockLabel={selected.label} />,
    );
    // Both branches are in the DOM under jsdom (CSS decides which one paints),
    // so the selected lock is marked exactly twice — once per branch.
    const current = container.querySelectorAll('[aria-current="true"]');
    expect(current).toHaveLength(2);
    for (const el of current) expect(el.textContent).toContain(selected.label);
  });
});
