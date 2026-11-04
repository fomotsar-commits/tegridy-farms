// Island answer twenty-six: /launch is the launch door, the countdown for every wallet, warm ones
// too, and for a visitor with nothing read. No tab strip, no chain menu, no form, no LIVE.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { parseHeatReading } from '../lib/heat/heatOracle';
import { setLastReading } from '../lib/heat/heatStore';
import { LAUNCH_DOOR_OPEN } from '../lib/launcher/door';

vi.mock('../hooks/useIslandTorches', () => ({ useIslandTorches: () => ({ warming: 28 }) }));
vi.mock('../lib/analytics', () => ({ trackPageView: () => {} }));

const { default: LaunchDoorPage } = await import('./LaunchDoorPage');

const ADDR = '0x1111111111111111111111111111111111111111';
function reading(degrees: number, tier: string) {
  const r = parseHeatReading({
    address: ADDR,
    degrees,
    tier,
    is_cold: degrees === 0,
    held_since_unix: degrees === 0 ? null : 1_700_000_000,
    as_of_unix: 1_762_000_000,
    token_count: degrees === 0 ? 0 : 2,
    breakdown: [],
  });
  if (!r) throw new Error('fixture did not parse');
  return r;
}

function mount() {
  return render(
    <MemoryRouter initialEntries={['/launch']}>
      <LaunchDoorPage />
    </MemoryRouter>,
  );
}

/** Nothing on the door may offer a launch, name a rail as live, or print the word Drifter. */
function expectNoLaunch(container: HTMLElement) {
  expect(screen.queryByRole('tablist')).toBeNull();
  expect(screen.queryByRole('button', { name: /Launch network/ })).toBeNull();
  expect(container.textContent).not.toMatch(/Launchpad|Memetics Curve|Launch a token|Token name|Can launch|lane is open|Drifter|\bSoon\b/);
  expect(container.textContent).not.toMatch(/\bLIVE\b/i);
}

afterEach(() => setLastReading(null));

describe('/launch is the launch door (island answer twenty-six)', () => {
  it('is committed closed', () => {
    expect(LAUNCH_DOOR_OPEN).toBe(false);
  });

  it('a fresh phone: the countdown from a standing start, and nothing to launch with', () => {
    const { container } = mount();
    const countdown = screen.getByTestId('countdown');
    expect(countdown.dataset.state).toBe('unread');
    expect(countdown.dataset.look).toBe('screen');
    expect(countdown.textContent).toContain('THE LAUNCH DOOR · NOT OPEN YET');
    expect(countdown.textContent).toContain('about half a year');
    expect(screen.getByRole('link', { name: 'Start the clock' })).toBeTruthy();
    expectNoLaunch(container);
  });

  it('a cold wallet: its own zero, the half year, Start the clock', () => {
    setLastReading(reading(0, 'Drifter'));
    const { container } = mount();
    const countdown = screen.getByTestId('countdown');
    expect(countdown.dataset.state).toBe('under');
    expect(countdown.querySelector('[data-standing]')?.textContent).toBe('0.00°');
    expect(countdown.textContent).toContain('0° today');
    expectNoLaunch(container);
  });

  it('a warm wallet at 80 and up: warm enough, on the list, and no form', () => {
    setLastReading(reading(92.5, 'Resident'));
    const { container } = mount();
    const countdown = screen.getByTestId('countdown');
    expect(countdown.dataset.state).toBe('warm');
    expect(countdown.textContent).toContain("warm enough. The door opens on the island's word.");
    expect(countdown.textContent).toContain('You are on the list the day it opens.');
    expect(screen.getByRole('link', { name: 'Pick a bungalow' })).toBeTruthy();
    expectNoLaunch(container);
  });
});
