// The review of a swap in one of our own pools, from the swap page (kind `venue-swap`).
// It is the last thing a person reads before signing, so every amount is checked as the
// exact words on screen: the pairing coin in ITS decimals and name (250 USDC is
// 250_000_000 base units; read as SOL that is 0.25), the token in the pool's decimals,
// and what Jupiter was seen to pay said as what it was: quoted now, quoted earlier, no
// route, or could not be asked.

import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { SummaryRows, TxReview } from './TxFlowView';
import { KEY } from './fakeWriteApi.fixture';
import { BAYLA_QUOTE, SOL_QUOTE, USDC_QUOTE } from '../../../lib/solana/lp/quotes';
import { BAYLA_MINT } from '../../../lib/solana/lp/tokenSafety';
import { PublicKey } from '@solana/web3.js';
import type { PreparedTx, TxSummary } from './ports';

type Swap = Extract<TxSummary, { kind: 'venue-swap' }>;

const POOL = KEY(40);
const TOKEN = KEY(41);
const TIER1 = {
  address: KEY(42).toBase58(), index: 1, disableCreatePool: false, tradeFeeRate: 10_000n, protocolFeeRate: 160_000n, fundFeeRate: 0n,
  createPoolFee: 150_000_000n, creatorFeeRate: 0n, protocolOwner: 'Own1', fundOwner: 'Own2',
};
const quoted = (out: bigint, tradeFee: bigint, creatorFee = 0n, creatorFeeOnInput = true): Swap['quoted'] => ({
  poolAddress: POOL.toBase58(), outAmount: out, reserveIn: 1n, reserveOut: 1n, priceImpact: 0.0123, creatorFeeOnInput,
  result: { outputAmount: out, tradeFee, protocolFee: 0n, fundFee: 0n, creatorFee, newInputVaultAmount: 0n, newOutputVaultAmount: 0n },
});
/** 0.1 SOL for 9,802.960494 tokens (shown cut to four places, never rounded up), at least 9,753.945691. */
const buy = (over: Partial<Swap> = {}): Swap => ({
  kind: 'venue-swap', pool: POOL, origin: 'standard', config: TIER1, tokenMint: TOKEN, tokenDecimals: 6, coin: SOL_QUOTE, paysCoin: true,
  amountIn: 100_000_000n, minimumAmountOut: 9_753_945_691n, quoted: quoted(9_802_960_494n, 1_000_000n),
  aggregator: { kind: 'quoted', out: 9_705_901_480n, when: 'now' }, unwrapsWsol: true, wsolHeldBefore: 0n, notices: [],
  ...over,
});

const text = (summary: TxSummary) => {
  const { container } = render(<SummaryRows summary={summary} decimals={null} display={(s) => s} />);
  return (container.textContent ?? '').replace(/\s+/g, ' ');
};

afterEach(cleanup);

describe('the rows of a swap in our own pool', () => {
  it('a buy with SOL: the pool, its kind and tier, what is paid to the last digit, what comes back, and the fee', () => {
    const t = text(buy());
    expect(t).toContain(POOL.toBase58());
    expect(t).toContain('Standard address for fee tier 1');
    expect(t).toContain(TOKEN.toBase58());
    expect(t).toMatch(/Paired with ?SOL/);
    expect(t).toMatch(/You pay ?0\.1 SOL/);
    expect(t).toMatch(/You receive \(quoted\) ?9,802\.9604 tokens/);
    expect(t).toMatch(/You receive at least ?9,753\.945691 tokens/);
    expect(t).toMatch(/Pool fee \(inside what you pay\) ?0\.001 SOL \(1%\)/);
    // The figure is against the pool's price before the trade: the 1% fee is inside it, and the label says so.
    expect(t).toMatch(/Price impact \(pool fee included\) ?1\.23%/);
    expect(t).toContain('Your SOL is wrapped into a token account for the swap, and that account is closed at the end, so you get plain SOL back.');
  });

  it('a sale for SOL into a wrapped-SOL account the wallet already had says it is left open', () => {
    const t = text(buy({ paysCoin: false, amountIn: 5_000_000_000n, minimumAmountOut: 49_000_000n, quoted: quoted(50_000_000n, 50_000_000n), unwrapsWsol: false, wsolHeldBefore: 5_000_000_000n }));
    expect(t).toMatch(/You pay ?5,000 tokens/);
    expect(t).toMatch(/You receive \(quoted\) ?0\.05 SOL/);
    expect(t).toMatch(/You receive at least ?0\.049 SOL/);
    // The fee is taken from what is paid in: tokens.
    expect(t).toMatch(/Pool fee \(inside what you pay\) ?50 tokens \(1%\)/);
    expect(t).toContain('The pool pays out wrapped SOL. You already had a wrapped SOL account, so it is left open with its balance.');
  });

  // 250 USDC is 250_000_000 base units. Printed with SOL's nine decimals it would read 0.25.
  it('a pool paired with USDC prints USDC in six decimals, by name, and wraps nothing', () => {
    const t = text(buy({ coin: USDC_QUOTE, amountIn: 250_000_000n, quoted: quoted(9_802_960_494n, 2_500_000n), unwrapsWsol: false }));
    expect(t).toMatch(/Paired with ?USDC/);
    expect(t).toMatch(/You pay ?250 USDC/);
    expect(t).toMatch(/Pool fee \(inside what you pay\) ?2\.5 USDC \(1%\)/);
    expect(t).toContain('Your USDC is spent straight from your own USDC account. Nothing is wrapped.');
    expect(t).not.toMatch(/0\.25 |wrapped SOL/);
    const sale = text(buy({ coin: BAYLA_QUOTE, paysCoin: false, amountIn: 1_000_000n, minimumAmountOut: 249_000_000n, quoted: quoted(250_000_000n, 10_000n), unwrapsWsol: false }));
    expect(sale).toMatch(/You receive \(quoted\) ?250 BAYLA/);
    expect(sale).toMatch(/You receive at least ?249 BAYLA/);
    expect(sale).toContain('The BAYLA is paid straight into your own BAYLA account. Nothing is wrapped.');
  });

  it('names a token that is itself a pairing coin: BAYLA in a BAYLA and SOL pool', () => {
    const t = text(buy({ tokenMint: new PublicKey(BAYLA_MINT) }));
    expect(t).toMatch(/You receive \(quoted\) ?9,802\.9604 BAYLA/);
    expect(t).toMatch(/You receive at least ?9,753\.945691 BAYLA/);
  });

  it('shows the creator fee a pool charges, on the side it is charged', () => {
    const onInput = text(buy({ quoted: quoted(9_802_960_494n, 1_000_000n, 500_000n, true) }));
    expect(onInput).toMatch(/Creator fee \(on top, from what you pay\) ?0\.0005 SOL/);
    const onOutput = text(buy({ quoted: quoted(9_802_960_494n, 1_000_000n, 49_000_000n, false) }));
    expect(onOutput).toMatch(/Creator fee \(taken from what you receive\) ?49 tokens/);
  });

  it('carries the builder’s notices', () => {
    expect(text(buy({ notices: ['Someone else can close your token account once it is empty.'] }))).toContain('Someone else can close your token account once it is empty.');
  });
});

describe('what Jupiter was seen to pay is said as what it was', () => {
  const line = (aggregator: Swap['aggregator'], out = 9_802_960_494n) => text(buy({ aggregator, quoted: quoted(out, 1_000_000n) }));

  it('quoted just now, and our pool pays more', () => {
    expect(line({ kind: 'quoted', out: 9_705_901_480n, when: 'now' })).toMatch(/Compared with Jupiter ?1% more than Jupiter quoted just now/);
  });
  it('quoted just now, and the two are the same: a tie stays here', () => {
    expect(line({ kind: 'quoted', out: 9_802_960_494n, when: 'now' })).toMatch(/Compared with Jupiter ?the same as Jupiter quoted just now, so the trade stays here/);
  });
  it('one raw unit more is never printed as 0%', () => {
    expect(line({ kind: 'quoted', out: 9_802_960_493n, when: 'now' })).toMatch(/Compared with Jupiter ?under 0\.001% more than Jupiter quoted just now/);
  });
  it('the figure that was on screen, when Jupiter could not be asked again', () => {
    expect(line({ kind: 'quoted', out: 9_705_901_480n, when: 'earlier' })).toMatch(/1% more than the last quote Jupiter gave \(it could not be asked again just now\)/);
    expect(line({ kind: 'quoted', out: 9_802_960_494n, when: 'earlier' })).toMatch(/the same as the last quote Jupiter gave \(it could not be asked again just now\), so the trade stays here/);
  });
  it('no route: Jupiter’s own answer', () => {
    expect(line({ kind: 'no-route' })).toMatch(/Compared with Jupiter ?Jupiter has no route for this trade, so this pool is the only route/);
  });
  it('could not be asked at all: said as that, never as "no route"', () => {
    const t = line({ kind: 'unreachable' });
    expect(t).toMatch(/Compared with Jupiter ?Jupiter could not be asked just now, so this trade was not compared with it/);
    expect(t).not.toMatch(/no route|only route/);
  });
  it('quoted more, but its transaction failed its test run: said as that, with how much more, never as Jupiter paying more', () => {
    // The pool pays 9,802.960494; the refused quote was 2% above it.
    const t = line({ kind: 'refused', out: 9_999_019_704n });
    expect(t).toMatch(/Compared with Jupiter ?Jupiter quoted 2% more, but its transaction for this trade failed its test run, so it could not be sent/);
    expect(t).not.toMatch(/no route|only route|now pays more|quoted more/);
    // One raw unit more is a real gap, never printed as 0%.
    expect(line({ kind: 'refused', out: 9_802_960_495n })).toMatch(/Jupiter quoted under 0\.001% more, but its transaction/);
  });
  it('a refused quote the pool has caught up with by the time the swap is built is not called "more"', () => {
    for (const out of [9_802_960_494n, 9_000_000_000n]) {
      const t = line({ kind: 'refused', out });
      expect(t).toMatch(/Compared with Jupiter ?Jupiter quoted no more than this pool pays, and its transaction for this trade failed its test run, so it could not be sent/);
      expect(t).not.toMatch(/% more|quoted more/);
    }
  });
  it('a refusal from the last press that could not be checked again says both, and keeps the figure', () => {
    const t = line({ kind: 'refused', out: 9_999_019_704n, earlier: true });
    expect(t).toMatch(/Compared with Jupiter ?Jupiter quoted 2% more, but its transaction for this trade failed its test run at your last press, so it could not be sent\. It could not be checked again just now/);
    expect(t).not.toMatch(/not compared|could not be asked just now/);
    expect(line({ kind: 'refused', out: 9_000_000_000n, earlier: true })).toMatch(/Jupiter quoted no more than this pool pays, and its transaction for this trade failed its test run at your last press, so it could not be sent\. It could not be checked again just now/);
  });
  it('a refusal with a cause says the cause after it, in the same row', () => {
    const why = "The test run paid less than your 0.5% slippage allows. A wider slippage may let Jupiter's transaction run";
    expect(line({ kind: 'refused', out: 9_999_019_704n, why })).toMatch(
      /Jupiter quoted 2% more, but its transaction for this trade failed its test run, so it could not be sent\. The test run paid less than your 0\.5% slippage allows\. A wider slippage may let Jupiter's transaction run/,
    );
    expect(line({ kind: 'refused', out: 9_999_019_704n, earlier: true, why })).toMatch(/It could not be checked again just now\. The test run paid less than your 0\.5% slippage allows\./);
  });
});

describe('the whole review', () => {
  it('is titled as a swap, names the new token account’s deposit, and prints the test run in each mint’s own decimals', () => {
    const prepared = {
      kind: 'venue-swap',
      fees: { baseLamports: 5_000n, priorityLamports: 0n, priorityFeeRead: true, newAccountRentLamports: 2_074_080n },
      simulated: {
        signerLamportsDelta: -102_079_080n,
        tokenDeltas: [{ mint: TOKEN, account: KEY(43), delta: 9_802_960_494n, role: 'token', decimals: 6 }],
      },
      summary: buy(),
    } as unknown as PreparedTx;
    const { container } = render(<TxReview prepared={prepared} decimals={null} display={(s) => s} />);
    const t = (container.textContent ?? '').replace(/\s+/g, ' ');
    expect(t).toContain('Review your swap');
    expect(t).toMatch(/One-time deposit for your new token account \(it stays in that account\) ?0\.002 SOL/);
    expect(t).toMatch(/Test run: your SOL changes by ?-0\.102 SOL/);
    expect(t).toMatch(/Test run: your tokens change by ?\+9,802\.9604/);
  });

  it('a USDC pool’s test run names USDC, in six decimals', () => {
    const prepared = {
      kind: 'venue-swap',
      fees: { baseLamports: 5_000n, priorityLamports: 0n, priorityFeeRead: true, newAccountRentLamports: 0n },
      simulated: {
        signerLamportsDelta: -5_000n,
        tokenDeltas: [
          { mint: new PublicKey(USDC_QUOTE.mint), account: KEY(44), delta: -250_000_000n, role: 'quote', decimals: 6 },
          { mint: TOKEN, account: KEY(43), delta: 9_802_960_494n, role: 'token', decimals: 6 },
        ],
      },
      summary: buy({ coin: USDC_QUOTE, amountIn: 250_000_000n, unwrapsWsol: false }),
    } as unknown as PreparedTx;
    const { container } = render(<TxReview prepared={prepared} decimals={null} display={(s) => s} />);
    const t = (container.textContent ?? '').replace(/\s+/g, ' ');
    expect(t).toMatch(/Test run: your USDC changes by ?-250/);
    expect(t).not.toMatch(/pairing coin|0\.25/);
  });
});
