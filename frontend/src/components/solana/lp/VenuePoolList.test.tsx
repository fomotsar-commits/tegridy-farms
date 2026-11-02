import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, render, screen, within, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { USDC_QUOTE } from '../../../lib/solana/lp/quotes';
import { PublicKey } from '@solana/web3.js';
import { LpInner } from './SolanaLpSection';
import type { LpReaders } from './readers';
import type { TokenSafety } from '../../../lib/solana/lp/tokenSafety';
import { BAYLA_MINT, TOKEN_2022_PROGRAM, USDC_MINT, WSOL_MINT } from '../../../lib/solana/lp/tokenSafety';
import { setPriceSide } from './priceSide';
import type { PoolListRead } from '../../../lib/solana/lp/poolList';
import type { LegQuote } from '../../../lib/solana/lp/outsidePrice';
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

const DECIMALS: Record<string, number> = { [WSOL_MINT]: 9 };
/** Jupiter quoting at `haircut` of its listed prices (`prices`), through a pool that is not ours. */
function jupiterAt(prices: Record<string, number>, haircut: (inputMint: string) => number = () => 1) {
  return vi.fn(async (inputMint: string, outputMint: string, amount: bigint): Promise<LegQuote> => {
    const usd = (Number(amount) / 10 ** (DECIMALS[inputMint] ?? 6)) * prices[inputMint]!;
    const out = BigInt(Math.floor((usd / prices[outputMint]!) * 10 ** (DECIMALS[outputMint] ?? 6) * haircut(inputMint)));
    return { kind: 'ok', out, pools: [key().toBase58()] };
  });
}
/** Jupiter's listed prices, and its live quotes right at them: a deep market, where a gap past the pool's fee pays. */
const jupiter = (prices: Record<string, number>) => ({ marketPrices: vi.fn(async () => prices), legQuote: jupiterAt(prices) });

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
    await waitFor(() => expect(list).toHaveTextContent('Not read just now. That does not mean there are none'));
    // The reason is one press away, under Why: what the read answered, word for word.
    expect(within(list).getByText('the pool index answered HTTP 502')).toBeInTheDocument();
    expect(screen.queryByTestId('lp-all-pools-none')).toBeNull();
    expect(screen.queryByTestId('lp-all-pools-row')).toBeNull();
  });

  it('a thrown read is unread too', async () => {
    mount(readers({ listPools: vi.fn(async () => { throw new Error('boom'); }) }));
    await waitFor(() => expect(screen.getByTestId('lp-all-pools')).toHaveTextContent('Not read just now.'));
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

  it('a row carries no arbitrage prose: the figure lives on the Arbitrage card, the row keeps its tag', async () => {
    mount(readers({ ...jupiter({ [WSOL_MINT]: 100, [BAYLA_MINT]: 3, [C]: 0.95 }), listPools: vi.fn(async () => ok([view(BAYLA, 30n * 10n ** 9n), view(CORN)], { chainNow: 1_000n, safety: [calls(C, 'CORN')] })) }));
    const rows = await screen.findAllByTestId('lp-all-pools-row');
    await within(rows[1]!).findByText('Price over 3% above Jupiter');
    await screen.findByTestId('lp-arb-row');
    for (const row of rows) {
      expect(row).not.toHaveTextContent(/Arbitrage/);
      expect(row).not.toHaveTextContent(/to LPs/);
    }
    expect(screen.getByTestId('lp-all-pools')).not.toHaveTextContent('Under such a row, Arbitrage');
    expect(screen.getByTestId('lp-all-pools')).toHaveTextContent('is on the Arbitrage card above');
  });

  it('each row links Swap to the swap page on that pair, paying with the pool’s coin, beside Add and View', async () => {
    mount(readers({ listPools: vi.fn(async () => ok([view(CORN), view(new PublicKey(USDC_MINT), 10n ** 9n, 100n * 10n ** 6n), usdcPool(view(CORN))], { safety: [calls(C, 'CORN')] })) }));
    const rows = await screen.findAllByTestId('lp-all-pools-row');
    const swap = within(rows[0]!).getByRole('link', { name: 'Swap CORN / SOL · 1% tier' });
    expect(swap).toHaveAttribute('href', `/solana?in=${WSOL_MINT}&out=${C}`);
    expect(swap).toHaveClass('min-h-[44px]');
    expect(swap).toHaveTextContent('Swap');
    // Pressed order in the row's button group: Add, then Swap, then View.
    expect([...rows[0]!.lastElementChild!.querySelectorAll('button, a')].map((el) => el.textContent)).toEqual(['Add', 'Swap', 'View']);
    expect(within(rows[1]!).getByRole('link', { name: 'Swap USDC / SOL · 1% tier' })).toHaveAttribute('href', `/solana?in=${WSOL_MINT}&out=${USDC_MINT}`);
    // A pool priced in USDC pays with USDC.
    expect(within(rows[2]!).getByRole('link', { name: 'Swap CORN / USDC · 1% tier' })).toHaveAttribute('href', `/solana?in=${USDC_MINT}&out=${C}`);
  });

  it('each row says what the pool holds in dollars at Jupiter’s prices, beside its pair; a coin with no price gets none, and none when prices are unread', async () => {
    // BAYLA: 30 SOL ($3,000) + 1,000 BAYLA ($3,000). CORN: 10 SOL ($1,000) + 1,000 CORN ($950).
    const { unmount } = mount(readers({ marketPrices: vi.fn(async () => ({ [WSOL_MINT]: 100, [BAYLA_MINT]: 3, [C]: 0.95 })) }));
    let rows = await screen.findAllByTestId('lp-all-pools-row');
    expect(await within(rows[0]!).findByTestId('lp-all-pools-worth')).toHaveTextContent('$6,000');
    expect(within(rows[1]!).getByTestId('lp-all-pools-worth')).toHaveTextContent('$1,950');
    expect(within(rows[1]!).getByTestId('lp-all-pools-worth')).toHaveAttribute('title', 'In the pool, at Jupiter’s listed prices');
    unmount();
    const second = mount(readers({ marketPrices: vi.fn(async () => ({ [WSOL_MINT]: 100, [BAYLA_MINT]: 3 })) }));
    rows = await screen.findAllByTestId('lp-all-pools-row');
    expect(await within(rows[0]!).findByTestId('lp-all-pools-worth')).toHaveTextContent('$6,000');
    expect(within(rows[1]!).queryByTestId('lp-all-pools-worth')).toBeNull();
    expect(rows[1]).not.toHaveTextContent('$0');
    second.unmount();
    mount(readers({ marketPrices: vi.fn(async () => { throw new Error('Price fetch failed (502)'); }) }));
    await screen.findByTestId('lp-all-pools-prices-unread');
    expect(screen.queryAllByTestId('lp-all-pools-worth')).toHaveLength(0);
    expect(screen.getByTestId('lp-all-pools')).toHaveTextContent('The dollars beside a pair are what the pool holds at Jupiter’s listed prices');
  });
});

/** The same pool with its token side under Token-2022, as BAYLA's mint is on mainnet. */
function token2022(v: PoolView): PoolView {
  const pool = v.quoteIsToken0 ? { ...v.snapshot.pool, token1Program: TOKEN_2022_PROGRAM } : { ...v.snapshot.pool, token0Program: TOKEN_2022_PROGRAM };
  return { ...v, snapshot: { ...v.snapshot, pool } };
}

/** The same coin's pool priced in USDC, ten times deeper: 10,000 USDC and 10,000 CORN, 1 USDC a CORN. */
function usdcPool(corn: PoolView): PoolView {
  return viewOf(buildPool({ plain: true, mint: new PublicKey(corn.tokenMint), quote: USDC_QUOTE, configIndex: 1, quoteReserve: 10_000n * 10n ** 6n, tokenReserve: 10_000n * 10n ** 6n }), { sol: 10_000n * 10n ** 6n, tok: 10_000n * 10n ** 6n });
}

describe('Arbitrage: every paying gap, ranked, with the trade and one press to take it', () => {
  // CORN dear here (0.01 SOL against Jupiter's 0.0095). Worked by hand: the token side goes to √(10e9·1e9·0.99/9.5)
  // = 1,020.836 CORN, so 21.046 CORN goes in ($19.99), and 10 SOL − 10e18/1,020.836e6 = 0.20411 SOL ($20.41)
  // comes back: $0.42 made. The 1% fee on $19.99: 84% to the LPs ($0.17), 16% to the venue ($0.03).
  const cornDear = { [WSOL_MINT]: 100, [BAYLA_MINT]: 3, [C]: 0.95 };

  it('sits under the finder and above All pools, with art, and says the basis of every figure once, stamped', async () => {
    mount(readers({ marketPrices: vi.fn(async () => cornDear), listPools: vi.fn(async () => ok([view(BAYLA, 30n * 10n ** 9n), view(CORN)], { chainNow: 1_000n, safety: [calls(C, 'CORN')] })) }));
    const board = screen.getByTestId('lp-arb');
    expect(board).toHaveAccessibleName('Arbitrage');
    expect(screen.getByTestId('lp-finder').compareDocumentPosition(board) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(board.compareDocumentPosition(screen.getByTestId('lp-all-pools')) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(within(board).getByRole('heading', { level: 2 })).toHaveTextContent('Arbitrage');
    expect(board.querySelector('[data-card-art]')).not.toBeNull();
    expect(await within(board).findByTestId('lp-arb-stamp')).toHaveTextContent('Against Jupiter’s listed prices, read just now.');
    expect(within(board).getByRole('button', { name: 'Read again' })).toBeInTheDocument();
  });

  it('one row per round trip that pays: the pair, the gap, Pay, Get, Profit at Jupiter’s live quote, where the fee goes, the price after, and Swap on that trade', async () => {
    mount(readers({ ...jupiter(cornDear), listPools: vi.fn(async () => ok([view(BAYLA, 30n * 10n ** 9n), view(CORN)], { chainNow: 1_000n, safety: [calls(C, 'CORN')] })) }));
    const row = await screen.findByTestId('lp-arb-row');
    expect(screen.getAllByTestId('lp-arb-row')).toHaveLength(1);
    expect(row).toHaveAttribute('data-side', 'sell');
    expect(row).toHaveTextContent('CORN / SOL · 1% tier');
    expect(within(row).getByTestId('lp-arb-gap')).toHaveTextContent('5.3% dearer here');
    expect(within(row).getByText(C)).toBeInTheDocument();
    const value = (label: string) => within(row).getByText(label, { exact: true }).nextElementSibling?.textContent;
    expect(value('Pay')).toBe('21.046 CORN ($19.99)');
    expect(value('Get')).toBe('≈ 0.2041 SOL ($20.41)');
    // Jupiter sells the 21.04 CORN that $19.99 buys at its listed price; sold here, they bring back $0.42 more.
    expect(value('Profit')).toBe('up to $0.42 round trip, at Jupiter’s live quote');
    expect(value('Fee')).toBe('$0.17 to LPs · $0.03 to the venue');
    // After the trade the pool's price sits the fee away from Jupiter's 0.0095 (0.0095 / 0.99 = 0.009596), less a
    // hair: the LPs' part of the fee stays in the token side's reserve, as the pool's own row will then show it.
    expect(value('After')).toMatch(/^1 CORN = 0\.009594 SOL/);
    const swap = within(row).getByRole('link', { name: 'Swap: sell 21.046 CORN for SOL' });
    // The link carries the exact sized amount, to the base unit; the row prints it to four places.
    expect(swap).toHaveAttribute('href', expect.stringMatching(new RegExp(`^/solana\\?in=${C}&out=${WSOL_MINT}&amt=21\\.046\\d*$`)));
    expect(swap).toHaveClass('btn-primary');
    expect(swap).toHaveTextContent('Swap');
    // The row's own tag stays a warning that names no figure.
    const rows = screen.getAllByTestId('lp-all-pools-row');
    expect(within(rows[1]!).getByText('Price over 3% above Jupiter')).toBeInTheDocument();
    expect(screen.getByTestId('lp-arb')).toHaveTextContent('It comes out of the pool’s LPs');
  });

  it('a token with a transfer fee: the figure counts it and the row says how much; its fee not read, no row', async () => {
    // CORN on Token-2022, dear here as above, keeping 1% of every transfer. Worked by hand: the token side goes to
    // √(10e9·1e9·0.99·0.99/9.5) = 1,015.719 CORN, so 15.877 CORN must reach the pool and the trader sends 16.038
    // ($15.24), 0.160 CORN of it kept by the token ($0.15). 10 SOL − 10e18/1,015.719e6 = 0.15475 SOL ($15.48)
    // comes back: $0.24 made. The 1% pool fee is on the 15.877 that arrive: $0.13 to the LPs, $0.02 to the venue.
    const { marketPrices, legQuote } = jupiter({ [WSOL_MINT]: 100, [C]: 0.95 });
    const corn = view(CORN);
    const pool = corn.quoteIsToken0 ? { ...corn.snapshot.pool, token1Program: TOKEN_2022_PROGRAM } : { ...corn.snapshot.pool, token0Program: TOKEN_2022_PROGRAM };
    const taxed: PoolView = { ...corn, snapshot: { ...corn.snapshot, pool } };
    const listPools = (safety: TokenSafety) => vi.fn(async () => ok([taxed], { chainNow: 1_000n, safety: [safety] }));
    // Whether it keeps a fee is unknown: the red tag on the row, and no figure that could leave a fee out.
    const { unmount } = mount(readers({ marketPrices, legQuote, listPools: listPools({ kind: 'unread', mint: C, detail: 'HTTP 429' }) }));
    await within((await screen.findAllByTestId('lp-all-pools-row'))[0]!).findByText('Price over 3% above Jupiter');
    expect(await screen.findByTestId('lp-arb-none')).toHaveTextContent('None right now.');
    expect(screen.getByTestId('lp-arb-partial')).toHaveTextContent('one pool’s token check could not be read, so it is not checked.');
    unmount();
    const fee = { epoch: 0n, maximumFee: 10n ** 12n, basisPoints: 100 };
    const read = okToken(C) as Extract<TokenSafety, { kind: 'read' }>;
    const withFee: TokenSafety = { ...read, facts: { ...read.facts!, program: 'token-2022', transferFee: { configAuthority: null, withdrawAuthority: null, withheldAmount: 0n, older: fee, newer: fee } } };
    mount(readers({ marketPrices, legQuote, listPools: listPools(withFee) }));
    const row = await screen.findByTestId('lp-arb-row');
    const value = (label: string) => within(row).getByText(label, { exact: true }).nextElementSibling?.textContent;
    expect(value('Pay')).toBe('16.0377 CORN ($15.24)');
    // Bought on Jupiter, the tokens pay the token's fee again on their way into the pool: less than the $0.24 above.
    expect(value('Profit')).toMatch(/^up to \$0\.\d\d round trip, at Jupiter’s live quote$/);
    expect(value('Fee')).toBe('$0.13 to LPs · $0.02 to the venue · the token keeps back $0.15');
    expect(within(row).getByRole('link', { name: 'Swap: sell 16.0377 CORN for SOL' })).toHaveAttribute('href', expect.stringMatching(new RegExp(`^/solana\\?in=${C}&out=${WSOL_MINT}&amt=16\\.0377\\d*$`)));
    expect(screen.getByTestId('lp-arb')).toHaveTextContent('a token whose transfer fee could not be read gets no figure');
  });

  it('ranks every paying gap by profit, most first, whatever coin the pool is priced in, and a 2% gap is on the board with no row tag', async () => {
    // CORN dear here (as above, $0.42), and dear in its USDC pool by the same 5.3% (1 USDC a CORN against $0.95),
    // which is ten times deeper, so that trade makes the most. BAYLA at $3 in the pool against $2.94 on Jupiter is
    // 2% dear here: past the 1% fee, so a trade pays and is listed, but inside 3%, so its row has no tag.
    const prices = { [WSOL_MINT]: 100, [BAYLA_MINT]: 3 / 1.02, [USDC_MINT]: 1, [C]: 0.95 };
    // BAYLA as mainnet holds it: a Token-2022 mint on the token side, and no check read for a coin the site names.
    const bayla = token2022(view(BAYLA, 30n * 10n ** 9n));
    const corn = view(CORN);
    const inUsdc = usdcPool(corn);
    mount(readers({ ...jupiter(prices), listPools: vi.fn(async () => ok([bayla, corn, inUsdc], { chainNow: 1_000n, safety: [calls(C, 'CORN')] })) }));
    const board = screen.getByTestId('lp-arb');
    await waitFor(() => expect(within(board).getAllByTestId('lp-arb-row')).toHaveLength(3));
    const arbRows = within(board).getAllByTestId('lp-arb-row');
    expect(arbRows.map((r) => r.getAttribute('data-pool'))).toEqual([inUsdc.address, corn.address, bayla.address]);
    expect(arbRows[0]).toHaveTextContent('CORN / USDC · 1% tier');
    expect(within(arbRows[0]!).getByRole('link', { name: /^Swap: sell .* CORN for USDC$/ })).toHaveAttribute('href', expect.stringMatching(new RegExp(`^/solana\\?in=${C}&out=${USDC_MINT}&amt=`)));
    expect(arbRows[2]).toHaveTextContent('BAYLA / SOL · 1% tier');
    expect(within(arbRows[2]!).getByTestId('lp-arb-gap')).toHaveTextContent('2.0% dearer here');
    expect(within(arbRows[2]!).getByRole('link', { name: /^Swap: sell .* BAYLA for SOL$/ })).toHaveAttribute('href', expect.stringMatching(new RegExp(`^/solana\\?in=${BAYLA_MINT}&out=${WSOL_MINT}&amt=`)));
    const rows = screen.getAllByTestId('lp-all-pools-row');
    expect(within(rows[0]!).queryAllByTestId('lp-all-pools-tag')).toHaveLength(0);
    expect(within(board).getByRole('list', { name: 'Arbitrage: ranked by profit, most first' })).toBeInTheDocument();
  });

  it('a token cheap here is bought: Pay in the pool’s coin, Get in the token, Swap buys it', async () => {
    // CORN at $1.20 on Jupiter against $1 here: 16.7% cheap here, so the trade pays SOL in and takes CORN out.
    mount(readers({ ...jupiter({ [WSOL_MINT]: 100, [C]: 1.2 }), listPools: vi.fn(async () => ok([view(CORN)], { chainNow: 1_000n, safety: [calls(C, 'CORN')] })) }));
    const row = await screen.findByTestId('lp-arb-row');
    expect(row).toHaveAttribute('data-side', 'buy');
    expect(within(row).getByTestId('lp-arb-gap')).toHaveTextContent('16.7% cheaper here');
    const value = (label: string) => within(row).getByText(label, { exact: true }).nextElementSibling?.textContent;
    expect(value('Pay')).toMatch(/^0\.\d{4} SOL \(\$\d+\.\d\d\)$/);
    expect(value('Get')).toMatch(/^≈ \d+\.\d{4} CORN \(\$\d+\.\d\d\)$/);
    expect(within(row).getByRole('link', { name: /^Swap: buy CORN with 0\.\d{4} SOL$/ })).toHaveAttribute('href', expect.stringMatching(new RegExp(`^/solana\\?in=${WSOL_MINT}&out=${C}&amt=0\\.\\d+$`)));
  });

  it('a frozen pool and a blocked token are not on the board, whatever their gap', async () => {
    const frozen = { ...view(CORN), vaultsFrozen: true };
    const blockedMint = key().toBase58();
    const blocked = view(new PublicKey(blockedMint));
    const prices = { [WSOL_MINT]: 100, [C]: 0.95, [blockedMint]: 0.95 };
    mount(readers({ marketPrices: vi.fn(async () => prices), listPools: vi.fn(async () => ok([frozen, blocked], { chainNow: 1_000n, safety: [{ ...okToken(blockedMint), verdict: 'blocked' } as TokenSafety] })) }));
    await screen.findAllByTestId('lp-all-pools-row');
    expect(await screen.findByTestId('lp-arb-none')).toHaveTextContent('None right now.');
    expect(screen.queryAllByTestId('lp-arb-row')).toHaveLength(0);
  });

  it('says each state in a line: reading, not read, prices not read', async () => {
    const { unmount } = mount(readers({ listPools: vi.fn(() => new Promise<PoolListRead>(() => {})) }));
    expect(screen.getByTestId('lp-arb-reading')).toHaveTextContent('Reading the pools from the chain…');
    expect(screen.queryByTestId('lp-arb-stamp')).toBeNull();
    unmount();
    const u = mount(readers({ listPools: vi.fn(async () => ({ kind: 'unread' as const, detail: 'the pool index answered HTTP 502' })) }));
    expect(await screen.findByTestId('lp-arb-unread')).toHaveTextContent('Not read.');
    expect(screen.getByRole('button', { name: 'Read again' })).not.toHaveAttribute('aria-disabled');
    u.unmount();
    mount(readers({ marketPrices: vi.fn(async () => { throw new Error('Price fetch failed (502)'); }) }));
    expect(await screen.findByTestId('lp-arb-prices-unread')).toHaveTextContent('Jupiter’s prices not read.');
    expect(screen.queryAllByTestId('lp-arb-row')).toHaveLength(0);
  });

  it('a reader without market prices shows the board reading its prices, and never a figure', async () => {
    const r = readers();
    delete r.marketPrices;
    mount(r);
    await screen.findAllByTestId('lp-all-pools-row');
    expect(screen.getByTestId('lp-arb-reading')).toHaveTextContent('Reading Jupiter’s prices…');
    expect(screen.queryAllByTestId('lp-arb-row')).toHaveLength(0);
  });

  it('Read again reads the list once more, keeping the rows and the last figures while it does; a read that fails keeps them and says why, in amber', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      let answers = 0;
      const pending: { resolve: (r: PoolListRead) => void; reject: (e: Error) => void }[] = [];
      const listPools = vi.fn(() => new Promise<PoolListRead>((resolve, reject) => { pending.push({ resolve, reject }); }));
      mount(readers({ ...jupiter(cornDear), listPools }));
      // Two reads at mount: this list's own, and Every position's once-only one (it shares a real reader's in-flight read).
      expect(listPools).toHaveBeenCalledTimes(2);
      const first = ok([view(BAYLA, 30n * 10n ** 9n), view(CORN)], { chainNow: 1_000n, safety: [calls(C, 'CORN')] });
      await act(async () => { pending[answers++]!.resolve(first); pending[answers++]!.resolve(first); });
      await screen.findByTestId('lp-arb-row');
      const again = screen.getByRole('button', { name: 'Read again' });
      // Held for ten seconds after an answer (the caches are thirty): said, never `disabled`, so focus stays.
      expect(again).toHaveAttribute('aria-disabled', 'true');
      await act(async () => { vi.advanceTimersByTime(15_000); });
      expect(screen.getByTestId('lp-arb-stamp')).toHaveTextContent(/read 1\d s ago\./);
      expect(again).not.toHaveAttribute('aria-disabled');
      fireEvent.click(again);
      expect(listPools).toHaveBeenCalledTimes(3);
      expect(again).toHaveAttribute('aria-busy', 'true');
      // The rows and the figures stay while the read is on its way.
      expect(screen.getAllByTestId('lp-arb-row')).toHaveLength(1);
      expect(screen.getAllByTestId('lp-all-pools-row')).toHaveLength(2);
      await act(async () => { pending[answers++]!.reject(new Error('the chain did not answer in 20 seconds')); });
      const stamp = await screen.findByTestId('lp-arb-stamp');
      await waitFor(() => expect(stamp).toHaveTextContent('Could not read again (the chain did not answer in 20 seconds). Showing the read from 1'));
      expect(stamp).toHaveTextContent(', against Jupiter’s listed prices.');
      expect(stamp).toHaveClass('text-amber-300/90');
      expect(screen.getAllByTestId('lp-arb-row')).toHaveLength(1);
      expect(screen.getAllByTestId('lp-all-pools-row')).toHaveLength(2);
      // Past a minute without a fresh read the stamp is amber too.
      await act(async () => { vi.advanceTimersByTime(50_000); });
      expect(screen.getByTestId('lp-arb-stamp')).toHaveAttribute('data-stale', '');
    } finally {
      vi.useRealTimers();
    }
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

  it('the venue’s own BAYLA pool, a Token-2022 mint the list reads no check for, is on the board like any other', async () => {
    // BAYLA at $3 here against $2.70 on Jupiter: 11% dear.
    mount(readers({ ...jupiter({ [WSOL_MINT]: 100, [BAYLA_MINT]: 2.7 }), listPools: vi.fn(async () => ok([token2022(view(BAYLA, 30n * 10n ** 9n))], { chainNow: 1_000n })) }));
    const row = await screen.findByTestId('lp-arb-row');
    expect(row).toHaveTextContent('BAYLA / SOL · 1% tier');
    expect(within(row).getByRole('link', { name: /^Swap: sell .* BAYLA for SOL$/ })).toBeInTheDocument();
    expect(screen.queryByTestId('lp-arb-partial')).toBeNull();
  });

  it('the chain’s clock not read: nothing can be sized, and the board says so instead of None', async () => {
    mount(readers({ marketPrices: vi.fn(async () => cornDear), listPools: vi.fn(async () => ok([view(BAYLA, 30n * 10n ** 9n), view(CORN)], { chainNow: null, safety: [calls(C, 'CORN')] })) }));
    expect(await screen.findByTestId('lp-arb-unsized')).toHaveTextContent('The chain’s clock was not read, so no trade can be sized.');
    expect(screen.queryByTestId('lp-arb-none')).toBeNull();
    expect(screen.queryAllByTestId('lp-arb-row')).toHaveLength(0);
  });

  it('pools the index named but could not be read are said as not checked, beside the rows and under None alike', async () => {
    const { unmount } = mount(readers({ ...jupiter(cornDear), listPools: vi.fn(async () => ok([view(CORN)], { chainNow: 1_000n, unread: 2, safety: [calls(C, 'CORN')] })) }));
    await screen.findByTestId('lp-arb-row');
    expect(screen.getByTestId('lp-arb-partial')).toHaveTextContent('2 pools could not be read, so they are not checked.');
    unmount();
    mount(readers({ marketPrices: vi.fn(async () => cornDear), listPools: vi.fn(async () => ok([view(BAYLA, 30n * 10n ** 9n)], { chainNow: 1_000n, unread: 1 })) }));
    expect(await screen.findByTestId('lp-arb-none')).toHaveTextContent('None right now.');
    expect(screen.getByTestId('lp-arb-partial')).toHaveTextContent('One pool could not be read, so it is not checked.');
  });

  it('Jupiter’s prices that could not be read again stand, said as old, and the rows and dollars stay', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const marketPrices = vi.fn<(mints: string[]) => Promise<Record<string, number>>>().mockResolvedValueOnce(cornDear).mockRejectedValue(new Error('Price fetch failed (502)'));
      const listPools = vi.fn(async () => ok([view(BAYLA, 30n * 10n ** 9n), view(CORN)], { chainNow: 1_000n, safety: [calls(C, 'CORN')] }));
      mount(readers({ marketPrices, legQuote: jupiterAt(cornDear), listPools }));
      await screen.findByTestId('lp-arb-row');
      await act(async () => { vi.advanceTimersByTime(15_000); });
      fireEvent.click(screen.getByRole('button', { name: 'Read again' }));
      await waitFor(() => expect(marketPrices).toHaveBeenCalledTimes(2));
      const stale = await screen.findByTestId('lp-arb-prices-stale');
      expect(stale).toHaveTextContent('Jupiter’s prices could not be read again. Showing the prices read');
      expect(screen.getAllByTestId('lp-arb-row')).toHaveLength(1);
      expect(screen.queryByTestId('lp-arb-prices-unread')).toBeNull();
      expect(screen.queryByTestId('lp-all-pools-prices-unread')).toBeNull();
      expect(screen.getAllByTestId('lp-all-pools-worth')).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a read again keeps a focused Swap focused: the rows keep their place', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      // The same pools on every read, as on chain (a fixture built per call would mint new addresses, and so new rows).
      const pools = [view(BAYLA, 30n * 10n ** 9n), view(CORN)];
      mount(readers({ ...jupiter(cornDear), listPools: vi.fn(async () => ok(pools, { chainNow: 1_000n, safety: [calls(C, 'CORN')] })) }));
      const swap = await screen.findByTestId('lp-arb-swap');
      swap.focus();
      expect(document.activeElement).toBe(swap);
      await act(async () => { vi.advanceTimersByTime(15_000); });
      fireEvent.click(screen.getByRole('button', { name: 'Read again' }));
      await waitFor(() => expect(screen.getByTestId('lp-arb-stamp')).toHaveTextContent('read just now.'));
      expect(screen.getByTestId('lp-arb-swap')).toBe(swap);
      expect(document.activeElement).toBe(swap);
    } finally {
      vi.useRealTimers();
    }
  });

  it('two failed reads in a row: Not read, and never "showing the read from" over nothing', async () => {
    const listPools = vi.fn(async () => { throw new Error('boom'); });
    mount(readers({ listPools }));
    expect(await screen.findByTestId('lp-arb-unread')).toHaveTextContent('Not read.');
    const again = screen.getByRole('button', { name: 'Read again' });
    expect(again).not.toHaveAttribute('aria-disabled');
    fireEvent.click(again);
    // Two reads at mount (this list's, Every position's), the press the third.
    await waitFor(() => expect(listPools).toHaveBeenCalledTimes(3));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Read again' })).not.toHaveAttribute('aria-busy'));
    expect(screen.getByTestId('lp-arb-unread')).toHaveTextContent('Not read.');
    expect(screen.queryByTestId('lp-arb-stamp')).toBeNull();
  });

  it('past a minute without a fresh read the stamp turns amber, while the figures stay', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      let answered = 0;
      // The first two asks (this list's, Every position's) answer; a later tick's read never lands.
      const listPools = vi.fn(() => (answered++ < 2 ? Promise.resolve(ok([view(BAYLA, 30n * 10n ** 9n), view(CORN)], { chainNow: 1_000n, safety: [calls(C, 'CORN')] })) : new Promise<PoolListRead>(() => {})));
      mount(readers({ ...jupiter(cornDear), listPools }));
      await screen.findByTestId('lp-arb-row');
      const stamp = await screen.findByTestId('lp-arb-stamp');
      expect(stamp).not.toHaveAttribute('data-stale');
      await act(async () => { vi.advanceTimersByTime(65_000); });
      expect(screen.getByTestId('lp-arb-stamp')).toHaveAttribute('data-stale', '');
      expect(screen.getByTestId('lp-arb-stamp')).toHaveTextContent('read 1 min ago.');
      expect(screen.getAllByTestId('lp-arb-row')).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });
});


describe('Arbitrage: only round trips that pay at Jupiter’s live quote are listed', () => {
  // Owner, 2026-11-01: "only show actual profitable arbs not distractions". GRR that morning read 9.0% cheaper here
  // against Jupiter's listed price, while Jupiter's real sale paid ~6% under it. Here CORN is 0.01 SOL ($1) in the
  // pool against a listed $1/0.91; the trip pays only if Jupiter's sale back comes within ~4.1% of that price.
  const grr = { [WSOL_MINT]: 100, [C]: 1 / 0.91 };
  const cornDear = { [WSOL_MINT]: 100, [BAYLA_MINT]: 3, [C]: 0.95 };
  const listed = (pools: PoolView[]) => vi.fn(async () => ok(pools, { chainNow: 1_000n, safety: [calls(C, 'CORN')] }));
  const valueOf = (row: HTMLElement, label: string) => within(row).getByText(label, { exact: true }).nextElementSibling as HTMLElement;
  /** `n` pools of their own coins, each priced `usd` by Jupiter against $1 here. */
  function coins(n: number, usd: number) {
    const mints = Array.from({ length: n }, () => key());
    return { mints, pools: mints.map((m) => view(m)), prices: { [WSOL_MINT]: 100, ...Object.fromEntries(mints.map((m) => [m.toBase58(), usd])) } };
  }

  it('GRR: 9% cheaper here, but Jupiter pays 6% under its listed price, so the trip loses: no row, one quiet line, and None', async () => {
    const legQuote = jupiterAt(grr, () => 0.94);
    mount(readers({ marketPrices: vi.fn(async () => grr), listPools: listed([view(CORN)]), legQuote }));
    expect(await screen.findByTestId('lp-arb-within')).toHaveTextContent('One pool is within trading costs of the market.');
    expect(screen.getByTestId('lp-arb-within')).toHaveClass('text-white/70');
    expect(screen.getByTestId('lp-arb-none')).toHaveTextContent('None right now.');
    expect(screen.queryAllByTestId('lp-arb-row')).toHaveLength(0);
    expect(screen.getByTestId('lp-arb')).not.toHaveTextContent('Profit');
    // One quote: sell on Jupiter what the pool's trade gives, CORN for SOL.
    expect(legQuote).toHaveBeenCalledTimes(1);
    expect(legQuote.mock.calls[0]!.slice(0, 2)).toEqual([C, WSOL_MINT]);
    // The pool's own row in All pools keeps its price tag: the gap is real, the profit is not.
    expect(await within(screen.getAllByTestId('lp-all-pools-row')[0]!).findByText('Price over 3% below Jupiter')).toBeInTheDocument();
  });

  it('GRR, SOY and BRAINLET as measured that morning (−6%, −4.5%, about even after Jupiter): all three left out, counted in one line', async () => {
    const { mints, pools, prices } = coins(3, 1 / 0.91);
    const haircut: Record<string, number> = { [mints[0]!.toBase58()]: 0.94, [mints[1]!.toBase58()]: 0.955, [mints[2]!.toBase58()]: 0.9588 };
    mount(readers({ marketPrices: vi.fn(async () => prices), listPools: vi.fn(async () => ok(pools, { chainNow: 1_000n })), legQuote: jupiterAt(prices, (m) => haircut[m]!) }));
    expect(await screen.findByTestId('lp-arb-within')).toHaveTextContent('3 pools are within trading costs of the market.');
    expect(screen.getByTestId('lp-arb-none')).toHaveTextContent('None right now.');
    expect(screen.queryAllByTestId('lp-arb-row')).toHaveLength(0);
    expect(screen.queryByTestId('lp-arb-unchecked')).toBeNull();
  });

  it('a real gap: Jupiter pays near its listed price, and the row shows the round trip’s profit', async () => {
    mount(readers({ marketPrices: vi.fn(async () => grr), listPools: listed([view(CORN)]), legQuote: jupiterAt(grr, () => 0.995) }));
    const row = await screen.findByTestId('lp-arb-row');
    expect(within(row).getByTestId('lp-arb-gap')).toHaveTextContent('9.0% cheaper here');
    expect(valueOf(row, 'Profit')).toHaveTextContent(/^up to \$1\.64 round trip, at Jupiter’s live quote$/);
    expect(within(row).getByRole('link', { name: /^Swap: buy CORN with 0\.\d{4} SOL$/ })).toBeInTheDocument();
    expect(screen.queryByTestId('lp-arb-within')).toBeNull();
    expect(screen.queryByTestId('lp-arb-none')).toBeNull();
  });

  it('dear here: Jupiter is asked to buy the tokens with the SOL they are worth at its listed price, and what it delivers is sold here', async () => {
    const legQuote = jupiterAt(cornDear, () => 0.995);
    mount(readers({ marketPrices: vi.fn(async () => cornDear), listPools: listed([view(CORN)]), legQuote }));
    const row = await screen.findByTestId('lp-arb-row');
    const [inputMint, outputMint, amount] = legQuote.mock.calls[0]!;
    expect([inputMint, outputMint]).toEqual([WSOL_MINT, C]);
    // 21.046 CORN at the listed $0.95 is $19.99: 0.1999 SOL.
    expect(Number(amount) / 1e9).toBeCloseTo(0.1999, 4);
    expect(valueOf(row, 'Profit')).toHaveTextContent(/^up to \$0\.\d\d round trip, at Jupiter’s live quote$/);
  });

  it('the trip the listed price ranked first is left out when Jupiter’s real quote makes it lose; the rest stay, by real profit', async () => {
    // Listed, the USDC pool makes the most (Arbitrage above). Jupiter's USDC route pays 20% under.
    const prices = { [WSOL_MINT]: 100, [BAYLA_MINT]: 3 / 1.02, [USDC_MINT]: 1, [C]: 0.95 };
    const corn = view(CORN);
    const inUsdc = usdcPool(corn);
    const bayla = token2022(view(BAYLA, 30n * 10n ** 9n));
    const legQuote = jupiterAt(prices, (inputMint) => (inputMint === USDC_MINT ? 0.8 : 0.999));
    mount(readers({ marketPrices: vi.fn(async () => prices), listPools: listed([bayla, corn, inUsdc]), legQuote }));
    expect(await screen.findByTestId('lp-arb-within')).toHaveTextContent('One pool is within trading costs of the market.');
    await waitFor(() => expect(screen.getAllByTestId('lp-arb-row')).toHaveLength(2));
    const pools = screen.getAllByTestId('lp-arb-row').map((r) => r.getAttribute('data-pool'));
    expect(pools).not.toContain(inUsdc.address);
    expect(new Set(pools)).toEqual(new Set([corn.address, bayla.address]));
  });

  it('asks for the top 5 gaps only, one quote after another, never two together; the rest are said as not checked, never None', async () => {
    const { pools, prices } = coins(7, 0.95 / 0.9);
    const answer = jupiterAt(prices, () => 0.999);
    const pending: (() => void)[] = [];
    const legQuote = vi.fn((i: string, o: string, a: bigint) => new Promise<LegQuote>((resolve) => pending.push(() => resolve(answer(i, o, a)))));
    mount(readers({ marketPrices: vi.fn(async () => prices), listPools: vi.fn(async () => ok(pools, { chainNow: 1_000n })), legQuote }));
    expect(await screen.findByTestId('lp-arb-checking')).toHaveTextContent('Checking 5 pools against Jupiter’s live quotes…');
    expect(screen.queryAllByTestId('lp-arb-row')).toHaveLength(0);
    expect(screen.queryByTestId('lp-arb-none')).toBeNull();
    for (let i = 0; i < 5; i++) {
      await waitFor(() => expect(legQuote).toHaveBeenCalledTimes(i + 1));
      await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
      expect(legQuote).toHaveBeenCalledTimes(i + 1);
      await act(async () => { pending[i]!(); });
    }
    await waitFor(() => expect(screen.getAllByTestId('lp-arb-row')).toHaveLength(5));
    expect(legQuote).toHaveBeenCalledTimes(5);
    expect(screen.queryByTestId('lp-arb-checking')).toBeNull();
    const unchecked = screen.getByTestId('lp-arb-unchecked');
    expect(unchecked).toHaveTextContent('2 pools were not checked against Jupiter’s live quote, so they are not listed.');
    expect(unchecked).toHaveClass('text-amber-300/90');
    expect(screen.queryByTestId('lp-arb-none')).toBeNull();
    expect(screen.getByTestId('lp-arb')).toHaveTextContent('the top 5 gaps each ask Jupiter for a live quote of the other half of the round trip');
  });

  it('a quote Jupiter did not answer ends the pass: no more are asked, nothing is listed, and it is never None', async () => {
    const { pools, prices } = coins(3, 0.95 / 0.9);
    const legQuote = vi.fn(async (): Promise<LegQuote> => ({ kind: 'unread', detail: 'Jupiter did not give a price (HTTP 429)' }));
    mount(readers({ marketPrices: vi.fn(async () => prices), listPools: vi.fn(async () => ok(pools, { chainNow: 1_000n })), legQuote }));
    expect(await screen.findByTestId('lp-arb-unchecked')).toHaveTextContent('3 pools were not checked against Jupiter’s live quote, so they are not listed.');
    await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
    expect(legQuote).toHaveBeenCalledTimes(1);
    expect(screen.queryAllByTestId('lp-arb-row')).toHaveLength(0);
    expect(screen.queryByTestId('lp-arb-none')).toBeNull();
  });

  it('a reader that cannot ask Jupiter lists nothing and says the pools were not checked', async () => {
    mount(readers({ marketPrices: vi.fn(async () => cornDear), listPools: listed([view(CORN)]) }));
    expect(await screen.findByTestId('lp-arb-unchecked')).toHaveTextContent('One pool was not checked against Jupiter’s live quote, so it is not listed.');
    expect(screen.queryAllByTestId('lp-arb-row')).toHaveLength(0);
    expect(screen.queryByTestId('lp-arb-none')).toBeNull();
  });

  it('a quote through one of our own pools is not an outside price; Jupiter’s "no route" is within costs', async () => {
    const corn = view(CORN);
    const { unmount } = mount(readers({ marketPrices: vi.fn(async () => grr), listPools: listed([corn]), legQuote: vi.fn(async (): Promise<LegQuote> => ({ kind: 'ok', out: 10n ** 12n, pools: [corn.address] })) }));
    expect(await screen.findByTestId('lp-arb-unchecked')).toHaveTextContent('One pool was not checked');
    expect(screen.queryAllByTestId('lp-arb-row')).toHaveLength(0);
    unmount();
    mount(readers({ marketPrices: vi.fn(async () => grr), listPools: listed([view(CORN)]), legQuote: vi.fn(async (): Promise<LegQuote> => ({ kind: 'no-route' })) }));
    expect(await screen.findByTestId('lp-arb-within')).toHaveTextContent('One pool is within trading costs of the market.');
    expect(screen.queryAllByTestId('lp-arb-row')).toHaveLength(0);
  });

  it('a listed row stays while its next quote is on the way, so it does not blink out on each read, and a focused Swap keeps focus', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      // The second read's prices move a hair, so the trade is sized again and Jupiter is asked a new amount.
      let reads = 0;
      const marketPrices = vi.fn(async () => (reads++ === 0 ? cornDear : { ...cornDear, [C]: 0.9499 }));
      const first = jupiterAt(cornDear);
      const legQuote = vi.fn((i: string, o: string, a: bigint) => (legQuote.mock.calls.length === 1 ? first(i, o, a) : new Promise<LegQuote>(() => {})));
      const pools = [view(CORN)];
      // A new list each read, of the same pools, as the chain read gives it: the prices are read again with it.
      mount(readers({ marketPrices, legQuote, listPools: vi.fn(async () => ok([...pools], { chainNow: 1_000n, safety: [calls(C, 'CORN')] })) }));
      const swap = await screen.findByTestId('lp-arb-swap');
      swap.focus();
      await act(async () => { vi.advanceTimersByTime(15_000); });
      fireEvent.click(screen.getByRole('button', { name: 'Read again' }));
      await waitFor(() => expect(marketPrices).toHaveBeenCalledTimes(2));
      await waitFor(() => expect(legQuote).toHaveBeenCalledTimes(2));
      expect(legQuote.mock.calls[1]![2]).not.toBe(legQuote.mock.calls[0]![2]);
      expect(screen.getByTestId('lp-arb-swap')).toBe(swap);
      expect(document.activeElement).toBe(swap);
      expect(screen.queryByTestId('lp-arb-checking')).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});

// Island answer twenty-four, §4: a row's coins are presses that copy their whole addresses.
describe('All pools: every coin in a row copies its whole address', () => {
  const writeText = vi.fn(async () => {});
  beforeEach(() => {
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
  });

  it('names the token and its pairing coin as presses, and keeps the heading and a stranger’s whole address', async () => {
    mount(readers({ listPools: vi.fn(async () => ok([view(BAYLA, 30n * 10n ** 9n), view(CORN)], { safety: [calls(C, 'CRYING')] })) }));
    const [bayla, crying] = await screen.findAllByTestId('lp-all-pools-row');
    const names = (row: HTMLElement) => within(row).getAllByTestId('coin-name').map((n) => n.getAttribute('aria-label'));
    expect(names(bayla!)).toEqual([`BAYLA: copy its address ${BAYLA_MINT}`, `SOL: copy its address ${WSOL_MINT}`]);
    expect(names(crying!)).toEqual([`CRYING: copy its address ${C}`, `SOL: copy its address ${WSOL_MINT}`]);
    expect(within(bayla!).getByText('BAYLA / SOL · 1% tier')).toBeInTheDocument();
    expect(within(crying!).getByText(C)).toBeInTheDocument();
    for (const n of within(crying!).getAllByTestId('coin-name')) expect(n.className).toContain('min-h-[44px]');
    await act(async () => {
      fireEvent.click(within(crying!).getAllByTestId('coin-name')[0]!);
    });
    expect(writeText).toHaveBeenCalledWith(C);
    expect(within(crying!).getByText('Copied')).toBeInTheDocument();
  });
});
