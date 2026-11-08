// The countdown (island answer twenty-five, screen 2; twenty-four, build 5): what a wallet under
// the launch floor sees on /launch and on the heat card. A timer, one line, one green button and
// the roster, in the island's words as drawn, in the drawn order. Never "Cannot", no em dash.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { parseHeatReading } from '../../lib/heat/heatOracle';
import { clearScreenMoves, useCurrentScreenMove } from '../../lib/screenMove';
import { setActiveBungalow } from '../../lib/bungalows';

const h = vi.hoisted(() => ({ warming: 28 as number | null, torches: true }));

// The roster is read from the island's board through the torches read; stubbed at the hook.
vi.mock('../../hooks/useIslandTorches', () => ({
  useIslandTorches: () => (h.torches ? { warming: h.warming } : null),
}));

const { Countdown } = await import('./Countdown');

const SOL = '8SxYwQuvV7m8nWz2kQxR1b5H6pD3fLtEaJcGsYhUWQuv';
const NOW = Math.floor(Date.now() / 1000);

function reading(degrees: number, tier: string, extra: Record<string, unknown> = {}) {
  return parseHeatReading({
    address: SOL,
    degrees,
    tier,
    is_cold: degrees === 0,
    held_since_unix: degrees === 0 ? null : NOW - 90 * 86_400,
    as_of_unix: degrees === 0 ? null : NOW - 3600,
    token_count: degrees === 0 ? 0 : 1,
    breakdown: [],
    ...extra,
  });
}

const COLD = reading(0, 'Drifter');

function Move() {
  return <output data-testid="move">{useCurrentScreenMove() ?? 'none'}</output>;
}

function mount(node: React.ReactNode, at = '/launch?c=1') {
  return render(
    <MemoryRouter initialEntries={[at]}>
      {node}
      <Move />
    </MemoryRouter>,
  );
}

const box = () => screen.getByTestId('countdown');
const text = () => box().textContent ?? '';

beforeEach(() => {
  h.warming = 28;
  h.torches = true;
  clearScreenMoves();
});
afterEach(() => clearScreenMoves());

describe('the screen for a cold wallet, as drawn', () => {
  it('says every word in the drawn order, and nothing else', () => {
    mount(<Countdown reading={COLD} look="screen" />);
    const order = [
      'THE LAUNCH DOOR · NOT OPEN YET',
      '0.00°',
      'about half a year',
      'to the door, if you hold from today.',
      '0° today',
      '80° · the door',
      'Residents launch here. Nobody can buy last year.',
      'Start the clock',
      '28 flames are warming toward the door right now.',
    ];
    let at = -1;
    for (const words of order) {
      const next = text().indexOf(words);
      expect(next, `"${words}" is missing or out of the drawn order`).toBeGreaterThan(at);
      at = next;
    }
    expect(text().length, 'a word the drawing does not hold').toBe(order.join('').length);
  });

  it('shows the wallet\'s degrees alone at the right, never a tier word (answer twenty-six, §2.4)', () => {
    mount(<Countdown reading={reading(41.2, 'Observer')} look="screen" />);
    expect(screen.getByText('41.20°').closest('[data-standing]')).not.toBeNull();
    expect(text()).not.toMatch(/Observer|Drifter/);
  });

  it('never says Cannot and carries no em dash, in any state', () => {
    for (const r of [COLD, reading(41.2, 'Observer'), reading(41.2, 'Observer', { days_to_plant: 148 })]) {
      for (const warming of [null, 0, 1, 28]) {
        h.warming = warming;
        const view = mount(<Countdown reading={r} look="screen" />);
        expect(text()).not.toMatch(/\bcannot\b/i);
        expect(text()).not.toContain('—');
        view.unmount();
      }
    }
  });
});

describe('the number', () => {
  it('reads “1 day” at one, in the singular (answer twenty-eight, §2.1)', () => {
    mount(<Countdown reading={reading(79.33, 'Observer', { days_to_plant: 1 })} look="screen" />);
    expect(screen.getByText('1').nextElementSibling?.textContent).toBe('day');
    expect(text()).not.toContain('days');
  });

  it('is the island’s served days, with “days” beside it on one baseline', () => {
    mount(<Countdown reading={reading(41.2, 'Observer', { days_to_plant: 148 })} look="screen" />);
    const number = screen.getByText('148');
    expect(number.nextElementSibling?.textContent).toBe('days');
    expect(number.parentElement?.className).toMatch(/\bitems-baseline\b/);
    expect(text()).toContain('to the door, if you hold from today.');
    expect(text()).not.toContain('about half a year');
  });

  it('is the words “about half a year” until served, for a wallet starting from nothing', () => {
    mount(<Countdown reading={COLD} look="screen" />);
    expect(screen.getByText('about half a year')).toBeInTheDocument();
    expect(text()).toContain('to the door, if you hold from today.');
  });

  it('is left out for a warm wallet the island has served no days for: the venue never works them out', () => {
    mount(<Countdown reading={reading(41.2, 'Observer')} look="screen" />);
    expect(text()).not.toContain('about half a year');
    expect(text()).not.toContain('to the door, if you hold from today.');
    expect(text()).not.toMatch(/\d+\s*days/);
    // The line, the green button and the track still stand.
    expect(text()).toContain('Residents launch here. Nobody can buy last year.');
    expect(screen.getByRole('link', { name: 'Start the clock' })).toBeInTheDocument();
  });
});

describe('the track', () => {
  const marker = () => box().querySelector<HTMLElement>('[data-marker]')!;

  it('puts the marker at the degrees over the floor of the width, and at 0 for a cold wallet', () => {
    const cold = mount(<Countdown reading={COLD} look="screen" />);
    expect(marker().style.getPropertyValue('--at')).toBe('0');
    cold.unmount();
    const warm = mount(<Countdown reading={reading(41.2, 'Observer')} look="screen" />);
    expect(Number(marker().style.getPropertyValue('--at'))).toBeCloseTo(41.2 / 80, 6);
    warm.unmount();
    // Past the door the marker stops at the door's end, never past the track.
    mount(<Countdown reading={reading(120, 'Resident')} look="screen" />);
    expect(marker().style.getPropertyValue('--at')).toBe('1');
  });

  it('never moves on its own', () => {
    mount(<Countdown reading={reading(41.2, 'Observer')} look="screen" />);
    expect(marker().className).not.toMatch(/transition|animate/);
  });

  it('labels 0° today only where the wallet stands at zero, and always the door', () => {
    const cold = mount(<Countdown reading={COLD} look="screen" />);
    expect(screen.getByText('0° today')).toBeInTheDocument();
    expect(screen.getByText('80° · the door')).toBeInTheDocument();
    cold.unmount();
    mount(<Countdown reading={reading(41.2, 'Observer')} look="screen" />);
    expect(screen.queryByText('0° today')).not.toBeInTheDocument();
    expect(screen.getByText('80° · the door')).toBeInTheDocument();
  });
});

describe('the green button', () => {
  it('is the one green button, full width, and opens the Buy sheet over the page it is on', () => {
    mount(<Countdown reading={COLD} look="screen" />, '/launch?c=1');
    const button = screen.getByRole('link', { name: 'Start the clock' });
    expect(button.getAttribute('href')).toBe('/launch?c=1&sheet=buy');
    expect(button.className).toMatch(/\bbtn-primary\b/);
    expect(button.className).toMatch(/\bw-full\b/);
    expect(box().querySelectorAll('.btn-primary')).toHaveLength(1);
  });

  it('says the screen’s move while it is on screen, so Bayla’s line can go quiet', () => {
    const view = mount(<Countdown reading={COLD} look="card" />);
    expect(screen.getByTestId('move').textContent).toBe('start');
    view.rerender(
      <MemoryRouter initialEntries={['/']}>
        <Move />
      </MemoryRouter>,
    );
    expect(screen.getByTestId('move').textContent).toBe('none');
  });
});

describe('the roster', () => {
  it('counts the flames warming toward the door, read from the island', () => {
    h.warming = 25;
    mount(<Countdown reading={COLD} look="screen" />);
    const roster = screen.getByText('25 flames are warming toward the door right now.');
    // Directly under the button.
    expect(roster.previousElementSibling?.textContent).toBe('Start the clock');
  });

  it('is left out when the board was not read, and never says 0', () => {
    for (const unread of [() => (h.torches = false), () => (h.warming = null), () => (h.warming = 0)]) {
      h.torches = true;
      h.warming = 28;
      unread();
      const view = mount(<Countdown reading={COLD} look="screen" />);
      expect(text()).not.toContain('flames are warming');
      view.unmount();
    }
  });

  it('reads in the singular at one, never left out (answer twenty-eight, §2.1)', () => {
    h.warming = 1;
    mount(<Countdown reading={COLD} look="screen" />);
    expect(screen.getByText('1 flame is warming toward the door right now.')).toBeInTheDocument();
    expect(text()).not.toContain('flames are warming');
  });
});

describe('the two looks', () => {
  it('the screen stands on the page’s own ground with the violet glow behind; the card is its own ground', () => {
    const screenLook = mount(<Countdown reading={COLD} look="screen" />);
    expect(box().getAttribute('data-look')).toBe('screen');
    expect(box().querySelector('[data-glow]')).not.toBeNull();
    screenLook.unmount();
    mount(<Countdown reading={COLD} look="card" />);
    expect(box().getAttribute('data-look')).toBe('card');
    expect(box().querySelector('[data-glow]')).toBeNull();
  });
});

describe('the door is not open yet (island answer twenty-six)', () => {
  afterEach(() => {
    setActiveBungalow('venue');
  });

  it('says so in its eyebrow, with the degrees alone at the right', () => {
    mount(<Countdown reading={reading(41.2, 'Observer')} look="screen" />);
    expect(box().querySelector('[data-eyebrow]')?.textContent).toBe('THE LAUNCH DOOR · NOT OPEN YET');
    expect(box().querySelector('[data-standing]')?.textContent).toBe('41.20°');
    expect(text()).not.toMatch(/Observer|Drifter|lane is open/);
  });

  it('on the door its eyebrow is the page heading: /launch has nothing else to be its h1', () => {
    mount(<Countdown reading={COLD} look="screen" />);
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('THE LAUNCH DOOR · NOT OPEN YET');
  });

  it('on a card its eyebrow stays a label, never a second heading on the page it sits on', () => {
    mount(<Countdown reading={COLD} look="card" />);
    expect(screen.queryByRole('heading')).toBeNull();
    expect(box().querySelector('[data-eyebrow]')?.textContent).toBe('THE LAUNCH DOOR · NOT OPEN YET');
  });

  it('at the floor and up: the degrees are the number, warm enough, on the list, and Add in the room', () => {
    setActiveBungalow('bayla');
    mount(<Countdown reading={reading(92.5, 'Resident')} look="screen" />);
    expect(box().dataset.state).toBe('warm');
    const order = [
      'THE LAUNCH DOOR · NOT OPEN YET',
      '92.50°',
      '92.50°',
      "warm enough. The door opens on the island's word.",
      '80° · the door',
      'You are on the list the day it opens.',
      'Add BAYLA',
      '28 flames are warming toward the door right now.',
    ];
    let at = -1;
    for (const words of order) {
      const next = text().indexOf(words, at + 1);
      expect(next, `"${words}" is missing or out of order`).toBeGreaterThan(at);
      at = next;
    }
    expect(text().length, 'a word the island did not give').toBe(order.join('').length);
    expect(screen.getByRole('link', { name: 'Add BAYLA' }).getAttribute('href')).toBe('/launch?c=1&sheet=add');
  });

  it('outside a room the warm move is picking one, in the Add sheet', () => {
    mount(<Countdown reading={reading(92.5, 'Resident')} look="screen" />);
    expect(screen.getByRole('link', { name: 'Pick a bungalow' }).getAttribute('href')).toBe('/launch?c=1&sheet=add');
  });

  it('for a visitor with nothing read: the standing start, no degrees and no today', () => {
    mount(<Countdown reading={null} look="screen" />);
    expect(box().dataset.state).toBe('unread');
    expect(box().querySelector('[data-standing]')).toBeNull();
    expect(text()).toContain('about half a year');
    expect(text()).toContain('to the door, if you hold from today.');
    expect(text()).not.toContain('0° today');
    expect(screen.getByRole('link', { name: 'Start the clock' })).toBeTruthy();
  });

  it('on the launch door its move quiets her line whatever it says; in a heat card only her own move does', () => {
    const first = mount(<Countdown reading={reading(92.5, 'Resident')} look="screen" />);
    expect(screen.getByTestId('move').textContent).toBe('door');
    first.unmount();
    mount(<Countdown reading={reading(92.5, 'Resident')} look="card" />);
    expect(screen.getByTestId('move').textContent).toBe('none');
  });
});
