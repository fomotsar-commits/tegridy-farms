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

// Every SOL pool on the venue's pool program whose coin is a room's, read on chain 2026-10-18.
const ROOM_POOLS: [id: string, symbol: string, pool: string][] = [
  ['bayla', 'BAYLA', BAYLA_SOL_POOL],
  ['bobo', 'BOBO', '9mHGFULXNFjcdkZ9fLy24A3pp4iYVk6y889NNcUvSgRV'],
  ['soy', 'SOY', '5M4SZy9Ytu1LGWWjBUwiDZ98bGdpQL4fD3PHETEXPAN8'],
  ['brainlet', 'BRAINLET', 'HaRnur2ETP44bFtjUU4haQcFVYrCDTSaJfjKY3E3bDDD'],
  ['rizz', 'RIZZ', '3yDDaZtABgj7z4BNtPKpfnK4yrx5bvEphDXYGGTnTmfA'],
];

describe('bungalowLpDoor', () => {
  it('BAYLA opens its SOL pool’s Add form, the token and the pool named in the link', () => {
    expect(bungalowLpDoor(room('bayla'))).toEqual({
      to: `/solana-lp?mint=${BAYLA_MINT}&task=add&pool=${BAYLA_SOL_POOL}`,
      label: 'Add SOL + BAYLA',
    });
  });

  it.each(ROOM_POOLS)('%s opens its own SOL pool, and only that one', (id, symbol, pool) => {
    expect(bungalowLpDoor(room(id))).toEqual({
      to: `/solana-lp?mint=${room(id).address}&task=add&pool=${pool}`,
      label: `Add SOL + ${symbol}`,
    });
  });

  it('a pool is named in one room only', () => {
    const named = BUNGALOWS.flatMap((b) => (b.venueSolPool ? [b.venueSolPool] : []));
    expect(named).toHaveLength(ROOM_POOLS.length);
    expect(new Set(named).size).toBe(named.length);
  });

  it.each(['pepe', 'qr', 'toweli'])('%s has no pool on the venue, so no door', (id) => {
    expect(bungalowLpDoor(room(id))).toBeNull();
  });

  it('a Solana room whose pool is not named has no door', () => {
    expect(bungalowLpDoor({ ...room('bobo'), venueSolPool: undefined })).toBeNull();
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

  it.each(ROOM_POOLS)('%s: the door is second, after Trade and before Stake', (id, symbol) => {
    render(<MemoryRouter><BungalowHero bungalow={room(id)} /></MemoryRouter>);
    const names = links();
    const door = names.indexOf(`Add SOL + ${symbol}`);
    expect(door).toBe(1);
    expect(names[0]).toMatch(new RegExp(symbol));
    expect(names.indexOf('The lighthouse') === -1 ? names.findIndex((n) => /^Stake /.test(n ?? '')) : names.indexOf('The lighthouse')).toBe(2);
    expect(screen.getByRole('link', { name: `Add SOL + ${symbol}` }).getAttribute('href')).toBe(bungalowLpDoor(room(id))!.to);
  });

  it('a Solana room with no pool named: no door', () => {
    render(<MemoryRouter><BungalowHero bungalow={{ ...room('bobo'), venueSolPool: undefined }} /></MemoryRouter>);
    expect(screen.queryByRole('link', { name: /^Add SOL/ })).toBeNull();
  });
});
