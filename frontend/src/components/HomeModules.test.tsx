// THE HOME'S CARDS (owner, 2026-10-16: "put the bayla staking module and the lp pool module
// here on the homepage ... so people can right away do these things", then "move the lp module
// beside the staking one ... the swap is missing ... staking module needs to be shorter").
// Pinned here:
//   1. One row: the swap form, BAYLA's stake card (short) and its SOL pool's LP card, in that
//      order, so stake and LP sit side by side; each is the form its own page mounts.
//   2. All inside ONE SolanaProviders, so a wallet connected in one is connected in the others.
//   3. The LP card only once the venue reads open, as on /solana-lp; the swap only where the
//      swap is live, as on /solana.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import type { VenueStatus } from '../lib/solana/cpswap/read';
import type { LpReaders } from './solana/lp/readers';
import { BUNGALOWS } from '../lib/bungalows';

const venue = vi.hoisted(() => ({ status: null as VenueStatus | null }));
// The ladder's address comes from the build's env (VITE_BAYLA_LADDER_POOL), empty under test.
const LADDER = vi.hoisted(() => 'LadderPoo1111111111111111111111111111111111');
const ladderOn = vi.hoisted(() => ({ value: true }));
const swapLive = vi.hoisted(() => ({ value: true }));
vi.mock('../lib/bungalows', async (orig) => {
  const m = await orig<typeof import('../lib/bungalows')>();
  const withLadder = m.BUNGALOWS.map((b) => (b.id === 'bayla' ? { ...b, ladderPool: LADDER } : b));
  return { ...m, get BUNGALOWS() { return ladderOn.value ? withLadder : m.BUNGALOWS; } };
});
vi.mock('../lib/solana', async (orig) => ({ ...(await orig<typeof import('../lib/solana')>()), isSolanaSwapLive: () => swapLive.value }));
vi.mock('../hooks/useVenueStatus', () => ({ useVenueStatus: () => ({ status: venue.status, refresh: () => {}, retry: () => {} }) }));
vi.mock('./solana/SolanaProviders', () => ({
  SolanaProviders: ({ children, mixed }: { children: ReactNode; mixed?: boolean }) => (
    <div data-testid="solana-providers" data-mixed={String(Boolean(mixed))}>{children}</div>
  ),
}));
vi.mock('../pages/SolanaSwapPage', () => ({
  SolanaSwapInner: ({ home }: { home?: boolean }) => <div data-testid="swap-form" data-home={String(Boolean(home))} />,
}));
vi.mock('./bungalow/SolanaLadderPoolLive', () => ({
  SolanaLadderPoolCard: ({ bungalow, compact }: { bungalow: { id: string; ladderPool: string }; compact?: boolean }) => (
    <div data-testid="ladder-card" data-room={bungalow.id} data-pool={bungalow.ladderPool} data-compact={String(Boolean(compact))} />
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
  ladderOn.value = true;
  swapLive.value = true;
});

describe('the home cards', () => {
  it('lays out swap, the short stake card and the LP card in one row, inside ONE wallet provider', async () => {
    render(<HomeModules readers={readers} />);
    const providers = screen.getAllByTestId('solana-providers');
    expect(providers).toHaveLength(1);
    // The home connects Ethereum too: the top bar keeps its sheet (lib/solanaSurface.ts `mixed`).
    expect(providers[0]).toHaveAttribute('data-mixed', 'true');
    const row = screen.getByTestId('home-modules');
    expect(providers[0]).toContainElement(row);
    // In that order: stake and LP side by side.
    expect([...row.children].map((c) => c.getAttribute('data-testid'))).toEqual(['home-swap', 'home-stake', 'home-lp']);

    expect(await within(screen.getByTestId('home-swap')).findByTestId('swap-form')).toHaveAttribute('data-home', 'true');
    const ladder = within(screen.getByTestId('home-stake')).getByTestId('ladder-card');
    expect(ladder).toHaveAttribute('data-pool', LADDER);
    expect(ladder).toHaveAttribute('data-compact', 'true');
    // Her closed pool's members keep their claim strip, as on /earn/bayla.
    expect(within(screen.getByTestId('home-stake')).getByTestId('claim-strip')).toHaveAttribute('data-pool', bayla.stakePool);
    const lp = within(screen.getByTestId('home-lp')).getByTestId('lp-inner');
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

  it('draws no swap card where the swap is not live', () => {
    swapLive.value = false;
    render(<HomeModules readers={readers} />);
    expect(screen.queryByTestId('home-swap')).toBeNull();
    expect(screen.getByTestId('ladder-card')).toBeInTheDocument();
  });

  // It is the top bar's Solana connection on the home (hasMixedSolanaSection): the top bar
  // mounts none of its own there, so this one is mounted with no card to draw too.
  it('mounts its Solana connection with no card to draw, and draws no empty box', () => {
    ladderOn.value = false;
    swapLive.value = false;
    venue.status = null;
    render(<HomeModules readers={readers} />);
    expect(screen.getByTestId('solana-providers')).toHaveAttribute('data-mixed', 'true');
    expect(screen.queryByTestId('home-modules')).toBeNull();
  });
});
