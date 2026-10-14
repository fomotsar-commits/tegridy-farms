// "Add with one coin", the arithmetic (oneCoin.ts). A SOL pool of 10 SOL and 1,000 tokens
// at tier 1 (1% a trade, 16% of it booked to the venue), built the way the program lays
// it out (testkit.fixture.ts). Every expected figure below is worked out by hand from
// cp-swap's own rules, not read back from the code under test.

import { describe, expect, it } from 'vitest';
import { decodeAmmConfig, decodePoolState } from '../cpswap/program';
import { quoteOwnPool, type PoolSnapshot } from '../cpswap/read';
import { SOL_QUOTE } from './quotes';
import { buildPool, key } from './testkit.fixture';
import { outsideShare, ownPoolShare, poolAfterSwap, stepTwo } from './oneCoin';
import { isPlanProblem } from './liquidityMath';

const MINT = key();
const SOL = 10n ** 9n;
const TOK = 10n ** 6n;

function pool() {
  const b = buildPool({ plain: true, mint: MINT, quote: SOL_QUOTE, configIndex: 1, quoteReserve: 10n * SOL, tokenReserve: 1_000n * TOK, openTime: 1n, lpSupply: 100n * SOL });
  const p = decodePoolState(b.address.toBase58(), b.accounts[b.address.toBase58()]!.data)!;
  const config = decodeAmmConfig(b.config.toBase58(), b.accounts[b.config.toBase58()]!.data)!;
  const quoteIsToken0 = p.token0Mint === SOL_QUOTE.mint;
  const [r0, r1] = quoteIsToken0 ? [10n * SOL, 1_000n * TOK] : [1_000n * TOK, 10n * SOL];
  const snap: PoolSnapshot = { pool: p, vault0Amount: r0, vault1Amount: r1, reserve0: r0, reserve1: r1 };
  return { snap, config, quoteIsToken0 };
}

describe('poolAfterSwap', () => {
  it('books the venue’s cut apart and keeps the pool’s cut in the price, as cp-swap does', () => {
    const { snap, config, quoteIsToken0 } = pool();
    const q = quoteOwnPool(snap, config, SOL_QUOTE.mint, 1n * SOL, 100)!;
    // 1 SOL in: a 1% trade fee of 10,000,000, of which 16% (1,600,000) is the venue's and
    // sits outside the reserves. 990,000,000 is swapped: 990,000,000 × 1e9 / 10.99e9 out.
    expect(q.outAmount).toBe(90_081_892n);
    const after = poolAfterSwap(snap, SOL_QUOTE.mint, 1n * SOL, q);
    const [sol, tok] = quoteIsToken0 ? [after.reserve0, after.reserve1] : [after.reserve1, after.reserve0];
    expect(sol).toBe(10n * SOL + 1n * SOL - 1_600_000n);
    expect(tok).toBe(1_000n * TOK - 90_081_892n);
  });
});

describe('ownPoolShare', () => {
  it('swaps the part that leaves what is kept and what came back at the pool’s ratio after the swap', () => {
    const { snap, config, quoteIsToken0 } = pool();
    const share = ownPoolShare(snap, config, SOL_QUOTE.mint, 1n * SOL, 100)!;
    // Under half: the swap raises the pool's SOL price, so the kept SOL buys more of the
    // pool there. The textbook zap with a 1% fee on a 10 SOL side gives 0.4906 SOL.
    expect(share.swapIn > (SOL * 490n) / 1000n && share.swapIn < (SOL * 491n) / 1000n).toBe(true);
    // At no slippage step 2 uses all but a few base units of both coins.
    const two = stepTwo(share.after, { quoteIsToken0, paid: 'quote', kept: SOL - share.swapIn, got: share.out, bps: 0n });
    if (isPlanProblem(two)) throw new Error(two.problem);
    expect(two.left.quote).toBeLessThan(1_000n);
    expect(two.left.token).toBeLessThan(10n);
    // One base unit more to swap and the kept SOL no longer covers what came back.
    const more = quoteOwnPool(snap, config, SOL_QUOTE.mint, share.swapIn + 1n, 100)!;
    const after = poolAfterSwap(snap, SOL_QUOTE.mint, share.swapIn + 1n, more);
    const [rSol, rTok] = quoteIsToken0 ? [after.reserve0, after.reserve1] : [after.reserve1, after.reserve0];
    expect((SOL - share.swapIn - 1n) * rTok < more.outAmount * rSol).toBe(true);
  });

  it('is null when the pool cannot price any part of it', () => {
    const { snap, config } = pool();
    expect(ownPoolShare(snap, config, SOL_QUOTE.mint, 1n, 100)).toBeNull();
    expect(ownPoolShare(snap, config, SOL_QUOTE.mint, 1n * SOL, 0)).toBeNull(); // not open yet
  });
});

describe('outsideShare', () => {
  it('splits by the outside rate against this pool’s ratio', () => {
    // Pool: 10 SOL to 1,000 tokens. Outside: 0.5 SOL buys 50 tokens, the pool's own price.
    expect(outsideShare(SOL, SOL / 2n, 50n * TOK, 10n * SOL, 1_000n * TOK)).toBe(SOL / 2n);
    // Outside pays twice the pool's rate: a third is swapped, two thirds kept (1:2 by value there).
    expect(outsideShare(3n * SOL, SOL, 200n * TOK, 10n * SOL, 1_000n * TOK)).toBe(SOL);
    expect(outsideShare(SOL, 0n, 1n, 1n, 1n)).toBeNull();
  });
});

describe('stepTwo', () => {
  it('the paid side drives, and what it leaves of each coin is said', () => {
    const { snap, quoteIsToken0 } = pool();
    // 0.5 SOL kept and 50 tokens got, at the pool's own ratio, at 1%.
    const two = stepTwo(snap, { quoteIsToken0, paid: 'quote', kept: SOL / 2n, got: 50n * TOK, bps: 100n });
    if (isPlanProblem(two)) throw new Error(two.problem);
    expect(two.driving).toBe('quote');
    expect(two.maxIn).toBe(SOL / 2n);
    // The typed most is the most that leaves: about 1% of each stays.
    expect(two.left.quote).toBe(SOL / 2n - (quoteIsToken0 ? two.plan.cost0 : two.plan.cost1));
    expect(two.left.quote > 4_900_000n && two.left.quote < 5_000_000n).toBe(true);
    expect(two.left.token > 490_000n && two.left.token < 500_000n).toBe(true);
  });

  it('the other side drives when the swap paid less than the kept side needs', () => {
    const { snap, quoteIsToken0 } = pool();
    const two = stepTwo(snap, { quoteIsToken0, paid: 'quote', kept: SOL / 2n, got: 40n * TOK, bps: 100n });
    if (isPlanProblem(two)) throw new Error(two.problem);
    expect(two.driving).toBe('token');
    expect(two.maxIn).toBe(40n * TOK);
    // About 0.1 SOL of the kept half stays.
    expect(two.left.quote > SOL / 10n).toBe(true);
  });
});
