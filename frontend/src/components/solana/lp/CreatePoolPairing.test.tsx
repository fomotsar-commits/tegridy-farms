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
import { act, render, screen, waitFor, within, fireEvent } from '@testing-library/react';
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
    expect(coinBox(panel, 'SOL')).toBeInTheDocument();
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
    // Two coins leave the wallet, and they are never added into one number.
    expect(row(panel, 'In all, from your wallet')).toHaveTextContent('50 USDC, and about 0.192 SOL for the fee to open and the account deposits, plus the network fee');
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
  it('empties both boxes, and the old coin’s balance is never shown under the new coin, not even while its own is read', async () => {
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
    // At once, before any read answers: the boxes are empty and nothing of SOL's is on the form.
    expect(coinBox(panel, 'USDC')).toHaveValue('');
    expect(tokens(panel)).toHaveValue('');
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
    expect(tokens(panel)).toHaveValue('');
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
    expect(price(panel)).toHaveTextContent('Your opening price: 1 token = 2 USDC. There is no market price to compare it with.');
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

  it('2.9% off passes and 3.1% off is refused, with the loss said in USDC', async () => {
    mount(readers());
    const { panel } = await openPanel();
    await pair(panel, 'USDC');
    type(tokens(panel), '25');
    // 51.45 USDC for 25 tokens is 2.058 USDC a token: 2.9% above 2.
    type(coinBox(panel, 'USDC'), '51.45');
    expect(price(panel)).toHaveAttribute('data-price', 'agrees');
    expect(reviewButton(panel)).toBeEnabled();
    // 51.55 is 2.062: 3.1% above.
    type(coinBox(panel, 'USDC'), '51.55');
    expect(price(panel)).toHaveAttribute('data-price', 'disagrees');
    expect(price(panel)).toHaveTextContent('Your opening price: 1 token = 2.062 USDC. Market: 2 USDC. Yours is 3.1% above the market.');
    expect(reviewButton(panel)).toBeDisabled();
    const alert = within(panel).getByRole('alert');
    await waitFor(() => expect(alert).not.toHaveTextContent(''));
    expect(alert).toHaveTextContent(
      /^Your opening price is 3\.1% above the market price\. Bots would trade against your pool as soon as it opens, taking about 0\.01\d* USDC of what you put in\. Pools opened from this site must start within 3% of the market\.$/,
    );
    // The line's own Match keeps the USDC (typed last) and moves the tokens.
    fireEvent.click(within(panel).getAllByRole('button', { name: 'Match the market price' }).find((b) => !b.hasAttribute('data-testid'))!);
    expect(coinBox(panel, 'USDC')).toHaveValue('51.55');
    expect(tokens(panel)).toHaveValue('25.775');
    expect(reviewButton(panel)).toBeEnabled();
  });

  it('a price that would pass only if USDC were read as SOL is refused', async () => {
    mount(readers());
    const { panel } = await openPanel();
    await pair(panel, 'USDC');
    // 0.25 USDC for 25 tokens is 0.01 USDC a token: the very number of the token's SOL
    // price (0.01 SOL). In USDC the market is 2, so this is 99.5% below it.
    type(coinBox(panel, 'USDC'), '0.25');
    type(tokens(panel), '25');
    expect(price(panel)).toHaveAttribute('data-price', 'disagrees');
    expect(price(panel)).toHaveTextContent('Your opening price: 1 token = 0.01 USDC. Market: 2 USDC. Yours is 99.5% below the market.');
    expect(reviewButton(panel)).toBeDisabled();
    // The same amounts on SOL are at SOL's market: the check is each coin's own.
    await pair(panel, 'SOL');
    type(coinBox(panel, 'SOL'), '0.25');
    type(tokens(panel), '25');
    expect(price(panel)).toHaveAttribute('data-price', 'agrees');
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
    expect(within(card).getByTestId('lp-create-none-yet')).toHaveTextContent('This token has no USDC pool yet.');
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
      'This wallet cannot open a pool yet. That needs about 0.1939 SOL for the fee to open, the account deposits and network fees, and this wallet has 0.193940159 SOL. No SOL goes into the pool, but those costs are paid in SOL.',
    );
    expect(cannot).toHaveTextContent('Send SOL to this wallet, then come back to this tab.');
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
      'The fee to open (0.15 SOL), the account deposits and the network fee are paid in SOL, whatever the pool is paired with. This wallet needs about 0.1939 SOL for them and has 5 SOL. Only your USDC and your tokens go into the pool.',
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
});
