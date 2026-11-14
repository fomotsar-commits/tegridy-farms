// "Priced in X" on /pools (spec 2026-11-14, community quote coins, phase 1): a coin's community
// shares /pools?mint=<the coin's whole address>, and when that coin is a pairing coin the list
// under the finder is every pool here priced in it, the oldest first. The default /pools is
// left exactly as it was.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, within, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { PublicKey } from '@solana/web3.js';
import { BAYLA_QUOTE, SOL_QUOTE, USDC_QUOTE, type QuoteCoin } from '../../../lib/solana/lp/quotes';
import { LpInner } from './SolanaLpSection';
import type { LpReaders } from './readers';
import type { TokenSafety } from '../../../lib/solana/lp/tokenSafety';
import { BAYLA_MINT, BOBO_MINT, USDC_MINT, WSOL_MINT } from '../../../lib/solana/lp/tokenSafety';
import { setPriceSide } from './priceSide';
import type { PoolListRead } from '../../../lib/solana/lp/poolList';
import type { PoolSearchRead, PoolView } from '../../../lib/solana/lp/poolFinder';
import { buildPool, key, viewOf } from '../../../lib/solana/lp/testkit.fixture';

const wallet = vi.hoisted(() => ({ publicKey: null as null | { toBase58(): string } }));
vi.mock('@solana/wallet-adapter-react', () => ({ useWallet: () => wallet, useConnection: () => ({ connection: { rpcEndpoint: 'fake' } }) }));
vi.mock('../SolanaConnectButton', () => ({ SolanaConnectButton: () => <button type="button">Connect Solana Wallet</button> }));

/** A pool of `mint` priced in `quote`, opened at `openTime`, holding `q` of the quote coin and 1,000 tokens. */
function pool(mint: PublicKey | string, quote: QuoteCoin, openTime: bigint, q = 10n * 10n ** BigInt(quote.decimals)): PoolView {
  const m = typeof mint === 'string' ? new PublicKey(mint) : mint;
  const tok = 1_000n * 10n ** 6n;
  return viewOf(buildPool({ plain: true, mint: m, quote, configIndex: 1, quoteReserve: q, tokenReserve: tok, openTime }), { sol: q, tok });
}

const okToken = (mint: string, symbol: string): TokenSafety => ({
  kind: 'read', mint, verdict: 'ok', blocks: [], warnings: [], name: symbol, symbol, metadataSource: 'metaplex',
  facts: { program: 'spl-token', mintAuthority: null, freezeAuthority: null, supply: 1n, decimals: 6, isInitialized: true, extensions: [], metadataPointer: null, tokenMetadata: null },
});

const ok = (pools: PoolView[], safety: TokenSafety[] = [], o: { truncated?: boolean } = {}): PoolListRead => ({
  kind: 'ok',
  list: { pools, unread: 0, truncated: o.truncated ?? false, chainNow: null, safety: new Map(safety.map((s) => [s.mint, s])) },
});

const none = (mint: string): PoolSearchRead => ({
  kind: 'ok',
  search: { mint, known: { launchPool: key().toBase58(), standard: [] }, index: { kind: 'ok', pools: [], truncated: false }, pools: [], otherPairs: 0, launchTierPools: [], knownState: {}, chainNow: 1_000n },
});

function readers(list: PoolListRead, o: Partial<LpReaders> = {}): LpReaders {
  return {
    programId: 'EKS4C6xvV9A5DMWaWtVnFvi7ru78EhqRAoddEMpQ2BtT',
    safety: vi.fn(async (mints: string[]) => new Map(mints.map((m) => [m, okToken(m, 'CORN')]))),
    findPools: vi.fn(async (mint: PublicKey) => none(mint.toBase58())),
    listPools: vi.fn(async () => list),
    outsidePrice: vi.fn(async () => ({ kind: 'ok' as const, solPerToken: 0.01, source: 'Jupiter' as const })),
    positions: vi.fn(async () => ({ kind: 'ok' as const, positions: [], chainNow: 1n, totalShares: 0 })),
    feeTiers: vi.fn(async () => ({ kind: 'ok' as const, openingDeposits: null, tiers: [] })),
    wallet: vi.fn(async () => { throw new Error('not stubbed'); }),
    placeShareOnChain: vi.fn(async () => { throw new Error('not stubbed'); }),
    ...o,
  };
}

const mount = (r: LpReaders, at: string) => render(<MemoryRouter initialEntries={[at]}><LpInner readers={r} writes={{ mode: 'off' }} /></MemoryRouter>);
const list = () => screen.getByTestId('lp-all-pools');

// Three pools priced in BAYLA, opened in the order OLD, MID, NEW; NEW holds the most, so a list by money would lead with it.
const OLD = key();
const MID = key();
const NEW = key();
const STRANGER = key();
const oldInBayla = pool(OLD, BAYLA_QUOTE, 1_000n, 5n * 10n ** 6n);
const midInBayla = pool(MID, BAYLA_QUOTE, 2_000n, 50n * 10n ** 6n);
const newInBayla = pool(NEW, BAYLA_QUOTE, 3_000n, 5_000n * 10n ** 6n);
// BOBO ranks below BAYLA: BOBO's pool with BAYLA is BOBO priced in BAYLA, and listed.
const boboInBayla = pool(BOBO_MINT, BAYLA_QUOTE, 1_500n);
const SAFETY = [okToken(OLD.toBase58(), 'OLDIE'), okToken(MID.toBase58(), 'MIDDY'), okToken(NEW.toBase58(), 'NEWBY'), okToken(STRANGER.toBase58(), 'CORN')];

/** Seven pools, in the order the list read them: four priced in BAYLA, and three that are not (BAYLA's own two, priced in SOL and USDC, and an outside token's SOL pool). */
function venue(): PoolView[] {
  return [
    pool(BAYLA_MINT, SOL_QUOTE, 500n),
    newInBayla,
    pool(STRANGER, SOL_QUOTE, 100n),
    midInBayla,
    pool(BAYLA_MINT, USDC_QUOTE, 200n),
    oldInBayla,
    boboInBayla,
  ];
}

beforeEach(() => { wallet.publicKey = null; setPriceSide('token'); });

describe('Priced in X: /pools?mint=<a pairing coin>', () => {
  it('lists only the pools priced in BAYLA, the oldest first, whatever Jupiter says they hold', async () => {
    const marketPrices = vi.fn(async () => ({ [WSOL_MINT]: 100, [BAYLA_MINT]: 3, [USDC_MINT]: 1, [OLD.toBase58()]: 1, [MID.toBase58()]: 1, [NEW.toBase58()]: 1, [BOBO_MINT]: 1 }));
    mount(readers(ok(venue(), SAFETY), { marketPrices }), `/pools?mint=${BAYLA_MINT}`);
    expect(await within(list()).findByRole('heading', { name: 'Priced in BAYLA' })).toBeInTheDocument();
    await waitFor(() => expect(within(list()).getAllByTestId('lp-all-pools-worth').length).toBeGreaterThan(0));
    const rows = within(list()).getAllByTestId('lp-all-pools-row');
    expect(rows.map((r) => r.querySelector('p')!.textContent)).toEqual(['OLDIE / BAYLA · 1% tier', 'BOBO / BAYLA · 1% tier', 'MIDDY / BAYLA · 1% tier', 'NEWBY / BAYLA · 1% tier']);
    expect(within(list()).getByRole('list', { name: 'Priced in BAYLA: the oldest pool first' })).toBeInTheDocument();
    // Not "All pools", and none of BAYLA's own pools, which are priced in SOL and USDC.
    expect(within(list()).queryByRole('heading', { name: 'All pools' })).toBeNull();
    expect(list()).not.toHaveTextContent('BAYLA / SOL');
    expect(list()).not.toHaveTextContent('BAYLA / USDC');
    expect(list()).not.toHaveTextContent('CORN');
  });

  it('heads the list with the coin: its ticker, which copies its address, and its WHOLE address', async () => {
    mount(readers(ok(venue(), SAFETY)), `/pools?mint=${BAYLA_MINT}`);
    const head = await within(list()).findByTestId('lp-priced-in-coin');
    expect(within(head).getByRole('button', { name: `BAYLA: copy its address ${BAYLA_MINT}` })).toBeInTheDocument();
    expect(within(head).getByText(BAYLA_MINT)).toBeInTheDocument();
    // An island coin adds no risk: no warning is drawn.
    expect(head).not.toHaveTextContent('freeze');
  });

  it('says the coin’s risk line under its address when it has one (USDC)', async () => {
    mount(readers(ok([pool(OLD, USDC_QUOTE, 10n), pool(BAYLA_MINT, USDC_QUOTE, 20n)], SAFETY)), `/pools?mint=${USDC_MINT}`);
    const head = await within(list()).findByTestId('lp-priced-in-coin');
    expect(within(list()).getByRole('heading', { name: 'Priced in USDC' })).toBeInTheDocument();
    expect(within(head).getByText(USDC_MINT)).toBeInTheDocument();
    expect(head).toHaveTextContent(USDC_QUOTE.risk!);
    expect(within(list()).getAllByTestId('lp-all-pools-row').map((r) => r.querySelector('p')!.textContent)).toEqual(['OLDIE / USDC · 1% tier', 'BAYLA / USDC · 1% tier']);
  });

  it('a row’s Swap opens the swap page paying in the coin for the row’s token', async () => {
    mount(readers(ok(venue(), SAFETY)), `/pools?mint=${BAYLA_MINT}`);
    const [first] = await within(list()).findAllByTestId('lp-all-pools-row');
    expect(within(first!).getByTestId('lp-all-pools-swap')).toHaveAttribute('href', `/solana?in=${BAYLA_MINT}&out=${OLD.toBase58()}`);
    const bobo = within(list()).getAllByTestId('lp-all-pools-row')[1]!;
    expect(within(bobo).getByTestId('lp-all-pools-swap')).toHaveAttribute('href', `/solana?in=${BAYLA_MINT}&out=${BOBO_MINT}`);
  });

  it('each row says how its LPs and the venue earn, at that pool’s own rates', async () => {
    mount(readers(ok(venue(), SAFETY)), `/pools?mint=${BAYLA_MINT}`);
    const rows = await within(list()).findAllByTestId('lp-all-pools-row');
    for (const row of rows) expect(within(row).getByTestId('lp-all-pools-earn')).toHaveTextContent(/^LPs keep \d+\.\d{3}% of each trade, the venue \d+\.\d{3}%\.$/);
    // A pool whose fee settings were not read says so; it never goes quiet about who earns.
    mount(readers(ok([{ ...oldInBayla, config: null }], SAFETY)), `/pools?mint=${BAYLA_MINT}`);
    const lists = await screen.findAllByTestId('lp-all-pools');
    expect(await within(lists[1]!).findByTestId('lp-all-pools-earn')).toHaveTextContent('This pool’s fee settings could not be read.');
  });

  it('with no pool priced in the coin, says so, and not that the venue has none', async () => {
    mount(readers(ok([pool(STRANGER, SOL_QUOTE, 1n), pool(BAYLA_MINT, USDC_QUOTE, 2n)], SAFETY)), `/pools?mint=${BOBO_MINT}`);
    expect(await within(list()).findByTestId('lp-priced-in-none')).toHaveTextContent(/^No pool is priced in BOBO yet\.$/);
    expect(within(list()).queryByTestId('lp-all-pools-none')).toBeNull();
    expect(within(list()).queryAllByTestId('lp-all-pools-row')).toHaveLength(0);
  });

  it('a list cut short never says there is none: it says there are more', async () => {
    mount(readers(ok([pool(STRANGER, SOL_QUOTE, 1n)], SAFETY, { truncated: true })), `/pools?mint=${BAYLA_MINT}`);
    expect(await within(list()).findByTestId('lp-all-pools-truncated')).toBeInTheDocument();
    expect(within(list()).queryByTestId('lp-priced-in-none')).toBeNull();
  });

  it('Every pool goes back to the full list, with no token in the address', async () => {
    mount(readers(ok(venue(), SAFETY)), `/pools?mint=${BAYLA_MINT}`);
    const every = await within(list()).findByRole('link', { name: 'Every pool' });
    expect(every).toHaveAttribute('href', '/pools');
    fireEvent.click(every);
    expect(await within(list()).findByRole('heading', { name: 'All pools' })).toBeInTheDocument();
    expect(within(list()).getAllByTestId('lp-all-pools-row')).toHaveLength(7);
    expect(within(list()).queryByTestId('lp-priced-in-coin')).toBeNull();
  });
});

describe('the default view is unchanged', () => {
  for (const [name, at] of [
    ['/pools', '/pools'],
    ['an outside token’s link', `/pools?mint=${STRANGER.toBase58()}`],
  ] as const) {
    it(`${name}: All pools, every pool, no "Priced in", no Every pool link, no earn line on a row`, async () => {
      mount(readers(ok(venue(), SAFETY)), at);
      expect(await within(list()).findByRole('heading', { name: 'All pools' })).toBeInTheDocument();
      const rows = await within(list()).findAllByTestId('lp-all-pools-row');
      expect(rows).toHaveLength(7);
      expect(list()).not.toHaveTextContent('Priced in');
      expect(within(list()).queryByRole('link', { name: 'Every pool' })).toBeNull();
      expect(within(list()).queryByTestId('lp-priced-in-coin')).toBeNull();
      expect(within(list()).queryAllByTestId('lp-all-pools-earn')).toHaveLength(0);
      // The order read (SOL's pools, then USDC's, then BAYLA's), as before.
      expect(within(list()).getByRole('list', { name: /^All pools: SOL pools first/ })).toBeInTheDocument();
    });
  }
});
