// Restarting an almost empty pool at the market price (restart.ts). The pools here are the
// venue's own, as mainnet held them on 2026-11-26: every share taken out but the locked 100,
// a few units of each coin left. Then the pool program's own deposit and withdrawal rules
// (constant_product.rs: ceiling in, floor out) play a restart against someone who moved
// the pool first.
import { describe, expect, it } from 'vitest';
import { lpTokensToTradingTokens } from '../cpswap/math';
import type { PoolStateView } from '../cpswap/program';
import type { PoolSnapshot } from '../cpswap/read';
import { tooFewShares } from './liquidityMath';
import { CHECK_BACK_MAX_BPS, CHECK_BACK_UNITS, RESTART_PRICE_UNITS, planRestart, restartTargets, type RestartPlan } from './restart';
import type { TransferFee } from './transferFee';

function snap(r0: bigint, r1: bigint, lpSupply = 100n): PoolSnapshot {
  return { pool: { lpSupply } as PoolStateView, vault0Amount: r0, vault1Amount: r1, reserve0: r0, reserve1: r1 };
}

// SOL / TBB at 6tNCdzjDAEKamjZQmKwdb5sm8yzyqa8FxCKidNbPz5AA: 18 lamports and 567 units of TBB
// (6 decimals), the locked 100 shares. Jupiter: 39.83 TBB units a lamport.
const SOL_TBB = snap(18n, 567n);
const TBB_PER_LAMPORT = 39.83;
const SOL_PRICE = { quoteIsToken0: true, quoteDecimals: 9, tokenDecimals: 6, perToken: 1e6 / TBB_PER_LAMPORT / 1e9 };
// USDC / USDT at G23uSnADCtgMdRfBdRhYj3JRVL9Ky9GEVdyy7jK9ughx: 100 units of USDC, 101 of USDT, 1.001 USDC a USDT.
const USDC_USDT = snap(100n, 101n);
const USDT_PRICE = { quoteIsToken0: true, quoteDecimals: 6, tokenDecimals: 6, perToken: 1.001 };
// SOL / 9x9MKb at AvYPHmnArhEH8JK5PNjRuhjTjQATEo3pSpe1CfBMVavw: ONE lamport against 33,682 units; 130,500 units a lamport.
const ONE_LAMPORT = snap(1n, 33_682n);
const ONE_LAMPORT_PRICE = { ...SOL_PRICE, perToken: 1e6 / 130_500 / 1e9 };

const BPS = 100n; // 1%
const rawRatio = (t: { reserve0: bigint; reserve1: bigint }) => Number(t.reserve1) / Number(t.reserve0);

describe('restartTargets: where the top-up leaves the pool', () => {
  it('stands the pool at the market price, only ever adding to a side', () => {
    for (const [s, p, perLamport] of [
      [SOL_TBB, SOL_PRICE, TBB_PER_LAMPORT],
      [ONE_LAMPORT, ONE_LAMPORT_PRICE, 130_500],
    ] as const) {
      const t = restartTargets(s, p)!;
      expect(t.reserve0).toBeGreaterThanOrEqual(s.reserve0);
      expect(t.reserve1).toBeGreaterThanOrEqual(s.reserve1);
      expect(t.topUp0).toBe(t.reserve0 - s.reserve0);
      expect(t.topUp1).toBe(t.reserve1 - s.reserve1);
      expect(Math.abs(rawRatio(t) / perLamport - 1)).toBeLessThan(0.0005);
    }
  });

  it('raises both sides together when the side worked out from the price would be under 1,000 units', () => {
    // 18 lamports are worth 717 TBB units: under 1,000, so both sides are doubled first.
    const t = restartTargets(SOL_TBB, SOL_PRICE)!;
    expect(t.reserve0).toBe(36n);
    expect(t.reserve1).toBe(1_434n);
    expect(t.reserve1).toBeGreaterThanOrEqual(RESTART_PRICE_UNITS);
  });

  it('keeps the side worth more at the market price, and tops up the other', () => {
    // One lamport against 33,682 units: the lamport is worth 130,500 units, so the TOKEN is short.
    const t = restartTargets(ONE_LAMPORT, ONE_LAMPORT_PRICE)!;
    expect(t.topUp0).toBe(0n);
    expect(t.reserve1).toBe(130_500n);
  });

  it('answers nothing for a pool empty on a side, or a price that is not a positive number', () => {
    expect(restartTargets(snap(0n, 5n), SOL_PRICE)).toBeNull();
    expect(restartTargets(SOL_TBB, { ...SOL_PRICE, perToken: 0 })).toBeNull();
    expect(restartTargets(SOL_TBB, { ...SOL_PRICE, perToken: Number.NaN })).toBeNull();
    expect(restartTargets(SOL_TBB, { ...SOL_PRICE, perToken: Number.POSITIVE_INFINITY })).toBeNull();
  });
});

const restart = (s: PoolSnapshot, p: typeof SOL_PRICE, over: Partial<Parameters<typeof planRestart>[1]> = {}) =>
  planRestart(s, { ...p, driving: 'quote', maxIn: 100_000_000n, bps: BPS, availableQuote: null, availableToken: null, ...over });
const ok = (r: ReturnType<typeof planRestart>): RestartPlan => {
  if ('problem' in r) throw new Error(`expected a plan, got ${JSON.stringify(r, (_, v) => (typeof v === 'bigint' ? v.toString() : v))}`);
  return r;
};

describe('planRestart', () => {
  it('0.1 SOL into the dead SOL / TBB pool: at the market price, a sliver back, the pool no longer almost empty', () => {
    const p = ok(restart(SOL_TBB, SOL_PRICE));
    expect(p.topUpSent0).toBe(18n);
    expect(p.topUpSent1).toBe(867n);
    // The deposit is the pool's own maths on the topped-up pool: its price is the market's.
    expect(Number(p.deposit.cost1) / Number(p.deposit.cost0) / TBB_PER_LAMPORT).toBeCloseTo(1, 3);
    expect(p.deposit.max0).toBe(100_000_000n);
    expect(p.check.out0).toBeGreaterThanOrEqual(CHECK_BACK_UNITS);
    expect(p.check.out1).toBeGreaterThanOrEqual(CHECK_BACK_UNITS);
    expect(p.check.lp * 10_000n).toBeLessThanOrEqual(p.deposit.lp * CHECK_BACK_MAX_BPS);
    expect(p.keep).toBe(p.deposit.lp - p.check.lp);
    expect(tooFewShares(100n + p.keep)).toBe(false);
    // 18 lamports and 867 TBB units: about 40 lamports all told.
    expect(p.costQuote).toBeLessThanOrEqual(41n);
  });

  it('refuses an amount that would leave the pool almost empty, and says the least that would not', () => {
    // The stablecoin pool, both sides raised to about 1,010 units, is 10 units a share: 100,000
    // shares take about 1 USDC a side. The top-up (about 1,820 units in all) is then under 0.1% of it.
    const small = restart(USDC_USDT, USDT_PRICE, { maxIn: 1_000_000n });
    if (!('problem' in small) || small.problem !== 'too-small-to-restart') throw new Error('expected too small');
    const least = small.least;
    if (least === null) throw new Error('expected a least amount');
    expect(restart(USDC_USDT, USDT_PRICE, { maxIn: least - 1n })).toMatchObject({ problem: 'too-small-to-restart', least });
    const p = ok(restart(USDC_USDT, USDT_PRICE, { maxIn: least }));
    expect(p.costQuote).toBeLessThanOrEqual(1_821n);
    expect(Number(p.costQuote) / Number(p.deposit.cost0 + p.deposit.cost1)).toBeLessThan(0.001);
  });

  it('refuses an amount too small for the check-back to be a sliver', () => {
    expect(restart(SOL_TBB, SOL_PRICE, { maxIn: 20_000n })).toMatchObject({ problem: 'too-small-to-restart' });
  });

  it('refuses a check-back that would take back more than a tenth, though the pool would no longer be almost empty', () => {
    // One lamport a hundred shares: 5,000 lamports buy about 495,000 shares, well past 100,000,
    // but 1,000 lamports back out take about a fifth of them.
    const small = restart(ONE_LAMPORT, ONE_LAMPORT_PRICE, { maxIn: 5_000n });
    expect(small).toMatchObject({ problem: 'too-small-to-restart' });
    const least = 'problem' in small && small.problem === 'too-small-to-restart' ? small.least : null;
    expect(least).not.toBeNull();
    const p = ok(restart(ONE_LAMPORT, ONE_LAMPORT_PRICE, { maxIn: least! }));
    expect(p.check.lp * 10_000n).toBeLessThanOrEqual(p.deposit.lp * CHECK_BACK_MAX_BPS);
    expect(tooFewShares(100n + p.keep)).toBe(false);
  });

  it('is never offered for a pool that is not almost empty', () => {
    expect(restart(snap(18n, 567n, 100_000n), SOL_PRICE)).toEqual({ problem: 'no-target' });
  });

  // The review of 2026-11-26: 99,000 shares, 98,900 of them held, 1 SOL and 0.099 tokens at
  // 0.001 SOL a token. A 0.05 SOL restart would have topped up about 1 SOL of tokens, nearly
  // all of it the holder's to take out. Only a pool whose shares are the locked 100 alone.
  it('is never offered while anyone holds a share: the top-up would be theirs', () => {
    const held = snap(1_000_000_000n, 99_000n, 99_000n);
    const p = { quoteIsToken0: true, quoteDecimals: 9, tokenDecimals: 6, perToken: 0.001 };
    expect(restart(held, p, { maxIn: 50_000_000n })).toEqual({ problem: 'no-target' });
    expect(restart(snap(18n, 567n, 101n), SOL_PRICE)).toEqual({ problem: 'no-target' });
  });

  it('counts the top-up against the wallet: a balance that covers the deposit but not both is short, said in its own figures', () => {
    const p = ok(restart(SOL_TBB, SOL_PRICE));
    const bothNeeded = p.deposit.max1 + p.topUpSent1;
    // Enough for the deposit's own maximum, but not for the top-up as well.
    const short = restart(SOL_TBB, SOL_PRICE, { availableQuote: 10n ** 9n, availableToken: p.deposit.cost1 + p.topUpSent1 - 1n });
    expect(short).toMatchObject({ problem: 'over-balance', side: 'token', have: p.deposit.cost1 + p.topUpSent1 - 1n });
    expect(ok(restart(SOL_TBB, SOL_PRICE, { availableQuote: 10n ** 9n, availableToken: bothNeeded })).deposit.max1).toBe(p.deposit.max1);
  });

  it('sends a transfer fee on top of the top-up, so what reaches the vault is still the market price', () => {
    const fee: TransferFee = { epoch: 0n, maximumFee: 10n ** 12n, basisPoints: 100 };
    const p = ok(restart(SOL_TBB, SOL_PRICE, { fees: [null, fee] }));
    expect(p.topUpSent1).toBeGreaterThan(p.targets.topUp1);
    expect(p.targets.reserve1).toBe(567n + p.targets.topUp1);
  });
});

// ── the pool program, played against a restart ──────────────────────────────

interface Pool {
  r0: bigint;
  r1: bigint;
  s: bigint;
}
const from = (x: PoolSnapshot): Pool => ({ r0: x.reserve0, r1: x.reserve1, s: x.pool.lpSupply });

/** The restart transaction as the pool program runs it: a failure anywhere undoes all of it. */
function run(start: Pool, p: RestartPlan): { ok: true; pool: Pool; paid: [bigint, bigint]; back: [bigint, bigint] } | { ok: false; at: string } {
  const pool = { ...start };
  // 1. The top-up: plain transfers into the vaults.
  pool.r0 += p.targets.topUp0;
  pool.r1 += p.targets.topUp1;
  // 2. deposit.rs: ceiling cost, refused above a maximum (6005).
  const c = lpTokensToTradingTokens(p.deposit.lp, pool.s, pool.r0, pool.r1, 'ceiling')!;
  const paid: [bigint, bigint] = [c.token0Amount, c.token1Amount];
  if (paid[0] > p.deposit.max0 || paid[1] > p.deposit.max1) return { ok: false, at: 'deposit' };
  pool.r0 += paid[0];
  pool.r1 += paid[1];
  pool.s += p.deposit.lp;
  // 3. withdraw.rs: floor payout, refused below a minimum (6005).
  const o = lpTokensToTradingTokens(p.check.lp, pool.s, pool.r0, pool.r1, 'floor')!;
  const back: [bigint, bigint] = [o.token0Amount, o.token1Amount];
  if (back[0] < p.check.min0 || back[1] < p.check.min1) return { ok: false, at: 'check-back' };
  pool.r0 -= back[0];
  pool.r1 -= back[1];
  pool.s -= p.check.lp;
  return { ok: true, pool, paid, back };
}

/** Someone's own deposit of `lp` shares at the pool's price as it stands. */
function dilute(p: Pool, lp: bigint): Pool {
  const c = lpTokensToTradingTokens(lp, p.s, p.r0, p.r1, 'ceiling')!;
  return { r0: p.r0 + c.token0Amount, r1: p.r1 + c.token1Amount, s: p.s + lp };
}
/** A trade of `amountIn` of side 0 in (a negative amount: side 1 in), on x·y = k, the fee left in the pool. */
function trade(p: Pool, amountIn: bigint): Pool {
  const k = p.r0 * p.r1;
  if (amountIn > 0n) {
    const r0 = p.r0 + amountIn;
    return { ...p, r0, r1: (k + r0 - 1n) / r0 };
  }
  const r1 = p.r1 - amountIn;
  return { ...p, r1, r0: (k + r1 - 1n) / r1 };
}

describe('a restart against someone who moved the pool first', () => {
  const plan = ok(restart(SOL_TBB, SOL_PRICE));
  const start = from(SOL_TBB);

  it('goes through on the pool as it was read, and leaves it at the market price', () => {
    const r = run(start, plan);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(Number(r.pool.r1) / Number(r.pool.r0) / TBB_PER_LAMPORT).toBeCloseTo(1, 3);
    expect(r.paid).toEqual([plan.deposit.cost0, plan.deposit.cost1]);
  });

  it('fails when someone added their own shares at the old price first (only the check-back catches this)', () => {
    // Ten times the locked shares, for 180 lamports and about 5,670 TBB units: next to nothing.
    const moved = dilute(start, 1_000n);
    const r = run(moved, plan);
    expect(r).toEqual({ ok: false, at: 'check-back' });
  });

  it('would have gone through without the check-back, at a price far from the market’s', () => {
    // The same transaction with its floor taken away: the deposit's maxima alone pass it.
    const moved = dilute(start, 1_000n);
    const r = run(moved, { ...plan, check: { ...plan.check, min0: 1n, min1: 1n } });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(Math.abs(Number(r.pool.r1) / Number(r.pool.r0) / TBB_PER_LAMPORT - 1)).toBeGreaterThan(0.1);
  });

  it('fails when someone traded the pool first, either way', () => {
    expect(run(trade(start, 10n), plan).ok).toBe(false);
    expect(run(trade(start, -400n), plan).ok).toBe(false);
  });

  it('fails when someone sent coins straight into a vault first', () => {
    expect(run({ ...start, r0: start.r0 + 20n }, plan).ok).toBe(false);
    expect(run({ ...start, r1: start.r1 + 1_000n }, plan).ok).toBe(false);
  });
});
