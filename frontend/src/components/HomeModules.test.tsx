// THE HOME'S CARDS (owner, 2026-10-16: "put the bayla staking module and the lp pool module
// here on the homepage ... so people can right away do these things", then "move the lp module
// beside the staking one ... the swap is missing ... staking module needs to be shorter").
// Pinned here:
//   1. One row: the swap form, BAYLA's stake card (short) and its SOL pool's LP card, in that
//      order, so stake and LP sit side by side; each is the form its own page mounts.
//   2. All inside ONE SolanaProviders, so a wallet connected in one is connected in the others.
//   3. The LP card only once the venue reads open, as on /pools; the swap only where the
//      swap is live, as on /solana.
//   4. The LP card carries the Pools network drop-down (owner, 2026-10-17: "swap and add
//      liquidity missing chain drop down"), lit on Solana; another network leaves for its tab.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import type { ReactNode } from 'react';
import type { VenueStatus } from '../lib/solana/cpswap/read';
import type { LpReaders } from './solana/lp/readers';
import { BUNGALOWS } from '../lib/bungalows';

const venue = vi.hoisted(() => ({ status: null as VenueStatus | null }));
// The ladder's address comes from the build's env (VITE_BAYLA_LADDER_POOL), empty under test.
const LADDER = vi.hoisted(() => 'LadderPoo1111111111111111111111111111111111');
const ladderOn = vi.hoisted(() => ({ value: true }));
const swapLive = vi.hoisted(() => ({ value: true }));
// The room's own SOL pool, which is what puts an LP card on the home at all.
const lpOn = vi.hoisted(() => ({ value: true }));
vi.mock('../lib/bungalows', async (orig) => {
  const m = await orig<typeof import('../lib/bungalows')>();
  return {
    ...m,
    get BUNGALOWS() {
      return m.BUNGALOWS.map((b) => (b.id === 'bayla'
        ? { ...b, ...(ladderOn.value ? { ladderPool: LADDER } : {}), ...(lpOn.value ? {} : { venueSolPool: undefined }) }
        : b));
    },
  };
});
vi.mock('../lib/solana', async (orig) => ({ ...(await orig<typeof import('../lib/solana')>()), isSolanaSwapLive: () => swapLive.value }));
vi.mock('wagmi', () => ({
  useAccount: () => ({ isConnected: false }),
  useChainId: () => 1,
  useSwitchChain: () => ({ switchChain: vi.fn() }),
}));
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

function Where() {
  const { pathname, search } = useLocation();
  return <output data-testid="where">{pathname + search}</output>;
}

function mount() {
  return render(
    <MemoryRouter initialEntries={['/']}>
      <HomeModules readers={readers} />
      <Where />
    </MemoryRouter>,
  );
}

const bayla = BUNGALOWS.find((b) => b.id === 'bayla')!;
const readers = { programId: 'x' } as unknown as LpReaders;

beforeEach(() => {
  venue.status = { kind: 'live' } as VenueStatus;
  ladderOn.value = true;
  lpOn.value = true;
  swapLive.value = true;
});

describe('the home cards', () => {
  it('lays out swap, the short stake card and the LP card in one row, inside ONE wallet provider', async () => {
    mount();
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

  it('gives the LP card the Pools network drop-down, on Solana; Base leaves for Base’s add / remove', () => {
    mount();
    const card = screen.getByTestId('home-lp');
    fireEvent.click(within(card).getByRole('button', { name: 'Pools network: Solana' }));
    expect(within(card).getByRole('option', { name: /Solana/ })).toHaveAttribute('aria-selected', 'true');
    fireEvent.click(within(card).getByRole('option', { name: /Base/ }));
    expect(screen.getByTestId('where')).toHaveTextContent(/^\/liquidity\?c=8453$/);
  });

  it.each<[string, VenueStatus | null]>([
    ['still reading', null],
    ['unreadable', { kind: 'unreadable', detail: 'the RPC proxy did not answer' } as VenueStatus],
  ])('keeps the LP card in its place while the venue is %s, with no form to deposit through', (_, status) => {
    // Owner, 2026-10-21: "idk why you keep taking them out put them back". A slow or failed read
    // took the card off the home; it now holds its place and says why there is no form.
    venue.status = status;
    mount();
    const row = screen.getByTestId('home-modules');
    expect([...row.children].map((c) => c.getAttribute('data-testid'))).toEqual(['home-swap', 'home-stake', 'home-lp']);
    expect(within(screen.getByTestId('home-lp')).getByRole('heading', { name: 'Add SOL + BAYLA' })).toBeInTheDocument();
    // The form is the only thing that can start a deposit: it still waits for the venue read.
    expect(screen.queryByTestId('lp-inner')).toBeNull();
    expect(screen.getByTestId('home-lp')).toHaveTextContent(status ? /could not be read just now/ : /Reading the pool/);
    expect(within(screen.getByTestId('home-lp')).queryByRole('button', { name: 'Try again' }) !== null).toBe(status !== null);
    // The stake card does not wait on the venue: it reads its own program.
    expect(screen.getByTestId('ladder-card')).toBeInTheDocument();
  });

  it('draws no swap card where the swap is not live', () => {
    swapLive.value = false;
    mount();
    expect(screen.queryByTestId('home-swap')).toBeNull();
    expect(screen.getByTestId('ladder-card')).toBeInTheDocument();
  });

  // It is the top bar's Solana connection on the home (hasMixedSolanaSection): the top bar
  // mounts none of its own there, so this one is mounted with no card to draw too.
  it('mounts its Solana connection with no card to draw, and draws no empty box', () => {
    ladderOn.value = false;
    swapLive.value = false;
    lpOn.value = false;
    venue.status = null;
    mount();
    expect(screen.getByTestId('solana-providers')).toHaveAttribute('data-mixed', 'true');
    expect(screen.queryByTestId('home-modules')).toBeNull();
  });
});
