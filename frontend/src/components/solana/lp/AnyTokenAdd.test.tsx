// "Any token may have a pool" (owner ruling 2026-10-04), on the pool card and the Add form.
//
// Four things used to refuse a deposit and are WARNINGS now: a price more than 3% from
// what it was checked against, no market price at all, a token its creator can freeze,
// and a token that copies a well-known name. The rule these tests pin, for each:
//   - the card never says "the checks pass" and nothing else: its heading says there are
//     warnings, and each one is listed;
//   - the form says each one above Review, and a price that is off also says what it is
//     estimated to cost at the amounts typed, IN THE POOL'S OWN COIN (USDC and BAYLA have
//     6 decimals: a loss printed with SOL's 9 would be a thousand times too small);
//   - a warning never switches Review off;
//   - what still refuses a deposit (a frozen vault) still refuses it, with no Add button,
//     and what could not be read is still "not checked", never a warning.
//
// The checks are the real ones (poolHealth.ts), fed by fake readers. The write layer is a
// fake (fakeLpWriteApi.fixture.ts). Nothing here touches a chain.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, render, screen, waitFor, within, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { PublicKey } from '@solana/web3.js';
import { LpInner, type LpWritesOverrides } from './SolanaLpSection';
import { PoolCard } from './PoolCard';
import { LpWritesProvider } from './useLpWrites';
import type { LpReaders } from './readers';
import type { TokenSafety } from '../../../lib/solana/lp/tokenSafety';
import { BAYLA_QUOTE, SOL_QUOTE, USDC_QUOTE, type QuoteCoin } from '../../../lib/solana/lp/quotes';
import type { OutsidePrice } from '../../../lib/solana/lp/outsidePrice';
import { assessPool, type PoolHealth } from '../../../lib/solana/lp/poolHealth';
import type { PoolSearchRead, PoolView } from '../../../lib/solana/lp/poolFinder';
import { decodeAmmConfig, decodePoolState } from '../../../lib/solana/cpswap/program';
import type { WalletFacts } from '../../../lib/solana/lp/walletFacts';
import type { Position } from '../../../lib/solana/lp/positions';
import { buildPool, key, keyStartingWith } from '../../../lib/solana/lp/testkit.fixture';
import { LP_COPY } from '../../../lib/launcher/solana/write/liquidity';
import { prepared } from '../curve/fakeWriteApi.fixture';
import type { LpWriteApi } from '../curve/ports';
import { fakeLpApi, lpDepositSummary, lpOpenGate, LP_PROGRAM, unusedGateRpc } from './fakeLpWriteApi.fixture';

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

const MINT = keyStartingWith(1);
const M = MINT.toBase58();
const UNIT = 10n ** 6n;

/** A SOL pool: 10 SOL and 1,000 tokens. Any other coin: 1,000 of it and 100,000 tokens. Either way 0.01 of the coin a token. */
function view(coin: QuoteCoin, o: { frozen?: boolean; origin?: PoolView['origin'] } = {}): PoolView {
  const q = coin.native ? 10n * 10n ** 9n : 1_000n * UNIT;
  const t = coin.native ? 1_000n * UNIT : 100_000n * UNIT;
  const b = buildPool({ plain: true, mint: MINT, quote: coin, configIndex: 1, quoteReserve: q, tokenReserve: t, openTime: 1n });
  const pool = decodePoolState(b.address.toBase58(), b.accounts[b.address.toBase58()]!.data)!;
  const config = decodeAmmConfig(b.config.toBase58(), b.accounts[b.config.toBase58()]!.data);
  const quoteIsToken0 = pool.token0Mint === coin.mint;
  return {
    address: b.address.toBase58(),
    origin: o.origin ?? 'other',
    snapshot: { pool, vault0Amount: quoteIsToken0 ? q : t, vault1Amount: quoteIsToken0 ? t : q, reserve0: quoteIsToken0 ? q : t, reserve1: quoteIsToken0 ? t : q },
    config,
    tokenMint: M,
    quote: coin,
    quoteIsToken0,
    quoteReserve: q,
    tokenReserve: t,
    vaultsFrozen: o.frozen ?? false,
    history: { kind: 'not-read' },
  };
}

const okToken: TokenSafety = {
  kind: 'read', mint: M, verdict: 'ok', blocks: [], warnings: [], name: 'Corn', symbol: 'CORN', metadataSource: 'metaplex',
  facts: { program: 'spl-token', mintAuthority: null, freezeAuthority: null, supply: 1n, decimals: 6, isInitialized: true, extensions: [], metadataPointer: null, tokenMetadata: null },
};
// What the token check says of a token that can be frozen and that copies a name: its own
// sentences, with the codes the deposit check reads (poolHealth.ts `tokenReasons`).
const FREEZE_TOKEN_LINE =
  'Its creator can freeze any account that holds it (freeze authority 9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin), a pool’s own vault and your own account included. While a pool’s vault is frozen, nobody can take liquidity out of that pool.';
const COPY_TOKEN_LINE = 'It calls itself USDC, but it is NOT the real USDC (whose mint is EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v). It is a different token that copied the name.';
const freezableCopy: TokenSafety = {
  ...okToken,
  verdict: 'warn',
  name: 'USD Coin',
  symbol: 'USDC',
  warnings: [
    { code: 'freeze-authority', text: FREEZE_TOKEN_LINE },
    { code: 'copies-known-name', text: COPY_TOKEN_LINE },
  ],
} as TokenSafety;

function search(v: PoolView): PoolSearchRead {
  return {
    kind: 'ok',
    search: {
      mint: M,
      known: { launchPool: key().toBase58(), standard: [{ index: 1, config: key().toBase58(), address: key().toBase58(), quote: SOL_QUOTE.mint }] },
      index: { kind: 'ok', pools: [v.address], truncated: false },
      pools: [{ kind: 'pool' as const, view: v }],
      otherPairs: 0,
      knownState: {},
      chainNow: 1_000n,
    },
  };
}

/** 5 SOL, 50,000 tokens, and 250 of the coin when the coin is not SOL. */
const walletOf = (coin: QuoteCoin): WalletFacts => ({
  kind: 'ok',
  lamports: 5n * 10n ** 9n,
  token: { address: key().toBase58(), amount: 50_000n * UNIT },
  wsol: { exists: false, amount: 0n },
  coin: coin.native ? null : { address: key().toBase58(), exists: true, amount: 250n * UNIT },
  lpAccountExists: false,
  rents: { walletFloor: 890_880n, tokenAccount165: 2_039_280n, ...(coin.native ? {} : { coinAccount: 2_039_280n }) },
});

/** The coin's own price, as Jupiter answers it: in SOL. */
const COIN_IN_SOL = 0.005;
/**
 * The token's outside price, in SOL, that makes the pool's 0.01 of its coin a token read
 * `times` the market: 1 agrees, 1.1 puts the pool 10% above, 1 / 1.1 puts it 9.1% below.
 */
const tokenAt = (coin: QuoteCoin, times: number): OutsidePrice => ({ kind: 'ok', solPerToken: (coin.native ? 0.01 : 0.01 * COIN_IN_SOL) / times, source: 'Jupiter' });
const NO_ROUTE: OutsidePrice = { kind: 'no-route', detail: 'Jupiter has no route for this token' };

function readers(v: PoolView, o: { token?: OutsidePrice; safety?: TokenSafety } = {}): LpReaders {
  const coin = v.quote;
  const token = o.token ?? tokenAt(coin, 1);
  return {
    programId: LP_PROGRAM,
    safety: vi.fn(async () => new Map([[M, o.safety ?? okToken]])),
    findPools: vi.fn(async () => search(v)),
    outsidePrice: vi.fn(async (mint: string): Promise<OutsidePrice> => (mint === M ? token : { kind: 'ok', solPerToken: COIN_IN_SOL, source: 'Jupiter' })),
    positions: vi.fn(async () => ({ kind: 'ok' as const, positions: [], chainNow: 1n, totalShares: 0 })),
    feeTiers: vi.fn(async () => ({ kind: 'ok' as const, openingDeposits: null, tiers: [] })),
    wallet: vi.fn(async () => walletOf(coin)),
    placeShareOnChain: vi.fn(async () => ({ kind: 'not-found' as const })),
  };
}

/** The same check the page runs, on the same reads: what the card and the form must say. */
const healthOf = (v: PoolView, o: { token?: OutsidePrice; safety?: TokenSafety } = {}): PoolHealth =>
  assessPool({
    view: v,
    tokenDecimals: 6,
    chainNow: 1_000n,
    outside: o.token ?? tokenAt(v.quote, 1),
    coinOutside: v.quote.native ? null : { kind: 'ok', solPerToken: COIN_IN_SOL, source: 'Jupiter' },
    safety: o.safety ?? okToken,
  });

const notSent = () => vi.fn(async () => ({ ok: false as const, outcome: { status: 'not-sent' as const, stage: 'build' as const, message: 'x' } }));

function mount(r: LpReaders, api: LpWriteApi = fakeLpApi({ prepareLpDeposit: notSent() }), mode: LpWritesOverrides['mode'] = 'on') {
  const writes: LpWritesOverrides = { mode, load: vi.fn(async () => api), gateRpc: unusedGateRpc };
  render(
    <MemoryRouter initialEntries={[`/pools?mint=${M}`]}>
      <LpInner readers={r} writes={writes} />
    </MemoryRouter>,
  );
  return api;
}

/** The pool's card, once its checks and the gate have both answered. */
async function cardWith(add: string) {
  const c = await screen.findByTestId('lp-pool');
  await waitFor(() => expect(c).toHaveAttribute('data-add', add));
  return c;
}
const cardRow = (c: HTMLElement, label: string) => within(c).getByText(label).nextElementSibling?.textContent;

/** Open the card's Add form, with the wallet read in. */
async function openAdd(c: HTMLElement, coin: QuoteCoin) {
  fireEvent.click(within(c).getByRole('button', { name: 'Add liquidity' }));
  const panel = await screen.findByTestId('lp-add-panel');
  await within(panel).findByRole('button', { name: `Max ${coin.symbol}` });
  const type = (value: string) => fireEvent.change(within(panel).getByLabelText(`${coin.symbol} to add`), { target: { value } });
  const review = () => within(panel).getByRole('button', { name: 'Review: add liquidity' });
  /** The lines under "Read these before you review", in order. */
  const said = () => Array.from(within(panel).getByTestId('lp-add-warnings').querySelectorAll('p')).slice(1).map((p) => p.textContent);
  return { panel, type, review, said };
}

const HEAD = 'Read these before you review. You can still add, and each one is a risk to what you put in:';
const PRICE_10_ABOVE = 'Its price is 10.0% above the outside price. A deposit here would hand that gap to the first arbitrage trade.';
const NO_MARKET =
  'Jupiter has no market price for this token, so this pool’s price was not checked against anything. If it is off, a deposit here hands the difference to whoever trades it back.';
const TYPE_FIRST = 'Type an amount to see about how much that could cost you.';

/**
 * What goes in, and what moving the pool's price back to the market is estimated to take
 * of it: `(√x − √(y × m))²` with x the coin put in, y the tokens and m the market price,
 * 0.01 / 1.1. Typing 1 SOL puts in 0.99009 SOL and 99.009 tokens: 0.002144269 SOL.
 * Typing 100 of a coin puts in 99.009 of it and 9,900.9 tokens: 0.214427 of the coin,
 * which is 214,427 of its smallest units. Read as lamports that would be 0.000214427 SOL.
 */
const CASES = [
  ['SOL', SOL_QUOTE, '1', '0.002144269 SOL'],
  ['USDC', USDC_QUOTE, '100', '0.214427 USDC'],
  ['BAYLA', BAYLA_QUOTE, '100', '0.214427 BAYLA'],
] as const;

beforeEach(() => {
  sessionStorage.clear();
  wallet.publicKey = OWNER;
  wallet.signTransaction = async (t) => t;
});

describe.each(CASES)('a %s pool whose price is 10%% above the outside price', (symbol, coin, typed, loss) => {
  it('the card: deposits are open WITH warnings, the gap is listed as a warning, and Add is offered', async () => {
    mount(readers(view(coin), { token: tokenAt(coin, 1.1) }));
    const c = await cardWith('offer');
    expect(c).toHaveAttribute('data-deposits', 'allowed');
    expect(c).toHaveAttribute('data-price', 'disagrees');
    const deposits = within(c).getByTestId('lp-pool-deposits');
    // Not a clean pass, and not a refusal: said in the warning colour.
    expect(within(deposits).getByText('Deposits: the checks pass, with warnings')).toHaveClass('text-amber-300/90');
    expect(within(deposits).queryByText('Deposits: the checks pass')).toBeNull();
    expect(deposits).not.toHaveTextContent('refused');
    expect(within(within(c).getByTestId('lp-pool-warnings')).getByText(PRICE_10_ABOVE)).toHaveClass('text-amber-300/90');
    // Allowed: no lead-in that sets the warnings apart from a refusal.
    expect(deposits).not.toHaveTextContent('apart from that');
    // The price rows are in the pool's own coin, and the difference says which side of the line it is.
    expect(cardRow(c, 'Price here')).toBe(`1 token = 0.01 ${symbol}`);
    expect(cardRow(c, 'Outside price (Jupiter)')).toBe(`1 token = 0.009091 ${symbol}`);
    expect(cardRow(c, 'Difference')).toBe('10.0% above. That is more than 3% apart: see the warning above.');
    expect(within(c).getByRole('button', { name: 'Add liquidity' })).toBeEnabled();
  });

  it(`the form: the warning is above Review, and typing an amount says what the gap may cost, in ${symbol}`, async () => {
    const api = mount(readers(view(coin), { token: tokenAt(coin, 1.1) }));
    const { panel, type, review, said } = await openAdd(await cardWith('offer'), coin);
    const warnings = within(panel).getByTestId('lp-add-warnings');
    expect(warnings).toHaveTextContent(HEAD);
    // Nothing typed yet: nothing to estimate from, and it says so rather than showing a 0.
    expect(said()).toEqual([PRICE_10_ABOVE, TYPE_FIRST]);
    expect(warnings).not.toHaveTextContent(/\b0 (SOL|USDC|BAYLA)\b/);
    expect(warnings.compareDocumentPosition(review()) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // A screen reader that lands on Review is read them: the button is described by the block.
    expect(warnings.id).not.toBe('');
    expect(review()).toHaveAttribute('aria-describedby', warnings.id);

    type(typed);
    const LOSS_LINE = `At these amounts, a move back to the outside price would take up to about ${loss} of what you put in. That is an estimate.`;
    expect(said()).toEqual([PRICE_10_ABOVE, LOSS_LINE]);
    for (const p of Array.from(warnings.querySelectorAll('p'))) expect(p).toHaveClass('text-amber-300/90');
    // The review says the cost in the builder's words (write/liquidity.ts): the form's are the same.
    expect(LOSS_LINE).toBe(LP_COPY.priceGapLoss(loss, 'the outside price'));
    // Never the other coin's units: a coin's loss read as lamports is a thousand times too small.
    if (!coin.native) expect(warnings).not.toHaveTextContent('SOL');
    expect(warnings).not.toHaveTextContent('0.000214427');

    // A screen reader hears it with the amounts, once typing settles.
    await waitFor(() => expect(within(panel).getAllByRole('status').map((s) => s.textContent).find((t) => t?.startsWith('You would add'))).toContain(LOSS_LINE), {
      timeout: 4_000,
    });

    // A warning never switches Review off: the builder is asked, and it reads everything again.
    expect(review()).toBeEnabled();
    await act(async () => {
      fireEvent.click(review());
    });
    expect(api.prepareLpDeposit).toHaveBeenCalledTimes(1);
  }, 20_000);
});

describe('a price below the market is said once', () => {
  it('9.1% below: a warning, and never "-9.1% below"', async () => {
    mount(readers(view(SOL_QUOTE), { token: tokenAt(SOL_QUOTE, 1 / 1.1) }));
    const c = await cardWith('offer');
    expect(cardRow(c, 'Difference')).toBe('9.1% below. That is more than 3% apart: see the warning above.');
    expect(within(c).getByTestId('lp-pool-warnings')).toHaveTextContent('Its price is 9.1% below the outside price.');
    const { type, said } = await openAdd(c, SOL_QUOTE);
    type('1');
    // 0.99009 SOL and 99.009 tokens against a market of 0.011: (√0.99009 − √1.089099)².
    expect(said()[1]).toBe('At these amounts, a move back to the outside price would take up to about 0.002358696 SOL of what you put in. That is an estimate.');
  });

  it('1% below is inside the line: the same clean pass as at the market, and the row reads "1.0% below"', async () => {
    mount(readers(view(SOL_QUOTE), { token: tokenAt(SOL_QUOTE, 1 / 1.01) }));
    const c = await cardWith('offer');
    expect(c).toHaveAttribute('data-price', 'agrees');
    expect(within(c).getByText('Deposits: the checks pass')).toHaveClass('text-emerald-300/90');
    expect(within(c).queryByTestId('lp-pool-warnings')).toBeNull();
    expect(cardRow(c, 'Difference')).toBe('1.0% below');
  });
});

describe('an estimate that cannot be worked out', () => {
  it('is said as that, and never shown as 0', async () => {
    // A market price too large to multiply: the sum has no answer (opening.ts `estimatedLoss` gives null).
    mount(readers(view(SOL_QUOTE), { token: { kind: 'ok', solPerToken: 1e308, source: 'Jupiter' } }));
    const { panel, type, review, said } = await openAdd(await cardWith('offer'), SOL_QUOTE);
    type('1');
    expect(said()).toEqual([
      'Its price is 100.0% below the outside price. A deposit here would hand that gap to the first arbitrage trade.',
      'What a move back to the outside price would cost you at these amounts could not be worked out.',
    ]);
    expect(said()[1]).toBe(LP_COPY.priceGapLoss(null, 'the outside price'));
    expect(within(panel).getByTestId('lp-add-warnings')).not.toHaveTextContent(/about 0 SOL|<0\.0001/);
    expect(review()).toBeEnabled();
  });
});

describe.each([
  ['SOL', SOL_QUOTE],
  ['USDC', USDC_QUOTE],
] as const)('a %s pool anyone could open, for a token Jupiter has no market for', (symbol, coin) => {
  it('is open with a warning: its price is shown, and what it was not checked against', async () => {
    mount(readers(view(coin), { token: NO_ROUTE }));
    const c = await cardWith('offer');
    expect(c).toHaveAttribute('data-deposits', 'allowed');
    expect(c).toHaveAttribute('data-price', 'no-market');
    expect(within(c).getByText('Deposits: the checks pass, with warnings')).toBeInTheDocument();
    expect(within(c).getByTestId('lp-pool-warnings')).toHaveTextContent(NO_MARKET);
    // Read, not unread: the price is there, in the pool's coin, and nothing is called "not checked".
    expect(cardRow(c, 'Price here')).toBe(`1 token = 0.01 ${symbol}`);
    expect(cardRow(c, 'Checked against')).toBe('Nothing: Jupiter has no market price for this token');
    expect(c).not.toHaveTextContent('Deposits: not checked');
    expect(c).not.toHaveTextContent('could not be run');

    const { panel, type, review, said } = await openAdd(c, coin);
    type(coin.native ? '1' : '100');
    // Nothing to compare with, so no cost can be estimated: only the warning is said.
    expect(said()).toEqual([NO_MARKET]);
    expect(panel).not.toHaveTextContent('a move back to');
    expect(review()).toBeEnabled();
  });
});

describe('a USDC pool 10% off the market whose token is a freezable copy', () => {
  const o = { token: tokenAt(USDC_QUOTE, 1.1), safety: freezableCopy };

  it('the card, the form and the review each say all of it, in USDC', async () => {
    const v = view(USDC_QUOTE);
    // What the builder puts on the summary: the fresh check's warnings, then the cost line
    // (write/liquidity.ts step 11b). The page's own check, on the same reads, says the same.
    const health = healthOf(v, o);
    expect(health.deposits.verdict).toBe('allowed');
    expect(health.deposits.warnings).toHaveLength(3);
    const [copy, freeze, gap] = health.deposits.warnings as [string, string, string];
    expect(copy).toMatch(/well-known token’s name but has a different mint/);
    expect(freeze).toMatch(/freeze the vault of this pool/);
    expect(gap).toBe(PRICE_10_ABOVE);
    const cost = LP_COPY.priceGapLoss('0.214427 USDC', 'the outside price');
    const summary = lpDepositSummary(new PublicKey(v.address), MINT, {
      quote: USDC_QUOTE,
      quoted: { quote: 99_009_000n, token: 9_900_900_000n },
      max: { quote: 100_000_000n, token: 9_999_909_000n },
      price: health.price,
      tokenWarnings: freezableCopy.kind === 'read' ? freezableCopy.warnings : [],
      warnings: [...health.deposits.warnings, cost],
      priceGap: { diff: 0.1, lossQuote: 214_427n },
    });
    mount(readers(v, o), fakeLpApi({ prepareLpDeposit: vi.fn(async () => ({ ok: true as const, prepared: prepared(summary) })) }));

    // The card.
    const c = await cardWith('offer');
    expect(within(c).getByText('Deposits: the checks pass, with warnings')).toBeInTheDocument();
    const onCard = Array.from(within(c).getByTestId('lp-pool-warnings').querySelectorAll('p')).map((p) => p.textContent);
    expect(onCard).toEqual([copy, freeze, gap]);
    expect(cardRow(c, 'Paired with')).toBe('USDC');
    expect(cardRow(c, 'Outside price (Jupiter)')).toBe('1 token = 0.009091 USDC');
    expect(c).not.toHaveTextContent(/does not take deposits|blocked on this site|refused/);

    // The form: the token's own two sentences at the top, then the pool's three and the cost, above Review.
    const { panel, type, review, said } = await openAdd(c, USDC_QUOTE);
    expect(within(panel).getByText(FREEZE_TOKEN_LINE)).toBeInTheDocument();
    expect(within(panel).getByText(COPY_TOKEN_LINE)).toBeInTheDocument();
    type('100');
    expect(said()).toEqual([copy, freeze, gap, cost]);
    // USDC's own line (its issuer can freeze it) is still there too.
    expect(within(panel).getByTestId('lp-add-coin-risk')).toHaveTextContent(USDC_QUOTE.risk!);
    expect(review()).toBeEnabled();

    // The review: the same four sentences, first, before any row and before the Sign button.
    await act(async () => {
      fireEvent.click(review());
    });
    await within(panel).findByRole('heading', { name: 'Review: add liquidity' });
    const top = within(panel).getByTestId('tx-review-warnings');
    expect(Array.from(top.querySelectorAll('li')).map((li) => li.textContent)).toEqual([copy, freeze, gap, cost]);
    expect(top).toHaveTextContent('Read these warnings first.');
    // Before the form's own notes about the pool program too, which every review carries.
    const follows = (el: Element) => top.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING;
    expect(follows(within(panel).getByTestId('lp-review-disclosure'))).toBeTruthy();
    expect(follows(within(panel).getByText('Pool kind'))).toBeTruthy();
    const value =(label: string) => within(panel).getByText(label).nextElementSibling?.textContent;
    expect(value('Price check')).toBe('10.0% above the outside price (Jupiter), read just now. That is off by more than 3%.');
    expect(value('Estimated cost of that gap')).toBe('up to about 0.214427 USDC of what you put in');
    expect(value('You put in about')).toBe('99.009 USDC and 9,900.9 tokens');
    expect(top.compareDocumentPosition(within(panel).getByRole('button', { name: 'Sign in wallet' })) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // No amount on the coin's side of this review is in SOL.
    expect(top).not.toHaveTextContent('SOL');
  }, 30_000);

  it('with a frozen vault it is still REFUSED: the warnings are shown, and there is no Add button', async () => {
    const v = view(USDC_QUOTE, { frozen: true });
    mount(readers(v, o));
    const c = await cardWith('checks');
    expect(c).toHaveAttribute('data-deposits', 'refused');
    const deposits = within(c).getByTestId('lp-pool-deposits');
    expect(within(deposits).getByText('Deposits: refused here')).toHaveClass('text-rose-300/90');
    expect(deposits).not.toHaveTextContent('with warnings');
    // The reason that refuses it is said as a refusal, and the warnings as warnings, set apart.
    expect(within(deposits).getByText('One of this pool’s vaults is frozen by the token’s issuer or USDC’s, so nothing can move in or out of it.')).toHaveClass('text-rose-300/90');
    const warnings = within(c).getByTestId('lp-pool-warnings');
    expect(warnings).toHaveTextContent('Warnings about this pool, apart from that:');
    expect(Array.from(warnings.querySelectorAll('p')).slice(1).map((p) => p.textContent)).toEqual(healthOf(v, o).deposits.warnings);
    expect(warnings.querySelectorAll('p')).toHaveLength(4);
    expect(within(c).queryByRole('button', { name: 'Add liquidity' })).toBeNull();
    expect(screen.queryByTestId('lp-add-panel')).toBeNull();
  });

  it('with the coin’s own price unread it is NOT CHECKED: never open, and the token’s warnings are still shown', async () => {
    const v = view(USDC_QUOTE);
    const r = readers(v, o);
    // Jupiter fails for USDC itself. That is a read that failed, never "no market".
    r.outsidePrice = vi.fn(async (mint: string): Promise<OutsidePrice> => (mint === M ? o.token : { kind: 'unread', detail: 'Jupiter did not give a price (HTTP 502)' }));
    mount(r);
    const c = await cardWith('checks');
    expect(c).toHaveAttribute('data-deposits', 'unchecked');
    expect(within(c).getByText('Deposits: not checked')).toBeInTheDocument();
    expect(c).not.toHaveTextContent('with warnings');
    const warnings = within(c).getByTestId('lp-pool-warnings');
    expect(warnings).toHaveTextContent('Warnings about this pool, apart from that:');
    // The copy and the freeze are known; the price is not, so nothing is said of a gap.
    expect(warnings.querySelectorAll('p')).toHaveLength(3);
    expect(warnings).not.toHaveTextContent('outside price');
    expect(within(c).queryByRole('button', { name: 'Add liquidity' })).toBeNull();
  });
});

// A launch pool with no outside market is checked against its OWN average over the last
// half hour (poolHealth.ts). Building that history through the readers is the engine's own
// test; here the check's answer is handed to the card as it would arrive.
describe('a launch pool whose price is off its own average', () => {
  const OWN = 'Its price is 25.0% above its own average over the last half hour. Someone may have just pushed it; a deposit now would pay for that.';

  it('the card names the average, and the form says the cost of a move back to it', async () => {
    const v = view(SOL_QUOTE, { origin: 'launch-pool' });
    const health: PoolHealth = {
      swaps: { state: 'open' },
      withdrawals: 'open',
      price: { state: 'disagrees', pool: 0.01, reference: 0.008, against: 'own-average', diff: 0.25 },
      deposits: { verdict: 'allowed', reasons: [], warnings: [OWN] },
    };
    const r = readers(v);
    render(
      <LpWritesProvider readers={r} mode="on" load={vi.fn(async () => fakeLpApi({ prepareLpDeposit: notSent() }))} gateRpc={unusedGateRpc}>
        <ul>
          <PoolCard view={v} health={health} tokenDecimals={6} safety={okToken} />
        </ul>
      </LpWritesProvider>,
    );
    const c = await cardWith('offer');
    expect(within(c).getByText('Deposits: the checks pass, with warnings')).toBeInTheDocument();
    expect(cardRow(c, 'Its own average, last 30 minutes')).toBe('1 token = 0.008 SOL');
    expect(cardRow(c, 'Difference')).toBe('25.0% above. That is more than 3% apart: see the warning above.');
    const { type, said } = await openAdd(c, SOL_QUOTE);
    type('1');
    // 0.99009 SOL and 99.009 tokens against an average of 0.008: (√0.99009 − √0.792072)².
    const cost = 'At these amounts, a move back to its own average would take up to about 0.011035165 SOL of what you put in. That is an estimate.';
    expect(said()).toEqual([OWN, cost]);
    expect(cost).toBe(LP_COPY.priceGapLoss('0.011035165 SOL', 'its own average'));
  });
});

// ── What the review of these forms found (2026-10-04) ───────────────────────────────────

/** The finder's own Read again: the token, its pools and every price are read again. */
const readAgain = () => fireEvent.click(within(screen.getByRole('button', { name: 'Find pools' }).parentElement!).getByRole('button', { name: 'Read again' }));
/** The open Add form, and every line of its warnings block: the heading first. */
const form = () => screen.getByTestId('lp-add-panel');
const formLines = () => Array.from(within(form()).getByTestId('lp-add-warnings').querySelectorAll('p')).map((p) => p.textContent);
const NOT_NOW_HEAD = 'This pool’s checks no longer let a deposit through (its card above says why). Its warnings:';
const before = (a: Element, b: Element) => (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;

// An open form stays open when its pool is read again (an outcome on it must not vanish).
// So it can sit under a card that now says "refused" or "not checked", and there "You can
// still add" was false: it is said only while the pool's check says a deposit is allowed.
describe('an Add form left open while its pool stops taking deposits', () => {
  it('Jupiter fails on a re-read: the card says "not checked", and the form no longer says "You can still add"', async () => {
    const v = view(USDC_QUOTE);
    const o = { safety: freezableCopy };
    let jupiterDown = false;
    const r = readers(v, o);
    r.outsidePrice = vi.fn(async (mint: string): Promise<OutsidePrice> => {
      if (jupiterDown) return { kind: 'unread', detail: 'Jupiter did not give a price (HTTP 502)' };
      return mint === M ? tokenAt(USDC_QUOTE, 1) : { kind: 'ok', solPerToken: COIN_IN_SOL, source: 'Jupiter' };
    });
    mount(r);
    const c = await cardWith('offer');
    await openAdd(c, USDC_QUOTE);
    // At the market: the token's two warnings (a copy, and one its creator can freeze).
    const tokenWarnings = healthOf(v, o).deposits.warnings;
    expect(tokenWarnings).toHaveLength(2);
    expect(formLines()).toEqual([HEAD, ...tokenWarnings]);

    jupiterDown = true;
    readAgain();
    await waitFor(() => expect(c).toHaveAttribute('data-deposits', 'unchecked'));
    expect(c).toHaveAttribute('data-add', 'checks');
    expect(within(c).getByText('Deposits: not checked')).toBeInTheDocument();
    // The form is still open, under that card, and its warnings are still said.
    expect(c).toContainElement(form());
    expect(formLines()).toEqual([NOT_NOW_HEAD, ...tokenWarnings]);
    expect(form()).not.toHaveTextContent('You can still add');

    // Jupiter answers again: the pool takes deposits again, and the form says so again.
    jupiterDown = false;
    readAgain();
    await waitFor(() => expect(c).toHaveAttribute('data-deposits', 'allowed'));
    expect(formLines()).toEqual([HEAD, ...tokenWarnings]);
  }, 20_000);

  it('a vault is frozen on a re-read: the card says "refused here", and the form no longer says "You can still add"', async () => {
    const v = view(USDC_QUOTE);
    let frozen = false;
    const r = readers(v, { token: tokenAt(USDC_QUOTE, 1.1) });
    r.findPools = vi.fn(async () => search(frozen ? { ...v, vaultsFrozen: true } : v));
    mount(r);
    const c = await cardWith('offer');
    await openAdd(c, USDC_QUOTE);
    expect(formLines()).toEqual([HEAD, PRICE_10_ABOVE, TYPE_FIRST]);

    frozen = true;
    readAgain();
    await waitFor(() => expect(c).toHaveAttribute('data-deposits', 'refused'));
    expect(within(c).getByText('Deposits: refused here')).toBeInTheDocument();
    expect(within(c).queryByRole('button', { name: 'Add liquidity' })).toBeNull();
    expect(c).toContainElement(form());
    expect(formLines()).toEqual([NOT_NOW_HEAD, PRICE_10_ABOVE, TYPE_FIRST]);
    expect(form()).not.toHaveTextContent('You can still add');
  }, 20_000);
});

// The line was chosen on "there is no plan yet". There is also no plan when the amount in
// the box is more than the wallet holds, is zero, or is not a number.
describe('"Type an amount" is said only while nothing is typed', () => {
  it('on a pool whose price is off: said with the box empty, never with an amount in it', async () => {
    mount(readers(view(USDC_QUOTE), { token: tokenAt(USDC_QUOTE, 1.1) }));
    const { panel, type, review, said } = await openAdd(await cardWith('offer'), USDC_QUOTE);
    expect(said()).toEqual([PRICE_10_ABOVE, TYPE_FIRST]);
    // The wallet holds 250 USDC.
    for (const [what, text] of [
      ['more than the wallet holds', '1000'],
      ['zero', '0'],
      ['not a number', 'abc'],
    ] as const) {
      type(text);
      expect(within(panel).getByLabelText('USDC to add'), what).toHaveValue(text);
      // The pool's own warning stays. Nothing asks for an amount that is already there.
      expect(said(), what).toEqual([PRICE_10_ABOVE]);
      expect(panel, what).not.toHaveTextContent(TYPE_FIRST);
      expect(review(), what).toBeDisabled();
    }
    type('');
    expect(said()).toEqual([PRICE_10_ABOVE, TYPE_FIRST]);
    // An amount the wallet can cover gets the estimate in that line's place.
    type('100');
    expect(said()).toEqual([PRICE_10_ABOVE, LP_COPY.priceGapLoss('0.214427 USDC', 'the outside price')]);
    expect(review()).toBeEnabled();
  }, 20_000);
});

// The owner's rule for these forms (panelKit.ts `NOTES_BELOW`): long notes above the amount
// boxes filled a phone's first screens, and the form read as if it were not there. On the
// card a warning is read before the button it is about.
describe('where the warnings sit', () => {
  it('on the card before the Add liquidity button; in the form under both amount boxes and above Review', async () => {
    mount(readers(view(USDC_QUOTE), { token: tokenAt(USDC_QUOTE, 1.1), safety: freezableCopy }));
    const c = await cardWith('offer');
    const onCard = within(c).getByTestId('lp-pool-warnings');
    expect(onCard.querySelectorAll('p')).toHaveLength(3);
    expect(before(onCard, within(c).getByRole('button', { name: 'Add liquidity' }))).toBe(true);

    const { panel, review } = await openAdd(c, USDC_QUOTE);
    // The form opens under that button, so the card's warnings are above the form too.
    expect(before(onCard, panel)).toBe(true);
    const inForm = within(panel).getByTestId('lp-add-warnings');
    expect(inForm.querySelectorAll('p')).toHaveLength(5);
    expect(before(within(panel).getByLabelText('USDC to add'), inForm)).toBe(true);
    expect(before(within(panel).getByLabelText('Tokens to add'), inForm)).toBe(true);
    expect(before(inForm, review())).toBe(true);
  }, 20_000);
});

// The heading is about the CHECKS, so it is true whether or not this site takes deposits
// right now. "Deposits: open, with warnings" was not true while adding is paused.
describe('the card’s heading while adding is paused', () => {
  it('an allowed pool with a warning: "the checks pass, with warnings", no Add button, and nothing says deposits are open', async () => {
    const api = fakeLpApi({ gate: lpOpenGate({ mode: 'withdraw-only' }) });
    mount(readers(view(SOL_QUOTE), { token: tokenAt(SOL_QUOTE, 1.1) }), api, 'withdraw-only');
    const c = await cardWith('paused-here');
    expect(c).toHaveAttribute('data-deposits', 'allowed');
    const deposits = within(c).getByTestId('lp-pool-deposits');
    expect(within(deposits).getByText('Deposits: the checks pass, with warnings')).toHaveClass('text-amber-300/90');
    expect(within(deposits).getByTestId('lp-pool-warnings')).toHaveTextContent(PRICE_10_ABOVE);
    expect(deposits).toHaveTextContent('Adding liquidity from this site is paused. Removing it still works.');
    expect(deposits).not.toHaveTextContent(/\bopen\b/i);
    expect(within(c).queryByRole('button', { name: 'Add liquidity' })).toBeNull();
    expect(screen.queryByTestId('lp-add-panel')).toBeNull();
  });
});

// A pool has two vaults, and the read does not say which one is frozen. USDC's issuer can
// freeze the USDC one, so on a USDC pool the words said before signing must not blame the
// token alone. SOL has no issuer, and BAYLA's mint has no freeze authority (quotes.ts): on
// those pools a frozen vault can only be the token's.
describe('a frozen vault: who can have frozen it', () => {
  const position = (v: PoolView): Position => ({
    lpMint: v.snapshot.pool.lpMint,
    lpAccount: key().toBase58(),
    lpAmount: 250_000n,
    placement: 'found',
    placementDetail: null,
    pool: { kind: 'pool', view: v },
    value: { token0: 1n, token1: 2n, sharePct: 25 },
    tooSmall: false,
  });

  it.each([
    ['SOL', 'the token’s issuer', SOL_QUOTE],
    ['USDC', 'the token’s issuer or USDC’s', USDC_QUOTE],
    ['BAYLA', 'the token’s issuer', BAYLA_QUOTE],
  ] as const)('a %s pool: the deposit reason, the card’s Withdrawals row and the position’s Withdrawals row say "%s"', async (_symbol, who, coin) => {
    const v = view(coin, { frozen: true });
    const r = readers(v);
    r.positions = vi.fn(async () => ({ kind: 'ok' as const, chainNow: 1_000n, totalShares: 1, positions: [position(v)] }));
    mount(r);
    const c = await cardWith('checks');
    expect(c).toHaveAttribute('data-deposits', 'refused');
    expect(c).toHaveAttribute('data-withdrawals', 'vault-frozen');
    // Each is the whole sentence: nothing after "issuer" on a pool whose coin nobody can freeze.
    expect(within(within(c).getByTestId('lp-pool-deposits')).getByText(`One of this pool’s vaults is frozen by ${who}, so nothing can move in or out of it.`)).toHaveClass('text-rose-300/90');
    expect(cardRow(c, 'Withdrawals')).toBe(`Blocked: one of the pool’s vaults is frozen by ${who}`);
    const row = await screen.findByTestId('lp-position');
    await waitFor(() => expect(row).toHaveAttribute('data-remove', 'vault-frozen'));
    expect(within(row).getByText('Withdrawals').nextElementSibling?.textContent).toBe(`blocked: a pool vault is frozen by ${who}`);
    // The coin is named as a possible freezer on the USDC pool only.
    for (const el of [c, row]) expect(/issuer or (SOL|USDC|BAYLA)’s/.test(el.textContent ?? '')).toBe(coin === USDC_QUOTE);
  }, 20_000);
});
