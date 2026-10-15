/**
 * RouteTabs renders a NavItem's compactTabLabel for sight only: the short form is
 * aria-hidden and the tab keeps its full label as its accessible name. Which one
 * shows at which width is CSS, so e2e/tab-label-fit.spec.ts measures that.
 */
import { describe, it, expect } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { LOCK_SECTION, type NavItem } from '../../lib/navConfig';
import { RouteTabs } from './RouteTabs';

const strip = (items: readonly NavItem[], active = items[0].to) =>
  render(<RouteTabs idPrefix="t" ariaLabel="Test sections" items={items} active={active} onSelect={() => {}} />);

describe('RouteTabs compact labels', () => {
  it('shows the Lock strip’s Copy Trading tab as CT while its accessible name stays Copy Trading', () => {
    strip(LOCK_SECTION.items);
    const tab = screen.getByRole('tab', { name: 'Copy Trading' });
    expect(within(tab).getByText('CT')).toHaveAttribute('aria-hidden', 'true');
    // The name comes from the tab's own text. A title would repeat it as the
    // description, read out a second time on a phone that never shows a tooltip.
    expect(tab).not.toHaveAttribute('title');
    // No tab in the strip is announced as "CT".
    expect(screen.queryByRole('tab', { name: /\bCT\b/ })).toBeNull();
  });

  it('renders whatever compact label the data carries, keyed off tabLabel when there is one', () => {
    strip([
      { to: '/a', label: 'Alpha' },
      { to: '/long', label: 'A Very Long Destination', tabLabel: 'Long Dest', compactTabLabel: 'LD' },
    ]);
    const tab = screen.getByRole('tab', { name: /^Long Dest/ });
    expect(within(tab).getByText('LD')).toHaveAttribute('aria-hidden', 'true');
    expect(tab).not.toHaveAttribute('title');
  });

  it('renders an entry without a compact label exactly as before: one label, no hidden text, no title', () => {
    strip([
      { to: '/a', label: 'Alpha' },
      { to: '/b', label: 'Bravo Destination', tabLabel: 'Bravo', live: true },
    ]);
    const tabs = screen.getAllByRole('tab');
    expect(tabs.map((t) => t.textContent)).toEqual(['Alpha', 'BravoLive']);
    expect(screen.getByRole('tab', { name: 'Alpha' })).not.toHaveAttribute('title');
    expect(screen.getByRole('tab', { name: /^Bravo/ })).not.toHaveAttribute('title');
    // The live pill's dot is the only aria-hidden node, as it was.
    expect(tabs[0].querySelector('[aria-hidden="true"]')).toBeNull();
    expect(tabs[1].querySelectorAll('[aria-hidden="true"]')).toHaveLength(1);
  });
});

// An entry that is off today is not listed and nothing says Soon (docs/FACE_LAWS.md, law 23).
// Its page still opens by URL, and there its own tab is the one lit, so the strip says where
// the visitor is and the panel keeps the tab that names it.
describe('RouteTabs: off is not listed', () => {
  const ITEMS: NavItem[] = [
    { to: '/a', label: 'Alpha' },
    { to: '/off', label: 'Off Destination', tabLabel: 'Off', soon: true },
    { to: '/c', label: 'Charlie', live: true },
  ];

  it('leaves an off entry out of the strip', () => {
    strip(ITEMS);
    expect(screen.getAllByRole('tab').map((t) => t.textContent)).toEqual(['Alpha', 'CharlieLive']);
  });

  it('shows the off entry only on its own page, lit, and never the word Soon', () => {
    const { container } = strip(ITEMS, '/off');
    expect(screen.getAllByRole('tab').map((t) => t.textContent)).toEqual(['Alpha', 'Off', 'CharlieLive']);
    expect(screen.getByRole('tab', { name: 'Off' })).toHaveAttribute('aria-selected', 'true');
    expect(container.textContent).not.toMatch(/soon/i);
  });
});
