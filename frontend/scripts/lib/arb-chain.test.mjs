import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import bs58 from 'bs58';
import { COINS, ROBOT, SOL_MINT, USDC_MINT, busyTokens, clmmConfigFee, decodePool, depthOf, lastSlippageBps, minOutAt, testRunProblem, tripsFor, withFee } from './arb-chain.mjs';
import { SAFE_CAP_USD } from '../../src/lib/solana/keeper/rule.ts';

/** The robot's settings before the Lighthouse check is proven: $25 a trip, a $0.01 floor plus the network fee. */
const SETTINGS = { maxTradeUsd: 1000, minProfitUsd: 0.01, microLamports: 10_000, lighthouseProven: false };

const ZEC_MINT = 'A7bdiYdS5GjqGFtxf17ppRHtDKPkkRqbKtR27dxvQXaS';
const key = (n) => bs58.encode(Buffer.alloc(32, n));
const tag = (name) => createHash('sha256').update(`account:${name}`).digest().subarray(0, 8);
const put = (b, at, mint) => Buffer.from(bs58.decode(mint)).copy(b, at);
const u128 = (b, at, v) => {
  b.writeBigUInt64LE(v & ((1n << 64n) - 1n), at);
  b.writeBigUInt64LE(v >> 64n, at + 8);
};
/** √price in Q64.64 for `price` raw units of B per raw unit of A. */
const sqrtX64 = (price) => BigInt(Math.round(Math.sqrt(price) * 2 ** 64));

/** An Orca pool of ZEC_MINT (8 decimals) against `coin`, at `usd` a token, with `liquidity` in its band. */
function whirlpool({ feeRate = 3000, liquidity = 10n ** 12n, usd = 1000, coin = USDC_MINT, solUsd = 100 } = {}) {
  const b = Buffer.alloc(653);
  tag('Whirlpool').copy(b, 0);
  b.writeUInt16LE(feeRate, 45);
  u128(b, 49, liquidity);
  const coinPerToken = (coin === USDC_MINT ? usd : usd / solUsd) * 10 ** (COINS[coin].decimals - 8);
  u128(b, 65, sqrtX64(coinPerToken));
  put(b, 101, ZEC_MINT);
  put(b, 133, key(1));
  put(b, 181, coin);
  put(b, 213, key(2));
  return b;
}

describe('decodePool reads each pool’s own fee and price', () => {
  it('takes an Orca pool’s fee from its account, not an assumed 0.3%', () => {
    const p = decodePool('whirlpool', key(9), whirlpool({ feeRate: 1600 }));
    expect(p).toMatchObject({ mintA: ZEC_MINT, mintB: USDC_MINT, fee: 0.0016, stopped: null });
  });
  it('takes a Raydium CLMM pool’s fee from its fee config (2% there, 11-05)', () => {
    const cfg = Buffer.alloc(117);
    cfg.writeUInt32LE(20_000, 47);
    expect(clmmConfigFee(cfg)).toBe(0.02);
  });
  it('says an Orca pool with no liquidity at its price cannot trade', () => {
    expect(decodePool('whirlpool', key(9), whirlpool({ liquidity: 0n })).stopped).toMatch(/no liquidity/);
  });
  it('refuses an account that is not the venue’s pool', () => {
    const b = whirlpool();
    b[0] ^= 1;
    expect(decodePool('whirlpool', key(9), b)).toBeNull();
  });
});

describe('depthOf sizes a concentrated pool from the liquidity in its band', () => {
  it('ignores the vaults: a band pool’s whole reserve is not its depth', () => {
    const p = decodePool('whirlpool', key(9), whirlpool({ liquidity: 10n ** 9n }));
    const huge = new Map([[key(1), 10n ** 18n], [key(2), 10n ** 18n]]);
    const d = depthOf(p, huge);
    // L = 1e9 at 1000 USDC (1e7 raw per raw unit... 10 raw USDC per raw token): b = L·√P.
    expect(d.b).toBeCloseTo(1e9 * Math.sqrt(10), -3);
    expect(d.b).toBeLessThan(1e17);
  });
});

/** One coin's trips, given pools, with the robot's holdings. */
function trips(pools, holds = new Map([[USDC_MINT, 1e12], [SOL_MINT, 1e15]]), bridgeFee = 400, settings = SETTINGS) {
  const decoded = pools.map((b, i) => decodePool('whirlpool', key(20 + i), b));
  const bridge = decodePool('whirlpool', key(40), (() => {
    const b = Buffer.alloc(653);
    tag('Whirlpool').copy(b, 0);
    b.writeUInt16LE(bridgeFee, 45);
    u128(b, 49, 10n ** 15n);
    u128(b, 65, sqrtX64(100 * 10 ** (6 - 9)));
    put(b, 101, SOL_MINT);
    put(b, 181, USDC_MINT);
    return b;
  })());
  const depths = new Map(decoded.map((p) => [p.address, depthOf(p, new Map())]));
  return tripsFor(decoded, { token: ZEC_MINT, decimals: 8, depths, usd: new Map([[USDC_MINT, 1], [SOL_MINT, 100]]), holds, bridge: { pool: bridge, depth: depthOf(bridge, new Map()) }, settings });
}

describe('tripsFor: only what the robot would take', () => {
  it('a 2% gap between two 0.3% pools pays, and is sized to at most $25', () => {
    const [best] = trips([whirlpool({ usd: 1000 }), whirlpool({ usd: 1020 })]);
    expect(best.pays).toBe(true);
    expect(best.inUsd).toBeLessThanOrEqual(SAFE_CAP_USD + 1e-9);
    // Held by the cap, not by the gap: the gap would take more, and the page says so.
    expect(best.sizedBy).toBe('cap');
    expect(best.gapInUsd).toBeGreaterThan(best.inUsd);
    expect(best.roiPct).toBeCloseTo((best.netUsd / best.inUsd) * 100, 9);
    expect(best.threeSwap).toBe(false);
    expect(best.legs.map((l) => l.fee)).toEqual([0.003, 0.003]);
  });
  it('lists the trips best first, whatever order the pools were read in', () => {
    const [best, other] = trips([whirlpool({ usd: 1020 }), whirlpool({ usd: 1000 })]);
    expect(best.pays).toBe(true);
    expect(other.pays).toBe(false);
    expect(best.netUsd).toBeGreaterThan(other.netUsd);
  });
  it('says the robot does not take a trip through two outside pools, and does take one through ours', () => {
    const [outside] = trips([whirlpool({ usd: 1000 }), whirlpool({ usd: 1020 })]);
    expect(outside.robotTakes).toBe(false);
    const a = decodePool('whirlpool', key(32), whirlpool({ usd: 1000 }));
    const b = { ...decodePool('whirlpool', key(33), whirlpool({ usd: 1020 })), dex: 'ours' };
    const depths = new Map([a, b].map((p) => [p.address, depthOf(p, new Map())]));
    const [ours] = tripsFor([a, b], { token: ZEC_MINT, decimals: 8, depths, usd: new Map([[USDC_MINT, 1], [SOL_MINT, 100]]), holds: new Map(), bridge: null, settings: SETTINGS });
    expect(ours.robotTakes).toBe(true);
  });
  it('the same gap does not pay when the pools really charge 2%', () => {
    const t = trips([whirlpool({ usd: 1000, feeRate: 20_000 }), whirlpool({ usd: 1020, feeRate: 20_000 })]);
    expect(t.every((x) => !x.pays)).toBe(true);
  });
  it('is sized to what the robot holds when that is less than $25', () => {
    const [best] = trips([whirlpool({ usd: 1000 }), whirlpool({ usd: 1020 })], new Map([[USDC_MINT, 2e6], [SOL_MINT, 0]]));
    expect(best.inUsd).toBeLessThanOrEqual(2 + 1e-9);
    expect(best.sizedBy).toBe('float');
    expect(best.floatUsd).toBeCloseTo(2, 6);
  });
  it('goes past $25 to where the gap closes once the Lighthouse check is proven', () => {
    const [best] = trips([whirlpool({ usd: 1000 }), whirlpool({ usd: 1020 })], undefined, undefined, { ...SETTINGS, lighthouseProven: true });
    expect(best.inUsd).toBeGreaterThan(SAFE_CAP_USD);
    expect(best.capUsd).toBe(1000);
  });
  it('a gap between a SOL pool and a USDC pool counts the third swap’s real fee', () => {
    const cheap = whirlpool({ usd: 1000, coin: SOL_MINT, feeRate: 500 });
    const dear = whirlpool({ usd: 1010, coin: USDC_MINT, feeRate: 500 });
    const [best] = trips([cheap, dear]);
    expect(best.threeSwap).toBe(true);
    expect(best.legs).toHaveLength(3);
    expect(best.costPct).toBeCloseTo(0.05 + 0.05 + 0.04, 6);
    // A third swap that costs more than the gap leaves nothing.
    expect(trips([cheap, dear], undefined, 20_000).every((x) => !x.pays)).toBe(true);
  });
  it('leaves out a pool that cannot trade', () => {
    expect(trips([whirlpool({ usd: 1000, liquidity: 0n }), whirlpool({ usd: 1020 })])).toHaveLength(0);
  });
  it('leaves out a pool whose trading is switched off, even with depth', () => {
    const a = decodePool('whirlpool', key(30), whirlpool({ usd: 1000 }));
    const b = { ...decodePool('whirlpool', key(31), whirlpool({ usd: 1020 })), stopped: 'trading switched off' };
    const depths = new Map([a, b].map((p) => [p.address, depthOf(p, new Map())]));
    expect(tripsFor([a, b], { token: ZEC_MINT, decimals: 8, depths, usd: new Map([[USDC_MINT, 1], [SOL_MINT, 100]]), holds: new Map(), bridge: null, settings: SETTINGS })).toHaveLength(0);
  });
  it('the floor is $0.01 and the network fee: a gap paying less is listed as not paying', () => {
    const [best] = trips([whirlpool({ usd: 1000 }), whirlpool({ usd: 1006.05 })]);
    expect(best.floorUsd).toBeGreaterThan(SETTINGS.minProfitUsd);
    expect(best.pays).toBe(best.gainUsd >= best.floorUsd);
  });
});

describe('withFee fills a pool’s fee from its config, never a guess', () => {
  it('returns nothing when the config was not read', () => {
    expect(withFee({ dex: 'clmm', config: key(3), fee: null }, new Map())).toBeNull();
    expect(withFee({ dex: 'clmm', config: key(3), fee: null }, new Map([[key(3), 0.0025]]))).toMatchObject({ fee: 0.0025 });
  });
});

describe('the robot’s test-run rule', () => {
  const ok = { coinBefore: 100n, coinAfter: 150n, tokenBefore: 5n, tokenAfter: 5n, otherBefore: 3n, otherAfter: 3n, lamportsBefore: 10n ** 7n, lamportsAfter: 10n ** 7n - 10_000n };
  it('passes a run that grew the coin by the floor and spent only fees', () => {
    expect(testRunProblem(ok, 50n)).toBeNull();
  });
  it('refuses a run under the floor, or that shrank the token or the other coin', () => {
    expect(testRunProblem(ok, 51n)).toMatch(/under the floor/);
    expect(testRunProblem({ ...ok, tokenAfter: 4n }, 50n)).toMatch(/token/);
    expect(testRunProblem({ ...ok, otherAfter: 2n }, 50n)).toMatch(/other coin/);
    expect(testRunProblem({ ...ok, lamportsAfter: 0n }, 50n)).toMatch(/SOL/);
  });
  it('sets the last leg’s minimum to at least spent + floor', () => {
    expect(lastSlippageBps(10_000n, 9_990n)).toBe(10);
    expect(minOutAt(10_000n, lastSlippageBps(10_000n, 9_990n))).toBeGreaterThanOrEqual(9_990n);
    expect(lastSlippageBps(10_000n, 9_000n)).toBe(ROBOT.slippageBps);
    expect(lastSlippageBps(9_000n, 9_001n)).toBeNull();
  });
});

describe('busyTokens', () => {
  it('lists each token once with its listed ticker, leaving out SOL, USDC and USDT', () => {
    const json = { data: [{ attributes: { name: 'ZEC / USDC 0.16%' }, relationships: { base_token: { data: { id: `solana_${ZEC_MINT}` } }, quote_token: { data: { id: `solana_${USDC_MINT}` } } } }] };
    expect([...busyTokens(json)]).toEqual([[ZEC_MINT, 'ZEC']]);
  });
});
