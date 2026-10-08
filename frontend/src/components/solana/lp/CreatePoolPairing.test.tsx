// Opening a pool paired with SOL, USDC or BAYLA (owner ruling 2026-10-03). The owner's own
// case: BAYLA already has a SOL pool on the site, and he opens the first BAYLA/USDC pool.
//
// THE ONE BUG THIS FILE EXISTS TO STOP: an amount typed for USDC or BAYLA read or printed
// with SOL's 9 decimals, or priced with SOL's price. That is a 1000x error in real money.
// So: the coin's box is parsed and printed in the CHOSEN coin's decimals, the builder is
// handed that coin's mint and base units, the market price is the token's price in that
// coin, and nothing read or typed for one coin is ever shown under another's name.
//
// Also here, each per coin: what the wallet can put in, where the pool goes (every pair
// has its own standard address), and the pool to add to first (advice, never a block).
// The write layer is a fake; nothing touches a chain.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, cleanup, render, screen, waitFor, within, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { PublicKey } from '@solana/web3.js';
import { LpInner } from './SolanaLpSection';
import type { LpReaders } from './readers';
import type { TokenSafety } from '../../../lib/solana/lp/tokenSafety';
import { BAYLA_QUOTE, SOL_QUOTE, USDC_QUOTE, quotesFor, readPair, type QuoteCoin, type QuoteSymbol } from '../../../lib/solana/lp/quotes';
import { rememberCreatedPool, type PoolSearchRead, type PoolView } from '../../../lib/solana/lp/poolFinder';
import type { OutsidePrice } from '../../../lib/solana/lp/outsidePrice';
import { decodeAmmConfig, decodePoolState } from '../../../lib/solana/cpswap/program';
import type { WalletFacts } from '../../../lib/solana/lp/walletFacts';
import { buildPool, key } from '../../../lib/solana/lp/testkit.fixture';
import type { LpWriteApi, Prepared } from '../curve/ports';
import { TIER1_ADDRESS, fakeLpApi, LP_PROGRAM, readyFacts, unusedGateRpc } from './fakeLpWriteApi.fixture';

// web3's address derivation cannot run under jsdom: the public tier's address is the fixture's fixed key.
vi.mock('../../../lib/solana/cpswap/program', async (orig) => {
  const { PublicKey: Key } = await import('@solana/web3.js');
  return { ...(await orig<typeof import('../../../lib/solana/cpswap/program')>()), publicTierConfig: () => new Key(new Uint8Array(32).fill(41)) };
});

const OWNER = key();
const wallet = vi.hoisted(() => ({
  publicKey: null as null | PublicKey,
  signTransaction: undefined as undefined | ((t: unknown) => Promise<unknown>),
  signMessage: undefined,
  connecting: false,
  wallet: null,
}));
const conn = vi.hoisted(() => ({ connection: { rpcEndpoint: 'fake' } }));
vi.mock('@solana/wallet-adapter-react', () => ({ useWallet: () => wallet, useConnection: () => conn }));
vi.mock('../SolanaConnectButton', () => ({ SolanaConnectButton: () => <button type="button">Connect Solana Wallet</button> }));

/** An ordinary token: it can be paired with all three coins. */
const MINT = key();
const M = MINT.toBase58();
const USDC = USDC_QUOTE.mint;
const BAYLA = BAYLA_QUOTE.mint;
const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
/** Two whole flows, or a flow on a loaded machine: well past the default 5 s. */
const LONG = 30_000;

// ── prices, all in SOL as Jupiter gives them ──
// The token is 0.01 SOL. USDC is 0.005 SOL (1 SOL = 200 USDC), so the token is 2 USDC.
// BAYLA is 0.0001 SOL, so the token is 100 BAYLA, and BAYLA itself is 0.02 USDC.
// The three numbers differ on purpose: a price in the wrong coin cannot pass by luck.
const TOKEN_SOL = 0.01;
const COIN_SOL: Record<string, number> = { [USDC]: 0.005, [BAYLA]: 0.0001 };
const ok = (solPerToken: number): OutsidePrice => ({ kind: 'ok', solPerToken, source: 'Jupiter' });
const priceOf = (mint: string) => ok(COIN_SOL[mint] ?? TOKEN_SOL);

const tokenFor = (mint: string): TokenSafety => ({
  kind: 'read', mint, verdict: 'ok', blocks: [], warnings: [], name: 'Corn', symbol: 'CORN', metadataSource: 'metaplex',
  facts: { program: 'spl-token', mintAuthority: null, freezeAuthority: null, supply: 1n, decimals: 6, isInitialized: true, extensions: [], metadataPointer: null, tokenMetadata: null },
});

const UNIT = { SOL: 10n ** 9n, USDC: 10n ** 6n, BAYLA: 10n ** 6n, token: 10n ** 6n } as const;

/**
 * A pool for `mint` paired with `quote`. `tier1` puts it on the public fee tier. Its price
 * is `reserve / tokens` in the coin: the defaults are at the market for MINT.
 */
function view(o: { mint?: PublicKey; quote?: QuoteCoin; reserve?: bigint; tokens?: bigint; tier1?: boolean; openTime?: bigint } = {}): PoolView {
  const quote = o.quote ?? SOL_QUOTE;
  const mint = o.mint ?? MINT;
  const tokens = o.tokens ?? 1_000n * UNIT.token;
  const reserve = o.reserve ?? (quote.native ? 10n * UNIT.SOL : quote === USDC_QUOTE ? 2_000n * UNIT.USDC : 100_000n * UNIT.BAYLA);
  const b = buildPool({ plain: true, mint, quote, configIndex: 1, quoteReserve: reserve, tokenReserve: tokens, openTime: o.openTime ?? 1n });
  const raw = decodePoolState(b.address.toBase58(), b.accounts[b.address.toBase58()]!.data)!;
  const pool = { ...raw, ammConfig: o.tier1 === false ? raw.ammConfig : TIER1_ADDRESS.toBase58() };
  const config = { ...decodeAmmConfig(b.config.toBase58(), b.accounts[b.config.toBase58()]!.data)!, index: o.tier1 === false ? 0 : 1 };
  const pair = readPair(pool.token0Mint, pool.token1Mint)!;
  const q0 = pair.quoteIsToken0;
  return {
    address: b.address.toBase58(),
    origin: 'other',
    snapshot: { pool, vault0Amount: q0 ? reserve : tokens, vault1Amount: q0 ? tokens : reserve, reserve0: q0 ? reserve : tokens, reserve1: q0 ? tokens : reserve },
    config,
    tokenMint: mint.toBase58(),
    quote: pair.quote,
    quoteIsToken0: q0,
    quoteReserve: reserve,
    tokenReserve: tokens,
    vaultsFrozen: false,
    history: { kind: 'not-read' },
  };
}

/** Each pair's own standard tier-1 address: one per coin, as the finder works them out. */
const STANDARD: Record<QuoteSymbol, string> = { SOL: key().toBase58(), USDC: key().toBase58(), BAYLA: key().toBase58() };
function search(views: PoolView[], o: { mint?: string; taken?: QuoteSymbol[]; truncated?: boolean } = {}): PoolSearchRead {
  const mint = o.mint ?? M;
  const coins = quotesFor(mint);
  return {
    kind: 'ok',
    search: {
      mint,
      known: { launchPool: key().toBase58(), standard: coins.map((q) => ({ index: 1, config: TIER1_ADDRESS.toBase58(), address: STANDARD[q.symbol], quote: q.mint })) },
      index: { kind: 'ok', pools: views.map((v) => v.address), truncated: o.truncated === true },
      pools: views.map((v) => ({ kind: 'pool' as const, view: v })),
      otherPairs: 0,
      knownState: Object.fromEntries(coins.map((q) => [STANDARD[q.symbol], o.taken?.includes(q.symbol) ? ('pool' as const) : ('absent' as const)])),
      chainNow: 1_000n,
    },
  };
}

type Ok = Extract<WalletFacts, { kind: 'ok' }>;
/**
 * The wallet as the read answers for `quote`: 5 SOL and 500 tokens, and on the coin's side
 * nothing for SOL (it is the wallet's own SOL), 250 USDC, or 7,000 BAYLA. The three
 * balances differ, so a balance shown under the wrong coin's name is seen.
 */
function walletFor(quote: QuoteCoin | undefined, over: Partial<Ok> = {}): WalletFacts {
  const coin = !quote || quote.native ? null : { address: key().toBase58(), exists: true, amount: quote === USDC_QUOTE ? 250n * UNIT.USDC : 7_000n * UNIT.BAYLA };
  return {
    kind: 'ok',
    lamports: 5n * UNIT.SOL,
    token: { address: key().toBase58(), amount: 500n * UNIT.token },
    wsol: { exists: false, amount: 0n },
    coin,
    lpAccountExists: false,
    rents: { walletFloor: 890_880n, tokenAccount165: 2_039_280n, neverRefunded: 40_000_000n, ...(coin ? { coinAccount: 2_039_280n } : {}) },
    ...over,
  };
}

type WalletFn = LpReaders['wallet'];
function readers(o: Partial<LpReaders> = {}): LpReaders {
  return {
    programId: LP_PROGRAM,
    safety: vi.fn(async (mints: string[]) => new Map(mints.map((m) => [m, tokenFor(m)]))),
    findPools: vi.fn(async (mint: PublicKey) => search([], { mint: mint.toBase58() })),
    outsidePrice: vi.fn(async (mint: string) => priceOf(mint)),
    positions: vi.fn(async () => ({ kind: 'ok' as const, positions: [], chainNow: 1n, totalShares: 0 })),
    feeTiers: vi.fn(async () => ({ kind: 'ok' as const, openingDeposits: null, tiers: [] })),
    wallet: vi.fn<WalletFn>(async (_o, _m, _p, _l, opts) => walletFor(opts?.quote)),
    placeShareOnChain: vi.fn(async () => ({ kind: 'not-found' as const })),
    ...o,
  };
}

const notBuilt = () => vi.fn(async (): Promise<Prepared> => ({ ok: false, outcome: { status: 'not-sent', stage: 'build', message: 'x' } }));

function mount(r: LpReaders, o: { api?: Partial<LpWriteApi>; mint?: string } = {}) {
  const api = fakeLpApi({ readCreateFacts: vi.fn(async () => readyFacts()), ...o.api });
  render(
    <MemoryRouter initialEntries={[`/pools?mint=${o.mint ?? M}`]}>
      <LpInner readers={r} writes={{ mode: 'on', load: vi.fn(async () => api), gateRpc: unusedGateRpc }} />
    </MemoryRouter>,
  );
  return { api };
}

async function offered() {
  const card = await screen.findByTestId('lp-create');
  await waitFor(() => expect(card).toHaveAttribute('data-create', 'offer'));
  return card;
}
async function openPanel() {
  const card = await offered();
  fireEvent.click(within(card).getByRole('button', { name: 'Open a pool' }));
  const panel = await screen.findByTestId('lp-create-panel');
  return { card, panel };
}
/** Choose what the token is paired with, and wait for that coin's wallet read. */
async function pair(panel: HTMLElement, symbol: QuoteSymbol) {
  fireEvent.click(within(panel).getByRole('radio', { name: symbol }));
  await within(panel).findByRole('button', { name: `Max ${symbol}` });
}

const coinBox = (p: HTMLElement, symbol: QuoteSymbol) => within(p).getByLabelText(`${symbol} to put in`);
const tokens = (p: HTMLElement) => within(p).getByLabelText('Tokens to put in');
const type = (el: HTMLElement, value: string) => fireEvent.change(el, { target: { value } });
const reviewButton = (p: HTMLElement) => within(p).getByRole('button', { name: 'Review: open the pool' });
const matchButton = (p: HTMLElement) => within(p).getByTestId('lp-create-match');
const market = (p: HTMLElement) => within(p).getByTestId('lp-create-market');
const price = (p: HTMLElement) => within(p).getByTestId('lp-create-price');
const row = (p: HTMLElement, label: string) => within(p).getByText(label, { exact: true }).nextElementSibling;
const TERMS = { createPoolFee: 150_000_000n, tradeFeeRate: 10_000n, protocolFeeRate: 160_000n, fundFeeRate: 0n, creatorFeeRate: 0n };

/** What the builder was handed on its last call. */
const handed = (prepareLpCreate: ReturnType<typeof notBuilt>) => (prepareLpCreate.mock.calls.at(-1) as unknown[] | undefined)?.[3];

beforeEach(() => {
  sessionStorage.clear();
  wallet.publicKey = OWNER;
  wallet.signTransaction = async (t) => t;
});

describe('Pair with: the coins a token can be paired with', () => {
  it('an ordinary token: SOL, USDC and BAYLA, starting on SOL; a real radio group, each option a 44px target', async () => {
    mount(readers());
    const { panel } = await openPanel();
    const group = within(panel).getByRole('radiogroup', { name: 'Pair with' });
    const options = within(group).getAllByRole('radio') as HTMLInputElement[];
    expect(options.map((o) => o.value)).toEqual(['SOL', 'USDC', 'BAYLA']);
    expect(options.map((o) => o.checked)).toEqual([true, false, false]);
    // Keyboard: native radio buttons under one name are one Tab stop, and the arrow keys move the choice.
    for (const o of options) {
      expect(o.tagName).toBe('INPUT');
      expect(o.type).toBe('radio');
      expect(o).toBeEnabled();
      // The whole label is the target, and it carries the option's name.
      expect(o.closest('label')?.className).toMatch(/\bmin-h-\[44px\]/);
      expect(o.closest('label')).toHaveTextContent(o.value);
    }
    expect(new Set(options.map((o) => o.name)).size).toBe(1);
    expect(options[0]!.name).not.toBe('');
    // It starts as it always was: a SOL opening.
    expect(coinBox(panel, 'SOL')).toHaveValue('');
    expect(within(panel).queryByText('Paired with')).toBeNull();
  });

  it('BAYLA itself: SOL or USDC, never BAYLA with BAYLA', async () => {
    mount(readers(), { mint: BAYLA });
    const { panel } = await openPanel();
    expect((within(panel).getAllByRole('radio') as HTMLInputElement[]).map((o) => o.value)).toEqual(['SOL', 'USDC']);
  });

  it('USDC itself: SOL only, so there is nothing to choose; the coin is said and no group is drawn', async () => {
    mount(readers(), { mint: USDC });
    const { panel } = await openPanel();
    expect(within(panel).queryByRole('radiogroup')).toBeNull();
    expect(within(panel).queryByRole('radio')).toBeNull();
    expect(row(panel, 'Paired with')).toHaveTextContent('SOL: this site pairs this token with SOL only');
    // Not a dead end: a USDC and BAYLA pool is the same pool read from BAYLA's side, and the row says so.
    expect(row(panel, 'Paired with')).toHaveTextContent('A pool of USDC and BAYLA is opened from the other side: look up BAYLA and pair it with USDC');
    expect(coinBox(panel, 'SOL')).toBeInTheDocument();
  });
});

// Whole-change review 2026-10-04 (W4). A pairing coin looked up as the token is searched
// only against the coins that outrank it: for USDC that is SOL alone. The page said "No
// pools pairing this token with SOL, USDC or BAYLA found" and "No pool for this token yet":
// USDC with USDC is nonsense, and a USDC and BAYLA pool was never looked for from here (it
// is BAYLA's pool, listed under BAYLA). The page names the coins that WERE searched, and
// says where the other pool is before the form is opened.
describe('a pairing coin looked up as the token: the page names the coins that were searched', () => {
  const OTHER_SIDE = 'A pool of USDC and BAYLA is found and opened from the other side: look up BAYLA and pair it with USDC.';
  const said = (el: Element | null) => (el?.textContent ?? '').replace(/\s+/g, ' ').trim();
  const status = () => said(screen.getByTestId('lp-status'));

  it('USDC with no pool: the list, the status line and the Open card say SOL, and point to the other side, with no form open', async () => {
    mount(readers(), { mint: USDC });
    const card = await offered();
    expect(said(screen.getByTestId('lp-no-pools'))).toBe(`No pools pairing this token with SOL found. ${OTHER_SIDE}`);
    expect(status()).toBe(`No pools pairing this token with SOL found. ${OTHER_SIDE}`);
    expect(card).toHaveTextContent('There is no SOL pool to add liquidity to yet. Opening one is how the first liquidity goes in.');
    expect(card).toHaveTextContent('No SOL pool for this token yet. You can open the first one on the public fee tier: 1% a trade, 0.15 SOL to open (read just now).');
    expect(said(within(card).getByTestId('lp-create-other-side'))).toBe(OTHER_SIDE);
    // Nothing says a pair that was never looked for has no pool.
    expect(document.body).not.toHaveTextContent('SOL, USDC or BAYLA found');
    expect(document.body).not.toHaveTextContent('No pools found for this token.');
    expect(card).not.toHaveTextContent('No pool for this token yet');
    expect(card).not.toHaveTextContent('There is no pool to add liquidity to yet');
    // All of it is said before the form: none is open.
    expect(screen.queryByTestId('lp-create-panel')).toBeNull();
  });

  it('USDC, when the index is down or cut: the same coin in each of the list’s sentences', async () => {
    const down = search([], { mint: USDC });
    if (down.kind === 'ok') down.search.index = { kind: 'unread', detail: 'HTTP 502' };
    mount(readers({ findPools: vi.fn(async () => down) }), { mint: USDC });
    await waitFor(() => expect(said(screen.getByTestId('lp-no-pools'))).toBe(`No pools pairing this token with SOL found at the addresses we could check. ${OTHER_SIDE}`));
    cleanup();
    mount(readers({ findPools: vi.fn(async () => search([], { mint: USDC, truncated: true })) }), { mint: USDC });
    await waitFor(() => expect(said(screen.getByTestId('lp-no-pools'))).toBe(`None of the pools our index returned pairs this token with SOL. It returned its maximum, so there may be more. ${OTHER_SIDE}`));
  });

  it('USDC with a USDC and SOL pool listed: the other side is still said, by the list and in the status line', async () => {
    const pool = view({ mint: new PublicKey(USDC) });
    mount(readers({ findPools: vi.fn(async () => search([pool], { mint: USDC })) }), { mint: USDC });
    const card = await offered();
    expect(screen.queryByTestId('lp-no-pools')).toBeNull();
    expect(said(screen.getByTestId('lp-other-side'))).toBe(OTHER_SIDE);
    expect(status()).toBe(`One pool found for this token. ${OTHER_SIDE}`);
    expect(said(within(card).getByTestId('lp-create-other-side'))).toBe(OTHER_SIDE);
  });

  it('BAYLA: SOL or USDC were searched. No coin ranks below BAYLA, so no other side is named', async () => {
    mount(readers(), { mint: BAYLA });
    const card = await offered();
    expect(said(screen.getByTestId('lp-no-pools'))).toBe('No pools pairing this token with SOL or USDC found.');
    expect(status()).toBe('No pools pairing this token with SOL or USDC found.');
    expect(card).toHaveTextContent('There is no SOL or USDC pool to add liquidity to yet. Opening one is how the first liquidity goes in.');
    expect(card).toHaveTextContent('No SOL or USDC pool for this token yet. You can open the first one on the public fee tier:');
    expect(document.body).not.toHaveTextContent('from the other side');
  });

  it('any other token: all three coins were searched, and every sentence is word for word what it was', async () => {
    mount(readers());
    const card = await offered();
    expect(said(screen.getByTestId('lp-no-pools'))).toBe('No pools pairing this token with SOL, USDC or BAYLA found.');
    expect(status()).toBe('No pools found for this token.');
    expect(card).toHaveTextContent('There is no pool to add liquidity to yet. Opening one is how the first liquidity goes in.');
    expect(card).toHaveTextContent('No pool for this token yet. You can open the first one on the public fee tier: 1% a trade, 0.15 SOL to open (read just now).');
    expect(document.body).not.toHaveTextContent('from the other side');
  });
});

describe('an amount typed for a coin is that coin’s, to the base unit', () => {
  it('USDC, then 50: the builder is handed 50,000,000 of USDC’s mint, never 50,000,000,000', async () => {
    const r = readers();
    const prepareLpCreate = notBuilt();
    mount(r, { api: { prepareLpCreate } });
    const { panel } = await openPanel();
    await pair(panel, 'USDC');
    // The coin's box is the coin's: SOL's is gone.
    expect(within(panel).queryByLabelText('SOL to put in')).toBeNull();
    type(coinBox(panel, 'USDC'), '50');
    type(tokens(panel), '25');
    expect(row(panel, 'You put in')).toHaveTextContent('50 USDC and 25 tokens, exactly');
    // The locked part's worth is in USDC's own 6 decimals: 100 shares of isqrt(50,000,000 × 25,000,000) = 35,355,339
    // leave 142 units of USDC and 71 of the token behind (rounded up: what can never come back is not
    // understated). Printed with SOL's 9 it would read 0.000000142.
    expect(row(panel, 'Locked in the pool forever')).toHaveTextContent('0.0000001 pool shares (100 of the smallest unit), worth about 0.000142 USDC and 0.000071 tokens');
    // Two coins leave the wallet, and they are never added into one number. The SOL is
    // 0.19203928, said rounded UP: what the wallet must pay never reads as less than it is.
    expect(row(panel, 'In all, from your wallet')).toHaveTextContent('50 USDC and 25 tokens, and about 0.1921 SOL for the fee to open and the account deposits, plus the network fee');
    expect(reviewButton(panel)).toBeEnabled();
    await act(async () => {
      fireEvent.click(reviewButton(panel));
    });
    expect(prepareLpCreate).toHaveBeenCalledWith(conn.connection, expect.objectContaining({ kind: 'open' }), r, {
      owner: OWNER,
      tokenMint: MINT,
      quoteMint: new PublicKey(USDC),
      quote: 50_000_000n,
      token: 25_000_000n,
      shown: { terms: TERMS, standard: 'empty' },
    });
  });

  it('BAYLA, then 1000: 1,000,000,000 of BAYLA’s mint (6 decimals)', async () => {
    const prepareLpCreate = notBuilt();
    mount(readers(), { api: { prepareLpCreate } });
    const { panel } = await openPanel();
    await pair(panel, 'BAYLA');
    type(coinBox(panel, 'BAYLA'), '1000');
    type(tokens(panel), '10');
    expect(row(panel, 'You put in')).toHaveTextContent('1,000 BAYLA and 10 tokens, exactly');
    await act(async () => {
      fireEvent.click(reviewButton(panel));
    });
    expect(handed(prepareLpCreate)).toMatchObject({ quoteMint: new PublicKey(BAYLA), quote: 1_000_000_000n, token: 10_000_000n });
  });

  it('back on SOL after another coin, 1 is a whole SOL again: 1,000,000,000 lamports of the wrapped-SOL mint', async () => {
    const prepareLpCreate = notBuilt();
    mount(readers(), { api: { prepareLpCreate } });
    const { panel } = await openPanel();
    await pair(panel, 'USDC');
    await pair(panel, 'SOL');
    type(coinBox(panel, 'SOL'), '1');
    fireEvent.click(matchButton(panel));
    expect(tokens(panel)).toHaveValue('100');
    await act(async () => {
      fireEvent.click(reviewButton(panel));
    });
    expect(handed(prepareLpCreate)).toMatchObject({ quoteMint: new PublicKey(SOL_QUOTE.mint), quote: 1_000_000_000n, token: 100_000_000n });
  });

  it('USDC has 6 decimals: a seventh is refused under the box, where SOL would take nine', async () => {
    mount(readers());
    const { panel } = await openPanel();
    type(coinBox(panel, 'SOL'), '0.0000001');
    expect(panel).not.toHaveTextContent('That is not a SOL amount');
    await pair(panel, 'USDC');
    type(coinBox(panel, 'USDC'), '0.0000001');
    type(tokens(panel), '25');
    expect(panel).toHaveTextContent('That is not a USDC amount (at most 6 decimals).');
    expect(reviewButton(panel)).toBeDisabled();
    // The smallest USDC there is.
    type(coinBox(panel, 'USDC'), '0.000001');
    expect(panel).not.toHaveTextContent('That is not a USDC amount');
  });

  it('Max USDC is the wallet’s USDC, to the unit, and the hint says it in USDC', async () => {
    mount(readers());
    const { panel } = await openPanel();
    await pair(panel, 'USDC');
    expect(panel).toHaveTextContent('You have 250 USDC.');
    fireEvent.click(within(panel).getByRole('button', { name: 'Max USDC' }));
    expect(coinBox(panel, 'USDC')).toHaveValue('250');
  });

  it('more USDC than the wallet holds: said in USDC, and Use that much fits', async () => {
    mount(readers());
    const { panel } = await openPanel();
    await pair(panel, 'USDC');
    type(coinBox(panel, 'USDC'), '300');
    type(tokens(panel), '150');
    await waitFor(() => expect(within(panel).getByRole('alert')).toHaveTextContent('You have 250 USDC; this needs 300 USDC.'));
    expect(reviewButton(panel)).toBeDisabled();
    fireEvent.click(within(panel).getByRole('button', { name: 'Use 250 USDC' }));
    expect(coinBox(panel, 'USDC')).toHaveValue('250');
    // The coin side now drives: Match moves the tokens, not the USDC.
    fireEvent.click(matchButton(panel));
    expect(coinBox(panel, 'USDC')).toHaveValue('250');
    expect(tokens(panel)).toHaveValue('125');
    expect(reviewButton(panel)).toBeEnabled();
  });
});

describe('changing the coin', () => {
  it('empties the coin’s box and keeps the token amount, and the old coin’s balance is never shown under the new coin, not even while its own is read', async () => {
    // Each wallet read is answered by hand, so the test sees the moment between the change and the answer.
    const asks: Array<{ quote: QuoteCoin | undefined; answer: (f: WalletFacts) => void }> = [];
    const walletRead = vi.fn<WalletFn>((_o, _m, _p, _l, opts) => new Promise<WalletFacts>((answer) => asks.push({ quote: opts?.quote, answer })));
    mount(readers({ wallet: walletRead }));
    const { panel } = await openPanel();
    await waitFor(() => expect(asks).toHaveLength(1));
    // SOL is asked for exactly as it always was.
    expect(walletRead).toHaveBeenLastCalledWith(OWNER, M, TOKEN_PROGRAM, null, { opening: true });
    await act(async () => asks[0]!.answer(walletFor(undefined)));
    expect(panel).toHaveTextContent('You have 5 SOL.');
    type(coinBox(panel, 'SOL'), '1');
    type(tokens(panel), '100');
    expect(reviewButton(panel)).toBeEnabled();

    fireEvent.click(within(panel).getByRole('radio', { name: 'USDC' }));
    // At once, before any read answers: the coin's box is empty and nothing of SOL's is on
    // the form. The token amount stays: 100 tokens are 100 tokens under any coin.
    expect(coinBox(panel, 'USDC')).toHaveValue('');
    expect(tokens(panel)).toHaveValue('100');
    expect(within(panel).queryByLabelText('SOL to put in')).toBeNull();
    expect(within(panel).getAllByText('Reading your wallet…')).toHaveLength(2);
    expect(panel).not.toHaveTextContent('You have 5 SOL');
    expect(within(panel).queryByRole('button', { name: /^Max / })).toBeNull();
    expect(market(panel)).not.toHaveTextContent('0.01');
    expect(reviewButton(panel)).toBeDisabled();
    // The wallet is read again, for USDC.
    await waitFor(() => expect(asks).toHaveLength(2));
    expect(asks[1]!.quote).toBe(USDC_QUOTE);
    expect(walletRead).toHaveBeenLastCalledWith(OWNER, M, TOKEN_PROGRAM, null, { opening: true, quote: USDC_QUOTE });
    await act(async () => asks[1]!.answer(walletFor(USDC_QUOTE)));
    expect(panel).toHaveTextContent('You have 250 USDC.');

    type(coinBox(panel, 'USDC'), '50');
    type(tokens(panel), '25');
    fireEvent.click(within(panel).getByRole('radio', { name: 'BAYLA' }));
    expect(coinBox(panel, 'BAYLA')).toHaveValue('');
    expect(tokens(panel)).toHaveValue('25');
    expect(panel).not.toHaveTextContent('You have 250');
    expect(within(panel).getAllByText('Reading your wallet…')).toHaveLength(2);
    await waitFor(() => expect(asks).toHaveLength(3));
    expect(asks[2]!.quote).toBe(BAYLA_QUOTE);
    await act(async () => asks[2]!.answer(walletFor(BAYLA_QUOTE)));
    expect(panel).toHaveTextContent('You have 7,000 BAYLA.');

    // And back: SOL's own read, never BAYLA's number under SOL's name.
    type(coinBox(panel, 'BAYLA'), '7000');
    fireEvent.click(within(panel).getByRole('radio', { name: 'SOL' }));
    expect(coinBox(panel, 'SOL')).toHaveValue('');
    expect(panel).not.toHaveTextContent('You have 7,000');
    await waitFor(() => expect(asks).toHaveLength(4));
    expect(asks[3]!.quote).toBeUndefined();
  });

  it('a late answer for the coin that was left is dropped', async () => {
    const asks: Array<{ quote: QuoteCoin | undefined; answer: (f: WalletFacts) => void }> = [];
    mount(readers({ wallet: vi.fn<WalletFn>((_o, _m, _p, _l, opts) => new Promise<WalletFacts>((answer) => asks.push({ quote: opts?.quote, answer }))) }));
    const { panel } = await openPanel();
    await waitFor(() => expect(asks).toHaveLength(1));
    fireEvent.click(within(panel).getByRole('radio', { name: 'USDC' }));
    await waitFor(() => expect(asks).toHaveLength(2));
    // SOL's answer arrives after the change: it is not USDC's, and is not shown.
    await act(async () => asks[0]!.answer(walletFor(undefined)));
    expect(panel).not.toHaveTextContent('You have 5 SOL');
    expect(within(panel).getAllByText('Reading your wallet…')).toHaveLength(2);
  });

  // The problems line is kept for half a second after it changes (it is read out once
  // typing settles). A change of coin inside that half second must not bring the old
  // coin's line back on the new coin's form.
  it('a problems line that settled under one coin is not shown again under the next', async () => {
    mount(readers());
    const { panel } = await openPanel();
    await within(panel).findByRole('button', { name: 'Max SOL' });
    // At the market, and more SOL than the wallet can put in after the costs.
    type(coinBox(panel, 'SOL'), '4.9');
    type(tokens(panel), '490');
    const alert = within(panel).getByRole('alert');
    await waitFor(() => expect(alert).toHaveTextContent(/The most you can put in from this wallet is 4\.80491144 SOL\./));
    fireEvent.click(within(panel).getByRole('radio', { name: 'USDC' }));
    expect(alert).toHaveTextContent('');
    // Typed at once: 20 units of USDC and 10 of the token, at the market and too small
    // for any pool, so a new problem exists straight away.
    type(coinBox(panel, 'USDC'), '0.00002');
    type(tokens(panel), '0.00001');
    expect(alert).not.toHaveTextContent('SOL');
    expect(alert).toHaveTextContent('');
    await waitFor(() => expect(alert).toHaveTextContent(/^Too small: the pool program keeps/));
  });

  it('a wallet answer with no coin in it is unread for that coin, never 0 and never the wallet’s SOL', async () => {
    // A read that answered as it does for a SOL pool: nothing in it is about USDC.
    mount(readers({ wallet: vi.fn<WalletFn>(async () => walletFor(undefined)) }));
    const { panel } = await openPanel();
    fireEvent.click(within(panel).getByRole('radio', { name: 'USDC' }));
    await waitFor(() => expect(panel).toHaveTextContent('You have: could not read (this wallet’s USDC was not read)'));
    expect(within(panel).queryByRole('button', { name: 'Max USDC' })).toBeNull();
    expect(panel).not.toHaveTextContent('You have 0 USDC');
    expect(panel).not.toHaveTextContent('You have 5 SOL.');
    expect(within(panel).queryByTestId('lp-create-cannot')).toBeNull();
  });

  it('one coin’s price is never shown as another’s: BAYLA says "reading" until BAYLA’s own price is in', async () => {
    let releaseBayla!: (p: OutsidePrice) => void;
    const outsidePrice = vi.fn((mint: string) => (mint === BAYLA ? new Promise<OutsidePrice>((res) => (releaseBayla = res)) : Promise.resolve(priceOf(mint))));
    mount(readers({ outsidePrice }));
    const { panel } = await openPanel();
    await pair(panel, 'USDC');
    await waitFor(() => expect(market(panel)).toHaveTextContent('1 token = 2 USDC.'));
    fireEvent.click(within(panel).getByRole('radio', { name: 'BAYLA' }));
    // USDC's price was read; BAYLA's was not. Nothing is priced in BAYLA yet.
    expect(market(panel)).toHaveTextContent('Market price in BAYLA: reading the price of BAYLA from Jupiter…');
    expect(market(panel)).not.toHaveTextContent('1 token =');
    await within(panel).findByRole('button', { name: 'Max BAYLA' });
    type(coinBox(panel, 'BAYLA'), '50');
    type(tokens(panel), '25');
    // 2 BAYLA a token would be at USDC's market. It is not checked against USDC's.
    expect(price(panel)).toHaveAttribute('data-price', 'unread');
    expect(reviewButton(panel)).toBeDisabled();
    await act(async () => releaseBayla(priceOf(BAYLA)));
    expect(market(panel)).toHaveTextContent('1 token = 100 BAYLA.');
    expect(price(panel)).toHaveAttribute('data-price', 'disagrees');
  });
});

describe('the market price in the coin', () => {
  it('SOL asks for no coin price; USDC asks for USDC’s own, with USDC’s decimals', async () => {
    const r = readers();
    mount(r);
    const { panel } = await openPanel();
    await within(panel).findByRole('button', { name: 'Max SOL' });
    expect(r.outsidePrice).toHaveBeenCalledTimes(1);
    expect(r.outsidePrice).toHaveBeenCalledWith(M, 6);
    expect(market(panel)).toHaveTextContent(/^Market price \(Jupiter, read \d\d:\d\d:\d\d\): 1 token = 0\.01 SOL\.$/);
    await pair(panel, 'USDC');
    await waitFor(() => expect(r.outsidePrice).toHaveBeenCalledWith(USDC, 6));
    expect(r.outsidePrice).toHaveBeenCalledTimes(2);
    // 0.01 SOL a token over 0.005 SOL a USDC.
    await waitFor(() => expect(market(panel)).toHaveTextContent(/^Market price \(Jupiter, read \d\d:\d\d:\d\d\): 1 token = 2 USDC\.$/));
  });

  it('while the coin’s price is still being read: Review is off and the form says which price is missing', async () => {
    let release!: (p: OutsidePrice) => void;
    const outsidePrice = vi.fn((mint: string) => (mint === USDC ? new Promise<OutsidePrice>((res) => (release = res)) : Promise.resolve(priceOf(mint))));
    mount(readers({ outsidePrice }));
    const { panel } = await openPanel();
    await pair(panel, 'USDC');
    expect(market(panel)).toHaveTextContent('Market price in USDC: reading the price of USDC from Jupiter…');
    type(coinBox(panel, 'USDC'), '50');
    type(tokens(panel), '25');
    expect(price(panel)).toHaveAttribute('data-price', 'unread');
    // Not read yet is said as that. "There is no market price" is a different answer, and an allowed one.
    expect(price(panel)).toHaveTextContent('Your opening price: 1 token = 2 USDC. It is not checked: the market price has not been read.');
    expect(price(panel)).not.toHaveTextContent('There is no market price');
    expect(within(panel).queryByTestId('lp-create-warnings')).toBeNull();
    expect(matchButton(panel)).toBeDisabled();
    expect(reviewButton(panel)).toBeDisabled();
    expect(within(panel).getByTestId('lp-create-coin-price')).toHaveTextContent('Review is off while the price of USDC is read: your opening price is checked in USDC.');
    await act(async () => release(priceOf(USDC)));
    expect(price(panel)).toHaveAttribute('data-price', 'agrees');
    expect(within(panel).queryByTestId('lp-create-coin-price')).toBeNull();
    expect(reviewButton(panel)).toBeEnabled();
  });

  it('when the coin’s price could not be read: Review is off, it says so, and Read again reads it again', async () => {
    const usdc = vi
      .fn<() => Promise<OutsidePrice>>()
      .mockResolvedValueOnce({ kind: 'unread', detail: 'Jupiter did not give a price (HTTP 502)' })
      .mockResolvedValue(priceOf(USDC));
    mount(readers({ outsidePrice: vi.fn((mint: string) => (mint === USDC ? usdc() : Promise.resolve(priceOf(mint)))) }));
    const { panel } = await openPanel();
    await pair(panel, 'USDC');
    await waitFor(() =>
      expect(market(panel)).toHaveTextContent(
        'Market price in USDC: could not be worked out (the price of USDC could not be read (Jupiter did not give a price (HTTP 502))).',
      ),
    );
    type(coinBox(panel, 'USDC'), '50');
    type(tokens(panel), '25');
    // A read that FAILED is not an answer: unread, never a warning in its place, and
    // Review stays off. (Jupiter ANSWERING "no route" for the coin is the test further down.)
    expect(price(panel)).toHaveAttribute('data-price', 'unread');
    expect(within(panel).queryByTestId('lp-create-warnings')).toBeNull();
    expect(reviewButton(panel)).toBeDisabled();
    expect(within(panel).getByTestId('lp-create-coin-price')).toHaveTextContent(
      'Review is off: the price of USDC could not be read, so your opening price cannot be checked in USDC. Press Read the market price again.',
    );
    // Never a price of 0, and never the token's SOL price standing in.
    expect(market(panel)).not.toHaveTextContent('1 token =');
    const again = within(panel).getByTestId('lp-create-market-again');
    fireEvent.click(within(again).getByRole('button', { name: 'Read the market price again' }));
    await waitFor(() => expect(usdc).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(market(panel)).toHaveTextContent('1 token = 2 USDC.'));
    await waitFor(() => expect(within(again).getByRole('status')).toHaveTextContent('Read again just now: the market price above is new.'));
    expect(within(panel).queryByTestId('lp-create-coin-price')).toBeNull();
    expect(reviewButton(panel)).toBeEnabled();
  }, LONG);

  it('a read-again waits for BOTH prices: with the token’s back and the coin’s still out, Review stays off', async () => {
    let release!: (p: OutsidePrice) => void;
    const usdc = vi
      .fn<() => Promise<OutsidePrice>>()
      .mockResolvedValueOnce(priceOf(USDC))
      .mockImplementationOnce(() => new Promise<OutsidePrice>((res) => (release = res)));
    mount(readers({ outsidePrice: vi.fn((mint: string) => (mint === USDC ? usdc() : Promise.resolve(priceOf(mint)))) }));
    const { panel } = await openPanel();
    await pair(panel, 'USDC');
    type(coinBox(panel, 'USDC'), '50');
    type(tokens(panel), '25');
    await waitFor(() => expect(reviewButton(panel)).toBeEnabled());
    const again = within(panel).getByTestId('lp-create-market-again');
    fireEvent.click(within(again).getByRole('button', { name: 'Read the market price again' }));
    await waitFor(() => expect(usdc).toHaveBeenCalledTimes(2));
    // The token and its pools are back; USDC's price is not.
    await waitFor(() => expect(screen.queryByText('Reading the token and its pools again…')).toBeNull());
    expect(reviewButton(panel)).toBeDisabled();
    expect(within(again).getByRole('button', { name: 'Read the market price again' })).toHaveAttribute('aria-disabled', 'true');
    expect(within(again).getByRole('status')).toHaveTextContent('Reading the market price again…');
    expect(within(panel).getByTestId('lp-create-coin-price')).toHaveTextContent('Review is off while the price of USDC is read');
    await act(async () => release(priceOf(USDC)));
    await waitFor(() => expect(within(again).getByRole('status')).toHaveTextContent('Read again just now: the same answer.'));
    expect(reviewButton(panel)).toBeEnabled();
  }, LONG);

  it('what the last Read again found was about one coin’s price: it is not said under the next coin', async () => {
    mount(readers());
    const { panel } = await openPanel();
    await pair(panel, 'USDC');
    await waitFor(() => expect(market(panel)).toHaveTextContent('1 token = 2 USDC.'));
    const again = within(panel).getByTestId('lp-create-market-again');
    fireEvent.click(within(again).getByRole('button', { name: 'Read the market price again' }));
    await waitFor(() => expect(within(again).getByRole('status')).toHaveTextContent('Read again just now: the same answer.'));
    fireEvent.click(within(panel).getByRole('radio', { name: 'BAYLA' }));
    expect(within(again).getByRole('status')).toHaveTextContent('');
  }, LONG);
});

describe('the opening price is checked in the coin', () => {
  it('at the market in USDC it passes; Match and the most-both button work in USDC', async () => {
    mount(readers());
    const { panel } = await openPanel();
    await pair(panel, 'USDC');
    type(coinBox(panel, 'USDC'), '50');
    fireEvent.click(matchButton(panel));
    // 50 USDC at 2 USDC a token.
    expect(tokens(panel)).toHaveValue('25');
    expect(price(panel)).toHaveAttribute('data-price', 'agrees');
    expect(price(panel)).toHaveTextContent('Your opening price: 1 token = 2 USDC. Market: 2 USDC. Yours is 0.0% above the market. Close enough to the market.');
    expect(reviewButton(panel)).toBeEnabled();
    // What a screen reader hears once typing settles is in USDC too. isqrt(50,000,000 × 25,000,000) − 100.
    await waitFor(() => expect(panel.querySelector('p.sr-only[role="status"]')).toHaveTextContent('You would open the pool at 1 token = 2 USDC and get 0.035355239 pool shares.'));
    // The token box typed last: Match works the USDC out from it.
    type(tokens(panel), '10');
    fireEvent.click(matchButton(panel));
    expect(coinBox(panel, 'USDC')).toHaveValue('20');
    // All 250 USDC takes 125 of the wallet's 500 tokens.
    fireEvent.click(within(panel).getByRole('button', { name: 'Use the most both balances allow' }));
    expect(coinBox(panel, 'USDC')).toHaveValue('250');
    expect(tokens(panel)).toHaveValue('125');
    expect(price(panel)).toHaveAttribute('data-price', 'agrees');
    expect(reviewButton(panel)).toBeEnabled();
  });

  // Owner ruling 2026-10-04: a price off the market is a warning, and Review stays on. The
  // gap and the loss are in the pool's own coin: 6 decimals for USDC, never SOL's 9.
  it('2.9% off passes with no warning; 3.1% off is warned about, with the estimated loss said in USDC, and Review stays ON', async () => {
    const prepareLpCreate = notBuilt();
    mount(readers(), { api: { prepareLpCreate } });
    const { panel } = await openPanel();
    await pair(panel, 'USDC');
    type(tokens(panel), '25');
    // 51.45 USDC for 25 tokens is 2.058 USDC a token: 2.9% above 2.
    type(coinBox(panel, 'USDC'), '51.45');
    expect(price(panel)).toHaveAttribute('data-price', 'agrees');
    expect(within(panel).queryByTestId('lp-create-warnings')).toBeNull();
    expect(reviewButton(panel)).toBeEnabled();
    // 51.55 is 2.062: 3.1% above.
    type(coinBox(panel, 'USDC'), '51.55');
    expect(price(panel)).toHaveAttribute('data-price', 'disagrees');
    expect(price(panel)).toHaveTextContent('Your opening price: 1 token = 2.062 USDC. Market: 2 USDC. Yours is 3.1% above the market.');
    expect(price(panel)).not.toHaveTextContent('Close enough');
    const warnings = within(panel).getByTestId('lp-create-warnings');
    expect(warnings).toHaveTextContent('Your opening price is 3.1% above the market price (Jupiter). The first trades would move it to the market price, at your cost.');
    // (√51.55 − √(25 × 2))² USDC = 0.011829… USDC: 11,830 of USDC's smallest unit, rounded up.
    // Worked out or printed with SOL's 9 decimals it would not read 0.01183 USDC.
    expect(warnings).toHaveTextContent('At these amounts, a move back to the market price would take up to about 0.01183 USDC of what you put in. That is an estimate.');
    expect(warnings).not.toHaveTextContent('SOL');
    expect(panel).not.toHaveTextContent(/must start within|within 3%/);
    expect(within(panel).getByRole('alert')).toHaveTextContent('');
    expect(reviewButton(panel)).toBeEnabled();
    // What a screen reader hears once typing settles is in USDC too.
    await waitFor(() =>
      expect(panel.querySelector('p.sr-only[role="status"]')).toHaveTextContent(/^You would open the pool at 1 token = 2\.062 USDC and get [\d.]+ pool shares\. That price is 3\.1% above the market price:/),
    );
    // The warning's own Match keeps the USDC (typed last) and moves the tokens.
    fireEvent.click(within(warnings).getByRole('button', { name: 'Match the market price' }));
    expect(coinBox(panel, 'USDC')).toHaveValue('51.55');
    expect(tokens(panel)).toHaveValue('25.775');
    expect(within(panel).queryByTestId('lp-create-warnings')).toBeNull();
    expect(reviewButton(panel)).toBeEnabled();
    // Off the market again and reviewed as it is: USDC's mint and USDC's base units.
    type(tokens(panel), '25');
    await act(async () => {
      fireEvent.click(reviewButton(panel));
    });
    expect(handed(prepareLpCreate)).toMatchObject({ quoteMint: new PublicKey(USDC), quote: 51_550_000n, token: 25_000_000n });
  });

  it('a price that would be at the market only if USDC were read as SOL is warned about, in USDC', async () => {
    mount(readers());
    const { panel } = await openPanel();
    await pair(panel, 'USDC');
    // 0.25 USDC for 25 tokens is 0.01 USDC a token: the very number of the token's SOL
    // price (0.01 SOL). In USDC the market is 2, so this is 99.5% below it.
    type(coinBox(panel, 'USDC'), '0.25');
    type(tokens(panel), '25');
    expect(price(panel)).toHaveAttribute('data-price', 'disagrees');
    expect(price(panel)).toHaveTextContent('Your opening price: 1 token = 0.01 USDC. Market: 2 USDC. Yours is 99.5% below the market.');
    expect(price(panel)).not.toHaveTextContent('Close enough');
    const warnings = within(panel).getByTestId('lp-create-warnings');
    expect(warnings).toHaveTextContent('Your opening price is 99.5% below the market price (Jupiter).');
    // (√0.25 − √50)² USDC: nearly all of the 50 USDC the tokens are worth.
    expect(warnings).toHaveTextContent('would take up to about 43.178933 USDC of what you put in');
    // The opener's choice now: Review is on.
    expect(reviewButton(panel)).toBeEnabled();
    // The same amounts on SOL are at SOL's market: the check is each coin's own.
    await pair(panel, 'SOL');
    type(coinBox(panel, 'SOL'), '0.25');
    expect(tokens(panel)).toHaveValue('25');
    expect(price(panel)).toHaveAttribute('data-price', 'agrees');
    expect(within(panel).queryByTestId('lp-create-warnings')).toBeNull();
  });
});

describe('where the pool goes: each pair has its own standard address', () => {
  it('a SOL pool at the SOL pair’s standard address does not move a USDC opening off its own', async () => {
    const prepareLpCreate = notBuilt();
    mount(readers({ findPools: vi.fn(async () => search([], { taken: ['SOL'] })) }), { api: { prepareLpCreate } });
    const { panel } = await openPanel();
    expect(row(panel, 'Pool address')).toHaveTextContent('a new address of its own (the standard address is already taken)');
    await pair(panel, 'USDC');
    expect(row(panel, 'Pool address')).toHaveTextContent('the standard address for fee tier 1');
    type(coinBox(panel, 'USDC'), '50');
    type(tokens(panel), '25');
    await act(async () => {
      fireEvent.click(reviewButton(panel));
    });
    expect(handed(prepareLpCreate)).toMatchObject({ quoteMint: new PublicKey(USDC), shown: { standard: 'empty' } });
  });

  it('and a USDC pool at the USDC pair’s address moves a USDC opening, not a SOL one', async () => {
    const prepareLpCreate = notBuilt();
    mount(readers({ findPools: vi.fn(async () => search([], { taken: ['USDC'] })) }), { api: { prepareLpCreate } });
    const { panel } = await openPanel();
    expect(row(panel, 'Pool address')).toHaveTextContent('the standard address for fee tier 1');
    await pair(panel, 'BAYLA');
    expect(row(panel, 'Pool address')).toHaveTextContent('the standard address for fee tier 1');
    await pair(panel, 'USDC');
    expect(row(panel, 'Pool address')).toHaveTextContent('a new address of its own (the standard address is already taken)');
    type(coinBox(panel, 'USDC'), '50');
    type(tokens(panel), '25');
    await act(async () => {
      fireEvent.click(reviewButton(panel));
    });
    expect(handed(prepareLpCreate)).toMatchObject({ quoteMint: new PublicKey(USDC), shown: { standard: 'taken' } });
  });
});

describe('the pool to add to first is the chosen coin’s (advice, never a block)', () => {
  // The owner's own case.
  it('BAYLA has a SOL pool and he picks USDC: nothing tells him a pool exists for it, and Review is on', async () => {
    const baylaKey = new PublicKey(BAYLA);
    // 10 SOL and 100,000 BAYLA: 0.0001 SOL a BAYLA, the market.
    const solPool = view({ mint: baylaKey, tokens: 100_000n * UNIT.BAYLA });
    const prepareLpCreate = notBuilt();
    const r = readers({
      findPools: vi.fn(async () => search([solPool], { mint: BAYLA })),
      wallet: vi.fn<WalletFn>(async (_o, _m, _p, _l, opts) => walletFor(opts?.quote, { token: { address: key().toBase58(), amount: 1_000_000n * UNIT.BAYLA } })),
    });
    mount(r, { api: { prepareLpCreate }, mint: BAYLA });
    const { card, panel } = await openPanel();

    // The card: the SOL pool, in the words it has always had, and which coin has no pool yet.
    expect(card).toHaveAttribute('data-advice', 'exists');
    const refer = within(card).getByTestId('lp-create-refer');
    expect(refer).toHaveAttribute('data-coin', 'SOL');
    expect(refer).toHaveTextContent(
      `This token already has a pool on the public fee tier that passes the checks (above). The biggest is ${solPool.address}, holding 10 SOL. We suggest adding to it: liquidity in one place gives traders a better price.`,
    );
    // The card names the way to it before the form is open: the owner could not see how to open a BAYLA/USDC pool.
    expect(within(card).getByTestId('lp-create-none-yet')).toHaveTextContent('This token has no USDC pool yet. Open a pool lets you choose what to pair it with.');
    expect(within(card).getByRole('button', { name: 'Add liquidity to that pool' })).toBeEnabled();
    expect(within(card).getByRole('button', { name: 'Open a pool' })).toBeEnabled();

    // The form, on SOL: the pool that exists is said.
    expect(within(panel).getByTestId('lp-create-advice')).toHaveTextContent(
      'This token already has a pool that passes the checks (the card above names it). Opening here makes a separate pool: it does not share that pool’s liquidity or fees.',
    );
    expect(within(panel).queryByTestId('lp-create-first')).toBeNull();

    // On USDC: no pool exists for it, and nothing says one does.
    await pair(panel, 'USDC');
    expect(within(panel).queryByTestId('lp-create-advice')).toBeNull();
    expect(panel).not.toHaveTextContent(/already has|You opened/);
    expect(within(panel).getByTestId('lp-create-first')).toHaveTextContent('No pool pairs this token with USDC yet. Yours would be the first.');
    // 50 USDC and 2,500 BAYLA: 0.02 USDC a BAYLA, the market.
    type(coinBox(panel, 'USDC'), '50');
    type(tokens(panel), '2500');
    expect(price(panel)).toHaveAttribute('data-price', 'agrees');
    expect(price(panel)).toHaveTextContent('Your opening price: 1 token = 0.02 USDC. Market: 0.02 USDC.');
    expect(reviewButton(panel)).toBeEnabled();
    await act(async () => {
      fireEvent.click(reviewButton(panel));
    });
    expect(prepareLpCreate).toHaveBeenCalledWith(conn.connection, expect.objectContaining({ kind: 'open' }), r, {
      owner: OWNER,
      tokenMint: baylaKey,
      quoteMint: new PublicKey(USDC),
      quote: 50_000_000n,
      token: 2_500_000_000n,
      shown: { terms: TERMS, standard: 'empty' },
    });
  }, LONG);

  it('a SOL pool and a USDC pool: each has its own line in its own coin and its own Add button, and the form follows the chosen coin', async () => {
    const solPool = view();
    const usdcPool = view({ quote: USDC_QUOTE });
    mount(readers({ findPools: vi.fn(async () => search([solPool, usdcPool])) }));
    const card = await offered();
    const refers = within(card).getAllByTestId('lp-create-refer');
    expect(refers.map((p) => p.getAttribute('data-coin'))).toEqual(['SOL', 'USDC']);
    expect(refers[0]).toHaveTextContent(`This token already has a SOL pool on the public fee tier that passes the checks (above). The biggest is ${solPool.address}, holding 10 SOL.`);
    expect(refers[1]).toHaveTextContent(`This token already has a USDC pool on the public fee tier that passes the checks (above). The biggest is ${usdcPool.address}, holding 2,000 USDC.`);
    expect(within(card).getByTestId('lp-create-none-yet')).toHaveTextContent('This token has no BAYLA pool yet.');
    expect(within(card).getByTestId('lp-create-still')).toHaveTextContent(
      "You can still open your own on the public fee tier (1% a trade, 0.15 SOL to open). It will be a separate pool: it does not share the other pools' liquidity or fees.",
    );
    // With more than one, each button says its coin: "that pool" would be a guess.
    expect(within(card).queryByRole('button', { name: 'Add liquidity to that pool' })).toBeNull();
    expect(within(card).getByRole('button', { name: 'Add liquidity to the SOL pool' })).toBeEnabled();
    expect(within(card).getByRole('button', { name: 'Open a pool' })).toBeEnabled();
    // The USDC button opens the USDC pool's own Add form, in that pool's card.
    fireEvent.click(within(card).getByRole('button', { name: 'Add liquidity to the USDC pool' }));
    const add = await screen.findByTestId('lp-add-panel');
    const usdcCard = screen.getAllByTestId('lp-pool').find((c) => c.getAttribute('data-pool') === usdcPool.address)!;
    expect(usdcCard).toContainElement(add);

    fireEvent.click(within(card).getByRole('button', { name: 'Open a pool' }));
    const panel = await screen.findByTestId('lp-create-panel');
    expect(within(panel).getByTestId('lp-create-advice')).toHaveTextContent('This token already has a SOL pool that passes the checks (the card above names it).');
    await pair(panel, 'USDC');
    expect(within(panel).getByTestId('lp-create-advice')).toHaveTextContent('This token already has a USDC pool that passes the checks (the card above names it).');
    expect(within(panel).queryByTestId('lp-create-first')).toBeNull();
    await pair(panel, 'BAYLA');
    expect(within(panel).queryByTestId('lp-create-advice')).toBeNull();
    expect(within(panel).getByTestId('lp-create-first')).toHaveTextContent('No pool pairs this token with BAYLA yet. Yours would be the first.');
  }, LONG);

  it('only a USDC pool: the card names it in USDC and says SOL and BAYLA have none; the SOL form says what it always said', async () => {
    const usdcPool = view({ quote: USDC_QUOTE });
    mount(readers({ findPools: vi.fn(async () => search([usdcPool])) }));
    const { card, panel } = await openPanel();
    expect(card).toHaveAttribute('data-advice', 'exists');
    const refer = within(card).getByTestId('lp-create-refer');
    expect(refer).toHaveAttribute('data-coin', 'USDC');
    expect(refer).toHaveTextContent(`This token already has a USDC pool on the public fee tier that passes the checks (above). The biggest is ${usdcPool.address}, holding 2,000 USDC.`);
    expect(within(card).getByTestId('lp-create-none-yet')).toHaveTextContent('This token has no SOL or BAYLA pool yet.');
    expect(within(card).getByRole('button', { name: 'Add liquidity to that pool' })).toBeEnabled();
    // On SOL (where the form starts) no pool exists, and the SOL form adds no line of its own.
    expect(within(panel).queryByTestId('lp-create-advice')).toBeNull();
    expect(within(panel).queryByTestId('lp-create-first')).toBeNull();
    await pair(panel, 'USDC');
    expect(within(panel).getByTestId('lp-create-advice')).toHaveTextContent(
      'This token already has a USDC pool that passes the checks (the card above names it). Opening here makes a separate pool: it does not share that pool’s liquidity or fees.',
    );
    // Advice, never a block.
    type(coinBox(panel, 'USDC'), '50');
    type(tokens(panel), '25');
    expect(reviewButton(panel)).toBeEnabled();
  });

  // Owner ruling 2026-10-07: Jupiter has no price for the COIN the pool is paired with. The
  // pool still takes deposits, with a warning, so the card still points to it and keeps its
  // Add button. What it says of that pool names the coin: the token has a price, so nothing
  // may say "Jupiter has no market price for this token".
  it('a USDC pool when Jupiter has no price for USDC itself: the card points to it, names USDC, never "this token", and keeps Add', async () => {
    const usdcPool = view({ quote: USDC_QUOTE });
    const noRoute = { kind: 'no-route' as const, detail: 'Jupiter has no route for this token' };
    mount(readers({ findPools: vi.fn(async () => search([usdcPool])), outsidePrice: vi.fn(async (mint: string) => (mint === USDC ? noRoute : priceOf(mint))) }));
    const card = await offered();
    const pool = await screen.findByTestId('lp-pool');
    await waitFor(() => expect(pool).toHaveAttribute('data-add', 'offer'));
    expect(pool).toHaveAttribute('data-price', 'no-market');
    const refer = within(card).getByTestId('lp-create-refer');
    expect((refer.textContent ?? '').replace(/\s+/g, ' ').trim()).toBe(
      `This token already has a USDC pool on the public fee tier that takes deposits, with a warning (above). The biggest is ${usdcPool.address}, holding 2,000 USDC. Jupiter has no price for USDC right now, so that pool’s price in USDC was not checked against anything. Adding to it keeps liquidity in one place; a pool of your own starts at the price you set.`,
    );
    expect(card).not.toHaveTextContent(/no market price for this token|passes the checks|We suggest adding to it/);
    expect(within(card).getByRole('button', { name: 'Add liquidity to that pool' })).toBeEnabled();
    expect(within(card).getByRole('button', { name: 'Open a pool' })).toBeEnabled();
  });

  it('Create a pool on the first screen lands on the card, not in the form, when ANY coin has a pool to add to', async () => {
    const usdcPool = view({ quote: USDC_QUOTE });
    mount(readers({ findPools: vi.fn(async () => search([usdcPool])) }));
    const card = await offered();
    fireEvent.click(within(screen.getByTestId('lp-finder')).getByRole('button', { name: 'Create a pool' }));
    await act(async () => {});
    expect(card).toHaveAttribute('data-advice', 'exists');
    expect(within(card).getByRole('button', { name: 'Add liquidity to that pool' })).toBeEnabled();
    expect(screen.queryByTestId('lp-create-panel')).toBeNull();
  });

  it('…and straight into the form when no coin has one', async () => {
    // A USDC pool that does not pass its checks (not open yet) is no pool to add to.
    const failing = view({ quote: USDC_QUOTE, openTime: 10n ** 12n });
    mount(readers({ findPools: vi.fn(async () => search([failing])) }));
    const card = await offered();
    expect(card).toHaveAttribute('data-advice', 'none');
    expect(within(card).getByTestId('lp-create-none-yet')).toHaveTextContent('This token has no SOL or BAYLA pool yet.');
    fireEvent.click(within(screen.getByTestId('lp-finder')).getByRole('button', { name: 'Create a pool' }));
    const panel = await screen.findByTestId('lp-create-panel');
    // USDC has a pool, so a USDC opening is not called the first; it passes no check, so it is not pointed to.
    await pair(panel, 'USDC');
    expect(within(panel).queryByTestId('lp-create-first')).toBeNull();
    expect(within(panel).queryByTestId('lp-create-advice')).toBeNull();
  });

  it('a pool with a coin that this tab opened: the card and the form say so for that coin only', async () => {
    const mine = view({ quote: USDC_QUOTE, openTime: 10n ** 12n });
    rememberCreatedPool(mine.address);
    mount(readers({ findPools: vi.fn(async () => search([mine])) }));
    const { card, panel } = await openPanel();
    expect(card).toHaveAttribute('data-advice', 'opened-here');
    const opened = within(card).getByTestId('lp-create-opened');
    expect(opened).toHaveAttribute('data-coin', 'USDC');
    expect(opened).toHaveTextContent(`You opened a USDC pool for this token just now (${mine.address}). Your share is under 'Your positions'. Adding to it keeps your liquidity in one place.`);
    expect(within(card).getByTestId('lp-create-still')).toHaveTextContent(
      'You can still open another on the public fee tier (1% a trade, 0.15 SOL to open). It will be a separate pool, and the fee to open is paid again.',
    );
    expect(within(panel).queryByTestId('lp-create-advice')).toBeNull();
    await pair(panel, 'USDC');
    expect(within(panel).getByTestId('lp-create-advice')).toHaveTextContent(
      'You opened a USDC pool for this token just now. Opening again makes a second, separate pool and pays the fee to open again.',
    );
  });

  it('a cut pool list never calls a USDC opening "the first": a pool that was not read may be paired with USDC', async () => {
    mount(readers({ findPools: vi.fn(async () => search([], { truncated: true })) }));
    const { card, panel } = await openPanel();
    expect(card).toHaveTextContent('For each coin a pool can be paired with, the index lists the ones holding the most of that coin');
    expect(within(card).queryByTestId('lp-create-none-yet')).toBeNull();
    await pair(panel, 'USDC');
    const line = within(panel).getByTestId('lp-create-first');
    expect(line).toHaveTextContent('None of the pools read for this token is paired with USDC. This token has more pools than our pool index lists, so one that was not read may be.');
    expect(line).not.toHaveTextContent(/first/i);
  });
});

describe('what the wallet can put in, for a coin that is not SOL', () => {
  // The SOL a USDC opening needs: (10,000 + 1,000,000) for two signatures and the
  // reserve, 2,039,280 for the pool-share account, 150,000,000 + 40,000,000 for the fee
  // and the deposits, and 890,880 kept in the wallet. No wrapped-SOL account is opened.
  const NEEDS = 193_940_160n;

  it('USDC in hand but one lamport too little SOL for the fee: told so in SOL, and Review is off', async () => {
    mount(readers({ wallet: vi.fn<WalletFn>(async (_o, _m, _p, _l, opts) => walletFor(opts?.quote, { lamports: NEEDS - 1n })) }));
    const { panel } = await openPanel();
    await pair(panel, 'USDC');
    const cannot = within(panel).getByTestId('lp-create-cannot');
    expect(cannot).toHaveTextContent(
      'This wallet cannot open a pool yet. That needs about 0.194 SOL for the fee to open, the account deposits and network fees, and this wallet has 0.193940159 SOL. No SOL goes into the pool, but those costs are paid in SOL.',
    );
    expect(cannot).toHaveTextContent('Send SOL to this wallet, then come back to this tab.');
    // The line under the boxes states the same need, and states it the same way: rounded
    // UP. Cut down it read "needs about 0.1939 SOL ... and has 0.193940159 SOL", which
    // looks like enough and is one lamport short (whole-change review, 2026-10-04).
    const paid = within(panel).getByTestId('lp-create-paid-in-sol');
    expect(paid).toHaveTextContent('This wallet needs about 0.194 SOL for them and has 0.193940159 SOL.');
    expect(paid).not.toHaveTextContent('0.1939 SOL');
    // It holds the USDC and the tokens: nothing else is said to be missing.
    expect(cannot).not.toHaveTextContent(/holds no|none of this token/);
    // Amounts the USDC and the tokens cover, at the market: only the SOL stops it.
    type(coinBox(panel, 'USDC'), '50');
    type(tokens(panel), '25');
    expect(price(panel)).toHaveAttribute('data-price', 'agrees');
    expect(within(panel).getByRole('alert')).toHaveTextContent('');
    expect(reviewButton(panel)).toBeDisabled();
    expect(within(panel).getByTestId('lp-review-why')).toHaveTextContent('Review is off for this wallet: the top of this form says what it is short of.');
  });

  it('exactly the SOL it needs: nothing is said, and Review is on', async () => {
    mount(readers({ wallet: vi.fn<WalletFn>(async (_o, _m, _p, _l, opts) => walletFor(opts?.quote, { lamports: NEEDS })) }));
    const { panel } = await openPanel();
    await pair(panel, 'USDC');
    expect(within(panel).queryByTestId('lp-create-cannot')).toBeNull();
    type(coinBox(panel, 'USDC'), '50');
    type(tokens(panel), '25');
    expect(reviewButton(panel)).toBeEnabled();
  });

  it('no USDC at all: told so, with the way to get some; a wallet with no USDC account holds a real 0', async () => {
    const none = (quote: QuoteCoin | undefined) => walletFor(quote, quote && !quote.native ? { coin: { address: key().toBase58(), exists: false, amount: 0n } } : {});
    mount(readers({ wallet: vi.fn<WalletFn>(async (_o, _m, _p, _l, opts) => none(opts?.quote)) }));
    const { panel } = await openPanel();
    await pair(panel, 'USDC');
    expect(panel).toHaveTextContent('You have 0 USDC.');
    const cannot = within(panel).getByTestId('lp-create-cannot');
    expect(cannot).toHaveTextContent('This wallet holds no USDC, so it cannot open a pool yet. A pool needs both USDC and the token.');
    expect(within(cannot).getByRole('link', { name: 'this site’s Solana swap' })).toHaveAttribute('href', `/solana?out=${USDC}`);
    type(coinBox(panel, 'USDC'), '50');
    type(tokens(panel), '25');
    expect(reviewButton(panel)).toBeDisabled();
  });

  it('the fee to open is paid in SOL, and the form says so only when the coin is not SOL', async () => {
    mount(readers());
    const { panel } = await openPanel();
    await within(panel).findByRole('button', { name: 'Max SOL' });
    expect(within(panel).queryByTestId('lp-create-paid-in-sol')).toBeNull();
    expect(within(panel).getByTestId('lp-before-you-open')).not.toHaveTextContent('Both are paid in SOL');
    expect(panel).toHaveTextContent('Your SOL is wrapped into a token account for the opening, and that account is closed in the same transaction.');
    await pair(panel, 'USDC');
    expect(within(panel).getByTestId('lp-create-paid-in-sol')).toHaveTextContent(
      // 0.19394016 SOL, rounded up: a need is never said as less than it is.
      'The fee to open (0.15 SOL), the account deposits and the network fee are paid in SOL, whatever the pool is paired with. This wallet needs about 0.194 SOL for them and has 5 SOL. Only your USDC and your tokens go into the pool.',
    );
    expect(within(panel).getByTestId('lp-before-you-open')).toHaveTextContent(
      "Opening costs 0.15 SOL, paid to the team's vault, and about 0.04 SOL in account deposits that never come back. Both are paid in SOL, whatever the pool is paired with: none of it comes out of your USDC. 0.0000001 pool shares",
    );
    expect(panel).toHaveTextContent('Your USDC is spent straight from your own USDC account. Nothing is wrapped.');
    expect(panel).not.toHaveTextContent('Your SOL is wrapped');
  });
});

describe('what the coin adds to the risks', () => {
  it('USDC’s is said in the form, before Review; BAYLA and SOL add none', async () => {
    mount(readers());
    const { panel } = await openPanel();
    await within(panel).findByRole('button', { name: 'Max SOL' });
    expect(within(panel).queryByTestId('lp-coin-risk')).toBeNull();
    expect(panel).not.toHaveTextContent('Circle');
    await pair(panel, 'USDC');
    const risk = within(panel).getByTestId('lp-coin-risk');
    expect(USDC_QUOTE.risk).toMatch(/Circle\) can freeze any USDC account/);
    expect(risk).toHaveTextContent(USDC_QUOTE.risk!);
    expect(risk.compareDocumentPosition(reviewButton(panel)) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    await pair(panel, 'BAYLA');
    expect(BAYLA_QUOTE.risk).toBeNull();
    expect(within(panel).queryByTestId('lp-coin-risk')).toBeNull();
    expect(panel).not.toHaveTextContent('Circle');
  });

  // Whole-change review 2026-10-04 (W5). The check's own warnings are what Review is
  // described by, so a screen reader says them when focus reaches the button. The coin's
  // risk was not among them: a clean USDC opening had a Review described by nothing.
  it('USDC’s is part of what Review is described by, with or without other warnings; BAYLA and SOL add nothing to it', async () => {
    mount(readers());
    const { panel } = await openPanel();
    await within(panel).findByRole('button', { name: 'Max SOL' });
    // SOL, nothing typed: described by nothing, as it always was.
    expect(reviewButton(panel)).not.toHaveAttribute('aria-describedby');
    await pair(panel, 'USDC');
    // A clean opening at the market (2 USDC a token): the coin's risk is the whole description.
    type(coinBox(panel, 'USDC'), '50');
    type(tokens(panel), '25');
    await waitFor(() => expect(price(panel)).toHaveAttribute('data-price', 'agrees'));
    expect(within(panel).queryByTestId('lp-create-warnings')).toBeNull();
    expect(reviewButton(panel)).toBeEnabled();
    expect(reviewButton(panel)).toHaveAccessibleDescription(USDC_QUOTE.risk!);
    // Off the market: the price warning and what it may cost, then the coin's risk.
    type(tokens(panel), '50');
    await waitFor(() => expect(price(panel)).toHaveAttribute('data-price', 'disagrees'));
    const description = reviewButton(panel).getAttribute('aria-describedby')!.split(' ').map((id) => document.getElementById(id)?.textContent ?? '');
    expect(description).toHaveLength(2);
    expect(description[0]).toContain('Your opening price is 50.0% below the market price');
    expect(description[1]).toBe(USDC_QUOTE.risk);
    // BAYLA adds none: at the market, Review is described by nothing again.
    await pair(panel, 'BAYLA');
    type(coinBox(panel, 'BAYLA'), '5000');
    await waitFor(() => expect(price(panel)).toHaveAttribute('data-price', 'agrees'));
    expect(reviewButton(panel)).not.toHaveAttribute('aria-describedby');
  }, LONG);

  // A live mint authority can make new tokens and sell them into the pool: what it takes
  // out is the pool's pairing coin, so that is the coin the warning names. It was never a
  // refusal, so it stays in the form's own list above the boxes.
  it('a token whose mint authority is live: what can be sold out of the pool is the chosen coin', async () => {
    const warned: TokenSafety = { ...tokenFor(M), verdict: 'warn', warnings: [{ code: 'mint-authority', text: 'Someone can still make more of this token.' }] } as TokenSafety;
    mount(readers({ safety: vi.fn(async () => new Map([[M, warned]])) }));
    const { panel } = await openPanel();
    expect(panel).toHaveTextContent('Whoever holds that mint authority can make new tokens at any time and sell them into your pool for its SOL.');
    await pair(panel, 'USDC');
    expect(panel).toHaveTextContent('Whoever holds that mint authority can make new tokens at any time and sell them into your pool for its USDC.');
    expect(panel).not.toHaveTextContent('for its SOL');
  });
});

// Round 3 of the forms review. Each of these was a rule with no failing test, or a place
// where one coin's answer could be shown as another's, or as current when it was not.
describe('a coin’s price is only ever the answer to the read that is out now', () => {
  // F2: USDC, SOL, USDC again. The kept answer used to be shown as the current price, with
  // Review on, while a new read of it was out.
  it('coming back to a coin through SOL reads its price again: the old one is not shown as current, and Review waits', async () => {
    const held: Array<(p: OutsidePrice) => void> = [];
    let usdcReads = 0;
    const outsidePrice = vi.fn((mint: string) => {
      if (mint !== USDC) return Promise.resolve(priceOf(mint));
      usdcReads += 1;
      // The first read of USDC answers. The second is held open.
      return usdcReads === 1 ? Promise.resolve(priceOf(USDC)) : new Promise<OutsidePrice>((res) => held.push(res));
    });
    mount(readers({ outsidePrice }));
    const { panel } = await openPanel();
    await pair(panel, 'USDC');
    await waitFor(() => expect(market(panel)).toHaveTextContent('1 token = 2 USDC.'));
    type(coinBox(panel, 'USDC'), '50');
    type(tokens(panel), '25');
    expect(reviewButton(panel)).toBeEnabled();
    await pair(panel, 'SOL');
    await pair(panel, 'USDC');
    await waitFor(() => expect(usdcReads).toBe(2));
    // The second read is out: nothing is priced in USDC until it answers.
    expect(market(panel)).toHaveTextContent('Market price in USDC: reading the price of USDC from Jupiter…');
    expect(market(panel)).not.toHaveTextContent('1 token =');
    type(coinBox(panel, 'USDC'), '50');
    expect(tokens(panel)).toHaveValue('25');
    expect(price(panel)).toHaveAttribute('data-price', 'unread');
    expect(matchButton(panel)).toBeDisabled();
    expect(reviewButton(panel)).toBeDisabled();
    expect(within(panel).getByTestId('lp-create-coin-price')).toHaveTextContent('Review is off while the price of USDC is read: your opening price is checked in USDC.');
    // USDC moved while the form was on SOL: the new answer is the one that is checked.
    await act(async () => held[0]!(ok(0.004)));
    expect(market(panel)).toHaveTextContent('1 token = 2.5 USDC.');
    expect(price(panel)).toHaveAttribute('data-price', 'disagrees');
    expect(within(panel).queryByTestId('lp-create-coin-price')).toBeNull();
  }, LONG);

  // F4: on a read-again the token's price comes back first. Its new price over the
  // coin's OLD one is a market price of no moment at all.
  it('a read-again never mixes the token’s new price with the coin’s old one: the line says "reading" and Match is off until both are in', async () => {
    let release!: (p: OutsidePrice) => void;
    let tokenSol = TOKEN_SOL;
    const usdc = vi
      .fn<() => Promise<OutsidePrice>>()
      .mockResolvedValueOnce(priceOf(USDC))
      .mockImplementationOnce(() => new Promise<OutsidePrice>((res) => (release = res)));
    mount(readers({ outsidePrice: vi.fn((mint: string) => (mint === USDC ? usdc() : Promise.resolve(ok(tokenSol)))) }));
    const { panel } = await openPanel();
    await pair(panel, 'USDC');
    await waitFor(() => expect(market(panel)).toHaveTextContent('1 token = 2 USDC.'));
    type(coinBox(panel, 'USDC'), '50');
    expect(matchButton(panel)).toBeEnabled();
    // The token doubles in SOL before the next read.
    tokenSol = 0.02;
    fireEvent.click(within(within(panel).getByTestId('lp-create-market-again')).getByRole('button', { name: 'Read the market price again' }));
    await waitFor(() => expect(usdc).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.queryByText('Reading the token and its pools again…')).toBeNull());
    // The token's new price is in and USDC's is not. 0.02 over the old 0.005 would read "4 USDC".
    expect(market(panel)).toHaveTextContent('Market price in USDC: reading the price of USDC from Jupiter…');
    expect(market(panel)).not.toHaveTextContent('1 token =');
    expect(matchButton(panel)).toBeDisabled();
    expect(reviewButton(panel)).toBeDisabled();
    // USDC doubled in SOL too, so the token is still 2 USDC.
    await act(async () => release(ok(0.01)));
    expect(market(panel)).toHaveTextContent('1 token = 2 USDC.');
    expect(matchButton(panel)).toBeEnabled();
    fireEvent.click(matchButton(panel));
    expect(tokens(panel)).toHaveValue('25');
  }, LONG);

  // Review 2026-10-04 (P1): the other order. The coin's price is one read; the token's
  // comes back with the whole pool search, so the coin's can land first. The token's OLD
  // price over the coin's NEW one is as untrue as the mix above. Both doubled in SOL here,
  // so the token was 2 USDC before and is 2 USDC after: 0.01 over 0.01 would read "1 USDC".
  it('…nor the coin’s new price with the token’s old one: until the token’s read is back too, no price is shown and Match does nothing', async () => {
    let releaseToken!: (p: OutsidePrice) => void;
    let releaseUsdc!: (p: OutsidePrice) => void;
    let held = false;
    const token = vi.fn(() => (held ? new Promise<OutsidePrice>((res) => (releaseToken = res)) : Promise.resolve(ok(TOKEN_SOL))));
    const usdc = vi.fn(() => (held ? new Promise<OutsidePrice>((res) => (releaseUsdc = res)) : Promise.resolve(priceOf(USDC))));
    mount(readers({ outsidePrice: vi.fn((mint: string) => (mint === USDC ? usdc() : token())) }));
    const { panel } = await openPanel();
    await pair(panel, 'USDC');
    await waitFor(() => expect(market(panel)).toHaveTextContent('1 token = 2 USDC.'));
    type(coinBox(panel, 'USDC'), '50');
    type(tokens(panel), '25');
    expect(price(panel)).toHaveAttribute('data-price', 'agrees');
    expect(matchButton(panel)).toBeEnabled();
    held = true;
    fireEvent.click(within(within(panel).getByTestId('lp-create-market-again')).getByRole('button', { name: 'Read the market price again' }));
    await waitFor(() => expect(usdc).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(token).toHaveBeenCalledTimes(2));
    // USDC's new price lands. The token's read is still out.
    await act(async () => releaseUsdc(ok(0.01)));
    expect(screen.getByText('Reading the token and its pools again…')).toBeInTheDocument();
    // No price is shown as the market price, and nothing is compared with one.
    expect(market(panel)).not.toHaveTextContent('1 token =');
    expect(market(panel)).toHaveTextContent(/^Market price in USDC: reading the price of USDC from Jupiter…$/);
    expect(price(panel)).toHaveAttribute('data-price', 'unread');
    expect(price(panel)).toHaveTextContent('Your opening price: 1 token = 2 USDC. It is not checked: the market price has not been read.');
    expect(within(panel).queryByTestId('lp-create-warnings')).toBeNull();
    // Nothing on the form can move the amounts to a price while one is being read.
    expect(matchButton(panel)).toBeDisabled();
    expect(within(panel).getAllByRole('button', { name: 'Match the market price' })).toHaveLength(1);
    fireEvent.click(matchButton(panel));
    expect(within(panel).queryByRole('button', { name: 'Use the most both balances allow' })).toBeNull();
    expect(coinBox(panel, 'USDC')).toHaveValue('50');
    expect(tokens(panel)).toHaveValue('25');
    expect(reviewButton(panel)).toBeDisabled();
    // The token's new price lands: 0.02 over 0.01 is 2 USDC, the price of one moment.
    await act(async () => releaseToken(ok(0.02)));
    await waitFor(() => expect(market(panel)).toHaveTextContent('1 token = 2 USDC.'));
    expect(price(panel)).toHaveAttribute('data-price', 'agrees');
    expect(matchButton(panel)).toBeEnabled();
    type(tokens(panel), '30');
    fireEvent.click(matchButton(panel));
    expect(coinBox(panel, 'USDC')).toHaveValue('60');
  }, LONG);

  // The same rule on SOL, where there is one price: while it is read again Match is off.
  // An opening price off the market has a second Match button, under its warning, and
  // that one must do nothing either.
  it('on SOL too: while the market price is read again Match is off, and the Match under the price warning does nothing', async () => {
    let release!: (p: OutsidePrice) => void;
    let held = false;
    const token = vi.fn(() => (held ? new Promise<OutsidePrice>((res) => (release = res)) : Promise.resolve(ok(TOKEN_SOL))));
    mount(readers({ outsidePrice: vi.fn(() => token()) }));
    const { panel } = await openPanel();
    await within(panel).findByRole('button', { name: 'Max SOL' });
    // 2 SOL for 100 tokens is 0.02 SOL a token: 100% above the market's 0.01.
    type(coinBox(panel, 'SOL'), '2');
    type(tokens(panel), '100');
    expect(price(panel)).toHaveAttribute('data-price', 'disagrees');
    const underWarning = () => within(within(panel).getByTestId('lp-create-warnings')).getByRole('button', { name: 'Match the market price' });
    expect(matchButton(panel)).toBeEnabled();
    held = true;
    fireEvent.click(within(within(panel).getByTestId('lp-create-market-again')).getByRole('button', { name: 'Read the market price again' }));
    await waitFor(() => expect(token).toHaveBeenCalledTimes(2));
    expect(screen.getByText('Reading the token and its pools again…')).toBeInTheDocument();
    expect(matchButton(panel)).toBeDisabled();
    fireEvent.click(matchButton(panel));
    fireEvent.click(underWarning());
    // At the old price either press would have made it 1 SOL for 100 tokens.
    expect(coinBox(panel, 'SOL')).toHaveValue('2');
    expect(tokens(panel)).toHaveValue('100');
    // The token doubled: 2 SOL for 100 tokens is the market price now, and Match uses it.
    await act(async () => release(ok(0.02)));
    await waitFor(() => expect(market(panel)).toHaveTextContent('1 token = 0.02 SOL.'));
    expect(matchButton(panel)).toBeEnabled();
    type(tokens(panel), '50');
    fireEvent.click(matchButton(panel));
    expect(coinBox(panel, 'SOL')).toHaveValue('1');
  }, LONG);

  // F6: with the guard gone, USDC's late answer took the place of BAYLA's.
  it('a late price answer for a coin that was left is dropped: it never takes the place of the chosen coin’s', async () => {
    let releaseUsdc!: (p: OutsidePrice) => void;
    const outsidePrice = vi.fn((mint: string) => (mint === USDC ? new Promise<OutsidePrice>((res) => (releaseUsdc = res)) : Promise.resolve(priceOf(mint))));
    mount(readers({ outsidePrice }));
    const { panel } = await openPanel();
    await pair(panel, 'USDC');
    expect(market(panel)).toHaveTextContent('reading the price of USDC');
    await pair(panel, 'BAYLA');
    await waitFor(() => expect(market(panel)).toHaveTextContent('1 token = 100 BAYLA.'));
    type(coinBox(panel, 'BAYLA'), '1000');
    type(tokens(panel), '10');
    expect(reviewButton(panel)).toBeEnabled();
    // USDC's answer lands now, for a read that was left.
    await act(async () => releaseUsdc(priceOf(USDC)));
    expect(market(panel)).toHaveTextContent('1 token = 100 BAYLA.');
    expect(price(panel)).toHaveAttribute('data-price', 'agrees');
    expect(reviewButton(panel)).toBeEnabled();
  });

  // Owner ruling 2026-10-07 ("no, we do what we want"). Jupiter's own words for "no route"
  // say "this token". Here the token HAS a price; it is the COIN that has none. That is an
  // answer, so it switches nothing off: the form says there is no market price in the coin,
  // offers nothing to match, says the check's warning above Review, and Review is on.
  // Before, this was "could not be worked out" and Review was off with "Pair with another coin".
  it.each([
    ['BAYLA', BAYLA, '1000', 100],
    ['USDC', USDC, '20', 2],
  ] as const)('when Jupiter has no route for %s itself: the form names the coin, never "this token", warns above Review, and Review is ON', async (symbol, coinMint, amount, perToken) => {
    const noRoute = { kind: 'no-route' as const, detail: 'Jupiter has no route for this token' };
    const prepareLpCreate = notBuilt();
    mount(readers({ outsidePrice: vi.fn(async (mint: string) => (mint === coinMint ? noRoute : priceOf(mint))) }), { api: { prepareLpCreate } });
    const { panel } = await openPanel();
    await pair(panel, symbol);
    await waitFor(() => expect(market(panel)).toHaveTextContent(`Market price in ${symbol}: none. Jupiter has no price for ${symbol} right now.`));
    expect(market(panel)).not.toHaveTextContent('this token');
    expect(market(panel)).not.toHaveTextContent('could not be worked out');
    // There is no market price to match: the button is not drawn, as for a token with none.
    expect(within(panel).queryByTestId('lp-create-match')).toBeNull();
    expect(within(panel).queryByRole('button', { name: 'Match the market price' })).toBeNull();
    type(coinBox(panel, symbol), amount);
    type(tokens(panel), '10');
    expect(price(panel)).toHaveAttribute('data-price', 'no-market');
    expect(price(panel)).toHaveTextContent(`Your opening price: 1 token = ${perToken} ${symbol}. There is no market price in ${symbol} to compare it with.`);
    // The check's own sentence, above Review. USDC's own risk line is a separate notice.
    const warnings = within(panel).getByTestId('lp-create-warnings');
    expect(Array.from(warnings.querySelectorAll('p')).map((p) => p.textContent)).toEqual([
      `Jupiter has no price for ${symbol} right now, so there is nothing to compare your opening price in ${symbol} with. You are setting the price yourself: if it is off, the first trades take the difference out of what you put in.`,
    ]);
    expect(warnings.compareDocumentPosition(reviewButton(panel)) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(reviewButton(panel).getAttribute('aria-describedby')).toContain(warnings.id);
    // The token HAS a price: nothing on the form says it has none.
    expect(panel).not.toHaveTextContent(/no market price for this token|no route for this token/);
    // Nothing is switched off, and no line says it is.
    expect(within(panel).queryByTestId('lp-create-coin-price')).toBeNull();
    expect(panel).not.toHaveTextContent(/Review is off|Pair with another coin/);
    expect(reviewButton(panel)).toBeEnabled();
    await act(async () => {
      fireEvent.click(reviewButton(panel));
    });
    // The builder is handed the chosen coin and its amount in the coin's own base units.
    expect(prepareLpCreate).toHaveBeenCalledTimes(1);
    expect(handed(prepareLpCreate)).toMatchObject({ tokenMint: MINT, quoteMint: new PublicKey(coinMint), quote: BigInt(amount) * UNIT[symbol], token: 10n * UNIT.token });
  }, LONG);

  it('what a screen reader hears once typing settles says there is no market price in the coin', async () => {
    const noRoute = { kind: 'no-route' as const, detail: 'Jupiter has no route for this token' };
    mount(readers({ outsidePrice: vi.fn(async (mint: string) => (mint === BAYLA ? noRoute : priceOf(mint))) }));
    const { panel } = await openPanel();
    await pair(panel, 'BAYLA');
    type(coinBox(panel, 'BAYLA'), '1000');
    type(tokens(panel), '10');
    await waitFor(
      () =>
        expect(panel.querySelector('p.sr-only[role="status"]')).toHaveTextContent(
          /^You would open the pool at 1 token = 100 BAYLA and get [\d.]+ pool shares\. There is no market price in BAYLA to compare it with: you are setting the price yourself\.$/,
        ),
      { timeout: 4_000 },
    );
  }, LONG);
});

describe('changing the coin is never silent', () => {
  const status = (p: HTMLElement) => p.querySelector('p.sr-only[role="status"]');
  /** The whole status line, and nothing else. */
  const said = (p: HTMLElement) => (status(p)?.textContent ?? '').replace(/\s+/g, ' ').trim();

  // Whole-change review 2026-10-04 (W5). The arrow keys in the radio group change the coin,
  // and the amber notice about what USDC adds to the risks appears beside it without a
  // word to a screen reader. The status line says the change of coin: it says that too.
  it('choosing USDC says what USDC adds to the risks, in the coin table’s own words; BAYLA and SOL add nothing to say', async () => {
    mount(readers());
    const { panel } = await openPanel();
    await within(panel).findByRole('button', { name: 'Max SOL' });
    await pair(panel, 'USDC');
    expect(USDC_QUOTE.risk).toMatch(/Circle\) can freeze any USDC account/);
    expect(said(panel)).toBe(`Now pairing with USDC. ${USDC_QUOTE.risk}`);
    await pair(panel, 'BAYLA');
    expect(said(panel)).toBe('Now pairing with BAYLA.');
    await pair(panel, 'SOL');
    expect(said(panel)).toBe('Now pairing with SOL.');
  });

  // F9: the radio group's arrow keys change the coin, and a typed amount went with it
  // without a word.
  it('the token amount is kept, the coin’s box is cleared, and the status line says so', async () => {
    mount(readers());
    const { panel } = await openPanel();
    await within(panel).findByRole('button', { name: 'Max SOL' });
    expect(status(panel)).toHaveTextContent('');
    type(coinBox(panel, 'SOL'), '1');
    type(tokens(panel), '100');
    await pair(panel, 'USDC');
    expect(coinBox(panel, 'USDC')).toHaveValue('');
    expect(tokens(panel)).toHaveValue('100');
    expect(said(panel)).toBe(`Now pairing with USDC. ${USDC_QUOTE.risk} Type the USDC amount again.`);
    // The kept token amount is what Match works from: 100 tokens at 2 USDC.
    await waitFor(() => expect(market(panel)).toHaveTextContent('1 token = 2 USDC.'));
    fireEvent.click(matchButton(panel));
    expect(coinBox(panel, 'USDC')).toHaveValue('200');
    expect(tokens(panel)).toHaveValue('100');
    // With the coin's amount in, there is nothing left to ask for.
    expect(status(panel)).not.toHaveTextContent('Now pairing');
  });

  // Review 2026-10-04 (P2). The note asks for the coin's amount once. With that amount in,
  // it has been answered: emptying the box later, to type another, must not say it again.
  it.each([
    ['typed', (panel: HTMLElement) => type(coinBox(panel, 'USDC'), '200')],
    ['put in by Max USDC', (panel: HTMLElement) => fireEvent.click(within(panel).getByRole('button', { name: 'Max USDC' }))],
    ['put in by Match the market price', (panel: HTMLElement) => fireEvent.click(matchButton(panel))],
  ])('the note is said once: after the coin’s amount is %s and the box is emptied again, it is not said again', async (_how, fill) => {
    mount(readers());
    const { panel } = await openPanel();
    await within(panel).findByRole('button', { name: 'Max SOL' });
    type(coinBox(panel, 'SOL'), '1');
    type(tokens(panel), '100');
    await pair(panel, 'USDC');
    await waitFor(() => expect(market(panel)).toHaveTextContent('1 token = 2 USDC.'));
    expect(said(panel)).toBe(`Now pairing with USDC. ${USDC_QUOTE.risk} Type the USDC amount again.`);
    fill(panel);
    expect(coinBox(panel, 'USDC')).not.toHaveValue('');
    expect(status(panel)).not.toHaveTextContent('Now pairing');
    type(coinBox(panel, 'USDC'), '');
    expect(coinBox(panel, 'USDC')).toHaveValue('');
    expect(status(panel)).not.toHaveTextContent('Now pairing');
    expect(status(panel)).not.toHaveTextContent('again');
    // The next change of coin is a new note, and it is said.
    await pair(panel, 'BAYLA');
    expect(status(panel)).toHaveTextContent(/^Now pairing with BAYLA\.$/);
  }, LONG);

  it('with nothing typed for the coin, it says the new coin and asks for nothing "again"', async () => {
    mount(readers());
    const { panel } = await openPanel();
    await within(panel).findByRole('button', { name: 'Max SOL' });
    type(tokens(panel), '100');
    await pair(panel, 'BAYLA');
    expect(tokens(panel)).toHaveValue('100');
    expect(status(panel)).toHaveTextContent(/^Now pairing with BAYLA\.$/);
  });

  // F6: the line a screen reader hears is kept for half a second after it changes.
  it('what a screen reader heard under one coin is not said again under the next', async () => {
    mount(readers());
    const { panel } = await openPanel();
    await within(panel).findByRole('button', { name: 'Max SOL' });
    type(coinBox(panel, 'SOL'), '1');
    type(tokens(panel), '100');
    await waitFor(() => expect(status(panel)).toHaveTextContent('You would open the pool at 1 token = 0.01 SOL and get 0.316227666 pool shares.'));
    fireEvent.click(within(panel).getByRole('radio', { name: 'USDC' }));
    // At once: the settled line was SOL's, and is not USDC's.
    expect(status(panel)).not.toHaveTextContent('You would open the pool');
    expect(status(panel)).not.toHaveTextContent('SOL');
    expect(said(panel)).toBe(`Now pairing with USDC. ${USDC_QUOTE.risk} Type the USDC amount again.`);
  });
});

describe('the card, per coin (round 3)', () => {
  // F6: the line was in no test at all.
  it('a coin whose pools all fail their checks is said by name, beside the coin that has a pool to add to', async () => {
    const solPool = view();
    // Not open for swaps yet: a pool, and one that passes no deposit check.
    const failingUsdc = view({ quote: USDC_QUOTE, openTime: 10n ** 12n });
    mount(readers({ findPools: vi.fn(async () => search([solPool, failingUsdc])) }));
    const card = await offered();
    expect(within(card).getByTestId('lp-create-refer')).toHaveAttribute('data-coin', 'SOL');
    expect(within(card).getByTestId('lp-create-failing')).toHaveTextContent(/^None of this token's USDC pools passes the checks above\.$/);
    expect(within(card).getByTestId('lp-create-none-yet')).toHaveTextContent('This token has no BAYLA pool yet.');
  });

  // F6: the card's "same answer" key covered the first coin only. A read that changes
  // only what a later coin has must say the answer is new.
  it('Read again says the answer is new when only a coin after the first changed, and the same when nothing did', async () => {
    const unread: OutsidePrice = { kind: 'unread', detail: 'Jupiter did not give a price (HTTP 502)' };
    const usdcPool = view({ quote: USDC_QUOTE });
    // Between the first read and the second, someone opens a USDC pool. SOL has none throughout.
    const findPools = vi.fn().mockResolvedValueOnce(search([])).mockResolvedValue(search([usdcPool]));
    mount(readers({ findPools, outsidePrice: vi.fn(async (mint: string) => (mint === M ? unread : priceOf(mint))) }));
    const card = await screen.findByTestId('lp-create');
    await waitFor(() => expect(card).toHaveAttribute('data-create', 'price-unread'));
    const reread = within(card).getByTestId('lp-create-reread');
    fireEvent.click(within(card).getByRole('button', { name: 'Read again' }));
    await waitFor(() => expect(reread).toHaveTextContent('Read again just now: the answer above is new.'));
    expect(card).toHaveAttribute('data-create', 'price-unread');
    fireEvent.click(within(card).getByRole('button', { name: 'Read again' }));
    await waitFor(() => expect(findPools).toHaveBeenCalledTimes(3));
    await waitFor(() => expect(reread).toHaveTextContent('Read again just now: the same answer.'));
  }, LONG);

  // F1: the card's Add button is a second, recommended way into the Add form. That form
  // once typed SOL for every pool: a typed 1 was handed over as 1,000 USDC. This pins the
  // whole way from the card to the builder, so no merge order can bring that back.
  it('"Add liquidity to that pool" on a USDC pool opens a form that types USDC: a typed 1 is 1,000,000 of its smallest unit', async () => {
    const usdcPool = view({ quote: USDC_QUOTE });
    const prepareLpDeposit = notBuilt();
    mount(readers({ findPools: vi.fn(async () => search([usdcPool])) }), { api: { prepareLpDeposit } });
    const card = await offered();
    fireEvent.click(await within(card).findByRole('button', { name: 'Add liquidity to that pool' }));
    const add = await screen.findByTestId('lp-add-panel');
    await within(add).findByRole('button', { name: 'Max USDC' });
    expect(within(add).queryByLabelText('SOL to add')).toBeNull();
    type(within(add).getByLabelText('USDC to add'), '1');
    const review = within(add).getByRole('button', { name: 'Review: add liquidity' });
    await waitFor(() => expect(review).toBeEnabled());
    await act(async () => {
      fireEvent.click(review);
    });
    expect(prepareLpDeposit).toHaveBeenCalledTimes(1);
    expect((prepareLpDeposit.mock.calls[0] as unknown[])[3]).toMatchObject({
      pool: new PublicKey(usdcPool.address),
      tokenMint: MINT,
      quoteMint: new PublicKey(USDC),
      driving: 'quote',
      // 1 USDC. With SOL's 9 decimals this would be 1,000,000,000: a thousand USDC.
      maxIn: 1_000_000n,
    });
  }, LONG);
});

// THE LEAVE RULE: nobody is let in who cannot be let out. The pool program refuses a
// withdrawal that pays 0 on a side. With ONE base unit on a side, the opener's 99.9% of
// the pool's shares pays floor(0.999) = 0 of that side, so no share of the pool could ever
// be taken out. For a token with no decimals, "1" is exactly what someone types. The form
// let it through to Review, and so did the builder (review, 2026-10-04).
describe('an opening whose own share could never be taken out', () => {
  /** A token with no decimals: its smallest unit is one whole token. */
  const whole = (mint: string): TokenSafety => {
    const t = tokenFor(mint);
    return t.kind === 'read' && t.facts ? { ...t, facts: { ...t.facts, decimals: 0 } } : t;
  };
  /** Nobody trades it: Jupiter ANSWERS that it has no route, which is a warning and never a stop. */
  const noRoute: OutsidePrice = { kind: 'no-route', detail: 'Jupiter has no route for this token' };
  /** A wallet that can cover any amount typed here: only the share rule can stop the opening. */
  const rich = (quote: QuoteCoin | undefined): WalletFacts =>
    walletFor(quote, {
      lamports: 50n * UNIT.SOL,
      token: { address: key().toBase58(), amount: 20_000_000_000n },
      ...(quote && !quote.native ? { coin: { address: key().toBase58(), exists: true, amount: 50_000n * 10n ** 6n } } : {}),
    });
  const mountWhole = () =>
    mount(
      readers({
        safety: vi.fn(async (mints: string[]) => new Map(mints.map((m) => [m, whole(m)]))),
        outsidePrice: vi.fn(async (mint: string) => (mint === M ? noRoute : priceOf(mint))),
        wallet: vi.fn<WalletFn>(async (_o, _m, _p, _l, opts) => rich(opts?.quote)),
      }),
    );
  const cannotLeave = (what: string) =>
    `Too small: your own share of this pool could never be taken out, because it would pay out less than one unit of ${what}. Put in more of it.`;
  // 10 SOL, 10,000 USDC and 10,000 BAYLA are each 10,000,000,000 base units: with one
  // token that is exactly 100,000 pool shares, so no other "too small" rule is in the way.
  const COINS: Array<[QuoteSymbol, string]> = [['SOL', '10'], ['USDC', '10000'], ['BAYLA', '10000']];

  it.each(COINS)('%s: ONE token with no decimals: the form says why, names the token, and Review is off; with two it is on', async (symbol, amount) => {
    mountWhole();
    const { panel } = await openPanel();
    if (symbol === 'SOL') await within(panel).findByRole('button', { name: 'Max SOL' });
    else await pair(panel, symbol);
    type(coinBox(panel, symbol), amount);
    type(tokens(panel), '1');
    const alert = within(panel).getByRole('alert');
    await waitFor(() => expect(alert).toHaveTextContent(cannotLeave('the token')));
    expect(reviewButton(panel)).toBeDisabled();
    // Not sent to the wrong fix: nothing here says the locked part is too large.
    expect(alert).not.toHaveTextContent('0.1%');
    // Two tokens: the opener's share pays one of them back, so it can leave.
    type(tokens(panel), '2');
    await waitFor(() => expect(alert).toHaveTextContent(''));
    expect(reviewButton(panel)).toBeEnabled();
  }, LONG);

  it.each(COINS)('%s: ONE base unit of the coin against 10,000,000,000 tokens: the words name the coin', async (symbol) => {
    mountWhole();
    const { panel } = await openPanel();
    if (symbol === 'SOL') await within(panel).findByRole('button', { name: 'Max SOL' });
    else await pair(panel, symbol);
    type(coinBox(panel, symbol), symbol === 'SOL' ? '0.000000001' : '0.000001');
    type(tokens(panel), '10000000000');
    const alert = within(panel).getByRole('alert');
    await waitFor(() => expect(alert).toHaveTextContent(cannotLeave(symbol)));
    expect(alert).not.toHaveTextContent('the token');
    expect(reviewButton(panel)).toBeDisabled();
  }, LONG);
});
