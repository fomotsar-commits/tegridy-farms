import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, within, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { PublicKey } from '@solana/web3.js';
import { LpInner } from './SolanaLpSection';
import type { LpReaders } from './readers';
import type { TokenSafety } from '../../../lib/solana/lp/tokenSafety';
import { BAYLA_MINT, TOKEN_2022_PROGRAM, USDC_MINT, WSOL_MINT } from '../../../lib/solana/lp/tokenSafety';
import { setPriceSide } from './priceSide';
import type { PoolListRead } from '../../../lib/solana/lp/poolList';
import type { PoolSearchRead, PoolView } from '../../../lib/solana/lp/poolFinder';
import { buildPool, key, viewOf } from '../../../lib/solana/lp/testkit.fixture';

const wallet = vi.hoisted(() => ({ publicKey: null as null | { toBase58(): string } }));
vi.mock('@solana/wallet-adapter-react', () => ({ useWallet: () => wallet, useConnection: () => ({ connection: { rpcEndpoint: 'fake' } }) }));
vi.mock('../SolanaConnectButton', () => ({ SolanaConnectButton: () => <button type="button">Connect Solana Wallet</button> }));

const CORN = key();
const C = CORN.toBase58();
const BAYLA = new PublicKey(BAYLA_MINT);

function view(mint: PublicKey, sol = 10n * 10n ** 9n, tok = 1_000n * 10n ** 6n): PoolView {
  return viewOf(buildPool({ plain: true, mint, configIndex: 1, quoteReserve: sol, tokenReserve: tok }), { sol, tok });
}

const okToken = (mint: string): TokenSafety => ({
  kind: 'read', mint, verdict: 'ok', blocks: [], warnings: [], name: 'Corn', symbol: 'CORN', metadataSource: 'metaplex',
  facts: { program: 'spl-token', mintAuthority: null, freezeAuthority: null, supply: 1n, decimals: 6, isInitialized: true, extensions: [], metadataPointer: null, tokenMetadata: null },
});

function search(mint: string, views: PoolView[]): PoolSearchRead {
  return {
    kind: 'ok',
    search: {
      mint,
      known: { launchPool: key().toBase58(), standard: [] },
      index: { kind: 'ok', pools: views.map((v) => v.address), truncated: false },
      pools: views.map((v) => ({ kind: 'pool' as const, view: v })),
      otherPairs: 0,
      launchTierPools: [],
      knownState: {},
      chainNow: 1_000n,
    },
  };
}

const ok = (pools: PoolView[], o: { unread?: number; truncated?: boolean; chainNow?: bigint | null; safety?: TokenSafety[] } = {}): PoolListRead => ({
  kind: 'ok',
  list: { pools, unread: o.unread ?? 0, truncated: o.truncated ?? false, chainNow: o.chainNow ?? null, safety: new Map((o.safety ?? []).map((s) => [s.mint, s])) },
});
/** The check read for `mint`: it calls itself `symbol`. */
const calls = (mint: string, symbol: string): TokenSafety => ({ ...okToken(mint), symbol } as TokenSafety);

function readers(o: Partial<LpReaders> = {}): LpReaders {
  const corn = view(CORN);
  return {
    programId: 'EKS4C6xvV9A5DMWaWtVnFvi7ru78EhqRAoddEMpQ2BtT',
    safety: vi.fn(async (mints: string[]) => new Map(mints.map((m) => [m, okToken(m)]))),
    findPools: vi.fn(async (mint: PublicKey) => search(mint.toBase58(), mint.toBase58() === C ? [corn] : [])),
    listPools: vi.fn(async () => ok([view(BAYLA, 30n * 10n ** 9n), corn])),
    outsidePrice: vi.fn(async () => ({ kind: 'ok' as const, solPerToken: 0.01, source: 'Jupiter' as const })),
    positions: vi.fn(async () => ({ kind: 'ok' as const, positions: [], chainNow: 1n, totalShares: 0 })),
    feeTiers: vi.fn(async () => ({ kind: 'ok' as const, openingDeposits: null, tiers: [] })),
    wallet: vi.fn(async () => { throw new Error('not stubbed'); }),
    placeShareOnChain: vi.fn(async () => { throw new Error('not stubbed'); }),
    ...o,
  };
}

function mount(r: LpReaders) {
  return render(<MemoryRouter initialEntries={['/pools']}><LpInner readers={r} writes={{ mode: 'off' }} /></MemoryRouter>);
}

beforeEach(() => { wallet.publicKey = null; setPriceSide('token'); });

describe('All pools: every pool on the venue, before a token is picked', () => {
  it('lists every pool on arrival, with no token picked and no search run', async () => {
    const r = readers();
    mount(r);
    const rows = await screen.findAllByTestId('lp-all-pools-row');
    expect(rows).toHaveLength(2);
    // A listed token by its registry name, and its pool's price and holdings in the pool's coin.
    expect(rows[0]).toHaveTextContent('BAYLA / SOL · 1% tier');
    expect(rows[0]).toHaveTextContent('1 BAYLA = 0.03 SOL');
    expect(rows[0]).toHaveTextContent(/Holds 30 SOL and 1,000 BAYLA/);
    expect(rows[1]).toHaveTextContent('1 token = 0.01 SOL');
    expect(r.findPools).not.toHaveBeenCalled();
  });

  it('a token the site does not list is shown by its whole address too, never by a short one alone', async () => {
    mount(readers());
    const rows = await screen.findAllByTestId('lp-all-pools-row');
    expect(within(rows[1]!).getByText(C)).toBeInTheDocument();
    expect(within(rows[0]!).queryByText(BAYLA_MINT)).toBeNull();
  });

  it('a coin that is not ours shows its own ticker in the heading, the holdings and the price, with its whole address', async () => {
    mount(readers({ listPools: vi.fn(async () => ok([view(CORN)], { safety: [calls(C, 'CRYING')] })) }));
    const [row] = await screen.findAllByTestId('lp-all-pools-row');
    expect(row).toHaveTextContent('CRYING / SOL · 1% tier');
    expect(row).toHaveTextContent(/Holds 10 SOL and 1,000 CRYING/);
    expect(row).toHaveTextContent('1 CRYING = 0.01 SOL');
    expect(within(row!).getByText(C)).toBeInTheDocument();
    expect(within(row!).getByRole('button', { name: 'View CRYING / SOL · 1% tier' })).toBeInTheDocument();
  });

  it('a coin copying one of our tickers reads "fake" everywhere on its row, and never heads a row as the real one', async () => {
    const soy = view(new PublicKey('8zsZESzrGoYVi1dVH4QNWXJ2EfW4v287aEGNiDvQpump'), 20n * 10n ** 9n);
    mount(readers({ listPools: vi.fn(async () => ok([soy, view(CORN)], { safety: [calls(C, 'SOY')] })) }));
    const [real, copy] = await screen.findAllByTestId('lp-all-pools-row');
    expect(real).toHaveTextContent('SOY / SOL · 1% tier');
    expect(copy).toHaveTextContent('fake SOY / SOL · 1% tier');
    expect(copy).toHaveTextContent(/Holds 10 SOL and 1,000 fake SOY/);
    expect(copy).toHaveTextContent('1 fake SOY = 0.01 SOL');
    expect(within(copy!).getByText(C)).toBeInTheDocument();
    expect(screen.getByTestId('lp-all-pools')).toHaveTextContent('one that copies the ticker of one of ours, or of SOL, USDC or USDT, reads “fake”');
  });

  it('a coin whose check was not read is headed by its short address and counted in tokens', async () => {
    mount(readers({ listPools: vi.fn(async () => ok([view(CORN)], { safety: [{ kind: 'unread', mint: C, detail: 'HTTP 429' }] })) }));
    const [row] = await screen.findAllByTestId('lp-all-pools-row');
    expect(row).toHaveTextContent(`${C.slice(0, 4)}…${C.slice(-4)} / SOL · 1% tier`);
    expect(row).toHaveTextContent('1 token = 0.01 SOL');
    expect(within(row!).getByText(C)).toBeInTheDocument();
  });

  it('a pairing coin on the token side (USDC in USDC / SOL) is named as the coin, by its address', async () => {
    mount(readers({ listPools: vi.fn(async () => ok([view(new PublicKey(USDC_MINT), 10n ** 9n, 100n * 10n ** 6n)])) }));
    const [row] = await screen.findAllByTestId('lp-all-pools-row');
    expect(row).toHaveTextContent('USDC / SOL · 1% tier');
    expect(row).toHaveTextContent(/Holds 1 SOL and 100 USDC/);
    expect(row).toHaveTextContent('1 USDC = 0.01 SOL');
    expect(within(row!).queryByText(USDC_MINT)).toBeNull();
  });

  it('View looks the pool’s token up in the finder: the token goes in the box and its pools are read and shown', async () => {
    const r = readers();
    mount(r);
    const rows = await screen.findAllByTestId('lp-all-pools-row');
    fireEvent.click(within(rows[1]!).getByRole('button', { name: /^View / }));
    await screen.findByTestId('lp-pool');
    expect(r.findPools).toHaveBeenCalledTimes(1);
    expect((r.findPools as ReturnType<typeof vi.fn>).mock.calls[0]![0].toBase58()).toBe(C);
    expect(within(screen.getByTestId('lp-finder')).getByDisplayValue(C)).toBeInTheDocument();
  });

  it('a list that could not be read says so, and never says there are no pools', async () => {
    mount(readers({ listPools: vi.fn(async () => ({ kind: 'unread' as const, detail: 'the pool index answered HTTP 502' })) }));
    const list = screen.getByTestId('lp-all-pools');
    await waitFor(() => expect(list).toHaveTextContent('The list of pools could not be read just now. That does not mean there are none'));
    // The reason is one press away, under Why: what the read answered, word for word.
    expect(within(list).getByText('the pool index answered HTTP 502')).toBeInTheDocument();
    expect(screen.queryByTestId('lp-all-pools-none')).toBeNull();
    expect(screen.queryByTestId('lp-all-pools-row')).toBeNull();
  });

  it('a thrown read is unread too', async () => {
    mount(readers({ listPools: vi.fn(async () => { throw new Error('boom'); }) }));
    await waitFor(() => expect(screen.getByTestId('lp-all-pools')).toHaveTextContent('could not be read just now.'));
    expect(within(screen.getByTestId('lp-all-pools')).getByText('boom')).toBeInTheDocument();
    expect(screen.queryByTestId('lp-all-pools-none')).toBeNull();
  });

  it('says "No pools yet" only when the index answered with none and nothing went unread', async () => {
    const { unmount } = mount(readers({ listPools: vi.fn(async () => ok([])) }));
    expect(await screen.findByTestId('lp-all-pools-none')).toHaveTextContent('No pools yet.');
    unmount();
    mount(readers({ listPools: vi.fn(async () => ok([], { unread: 2 })) }));
    await waitFor(() => expect(screen.getByTestId('lp-all-pools')).toHaveTextContent('2 more pools could not be read just now.'));
    expect(screen.queryByTestId('lp-all-pools-none')).toBeNull();
  });

  it('when there are more pools than the list holds, it says so and points to the search', async () => {
    mount(readers({ listPools: vi.fn(async () => ok([view(CORN)], { truncated: true })) }));
    expect(await screen.findByTestId('lp-all-pools-truncated')).toHaveTextContent('There are more pools than this list holds. Search a token above to find the rest.');
  });

  it('sits under the finder and above the positions (both tabs draw the section in one order)', async () => {
    mount(readers());
    const list = screen.getByTestId('lp-all-pools');
    expect(screen.getByTestId('lp-finder').compareDocumentPosition(list) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(list.compareDocumentPosition(screen.getByTestId('lp-positions')) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('each row shows its warning tags from what the list read, and a row with nothing to warn about shows none', async () => {
    const off = viewOf(buildPool({ plain: true, mint: key(), configIndex: 1, quoteReserve: 10n ** 8n, tokenReserve: 10n ** 9n, status: 4 | 1 }), { sol: 10n ** 8n, tok: 10n ** 9n });
    const deep = view(CORN);
    mount(readers({ listPools: vi.fn(async () => ok([deep, off], { chainNow: 1_000n })) }));
    const rows = await screen.findAllByTestId('lp-all-pools-row');
    expect(within(rows[0]!).queryAllByTestId('lp-all-pools-tag')).toHaveLength(0);
    const tags = within(rows[1]!).getAllByTestId('lp-all-pools-tag').map((t) => t.textContent);
    expect(tags).toEqual(['Trading off', 'Adding off', 'Little money in pool']);
    expect(within(rows[1]!).getByRole('list', { name: /: warnings$/ })).toBeInTheDocument();
    // What each tag means, and the threshold, are one press away.
    // Said by the price line every row shows: BAYLA / SOL is priced in SOL and can get the tag.
    expect(screen.getByTestId('lp-all-pools')).toHaveTextContent('Little money in pool: it holds under 1 SOL or 100 USDC (a pool priced in BAYLA never gets this tag).');
    expect(screen.getByTestId('lp-all-pools')).toHaveTextContent('a row with no tag is not a pool that passed');
  });

  it('a pool more than 3% from Jupiter’s price gets a red tag; one within gets none', async () => {
    // $100 a SOL: BAYLA at 0.03 SOL is $3 (agrees), CORN at 0.01 SOL would be $1, and Jupiter says $0.95.
    const marketPrices = vi.fn(async () => ({ [WSOL_MINT]: 100, [BAYLA_MINT]: 3, [C]: 0.95 }));
    mount(readers({ marketPrices }));
    const rows = await screen.findAllByTestId('lp-all-pools-row');
    const tag = await within(rows[1]!).findByText('Price over 3% above Jupiter');
    expect(tag).toHaveClass('text-rose-300');
    expect(within(rows[0]!).queryAllByTestId('lp-all-pools-tag')).toHaveLength(0);
    // One read for the whole list.
    expect(marketPrices).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('lp-all-pools')).toHaveTextContent('Price over 3% above or below Jupiter: the pool’s price is that far from Jupiter’s market price');
    // Prices turned round ("1 SOL = 100 CORN"): the gap is said that way round too, as the card says it.
    fireEvent.click(within(rows[1]!).getByTestId('lp-price-flip'));
    expect(within(rows[1]!).getByText('Price over 3% below Jupiter')).toBeInTheDocument();
    expect(screen.queryByTestId('lp-all-pools-prices-unread')).toBeNull();
  });

  it('under a red tag: the arbitrage in dollars, the trade it takes, and who that trade’s fee pays', async () => {
    // CORN dear here (0.01 SOL against Jupiter's 0.0095). Worked by hand: the token side goes to √(10e9·1e9·0.99/9.5)
    // = 1,020.836 CORN, so 21.046 CORN goes in ($19.99), and 10 SOL − 10e18/1,020.836e6 = 0.20411 SOL ($20.41)
    // comes back: $0.42 made. The 1% fee on $19.99: 84% to the LPs ($0.17), 16% to the venue ($0.03).
    // BAYLA 2% off: past the 1% fee, so a trade would pay, but inside 3%, so its row stays quiet.
    const marketPrices = vi.fn(async () => ({ [WSOL_MINT]: 100, [BAYLA_MINT]: 3 / 1.02, [C]: 0.95 }));
    const listPools = (chainNow: bigint | null) => vi.fn(async () => ok([view(BAYLA, 30n * 10n ** 9n), view(CORN)], { chainNow }));
    // The chain's clock not read: whether the pool trades now is unknown, so no figure (the red tag stays).
    const { unmount } = mount(readers({ marketPrices, listPools: listPools(null) }));
    await within((await screen.findAllByTestId('lp-all-pools-row'))[1]!).findByText('Price over 3% above Jupiter');
    expect(screen.queryByTestId('lp-all-pools-arb')).toBeNull();
    unmount();
    mount(readers({ marketPrices, listPools: listPools(1_000n) }));
    const rows = await screen.findAllByTestId('lp-all-pools-row');
    const arb = await within(rows[1]!).findByTestId('lp-all-pools-arb');
    expect(arb).toHaveTextContent('Arbitrage: about $0.42, from selling about $19.99 of the token here');
    expect(arb).toHaveTextContent('That trade pays the pool’s fee: $0.17 to LPs, $0.03 to the venue');
    expect(arb).not.toHaveTextContent('creator');
    // A row within 3% says nothing about arbitrage.
    expect(within(rows[0]!).queryAllByTestId('lp-all-pools-tag')).toHaveLength(0);
    expect(within(rows[0]!).queryByTestId('lp-all-pools-arb')).toBeNull();
    expect(screen.getByTestId('lp-all-pools')).toHaveTextContent('It comes out of the pool’s LPs');
  });

  it('a token with a transfer fee: the figure counts it and the row says how much; its fee not read, no figure', async () => {
    // CORN on Token-2022, dear here as above, keeping 1% of every transfer. Worked by hand: the token side goes to
    // √(10e9·1e9·0.99·0.99/9.5) = 1,015.719 CORN, so 15.877 CORN must reach the pool and the trader sends 16.038
    // ($15.24), 0.160 CORN of it kept by the token ($0.15). 10 SOL − 10e18/1,015.719e6 = 0.15475 SOL ($15.48)
    // comes back: $0.24 made. The 1% pool fee is on the 15.877 that arrive: $0.13 to the LPs, $0.02 to the venue.
    const marketPrices = vi.fn(async () => ({ [WSOL_MINT]: 100, [C]: 0.95 }));
    const corn = view(CORN);
    const pool = corn.quoteIsToken0 ? { ...corn.snapshot.pool, token1Program: TOKEN_2022_PROGRAM } : { ...corn.snapshot.pool, token0Program: TOKEN_2022_PROGRAM };
    const taxed: PoolView = { ...corn, snapshot: { ...corn.snapshot, pool } };
    const listPools = (safety: TokenSafety) => vi.fn(async () => ok([taxed], { chainNow: 1_000n, safety: [safety] }));
    // Whether it keeps a fee is unknown: the red tag, and no figure that could leave a fee out.
    const { unmount } = mount(readers({ marketPrices, listPools: listPools({ kind: 'unread', mint: C, detail: 'HTTP 429' }) }));
    await within((await screen.findAllByTestId('lp-all-pools-row'))[0]!).findByText('Price over 3% above Jupiter');
    expect(screen.queryByTestId('lp-all-pools-arb')).toBeNull();
    unmount();
    const fee = { epoch: 0n, maximumFee: 10n ** 12n, basisPoints: 100 };
    const read = okToken(C) as Extract<TokenSafety, { kind: 'read' }>;
    const withFee: TokenSafety = { ...read, facts: { ...read.facts!, program: 'token-2022', transferFee: { configAuthority: null, withdrawAuthority: null, withheldAmount: 0n, older: fee, newer: fee } } };
    mount(readers({ marketPrices, listPools: listPools(withFee) }));
    const arb = await screen.findByTestId('lp-all-pools-arb');
    expect(arb).toHaveTextContent('Arbitrage: about $0.24, from selling about $15.24 of CORN here');
    expect(arb).toHaveTextContent('That trade pays the pool’s fee: $0.13 to LPs, $0.02 to the venue; the token keeps back $0.15, for whoever collects its fee');
    expect(screen.getByTestId('lp-all-pools')).toHaveTextContent('a token whose transfer fee could not be read gets no figure');
  });

  it('Jupiter’s prices not read: the list says no row is marked, never that every price agrees', async () => {
    mount(readers({ marketPrices: vi.fn(async () => { throw new Error('Price fetch failed (502)'); }) }));
    expect(await screen.findByTestId('lp-all-pools-prices-unread')).toHaveTextContent('Jupiter’s prices could not be read just now, so no row is marked for a price gap.');
    expect(screen.queryAllByTestId('lp-all-pools-tag')).toHaveLength(0);
  });

  it('a reader without listPools shows no list', () => {
    const r = readers();
    delete r.listPools;
    mount(r);
    expect(screen.queryByTestId('lp-all-pools')).toBeNull();
  });
});
