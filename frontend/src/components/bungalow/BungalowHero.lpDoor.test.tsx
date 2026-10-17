// THE LP DOOR on a room's first screen (island, answer twenty): a Solana room whose coin has a
// SOL pool on the venue gets "Add SOL + <COIN>" second, before Stake, one press from that
// pool's Add form with the token and the pool answered. A room with no pool shows nothing.

import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { BungalowHero } from './BungalowHero';
import { BAYLA_MINT, BUNGALOWS, bungalowLpDoor, type Bungalow, type BungalowIdentity } from '../../lib/bungalows';

const room = (id: string) => BUNGALOWS.find((b) => b.id === id) as Bungalow & { identity: BungalowIdentity };
const BAYLA_SOL_POOL = 'ErvzV1NMZmcfAqZtGH4AQhYAjn77nJEworKK1mYPz5w4';

describe('bungalowLpDoor', () => {
  it('BAYLA opens its SOL pool’s Add form, the token and the pool named in the link', () => {
    expect(bungalowLpDoor(room('bayla'))).toEqual({
      to: `/solana-lp?mint=${BAYLA_MINT}&task=add&pool=${BAYLA_SOL_POOL}`,
      label: 'Add SOL + BAYLA',
    });
  });

  it.each(['bobo', 'soy', 'brainlet', 'rizz', 'pepe', 'qr', 'toweli'])('%s has no pool on the venue, so no door', (id) => {
    expect(bungalowLpDoor(room(id))).toBeNull();
  });

  it('every pool named in the registry is a whole Solana address, never a short one', () => {
    for (const b of BUNGALOWS) {
      if (b.venueSolPool === undefined) continue;
      expect(b.chain, `${b.id} names a SOL pool on a ${b.chain} room`).toBe('solana');
      expect(b.venueSolPool).toMatch(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/);
    }
  });
});

describe('the room’s first screen', () => {
  const links = () => screen.getAllByRole('link').map((l) => l.textContent?.trim());

  it('BAYLA: the door is second, after Trade and before Stake', () => {
    render(<MemoryRouter><BungalowHero bungalow={room('bayla')} /></MemoryRouter>);
    const names = links();
    const door = names.indexOf('Add SOL + BAYLA');
    expect(door).toBe(1);
    expect(names[0]).toMatch(/BAYLA/);
    expect(names.indexOf('The lighthouse') === -1 ? names.findIndex((n) => /^Stake /.test(n ?? '')) : names.indexOf('The lighthouse')).toBe(2);
    expect(screen.getByRole('link', { name: 'Add SOL + BAYLA' }).getAttribute('href')).toBe(bungalowLpDoor(room('bayla'))!.to);
  });

  it('BOBO: no pool on the venue, no door', () => {
    render(<MemoryRouter><BungalowHero bungalow={room('bobo')} /></MemoryRouter>);
    expect(screen.queryByRole('link', { name: /^Add SOL/ })).toBeNull();
  });
});
