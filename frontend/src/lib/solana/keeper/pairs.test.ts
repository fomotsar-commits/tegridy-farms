// @vitest-environment node
//
// Trips between two of our own pools, which pools the keeper can trade at all, the check on a
// sale of leftover tokens, and the quick check's price steps. Pools are built by the same kit
// the pool list's tests use, and priced by the pool program's own maths (quoteOwnPool).
import { describe, it, expect } from 'vitest';
import { POOL_STATUS_DISABLE_SWAP } from '../cpswap/program';
import { quoteOwnPool } from '../cpswap/read';
import { buildPool, key, viewOf } from '../lp/testkit.fixture';
import { BAYLA_QUOTE, SOL_QUOTE } from '../lp/quotes';
import type { PoolView } from '../lp/poolFinder';
import { DEFAULT_LIMITS, MAX_FEE_LAMPORTS, dustSaleProblem, ownPairPlan, poolProblem, priceStep } from './plan';

const NOW = 10_000_000;
const SOL = 10n ** 9n;
const usd = new Map([[SOL_QUOTE.mint, 200]]);
const mint = key();

function pool(sol: bigint, tok: bigint, o: { status?: number; quote?: typeof SOL_QUOTE } = {}): PoolView {
  const b = buildPool({ mint, address: key(), quoteReserve: sol, tokenReserve: tok, status: o.status, quote: o.quote });
  return viewOf(b, { sol, tok });
}

/** What a trip of `x` lamports makes: buy in `cheap`, sell what it pays in `dear`. */
function made(cheap: PoolView, dear: PoolView, x: bigint): bigint {
  const t = quoteOwnPool(cheap.snapshot, cheap.config!, SOL_QUOTE.mint, x, NOW)!.outAmount;
  return quoteOwnPool(dear.snapshot, dear.config!, mint.toBase58(), t, NOW)!.outAmount - x;
}

describe('ownPairPlan: a trip between two of our pools of one pair', () => {
  // The token at 0.05 SOL in one pool and about 0.0556 in the other, 1% fee in each.
  const cheap = pool(50n * SOL, 10n ** 9n);
  const dear = pool(50n * SOL, 9n * 10n ** 8n);
  const lots = 100n * SOL;
  const wide = { ...DEFAULT_LIMITS, maxTradeUsd: 10_000 };

  it('buys where the token is cheap, sells where it is dear, at the size that makes the most', () => {
    for (const [a, b] of [[cheap, dear], [dear, cheap]] as const) {
      const p = ownPairPlan(a, b, NOW, usd, wide, lots)!;
      expect(p.cheap).toBe(cheap);
      expect(p.dear).toBe(dear);
      expect(p.coinOut - p.coinIn).toBe(made(cheap, dear, p.coinIn));
      expect(p.tokens).toBe(quoteOwnPool(cheap.snapshot, cheap.config!, SOL_QUOTE.mint, p.coinIn, NOW)!.outAmount);
      // Smaller or larger, the same trip makes less.
      expect(made(cheap, dear, (p.coinIn * 9n) / 10n)).toBeLessThan(p.coinOut - p.coinIn);
      expect(made(cheap, dear, (p.coinIn * 11n) / 10n)).toBeLessThan(p.coinOut - p.coinIn);
      expect(p.minProfit).toBe(50_000n); // $0.01 at $200 a SOL
    }
  });

  it('never spends more than the keeper holds, or than a trip may be', () => {
    expect(ownPairPlan(cheap, dear, NOW, usd, wide, SOL / 10n)!.coinIn).toBeLessThanOrEqual(SOL / 10n);
    expect(ownPairPlan(cheap, dear, NOW, usd, { ...DEFAULT_LIMITS, maxTradeUsd: 20 }, lots)!.coinIn).toBeLessThanOrEqual(SOL / 10n);
  });

  it('is null when no trip clears the floor, or the two are not one pair', () => {
    expect(ownPairPlan(cheap, pool(50n * SOL, 10n ** 9n), NOW, usd, wide, lots)).toBeNull();
    expect(ownPairPlan(cheap, dear, NOW, usd, wide, 0n)).toBeNull();
    expect(ownPairPlan(cheap, cheap, NOW, usd, wide, lots)).toBeNull();
    const otherToken = viewOf(buildPool({ mint: key(), address: key(), quoteReserve: 50n * SOL, tokenReserve: 9n * 10n ** 8n }), { sol: 50n * SOL, tok: 9n * 10n ** 8n });
    expect(ownPairPlan(cheap, otherToken, NOW, usd, wide, lots)).toBeNull();
    expect(ownPairPlan(cheap, dear, NOW, new Map(), wide, lots)).toBeNull();
  });
});

describe('poolProblem: which pools the keeper can trade', () => {
  it('trades a SOL pool whose token keeps no fee', () => {
    expect(poolProblem(pool(SOL, 10n ** 9n), null)).toBeNull();
  });
  it('says why it cannot', () => {
    expect(poolProblem(pool(SOL, 10n ** 9n, { quote: BAYLA_QUOTE }), null)).toMatch(/priced in BAYLA/);
    expect(poolProblem({ ...pool(SOL, 10n ** 9n), vaultsFrozen: true }, null)).toMatch(/frozen/);
    expect(poolProblem(pool(SOL, 10n ** 9n, { status: POOL_STATUS_DISABLE_SWAP }), null)).toMatch(/switched off/);
    expect(poolProblem({ ...pool(SOL, 10n ** 9n), config: null }, null)).toMatch(/fee settings/);
    expect(poolProblem(pool(SOL, 10n ** 9n), 'unread')).toMatch(/not read/);
    expect(poolProblem(pool(SOL, 10n ** 9n), { epoch: 0n, maximumFee: 1n, basisPoints: 100 })).toMatch(/transfer fee/);
  });
});

describe('dustSaleProblem: what a test-run sale of leftovers must show', () => {
  const ok = { coinBefore: 100n, coinAfter: 150n, tokenBefore: 9n, tokenAfter: 0n, otherCoinBefore: 3n, otherCoinAfter: 3n, lamportsBefore: 10n ** 7n, lamportsAfter: 10n ** 7n - MAX_FEE_LAMPORTS };
  it('passes the SOL grown by the minimum, the token spent no more than sold', () => {
    expect(dustSaleProblem(ok, 50n, 9n)).toBeNull();
  });
  it('refuses a short sale, more token gone than sold, the other coin touched, or more SOL than fees', () => {
    expect(dustSaleProblem(ok, 51n, 9n)).toMatch(/under the sale/);
    expect(dustSaleProblem(ok, 50n, 8n)).toMatch(/more of the token/);
    expect(dustSaleProblem({ ...ok, otherCoinAfter: 2n }, 50n, 9n)).toMatch(/other coin/);
    expect(dustSaleProblem({ ...ok, lamportsAfter: ok.lamportsAfter - 1n }, 50n, 9n)).toMatch(/more SOL/);
  });
});

describe('priceStep: the quick check’s price, in steps of 0.25%', () => {
  it('is the same step for a small move from a step’s middle, and another step past 0.3%', () => {
    const middle = 1.0025 ** 1000;
    expect(priceStep(middle)).toBe(1000);
    expect(priceStep(middle * 1.0005)).toBe(1000);
    expect(priceStep(middle * 1.003)).toBe(1001);
    // The two KWIF pools' prices of 2026-10-30, 1.4% apart, are different prices.
    expect(priceStep(0.000002198)).not.toBe(priceStep(0.000002229));
  });
});
