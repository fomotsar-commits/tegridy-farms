// The review screen for a pool paired with USDC or BAYLA (quotes.ts). It is the last
// thing a person reads before signing, so it is where a wrong unit costs real money.
//
// THE ONE BUG THESE TESTS EXIST FOR: an amount of USDC or BAYLA printed with SOL's 9
// decimals, or with SOL's name. USDC and BAYLA have 6 decimals, so 250 USDC is
// 250_000_000 base units, and the same number read as SOL is 0.25: wrong by 1000.
// Every coin amount below is checked as the exact words on screen.
//
// SOL on the same screen stays SOL: the network fee, the priority fee, the account
// deposits, the fee to open and the test run's SOL line are paid in SOL whatever the
// pool is paired with.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, renderHook, screen, within } from '@testing-library/react';
import { PublicKey } from '@solana/web3.js';
import { SummaryRows, TxFlowView } from './TxFlowView';
import { useTxFlow } from './useTxFlow';
import { CREATOR, KEY, SIG, fakeApi, prepared } from './fakeWriteApi.fixture';
import { COIN_ACCOUNT, lpCreateSummary, lpDepositSummary, lpWithdrawSummary } from '../lp/fakeLpWriteApi.fixture';
import { coinAbout, coinExact } from '../lp/panelKit';
import { BAYLA_QUOTE, SOL_QUOTE, USDC_QUOTE, type QuoteCoin } from '../../../lib/solana/lp/quotes';
import { noPriceClause } from '../../../lib/solana/lp/poolHealth';
import type { PreparedTx, TxOutcome, TxSigner, TxSummary, WriteRpc } from './ports';

const rpc = {} as WriteRpc;
const signer: TxSigner = { publicKey: CREATOR, signTransaction: async (t) => t };

const POOL = KEY(30);
const TOKEN = KEY(31);
const LP_ACCOUNT = KEY(32);
const TOKEN_ACCOUNT = KEY(33);
const LP_MINT = KEY(34);
const FEE_RECEIVER = KEY(8);

/** The two coins that are not SOL. Both have 6 decimals; only USDC carries a risk line. */
const COINS: QuoteCoin[] = [USDC_QUOTE, BAYLA_QUOTE];

// Fees big enough to read: 0.0012 SOL of priority fee is 0.48% of 250_000_000, so a
// priority fee measured against a coin amount as if it were lamports shows on screen.
const FEES: PreparedTx['fees'] = { baseLamports: 5_000n, priorityLamports: 1_200_000n, priorityFeeRead: true, newAccountRentLamports: 2_039_280n };

/** A pool price 10% above the outside price: built for, with a warning, since 2026-10-04. */
const OFF_PRICE = { state: 'disagrees', pool: 0.011, reference: 0.01, against: 'outside', diff: 0.1 } as const;

type Deposit = Extract<TxSummary, { kind: 'lp-deposit' }>;
type Withdraw = Extract<TxSummary, { kind: 'lp-withdraw' }>;
type Create = Extract<TxSummary, { kind: 'lp-create' }>;

const deposit = (coin: QuoteCoin, over: Partial<Deposit> = {}) =>
  lpDepositSummary(POOL, TOKEN, {
    quote: coin,
    quoted: { quote: 250_123_456n, token: 5_000_000n },
    max: { quote: 252_624_691n, token: 5_050_001n },
    ...over,
  });

const withdraw = (coin: QuoteCoin, over: Partial<Withdraw> = {}) =>
  lpWithdrawSummary(POOL, TOKEN, LP_ACCOUNT, {
    quote: coin,
    quoted: { quote: 125_061_728n, token: 3_000_000n },
    min: { quote: 123_811_111n, token: 2_970_001n },
    tokenAccount: TOKEN_ACCOUNT,
    ...over,
  });

const create = (coin: QuoteCoin, over: Partial<Create> = {}) =>
  lpCreateSummary(POOL, TOKEN, {
    quote: coin,
    put: { quote: 250_000_001n, token: 10_000_000_000n },
    supply: 1_581_138_833n,
    lpAmount: 1_581_138_733n,
    locked: { quote: 15n, token: 632n },
    createFee: 150_000_000n,
    feeReceiver: FEE_RECEIVER,
    rents: { neverRefunded: 40_000_000n, lpAccount: 2_039_280n },
    price: { state: 'agrees', pool: 0.025, reference: 0.0249, against: 'outside', diff: 0.025 / 0.0249 - 1 },
    ...over,
  });

/** The review step of the real flow, as a panel shows it. `pageDecimals` is the token's, as the page read it. */
async function review(summary: TxSummary, over: Partial<PreparedTx> = {}, pageDecimals: number | null = 6) {
  const api = fakeApi();
  const { result } = renderHook(() => useTxFlow(api, rpc));
  await act(() => result.current.prepare(async () => ({ ok: true, prepared: prepared(summary, { fees: FEES, ...over }) })));
  render(<TxFlowView flow={result.current} api={api} cluster="localnet" decimals={pageDecimals} signer={signer} />);
}

const value = (label: string) => screen.getByText(label).nextElementSibling?.textContent;
const reviewText = () => screen.getByTestId('tx-review').textContent ?? '';
/** The summary alone, above the fee rows: for a coin pool's add and remove, no SOL belongs in it. */
function summaryText(summary: TxSummary): string {
  const view = render(<SummaryRows summary={summary} decimals={6} display={(s) => s} />);
  const text = view.container.textContent ?? '';
  view.unmount();
  return text;
}

/**
 * What the test run saw move in the coin's account, as the builders' watch lists report it
 * for a pool that is not paired with SOL. `decimals: null` leaves the figure out.
 */
const coinDelta = (coin: QuoteCoin, delta: bigint, decimals: number | null = coin.decimals) => ({
  mint: new PublicKey(coin.mint),
  account: COIN_ACCOUNT,
  delta,
  role: 'quote' as const,
  ...(decimals === null ? {} : { decimals }),
});

afterEach(() => {
  cleanup();
});

// ---------------------------------------------------------------------------
// Adding liquidity.
// ---------------------------------------------------------------------------

describe.each(COINS)('adding to a pool paired with $symbol: the review', (coin) => {
  const C = coin.symbol;

  it('250 of the coin reads as 250, never as the 0.25 that SOL’s 9 decimals would make of it', async () => {
    await review(deposit(coin, { quoted: { quote: 250_000_000n, token: 5_000_000n }, max: { quote: 250_000_000n, token: 5_050_001n } }));
    expect(value('You put in about')).toBe(`250 ${C} and 5 tokens`);
    expect(value('At most')).toBe(`250 ${C} and 5.050001 tokens`);
    const text = reviewText();
    expect(text).not.toContain('0.25 ');
    expect(text).not.toContain('250 SOL');
  });

  it('the rounded row is rounded and the bound is to the coin’s last digit, as the SOL rows are', async () => {
    await review(deposit(coin));
    expect(value('Paired with')).toBe(C);
    // "About" is four decimals, like every "about" on this page.
    expect(value('You put in about')).toBe(`250.1234 ${C} and 5 tokens`);
    // The maximum is what the program enforces: all six of the coin's decimals.
    expect(value('At most')).toBe(`252.624691 ${C} and 5.050001 tokens`);
  });

  it('a maximum lowered to the wallet’s balance names the coin', async () => {
    await review(deposit(coin, { limitedByBalance: 'quote' }));
    expect(value('At most')).toBe(`252.624691 ${C} and 5.050001 tokens (all the ${C} you have)`);
  });

  it('nothing is wrapped, and the review says where the coin is spent from', async () => {
    // Even if a summary claimed otherwise: a pool that is not paired with SOL wraps nothing.
    await review(deposit(coin, { unwrapsWsol: true, wsolHeldBefore: 500_000_000n }));
    expect(
      screen.getByText(`Your ${C} is spent straight from your own ${C} account. Nothing is wrapped, and what the pool does not use never leaves that account.`),
    ).toBeInTheDocument();
    expect(reviewText()).not.toMatch(/wrapped into a token account|plain SOL|wrapped SOL/);
  });

  it('no SOL is named above the fee rows: no SOL goes into this pool', () => {
    for (const limitedByBalance of ['none', 'quote', 'token'] as const) {
      expect(summaryText(deposit(coin, { limitedByBalance })), limitedByBalance).not.toContain('SOL');
    }
    // Nor when the price is off and its cost is said: that cost is the coin's.
    expect(summaryText(deposit(coin, { price: OFF_PRICE, priceGap: { diff: 0.1, lossQuote: 214_427n } }))).not.toContain('SOL');
  });

  // "Any token" (owner ruling 2026-10-04). What a price that is off may cost is an amount of
  // the pool's coin. The builder gives it in the coin's smallest units: 214,427 of them is
  // 0.214427 of the coin. Read as lamports that is 0.000214427 SOL, a thousand times too small.
  it('the estimated cost of a price that is off is in the coin, in the coin’s own decimals', async () => {
    const said = [
      'Its price is 10.0% above the outside price. A deposit here would hand that gap to the first arbitrage trade.',
      `At these amounts, a move back to the outside price would take up to about 0.214427 ${C} of what you put in. That is an estimate.`,
    ];
    await review(deposit(coin, { price: OFF_PRICE, warnings: said, priceGap: { diff: 0.1, lossQuote: 214_427n } }));
    expect(value('Price check')).toBe('10.0% above the outside price (Jupiter), read just now. That is off by more than 3%.');
    expect(value('Estimated cost of that gap')).toBe(`up to about 0.214427 ${C} of what you put in`);
    const box = screen.getByTestId('tx-review-warnings');
    // The builder's warnings, then what the coin itself adds to the risks (USDC's only).
    expect(Array.from(box.querySelectorAll('li')).map((li) => li.textContent)).toEqual(coin.risk ? [...said, coin.risk] : said);
    expect(box.textContent).not.toContain('SOL');
    expect(reviewText()).not.toContain('0.000214427');
    cleanup();
    // The smallest cost there is: one unit of the coin, never a nothing.
    await review(deposit(coin, { price: OFF_PRICE, warnings: said, priceGap: { diff: 0.1, lossQuote: 1n } }));
    expect(value('Estimated cost of that gap')).toBe(`up to about 0.000001 ${C} of what you put in`);
  }, 30_000);

  // Owner ruling 2026-10-07: Jupiter having no price for the pool's COIN does not stop a
  // deposit. The token HAS a price then, so the review's price row names the coin, and
  // nothing on it says "Jupiter has no market price for this token".
  it('adding to a pool whose coin Jupiter has no price for: the warning first, and the row names the coin, never "this token"', async () => {
    const WARNING = `Jupiter has no price for ${C} right now, so this pool’s price in ${C} was not checked against anything. If it is off, a deposit here hands the difference to whoever trades it back.`;
    await review(deposit(coin, { price: { state: 'no-market', of: 'coin', pool: 2, detail: `Jupiter has no route for ${C}` }, warnings: [WARNING] }));
    expect(value('Price check')).toBe(`not checked against anything: Jupiter has no price for ${C} right now`);
    // The same clause as every other screen (poolHealth.ts `noPriceClause`).
    expect(value('Price check')).toBe(`not checked against anything: ${noPriceClause('coin', coin)}`);
    const box = screen.getByTestId('tx-review-warnings');
    expect(Array.from(box.querySelectorAll('li')).map((li) => li.textContent)).toEqual(coin.risk ? [WARNING, coin.risk] : [WARNING]);
    expect(reviewText()).not.toMatch(/for this token|this token has/);
    // Nothing to compare with, so no gap and no cost row. A warning is not a stop: Sign is on.
    expect(screen.queryByText('Estimated cost of that gap')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Sign in wallet' })).toBeEnabled();
  });

  it('adding to a pool whose TOKEN Jupiter has no price for keeps the token’s words, whatever the coin', async () => {
    await review(deposit(coin, { price: { state: 'no-market', of: 'token', pool: 2, detail: 'Jupiter has no route for this token' } }));
    expect(value('Price check')).toBe('not checked against anything: Jupiter has no market price for this token');
    expect(value('Price check')).toBe(`not checked against anything: ${noPriceClause('token', coin)}`);
  });

  it('the costs paid in SOL stay in SOL', async () => {
    await review(deposit(coin), { simulated: { signerLamportsDelta: -3_244_280n, tokenDeltas: [] } });
    expect(value('Network fee')).toBe('<0.0001 SOL');
    expect(value('One-time deposit for your new token account (it stays in that account)')).toBe('0.002 SOL');
    expect(value('Test run: your SOL changes by')).toBe('-0.0032 SOL');
  });

  it('the priority fee is its own amount in SOL, never a share "of this trade"', async () => {
    await review(deposit(coin, { quoted: { quote: 250_000_000n, token: 5_000_000n } }));
    expect(value('Priority fee')).toBe('0.0012 SOL');
    expect(reviewText()).not.toContain('of this trade');
  });

  it('the test run names the coin and prints it in the coin’s decimals, whatever the token’s are', async () => {
    // The page's token has 9 decimals here. The coin's line must not borrow them.
    await review(
      deposit(coin),
      {
        simulated: {
          signerLamportsDelta: -3_244_280n,
          tokenDeltas: [
            { mint: TOKEN, account: TOKEN_ACCOUNT, delta: -5_000_000_000n, role: 'token', decimals: 9 },
            { mint: LP_MINT, account: LP_ACCOUNT, delta: 1_000_000n, role: 'lp', decimals: 9 },
            coinDelta(coin, -250_123_456n),
          ],
        },
      },
      9,
    );
    expect(value(`Test run: your ${C} changes by`)).toBe('-250.1234');
    expect(value('Test run: your tokens change by')).toBe('-5');
    expect(value('Test run: your pool shares change by')).toBe('+0.001');
    expect(screen.queryByText('Test run: your wrapped SOL changes by')).not.toBeInTheDocument();
    expect(screen.queryByText('Test run: your pairing coin changes by')).not.toBeInTheDocument();
  });

  it('a coin line the watch list gave no decimals for still uses the coin’s, never the token’s', async () => {
    await review(deposit(coin), { simulated: { signerLamportsDelta: -3_244_280n, tokenDeltas: [coinDelta(coin, -250_000_000n, null)] } }, 9);
    expect(value(`Test run: your ${C} changes by`)).toBe('-250');
  });

  // The line is the coin's because the account holds the coin's mint. The watch list's tag
  // and decimals are the builder's word for it, and the screen does not lean on them.
  it('the coin’s line is known by its mint: a wrong tag cannot call it wrapped SOL, and wrong decimals cannot rescale it', async () => {
    const mint = new PublicKey(coin.mint);
    await review(deposit(coin), { simulated: { signerLamportsDelta: -3_244_280n, tokenDeltas: [{ mint, account: COIN_ACCOUNT, delta: -250_000_000n, role: 'wsol', decimals: 9 }] } }, 9);
    expect(value(`Test run: your ${C} changes by`)).toBe('-250');
    expect(screen.queryByText('Test run: your wrapped SOL changes by')).not.toBeInTheDocument();
    cleanup();
    // No tag at all would read as "your tokens".
    await review(deposit(coin), { simulated: { signerLamportsDelta: -3_244_280n, tokenDeltas: [{ mint, account: COIN_ACCOUNT, delta: -250_000_000n }] } }, 9);
    expect(value(`Test run: your ${C} changes by`)).toBe('-250');
    expect(screen.queryByText('Test run: your tokens change by')).not.toBeInTheDocument();
  }, 30_000);

  it('an account tagged as a pairing coin that does not hold the pool’s coin is not given the coin’s name', async () => {
    await review(deposit(coin), { simulated: { signerLamportsDelta: -3_244_280n, tokenDeltas: [{ mint: KEY(60), account: KEY(61), delta: -250_000_000n, role: 'quote', decimals: 6 }] } });
    expect(value('Test run: your pairing coin changes by')).toBe('-250');
    expect(screen.queryByText(`Test run: your ${C} changes by`)).not.toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Removing liquidity.
// ---------------------------------------------------------------------------

describe.each(COINS)('removing from a pool paired with $symbol: the review', (coin) => {
  const C = coin.symbol;

  it('what comes back is in the coin: rounded where it says about, to the last digit where it is the floor', async () => {
    await review(withdraw(coin));
    expect(value('Paired with')).toBe(C);
    expect(value('You get about')).toBe(`125.0617 ${C} and 3 tokens`);
    expect(value('You get at least')).toBe(`123.811111 ${C} and 2.970001 tokens`);
  });

  it('250 of the coin reads as 250', async () => {
    await review(withdraw(coin, { quoted: { quote: 250_000_000n, token: 3_000_000n }, min: { quote: 250_000_000n, token: 2_970_001n } }));
    expect(value('You get about')).toBe(`250 ${C} and 3 tokens`);
    expect(value('You get at least')).toBe(`250 ${C} and 2.970001 tokens`);
    expect(reviewText()).not.toContain('0.25 ');
    expect(reviewText()).not.toContain('250 SOL');
  });

  it('the coin arrives in its own account, and no row says it arrives as SOL', async () => {
    await review(withdraw(coin));
    expect(value(`The ${C} arrives in`)).toBe(COIN_ACCOUNT.toBase58());
    expect(screen.queryByText('The SOL arrives')).not.toBeInTheDocument();
    expect(reviewText()).not.toMatch(/plain SOL|wrapped SOL/);
  });

  it('an account opened for the coin says what its deposit costs, in SOL', async () => {
    await review(withdraw(coin, { quoteAccount: { address: COIN_ACCOUNT, rent: 2_039_280n } }));
    expect(value(`The ${C} arrives in`)).toBe(`${COIN_ACCOUNT.toBase58()} (opened for you; its deposit of 0.00203928 SOL stays in that account)`);
  });

  it('a summary that names no account for the coin says so, and still never says SOL arrives', async () => {
    await review(withdraw(coin, { quoteAccount: null, unwrapsWsol: true }));
    expect(value(`The ${C} arrives in`)).toBe(`your own ${C} account (its address was not read)`);
    expect(screen.queryByText('The SOL arrives')).not.toBeInTheDocument();
    expect(reviewText()).not.toMatch(/plain SOL|wrapped SOL/);
  });

  it('with both accounts already open, no SOL is named above the fee rows', () => {
    expect(summaryText(withdraw(coin))).not.toContain('SOL');
    expect(summaryText(withdraw(coin, { all: true, keep: 0n }))).not.toContain('SOL');
  });

  // A SOL pool never keeps a new account for its SOL, so its line only ever meant the
  // token's account. A coin pool can open the coin's account too, and the amount covers both.
  it('the deposit line names each account it pays for', async () => {
    const TOKEN_RENT = 2_074_080n;
    const COIN_RENT = 2_039_280n;
    const fees = (rent: bigint) => ({ fees: { ...FEES, newAccountRentLamports: rent } });

    // The deposit of the token's account is SOL, on a coin pool too: 2,074,080 lamports read
    // as the coin's 6 decimals would say "2.07408 USDC".
    const tokenRow = `${TOKEN_ACCOUNT.toBase58()} (opened for you; its deposit of 0.00207408 SOL stays in that account)`;

    await review(withdraw(coin, { tokenAccountRent: TOKEN_RENT }), fees(TOKEN_RENT));
    expect(value('One-time deposit for your new token account (it stays in that account)')).toBe('0.002 SOL');
    expect(value('The tokens arrive in')).toBe(tokenRow);
    // Both "arrives in" rows carry an address and then a sentence with a SOL amount in it: they
    // break between words, never in the middle of that amount. A row that is only an address
    // (the pool) still breaks anywhere.
    const valueSpan = (label: string) => screen.getByText(label).nextElementSibling as HTMLElement;
    for (const label of ['The tokens arrive in', `The ${C} arrives in`]) {
      expect(valueSpan(label).className, label).toMatch(/font-mono/);
      expect(valueSpan(label).className, label).not.toMatch(/break-all/);
    }
    expect(valueSpan('Pool').className).toMatch(/break-all/);
    cleanup();

    await review(withdraw(coin, { quoteAccount: { address: COIN_ACCOUNT, rent: COIN_RENT } }), fees(COIN_RENT));
    expect(value(`One-time deposit for your new ${C} account (it stays in that account)`)).toBe('0.002 SOL');
    expect(screen.queryByText('One-time deposit for your new token account (it stays in that account)')).not.toBeInTheDocument();
    cleanup();

    await review(withdraw(coin, { tokenAccountRent: TOKEN_RENT, quoteAccount: { address: COIN_ACCOUNT, rent: COIN_RENT } }), fees(TOKEN_RENT + COIN_RENT));
    expect(value(`One-time deposits for your new token account and your new ${C} account (each stays in its own account)`)).toBe('0.0041 SOL');
    expect(value('The tokens arrive in')).toBe(tokenRow);
    expect(reviewText()).not.toContain(`2.07408 ${C}`);
  }, 30_000);

  it('the priority fee is its own amount in SOL, never a share "of this trade"', async () => {
    await review(withdraw(coin, { quoted: { quote: 250_000_000n, token: 3_000_000n } }));
    expect(value('Priority fee')).toBe('0.0012 SOL');
    expect(reviewText()).not.toContain('of this trade');
  });

  it('the test run names the coin and prints it in the coin’s decimals', async () => {
    await review(
      withdraw(coin),
      {
        simulated: {
          signerLamportsDelta: -1_205_000n,
          tokenDeltas: [
            { mint: LP_MINT, account: LP_ACCOUNT, delta: -500_000n, role: 'lp', decimals: 9 },
            { mint: TOKEN, account: TOKEN_ACCOUNT, delta: 3_000_000_000n, role: 'token', decimals: 9 },
            coinDelta(coin, 125_061_728n),
          ],
        },
      },
      9,
    );
    expect(value(`Test run: your ${C} changes by`)).toBe('+125.0617');
    expect(value('Test run: your SOL changes by')).toBe('-0.0012 SOL');
    expect(screen.queryByText('Test run: your wrapped SOL changes by')).not.toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Opening a pool.
// ---------------------------------------------------------------------------

describe.each(COINS)('opening a pool paired with $symbol: the review', (coin) => {
  const C = coin.symbol;

  it('what goes in is in the coin, to its last digit', async () => {
    await review(create(coin));
    expect(value('Paired with')).toBe(C);
    expect(value('You put in')).toBe(`250.000001 ${C} and 10,000 tokens, exactly`);
  });

  it('250 of the coin reads as 250', async () => {
    await review(create(coin, { put: { quote: 250_000_000n, token: 10_000_000_000n } }));
    expect(value('You put in')).toBe(`250 ${C} and 10,000 tokens, exactly`);
    expect(reviewText()).not.toContain('0.25 ');
    expect(reviewText()).not.toContain('250 SOL');
  });

  it('the opening price and the market’s are said in the coin', async () => {
    await review(create(coin));
    expect(value('Opening price')).toBe(`1 token = 0.025 ${C}. Market (Jupiter, read just now): 0.0249 ${C}, 0.4% above`);
  });

  it('an opening price that is off the market, and what that may cost, are said in the coin', async () => {
    await review(
      create(coin, {
        price: { state: 'disagrees', pool: 0.025, reference: 0.02, against: 'outside', diff: 0.25 },
        warnings: [`Your opening price is 25.0% above the market price (Jupiter).`],
        priceGap: { diff: 0.25, lossQuote: 2_500_001n },
      }),
    );
    expect(value('Opening price')).toBe(`1 token = 0.025 ${C}. Market (Jupiter, read just now): 0.02 ${C}, 25.0% above. That is off by more than 3%.`);
    // 2,500,001 of the coin's smallest units, to the last digit. As lamports: 0.002500001 SOL.
    expect(value('Estimated cost of that gap')).toBe(`up to about 2.500001 ${C} of what you put in`);
    expect(reviewText()).not.toContain('0.002500001');
  });

  it('an opening with no market price still says its price, in the coin, written out', async () => {
    await review(create(coin, { price: { state: 'no-market', of: 'token', pool: 104_000, detail: 'Jupiter has no route for this token' }, warnings: ['Jupiter has no market price for this token.'] }));
    // 104,000 of the coin a token: never "1.040e+5".
    expect(value('Opening price')).toBe(
      `1 token = 104,000 ${C}. Jupiter has no market price for this token, so there is nothing to compare it with: you are setting the price yourself`,
    );
    expect(reviewText()).not.toMatch(/e\+/);
  });

  // Owner ruling 2026-10-07: Jupiter having no price for the pool's COIN does not stop an
  // opening priced in it. The token HAS a price then, so the review names the coin and
  // nothing on it says "Jupiter has no market price for this token".
  it('an opening priced in a coin Jupiter has no price for: the row names the coin, never "this token"', async () => {
    const WARNING = `Jupiter has no price for ${C} right now, so there is nothing to compare your opening price in ${C} with. You are setting the price yourself: if it is off, the first trades take the difference out of what you put in.`;
    await review(create(coin, { price: { state: 'no-market', of: 'coin', pool: 2, detail: `Jupiter has no route for ${C}` }, warnings: [WARNING] }));
    expect(value('Opening price')).toBe(`1 token = 2 ${C}. Jupiter has no price for ${C} right now, so there is nothing to compare it with: you are setting the price yourself`);
    // The same clause as every other screen (poolHealth.ts `noPriceClause`).
    expect(value('Opening price')).toContain(noPriceClause('coin', coin));
    expect(within(screen.getByTestId('tx-review-warnings')).getByText(WARNING)).toBeInTheDocument();
    expect(reviewText()).not.toMatch(/for this token|this token has/);
    expect(screen.queryByText('Estimated cost of that gap')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Sign in wallet' })).toBeEnabled();
  });

  it('the locked shares are valued in the coin, and a real amount too small to show is not shown as nothing', async () => {
    await review(create(coin));
    expect(value('Locked in the pool forever')).toBe(
      `0.0000001 pool shares (100 of the smallest unit), worth about <0.0001 ${C} and 0.0006 tokens at these amounts`,
    );
    cleanup();
    await review(create(coin, { locked: { quote: 2_500_000n, token: 632n } }));
    expect(value('Locked in the pool forever')).toContain(`worth about 2.5 ${C} and`);
  }, 30_000);

  it('the fee to open and the account deposits stay in SOL', async () => {
    await review(create(coin));
    expect(value('Fee to open the pool')).toBe(
      `0.15 SOL, paid to the team's vault (into ${FEE_RECEIVER.toBase58()}, the account the pool program fixes); not refundable`,
    );
    expect(value('Account deposits that never come back')).toBe('0.04 SOL (the pool, its price record, its share token and its two vaults; none can be closed)');
    expect(value('Your pool-share account')).toBe('0.00203928 SOL (it comes back if you close that account later)');
    expect(value('Network fee')).toBe('<0.0001 SOL');
  });

  it('nothing is wrapped, and the review says the costs are still paid in SOL', async () => {
    await review(create(coin, { unwrapsWsol: true, wsolHeldBefore: 500_000_000n }));
    expect(
      screen.getByText(`Your ${C} is spent straight from your own ${C} account. Nothing is wrapped. The fee to open and the account deposits are paid in SOL.`),
    ).toBeInTheDocument();
    expect(reviewText()).not.toMatch(/wrapped into a token account|wrapped SOL|plain SOL/);
  });

  it('a token that can still be minted is sold into the pool for the coin, not for SOL', async () => {
    await review(create(coin, { tokenWarnings: [{ code: 'mint-authority', text: 'Its creator can still mint more.' }] }));
    expect(screen.getByText(`Whoever holds that mint authority can make new tokens at any time and sell them into your pool for its ${C}.`)).toBeInTheDocument();
    expect(reviewText()).not.toContain('for its SOL');
  });

  it('the priority fee is its own amount in SOL, never a share "of this trade"', async () => {
    await review(create(coin, { put: { quote: 250_000_000n, token: 10_000_000_000n } }));
    expect(value('Priority fee')).toBe('0.0012 SOL');
    expect(reviewText()).not.toContain('of this trade');
  });

  it('the test run: the coin by name in its own decimals, and the fee account’s gain in SOL', async () => {
    await review(
      create(coin),
      {
        simulated: {
          signerLamportsDelta: -193_244_280n,
          tokenDeltas: [
            { mint: TOKEN, account: TOKEN_ACCOUNT, delta: -10_000_000_000_000n, role: 'token', decimals: 9 },
            coinDelta(coin, -250_000_001n),
            { mint: LP_MINT, account: LP_ACCOUNT, delta: 1_581_138_733n, role: 'lp', decimals: 9 },
            { mint: new PublicKey(SOL_QUOTE.mint), account: FEE_RECEIVER, delta: 150_000_000n, role: 'treasury', decimals: 9 },
          ],
        },
      },
      9,
    );
    expect(value(`Test run: your ${C} changes by`)).toBe('-250');
    expect(value('Test run: your SOL changes by')).toBe('-0.1932 SOL');
    expect(value("Test run: the team's vault account gains, in SOL (the fee, plus any SOL that account was already holding)")).toBe('+0.15');
    expect(screen.queryByText('Test run: your wrapped SOL changes by')).not.toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// What the coin adds to the risks (quotes.ts `risk`).
// ---------------------------------------------------------------------------

describe('the coin’s own risk line', () => {
  const RISK = USDC_QUOTE.risk!;

  /** The lines of the warnings box the review opens on, and whether the review's heading is described by that box. */
  const warningsBox = () => {
    const box = screen.getByTestId('tx-review-warnings');
    const heading = screen.getByRole('heading', { name: /^Review: / });
    return { lines: Array.from(box.querySelectorAll('li')).map((li) => li.textContent), described: heading.getAttribute('aria-describedby') === box.id, box };
  };

  // Whole-change review 2026-10-04 (W5). The line was a plain notice far down the rows: a
  // clean USDC review had no warnings box at all, so the heading was described by nothing
  // and a screen-reader user could reach Sign without hearing that Circle can freeze the
  // pool's USDC. It is a risk to what goes in, like a token its creator can freeze, so it
  // is among the warnings the review opens on. Said once: not there and again in the rows.
  it('USDC: among the warnings the review opens on, in the coin table’s own words, and the heading is described by them, on adding and on opening', async () => {
    expect(RISK).toMatch(/Circle.*can freeze any USDC account/);
    for (const summary of [deposit(USDC_QUOTE), create(USDC_QUOTE)]) {
      await review(summary);
      const { lines, described, box } = warningsBox();
      expect(lines).toEqual([RISK]);
      expect(described).toBe(true);
      expect(box.querySelector('ul')).toHaveClass('text-amber-300/90');
      expect(screen.getAllByText(RISK)).toHaveLength(1);
      cleanup();
    }
  }, 30_000);

  it('USDC, with the builder’s own warnings: after them, still once', async () => {
    const said = ['Its price is 10.0% above the outside price. A deposit here would hand that gap to the first arbitrage trade.'];
    for (const summary of [deposit(USDC_QUOTE, { warnings: said }), create(USDC_QUOTE, { warnings: said })]) {
      await review(summary);
      expect(warningsBox().lines).toEqual([...said, RISK]);
      expect(screen.getAllByText(RISK)).toHaveLength(1);
      cleanup();
    }
  }, 30_000);

  it('BAYLA and SOL have none, so nothing about freezing is said', async () => {
    for (const coin of [BAYLA_QUOTE, SOL_QUOTE]) {
      expect(coin.risk).toBeNull();
      await review(deposit(coin));
      expect(reviewText()).not.toMatch(/freeze|frozen/);
      cleanup();
      await review(create(coin));
      expect(reviewText()).not.toMatch(/freeze|frozen/);
      cleanup();
    }
  }, 60_000);

  // Decided 2026-10-03: not on a removal. The line is about what a person takes on by
  // putting USDC in. A removal lowers that, its test run has just shown the pool can pay
  // out, and a warning on the way out is a reason to hesitate over the safer action.
  it('is not shown on a removal, for USDC either', async () => {
    await review(withdraw(USDC_QUOTE));
    expect(screen.queryByText(RISK)).not.toBeInTheDocument();
    expect(reviewText()).not.toMatch(/freeze|frozen/);
    cleanup();
    // Taking only part out is still a removal.
    await review(withdraw(USDC_QUOTE, { all: false, keep: 500_000n }));
    expect(screen.queryByText(RISK)).not.toBeInTheDocument();
  }, 30_000);
});

// ---------------------------------------------------------------------------
// After signing. No outcome names an amount of the coin; the one amount named is the
// fees a refused transaction still cost, and those are paid in SOL.
// ---------------------------------------------------------------------------

describe.each(COINS)('after signing, for a pool paired with $symbol', (coin) => {
  const AMOUNT = /\d\s*(SOL|USDC|BAYLA)\b/;
  const kinds = [
    ['lp-deposit', () => deposit(coin)],
    ['lp-withdraw', () => withdraw(coin)],
    ['lp-create', () => create(coin)],
  ] as const;

  async function outcomeText(summary: TxSummary, o: TxOutcome): Promise<string> {
    const api = fakeApi({ submitPrepared: vi.fn(async () => o) });
    const { result } = renderHook(() => useTxFlow(api, rpc));
    await act(() => result.current.prepare(async () => ({ ok: true, prepared: prepared(summary, { fees: FEES }) })));
    await act(() => result.current.confirm(signer));
    const view = render(<TxFlowView flow={result.current} api={api} cluster="localnet" decimals={6} signer={signer} />);
    const text = screen.getByTestId('tx-outcome').textContent ?? '';
    view.unmount();
    return text;
  }

  it('confirmed, not signed and unknown name no amount at all', async () => {
    for (const [kind, summary] of kinds) {
      const done = await outcomeText(summary(), { status: 'confirmed', signature: SIG, slot: 1 });
      expect(done, kind).toContain('Done. The network confirmed it.');
      expect(done, kind).not.toMatch(AMOUNT);

      const unsigned = await outcomeText(summary(), { status: 'not-sent', stage: 'sign', message: 'The wallet closed the request.' });
      expect(unsigned, kind).toContain('Not sent. Your wallet did not sign it.');
      expect(unsigned, kind).toContain('Nothing was charged.');
      expect(unsigned, kind).not.toMatch(AMOUNT);

      const unknown = await outcomeText(summary(), { status: 'unknown', signature: SIG, message: 'slow' });
      expect(unknown, kind).toContain('Sent, not confirmed yet. Do not retry until you check.');
      expect(unknown, kind).not.toMatch(AMOUNT);
      expect(unknown, kind).not.toMatch(/fail/i);
    }
  }, 60_000);

  it('unknown keeps each kind’s own warning about doing it twice', async () => {
    const unknown: TxOutcome = { status: 'unknown', signature: SIG, message: 'slow' };
    expect(await outcomeText(deposit(coin), unknown)).toContain('Sending again could make you pay twice.');
    expect(await outcomeText(withdraw(coin), unknown)).toContain('Taking liquidity out again now could take out more than you meant.');
    expect(await outcomeText(create(coin), unknown)).toContain('Opening a pool again now could open a second pool and pay the fee to open twice.');
  }, 30_000);

  it('refused by the program: the fees it still cost are said in SOL', async () => {
    for (const [kind, summary] of kinds) {
      const text = await outcomeText(summary(), { status: 'reverted', signature: SIG, program: 'cp-swap', code: 6005, message: 'The price moved past your limit.' });
      expect(text, kind).toContain('Nothing moved except the fees: 0.0012 SOL (the network fee and the priority fee).');
      expect(text, kind).not.toMatch(/\d\s*(USDC|BAYLA)\b/);
    }
  }, 30_000);
});

// ---------------------------------------------------------------------------
// The review and the forms print a coin the same way (panelKit.ts has the forms' copy
// of `coinAbout` and `coinExact`). A person must not see one number on the form and
// another on the review.
// ---------------------------------------------------------------------------

describe('the review prints a coin amount exactly as the forms do', () => {
  // From the smallest unit to a figure with thousands in it.
  const AMOUNTS = [1n, 99n, 999_999n, 1_000_000n, 250_000_000n, 1_234_567_890n, 123_456_789_012_345n];
  /** What follows a row's label in the summary's text: its value, then the next row. */
  const after = (text: string, label: string) => text.split(label)[1] ?? '';

  it.each([SOL_QUOTE, USDC_QUOTE, BAYLA_QUOTE])('$symbol', (coin) => {
    for (const v of AMOUNTS) {
      const about = coinAbout(v, coin);
      const exact = coinExact(v, coin);
      const add = summaryText(deposit(coin, { quoted: { quote: v, token: 5_000_000n }, max: { quote: v, token: 5_050_001n } }));
      expect(after(add, 'You put in about').startsWith(`${about} and 5 tokens`), `add, about, ${v}`).toBe(true);
      expect(after(add, 'At most').startsWith(`${exact} and 5.050001 tokens`), `add, at most, ${v}`).toBe(true);
      const remove = summaryText(withdraw(coin, { quoted: { quote: v, token: 3_000_000n }, min: { quote: v, token: 2_970_001n } }));
      expect(after(remove, 'You get about').startsWith(`${about} and 3 tokens`), `remove, about, ${v}`).toBe(true);
      expect(after(remove, 'You get at least').startsWith(`${exact} and 2.970001 tokens`), `remove, at least, ${v}`).toBe(true);
      const open = summaryText(create(coin, { put: { quote: v, token: 10_000_000_000n }, locked: { quote: v, token: 632n } }));
      expect(after(open, 'You put in').startsWith(`${exact} and 10,000 tokens, exactly`), `open, put in, ${v}`).toBe(true);
      expect(after(open, 'Locked in the pool forever'), `open, locked, ${v}`).toContain(`worth about ${about} and `);
    }
  }, 30_000);
});

// ---------------------------------------------------------------------------
// The same builders with SOL: a SOL pool keeps its own words. (TxFlowView.test.tsx pins
// every SOL row; these are the ones a coin change could knock over.)
// ---------------------------------------------------------------------------

describe('a pool paired with SOL, through the same builders', () => {
  // Owner ruling 2026-10-07: "Paired with" stays on EVERY review, SOL pools included. It is
  // never left out because the coin is the usual one: a person reads the same row on a SOL
  // pool as on a USDC pool, and its absence is never how they are told it is SOL.
  it.each([
    ['adding', () => deposit(SOL_QUOTE)],
    ['removing', () => withdraw(SOL_QUOTE)],
    ['opening a pool', () => create(SOL_QUOTE)],
  ] as const)('%s: the review of a SOL pool says "Paired with: SOL"', async (_n, summary) => {
    await review(summary());
    expect(value('Paired with')).toBe('SOL');
    // Once, as a row of its own.
    expect(screen.getAllByText('Paired with')).toHaveLength(1);
  });

  it('the summary rows alone say it too, for a SOL pool as for every other coin', () => {
    for (const coin of [SOL_QUOTE, USDC_QUOTE, BAYLA_QUOTE]) {
      for (const s of [deposit(coin), withdraw(coin), create(coin)]) expect(summaryText(s), `${s.kind} ${coin.symbol}`).toContain(`Paired with${coin.symbol}`);
    }
  });

  it('the same base units are 0.25 SOL: SOL keeps its 9 decimals and its wrapping words', async () => {
    await review(deposit(SOL_QUOTE, { quoted: { quote: 250_000_000n, token: 5_000_000n }, max: { quote: 252_500_000n, token: 5_050_001n }, limitedByBalance: 'quote' }));
    expect(value('Paired with')).toBe('SOL');
    expect(value('You put in about')).toBe('0.25 SOL and 5 tokens');
    expect(value('At most')).toBe('0.2525 SOL and 5.050001 tokens (all the SOL you can spend)');
    expect(screen.getByText(/closed at the end, so anything not used comes back as plain SOL/)).toBeInTheDocument();
    expect(value('Priority fee')).toBe('0.0012 SOL (0.48% of this trade)');
  });

  it('removing says how the SOL arrives, and names no account for it', async () => {
    await review(withdraw(SOL_QUOTE));
    expect(value('The SOL arrives')).toBe('as plain SOL');
    expect(screen.queryByText('The SOL arrives in')).not.toBeInTheDocument();
    expect(value('You get about')).toBe('0.125 SOL and 3 tokens');
    expect(value('You get at least')).toBe('0.123811111 SOL and 2.970001 tokens');
  });

  it('a SOL pool’s deposit line is the token account’s, even if a summary named a coin account', async () => {
    await review(
      withdraw(SOL_QUOTE, { tokenAccountRent: 2_074_080n, quoteAccount: { address: COIN_ACCOUNT, rent: 2_039_280n } }),
      { fees: { ...FEES, newAccountRentLamports: 2_074_080n } },
    );
    expect(value('One-time deposit for your new token account (it stays in that account)')).toBe('0.002 SOL');
    expect(value('The SOL arrives')).toBe('as plain SOL');
  });

  it('opening says SOL in the price and the mint warning, and wraps', async () => {
    await review(create(SOL_QUOTE, { put: { quote: 250_000_000n, token: 10_000_000_000n }, tokenWarnings: [{ code: 'mint-authority', text: 'Its creator can still mint more.' }] }));
    expect(value('You put in')).toBe('0.25 SOL and 10,000 tokens, exactly');
    expect(value('Opening price')).toBe('1 token = 0.025 SOL. Market (Jupiter, read just now): 0.0249 SOL, 0.4% above');
    expect(screen.getByText('Whoever holds that mint authority can make new tokens at any time and sell them into your pool for its SOL.')).toBeInTheDocument();
    expect(screen.getByText(/wrapped into a token account for the opening/)).toBeInTheDocument();
    expect(value('Priority fee')).toBe('0.0012 SOL (0.48% of this trade)');
  });

  it('the wrapped-SOL line of the test run keeps its name', async () => {
    await review(deposit(SOL_QUOTE), {
      simulated: { signerLamportsDelta: -253_244_280n, tokenDeltas: [{ mint: new PublicKey(SOL_QUOTE.mint), account: KEY(52), delta: 1_500_000_000n, role: 'wsol', decimals: 9 }] },
    });
    expect(value('Test run: your wrapped SOL changes by')).toBe('+1.5');
  });
});

// ---------------------------------------------------------------------------
// The shared fixture (lp/fakeLpWriteApi.fixture.ts): a coin passed to a summary builder
// gives the summary a builder would, so a form's test does not review a USDC pool that
// claims to unwrap SOL.
// ---------------------------------------------------------------------------

describe('the fixture’s summaries follow the coin', () => {
  it.each(COINS)('$symbol: nothing wrapped, and a removal names the coin’s account', (coin) => {
    const d = lpDepositSummary(POOL, TOKEN, { quote: coin });
    const w = lpWithdrawSummary(POOL, TOKEN, LP_ACCOUNT, { quote: coin });
    const c = lpCreateSummary(POOL, TOKEN, { quote: coin });
    expect(d).toMatchObject({ kind: 'lp-deposit', quote: coin, unwrapsWsol: false });
    expect(w).toMatchObject({ kind: 'lp-withdraw', quote: coin, unwrapsWsol: false, quoteAccount: { address: COIN_ACCOUNT, rent: 0n } });
    expect(c).toMatchObject({ kind: 'lp-create', quote: coin, unwrapsWsol: false });
  });

  it('SOL, named or not, is what the builders always returned', () => {
    for (const over of [{}, { quote: SOL_QUOTE }]) {
      expect(lpDepositSummary(POOL, TOKEN, over)).toMatchObject({ quote: SOL_QUOTE, unwrapsWsol: true });
      expect(lpWithdrawSummary(POOL, TOKEN, LP_ACCOUNT, over)).toMatchObject({ quote: SOL_QUOTE, unwrapsWsol: true, quoteAccount: null });
      expect(lpCreateSummary(POOL, TOKEN, over)).toMatchObject({ quote: SOL_QUOTE, unwrapsWsol: true });
    }
  });

  it('what the caller passes still wins', () => {
    expect(lpWithdrawSummary(POOL, TOKEN, LP_ACCOUNT, { quote: USDC_QUOTE, quoteAccount: null })).toMatchObject({ quoteAccount: null });
    expect(lpDepositSummary(POOL, TOKEN, { quote: USDC_QUOTE, unwrapsWsol: true })).toMatchObject({ unwrapsWsol: true });
  });
});
