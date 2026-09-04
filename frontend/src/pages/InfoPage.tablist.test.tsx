/**
 * A11Y — /treasury, /contracts, /risks, /terms, /privacy reach assistive tech as
 * a real tablist.
 *
 * InfoPage hosts the site's legal and treasury navigation behind a control that
 * LOOKS like tabs and was built as five `aria-pressed` toggle buttons: no
 * `role="tablist"`, no `role="tab"`, no `aria-controls`, no `tabpanel`, no roving
 * focus. A sighted user got tabs; a screen-reader user got five unlabelled
 * toggles. ActivityPage next door — the same route-navigating tab pattern, same
 * shared `useTabListKeys` hook — already did all five.
 *
 * These assertions fail on the pre-change file: `getAllByRole('tab')` finds
 * nothing when the buttons carry only `aria-pressed`.
 *
 * The five hosted pages are stubbed. They are lazy-loaded route content; the
 * subject here is the strip above them.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

vi.mock('./TreasuryPage', () => ({ default: () => <div>treasury panel</div> }));
vi.mock('./ContractsPage', () => ({ default: () => <div>contracts panel</div> }));
vi.mock('./RisksPage', () => ({ default: () => <div>risks panel</div> }));
vi.mock('./TermsPage', () => ({ default: () => <div>terms panel</div> }));
vi.mock('./PrivacyPage', () => ({ default: () => <div>privacy panel</div> }));

import InfoPage from './InfoPage';

const at = (path: string) =>
  render(
    <MemoryRouter initialEntries={[path]}>
      <InfoPage />
    </MemoryRouter>,
  );

describe('InfoPage tab strip', () => {
  it('is a labelled tablist of tabs, not a row of toggle buttons', () => {
    at('/risks');
    const list = screen.getByRole('tablist');
    expect(list).toHaveAttribute('aria-label');
    const tabs = screen.getAllByRole('tab');
    expect(tabs.map((t) => t.textContent)).toEqual([
      'Treasury',
      'Contracts',
      'Risks',
      'Terms',
      'Privacy',
    ]);
    // The state the old markup expressed with aria-pressed, which announces a
    // toggle rather than a selection.
    for (const t of tabs) expect(t).not.toHaveAttribute('aria-pressed');
  });

  it('marks exactly one tab selected, and it is the one the URL names', () => {
    at('/terms');
    const selected = screen.getAllByRole('tab').filter((t) => t.getAttribute('aria-selected') === 'true');
    expect(selected).toHaveLength(1);
    expect(selected[0]).toHaveTextContent('Terms');
  });

  it('points every tab at a tabpanel that exists and names it back', () => {
    at('/privacy');
    const panel = screen.getByRole('tabpanel');
    for (const t of screen.getAllByRole('tab')) {
      expect(t.getAttribute('aria-controls')).toBe(panel.id);
    }
    // The panel labels itself by the SELECTED tab, so the panel announces which
    // section it belongs to.
    const selected = screen.getAllByRole('tab').find((t) => t.getAttribute('aria-selected') === 'true');
    expect(panel.getAttribute('aria-labelledby')).toBe(selected!.id);
  });

  it('keeps a single tab in the Tab sequence and moves the rest with arrows', () => {
    at('/treasury');
    const tabs = screen.getAllByRole('tab');
    expect(tabs.filter((t) => t.getAttribute('tabindex') === '0')).toHaveLength(1);
    expect(tabs[0]).toHaveAttribute('tabindex', '0');

    // Roving focus: ArrowRight from the first tab activates the second. The
    // handler lives on the tablist, which is where the keydown bubbles to.
    fireEvent.keyDown(screen.getByRole('tablist'), { key: 'ArrowRight' });
    expect(screen.getAllByRole('tab').find((t) => t.getAttribute('aria-selected') === 'true')).toHaveTextContent(
      'Contracts',
    );
  });
});
