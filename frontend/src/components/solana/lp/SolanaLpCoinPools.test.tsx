// Adding and removing liquidity on a pool paired with USDC or BAYLA (owner ruling
// 2026-10-03). SolanaLpWrites.test.tsx covers SOL pools; this file is the same forms on
// the other two coins.
//
// THE ONE BUG THESE EXIST TO STOP: an amount on the coin's side read or printed with SOL's
// 9 decimals. USDC and BAYLA have 6, so that is a thousand times wrong, in real money. So
// these tests type an amount and check the base units the builder is handed, and read the
// numbers off the form.
//
// The write layer is a fake (fakeLpWriteApi.fixture.ts); the pools, positions and wallet
// are fake readers. Nothing here touches a chain.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, render, screen, waitFor, within, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { PublicKey } from '@solana/web3.js';
import { LpInner, type LpWritesOverrides } from './SolanaLpSection';
import { solAbout } from './panelKit';
import type { LpReaders } from './readers';
import { TOKEN_2022_PROGRAM, TOKEN_PROGRAM, type TokenSafety } from '../../../lib/solana/lp/tokenSafety';
import { BAYLA_QUOTE, SOL_QUOTE, USDC_QUOTE, type QuoteCoin } from '../../../lib/solana/lp/quotes';
import type { PoolSearchRead, PoolView } from '../../../lib/solana/lp/poolFinder';
import { decodeAmmConfig, decodePoolState } from '../../../lib/solana/cpswap/program';
import type { Position } from '../../../lib/solana/lp/positions';
import type { WalletFacts } from '../../../lib/solana/lp/walletFacts';
import { buildPool, key, keyStartingWith } from '../../../lib/solana/lp/testkit.fixture';
import type { LpWriteApi } from '../curve/ports';
import { fakeLpApi, LP_PROGRAM, unusedGateRpc } from './fakeLpWriteApi.fixture';

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
// web3's address derivation cannot run under jsdom (a cross-realm Uint8Array check), so
// the one derivation a panel makes, the token account a withdrawal opens, is a fixed key.
// The coin's account is never derived by a panel: the wallet read gives its address.
vi.mock('../../../lib/launcher/solana/curve/ix', async (orig) => {
  const { PublicKey: Key } = await import('@solana/web3.js');
  return { ...(await orig<typeof import('../../../lib/launcher/solana/curve/ix')>()), associatedTokenAddress: () => new Key(new Uint8Array(32).fill(77)) };
});
const TOKEN_ATA = new PublicKey(new Uint8Array(32).fill(77)).toBase58();

const COINS = [
  ['USDC', USDC_QUOTE],
  ['BAYLA', BAYLA_QUOTE],
] as const;

/**
 * A pool stores its two mints in byte order, so the coin is the first of them for one
 * token and the second for another. Both are tried: a form that takes the wrong side for
 * the coin gets the units wrong for half of all tokens.
 */
const LOW = keyStartingWith(1);
const HIGH = keyStartingWith(255);
const ORDERS = [
  ['the coin is the pool’s second mint', LOW, false],
  ['the coin is the pool’s first mint', HIGH, true],
] as const;

const FLOOR = 890_880n;
/** A 165-byte account's deposit (USDC, and every classic token), and a 170-byte one's (BAYLA). */
const RENT_165 = 2_039_280n;
const RENT_170 = 2_074_080n;
const coinRent = (coin: QuoteCoin) => (coin.program === TOKEN_2022_PROGRAM ? RENT_170 : RENT_165);
const TOKEN_ACCOUNT = key().toBase58();
const COIN_ACCOUNT = key().toBase58();
const UNIT = 10n ** 6n;

/** 1,000 of the coin against 100,000 tokens: 0.01 of the coin per token. A SOL pool: 10 SOL against 1,000 tokens. */
function view(coin: QuoteCoin, mint: PublicKey, o: { token2022?: boolean } = {}): PoolView {
  const q = coin.native ? 10n * 10n ** 9n : 1_000n * UNIT;
  const t = coin.native ? 1_000n * UNIT : 100_000n * UNIT;
  const b = buildPool({ plain: true, mint, quote: coin, configIndex: 1, quoteReserve: q, tokenReserve: t, openTime: 1n });
  const read = decodePoolState(b.address.toBase58(), b.accounts[b.address.toBase58()]!.data)!;
  const config = decodeAmmConfig(b.config.toBase58(), b.accounts[b.config.toBase58()]!.data);
  const quoteIsToken0 = read.token0Mint === coin.mint;
  // `token2022`: the token's side (never the coin's) sits under Token-2022.
  const pool = !o.token2022 ? read : quoteIsToken0 ? { ...read, token1Program: TOKEN_2022_PROGRAM } : { ...read, token0Program: TOKEN_2022_PROGRAM };
  return {
    address: b.address.toBase58(),
    origin: 'other',
    snapshot: { pool, vault0Amount: quoteIsToken0 ? q : t, vault1Amount: quoteIsToken0 ? t : q, reserve0: quoteIsToken0 ? q : t, reserve1: quoteIsToken0 ? t : q },
    config,
    tokenMint: mint.toBase58(),
    quote: coin,
    quoteIsToken0,
    quoteReserve: q,
    tokenReserve: t,
    vaultsFrozen: false,
    history: { kind: 'not-read' },
  };
}

const okToken = (mint: string): TokenSafety => ({
  kind: 'read', mint, verdict: 'ok', blocks: [], warnings: [], name: 'Corn', symbol: 'CORN', metadataSource: 'metaplex',
  facts: { program: 'spl-token', mintAuthority: null, freezeAuthority: null, supply: 1n, decimals: 6, isInitialized: true, extensions: [], metadataPointer: null, tokenMetadata: null },
});

function search(v: PoolView): PoolSearchRead {
  return {
    kind: 'ok',
    search: {
      mint: v.tokenMint,
      known: { launchPool: key().toBase58(), standard: [{ index: 1, config: key().toBase58(), address: key().toBase58(), quote: SOL_QUOTE.mint }] },
      index: { kind: 'ok', pools: [v.address], truncated: false },
      pools: [{ kind: 'pool' as const, view: v }],
      otherPairs: 0,
      knownState: {},
      chainNow: 1_000n,
    },
  };
}

type OkFacts = Extract<WalletFacts, { kind: 'ok' }>;
/** 5 SOL, 50,000 tokens and 250 of the coin in its own account. No wrapped SOL: these pools read none. */
const walletOf = (coin: QuoteCoin, over: Partial<OkFacts> = {}): WalletFacts => ({
  kind: 'ok',
  lamports: 5n * 10n ** 9n,
  token: { address: TOKEN_ACCOUNT, amount: 50_000n * UNIT },
  wsol: { exists: false, amount: 0n },
  coin: coin.native ? null : { address: COIN_ACCOUNT, exists: true, amount: 250n * UNIT },
  lpAccountExists: false,
  rents: { walletFloor: FLOOR, tokenAccount165: RENT_165, ...(coin.native ? {} : { coinAccount: coinRent(coin) }) },
  ...over,
});
const noCoinAccount = { address: COIN_ACCOUNT, exists: false, amount: 0n };

function position(v: PoolView, over: Partial<Position> = {}): Position {
  // A quarter of the pool: 250 of the coin and 25,000 tokens (2.5 SOL and 250 tokens in a SOL pool).
  const coinWorth = v.quoteReserve / 4n;
  const tokenWorth = v.tokenReserve / 4n;
  return {
    lpMint: v.snapshot.pool.lpMint,
    lpAccount: key().toBase58(),
    lpAmount: 250_000n,
    placement: 'found',
    placementDetail: null,
    pool: { kind: 'pool', view: v },
    value: { token0: v.quoteIsToken0 ? coinWorth : tokenWorth, token1: v.quoteIsToken0 ? tokenWorth : coinWorth, sharePct: 25 },
    tooSmall: false,
    ...over,
  };
}

/** Readers for one pool. The outside prices agree with the pool: 0.01 of its coin per token. */
function readers(v: PoolView, o: Partial<LpReaders> = {}): LpReaders {
  const coin = v.quote;
  return {
    programId: LP_PROGRAM,
    safety: vi.fn(async () => new Map([[v.tokenMint, okToken(v.tokenMint)]])),
    findPools: vi.fn(async () => search(v)),
    // In SOL, as Jupiter answers: the token's price, and the coin's own.
    outsidePrice: vi.fn(async (mint: string) => ({ kind: 'ok' as const, solPerToken: coin.native ? 0.01 : mint === coin.mint ? 0.005 : 0.00005, source: 'Jupiter' as const })),
    positions: vi.fn(async () => ({ kind: 'ok' as const, positions: [], chainNow: 1n, totalShares: 0 })),
    feeTiers: vi.fn(async () => ({ kind: 'ok' as const, openingDeposits: null, tiers: [] })),
    wallet: vi.fn(async () => walletOf(coin)),
    placeShareOnChain: vi.fn(async () => ({ kind: 'not-found' as const })),
    ...o,
  };
}

const withPosition = (v: PoolView, p: Position = position(v)) => ({
  positions: vi.fn(async () => ({ kind: 'ok' as const, chainNow: 5n, totalShares: 1, positions: [p] })),
});

function mount(r: LpReaders, o: { api?: LpWriteApi; path: string }) {
  const api = o.api ?? fakeLpApi();
  const writes: LpWritesOverrides = { mode: 'on', load: vi.fn(async () => api), gateRpc: unusedGateRpc };
  render(
    <MemoryRouter initialEntries={[o.path]}>
      <LpInner readers={r} writes={writes} />
    </MemoryRouter>,
  );
  return api;
}

const notSent = () => vi.fn(async () => ({ ok: false as const, outcome: { status: 'not-sent' as const, stage: 'build' as const, message: 'x' } }));

/** Open the Add form of the one pool on the page. */
async function openAdd(v: PoolView, o: { api?: LpWriteApi; readers?: Partial<LpReaders> } = {}) {
  const r = readers(v, o.readers);
  const api = mount(r, { api: o.api, path: `/pools?mint=${v.tokenMint}` });
  fireEvent.click(await within(await screen.findByTestId('lp-pool')).findByRole('button', { name: 'Add liquidity' }));
  const panel = await screen.findByTestId('lp-add-panel');
  const box = (label: string) => within(panel).getByLabelText(label) as HTMLInputElement;
  const type = (label: string, value: string) => fireEvent.change(box(label), { target: { value } });
  const review = () => within(panel).getByRole('button', { name: 'Review: add liquidity' });
  const row = (label: string) => within(panel).getByText(label).nextElementSibling;
  return { r, api, panel, box, type, review, row };
}

/** Open the Remove form of the one position on the page. */
async function openRemove(v: PoolView, o: { api?: LpWriteApi; readers?: Partial<LpReaders>; position?: Position; path?: string } = {}) {
  const p = o.position ?? position(v);
  const r = readers(v, { ...withPosition(v, p), ...o.readers });
  const api = mount(r, { api: o.api, path: o.path ?? '/pools' });
  fireEvent.click(await within(await screen.findByTestId('lp-position')).findByRole('button', { name: 'Remove liquidity' }));
  const panel = await screen.findByTestId('lp-remove-panel');
  const review = () => within(panel).getByRole('button', { name: 'Review: remove liquidity' });
  const row = (label: string) => within(panel).getByText(label).nextElementSibling;
  return { r, api, panel, p, review, row };
}

/** The wallet read has landed once the form says what the wallet holds. */
const walletRead = (panel: HTMLElement) => waitFor(() => expect(panel).not.toHaveTextContent('Reading your wallet…'));

beforeEach(() => {
  sessionStorage.clear();
  wallet.publicKey = OWNER;
  wallet.signTransaction = async (t) => t;
});

describe.each(COINS)('Add liquidity to a pool paired with %s', (symbol, coin) => {
  const COIN_BOX = `${symbol} to add`;

  it.each(ORDERS)('typing 100 in the coin box hands the builder 100,000,000 base units, never 100,000,000,000 (%s)', async (_n, mint, coinFirst) => {
    const v = view(coin, mint);
    expect(v.quoteIsToken0).toBe(coinFirst);
    const { r, api, panel, box, type, review, row } = await openAdd(v, { api: fakeLpApi({ prepareLpDeposit: notSent() }) });
    await within(panel).findByRole('button', { name: `Max ${symbol}` });
    type(COIN_BOX, '100');
    // 100 into 1,000 of the coin / 100,000 tokens / 1,000,000 shares at 1%: 99,009 shares,
    // which cost 99.009 of the coin and 9,900.9 tokens.
    expect(box('Tokens to add')).toHaveValue('9900.9');
    expect(box(COIN_BOX)).toHaveAttribute('data-driving', 'true');
    expect(row('You put in about')).toHaveTextContent(`99.009 ${symbol} and 9,900.9 tokens`);
    expect(row('At most')).toHaveTextContent(`100 ${symbol} and 9,999.909 tokens`);
    expect(row('You get')).toHaveTextContent('0.000099009 pool shares, exactly');
    expect(review()).toBeEnabled();
    await act(async () => {
      fireEvent.click(review());
    });
    expect(api.prepareLpDeposit).toHaveBeenCalledTimes(1);
    const args = vi.mocked(api.prepareLpDeposit).mock.calls[0]!;
    expect(args[2]).toBe(r);
    expect(args[3]).toEqual({
      owner: OWNER,
      pool: new PublicKey(v.address),
      tokenMint: mint,
      quoteMint: new PublicKey(coin.mint),
      driving: 'quote',
      maxIn: 100_000_000n,
      slippageBps: 100n,
      // The token side's maximum the preview showed: ceil(9,900,900,000 × 1.01).
      shownOtherMax: 9_999_909_000n,
    });
  }, 20_000);

  it.each(ORDERS)('typing the token side works out the coin side in the coin’s own units (%s)', async (_n, mint) => {
    const v = view(coin, mint);
    const { api, panel, box, type, review, row } = await openAdd(v, { api: fakeLpApi({ prepareLpDeposit: notSent() }) });
    await within(panel).findByRole('button', { name: 'Max tokens' });
    type('Tokens to add', '5000');
    // 5,000 tokens buy 49,504 shares, which cost 49.504 of the coin: 49,504,000 base units.
    expect(box(COIN_BOX)).toHaveValue('49.504');
    expect(box('Tokens to add')).toHaveAttribute('data-driving', 'true');
    expect(row('At most')).toHaveTextContent(`49.99904 ${symbol} and 5,000 tokens`);
    expect(within(panel).getByText(`Worked out from the token amount: at most 49.99904 ${symbol} can leave your wallet. You have 250 ${symbol}.`)).toBeInTheDocument();
    await act(async () => {
      fireEvent.click(review());
    });
    expect(vi.mocked(api.prepareLpDeposit).mock.calls[0]![3]).toEqual({
      owner: OWNER,
      pool: new PublicKey(v.address),
      tokenMint: mint,
      quoteMint: new PublicKey(coin.mint),
      driving: 'token',
      maxIn: 5_000_000_000n,
      slippageBps: 100n,
      // The coin side's maximum, in the coin's base units: ceil(49,504,000 × 1.01).
      shownOtherMax: 49_999_040n,
    });
  }, 20_000);

  it('the wallet is read for this pool’s coin, and the form says the coin by name', async () => {
    const v = view(coin, LOW);
    const { r, panel } = await openAdd(v);
    await within(panel).findByRole('button', { name: `Max ${symbol}` });
    expect(r.wallet).toHaveBeenCalledWith(OWNER, v.tokenMint, TOKEN_PROGRAM, v.snapshot.pool.lpMint, { quote: coin });
    expect(within(panel).getByText(`You have 250 ${symbol}.`)).toBeInTheDocument();
    expect(within(panel).getByText('You have 50,000 tokens.')).toBeInTheDocument();
    // SOL's rules and SOL's words are not this pool's.
    expect(within(panel).queryByLabelText('SOL to add')).toBeNull();
    expect(panel).not.toHaveTextContent('can go in after fees and account deposits');
    expect(panel).not.toHaveTextContent('wrapped into a token account');
    expect(panel).toHaveTextContent(
      `Your ${symbol} is spent straight from your own ${symbol} account. Nothing is wrapped, and what the pool does not use never leaves that account. The network fee and any account deposit are paid in SOL.`,
    );
    expect(within(panel).queryByTestId('lp-add-cannot')).toBeNull();
  });

  it('typing in the coin box says what the token side is limited to, by the coin’s name', async () => {
    const { panel, type } = await openAdd(view(coin, LOW));
    await within(panel).findByRole('button', { name: `Max ${symbol}` });
    type(COIN_BOX, '100');
    expect(within(panel).getByText(`Worked out from the ${symbol} amount: at most 9,999.909 tokens can leave your wallet. You have 50,000 tokens.`)).toBeInTheDocument();
  });

  it('Max puts in the whole coin balance when the tokens cover it', async () => {
    const { panel, box, review, row } = await openAdd(view(coin, LOW));
    fireEvent.click(await within(panel).findByRole('button', { name: `Max ${symbol}` }));
    // All 250, not 250 less a SOL fee: the fee is not paid out of the coin.
    expect(box(COIN_BOX)).toHaveValue('250');
    expect(box(COIN_BOX)).toHaveAttribute('data-driving', 'true');
    expect(box('Tokens to add')).toHaveValue('24752.4');
    expect(row('At most')).toHaveTextContent(`250 ${symbol} and`);
    expect(review()).toBeEnabled();
  });

  it('Max when the tokens do not cover it: says so, and the most both balances allow is set in the coin’s decimals', async () => {
    const few = walletOf(coin, { token: { address: TOKEN_ACCOUNT, amount: 1_000n * UNIT } });
    const { panel, box, review } = await openAdd(view(coin, LOW), { readers: { wallet: vi.fn(async () => few) } });
    fireEvent.click(await within(panel).findByRole('button', { name: `Max ${symbol}` }));
    await waitFor(
      () => expect(panel).toHaveTextContent(`This needs up to 24,752.4 tokens and your wallet has 1,000 tokens. Lower the ${symbol} amount, or use the most both balances allow.`),
      { timeout: 4_000 },
    );
    expect(review()).toBeDisabled();
    fireEvent.click(within(panel).getByRole('button', { name: 'Use the most both balances allow' }));
    // 1,000 tokens at 100 tokens per coin: 10 of the coin drives, and the plan fits.
    expect(box(COIN_BOX)).toHaveValue('10');
    expect(review()).toBeEnabled();
  }, 20_000);

  it('more of the coin than the wallet holds: said in the coin’s own amounts, and "Use" sets the coin box', async () => {
    const { panel, box, type, review } = await openAdd(view(coin, LOW));
    await within(panel).findByRole('button', { name: `Max ${symbol}` });
    type(COIN_BOX, '300');
    await waitFor(() => expect(panel).toHaveTextContent(`This needs up to 300 ${symbol} and your wallet has 250 ${symbol}.`), { timeout: 4_000 });
    expect(panel).not.toHaveTextContent('too little SOL to stay open');
    expect(review()).toBeDisabled();
    fireEvent.click(within(panel).getByRole('button', { name: `Use 250 ${symbol}` }));
    expect(box(COIN_BOX)).toHaveValue('250');
    expect(box(COIN_BOX)).toHaveAttribute('data-driving', 'true');
    expect(review()).toBeEnabled();
  }, 20_000);

  it('tokens that need more of the coin than the wallet holds: the same words, and "Use" makes the coin drive', async () => {
    const { panel, box, type, review } = await openAdd(view(coin, LOW));
    await within(panel).findByRole('button', { name: 'Max tokens' });
    type('Tokens to add', '40000');
    // 40,000 tokens buy 396,039 shares, which cost 396.039 of the coin.
    await waitFor(() => expect(panel).toHaveTextContent(`This needs up to 396.039 ${symbol} and your wallet has 250 ${symbol}.`), { timeout: 4_000 });
    expect(review()).toBeDisabled();
    fireEvent.click(within(panel).getByRole('button', { name: `Use 250 ${symbol}` }));
    expect(box(COIN_BOX)).toHaveValue('250');
    expect(box(COIN_BOX)).toHaveAttribute('data-driving', 'true');
    expect(review()).toBeEnabled();
  }, 20_000);

  it('an amount with more decimals than the coin has is refused in the coin’s words', async () => {
    const { panel, type, review } = await openAdd(view(coin, LOW));
    await within(panel).findByRole('button', { name: `Max ${symbol}` });
    // Seven decimals: fine for SOL (9), one too many for a coin with 6.
    type(COIN_BOX, '1.1234567');
    expect(within(panel).getByText(`That is not a ${symbol} amount (at most 6 decimals).`)).toBeInTheDocument();
    expect(review()).toBeDisabled();
    type(COIN_BOX, '1.123456');
    expect(within(panel).queryByText(/That is not a/)).toBeNull();
    expect(review()).toBeEnabled();
  });

  it('the coin balance comes from the coin’s own account, never from wrapped SOL', async () => {
    // A wallet that also holds 7 wrapped SOL. A coin pool's read does not look at that
    // account at all; a form that did would offer 7,000 of the coin.
    const both = walletOf(coin, { wsol: { exists: true, amount: 7n * 10n ** 9n } });
    const { panel, box } = await openAdd(view(coin, LOW), { readers: { wallet: vi.fn(async () => both) } });
    fireEvent.click(await within(panel).findByRole('button', { name: `Max ${symbol}` }));
    expect(box(COIN_BOX)).toHaveValue('250');
    expect(within(panel).getByText(`You have 250 ${symbol}.`)).toBeInTheDocument();
    expect(panel).not.toHaveTextContent('wrapped SOL');
  });

  it('a wallet with no account for the coin is told so, and Review is off', async () => {
    const none = walletOf(coin, { coin: noCoinAccount });
    const { panel, type, review } = await openAdd(view(coin, LOW), { readers: { wallet: vi.fn(async () => none) } });
    const cannot = await within(panel).findByTestId('lp-add-cannot');
    expect(cannot).toHaveTextContent(`This wallet holds no ${symbol}, so it cannot add to this pool yet. A pool needs both ${symbol} and the token.`);
    // The coin is had on the swap, opened on the coin by its address.
    expect(within(cannot).getByRole('link', { name: 'this site’s Solana swap' })).toHaveAttribute('href', `/solana?out=${coin.mint}`);
    expect(within(panel).getByText(`You have no ${symbol}: this wallet has no account for it.`)).toBeInTheDocument();
    expect(review()).toBeDisabled();
    expect(within(panel).getByTestId('lp-review-why')).toHaveTextContent('Review is off for this wallet: the top of this form says what it is short of.');
    // Typing the token side cannot get round it, and no "Use 0" is offered.
    type('Tokens to add', '5000');
    await waitFor(() => expect(panel).toHaveTextContent(`This needs up to 49.504 ${symbol} and your wallet has 0 ${symbol}.`), { timeout: 4_000 });
    expect(within(panel).queryByRole('button', { name: /^Use / })).toBeNull();
    expect(review()).toBeDisabled();
  }, 20_000);

  it('a wallet with an empty account for the coin is told it holds none', async () => {
    const empty = walletOf(coin, { coin: { address: COIN_ACCOUNT, exists: true, amount: 0n } });
    const { panel, review } = await openAdd(view(coin, LOW), { readers: { wallet: vi.fn(async () => empty) } });
    expect(await within(panel).findByTestId('lp-add-cannot')).toHaveTextContent(`This wallet holds no ${symbol}, so it cannot add to this pool yet.`);
    expect(within(panel).getByText(`You have 0 ${symbol}.`)).toBeInTheDocument();
    expect(review()).toBeDisabled();
  });

  it('a wallet with the coin but too little SOL for the fee and the share account is told so, and Review is off', async () => {
    const poor = walletOf(coin, { lamports: 3_000_000n });
    const { panel, type, review } = await openAdd(view(coin, LOW), { readers: { wallet: vi.fn(async () => poor) } });
    const cannot = await within(panel).findByTestId('lp-add-cannot');
    // (5,000 + 1,000,000) for one signature and the reserve, 2,039,280 for the pool-share
    // account, and 890,880 kept in the wallet. No wrapped-SOL account is opened, so none is paid for.
    expect(cannot).toHaveTextContent(
      `This wallet cannot add to this pool yet. That needs about ${solAbout(3_935_160n)} for fees and account deposits, and this wallet has 0.003 SOL. No SOL goes into the pool, but those costs are paid in SOL.`,
    );
    expect(cannot).not.toHaveTextContent(`holds no ${symbol}`);
    expect(within(cannot).getByTestId('lp-funding-next')).toHaveTextContent('Send SOL to this wallet, then come back to this tab.');
    // The amounts fit the coin and the token, and it still cannot be paid for.
    type(`${symbol} to add`, '100');
    expect(within(panel).getByTestId('lp-add-preview')).toBeInTheDocument();
    expect(review()).toBeDisabled();
    expect(within(panel).getByTestId('lp-review-why')).toHaveTextContent('Review is off for this wallet: the top of this form says what it is short of.');
  });

  it('the SOL it needs is the fee and the share account’s deposit only when that account is missing', async () => {
    // The same 0.003 SOL covers it once the pool-share account exists: 1,005,000 + 890,880.
    const has = walletOf(coin, { lamports: 3_000_000n, lpAccountExists: true });
    const { panel, type, review } = await openAdd(view(coin, LOW), { readers: { wallet: vi.fn(async () => has) } });
    await within(panel).findByRole('button', { name: `Max ${symbol}` });
    expect(within(panel).queryByTestId('lp-add-cannot')).toBeNull();
    type(`${symbol} to add`, '100');
    expect(review()).toBeEnabled();
  });

  it.each([
    [3_935_160n, true],
    [3_935_159n, false],
  ] as const)('exactly the SOL it needs is enough, one lamport less is not (%s lamports)', async (lamports, enough) => {
    const w = walletOf(coin, { lamports });
    const { panel, type, review } = await openAdd(view(coin, LOW), { readers: { wallet: vi.fn(async () => w) } });
    await within(panel).findByRole('button', { name: `Max ${symbol}` });
    type(`${symbol} to add`, '100');
    expect(within(panel).queryByTestId('lp-add-cannot') === null).toBe(enough);
    expect((review() as HTMLButtonElement).disabled).toBe(!enough);
  });

  it('an unread wallet shows no Max and no 0', async () => {
    const { panel, type, review } = await openAdd(view(coin, LOW), { readers: { wallet: vi.fn(async () => ({ kind: 'unread' as const, detail: 'HTTP 502' })) } });
    await waitFor(() => expect(within(panel).getAllByText('You have: could not read (HTTP 502)')).toHaveLength(2));
    expect(within(panel).queryByRole('button', { name: `Max ${symbol}` })).toBeNull();
    expect(within(panel).queryByRole('button', { name: 'Max tokens' })).toBeNull();
    expect(panel).not.toHaveTextContent(`0 ${symbol}`);
    expect(panel).not.toHaveTextContent(`no ${symbol}`);
    expect(within(panel).queryByTestId('lp-add-cannot')).toBeNull();
    // Nothing is judged from a read that did not happen: the review's own reads decide.
    type(`${symbol} to add`, '100');
    expect(review()).toBeEnabled();
  });

  it('a wallet read that has no answer for the coin shows no Max for it, and never a 0', async () => {
    // The read came back without the coin's account. That is unread, not "none".
    const blank = walletOf(coin, { coin: null });
    const { panel } = await openAdd(view(coin, LOW), { readers: { wallet: vi.fn(async () => blank) } });
    await within(panel).findByRole('button', { name: 'Max tokens' });
    expect(within(panel).queryByRole('button', { name: `Max ${symbol}` })).toBeNull();
    expect(within(panel).getByText(`You have: could not read (this wallet’s ${symbol} was not read)`)).toBeInTheDocument();
    expect(panel).not.toHaveTextContent(`0 ${symbol}`);
    expect(within(panel).queryByTestId('lp-add-cannot')).toBeNull();
  });
});

describe('what the pool’s coin adds to the risks, on the Add form', () => {
  it('USDC: its line is on the form, before Review', async () => {
    const { panel, review } = await openAdd(view(USDC_QUOTE, LOW));
    const risk = within(panel).getByTestId('lp-add-coin-risk');
    expect(USDC_QUOTE.risk).toMatch(/Circle/);
    expect(risk).toHaveTextContent(USDC_QUOTE.risk!);
    expect(risk.compareDocumentPosition(review()) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it.each([
    ['BAYLA', BAYLA_QUOTE],
    ['SOL', SOL_QUOTE],
  ] as const)('%s: no line, because the coin adds none', async (_n, coin) => {
    expect(coin.risk).toBeNull();
    const { panel } = await openAdd(view(coin, LOW));
    await walletRead(panel);
    expect(within(panel).queryByTestId('lp-add-coin-risk')).toBeNull();
    expect(panel).not.toHaveTextContent('Circle');
  });
});

describe('a SOL pool’s Add form says what it always said', () => {
  it('SOL’s box, SOL’s rent band, and the note about wrapped SOL', async () => {
    const v = view(SOL_QUOTE, HIGH);
    const { r, panel, type, row } = await openAdd(v);
    await within(panel).findByRole('button', { name: 'Max SOL' });
    // Asked exactly as before the coins: no options at all.
    expect(r.wallet).toHaveBeenCalledWith(OWNER, v.tokenMint, TOKEN_PROGRAM, v.snapshot.pool.lpMint);
    // 5 SOL less (5,000 + 1,000,000), the share account's 2,039,280 and the wrapped-SOL account's 2,039,280.
    expect(within(panel).getByText('You have 5 SOL. Up to 4.9949 SOL can go in after fees and account deposits.')).toBeInTheDocument();
    expect(panel).toHaveTextContent(
      'Your SOL is wrapped into a token account for the deposit, and the account is closed at the end, so anything not used comes back as plain SOL.',
    );
    expect(panel).not.toHaveTextContent('Nothing is wrapped');
    type('SOL to add', '1');
    expect(row('At most')).toHaveTextContent('1 SOL and 99.99909 tokens');
    type('SOL to add', '1.1234567891');
    expect(within(panel).getByText('That is not a SOL amount (at most 9 decimals).')).toBeInTheDocument();
  });
});

describe.each(COINS)('Remove liquidity from a pool paired with %s', (symbol, coin) => {
  const ARRIVES = `The ${symbol} arrives in`;

  it.each(ORDERS)('the preview says what comes back in the coin’s own decimals, and Review names the pool’s coin (%s)', async (_n, mint, coinFirst) => {
    const v = view(coin, mint);
    expect(v.quoteIsToken0).toBe(coinFirst);
    const { r, api, panel, p, review, row } = await openRemove(v, { api: fakeLpApi({ prepareLpWithdraw: notSent() }) });
    expect(r.wallet).toHaveBeenCalledWith(OWNER, v.tokenMint, TOKEN_PROGRAM, null, { quote: coin });
    expect(row('You hold')).toHaveTextContent(`0.00025 pool shares, 25.0000% of the pool, worth about 250 ${symbol} and 25,000 tokens now`);
    fireEvent.click(within(panel).getByRole('button', { name: '50%' }));
    // Half of a quarter of 1,000 of the coin and 100,000 tokens; "at least" is 1% under.
    expect(row('You get about')).toHaveTextContent(`125 ${symbol} and 12,500 tokens`);
    expect(row('You get at least')).toHaveTextContent(`123.75 ${symbol} and 12,375 tokens`);
    expect(panel).not.toHaveTextContent('The SOL arrives');
    expect(review()).toBeEnabled();
    await act(async () => {
      fireEvent.click(review());
    });
    expect(api.prepareLpWithdraw).toHaveBeenCalledTimes(1);
    expect(vi.mocked(api.prepareLpWithdraw).mock.calls[0]![2]).toEqual({
      owner: OWNER,
      pool: new PublicKey(v.address),
      tokenMint: mint,
      quoteMint: new PublicKey(coin.mint),
      lpAccount: new PublicKey(p.lpAccount),
      pctBps: 5_000n,
      slippageBps: 100n,
    });
  }, 20_000);

  it('the coin arrives in the wallet’s own account for it, and nothing is opened when it has one', async () => {
    const { panel, row } = await openRemove(view(coin, LOW));
    fireEvent.click(within(panel).getByRole('button', { name: '50%' }));
    await waitFor(() => expect(row(ARRIVES)).toHaveTextContent(COIN_ACCOUNT));
    expect(row('The tokens arrive in')).toHaveTextContent(TOKEN_ACCOUNT);
    expect(panel).not.toHaveTextContent('Opened for you');
    expect(row('Network fee and account deposit')).toHaveTextContent('about 0.000005 SOL');
    expect(within(panel).queryByTestId('lp-remove-may-lack-sol')).toBeNull();
  });

  it('a wallet with no account for the coin: one is opened for it, what that costs is said, and Review stays on', async () => {
    const none = walletOf(coin, { coin: noCoinAccount });
    const { api, panel, review, row } = await openRemove(view(coin, LOW), { api: fakeLpApi({ prepareLpWithdraw: notSent() }), readers: { wallet: vi.fn(async () => none) } });
    fireEvent.click(within(panel).getByRole('button', { name: '50%' }));
    await waitFor(() => expect(row(ARRIVES)).toHaveTextContent(COIN_ACCOUNT));
    // USDC's account is 165 bytes; BAYLA's is 170 and costs more. Never the classic figure for both.
    const deposit = coin === BAYLA_QUOTE ? '0.00207408 SOL' : '0.00203928 SOL';
    // The line right under the coin's row, before the tokens' row.
    expect(row(ARRIVES)!.parentElement!.nextElementSibling).toHaveTextContent(`Opened for you; its deposit of ${deposit} stays in that account.`);
    expect(within(panel).getAllByText(/^Opened for you/)).toHaveLength(1);
    expect(row('Network fee and account deposit')).toHaveTextContent(coin === BAYLA_QUOTE ? 'about 0.00207908 SOL' : 'about 0.00204428 SOL');
    // 5 SOL covers it: no warning.
    expect(within(panel).queryByTestId('lp-remove-may-lack-sol')).toBeNull();
    expect(review()).toBeEnabled();
    await act(async () => {
      fireEvent.click(review());
    });
    expect(api.prepareLpWithdraw).toHaveBeenCalledTimes(1);
  }, 20_000);

  it('neither account: both are opened, and the deposits are added up', async () => {
    const none = walletOf(coin, { coin: noCoinAccount, token: null });
    const { panel, review, row } = await openRemove(view(coin, LOW), { readers: { wallet: vi.fn(async () => none) } });
    fireEvent.click(within(panel).getByRole('button', { name: '50%' }));
    await waitFor(() => expect(row('The tokens arrive in')).toHaveTextContent(TOKEN_ATA));
    expect(within(panel).getAllByText(/^Opened for you; its deposit of/)).toHaveLength(2);
    // 5,000 for the fee, 2,039,280 for the token account and the coin account's own.
    expect(row('Network fee and account deposit')).toHaveTextContent(coin === BAYLA_QUOTE ? 'about 0.00411836 SOL' : 'about 0.00408356 SOL');
    expect(review()).toBeEnabled();
  });

  it('a deposit that was not read is never a number: a Token-2022 token’s account is sized at the review', async () => {
    const none = walletOf(coin, { coin: noCoinAccount, token: null });
    const { panel, review, row } = await openRemove(view(coin, LOW, { token2022: true }), { readers: { wallet: vi.fn(async () => none) } });
    fireEvent.click(within(panel).getByRole('button', { name: '50%' }));
    await waitFor(() => expect(row(ARRIVES)).toHaveTextContent(COIN_ACCOUNT));
    // The coin's deposit is known and said. The token's is not, so no total is given.
    expect(row('Network fee and account deposit')).toHaveTextContent(
      `about ${solAbout(5_000n)}, plus a deposit for the token account and the ${symbol} account it opens (the review shows them)`,
    );
    expect(within(panel).getByText('Opened for you; its deposit stays in that account (the review shows the amount).')).toBeInTheDocument();
    expect(within(panel).getAllByText(/^Opened for you; its deposit of/)).toHaveLength(1);
    expect(review()).toBeEnabled();
  });

  it('too little SOL to open the coin’s account is a warning, and Review stays on', async () => {
    const poor = walletOf(coin, { coin: noCoinAccount, lamports: 1_000_000n });
    const { api, panel, review } = await openRemove(view(coin, LOW), { api: fakeLpApi({ prepareLpWithdraw: notSent() }), readers: { wallet: vi.fn(async () => poor) } });
    fireEvent.click(within(panel).getByRole('button', { name: '50%' }));
    const warn = await within(panel).findByTestId('lp-remove-may-lack-sol');
    const deposit = coin === BAYLA_QUOTE ? '0.00207408 SOL' : '0.00203928 SOL';
    expect(warn).toHaveTextContent(
      `This wallet may be short of SOL for this. It has 0.001 SOL. This withdrawal opens the ${symbol} account, whose deposit is ${deposit}, and pays the network fee. You can still press Review: it test-runs the withdrawal and says for sure.`,
    );
    // The builder and its test run decide, not this form.
    expect(review()).toBeEnabled();
    await act(async () => {
      fireEvent.click(review());
    });
    expect(api.prepareLpWithdraw).toHaveBeenCalledTimes(1);
  }, 20_000);

  it('a wallet with both accounts and almost no SOL is told nothing: nothing is opened', async () => {
    const poor = walletOf(coin, { lamports: 10_000n });
    const { panel, review, row } = await openRemove(view(coin, LOW), { readers: { wallet: vi.fn(async () => poor) } });
    fireEvent.click(within(panel).getByRole('button', { name: '50%' }));
    await waitFor(() => expect(row(ARRIVES)).toHaveTextContent(COIN_ACCOUNT));
    expect(within(panel).queryByTestId('lp-remove-may-lack-sol')).toBeNull();
    expect(review()).toBeEnabled();
  });

  it('an unread wallet: nothing is claimed about the coin’s account, and Review stays on', async () => {
    const { api, panel, review, row } = await openRemove(view(coin, LOW), {
      api: fakeLpApi({ prepareLpWithdraw: notSent() }),
      readers: { wallet: vi.fn(async () => ({ kind: 'unread' as const, detail: 'HTTP 502' })) },
    });
    fireEvent.click(within(panel).getByRole('button', { name: '50%' }));
    expect(row(ARRIVES)).toHaveTextContent(`this wallet’s own ${symbol} account, opened for you if it has none (not read yet; the review will say)`);
    await waitFor(() =>
      expect(row('Network fee and account deposit')).toHaveTextContent(`about ${solAbout(5_000n)}, plus a deposit if your token account or your ${symbol} account is missing`),
    );
    expect(panel).not.toHaveTextContent('Opened for you');
    expect(panel).not.toHaveTextContent(COIN_ACCOUNT);
    expect(within(panel).queryByTestId('lp-remove-may-lack-sol')).toBeNull();
    // What comes back is from the pool, not the wallet, so it is still said.
    expect(row('You get about')).toHaveTextContent(`125 ${symbol} and 12,500 tokens`);
    expect(review()).toBeEnabled();
    await act(async () => {
      fireEvent.click(review());
    });
    expect(api.prepareLpWithdraw).toHaveBeenCalledTimes(1);
  }, 20_000);

  it('a wallet read with no answer for the coin: the same, and Review stays on', async () => {
    const blank = walletOf(coin, { coin: null });
    const { panel, review, row } = await openRemove(view(coin, LOW), { readers: { wallet: vi.fn(async () => blank) } });
    fireEvent.click(within(panel).getByRole('button', { name: '50%' }));
    await waitFor(() => expect(row('The tokens arrive in')).toHaveTextContent(TOKEN_ACCOUNT));
    expect(row(ARRIVES)).toHaveTextContent('not read yet; the review will say');
    expect(panel).not.toHaveTextContent('Opened for you');
    expect(review()).toBeEnabled();
  });

  it('a price that cannot be checked switches Add off and leaves Remove on', async () => {
    // Jupiter gives no price for the coin: the pool's deposits are unchecked.
    const v = view(coin, LOW);
    const { review, panel } = await openRemove(v, {
      path: `/pools?mint=${v.tokenMint}`,
      readers: { outsidePrice: vi.fn(async () => ({ kind: 'unread' as const, detail: 'Jupiter did not give a price (HTTP 502)' })) },
    });
    const card = await screen.findByTestId('lp-pool');
    await waitFor(() => expect(card).toHaveAttribute('data-add', 'checks'));
    expect(within(card).queryByRole('button', { name: 'Add liquidity' })).toBeNull();
    fireEvent.click(within(panel).getByRole('button', { name: 'All' }));
    expect(review()).toBeEnabled();
  });

  it('a token that is blocked on this site can still be taken out', async () => {
    const v = view(coin, LOW);
    const blocked: TokenSafety = { ...okToken(v.tokenMint), verdict: 'blocked', blocks: [{ code: 'freeze-authority', text: 'Its creator can still freeze token accounts.' }] } as TokenSafety;
    const { panel, review } = await openRemove(v, { readers: { safety: vi.fn(async () => new Map([[v.tokenMint, blocked]])) } });
    fireEvent.click(within(panel).getByRole('button', { name: 'All' }));
    expect(panel).toHaveTextContent('This token is blocked on this site for new deposits (Its creator can still freeze token accounts.). You can still take your liquidity out.');
    expect(review()).toBeEnabled();
  });
});

describe('a SOL pool’s Remove form says what it always said', () => {
  it('SOL comes back as SOL, and a wallet short of SOL for the token account is told nothing new', async () => {
    const v = view(SOL_QUOTE, HIGH);
    const poor = walletOf(SOL_QUOTE, { token: null, lamports: 1_000_000n });
    const { r, panel, review, row } = await openRemove(v, { readers: { wallet: vi.fn(async () => poor) } });
    expect(r.wallet).toHaveBeenCalledWith(OWNER, v.tokenMint, TOKEN_PROGRAM, null);
    fireEvent.click(within(panel).getByRole('button', { name: '50%' }));
    // Half of a quarter of 10 SOL and 1,000 tokens.
    expect(row('You get about')).toHaveTextContent('1.25 SOL and 125 tokens');
    expect(row('You get at least')).toHaveTextContent('1.2375 SOL and 123.75 tokens');
    await waitFor(() => expect(row('The SOL arrives')).toHaveTextContent('as plain SOL'));
    expect(panel).not.toHaveTextContent('arrives in');
    expect(within(panel).queryByTestId('lp-remove-may-lack-sol')).toBeNull();
    expect(review()).toBeEnabled();
  });
});
