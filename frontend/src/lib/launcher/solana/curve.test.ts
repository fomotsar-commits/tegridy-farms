import { describe, it, expect } from 'vitest';
import {
  BONDING_CURVE_SIZE,
  BPS_DENOMINATOR,
  CurveQuoteError,
  GLOBAL_CONFIG_SIZE,
  LAUNCH_ERROR_NAMES,
  applySlippage,
  buyBlockedReason,
  classifyLaunchPhase,
  decodeBondingCurve,
  decodeGlobalConfig,
  effectiveSol,
  effectiveTokens,
  feeUp,
  formatSol,
  formatTokenAmount,
  graduationProgress,
  isZeroPubkey,
  lamportsUntilTarget,
  launchErrorName,
  migrationBlockedReason,
  parseDecimalToBaseUnits,
  quoteBuy,
  quoteSell,
  raiseCeiling,
  sellBlockedReason,
  spotPriceScaled,
  violatesRentFloor,
  type AccountRead,
  type BondingCurveState,
  type GlobalConfigState,
  type ProgramProbe,
} from './curve';

// Ground truth for this file is the program itself:
//   solana/tegridy-amm/programs/tegridy-launch/src/{curve,state,lib,errors}.rs
// The constants below are the ones the program's OWN unit tests use
// (curve.rs:409-412), so a property that holds there must hold here.

const SOL = 1_000_000_000n;
const V_SOL = 30n * SOL;
const V_TOK = 1_073_000_000_000_000n;
const SUPPLY = 1_000_000_000_000_000n;

const ZERO32 = new Uint8Array(32);

/** A curve in the state `create_launch` leaves it in (lib.rs:425-435). */
function freshCurve(over: Partial<BondingCurveState> = {}): BondingCurveState {
  return {
    mint: new Uint8Array(32).fill(1),
    creator: new Uint8Array(32).fill(2),
    virtualSolReserves: V_SOL,
    virtualTokenReserves: V_TOK,
    realSolReserves: 0n,
    realTokenReserves: SUPPLY,
    tradeFeeBps: 100n,
    graduationTargetLamports: 85n * SOL,
    migrationReserveLamports: 1n * SOL,
    complete: false,
    pool: new Uint8Array(32),
    bump: 255,
    ...over,
  };
}

function freshGlobal(over: Partial<GlobalConfigState> = {}): GlobalConfigState {
  return {
    authority: new Uint8Array(32).fill(3),
    feeRecipient: new Uint8Array(32).fill(4),
    tradeFeeBps: 100n,
    initialVirtualSol: V_SOL,
    initialVirtualToken: V_TOK,
    tokenTotalSupply: SUPPLY,
    graduationTargetLamports: 85n * SOL,
    migrationReserveLamports: 1n * SOL,
    cpSwapProgram: new Uint8Array(32).fill(5),
    ammConfig: new Uint8Array(32).fill(6),
    paused: false,
    bump: 254,
    ...over,
  };
}

const present = <T>(value: T): AccountRead<T> => ({ status: 'present', value });
const DEPLOYED: ProgramProbe = { status: 'deployed' };

// ---------------------------------------------------------------------------
// Fees — exact vectors lifted from curve.rs:488-496
// ---------------------------------------------------------------------------

describe('feeUp', () => {
  it('rounds UP so a dust trade still pays (curve.rs:489-496)', () => {
    expect(feeUp(1n, 1n)).toBe(1n); // 0.0001 lamports must still charge 1
    expect(feeUp(0n, 100n)).toBe(0n);
    expect(feeUp(10_000n, 100n)).toBe(100n);
    // Exactly divisible must NOT be pushed to the next lamport.
    expect(feeUp(20_000n, 100n)).toBe(200n);
  });

  it('rejects a fee above the protocol ceiling (curve.rs:93-95)', () => {
    expect(() => feeUp(SOL, 1001n)).toThrow(CurveQuoteError);
    expect(() => feeUp(SOL, 1001n)).toThrow(/ceiling/i);
    expect(feeUp(SOL, 1000n)).toBe(100_000_000n); // 1000 bps is legal
  });

  it('short-circuits a zero fee rather than rounding it up to 1', () => {
    expect(feeUp(999_999_999n, 0n)).toBe(0n);
  });
});

// ---------------------------------------------------------------------------
// Buy
// ---------------------------------------------------------------------------

describe('quoteBuy', () => {
  it('charges the fee off the top and quotes the constant-product remainder', () => {
    const q = quoteBuy(freshCurve(), SOL);
    // Computed from the program's formula: out = (y*dx)/(x+dx), rounded down.
    expect(q.feeLamports).toBe(10_000_000n);
    expect(q.lamportsToCurve).toBe(990_000_000n);
    expect(q.tokensOut).toBe(66_223_620_522_749n);
    expect(q.cappedIn).toBe(SOL);
    expect(q.capped).toBe(false);
    // The debit is the sum of both legs — this is what the wallet actually pays.
    expect(q.lamportsToCurve + q.feeLamports).toBe(q.cappedIn);
  });

  it('sends everything to the curve at a zero fee (curve.rs:424-429)', () => {
    const q = quoteBuy(freshCurve({ tradeFeeBps: 0n }), SOL);
    expect(q.feeLamports).toBe(0n);
    expect(q.lamportsToCurve).toBe(SOL);
  });

  it('quotes from the curve SNAPSHOT fee, so two curves at different fees differ', () => {
    // lib.rs:430-432 snapshots trade_fee_bps at creation precisely so a later
    // governance change cannot rewrite a live launch. A quote built from
    // `global` instead would silently disagree with the program.
    const cheap = quoteBuy(freshCurve({ tradeFeeBps: 0n }), SOL);
    const dear = quoteBuy(freshCurve({ tradeFeeBps: 1000n }), SOL);
    expect(dear.feeLamports).toBe(100_000_000n);
    expect(dear.tokensOut).toBeLessThan(cheap.tokensOut);
  });

  it('prices strictly higher as the curve fills (curve.rs:431-442)', () => {
    const first = quoteBuy(freshCurve({ tradeFeeBps: 0n }), SOL);
    const later = quoteBuy(
      freshCurve({
        tradeFeeBps: 0n,
        realSolReserves: 10n * SOL,
        realTokenReserves: SUPPLY - first.tokensOut,
      }),
      SOL,
    );
    expect(later.tokensOut).toBeLessThan(first.tokensOut);
  });

  it('never lets a round trip profit (curve.rs:447-461)', () => {
    for (const spend of [SOL / 1000n, SOL, 5n * SOL, 25n * SOL]) {
      const buy = quoteBuy(freshCurve({ tradeFeeBps: 0n }), spend);
      const after = freshCurve({
        tradeFeeBps: 0n,
        realSolReserves: buy.lamportsToCurve,
        realTokenReserves: SUPPLY - buy.tokensOut,
      });
      const sell = quoteSell(after, buy.tokensOut);
      expect(sell.lamportsOut).toBeLessThanOrEqual(spend);
    }
  });

  it('never lets order-slicing beat one shot (curve.rs:465-485)', () => {
    const total = 10n * SOL;
    const oneShot = quoteBuy(freshCurve({ tradeFeeBps: 0n }), total).tokensOut;

    let realSol = 0n;
    let realTok = SUPPLY;
    let acc = 0n;
    for (let i = 0; i < 10; i++) {
      const q = quoteBuy(
        freshCurve({ tradeFeeBps: 0n, realSolReserves: realSol, realTokenReserves: realTok }),
        total / 10n,
      );
      acc += q.tokensOut;
      realSol += q.lamportsToCurve;
      realTok -= q.tokensOut;
    }
    expect(acc).toBeLessThanOrEqual(oneShot);
  });

  it('CAPS the spend at target + reserve and reports it as capped (lib.rs:466-480)', () => {
    // One lamport of post-fee room left below the ceiling.
    const c = freshCurve({ realSolReserves: raiseCeiling(freshCurve()) - 1n });
    const q = quoteBuy(c, 500n * SOL);
    expect(q.capped).toBe(true);
    // Grossed up for the 1% fee: 1 post-fee lamport needs 2 gross (ceil).
    expect(q.cappedIn).toBe(2n);
    expect(q.cappedIn).toBeLessThan(500n * SOL);
  });

  it('caps against target PLUS reserve, not the target alone', () => {
    // Sitting exactly ON the target: buys must still be accepted, because the
    // migration reserve is raised above the target (lib.rs:459-469).
    const c = freshCurve({ realSolReserves: 85n * SOL });
    const q = quoteBuy(c, 10n * SOL);
    expect(q.cappedIn).toBeGreaterThan(0n);
    expect(q.capped).toBe(true);
  });

  it('rejects a fully funded curve with AwaitingMigration, NOT AlreadyComplete', () => {
    // 6019 exists solely to keep these apart: an earlier version returned
    // AlreadyComplete here, telling callers a curve had moved to an AMM pool
    // when it had not (lib.rs:476-479).
    const c = freshCurve({ realSolReserves: raiseCeiling(freshCurve()) });
    expect(() => quoteBuy(c, SOL)).toThrow(CurveQuoteError);
    try {
      quoteBuy(c, SOL);
    } catch (e) {
      expect((e as CurveQuoteError).code).toBe('AwaitingMigration');
    }
  });

  it('rejects a graduated curve with AlreadyComplete', () => {
    try {
      quoteBuy(freshCurve({ complete: true }), SOL);
      throw new Error('should have thrown');
    } catch (e) {
      expect((e as CurveQuoteError).code).toBe('AlreadyComplete');
    }
  });

  it('rejects a dust buy whose whole input is eaten by the fee (curve.rs:523-529)', () => {
    try {
      quoteBuy(freshCurve({ tradeFeeBps: 1000n }), 1n);
      throw new Error('should have thrown');
    } catch (e) {
      expect((e as CurveQuoteError).code).toBe('ZeroAmount');
    }
  });

  it('rejects zero and empty reserves (curve.rs:507-519)', () => {
    expect(() => quoteBuy(freshCurve(), 0n)).toThrow(/zero/i);
    try {
      // Both legs of `effective_sol` at zero: nothing to price against.
      quoteBuy(freshCurve({ virtualSolReserves: 0n }), SOL);
      throw new Error('should have thrown');
    } catch (e) {
      expect((e as CurveQuoteError).code).toBe('InsufficientLiquidity');
    }
  });

  it('refuses to quote more tokens than the curve REALLY holds', () => {
    // curve.rs:152 checks against EFFECTIVE tokens; lib.rs:492 against REAL
    // ones. Only the second one bites here.
    const c = freshCurve({ realTokenReserves: 1_000n });
    try {
      quoteBuy(c, 100n * SOL);
      throw new Error('should have thrown');
    } catch (e) {
      expect((e as CurveQuoteError).code).toBe('InsufficientLiquidity');
    }
  });

  it('refuses a negative or over-u64 request instead of computing a phantom quote', () => {
    expect(() => quoteBuy(freshCurve(), -1n)).toThrow(CurveQuoteError);
    expect(() => quoteBuy(freshCurve(), 2n ** 64n)).toThrow(CurveQuoteError);
  });
});

// ---------------------------------------------------------------------------
// Sell
// ---------------------------------------------------------------------------

describe('quoteSell', () => {
  it('mirrors the buy branch and deducts the fee from the gross', () => {
    const buy = quoteBuy(freshCurve(), SOL);
    const after = freshCurve({
      realSolReserves: buy.lamportsToCurve,
      realTokenReserves: SUPPLY - buy.tokensOut,
    });
    const s = quoteSell(after, buy.tokensOut);
    expect(s.gross).toBe(989_999_999n);
    expect(s.feeLamports).toBe(9_900_000n);
    expect(s.lamportsOut).toBe(980_099_999n);
    expect(s.gross - s.feeLamports).toBe(s.lamportsOut);
  });

  it('never pays out more than the curve holds in REAL lamports (lib.rs:582-587)', () => {
    // The virtual leg is pricing fiction and is never redeemable, so a sell
    // priced off virtual+real must still be refused if it exceeds real.
    const c = freshCurve({ realSolReserves: 1n, realTokenReserves: SUPPLY });
    try {
      quoteSell(c, 100_000_000_000_000n);
      throw new Error('should have thrown');
    } catch (e) {
      expect((e as CurveQuoteError).code).toBe('InsufficientLiquidity');
    }
  });

  it('rejects zero tokens in', () => {
    expect(() => quoteSell(freshCurve(), 0n)).toThrow(/zero/i);
  });

  it('rejects a graduated curve', () => {
    try {
      quoteSell(freshCurve({ complete: true }), 1_000n);
      throw new Error('should have thrown');
    } catch (e) {
      expect((e as CurveQuoteError).code).toBe('AlreadyComplete');
    }
  });
});

describe('violatesRentFloor', () => {
  it('reads the PDA balance, not the reserves field (lib.rs:605-614)', () => {
    const rent = 2_018_400n;
    // Balance = rent + 1 SOL of reserves. A 1 SOL sell leaves exactly rent.
    expect(violatesRentFloor(SOL, rent + SOL, rent)).toBe(false);
    expect(violatesRentFloor(SOL + 1n, rent + SOL, rent)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Cap helper
// ---------------------------------------------------------------------------

describe('lamportsUntilTarget', () => {
  it('grosses the remainder up so the post-fee amount lands on target (curve.rs:562-575)', () => {
    const gross = lamportsUntilTarget(0n, 10n * SOL, 100n);
    expect(gross).not.toBeNull();
    expect(gross!).toBeGreaterThan(10n * SOL);
    expect(gross! - feeUp(gross!, 100n)).toBeGreaterThanOrEqual(10n * SOL);
  });

  it('returns null once the ceiling is reached or passed (curve.rs:577-581)', () => {
    expect(lamportsUntilTarget(10n * SOL, 10n * SOL, 100n)).toBeNull();
    expect(lamportsUntilTarget(11n * SOL, 10n * SOL, 100n)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Slippage
// ---------------------------------------------------------------------------

describe('applySlippage', () => {
  it('rounds the floor DOWN so it never exceeds the quote', () => {
    expect(applySlippage(1_000n, 100n)).toBe(990n); // 1%
    expect(applySlippage(9_999n, 100n)).toBe(9_899n); // floor, not 9899.01
    expect(applySlippage(1_000n, 0n)).toBe(1_000n);
  });

  it('refuses a tolerance of 100% or more, which would accept any fill', () => {
    expect(() => applySlippage(1_000n, BPS_DENOMINATOR)).toThrow(CurveQuoteError);
    expect(() => applySlippage(1_000n, -1n)).toThrow(CurveQuoteError);
  });
});

// ---------------------------------------------------------------------------
// Derived display numbers
// ---------------------------------------------------------------------------

describe('graduationProgress', () => {
  it('uses target + reserve as the denominator, not target alone', () => {
    // With target 85 and reserve 1, sitting on 85 SOL is 85/86, NOT 100%.
    // Using the target alone would show a full bar while buys still succeed.
    const p = graduationProgress(freshCurve({ realSolReserves: 85n * SOL }));
    expect(p).toBeCloseTo(85 / 86, 4);
    expect(p).toBeLessThan(1);
  });

  it('is 0 on a fresh curve and 1 once fully funded', () => {
    expect(graduationProgress(freshCurve())).toBe(0);
    expect(graduationProgress(freshCurve({ realSolReserves: 86n * SOL }))).toBe(1);
  });
});

describe('spotPriceScaled', () => {
  it('prices off effective (virtual + real) reserves on both legs', () => {
    const c = freshCurve();
    expect(effectiveSol(c)).toBe(V_SOL);
    expect(effectiveTokens(c)).toBe(V_TOK + SUPPLY);
    expect(spotPriceScaled(c)).toBe((V_SOL * 1_000_000_000_000n) / (V_TOK + SUPPLY));
  });

  it('returns null rather than dividing by zero', () => {
    expect(spotPriceScaled(freshCurve({ virtualTokenReserves: 0n, realTokenReserves: 0n }))).toBeNull();
  });
});

describe('formatSol', () => {
  it('never renders a non-zero balance as 0', () => {
    // The defect this repo keeps re-shipping: a real value truncated to a clean
    // zero. Below display precision must read as "smaller than", not "none".
    expect(formatSol(1n)).toBe('<0.0001');
    expect(formatSol(0n)).toBe('0');
    expect(formatSol(SOL)).toBe('1');
    expect(formatSol(1_500_000_000n)).toBe('1.5');
    expect(formatSol(86n * SOL)).toBe('86');
  });
});

describe('formatTokenAmount', () => {
  it('says it is showing base units when decimals could not be read', () => {
    // Decimals are not on the curve and NOT constrained by the program — the
    // tests use 9 but nothing enforces it. Assuming 9 mis-scales every number.
    const r = formatTokenAmount(1_234_567_890n, null);
    expect(r.isBaseUnits).toBe(true);
    expect(r.text).toBe('1234567890');
  });

  it('scales by the mint decimals when they were read', () => {
    const r = formatTokenAmount(1_234_567_890n, 9);
    expect(r.isBaseUnits).toBe(false);
    expect(r.text).toBe('1.2345');
  });

  it('does not assume 9 — a 6-decimal mint scales differently', () => {
    expect(formatTokenAmount(1_234_567_890n, 6).text).toBe('1,234.5678');
  });
});

describe('parseDecimalToBaseUnits', () => {
  it('parses exactly and rejects junk rather than coercing it to zero', () => {
    expect(parseDecimalToBaseUnits('1.5', 9)).toBe(1_500_000_000n);
    expect(parseDecimalToBaseUnits('0.000000001', 9)).toBe(1n);
    expect(parseDecimalToBaseUnits('', 9)).toBeNull();
    expect(parseDecimalToBaseUnits('abc', 9)).toBeNull();
    expect(parseDecimalToBaseUnits('-1', 9)).toBeNull();
    expect(parseDecimalToBaseUnits('1e9', 9)).toBeNull();
    // More precision than the mint has is a mistake, not a rounding opportunity.
    expect(parseDecimalToBaseUnits('1.0000000001', 9)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Account decoding
// ---------------------------------------------------------------------------

function encodeCurve(c: BondingCurveState): Uint8Array {
  const b = new Uint8Array(BONDING_CURVE_SIZE);
  b.set([23, 183, 248, 55, 96, 216, 172, 96], 0);
  b.set(c.mint, 8);
  b.set(c.creator, 40);
  const v = new DataView(b.buffer);
  v.setBigUint64(72, c.virtualSolReserves, true);
  v.setBigUint64(80, c.virtualTokenReserves, true);
  v.setBigUint64(88, c.realSolReserves, true);
  v.setBigUint64(96, c.realTokenReserves, true);
  v.setBigUint64(104, c.tradeFeeBps, true);
  v.setBigUint64(112, c.graduationTargetLamports, true);
  v.setBigUint64(120, c.migrationReserveLamports, true);
  b[128] = c.complete ? 1 : 0;
  b.set(c.pool, 129);
  b[161] = c.bump;
  return b;
}

describe('decodeBondingCurve', () => {
  it('round-trips every field at its documented offset', () => {
    const original = freshCurve({ realSolReserves: 12_345n, complete: true, pool: new Uint8Array(32).fill(9) });
    const r = decodeBondingCurve(encodeCurve(original));
    expect(r.status).toBe('present');
    if (r.status !== 'present') return;
    expect(r.value.realSolReserves).toBe(12_345n);
    expect(r.value.virtualTokenReserves).toBe(V_TOK);
    expect(r.value.tradeFeeBps).toBe(100n);
    expect(r.value.graduationTargetLamports).toBe(85n * SOL);
    expect(r.value.migrationReserveLamports).toBe(1n * SOL);
    expect(r.value.complete).toBe(true);
    expect(r.value.bump).toBe(255);
    expect([...r.value.pool]).toEqual([...new Uint8Array(32).fill(9)]);
  });

  it('reads u64s that exceed Number.MAX_SAFE_INTEGER without losing precision', () => {
    const big = 18_446_744_073_709_551_615n; // u64::MAX — the full field range
    expect(big).toBeGreaterThan(BigInt(Number.MAX_SAFE_INTEGER));
    const r = decodeBondingCurve(encodeCurve(freshCurve({ realTokenReserves: big })));
    if (r.status !== 'present') throw new Error('expected present');
    expect(r.value.realTokenReserves).toBe(big);
  });

  it('reports a missing account as absent, not as a zeroed curve', () => {
    expect(decodeBondingCurve(null).status).toBe('absent');
    expect(decodeBondingCurve(undefined).status).toBe('absent');
  });

  it('reports a wrong-sized buffer as UNREADABLE rather than decoding garbage', () => {
    const r = decodeBondingCurve(new Uint8Array(100));
    expect(r.status).toBe('unreadable');
    if (r.status === 'unreadable') expect(r.reason).toMatch(/100 bytes/);
  });

  it('refuses to decode an account with a foreign discriminator', () => {
    const b = encodeCurve(freshCurve());
    b[0] = 0; // any other Anchor account would land here
    const r = decodeBondingCurve(b);
    expect(r.status).toBe('unreadable');
    if (r.status === 'unreadable') expect(r.reason).toMatch(/discriminator/);
  });
});

describe('decodeGlobalConfig', () => {
  it('decodes at the documented offsets and treats a wrong size as unreadable', () => {
    const b = new Uint8Array(GLOBAL_CONFIG_SIZE);
    b.set([149, 8, 156, 202, 160, 252, 176, 217], 0);
    const v = new DataView(b.buffer);
    v.setBigUint64(72, 250n, true); // trade_fee_bps
    v.setBigUint64(96, SUPPLY, true); // token_total_supply
    v.setBigUint64(104, 85n * SOL, true); // graduation_target_lamports
    b[184] = 1; // paused
    const r = decodeGlobalConfig(b);
    if (r.status !== 'present') throw new Error('expected present');
    expect(r.value.tradeFeeBps).toBe(250n);
    expect(r.value.tokenTotalSupply).toBe(SUPPLY);
    expect(r.value.graduationTargetLamports).toBe(85n * SOL);
    expect(r.value.paused).toBe(true);
    // cp_swap_program / amm_config are legitimately zero before an operator
    // creates the AmmConfig — a real state, not a read failure.
    expect(isZeroPubkey(r.value.cpSwapProgram)).toBe(true);

    expect(decodeGlobalConfig(new Uint8Array(GLOBAL_CONFIG_SIZE - 1)).status).toBe('unreadable');
  });
});

// ---------------------------------------------------------------------------
// Phase classification — the honesty layer
// ---------------------------------------------------------------------------

describe('classifyLaunchPhase', () => {
  const g = present(freshGlobal());

  it('answers "not deployed" before looking at anything else', () => {
    const p = classifyLaunchPhase({ status: 'not-deployed' }, present(freshGlobal()), present(freshCurve()));
    expect(p.kind).toBe('not-deployed');
  });

  it('NEVER falls through an unreadable read to a later, positive row', () => {
    // This is the whole reason the ordering is fixed. Every row below
    // "unreadable" is a positive claim about the launch, and a failed read is
    // not a finding about the launch at all.
    const readable = present(freshCurve());
    expect(classifyLaunchPhase({ status: 'unreadable', reason: 'rpc 503' }, g, readable).kind).toBe('unreadable');
    expect(classifyLaunchPhase(DEPLOYED, { status: 'unreadable', reason: 'x' }, readable).kind).toBe('unreadable');
    expect(classifyLaunchPhase(DEPLOYED, g, { status: 'unreadable', reason: 'y' }).kind).toBe('unreadable');
  });

  it('separates "protocol not initialized" from "this mint has no curve"', () => {
    expect(classifyLaunchPhase(DEPLOYED, { status: 'absent' }, { status: 'absent' }).kind).toBe('not-initialized');
    expect(classifyLaunchPhase(DEPLOYED, g, { status: 'absent' }).kind).toBe('pre-launch');
  });

  it('distinguishes trading / at-target / awaiting-migration / graduated', () => {
    expect(classifyLaunchPhase(DEPLOYED, g, present(freshCurve())).kind).toBe('trading');
    expect(classifyLaunchPhase(DEPLOYED, g, present(freshCurve({ realSolReserves: 85n * SOL }))).kind).toBe('at-target');
    expect(classifyLaunchPhase(DEPLOYED, g, present(freshCurve({ realSolReserves: 86n * SOL }))).kind).toBe(
      'awaiting-migration',
    );
    // `complete` outranks the reserves: it is the only terminal state.
    expect(classifyLaunchPhase(DEPLOYED, g, present(freshCurve({ complete: true }))).kind).toBe('graduated');
  });

  it('has no "migrating" phase at all', () => {
    // Migration is one atomic instruction — a curve is either open or complete.
    const kinds = new Set(
      [
        freshCurve(),
        freshCurve({ realSolReserves: 85n * SOL }),
        freshCurve({ realSolReserves: 86n * SOL }),
        freshCurve({ complete: true }),
      ].map((c) => classifyLaunchPhase(DEPLOYED, g, present(c)).kind),
    );
    expect([...kinds]).not.toContain('migrating');
  });
});

describe('buy/sell gating', () => {
  it('halts buys when paused but leaves selling open (lib.rs:453 vs 563-564)', () => {
    const trading = { kind: 'trading' } as const;
    expect(buyBlockedReason(trading, true)).toBe('Paused');
    // A pause stops new money entering; it must never strand holders.
    expect(sellBlockedReason(trading)).toBeNull();
  });

  it('blocks buys on a fully funded curve with a DIFFERENT reason than a graduated one', () => {
    expect(buyBlockedReason({ kind: 'awaiting-migration' }, false)).toBe('AwaitingMigration');
    expect(buyBlockedReason({ kind: 'graduated' }, false)).toBe('AlreadyComplete');
    // ...and sells still work on the fully funded one.
    expect(sellBlockedReason({ kind: 'awaiting-migration' })).toBeNull();
    expect(sellBlockedReason({ kind: 'graduated' })).toBe('AlreadyComplete');
  });
});

describe('migrationBlockedReason', () => {
  const funded = freshCurve({ realSolReserves: 86n * SOL });
  const rent = 2_018_400n;
  const balance = rent + 86n * SOL;

  it('passes only when every read-only precondition holds (lib.rs:695-743)', () => {
    expect(migrationBlockedReason(freshGlobal(), funded, balance, rent)).toBeNull();
  });

  it('does not offer migration at the target — the lamport budget check will fail', () => {
    const atTarget = freshCurve({ realSolReserves: 85n * SOL });
    expect(migrationBlockedReason(freshGlobal(), atTarget, rent + 85n * SOL, rent)).toBe('MigrationReserveTooLow');
  });

  it('reports an unconfigured venue as a protocol state, not a launch failure', () => {
    expect(migrationBlockedReason(freshGlobal({ ammConfig: ZERO32 }), funded, balance, rent)).toBe('AmmNotConfigured');
    expect(migrationBlockedReason(freshGlobal({ cpSwapProgram: ZERO32 }), funded, balance, rent)).toBe(
      'AmmNotConfigured',
    );
  });

  it('reads the PDA balance, so a 1-lamport shortfall blocks it', () => {
    // The known stall: `sell` is unpausable, so a 1-lamport sell can flip this
    // between the read and the send. It is retryable, not a brick.
    expect(migrationBlockedReason(freshGlobal(), funded, balance - 1n, rent)).toBe('MigrationReserveTooLow');
  });

  it('blocks while paused and once complete', () => {
    expect(migrationBlockedReason(freshGlobal({ paused: true }), funded, balance, rent)).toBe('Paused');
    expect(migrationBlockedReason(freshGlobal(), { ...funded, complete: true }, balance, rent)).toBe('AlreadyComplete');
  });
});

describe('launchErrorName', () => {
  it('maps Anchor codes from 6000 in declaration order (errors.rs:5-48)', () => {
    expect(launchErrorName(6000)).toBe('Overflow');
    expect(launchErrorName(6004)).toBe('Paused');
    expect(launchErrorName(6005)).toBe('AlreadyComplete');
    expect(launchErrorName(6019)).toBe('AwaitingMigration');
    expect(LAUNCH_ERROR_NAMES.length).toBe(20);
  });

  it('returns null for a code outside the program rather than guessing', () => {
    expect(launchErrorName(5999)).toBeNull();
    expect(launchErrorName(6020)).toBeNull();
    expect(launchErrorName(0)).toBeNull();
  });
});
