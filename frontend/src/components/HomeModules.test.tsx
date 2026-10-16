// THE HOME'S TWO CARDS (owner, 2026-10-16: "put the bayla staking module and the lp pool module
// here on the homepage ... so people can right away do these things"). Pinned here:
//   1. BAYLA's stake card and its SOL pool's LP card, the very cards /earn/bayla and /solana-lp mount.
//   2. Both inside ONE SolanaProviders, so a wallet connected in one is connected in the other.
//   3. The LP card only once the venue reads open, as on /solana-lp; any other read draws no LP card.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import type { VenueStatus } from '../lib/solana/cpswap/read';
import type { LpReaders } from './solana/lp/readers';
import { BUNGALOWS } from '../lib/bungalows';

const venue = vi.hoisted(() => ({ status: null as VenueStatus | null }));
// The ladder's address comes from the build's env (VITE_BAYLA_LADDER_POOL), empty under test.
const LADDER = vi.hoisted(() => 'LadderPoo1111111111111111111111111111111111');
vi.mock('../lib/bungalows', async (orig) => {
  const m = await orig<typeof import('../lib/bungalows')>();
  return { ...m, BUNGALOWS: m.BUNGALOWS.map((b) => (b.id === 'bayla' ? { ...b, ladderPool: LADDER } : b)) };
});
vi.mock('../hooks/useVenueStatus', () => ({ useVenueStatus: () => ({ status: venue.status, refresh: () => {}, retry: () => {} }) }));
vi.mock('./solana/SolanaProviders', () => ({
  SolanaProviders: ({ children }: { children: ReactNode }) => <div data-testid="solana-providers">{children}</div>,
}));
vi.mock('./bungalow/SolanaLadderPoolLive', () => ({
  SolanaLadderPoolCard: ({ bungalow }: { bungalow: { id: string; ladderPool: string } }) => (
    <div data-testid="ladder-card" data-room={bungalow.id} data-pool={bungalow.ladderPool} />
  ),
}));
vi.mock('./bungalow/LighthousePoolLive', () => ({
  LighthouseClaimStrip: ({ bungalow }: { bungalow: { stakePool: string } }) => <div data-testid="claim-strip" data-pool={bungalow.stakePool} />,
}));
vi.mock('./solana/lp/SolanaLpSection', () => ({
  LpInner: ({ home }: { home: { mint: string; pool: string } }) => <div data-testid="lp-inner" data-mint={home.mint} data-pool={home.pool} />,
}));

import HomeModules from './HomeModules';

const bayla = BUNGALOWS.find((b) => b.id === 'bayla')!;
const readers = { programId: 'x' } as unknown as LpReaders;

beforeEach(() => {
  venue.status = { kind: 'live' } as VenueStatus;
});

describe('the home cards', () => {
  it('offers BAYLA’s stake card and the LP card on its SOL pool, inside ONE wallet provider', () => {
    render(<HomeModules readers={readers} />);
    const providers = screen.getAllByTestId('solana-providers');
    expect(providers).toHaveLength(1);
    expect(providers[0]).toContainElement(screen.getByTestId('ladder-card'));
    expect(screen.getByTestId('ladder-card')).toHaveAttribute('data-pool', LADDER);
    // Her closed pool's members keep their claim strip, as on /earn/bayla.
    expect(providers[0]).toContainElement(screen.getByTestId('claim-strip'));
    expect(screen.getByTestId('claim-strip')).toHaveAttribute('data-pool', bayla.stakePool);
    const lp = screen.getByTestId('lp-inner');
    expect(providers[0]).toContainElement(lp);
    expect(lp).toHaveAttribute('data-mint', bayla.address);
    expect(lp).toHaveAttribute('data-pool', bayla.venueSolPool);
    expect(screen.getByRole('heading', { level: 2, name: 'Add SOL + BAYLA' })).toBeInTheDocument();
  });

  it.each<[string, VenueStatus | null]>([
    ['still reading', null],
    ['unreadable', { kind: 'unreadable', detail: 'the RPC proxy did not answer' } as VenueStatus],
  ])('draws no LP card while the venue is %s', (_, status) => {
    venue.status = status;
    render(<HomeModules readers={readers} />);
    expect(screen.queryByTestId('lp-inner')).toBeNull();
    expect(screen.queryByRole('heading', { name: 'Add SOL + BAYLA' })).toBeNull();
    // The stake card does not wait on the venue: it reads its own program.
    expect(screen.getByTestId('ladder-card')).toBeInTheDocument();
  });
});
