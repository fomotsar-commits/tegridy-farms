// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { PublicKey } from '@solana/web3.js';
import { SOL_MINT, USDC_MINT } from '../../solana';
import { swapBaseInput } from '../cpswap/math';
import { isCreatorFeeOnInput } from '../cpswap/program';
import { decodeObservationState, recordSilence } from '../lp/ownPrice';
import { poolViewFrom, type PoolView } from '../lp/poolFinder';
import type { MintFacts, TokenSafety } from '../lp/tokenSafety';
import { LAUNCH, PROGRAM, buildPool, key, observationBytes, viewOf } from '../lp/testkit.fixture';
import { chooseRoute } from '../route';
import {
  LAUNCH_MAX_SILENCE_DIVISOR,
  ROUTE_FEE_NOT_IN_SOL,
  ROUTE_TOO_SMALL,
  UNTRADED_RESERVES_TOLERANCE_BPS,
  bestOwn,
  decideRoute,
  jupiterSideOf,
  launchPriceOk,
  launchPriceProblem,
  reservesMatchShares,
  routeExclusion,
  siteFeeIsInSol,
  routeQuote,
  routedTier,
  type OwnCandidate,
  type RouteQuote,
} from './ownRoute';

// The pure route layer (SPEC_S3 sections 3.5, 3.7, 3.8): what one of our pools pays
// after the site fee, which pools may compete, and ours against Jupiter.

const mint = key();
const NOW = 1_000n;

type Rates = { tradeFeeRate: bigint; protocolFeeRate: bigint; fundFeeRate: bigint; creatorFeeRate: bigint };
/** Mainnet's two fee tiers: 0 is the launch tier (0.25% + a 0.05% creator fee), 1 the public tier (1%). */
const TIER0: Rates = { tradeFeeRate: 2_500n, protocolFeeRate: 200_000n, fundFeeRate: 0n, creatorFeeRate: 500n };
const TIER1: Rates = { tradeFeeRate: 10_000n, protocolFeeRate: 160_000n, fundFeeRate: 0n, creatorFeeRate: 0n };

interface Spec {
  tier?: number;
  address?: PublicKey;
  origin?: PoolView['origin'];
  sol?: bigint;
  tok?: bigint;
  openTime?: bigint;
  status?: number;
  frozen?: boolean;
  history?: PoolView['history'];
  /** null = the pool's fee settings were not read. */
  rates?: Rates | null;
  /** The creator fee: off (the default), or on with the raw `creator_fee_on` mode; 'sol' = the SOL side, as a launch pool has it. */
  creatorFeeOn?: number | 'sol';
}

function poolView(o: Spec = {}): PoolView {
  const tier = o.tier ?? 1;
  const sol = o.sol ?? 85_000_000_000n;
  const tok = o.tok ?? 200_000_000_000_000n;
  const b = buildPool({ mint, configIndex: tier, address: o.address, solReserve: sol, tokenReserve: tok, openTime: o.openTime ?? 100n, status: o.status ?? 0 });
  const v = viewOf(b, { sol, tok, origin: o.origin ?? 'standard', frozen: o.frozen, history: o.history });
  const rates = o.rates === undefined ? (tier === 0 ? TIER0 : TIER1) : o.rates;
  const mode = o.creatorFeeOn === 'sol' ? (v.solIsToken0 ? 1 : 2) : o.creatorFeeOn;
  return {
    ...v,
    config: rates === null ? null : { ...v.config!, ...rates },
    snapshot: { ...v.snapshot, pool: { ...v.snapshot.pool, enableCreatorFee: mode !== undefined, creatorFeeOn: mode ?? 0 } },
  };
}

/** The same pool with other reserves: no addresses are derived again (the 10,000-case loop needs that). */
function withReserves(v: PoolView, sol: bigint, tok: bigint): PoolView {
  const [r0, r1] = v.solIsToken0 ? [sol, tok] : [tok, sol];
  return { ...v, solReserve: sol, tokenReserve: tok, snapshot: { ...v.snapshot, vault0Amount: r0, vault1Amount: r1, reserve0: r0, reserve1: r1 } };
}

/** r3's worked pool: 85 SOL against 200,000,000 tokens of 6 decimals. */
const launchPool = () => poolView({ tier: 0, origin: 'launch-pool', address: key(), creatorFeeOn: 'sol' });
const publicTier0 = () => poolView({ tier: 0 });
const tier1Pool = () => poolView({ tier: 1 });

const FACTS: MintFacts = {
  program: 'spl-token',
  mintAuthority: null,
  freezeAuthority: null,
  supply: 1_000_000_000_000_000n,
  decimals: 6,
  isInitialized: true,
  extensions: [],
  metadataPointer: null,
  tokenMetadata: null,
};
const OK_TOKEN: TokenSafety = { kind: 'read', mint: mint.toBase58(), verdict: 'ok', blocks: [], warnings: [], facts: FACTS, name: null, symbol: null, metadataSource: 'none' };
const eligible: Parameters<typeof routeExclusion>[1] = { cp: PROGRAM, chainNow: NOW, safety: OK_TOKEN, demoted: new Set<string>() };

const SOL_1 = 1_000_000_000n;

/** The pool's own maths for `amountIn`, straight from the port of the program, never through routeQuote. */
function poolOut(v: PoolView, side: 'buy' | 'sell', amountIn: bigint): bigint {
  const { pool } = v.snapshot;
  const inputIsSol = side === 'buy';
  const inputIsToken0 = inputIsSol === v.solIsToken0;
  const r = swapBaseInput({
    inputAmount: amountIn,
    inputVaultAmount: inputIsSol ? v.solReserve : v.tokenReserve,
    outputVaultAmount: inputIsSol ? v.tokenReserve : v.solReserve,
    tradeFeeRate: v.config!.tradeFeeRate,
    protocolFeeRate: v.config!.protocolFeeRate,
    fundFeeRate: v.config!.fundFeeRate,
    creatorFeeRate: pool.enableCreatorFee ? v.config!.creatorFeeRate : 0n,
    isCreatorFeeOnInput: isCreatorFeeOnInput(pool.creatorFeeOn, inputIsToken0)!,
  });
  return r!.outputAmount;
}
const fee50 = (x: bigint) => (x * 50n) / 10_000n;
const floorSlip = (x: bigint, s: bigint) => (x * (10_000n - s)) / 10_000n;

describe('T-RQ-01: a buy pays the site fee off the SOL going in', () => {
  it('the worked pool, 1 SOL: fee 5,000,000, 995,000,000 into the pool, on each kind of pool', () => {
    for (const [v, out] of [
      [launchPool(), 2_307_225_851_144n],
      [publicTier0(), 2_308_369_580_432n],
      [tier1Pool(), 2_291_212_251_432n],
    ] as const) {
      const q = routeQuote(v, 'buy', SOL_1, 50n, NOW)!;
      expect(q).toMatchObject({ side: 'buy', fee: 5_000_000n, swapIn: 995_000_000n, quoteOut: out, netExpected: out });
      expect(q.minOut).toBe(floorSlip(out, 50n));
      expect(q.netGuaranteed).toBe(q.minOut);
      expect(q.quote.poolAddress).toBe(v.address);
    }
  });

  // The fix test (SPEC_S3 5.3): today's route line ranks our pool on the bare pool quote.
  it('the candidate is the pool’s output for T - fee(T), never for T', () => {
    const v = tier1Pool();
    const q = routeQuote(v, 'buy', SOL_1, 50n, NOW)!;
    expect(q.netExpected).toBe(poolOut(v, 'buy', SOL_1 - fee50(SOL_1)));
    expect(q.netExpected).toBeLessThan(poolOut(v, 'buy', SOL_1));
  });

  it('the launch pool’s creator fee is in the quote, taken on the SOL going in', () => {
    const q = routeQuote(launchPool(), 'buy', SOL_1, 50n, NOW)!;
    expect(q.quote.creatorFeeOnInput).toBe(true);
    expect(q.quote.result).toMatchObject({ tradeFee: 2_487_500n, protocolFee: 497_500n, creatorFee: 497_500n });
  });
});

describe('T-RQ-02: a sell pays the site fee off the SOL coming out', () => {
  const TOKENS = 2_000_000_000_000n; // 2,000,000 tokens

  it('the worked pool, 2,000,000 tokens to the launch pool at 0.5% slippage', () => {
    const q = routeQuote(launchPool(), 'sell', TOKENS, 50n, NOW)!;
    expect(q).toMatchObject({
      side: 'sell',
      swapIn: TOKENS,
      quoteOut: 839_081_226n,
      netExpected: 834_885_820n,
      // The floor. (r3 printed 834,885,820, rounding the other way.)
      minOut: 834_885_819n,
      fee: 4_174_429n,
      netGuaranteed: 830_711_390n,
    });
    expect(q.quote.creatorFeeOnInput).toBe(false);
  });

  // The fix test (SPEC_S3 5.3).
  it('the candidate is gross - fee(gross): the fee Jupiter would take at the quote', () => {
    const v = tier1Pool();
    const gross = poolOut(v, 'sell', TOKENS);
    const q = routeQuote(v, 'sell', TOKENS, 50n, NOW)!;
    expect(q.quoteOut).toBe(gross);
    expect(q.netExpected).toBe(gross - fee50(gross));
  });

  it('the transaction’s fee is off the MINIMUM (the only output amount in its bytes), so it is never above 0.5% of what arrives', () => {
    for (const s of [50n, 100n, 300n, 500n]) {
      const q = routeQuote(tier1Pool(), 'sell', TOKENS, s, NOW)!;
      expect(q.fee).toBe(fee50(q.minOut));
      expect(q.fee).toBeLessThanOrEqual(fee50(q.quoteOut));
      expect(q.netGuaranteed).toBe(q.minOut - q.fee);
      // The small undercharge never earns ranking credit: the ranking number is below quoteOut - fee.
      expect(q.netExpected).toBeLessThanOrEqual(q.quoteOut - q.fee);
    }
  });
});

describe('T-RQ-03: the pool’s OWN fee settings are used', () => {
  it('a tier-1 pool is priced at 1%, not at the launch tier’s 0.25%', () => {
    const t1 = routeQuote(tier1Pool(), 'buy', SOL_1, 50n, NOW)!;
    const t0 = routeQuote(publicTier0(), 'buy', SOL_1, 50n, NOW)!;
    expect(t1.quote.result.tradeFee).toBe(9_950_000n);
    expect(t0.quote.result.tradeFee).toBe(2_487_500n);
    expect(t1.netExpected).toBeLessThan(t0.netExpected);
  });

  it('fee settings that were not read: no quote, never a default tier', () => {
    expect(routeQuote(poolView({ rates: null }), 'buy', SOL_1, 50n, NOW)).toBeNull();
    expect(routeQuote(poolView({ rates: null }), 'sell', SOL_1, 50n, NOW)).toBeNull();
  });
});

describe('T-RQ-04: the CHAIN’s clock is used, never this device’s', () => {
  it('a pool that opens one second after the chain’s time has no quote, though this device’s clock is decades later', () => {
    expect(BigInt(Math.floor(Date.now() / 1000))).toBeGreaterThan(NOW + 1n);
    expect(routeQuote(poolView({ openTime: NOW + 1n }), 'buy', SOL_1, 50n, NOW)).toBeNull();
    expect(routeQuote(poolView({ openTime: NOW + 1n }), 'sell', SOL_1, 50n, NOW)).toBeNull();
    expect(routeQuote(poolView({ openTime: NOW }), 'buy', SOL_1, 50n, NOW)).not.toBeNull();
  });

  it('and one that opens far in this device’s future is quoted when the chain says it is open', () => {
    const far = BigInt(Math.floor(Date.now() / 1000)) + 10n ** 9n;
    expect(routeQuote(poolView({ openTime: far }), 'buy', SOL_1, 50n, far)).not.toBeNull();
  });
});

describe('T-RQ-05..07: no quote when anything rounds to nothing', () => {
  it('T-RQ-05: the output is 0', () => {
    const v = poolView({ sol: 85_000_000_000n, tok: 1_000n });
    expect(poolOut(v, 'buy', 199n)).toBe(0n);
    expect(routeQuote(v, 'buy', 200n, 0n, NOW)).toBeNull();
  });

  it('T-RQ-06: the minimum is 0 (an output of 1 with any slippage)', () => {
    const v = poolView({ sol: 1_000_000_000n, tok: 5n });
    const T = 300_000_000n;
    expect(poolOut(v, 'buy', T - fee50(T))).toBe(1n);
    expect(routeQuote(v, 'buy', T, 50n, NOW)).toBeNull();
    // With no slippage the minimum is the 1, and it quotes.
    expect(routeQuote(v, 'buy', T, 0n, NOW)).toMatchObject({ quoteOut: 1n, minOut: 1n });
  });

  it('T-RQ-07: the site fee is 0. A buy of 199 lamports; a sell whose minimum is under 200', () => {
    const deep = poolView({ sol: 1_000_000_000n, tok: 1_000_000_000_000_000n });
    expect(poolOut(deep, 'buy', 199n)).toBeGreaterThan(0n);
    expect(routeQuote(deep, 'buy', 199n, 50n, NOW)).toBeNull();
    expect(routeQuote(deep, 'buy', 200n, 50n, NOW)).toMatchObject({ fee: 1n, swapIn: 199n });

    const v = poolView({ sol: 1_000_000_000n, tok: 1_000_000_000n });
    const small = 200n;
    expect(floorSlip(poolOut(v, 'sell', small), 50n)).toBeLessThan(200n);
    expect(floorSlip(poolOut(v, 'sell', small), 50n)).toBeGreaterThan(0n);
    expect(routeQuote(v, 'sell', small, 50n, NOW)).toBeNull();
    const enough = 1_000n;
    expect(floorSlip(poolOut(v, 'sell', enough), 50n)).toBeGreaterThanOrEqual(200n);
    expect(routeQuote(v, 'sell', enough, 50n, NOW)).not.toBeNull();
  });

  it('an amount that is zero, negative or beyond a u64; a slippage of 100% or below 0', () => {
    const v = tier1Pool();
    for (const amount of [0n, -1n, 1n << 64n]) expect(routeQuote(v, 'buy', amount, 50n, NOW)).toBeNull();
    for (const s of [10_000n, 10_001n, -1n]) expect(routeQuote(v, 'buy', SOL_1, s, NOW)).toBeNull();
  });

  it('whatever the pool program would refuse: swaps switched off, a fee mode it cannot price', () => {
    expect(routeQuote(poolView({ status: 4 }), 'buy', SOL_1, 50n, NOW)).toBeNull();
    expect(routeQuote(poolView({ creatorFeeOn: 3 }), 'buy', SOL_1, 50n, NOW)).toBeNull();
  });
});

describe('routedTier', () => {
  it('names tier 0 and tier 1 by their derived addresses, and nothing else', () => {
    expect(routedTier(PROGRAM, publicTier0().snapshot.pool.ammConfig)).toBe(0);
    expect(routedTier(PROGRAM, tier1Pool().snapshot.pool.ammConfig)).toBe(1);
    expect(routedTier(PROGRAM, poolView({ tier: 2 }).snapshot.pool.ammConfig)).toBeNull();
    expect(routedTier(PROGRAM, key().toBase58())).toBeNull();
    // Another pool program's tier 1 is not ours.
    expect(routedTier(LAUNCH, tier1Pool().snapshot.pool.ammConfig)).toBeNull();
  });
});

describe('T-ELIG: which pools may compete (each fact read from the chain; unread excludes)', () => {
  it('a healthy pool on either tier, at any kind of address, is eligible', () => {
    for (const v of [tier1Pool(), publicTier0(), launchPool(), poolView({ origin: 'other', address: key() })]) {
      expect(routeExclusion(v, eligible)).toBeNull();
    }
  });

  it('T-ELIG-01: an account that is not one of our TOKEN/SOL pools never becomes a pool to route to', () => {
    const b = buildPool({ mint, configIndex: 1, solReserve: 1n, tokenReserve: 1n });
    const acc = (a: string) => {
      const x = b.accounts[a];
      return x ? { address: a, owner: x.owner, data: x.data, lamports: 1 } : null;
    };
    const pool = b.accounts[b.address.toBase58()]!;
    const look = (p: { owner: string; data: Uint8Array } | null) =>
      poolViewFrom({
        address: b.address.toBase58(),
        pool: p ? { address: b.address.toBase58(), owner: p.owner, data: p.data, lamports: 1 } : null,
        vault0: null,
        vault1: null,
        config: acc(b.config.toBase58()),
        observation: null,
        opts: { programId: PROGRAM, launchProgramId: LAUNCH },
      }).kind;
    expect(look(null)).toBe('absent');
    expect(look({ owner: LAUNCH.toBase58(), data: pool.data })).toBe('not-a-pool');
    expect(look({ owner: pool.owner, data: new Uint8Array(pool.data.length) })).toBe('not-a-pool');
    // A real pool whose vaults could not be read is unread, not a pool.
    expect(look(pool)).toBe('unread');
  });

  it('T-ELIG-02: the swap bit is set', () => {
    for (const status of [4, 5, 6, 7, 0b1100]) {
      expect(routeExclusion(poolView({ status }), eligible)).toBe('swaps are switched off on it');
    }
  });

  it('T-ELIG-03: any other status bit is set, including bits this site does not know', () => {
    for (const status of [1, 2, 3, 8, 0x80, 0b1000_0001]) {
      expect(routeExclusion(poolView({ status }), eligible)).toBe('the pool program’s admin has changed its settings');
    }
  });

  it('T-ELIG-04: the chain clock is unread (never "assume it is open")', () => {
    expect(routeExclusion(tier1Pool(), { ...eligible, chainNow: null })).toBe('the network clock could not be read');
  });

  it('T-ELIG-05: it opens after the chain’s time; at exactly its open time it is open', () => {
    expect(routeExclusion(poolView({ openTime: NOW + 1n }), eligible)).toBe('it does not open for trading until 1970-01-01 00:16:41 UTC');
    expect(routeExclusion(poolView({ openTime: NOW }), eligible)).toBeNull();
    // A stranger's squat on the standard address: an open time beyond any calendar date.
    expect(routeExclusion(poolView({ openTime: (1n << 64n) - 1n }), eligible)).toMatch(/^it does not open for trading until unix time 18446744073709551615/);
  });

  it('T-ELIG-06: a vault is frozen', () => {
    expect(routeExclusion(poolView({ frozen: true }), eligible)).toBe('one of its vaults is frozen by the token’s issuer');
  });

  it('T-ELIG-07: either tradable side is 0', () => {
    expect(routeExclusion(poolView({ sol: 0n }), eligible)).toBe('it is empty on one side');
    expect(routeExclusion(poolView({ tok: 0n }), eligible)).toBe('it is empty on one side');
  });

  it('T-ELIG-08: its fee settings are unread', () => {
    expect(routeExclusion(poolView({ rates: null }), eligible)).toBe('its fee settings could not be read');
  });

  it('T-ELIG-09: its fee tier is not tier 0 or tier 1', () => {
    expect(routeExclusion(poolView({ tier: 2 }), eligible)).toBe('it is on a fee tier this site does not route to');
    // The right tier of ANOTHER pool program is not a tier of this one.
    expect(routeExclusion(tier1Pool(), { ...eligible, cp: LAUNCH })).toBe('it is on a fee tier this site does not route to');
  });

  it('T-ELIG-10: a creator-fee mode that is not 0, 1 or 2', () => {
    for (const mode of [3, 4, 255]) {
      expect(routeExclusion(poolView({ creatorFeeOn: mode }), eligible)).toBe('it uses a fee mode this site cannot price');
    }
    for (const mode of [0, 1, 2]) expect(routeExclusion(poolView({ creatorFeeOn: mode }), eligible)).toBeNull();
  });

  it('T-ELIG-11: the token is unread, absent, blocked, or copies a well-known name', () => {
    const m = mint.toBase58();
    const unread = 'We could not read the token, so we cannot say whether it is safe.';
    expect(routeExclusion(tier1Pool(), { ...eligible, safety: null })).toBe(unread);
    expect(routeExclusion(tier1Pool(), { ...eligible, safety: { kind: 'unread', mint: m, detail: 'HTTP 502' } })).toBe(unread);
    expect(routeExclusion(tier1Pool(), { ...eligible, safety: { kind: 'absent', mint: m } })).toBe('The token does not exist.');
    const blocked = { ...OK_TOKEN, verdict: 'blocked', blocks: [{ code: 'freeze-authority', text: 'x' }] } as TokenSafety;
    expect(routeExclusion(tier1Pool(), { ...eligible, safety: blocked })).toBe('This token is blocked on this site (see why above).');
    const copy = { ...OK_TOKEN, verdict: 'warn', warnings: [{ code: 'copies-known-name', text: 'x' }] } as TokenSafety;
    expect(routeExclusion(tier1Pool(), { ...eligible, safety: copy })).toBe(
      'It calls itself by a well-known token’s name but has a different mint. This site does not send trades to pools of copies.',
    );
  });

  it('a token that only carries warnings (a live mint authority) is NOT excluded: it is the same token on either route', () => {
    const warned = { ...OK_TOKEN, verdict: 'warn', warnings: [{ code: 'mint-authority', text: 'x' }] } as TokenSafety;
    expect(routeExclusion(tier1Pool(), { ...eligible, safety: warned })).toBeNull();
  });

  it('T-ELIG-12: a swap through it landed and reverted on price this session', () => {
    const v = tier1Pool();
    expect(routeExclusion(v, { ...eligible, demoted: new Set([v.address]) })).toBe('a swap through it just failed on price, so it is skipped for now');
    // Another pool's demotion does not touch this one.
    expect(routeExclusion(v, { ...eligible, demoted: new Set([key().toBase58()]) })).toBeNull();
  });

  it('T-ELIG-13: a pool that cannot take this amount is eligible but has no quote; the caller says so', () => {
    const v = poolView({ sol: 85_000_000_000n, tok: 1_000n });
    expect(routeExclusion(v, eligible)).toBeNull();
    expect(routeQuote(v, 'buy', 200n, 50n, NOW)).toBeNull();
    expect(ROUTE_TOO_SMALL).toBe('it can’t take an amount this size');
  });

  it('the first reason is the one given, in the table’s order', () => {
    const everything = poolView({ status: 7, openTime: NOW + 1n, frozen: true, sol: 0n, rates: null, tier: 2, creatorFeeOn: 3 });
    const a = { cp: PROGRAM, chainNow: null, safety: null, demoted: new Set([everything.address]) };
    expect(routeExclusion(everything, a)).toBe('swaps are switched off on it');
    const noSwapBit = poolView({ status: 3, openTime: NOW + 1n, frozen: true });
    expect(routeExclusion(noSwapBit, { ...a, demoted: new Set([noSwapBit.address]) })).toBe('the pool program’s admin has changed its settings');
  });

  it('no exclusion sentence carries an em dash', () => {
    const cases: [PoolView, Partial<typeof eligible>][] = [
      [poolView({ status: 4 }), {}],
      [poolView({ status: 1 }), {}],
      [tier1Pool(), { chainNow: null }],
      [poolView({ openTime: NOW + 1n }), {}],
      [poolView({ frozen: true }), {}],
      [poolView({ sol: 0n }), {}],
      [poolView({ rates: null }), {}],
      [poolView({ tier: 2 }), {}],
      [poolView({ creatorFeeOn: 3 }), {}],
      [tier1Pool(), { safety: null }],
    ];
    for (const [v, over] of cases) {
      const reason = routeExclusion(v, { ...eligible, ...over });
      expect(reason).not.toBeNull();
      expect(reason).not.toMatch(/[–—]/);
    }
    expect(ROUTE_TOO_SMALL).not.toMatch(/[–—]/);
  });
});

/** A candidate with a chosen ranking number (bestOwn and decideRoute read nothing else of the quote). */
function cand(view: PoolView, netExpected: bigint): OwnCandidate {
  const q = routeQuote(tier1Pool(), 'buy', SOL_1, 50n, NOW)!;
  return { view, q: { ...q, netExpected } };
}

describe('T-BEST-01: one pool per swap, the one that pays most', () => {
  it('a better-priced one-off pool beats a deeper standard pool', () => {
    const deep = poolView({ sol: 100_000_000_000n, tok: 200_000_000_000n });
    const oneOff = poolView({ origin: 'other', address: key(), sol: 10_000_000_000n, tok: 30_000_000_000n });
    const amount = 100_000_000n;
    const c = [deep, oneOff].map((view) => ({ view, q: routeQuote(view, 'buy', amount, 50n, NOW)! }));
    expect(c[1]!.q.netExpected).toBeGreaterThan(c[0]!.q.netExpected);
    expect(bestOwn(c)!.view.address).toBe(oneOff.address);
    expect(bestOwn([...c].reverse())!.view.address).toBe(oneOff.address);
  });

  it('an exact tie: the launch pool; then the larger SOL side; then the lower address. Never the read order', () => {
    const launch = poolView({ origin: 'launch-pool', address: key(), sol: 1_000_000_000n, tok: 5_000_000_000n });
    // The bigger pool is given the HIGHER address, so the address rule alone would pick the other one.
    const [lowKey, highKey] = [key(), key()].sort((x, y) => (x.toBase58() < y.toBase58() ? -1 : 1)) as [PublicKey, PublicKey];
    const big = poolView({ origin: 'other', address: highKey, sol: 9_000_000_000n, tok: 5_000_000_000n });
    const small = poolView({ origin: 'other', address: lowKey, sol: 2_000_000_000n, tok: 5_000_000_000n });
    expect(small.address < big.address).toBe(true);
    const twin = poolView({ origin: 'other', address: key(), sol: 2_000_000_000n, tok: 5_000_000_000n });
    const both = (xs: PoolView[]) => [xs, [...xs].reverse()].map((order) => bestOwn(order.map((v) => cand(v, 777n)))!.view.address);

    expect(both([launch, big, small])).toEqual([launch.address, launch.address]);
    expect(both([big, small])).toEqual([big.address, big.address]);
    const lower = small.address < twin.address ? small.address : twin.address;
    expect(both([small, twin])).toEqual([lower, lower]);
    // One unit more beats every tie-break.
    expect(bestOwn([cand(launch, 777n), cand(twin, 778n)])!.view.address).toBe(twin.address);
  });

  it('no candidates: no pool', () => {
    expect(bestOwn([])).toBeNull();
  });
});

describe('launchPriceOk: may the launch pool run when Jupiter has no route', () => {
  // 10 SOL against 1,000 tokens of 6 decimals: 10 lamports per token base unit.
  const SOL = 10n * 10n ** 9n;
  const TOK = 1_000n * 10n ** 6n;
  // The pool program opens a pool with lp_supply = floor(sqrt(side0 x side1)): 3,162,277,660 here.
  const SHARES = 3_162_277_660n;
  const b = buildPool({ mint, configIndex: 0, address: key(), solReserve: SOL, tokenReserve: TOK, openTime: 100n, lpSupply: SHARES });
  const tokenIs0 = viewOf(b, { sol: SOL, tok: TOK }).solIsToken0 === false;
  const Q32 = 1n << 32n;
  /**
   * A price record from 1,000 to 4,600 at one price, a slot every `stepSecs`. The default
   * (a trade a minute) is a steadily traded pool; 3,600 is two slots an hour apart: one
   * swap, an hour of nothing, one swap.
   */
  function history(solPerBaseX32: bigint, o: { initialized?: boolean; stepSecs?: bigint } = {}): PoolView['history'] {
    const step = o.stepSecs ?? 60n;
    const obs: [number, bigint, bigint, bigint][] = [];
    for (let t = 1_000n; t <= 4_600n; t += step) {
      const own = solPerBaseX32 * (t - 1_000n);
      const other = ((Q32 * Q32) / solPerBaseX32) * (t - 1_000n);
      obs.push([obs.length, t, ...(tokenIs0 ? ([own, other] as const) : ([other, own] as const))]);
    }
    const data = observationBytes({ pool: b.address, initialized: o.initialized, index: obs.length - 1, lastUpdate: 4_600n, obs });
    return { kind: 'ok', obs: decodeObservationState(data)! };
  }
  const launch = (h: PoolView['history'], origin: PoolView['origin'] = 'launch-pool', r: { sol?: bigint; tok?: bigint } = {}) =>
    viewOf(b, { sol: r.sol ?? SOL, tok: r.tok ?? TOK, origin, history: h });
  const at = { chainNow: 4_610n, safety: OK_TOKEN };
  const never = history(10n * Q32, { initialized: false });

  it('it traded steadily and its price agrees with its own half-hour average: yes', () => {
    expect(launchPriceProblem(launch(history(10n * Q32)), at)).toBeNull();
    expect(launchPriceOk(launch(history(10n * Q32)), at)).toBe(true);
  });

  it('it has never traded and still holds what its shares account for (the price the launch program set): yes', () => {
    expect(launchPriceProblem(launch(never), at)).toBeNull();
    expect(launchPriceOk(launch(never), at)).toBe(true);
  });

  // funds-1 (dark review). A pool's reserves are its vaults' live balances, and its price
  // record is written only by swaps. Tokens or SOL sent STRAIGHT into a vault move the
  // price and leave no mark, and both "never traded" and "agrees with its average"
  // used to pass on the moved price.
  describe('a price moved without a trade (a transfer straight into a vault) is never trusted', () => {
    it('never traded, tokens sent into the token vault: the price fell by a third and no swap recorded it -> no', () => {
      const pushed = launch(never, 'launch-pool', { tok: (TOK * 3n) / 2n });
      expect(launchPriceProblem(pushed, at)).toBe('reserves-moved');
      expect(launchPriceOk(pushed, at)).toBe(false);
    });

    it('never traded, wrapped SOL sent into the SOL vault -> no', () => {
      expect(launchPriceProblem(launch(never, 'launch-pool', { sol: SOL * 2n }), at)).toBe('reserves-moved');
    });

    it('the tolerance is 10 bps of the product: rounding dust passes, the first unit past it does not', () => {
      expect(UNTRADED_RESERVES_TOLERANCE_BPS).toBe(10n);
      expect(reservesMatchShares(launch(never, 'launch-pool', { tok: TOK + 1n }))).toBe(true);
      // The largest token side with sol x tok x 10,000 <= shares^2 x 10,010, and one more.
      const most = (SHARES * SHARES * 10_010n) / (SOL * 10_000n);
      expect(reservesMatchShares(launch(never, 'launch-pool', { tok: most }))).toBe(true);
      expect(reservesMatchShares(launch(never, 'launch-pool', { tok: most + 1n }))).toBe(false);
    });

    it('reserves BELOW the shares, a pool with no shares, an empty side: a state the pool program never makes is unread, not fine', () => {
      expect(reservesMatchShares(launch(never, 'launch-pool', { tok: TOK - TOK / 1_000n }))).toBe(false);
      expect(reservesMatchShares(launch(never, 'launch-pool', { tok: 0n }))).toBe(false);
      const noShares = viewOf(buildPool({ mint, configIndex: 0, address: key(), solReserve: SOL, tokenReserve: TOK, lpSupply: 0n }), { sol: SOL, tok: TOK, origin: 'launch-pool', history: never });
      expect(reservesMatchShares(noShares)).toBe(false);
      expect(launchPriceOk(noShares, at)).toBe(false);
    });

    it('a deposit or a withdrawal moves both sides and the shares together, and still passes', () => {
      const doubled = viewOf(buildPool({ mint, configIndex: 0, address: key(), solReserve: SOL * 2n, tokenReserve: TOK * 2n, lpSupply: SHARES * 2n }), { sol: SOL * 2n, tok: TOK * 2n, origin: 'launch-pool', history: never });
      expect(launchPriceProblem(doubled, at)).toBeNull();
    });

    it('traded, then quiet for an hour, then tokens sent in: "its average" is only the price right now compared with itself -> no', () => {
      // The record ends at 4,600; it is now 8,200 and the pool holds twice the tokens.
      const pushed = launch(history(10n * Q32), 'launch-pool', { tok: TOK * 2n });
      const later = { ...at, chainNow: 8_200n };
      expect(launchPriceProblem(pushed, later)).toBe('too-quiet');
      // And the honest pool in the same quiet hour is refused too: silence is not evidence either way.
      expect(launchPriceProblem(launch(history(10n * Q32)), later)).toBe('too-quiet');
    });

    it('a quiet hour, tokens sent in, then one dust swap: that swap writes the moved price over the whole hour -> no', () => {
      // Two slots an hour apart, the whole hour credited at 5 (the moved price), and the pool at 5.
      const pushed = launch(history(5n * Q32, { stepSecs: 3_600n }), 'launch-pool', { tok: TOK * 2n });
      expect(launchPriceProblem(pushed, at)).toBe('too-quiet');
      expect(launchPriceOk(pushed, at)).toBe(false);
    });

    it('the longest stretch with no recorded swap may be a sixth of the window, and not a second more', () => {
      expect(LAUNCH_MAX_SILENCE_DIVISOR).toBe(6n);
      // Last swap at 4,600. At 4,900 the window starts at the slot at 3,100: 1,800 s, of which 300 are silent.
      expect(launchPriceProblem(launch(history(10n * Q32)), { ...at, chainNow: 4_900n })).toBeNull();
      // One second later: 301 s of 1,801.
      expect(launchPriceProblem(launch(history(10n * Q32)), { ...at, chainNow: 4_901n })).toBe('too-quiet');
      // A silent stretch in the MIDDLE of the window counts the same as one at its end.
      const gapInside = history(10n * Q32, { stepSecs: 400n });
      expect(launchPriceProblem(launch(gapInside), at)).toBe('too-quiet');
    });
  });

  it('its price is double its own average (someone just pushed it with a swap): no', () => {
    expect(launchPriceProblem(launch(history(5n * Q32)), at)).toBe('disagrees');
    expect(launchPriceOk(launch(history(5n * Q32)), at)).toBe(false);
  });

  it('anything unread is a no: its price record, the clock, the token, the token’s decimals', () => {
    expect(launchPriceOk(launch({ kind: 'not-read' }), at)).toBe(false);
    expect(launchPriceOk(launch({ kind: 'unread', detail: 'its price record account is missing' }), at)).toBe(false);
    expect(launchPriceOk(launch(history(10n * Q32)), { ...at, chainNow: null })).toBe(false);
    expect(launchPriceOk(launch(history(10n * Q32)), { ...at, safety: null })).toBe(false);
    expect(launchPriceOk(launch(history(10n * Q32)), { ...at, safety: { kind: 'unread', mint: mint.toBase58(), detail: 'x' } })).toBe(false);
    expect(launchPriceOk(launch(history(10n * Q32)), { ...at, safety: { ...OK_TOKEN, facts: null } as TokenSafety })).toBe(false);
  });

  it('a blocked token: no', () => {
    const blocked = { ...OK_TOKEN, verdict: 'blocked', blocks: [{ code: 'freeze-authority', text: 'x' }] } as TokenSafety;
    expect(launchPriceOk(launch(history(10n * Q32)), { ...at, safety: blocked })).toBe(false);
  });

  it('a pool anyone could open is never trusted on its own history, however well it agrees', () => {
    expect(launchPriceOk(launch(history(10n * Q32), 'standard'), at)).toBe(false);
    expect(launchPriceOk(launch(history(10n * Q32), 'other'), at)).toBe(false);
    expect(launchPriceProblem(launch(never, 'standard'), at)).toBe('not-launch-pool');
  });
});

describe('recordSilence: the longest stretch in the average’s window with nothing recorded', () => {
  const pool = key();
  const state = (obs: [number, bigint, bigint, bigint][], lastUpdate: bigint, initialized = true) =>
    decodeObservationState(observationBytes({ pool, initialized, index: obs.length - 1, lastUpdate, obs }))!;

  it('counts slot to slot, the newest slot to the last update, and the last update to now', () => {
    const s = state([[0, 1_000n, 0n, 0n], [1, 1_100n, 1n, 1n], [2, 1_700n, 2n, 2n]], 1_710n);
    // From 1,000 (the oldest: nothing is 30 minutes old yet) to 2,000: the gaps are 100, 600, 10, 290.
    expect(recordSilence(s, 2_000n)).toEqual({ windowSecs: 1_000n, longestSecs: 600n });
    // Much later, the window starts at the newest slot and all of it is silence.
    expect(recordSilence(s, 10_000n)).toEqual({ windowSecs: 8_300n, longestSecs: 8_290n });
  });

  it('a record that cannot say is null, never "no silence": never traded, empty, or later than the clock', () => {
    expect(recordSilence(state([[0, 1_000n, 0n, 0n]], 1_000n, false), 2_000n)).toBeNull();
    expect(recordSilence(state([[0, 0n, 0n, 0n]], 0n), 2_000n)).toBeNull();
    expect(recordSilence(state([[0, 1_000n, 0n, 0n]], 3_000n), 2_000n)).toBeNull();
  });
});

describe('parity-2: a pair whose site fee Jupiter takes in USDC is never ours', () => {
  const usdc = new PublicKey(USDC_MINT);

  it('TOKEN/SOL takes the fee in SOL; USDC/SOL takes it in USDC, in either direction', () => {
    expect(siteFeeIsInSol(mint.toBase58())).toBe(true);
    expect(siteFeeIsInSol(USDC_MINT)).toBe(false);
  });

  it('a USDC/SOL pool on our program, healthy in every other way, is excluded, and that is the first reason', () => {
    const b = buildPool({ mint: usdc, configIndex: 1, solReserve: 85_000_000_000n, tokenReserve: 20_000_000_000n, openTime: 100n });
    const v = viewOf(b, { sol: 85_000_000_000n, tok: 20_000_000_000n, origin: 'standard' });
    const safe: TokenSafety = { ...OK_TOKEN, mint: USDC_MINT };
    expect(routeExclusion(v, { ...eligible, safety: safe })).toBe(ROUTE_FEE_NOT_IN_SOL);
    expect(ROUTE_FEE_NOT_IN_SOL).toBe('the site fee on this pair is taken in USDC, not in SOL');
    // The same pool with any other token is eligible: the fee side is the ONLY thing refused here.
    expect(routeExclusion(tier1Pool(), eligible)).toBeNull();
    // Even with every other fault present, this is the reason said.
    const broken = { ...v, vaultsFrozen: true, config: null };
    expect(routeExclusion(broken, { ...eligible, chainNow: null, safety: null })).toBe(ROUTE_FEE_NOT_IN_SOL);
  });
});

describe('parity-1: what the route rule is told about Jupiter (jupiterSideOf)', () => {
  const SOL = SOL_MINT;
  const TOKEN = mint.toBase58();
  const asked = { inputMint: SOL, outputMint: TOKEN, amount: '1000000000' };
  // A quote that proves its outAmount is after our fee: one leg paying 2,000,000, fee 10,000, out 1,990,000.
  const proven = {
    kind: 'quote' as const,
    feeBpsSent: 50,
    quote: {
      inputMint: SOL, outputMint: TOKEN, inAmount: '1000000000', outAmount: '1990000', otherAmountThreshold: '1980050', swapMode: 'ExactIn',
      slippageBps: 50, priceImpactPct: '0', platformFee: { amount: '10000', feeBps: 50 },
      routePlan: [{ swapInfo: { outputMint: TOKEN, outAmount: '2000000' } }],
    },
  };

  it('a proven fee-bearing quote is a number our pool may be ranked against', () => {
    expect(jupiterSideOf(proven, asked, { feeWaivedOnPair: false })).toEqual({ kind: 'net', net: 1_990_000n });
  });

  it('the SAME quote on a pair where Jupiter’s trade goes out with no fee is not: Jupiter runs, ours does not compete', () => {
    const side = jupiterSideOf(proven, asked, { feeWaivedOnPair: true });
    expect(side).toEqual({ kind: 'meaning-unread' });
    // A pool that would "win" against the fee-bearing number by a hair does not get the trade.
    const c = cand(tier1Pool(), 1_990_001n);
    expect(decideRoute({ best: c, launch: null, jupiter: side })).toMatchObject({ route: 'jupiter', why: 'meaning-unread' });
    expect(decideRoute({ best: c, launch: null, jupiter: jupiterSideOf(proven, asked, { feeWaivedOnPair: false }) }).route).toBe('own');
  });

  it('unread, no-route and an unproven quote pass through as themselves', () => {
    expect(jupiterSideOf({ kind: 'unread', detail: 'x' }, asked, { feeWaivedOnPair: false })).toEqual({ kind: 'unread' });
    expect(jupiterSideOf({ kind: 'no-route' }, asked, { feeWaivedOnPair: true })).toEqual({ kind: 'no-route' });
    expect(jupiterSideOf({ ...proven, feeBpsSent: null }, asked, { feeWaivedOnPair: false })).toEqual({ kind: 'meaning-unread' });
  });
});

describe('T-DEC-ROUTE: ours against Jupiter', () => {
  const N = 1_000_000n;
  const ours = () => cand(tier1Pool(), N);
  const net = (n: bigint) => ({ kind: 'net' as const, net: n });

  it('P-03’s reason, restated: chooseRoute handed our pool alone picks it, so decideRoute must never do that', () => {
    expect(chooseRoute([{ venue: 'own-pool', outAmount: N, label: 'our pool' }]).chosen?.venue).toBe('own-pool');
  });

  it('T-DEC-ROUTE-01: Jupiter unread, and a pool that would pay far more: no route at all', () => {
    const best = cand(tier1Pool(), N * 1_000n);
    expect(decideRoute({ best, launch: null, jupiter: { kind: 'unread' } })).toEqual({ route: 'none', why: 'jupiter-unread' });
    // Even the launch pool with a good price does not run on an unread Jupiter.
    const launch = { ...cand(launchPool(), N * 1_000n), priceOk: true };
    expect(decideRoute({ best: launch, launch, jupiter: { kind: 'unread' } })).toEqual({ route: 'none', why: 'jupiter-unread' });
  });

  it('a Jupiter "net" that is not a positive amount is unread, not a price our pool beats', () => {
    for (const n of [0n, -1n]) {
      expect(decideRoute({ best: ours(), launch: null, jupiter: net(n) })).toEqual({ route: 'none', why: 'jupiter-unread' });
    }
  });

  it('T-DEC-ROUTE-02: Jupiter’s number is not proven to be after our fee: Jupiter runs, ours does not compete', () => {
    const best = cand(tier1Pool(), N * 1_000n);
    expect(decideRoute({ best, launch: null, jupiter: { kind: 'meaning-unread' } })).toEqual({ route: 'jupiter', why: 'meaning-unread', own: best, edge: null });
    expect(decideRoute({ best: null, launch: null, jupiter: { kind: 'meaning-unread' } })).toEqual({ route: 'jupiter', why: 'meaning-unread', own: null, edge: null });
  });

  it('T-DEC-ROUTE-03: ours one unit below Jupiter: Jupiter', () => {
    const best = ours();
    const d = decideRoute({ best, launch: null, jupiter: net(N + 1n) });
    expect(d).toMatchObject({ route: 'jupiter', why: 'pays-more', own: best });
    expect(d.route === 'jupiter' && d.edge).toBeCloseTo(1e-6, 12);
  });

  it('T-DEC-ROUTE-04: an exact tie is ours', () => {
    const best = ours();
    expect(decideRoute({ best, launch: null, jupiter: net(N) })).toEqual({ route: 'own', own: best, versus: N, edge: 0, tie: true });
  });

  it('T-DEC-ROUTE-05: ours one unit above Jupiter: ours, and not called a tie', () => {
    const best = ours();
    const d = decideRoute({ best, launch: null, jupiter: net(N - 1n) });
    expect(d).toMatchObject({ route: 'own', own: best, versus: N - 1n, tie: false });
    expect(d.route === 'own' && d.edge).toBeGreaterThan(0);
  });

  it('there is no band: a pool 0.0001% short of Jupiter loses, and one far better still wins', () => {
    expect(decideRoute({ best: cand(tier1Pool(), 999_999_999n), launch: null, jupiter: net(1_000_000_000n) }).route).toBe('jupiter');
    expect(decideRoute({ best: cand(tier1Pool(), N * 5n), launch: null, jupiter: net(N) })).toMatchObject({ route: 'own', edge: 4 });
  });

  it('Jupiter quoted and no pool of ours is eligible or can quote: Jupiter', () => {
    expect(decideRoute({ best: null, launch: null, jupiter: net(N) })).toEqual({ route: 'jupiter', why: 'no-eligible-pool', own: null, edge: null });
  });

  it('T-DEC-ROUTE-06: Jupiter has no route and the launch pool’s price agrees: the launch pool', () => {
    const c = cand(launchPool(), N);
    expect(decideRoute({ best: c, launch: { ...c, priceOk: true }, jupiter: { kind: 'no-route' } })).toEqual({ route: 'own', own: c, versus: null, edge: null, tie: false });
    // Even when another pool of ours would pay more: with no outside price, only the launch pool runs.
    const better = cand(tier1Pool(), N * 2n);
    const d = decideRoute({ best: better, launch: { ...c, priceOk: true }, jupiter: { kind: 'no-route' } });
    expect(d.route === 'own' && d.own.view.address).toBe(c.view.address);
  });

  it('T-DEC-ROUTE-07: Jupiter has no route and the launch pool’s price does not agree: no route', () => {
    const c = cand(launchPool(), N);
    expect(decideRoute({ best: c, launch: { ...c, priceOk: false }, jupiter: { kind: 'no-route' } })).toEqual({ route: 'none', why: 'no-route' });
  });

  it('T-DEC-ROUTE-08: Jupiter has no route and our only pool is a tier-1 pool anyone could open: no route', () => {
    const c = cand(tier1Pool(), N);
    expect(decideRoute({ best: c, launch: null, jupiter: { kind: 'no-route' } })).toEqual({ route: 'none', why: 'no-route' });
    // And a caller that hands it in as "the launch pool" by mistake is not believed.
    expect(decideRoute({ best: c, launch: { ...c, priceOk: true }, jupiter: { kind: 'no-route' } })).toEqual({ route: 'none', why: 'no-route' });
    const other = cand(poolView({ origin: 'other', address: key() }), N);
    expect(decideRoute({ best: other, launch: { ...other, priceOk: true }, jupiter: { kind: 'no-route' } })).toEqual({ route: 'none', why: 'no-route' });
  });

  it('with a Jupiter price, the launch pool gets no special treatment: it must still pay at least as much', () => {
    const c = cand(launchPool(), N);
    expect(decideRoute({ best: c, launch: { ...c, priceOk: true }, jupiter: net(N + 1n) }).route).toBe('jupiter');
  });
});

// T-INV. When the route is ours, the least the trader can end up with is at or above
// Jupiter's own minimum for the price it lost with, less 2 raw units. Jupiter's
// otherAmountThreshold rounds UP (measured live); ours floors, and a sell floors the fee
// too: the 2 is exactly those floors (1 on a buy, 2 on a sell).
//
// The guaranteed amount is recomputed HERE from the pool's maths and the transaction's
// shape (a buy swaps T - fee(T); a sell pays fee(minimum) out of the minimum), never
// read back from routeQuote alone, so a quote that ranks on one number while the
// transaction would deliver another breaks this test.
describe('T-INV: routing to our pool never lowers the trader’s worst case below Jupiter’s', () => {
  /** mulberry32: a small seeded generator, so the 10,000 cases are the same on every run. */
  function rng(seed: number): () => number {
    let a = seed >>> 0;
    return () => {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  const SLIPPAGES = [50n, 100n, 300n, 500n] as const;

  it('10,000 seeded cases: both tiers, every creator-fee mode, both sides, J drawn around ours', () => {
    const r = rng(20261003);
    const int = (lo: number, hi: number) => BigInt(Math.floor(lo + r() * (hi - lo)));
    /** Log-uniform between 10^lo and 10^hi. */
    const mag = (lo: number, hi: number) => BigInt(Math.floor(10 ** (lo + r() * (hi - lo))));
    const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(r() * xs.length)]!;

    const bases = [0, 1].flatMap((tier) =>
      [undefined, 0, 1, 2].map((creatorFeeOn) => poolView({ tier, creatorFeeOn, origin: 'other', address: key() })),
    );
    // A tier-0 base whose creator fee is on must actually charge one, or the modes are not exercised.
    expect(bases.some((v) => v.snapshot.pool.enableCreatorFee && v.config!.creatorFeeRate > 0n)).toBe(true);

    let own = 0;
    let jupiter = 0;
    let skipped = 0;
    let worstBuy = -(1n << 64n);
    let worstSell = -(1n << 64n);
    const seen = { buy: 0, sell: 0 };

    for (let i = 0; i < 10_000; i++) {
      const view = withReserves(pick(bases), mag(8, 13), mag(9, 16.5));
      const side = pick(['buy', 'sell'] as const);
      const s = pick(SLIPPAGES);
      const amountIn = side === 'buy' ? mag(4.5, 10.5) : mag(4, 15);
      const q: RouteQuote | null = routeQuote(view, side, amountIn, s, NOW);
      if (!q) {
        skipped++;
        continue;
      }

      // J: mostly within a few units of ours (the edge the invariant lives on), sometimes far.
      const near = r() < 0.7;
      const J = near ? q.netExpected + int(-3, 4) : (q.netExpected * int(9_000, 11_001)) / 10_000n;
      if (J <= 0n) {
        skipped++;
        continue;
      }
      const d = decideRoute({ best: { view, q }, launch: null, jupiter: { kind: 'net', net: J } });

      // What the transaction would really guarantee, from the pool's maths alone.
      let guaranteed: bigint;
      if (side === 'buy') {
        guaranteed = floorSlip(poolOut(view, 'buy', amountIn - fee50(amountIn)), s);
      } else {
        const min = floorSlip(poolOut(view, 'sell', amountIn), s);
        guaranteed = min - fee50(min);
      }
      expect(q.netGuaranteed, `case ${i} ${side}`).toBe(guaranteed);

      if (d.route === 'own') {
        own++;
        seen[side]++;
        expect(q.netExpected >= J, `case ${i}: ours was chosen while paying less`).toBe(true);
        const jupiterThreshold = (J * (10_000n - s) + 9_999n) / 10_000n;
        const slack = jupiterThreshold - guaranteed;
        if (side === 'buy' && slack > worstBuy) worstBuy = slack;
        if (side === 'sell' && slack > worstSell) worstSell = slack;
        expect(guaranteed >= jupiterThreshold - 2n, `case ${i} ${side}: guaranteed ${guaranteed} vs Jupiter's threshold ${jupiterThreshold}`).toBe(true);
      } else {
        jupiter++;
        expect(d, `case ${i}`).toMatchObject({ route: 'jupiter', why: 'pays-more' });
        expect(J > q.netExpected, `case ${i}: Jupiter was chosen without paying more`).toBe(true);
      }
    }

    // The loop is not vacuous: most cases quote, both routes win often, on both sides.
    expect(skipped).toBeLessThan(2_500);
    expect(own).toBeGreaterThan(3_000);
    expect(jupiter).toBeGreaterThan(2_000);
    expect(seen.buy).toBeGreaterThan(1_000);
    expect(seen.sell).toBeGreaterThan(1_000);
    // The measured slack: 1 on a buy, 2 on a sell (judge-inv.cjs, 2,000,000 cases). The 2 is not padding.
    expect(worstBuy).toBeLessThanOrEqual(1n);
    expect(worstSell).toBe(2n);
  });
});
