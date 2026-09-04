/**
 * SectionHost — one nav section rendered as one page with tabs.
 *
 * The four collapsed sections (Launch / Earn / Stats / Trust & Safety) all go
 * through this component, so the properties below are the ones that decide
 * whether the 2026-09-04 dropdown condensation is safe:
 *
 *   · every destination in the section is still reachable — from the tab strip
 *     if not from the menu;
 *   · the tab the URL names is the tab that lights, and the page that renders;
 *   · a gated entry keeps its SOON pill, because collapsing a menu must not
 *     silently un-disclose four flag-gated surfaces.
 *
 * The `/launch` vs `/launch-simulator` case is not a hypothetical: a
 * `pathname.startsWith(to)` match — the obvious implementation, and the one the
 * three older hosts use against their own hand-written path lists — picks
 * `/launch` for BOTH, so the Simulator would render the Doppler wizard under a
 * highlighted "Launchpad" tab.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
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
  it('renders one tab per section entry, so nothing the menu stopped listing is lost', () => {
    at('/launch');
    expect(screen.getAllByRole('tab').map((t) => t.textContent)).toEqual([
      'Launchpad',
      'Solana CurveSoon',
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

  it('keeps a collapsed entry’s SOON pill on its tab', () => {
    at('/launch');
    const solana = screen.getAllByRole('tab').find((t) => t.textContent?.startsWith('Solana Curve'));
    expect(solana, 'the gated entry has no tab').toBeTruthy();
    // The pill is the answer to "can I do the thing this label names". Losing it
    // in the collapse would advertise an undeployed Solana program as live.
    expect(solana).toHaveTextContent('Soon');
    expect(screen.getAllByRole('tab').find((t) => t.textContent?.startsWith('Launchpad'))).not.toHaveTextContent(
      'Soon',
    );
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

describe('SectionHost — top clearance', () => {
  // The strip is `position: fixed` under the 56px header, so a page that does not
  // already pull itself up under the header needs padding or its own heading
  // renders behind the tabs. `fullBleed` opts a page out of that.
  it('pads a normal page and leaves a full-bleed one alone', async () => {
    const { container, unmount } = render(
      <MemoryRouter initialEntries={['/launch']}>
        <SectionHost section={SECTION} idPrefix="launch" ariaLabel="Launch sections" panels={PANELS} />
      </MemoryRouter>,
    );
    await screen.findByText('launchpad panel');
    expect(container.querySelector('#launch-panel > .pt-14')).toBeTruthy();
    unmount();

    render(
      <MemoryRouter initialEntries={['/launch']}>
        <SectionHost
          section={SECTION}
          idPrefix="launch"
          ariaLabel="Launch sections"
          panels={PANELS}
          fullBleed={['/launch']}
        />
      </MemoryRouter>,
    );
    await screen.findByText('launchpad panel');
    expect(document.querySelector('#launch-panel > .pt-14')).toBeFalsy();
  });
});

// Suppress the lazy/Suspense act() noise the three older hosts also produce.
vi.mock('../components/PageSkeleton', () => ({ PageSkeleton: () => <div>loading</div> }));
