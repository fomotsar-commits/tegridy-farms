/**
 * SectionHost: one nav section rendered as one page with tabs. The tab the URL names lights and
 * renders (a prefix match would render /launch for /launch-simulator), and an entry that is off
 * today is not listed but still opens by URL (docs/FACE_LAWS.md, law 23).
 */
import { describe, it, expect, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import type { NavSection } from '../lib/navConfig';
import { SectionHost } from './SectionHost';

const SECTION: NavSection = {
  heading: 'Launch',
  hub: '/launch',
  items: [
    { to: '/launch', label: 'Launch', tabLabel: 'Launchpad' },
    { to: '/curve-launch', label: 'Memetics Curve (Solana)', tabLabel: 'Solana Curve', soon: true },
    { to: '/eth-curve', label: 'Memetics Curve (Ethereum)', tabLabel: 'Memetics Curve', live: true },
    { to: '/launch-simulator', label: 'Launch Simulator', tabLabel: 'Simulator' },
  ],
};

const panel = (name: string) => () => <div>{name} panel</div>;
const PANELS = {
  '/launch': panel('launchpad'),
  '/curve-launch': panel('solana'),
  '/eth-curve': panel('evm'),
  '/launch-simulator': panel('simulator'),
};

const at = (path: string) =>
  render(
    <MemoryRouter initialEntries={[path]}>
      <SectionHost section={SECTION} idPrefix="launch" ariaLabel="Launch sections" panels={PANELS} />
    </MemoryRouter>,
  );

const selected = () =>
  screen.getAllByRole('tab').find((t) => t.getAttribute('aria-selected') === 'true');

describe('SectionHost', () => {
  it('renders one tab per section entry that is on, so the strip lists nothing that is off', () => {
    at('/launch');
    expect(screen.getAllByRole('tab').map((t) => t.textContent)).toEqual([
      'Launchpad',
      'Memetics CurveLive',
      'Simulator',
    ]);
  });

  it('selects the tab the URL names, and renders that page', async () => {
    at('/eth-curve');
    expect(selected()).toHaveTextContent('Memetics Curve');
    expect(await screen.findByText('evm panel')).toBeInTheDocument();
  });

  it('does not mistake /launch-simulator for /launch', async () => {
    at('/launch-simulator');
    // A prefix match lights "Launchpad" here and renders the Doppler wizard.
    expect(selected()).toHaveTextContent('Simulator');
    expect(await screen.findByText('simulator panel')).toBeInTheDocument();
    expect(screen.queryByText('launchpad panel')).not.toBeInTheDocument();
  });

  it('lands on the hub tab for a path the section does not own', () => {
    at('/somewhere-else');
    expect(selected()).toHaveTextContent('Launchpad');
  });

  it('still opens an off entry by its URL, with its own tab lit and no word Soon', async () => {
    const { container } = at('/curve-launch');
    expect(selected()).toHaveTextContent('Solana Curve');
    expect(await screen.findByText('solana panel')).toBeInTheDocument();
    expect(container.textContent).not.toMatch(/soon/i);
  });

  it('is a real tablist pointing at a tabpanel that names it back', () => {
    at('/curve-launch');
    const list = screen.getByRole('tablist');
    expect(list).toHaveAttribute('aria-label', 'Launch sections');
    const tabpanel = screen.getByRole('tabpanel');
    for (const t of screen.getAllByRole('tab')) {
      expect(t.getAttribute('aria-controls')).toBe(tabpanel.id);
      expect(t).not.toHaveAttribute('aria-pressed');
    }
    expect(tabpanel.getAttribute('aria-labelledby')).toBe(selected()!.id);
  });

  it('navigates on click rather than swapping a panel behind a stale URL', async () => {
    const { container } = render(
      <MemoryRouter initialEntries={['/launch']}>
        <SectionHost section={SECTION} idPrefix="launch" ariaLabel="Launch sections" panels={PANELS} />
      </MemoryRouter>,
    );
    const tab = screen.getAllByRole('tab').find((t) => t.textContent?.startsWith('Simulator'))!;
    const { fireEvent } = await import('@testing-library/react');
    fireEvent.click(tab);
    expect(await screen.findByText('simulator panel')).toBeInTheDocument();
    expect(container.querySelector('[aria-selected="true"]')).toHaveTextContent('Simulator');
  });
});

describe('SectionHost — a page under a tab', () => {
  // /earn/<id> is one pool under the Earn host's first tab, /earn. Before
  // 2026-09-30 a click on the LIT tab was a no-op, and the lit tab is the only
  // one a visitor inside a pool would reach for to get back to the list.
  const EARN: NavSection = {
    heading: 'Earn',
    hub: '/earn',
    items: [
      { to: '/earn', label: 'Staking' },
      { to: '/referrals', label: 'Referrals' },
    ],
  };
  function StakingPanel() {
    const { pathname } = useLocation();
    return <div>staking panel at {pathname}</div>;
  }
  const EARN_PANELS = { '/earn': StakingPanel, '/referrals': panel('referrals') };

  it('lights the tab above it, and a click on that tab goes back up to the tab', async () => {
    render(
      <MemoryRouter initialEntries={['/earn/bayla']}>
        <SectionHost section={EARN} idPrefix="earn" ariaLabel="Earn sections" panels={EARN_PANELS} />
      </MemoryRouter>,
    );
    expect(selected()).toHaveTextContent('Staking');
    expect(await screen.findByText('staking panel at /earn/bayla')).toBeInTheDocument();
    fireEvent.click(selected()!);
    expect(await screen.findByText('staking panel at /earn')).toBeInTheDocument();
  });
});

describe('SectionHost — top clearance', () => {
  // The strip takes no room in the flow and lies over the panel's top padding, so the
  // panel keeps that padding or its own heading starts under the tabs.
  it('pads the panel by the strip', async () => {
    const { container } = render(
      <MemoryRouter initialEntries={['/launch']}>
        <SectionHost section={SECTION} idPrefix="launch" ariaLabel="Launch sections" panels={PANELS} />
      </MemoryRouter>,
    );
    await screen.findByText('launchpad panel');
    expect(container.querySelector('#launch-panel > .pt-14')).toBeTruthy();
  });
});

// Suppress the lazy/Suspense act() noise the three older hosts also produce.
vi.mock('../components/PageSkeleton', () => ({ PageSkeleton: () => <div>loading</div> }));
