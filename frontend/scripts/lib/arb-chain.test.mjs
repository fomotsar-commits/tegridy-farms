import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import bs58 from 'bs58';
import { COINS, Misreads, PUMP_FEE_CONFIG, ROBOT, SOL_MINT, USDC_MINT, busyTokens, poolsFromListing, pumpFeeConfig, takeRows, clmmConfigFee, decodePool, depthOf, lastSlippageBps, minOutAt, nearestFirst, robotSettings, testRunProblem, tripsFor, withFee } from './arb-chain.mjs';
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
  it('says the robot takes a two-swap trip through two outside pools (keeper/takes.ts) and one through ours', () => {
    const [outside] = trips([whirlpool({ usd: 1000 }), whirlpool({ usd: 1020 })]);
    expect(outside.robotTakes).toBe(true);
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

describe('robotSettings: the rule the running robot judges with, read from its page', () => {
  // The live robot of 2026-11-06: a $100 cap and a $0.002 floor, where a scanner started without
  // its settings judged at $25 and $0.01 (and the robot sizes an outside trip by the scanner's size).
  const rule = { maxTradeUsd: 100, minProfitUsd: 0.002, microLamports: 10_000, lighthouseProven: true, flashLoans: true };
  const page = (body, status = 200) => {
    const asked = [];
    const fetchImpl = async (url) => {
      asked.push(url);
      return new Response(JSON.stringify(body), { status });
    };
    return Object.assign(fetchImpl, { asked });
  };

  it('gives the robot’s own settings when its page has them, asked of the page named', async () => {
    const f = page({ wallet: ROBOT.wallet, lighthouse: { proven: true }, rule });
    expect(await robotSettings('http://127.0.0.1:8792/state.json', f)).toEqual({ rule });
    expect(f.asked).toEqual(['http://127.0.0.1:8792/state.json']);
  });

  it('says why not, so the scanner’s own settings stand in and the page says so', async () => {
    const off = page({ rule });
    expect((await robotSettings('off', off)).why).toMatch(/ARB_ROBOT_URL is off/);
    expect(off.asked).toEqual([]);
    // A robot started on an older build publishes its cap but not its floor.
    expect(await robotSettings('http://127.0.0.1:8792/state.json', page({ lighthouse: { proven: true, capUsd: 100, settingUsd: 100 } }))).toEqual({ why: expect.stringMatching(/does not give its settings/) });
    expect(await robotSettings('http://127.0.0.1:8792/state.json', page({ rule: { ...rule, minProfitUsd: -1 } }))).toEqual({ why: expect.stringMatching(/not a positive number/) });
    expect((await robotSettings('http://127.0.0.1:8792/state.json', page({ rule }, 421))).why).toMatch(/answered 421/);
    const down = async () => {
      throw new TypeError('fetch failed', { cause: { code: 'ECONNREFUSED' } });
    };
    expect((await robotSettings('http://127.0.0.1:8792/state.json', down)).why).toMatch(/ECONNREFUSED.*is the robot running/);
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

describe('the wider scanner (11-06: 6 of 64 coins looked up in 6.7 h, 0 test runs passed)', () => {
  const BAYLA = '7hmVkPXmVagxoptAEpx4jBzZVHwGLdFj6c1y42qxpump';
  const band = (address, mintA, mintB, rawBPerA, fee, liquidity = 10n ** 13n) => ({ address, dex: 'whirlpool', kind: 'band', fee, liquidity, sqrtPriceX64: sqrtX64(rawBPerA), mintA, mintB, stopped: null, owedA: 0n, owedB: 0n });

  it('finds a coin’s pools from one listing read, deepest first, its own address only', () => {
    const listing = [
      { chainId: 'solana', pairAddress: key(50), baseToken: { address: ZEC_MINT }, quoteToken: { address: SOL_MINT }, liquidity: { usd: 5_000 } },
      { chainId: 'solana', pairAddress: key(51), baseToken: { address: ZEC_MINT }, quoteToken: { address: USDC_MINT }, liquidity: { usd: 90_000 } },
      { chainId: 'solana', pairAddress: key(52), baseToken: { address: ZEC_MINT }, quoteToken: { address: SOL_MINT }, liquidity: { usd: 200 } },
      { chainId: 'ethereum', pairAddress: key(53), baseToken: { address: ZEC_MINT }, quoteToken: { address: SOL_MINT }, liquidity: { usd: 9e9 } },
      { chainId: 'solana', pairAddress: 'not an address', baseToken: { address: ZEC_MINT }, quoteToken: { address: SOL_MINT }, liquidity: { usd: 9e9 } },
      { chainId: 'solana', pairAddress: key(54), baseToken: { address: SOL_MINT }, quoteToken: { address: USDC_MINT }, liquidity: { usd: 9e9 } },
      { chainId: 'solana', pairAddress: key(51), baseToken: { address: ZEC_MINT }, quoteToken: { address: USDC_MINT }, liquidity: { usd: 90_000 } },
    ];
    expect(poolsFromListing(listing, ZEC_MINT, 1_000).map((p) => p.address)).toEqual([key(51), key(50)]);
    expect(poolsFromListing({ error: 'x' }, ZEC_MINT, 1_000)).toEqual([]);
  });

  it('trades a pool priced in BAYLA: SOL → BAYLA → the token → SOL, three swaps', () => {
    // ZEC $1000 in its BAYLA pool, $1020 in its SOL pool; BAYLA $0.01, SOL $100.
    const link = band(key(60), SOL_MINT, BAYLA, (100 / 0.01) * 10 ** (6 - 9), 0.0025, 10n ** 15n);
    const cheap = band(key(61), ZEC_MINT, BAYLA, (1000 / 0.01) * 10 ** (6 - 8), 0.003);
    const dear = band(key(62), ZEC_MINT, SOL_MINT, (1020 / 100) * 10 ** (9 - 8), 0.003);
    const depths = new Map([cheap, dear].map((p) => [p.address, depthOf(p, new Map())]));
    const quotes = new Map([[BAYLA, { pool: link, depth: depthOf(link, new Map()) }]]);
    const usd = new Map([[USDC_MINT, 1], [SOL_MINT, 100], [BAYLA, 0.01]]);
    const [best] = tripsFor([cheap, dear], { token: ZEC_MINT, decimals: 8, depths, usd, holds: new Map([[SOL_MINT, 1e15]]), bridge: null, quotes, settings: SETTINGS });
    expect(best.pays).toBe(true);
    expect(best.coin).toBe(SOL_MINT);
    expect(best.legs.map((l) => l.pool)).toEqual([key(60), key(61), key(62)]);
    expect(best.via).toEqual([BAYLA, ZEC_MINT]);
    expect(best.gapPct).toBeCloseTo(2, 6);
    // Three swaps: shown, test-run, but not handed to the robot (keeper/takes.ts reads two).
    expect(best.robotTakes).toBe(false);
  });

  it('leaves a misread pool out of test runs, longer each time', () => {
    const m = new Misreads();
    expect(m.judge('P', 1_000, 990, 0)).toBe(false); // within 2%: a fair reading
    expect(m.judge('P', 1_000, 900, 0)).toBe(true);
    expect(m.held('P', 9 * 60_000)).toBe(true);
    expect(m.held('P', 11 * 60_000)).toBe(false);
    m.judge('P', 1_000, 900, 11 * 60_000);
    expect(m.held('P', 30 * 60_000)).toBe(true); // 20 minutes the second time
    for (let i = 0; i < 12; i++) m.judge('P', 1_000, 900, 0);
    expect(m.list(0)[0].until).toBe(6 * 60 * 60_000); // never past 6 hours
  });

  it('hands the robot every fresh passed two-swap trip, outside pools included, not only the best 60', () => {
    const now = 1e9;
    const row = (robotTakes, ok, age) => ({ robotTakes, proof: { ok, at: now - age } });
    const rows = [row(true, true, 1_000), row(true, false, 1_000), row(false, true, 1_000), row(true, true, 4 * 60_000)];
    expect(takeRows(rows, now, 3 * 60_000)).toEqual([rows[0]]);
  });
});

describe('closest to paying: the money behind a gap, not its percent (11-06: KWIF 14%, TBB 890%, both into pools holding dust)', () => {
  /** A constant-product pool of `token` against SOL: `lamports` deep, at `solPerToken` (6-decimal token). */
  const pair = (n, token, dex, fee, lamports, solPerToken) => ({
    pool: { address: key(n), dex, kind: 'pair', fee, mintA: token, mintB: SOL_MINT, stopped: null },
    depth: { a: lamports / (solPerToken * 1e3), b: lamports },
  });
  const tripsOf = (token, pools) =>
    tripsFor(pools.map((x) => x.pool), { token, decimals: 6, depths: new Map(pools.map((x) => [x.pool.address, x.depth])), usd: new Map([[USDC_MINT, 1], [SOL_MINT, 100]]), holds: new Map([[SOL_MINT, 6.8e8]]), bridge: null, settings: SETTINGS });
  const through = (t, x) => t.legs.some((l) => l.pool === x.pool.address);
  const route = (t) => t.legs.map((l) => l.pool);

  // KWIF read 11-06 ~13:31Z: a ~$60k Raydium pool, our HBGZ… (0.136 SOL) 1.3% dearer, our H3ru… (5 lamports) 14% dearer.
  const KWIF = key(70);
  const RAY = pair(72, KWIF, 'cpmm', 0.0025, 3e11, 2e-6);
  const HBGZ = pair(73, KWIF, 'ours', 0.01, 135_958_000, 2.026e-6);
  const H3RU = pair(74, KWIF, 'ours', 0.01, 5, 2.28e-6);
  // TBB: a ~$165k PumpSwap pool, ours 6tNC… (0.36 SOL) 0.6% dearer, and a pool of dust 890% dearer.
  const TBB = key(71);
  const PUMP = pair(75, TBB, 'pumpswap', 0.0025, 8.25e11, 3e-5);
  const SIX = pair(76, TBB, 'ours', 0.01, 362_797_000, 3e-5 * 1.006);
  const DUST = pair(77, TBB, 'ours', 0.01, 40, 3e-5 * 9.9);
  // A coin with two $60k pools 1.28% apart: a smaller gap than KWIF's in percent, more in dollars.
  const DEEP = key(78);
  const OUT = pair(79, DEEP, 'cpmm', 0.0025, 3e11, 1e-5);
  const IN = pair(80, DEEP, 'ours', 0.01, 3e11, 1e-5 * 1.0128);
  const kwif = tripsOf(KWIF, [RAY, HBGZ, H3RU]);
  const tbb = tripsOf(TBB, [PUMP, SIX, DUST]);
  const deep = tripsOf(DEEP, [OUT, IN]);

  it('a coin’s closest is the 1.3% trip through $60k, not a 14% gap into 5 lamports', () => {
    const dust = kwif.find((t) => route(t).join() === [RAY.pool.address, H3RU.pool.address].join());
    expect(dust.gapPct).toBeCloseTo(14, 0);
    expect(dust.pays).toBe(false);
    expect(dust.gapInUsd).toBeLessThan(1e-6);
    const [closest] = nearestFirst(kwif);
    expect(route(closest)).toEqual([RAY.pool.address, HBGZ.pool.address]);
    expect(closest.gapPct).toBeCloseTo(1.3, 1);
  });

  it('the list puts every trip into a dust pool after every trip with money behind it', () => {
    expect(route(nearestFirst(tbb)[0])).toEqual([PUMP.pool.address, SIX.pool.address]);
    const listed = nearestFirst([...kwif, ...tbb, ...deep]);
    const dust = (t) => through(t, H3RU) || through(t, DUST);
    const firstDust = listed.findIndex(dust);
    expect(firstDust).toBeGreaterThan(0);
    expect(listed.slice(firstDust).every(dust)).toBe(true);
    // In dollars at the best size: the $60k pair makes more than KWIF's $0.14-deep pool, though its
    // gap is the smaller in percent; the TBB trip, under its fees, makes nothing.
    expect(listed[0].gapPct).toBeLessThan(listed[1].gapPct);
    expect(route(listed[0])).toEqual([OUT.pool.address, IN.pool.address]);
    expect(route(listed[1])).toEqual([RAY.pool.address, HBGZ.pool.address]);
    expect(route(listed[2])).toEqual([PUMP.pool.address, SIX.pool.address]);
  });
});

describe('PumpSwap pools priced as PumpSwap prices them (11-06: Jupiter paid 3% to 18% less than the vaults said)', () => {
  // SOY's pool H8yiDq… read 11-06 ~07:10Z: base vault, quote vault, the pool's extra SOL at byte 245.
  const B = 171231486962232n;
  const Q = 86860086012n;
  const V = 17584291633n;
  const SUPPLY = 1_000_000_000n * 10n ** 6n;
  function pumpPool({ extra = V, creator = true, length = 301 } = {}) {
    const b = Buffer.alloc(length);
    tag('Pool').copy(b, 0);
    put(b, 43, ZEC_MINT);
    put(b, 75, SOL_MINT);
    put(b, 139, key(1));
    put(b, 171, key(2));
    if (creator) put(b, 211, key(3));
    if (length >= 261) {
      // A signed 128-bit number: two's complement over 16 bytes.
      const raw = BigInt.asUintN(128, extra);
      b.writeBigUInt64LE(raw & ((1n << 64n) - 1n), 245);
      b.writeBigUInt64LE(raw >> 64n, 253);
    }
    return decodePool('pumpswap', key(70), b);
  }
  /** The pump fee program's FeeConfig as read 11-06: flat 25+5+0 bps, then 25 market-cap tiers (three here). */
  function feeConfigBytes() {
    const tiers = [[0n, 2n, 93n, 30n], [420n * 10n ** 9n, 20n, 5n, 95n], [98_240n * 10n ** 9n, 20n, 5n, 5n]];
    const b = Buffer.alloc(8 + 1 + 32 + 24 + 4 + tiers.length * 40);
    tag('FeeConfig').copy(b, 0);
    let o = 41;
    for (const f of [25n, 5n, 0n]) (b.writeBigUInt64LE(f, o), (o += 8));
    b.writeUInt32LE(tiers.length, o);
    o += 4;
    for (const [th, lp, pr, cr] of tiers) {
      u128(b, o, th);
      b.writeBigUInt64LE(lp, o + 16);
      b.writeBigUInt64LE(pr, o + 24);
      b.writeBigUInt64LE(cr, o + 32);
      o += 40;
    }
    return b;
  }
  const amounts = new Map([[key(1), B], [key(2), Q]]);

  it('counts the pool’s extra SOL (byte 245) as depth: a buy pays what Jupiter paid through it', () => {
    const p = pumpPool();
    const d = depthOf(p, amounts);
    expect(d.b).toBe(Number(Q + V));
    // 20 SOL in at the 1.2% tier: Jupiter paid 27,244,965,195,998 through this pool (11-06).
    const xin = 20e9 * (1 - 0.012);
    expect((d.a * xin) / (d.b + xin) / 27_244_965_195_998).toBeCloseTo(1, 3);
  });

  it('reads the extra as signed: Fartcoin’s pool AmmpSn… holds −9,401 lamports there, not 2^64 − 9,401', () => {
    expect(depthOf(pumpPool({ extra: -9_401n, length: 300 }), amounts).b).toBe(Number(Q) - 9_401);
  });

  it('a pool of the older 243-byte layout has no extra SOL', () => {
    expect(depthOf(pumpPool({ length: 243 }), amounts).b).toBe(Number(Q));
  });

  it('charges the market-cap tier from the pump fee program, not GlobalConfig’s flat 0.30%', () => {
    const cfg = pumpFeeConfig(feeConfigBytes());
    const configs = new Map([[PUMP_FEE_CONFIG, cfg]]);
    const p = pumpPool();
    // SOY: about 605 SOL of market cap, the 420 SOL tier: 20 + 5 + 95 bps.
    expect(withFee(p, configs, { depth: depthOf(p, amounts), supply: SUPPLY }).fee).toBeCloseTo(0.012, 9);
    // Under 420 SOL: 1.25%. A pool with no coin creator pays the flat 0.30%.
    const small = new Map([[key(1), B * 4n], [key(2), Q]]);
    expect(withFee(p, configs, { depth: depthOf(p, small), supply: SUPPLY }).fee).toBeCloseTo(0.0125, 9);
    expect(withFee(pumpPool({ creator: false }), configs, { depth: depthOf(p, amounts), supply: SUPPLY }).fee).toBeCloseTo(0.003, 9);
    // Unread, the fee is not guessed.
    expect(withFee(p, new Map(), { depth: depthOf(p, amounts), supply: SUPPLY })).toBeNull();
    expect(pumpFeeConfig(Buffer.alloc(100))).toBeNull();
  });
});
