// @vitest-environment node
//
// Round trips through three of our own pools: SOL → a token (TOKEN / SOL) → USDC (TOKEN / USDC)
// → SOL (USDC / SOL), the shape of BAYLA's and USDT's pools on the venue (read 2026-11-05).
// No Jupiter call: every leg is priced by the pool program's own maths (quoteOwnPool).
import { describe, it, expect } from 'vitest';
import { PublicKey } from '@solana/web3.js';
import { quoteOwnPool } from '../cpswap/read';
import { buildPool, key, viewOf } from '../lp/testkit.fixture';
import { SOL_QUOTE, USDC_QUOTE } from '../lp/quotes';
import type { PoolView } from '../lp/poolFinder';
import { DEFAULT_LIMITS, ownLoopPlan, ownLoops, type LoopLeg } from './plan';

const NOW = 10_000_000;
const SOL = 10n ** 9n;
const USDC = 10n ** 6n;
const usd = new Map([
  [SOL_QUOTE.mint, 200],
  [USDC_QUOTE.mint, 1],
]);
const wide = { ...DEFAULT_LIMITS, maxTradeUsd: 10_000 };
const lots = 1_000n * SOL;

function pool(mint: PublicKey, quote: typeof SOL_QUOTE, quoteReserve: bigint, tokenReserve: bigint): PoolView {
  return viewOf(buildPool({ mint, address: key(), quote, quoteReserve, tokenReserve }), { sol: quoteReserve, tok: tokenReserve });
}

const token = key();
// The token at 50 lamports ($0.00001) in its SOL pool, and 5% dearer in its USDC pool. 1% fee in each.
const tokenSol = pool(token, SOL_QUOTE, 50n * SOL, 10n ** 9n);
const tokenUsdcDear = pool(token, USDC_QUOTE, 10_500n * USDC, 10n ** 9n);
const tokenUsdcFair = pool(token, USDC_QUOTE, 10_000n * USDC, 10n ** 9n);
const usdcSol = pool(new PublicKey(USDC_QUOTE.mint), SOL_QUOTE, 50n * SOL, 10_000n * USDC);

const mintIn = (l: LoopLeg) => (l.input === 'coin' ? l.view.quote.mint : l.view.tokenMint);

/** What a loop of `x` makes, leg by leg, by the program's maths. */
function made(loop: LoopLeg[], x: bigint): bigint {
  let amount = x;
  for (const l of loop) amount = quoteOwnPool(l.view.snapshot, l.view.config!, mintIn(l), amount, NOW)!.outAmount;
  return amount - x;
}

describe('ownLoops: which three of our pools make a loop', () => {
  it('finds the loop both ways round, each once, starting in SOL', () => {
    const loops = ownLoops([tokenSol, tokenUsdcDear, usdcSol]);
    expect(loops).toHaveLength(2);
    for (const loop of loops) {
      expect(loop).toHaveLength(3);
      expect(mintIn(loop[0]!)).toBe(SOL_QUOTE.mint);
      expect(new Set(loop.map((l) => l.view))).toEqual(new Set([tokenSol, tokenUsdcDear, usdcSol]));
    }
    const ways = loops.map((loop) => loop.map((l) => l.view));
    expect(ways).toContainEqual([tokenSol, tokenUsdcDear, usdcSol]);
    expect(ways).toContainEqual([usdcSol, tokenUsdcDear, tokenSol]);
  });

  it('finds none without the pool that closes it', () => {
    expect(ownLoops([tokenSol, tokenUsdcDear])).toEqual([]);
    expect(ownLoops([tokenSol, usdcSol])).toEqual([]);
    // Two pools of one pair are a pair trip (ownPairPlan), not a loop.
    expect(ownLoops([tokenSol, pool(token, SOL_QUOTE, 50n * SOL, 9n * 10n ** 8n), usdcSol])).toEqual([]);
  });
});

describe('ownLoopPlan: the size of a loop', () => {
  const [cheapFirst, dearFirst] = (() => {
    const loops = ownLoops([tokenSol, tokenUsdcDear, usdcSol]);
    const a = loops.find((l) => l[0]!.view === tokenSol)!;
    const b = loops.find((l) => l[0]!.view === usdcSol)!;
    return [a, b];
  })();

  it('buys where the token is cheap and closes through USDC, at the size that makes the most', () => {
    const p = ownLoopPlan(cheapFirst, NOW, usd, wide, lots)!;
    expect(p.coin).toBe(SOL_QUOTE);
    expect(p.middle).toEqual([token.toBase58(), USDC_QUOTE.mint]);
    expect(p.coinOut - p.coinIn).toBe(made(cheapFirst, p.coinIn));
    expect(p.outs).toHaveLength(3);
    expect(p.outs[0]).toBe(quoteOwnPool(tokenSol.snapshot, tokenSol.config!, SOL_QUOTE.mint, p.coinIn, NOW)!.outAmount);
    expect(p.outs[2]).toBe(p.coinOut);
    expect(made(cheapFirst, (p.coinIn * 9n) / 10n)).toBeLessThan(p.coinOut - p.coinIn);
    expect(made(cheapFirst, (p.coinIn * 11n) / 10n)).toBeLessThan(p.coinOut - p.coinIn);
    expect(p.minProfit).toBe(50_000n); // $0.01 at $200 a SOL
  });

  it('is null the losing way round, and when the pools agree', () => {
    expect(ownLoopPlan(dearFirst, NOW, usd, wide, lots)).toBeNull();
    for (const loop of ownLoops([tokenSol, tokenUsdcFair, usdcSol])) expect(ownLoopPlan(loop, NOW, usd, wide, lots)).toBeNull();
    expect(ownLoopPlan(cheapFirst, NOW, new Map(), wide, lots)).toBeNull();
    expect(ownLoopPlan(cheapFirst, NOW, usd, wide, 0n)).toBeNull();
  });

  it('never spends more than the keeper holds, or than a trip may be', () => {
    expect(ownLoopPlan(cheapFirst, NOW, usd, wide, SOL / 10n)!.coinIn).toBeLessThanOrEqual(SOL / 10n);
    expect(ownLoopPlan(cheapFirst, NOW, usd, { ...DEFAULT_LIMITS, maxTradeUsd: 20 }, lots)!.coinIn).toBeLessThanOrEqual(SOL / 10n);
  });
});
