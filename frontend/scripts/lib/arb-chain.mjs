/**
 * The arbitrage scanner's chain maths (scripts/arb-scanner.mjs; owner 2026-11-05: "fill it with
 * arbs that are actually the ones our bot would execute").
 *
 * Every figure here is read from the pool accounts themselves, all of one coin's pools in one
 * `getMultipleAccounts` call, so every price compared was true in the same slot:
 *   - the fee each pool really charges (its own account or its fee config), never an assumed one;
 *   - the price and the depth AT that price: a concentrated pool (Orca, Raydium CLMM) is sized
 *     from the liquidity in its current band, not from its whole reserve;
 *   - whether it can trade at all (switched off, empty band).
 *
 * Whether the robot would take a trip, at what size, and what it makes is decided by the robot's
 * OWN rule (src/lib/solana/keeper/rule.ts, imported here): the size where the gap closes, held to
 * the robot's float and cap, and the floor (the network fee and the robot's minimum profit), with
 * the settings the running robot publishes (`robotSettings`). This file reads the pools; the
 * scanner's test run from the robot's wallet decides.
 */
import { createHash } from 'node:crypto';
import bs58 from 'bs58';
import { judgeTrip, rankTrips, robotRule } from '../../src/lib/solana/keeper/rule.ts';

export const SOL_MINT = 'So11111111111111111111111111111111111111112';
export const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
export const USDT_MINT = 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB';
export const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
export const TOKEN_2022_PROGRAM = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';

/** The coins the robot starts and ends a trip in (keeper/plan.ts KEEPER_COINS). */
export const COINS = Object.freeze({
  [SOL_MINT]: { symbol: 'SOL', decimals: 9 },
  [USDC_MINT]: { symbol: 'USDC', decimals: 6 },
});

/**
 * Coins a pool may be priced in besides SOL and USDC, each with the pool that links it to one of
 * them (read in the same slot as the coin's pools): BAYLA through our BAYLA/SOL pool, USDT
 * through a Raydium USDT/USDC pool. A trip through one adds a swap at each end.
 */
export const QUOTES = Object.freeze({
  '7hmVkPXmVagxoptAEpx4jBzZVHwGLdFj6c1y42qxpump': { symbol: 'BAYLA', decimals: 6, program: TOKEN_2022_PROGRAM, bridge: 'ErvzV1NMZmcfAqZtGH4AQhYAjn77nJEworKK1mYPz5w4' },
  [USDT_MINT]: { symbol: 'USDT', decimals: 6, program: TOKEN_PROGRAM, bridge: '7TbGqz32RsuwXbXY7EyBCiAnMbJq1gm1wKmfjQjuwoyF' },
});

/** The robot's wallet and the two figures of its (keeper/plan.ts DEFAULT_LIMITS, MAX_LAMPORTS_SPENT) a test run needs. Its cap and floor are keeper/rule.ts's. */
export const ROBOT = Object.freeze({
  wallet: '9WAugU3g3YECwuEuoPy3NEH5Co475fHATGdjr2dy2Fcz',
  slippageBps: 50,
  maxLamportsSpent: 3_000_000,
});

/**
 * The rule the running robot judges with, read from its gap screen (keeper/rule.ts robotRule):
 * `{ rule }` (its cap, floor, fee, Lighthouse proof and SOL loans), or `{ why }` when the page
 * cannot be read or does not give them, and the scanner's own settings must stand in. The robot
 * sizes a trip through two outside pools by the scanner's size, so the two must judge alike.
 * `url` "off" reads nothing.
 */
export async function robotSettings(url, fetchImpl) {
  if (url.toLowerCase() === 'off') return { why: 'ARB_ROBOT_URL is off' };
  try {
    const r = await fetchImpl(url, { signal: AbortSignal.timeout(5_000) });
    const got = r.ok ? robotRule(await r.json()) : `the robot’s page answered ${r.status}`;
    return typeof got === 'string' ? { why: got } : { rule: got };
  } catch (e) {
    const said = e?.cause?.code ?? (e instanceof Error ? e.message : String(e));
    return { why: `the robot’s page was not read (${said}): is the robot running?` };
  }
}

/**
 * The six outside venues and ours. `mints`: where the pool's two coins sit in its account (the
 * one-coin lookup filters on them); `size`: the account's length, when every pool's is the same.
 */
export const DEXES = Object.freeze({
  ours: { program: 'EKS4C6xvV9A5DMWaWtVnFvi7ru78EhqRAoddEMpQ2BtT', name: 'Tegriddy Farms (ours)', mints: [168, 200], size: 637, tag: 'PoolState' },
  pumpswap: { program: 'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA', name: 'PumpSwap', mints: [43, 75], size: null, tag: 'Pool' },
  ammV4: { program: '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8', name: 'Raydium AMM v4', mints: [400, 432], size: 752, tag: null },
  cpmm: { program: 'CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C', name: 'Raydium CPMM', mints: [168, 200], size: 637, tag: 'PoolState' },
  clmm: { program: 'CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK', name: 'Raydium CLMM', mints: [73, 105], size: 1544, tag: 'PoolState' },
  whirlpool: { program: 'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc', name: 'Orca', mints: [101, 181], size: 653, tag: 'Whirlpool' },
  dlmm: { program: 'LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo', name: 'Meteora DLMM', mints: [88, 120], size: 904, tag: 'LbPair' },
});
export const dexOfProgram = (program) => Object.keys(DEXES).find((k) => DEXES[k].program === program) ?? null;

/**
 * PumpSwap's fees: the pump fee program's FeeConfig for PumpSwap (PDA ["fee_config", PumpSwap],
 * read 11-06): flat fees for a pool with no coin creator, else a tier by the coin's market cap
 * (1.25% under 420 SOL, down to 0.30% from 98,240 SOL). GlobalConfig's flat 0.30% is not it.
 */
export const PUMP_FEE_CONFIG = '5PHirr8joyTMp9JMm6nW7hNDVyEYdkzDqazxPD7RaTjx';
export const PUMP_FEE_PROGRAM = 'pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ';

const tagOf = (name) => createHash('sha256').update(`account:${name}`).digest().subarray(0, 8);
const TAGS = Object.fromEntries(Object.entries(DEXES).map(([k, d]) => [k, d.tag ? tagOf(d.tag) : null]));

const key = (d, at) => bs58.encode(d.subarray(at, at + 32));
const u16 = (d, at) => d.readUInt16LE(at);
const u32 = (d, at) => d.readUInt32LE(at);
const i32 = (d, at) => d.readInt32LE(at);
const u64 = (d, at) => d.readBigUInt64LE(at);
const u128 = (d, at) => d.readBigUInt64LE(at) + (d.readBigUInt64LE(at + 8) << 64n);

/**
 * One pool account, in one shape for every venue, or null when it is not a pool of `dex`.
 * `fee` is the fraction the pool keeps of what goes in; null when it lives in a fee config
 * (`config`), which `withFee` fills. A pool that cannot trade says why in `stopped`.
 */
export function decodePool(dex, address, data) {
  const d = DEXES[dex];
  if (!d || !Buffer.isBuffer(data)) return null;
  if (d.size && data.length !== d.size) return null;
  if (TAGS[dex] && !data.subarray(0, 8).equals(TAGS[dex])) return null;
  const base = { address, dex, config: null, fee: null, stopped: null, owedA: 0n, owedB: 0n };
  switch (dex) {
    case 'whirlpool': {
      const liquidity = u128(data, 49);
      return { ...base, kind: 'band', fee: u16(data, 45) / 1e6, liquidity, sqrtPriceX64: u128(data, 65), mintA: key(data, 101), vaultA: key(data, 133), mintB: key(data, 181), vaultB: key(data, 213), stopped: liquidity === 0n ? 'no liquidity at its price' : null };
    }
    case 'clmm': {
      const liquidity = u128(data, 237);
      const status = data[389];
      return {
        ...base, kind: 'band', config: key(data, 9), liquidity, sqrtPriceX64: u128(data, 253),
        mintA: key(data, 73), mintB: key(data, 105), vaultA: key(data, 137), vaultB: key(data, 169),
        stopped: status & 16 ? 'trading switched off' : liquidity === 0n ? 'no liquidity at its price' : null,
      };
    }
    case 'ours':
    case 'cpmm': {
      const status = data[329];
      const creatorOn = data[390] !== 0;
      return {
        ...base, kind: 'pair', config: key(data, 8), vaultA: key(data, 72), vaultB: key(data, 104), mintA: key(data, 168), mintB: key(data, 200),
        programA: key(data, 232), programB: key(data, 264), observation: key(data, 296), creatorOn,
        owedA: u64(data, 341) + u64(data, 357) + (creatorOn ? u64(data, 397) : 0n),
        owedB: u64(data, 349) + u64(data, 365) + (creatorOn ? u64(data, 405) : 0n),
        openTime: u64(data, 373),
        stopped: status & 4 ? 'trading switched off' : null,
      };
    }
    case 'ammV4': {
      const status = u64(data, 0);
      const den = u64(data, 184);
      return {
        ...base, kind: 'pair', fee: den > 0n ? Number(u64(data, 176)) / Number(den) : null,
        owedA: u64(data, 192), owedB: u64(data, 200),
        vaultA: key(data, 336), vaultB: key(data, 368), mintA: key(data, 400), mintB: key(data, 432), openTime: u64(data, 224),
        stopped: [1n, 6n, 7n].includes(status) ? null : `status ${status}: not trading`,
      };
    }
    case 'pumpswap': {
      if (data.length < 243) return null;
      // A newer pool prices with a signed 128-bit quote (SOL) adjustment at byte 245 beside its
      // vault: Jupiter matches vault + it to 0.01% (SOY, +17.6 SOL, 11-06); some hold a few lamports below 0.
      const extraB = data.length >= 261 ? BigInt.asIntN(128, u128(data, 245)) : 0n;
      return { ...base, kind: 'pair', mintA: key(data, 43), mintB: key(data, 75), vaultA: key(data, 139), vaultB: key(data, 171), creatorSet: !data.subarray(211, 243).equals(Buffer.alloc(32)), extraB };
    }
    case 'dlmm': {
      const binStep = u16(data, 80);
      const baseFee = u16(data, 8) * binStep * 10 * 10 ** data[34];
      const va = u32(data, 40);
      const variable = Math.ceil(((va * binStep) ** 2 * u32(data, 16)) / 1e11);
      return {
        ...base, kind: 'bins', fee: Math.min(baseFee + variable, 1e8) / 1e9, activeId: i32(data, 76), binStep,
        mintA: key(data, 88), mintB: key(data, 120), vaultA: key(data, 152), vaultB: key(data, 184),
        stopped: data[82] !== 0 ? 'trading switched off' : null,
      };
    }
    default:
      return null;
  }
}

/** The trade fee in a Raydium CLMM fee config, or null. */
export const clmmConfigFee = (data) => (Buffer.isBuffer(data) && data.length >= 51 ? u32(data, 47) / 1e6 : null);
/** The trade and creator fees in a cp-swap fee config (ours and Raydium CPMM), or null. */
export const cpConfigFee = (data) => (Buffer.isBuffer(data) && data.length >= 116 ? { trade: Number(u64(data, 12)) / 1e6, creator: Number(u64(data, 108)) / 1e6 } : null);
/** The pump fee program's FeeConfig: flat fees and market-cap tiers, each a fraction; null when not one. */
export function pumpFeeConfig(data) {
  if (!Buffer.isBuffer(data) || data.length < 73 || !data.subarray(0, 8).equals(tagOf('FeeConfig'))) return null;
  const fees = (at) => Number(u64(data, at) + u64(data, at + 8) + u64(data, at + 16)) / 1e4;
  const n = u32(data, 65);
  if (n === 0 || data.length < 69 + n * 40) return null;
  const tiers = Array.from({ length: n }, (_, i) => ({ threshold: Number(u128(data, 69 + i * 40)), fee: fees(69 + i * 40 + 16) }));
  return { flat: fees(41), tiers };
}

/** A PumpSwap pool's fee: its market cap's tier (lamports: supply × SOL per token) or the flat fee. */
function pumpFee(pool, cfg, ctx) {
  if (!pool.creatorSet || pool.mintB !== SOL_MINT) return cfg.flat;
  if (!ctx?.depth || !(ctx.supply > 0)) return Math.max(cfg.flat, ...cfg.tiers.map((t) => t.fee)); // depth unread: the dearest
  const cap = (ctx.depth.b / ctx.depth.a) * Number(ctx.supply);
  if (cap < cfg.tiers[0].threshold) return cfg.tiers[0].fee;
  return [...cfg.tiers].reverse().find((t) => cap >= t.threshold).fee;
}

/**
 * The pool with its real fee filled in from `configs` (address → decoded fee config); null when
 * unread. A PumpSwap pool's needs its depth and its token's supply (`ctx`): its tier is its market cap.
 */
export function withFee(pool, configs, ctx) {
  if (pool.dex === 'clmm') {
    const f = configs.get(pool.config);
    return typeof f === 'number' ? { ...pool, fee: f } : null;
  }
  if (pool.dex === 'ours' || pool.dex === 'cpmm') {
    const f = configs.get(pool.config);
    return f ? { ...pool, fee: f.trade + (pool.creatorOn ? f.creator : 0) } : null;
  }
  if (pool.dex === 'pumpswap') {
    const cfg = configs.get(PUMP_FEE_CONFIG);
    return cfg ? { ...pool, fee: pumpFee(pool, cfg, ctx) } : null;
  }
  return pool.fee === null ? null : pool;
}

/** A token account's amount (SPL and Token-2022 alike), or null. */
export const tokenAmount = (data) => (Buffer.isBuffer(data) && data.length >= 72 ? u64(data, 64) : null);

/**
 * What a pool trades like near its price, in raw units: x·y = k on `a` and `b`. A pair pool's
 * are its reserves (vaults less the fees parked in them); a band pool's are its in-band
 * liquidity's (L/√P and L·√P), which hold only within the band; a bin pool's are its smaller
 * side at its active bin's price, a rough depth. Null when it cannot be priced.
 */
export function depthOf(pool, amounts) {
  if (pool.kind === 'band') {
    const sqrtP = Number(pool.sqrtPriceX64) / 2 ** 64;
    const L = Number(pool.liquidity);
    if (!(sqrtP > 0 && L > 0)) return null;
    return { a: L / sqrtP, b: L * sqrtP };
  }
  const va = amounts.get(pool.vaultA);
  const vb = amounts.get(pool.vaultB);
  if (va === undefined || vb === undefined || va === null || vb === null) return null;
  if (pool.kind === 'pair') {
    const a = Number(va - pool.owedA);
    const b = Number(vb - pool.owedB + (pool.extraB ?? 0n));
    return a > 0 && b > 0 ? { a, b } : null;
  }
  const price = (1 + pool.binStep / 1e4) ** pool.activeId;
  const b = Math.min(Number(vb), Number(va) * price);
  return b > 0 && price > 0 && Number.isFinite(price) ? { a: b / price, b, rough: true } : null;
}

/** One swap through a depth: what `x` in pays out after the pool's fee. */
export const swapOut = (rin, rout, fee, x) => {
  const xin = x * (1 - fee);
  return (rout * xin) / (rin + xin);
};

/** A leg of a trip: the pool, which way, its depth that way (`rin`, `rout`) and fee. */
export function legOf(pool, depth, fromMint) {
  const aToB = pool.mintA === fromMint;
  return { pool, from: fromMint, to: aToB ? pool.mintB : pool.mintA, rin: aToB ? depth.a : depth.b, rout: aToB ? depth.b : depth.a, fee: pool.fee };
}

/**
 * Every round trip among `pools` (one token's pools, all read in one slot), judged by the robot's
 * own rule (keeper/rule.ts judgeTrip), the trips it takes first and then by profit after the
 * network fee. `ctx`:
 *   token, decimals   the token and its decimals
 *   depths            pool address → depthOf()
 *   usd               coin mint → USD (SOL from a SOL/USDC pool read in the same call; USDC 1)
 *   holds             coin mint → what the robot holds, raw (missing: not read, sized by the cap)
 *   bridge            the SOL/USDC pool that closes a trip priced in both coins, with its depth
 *   settings          the robot's rule settings (keeper/rule.ts ruleSettingsFromEnv)
 */
export function tripsFor(pools, ctx) {
  const trips = [];
  // ctx.quotes: quote mint → { pool, depth } linking it to SOL or USDC (QUOTES), when read.
  const linked = (q) => COINS[q] || ctx.quotes?.get(q);
  // A bin pool's depth (Meteora DLMM) is rough: its price steps are not read, so a gap through
  // it is not a real one. 11-06/07: 1,328 of 1,330 test runs through one lost at Jupiter's real
  // quote (median -1.32% against +0.52% on paper); the other two lost too. Left out until the
  // bins are read.
  const usable = pools.filter((p) => !p.stopped && ctx.depths.get(p.address) && !ctx.depths.get(p.address).rough && linked(p.mintA === ctx.token ? p.mintB : p.mintA));
  const coinOf = (p) => (p.mintA === ctx.token ? p.mintB : p.mintA);
  const link = (q) => ctx.quotes.get(q);
  const coinAcross = (q) => (COINS[q] ? q : link(q).pool.mintA === q ? link(q).pool.mintB : link(q).pool.mintA);
  for (const buy of usable) {
    for (const sell of usable) {
      if (buy === sell) continue;
      const qBuy = coinOf(buy);
      const qSell = coinOf(sell);
      const start = coinAcross(qBuy);
      const legs = [];
      if (qBuy !== start) legs.push(legOf(link(qBuy).pool, link(qBuy).depth, start));
      legs.push(legOf(buy, ctx.depths.get(buy.address), qBuy), legOf(sell, ctx.depths.get(sell.address), ctx.token));
      let end = qSell;
      if (!COINS[qSell]) {
        legs.push(legOf(link(qSell).pool, link(qSell).depth, qSell));
        end = coinAcross(qSell);
      }
      if (end !== start) {
        if (!ctx.bridge) continue;
        legs.push(legOf(ctx.bridge.pool, ctx.bridge.depth, end));
      }
      if (legs.length > 4) continue;
      const coin = COINS[start];
      const holds = ctx.holds?.get(start);
      const judged = judgeTrip(legs, { decimals: coin.decimals, coinUsd: ctx.usd.get(start), solUsd: ctx.usd.get(SOL_MINT), holdsRaw: holds === undefined ? null : holds, settings: ctx.settings });
      if (typeof judged === 'string') continue;
      const decimalsOf = (m) => (COINS[m] ?? QUOTES[m]).decimals;
      const tokenUsd = (l) => {
        const q = l.from === ctx.token ? l.to : l.from;
        return (l.from === ctx.token ? l.rout / l.rin : l.rin / l.rout) * 10 ** (ctx.decimals - decimalsOf(q)) * (ctx.usd.get(q) ?? NaN);
      };
      const at = qBuy === start ? 0 : 1;
      const priceBuy = tokenUsd(legs[at]);
      const priceSell = tokenUsd(legs[at + 1]);
      trips.push({
        coin: start,
        legs: legs.map((l) => ({ pool: l.pool.address, dex: l.pool.dex, from: l.from, to: l.to, fee: l.fee, rough: Boolean(ctx.depths.get(l.pool.address)?.rough) })),
        priceBuyUsd: priceBuy,
        priceSellUsd: priceSell,
        gapPct: (priceSell / priceBuy - 1) * 100,
        costPct: legs.reduce((s, l) => s + l.fee, 0) * 100,
        judged,
        inRaw: judged.inRaw,
        inUsd: judged.inUsd,
        gainUsd: judged.gainUsd,
        feeUsd: judged.feeUsd,
        floorUsd: judged.floorUsd,
        netUsd: judged.netUsd,
        roiPct: judged.roiPct,
        gapInUsd: judged.gapInUsd,
        gapNetUsd: judged.gapNetUsd,
        reachUsd: reachOf(legs) * (ctx.usd.get(start) / 10 ** coin.decimals),
        capUsd: judged.capUsd,
        floatUsd: judged.floatUsd,
        pays: judged.takes,
        why: judged.why,
        sizedBy: judged.sizedBy,
        threeSwap: legs.length > 2,
        // Every coin the trip holds between its first and last swap (ATAs the test run opens).
        via: legs.slice(1).map((l) => l.from),
        // The robot takes two-swap trips: one in our pool (its own), or two outside pools
        // (keeper/takes.ts, since 7f40aed31). Three or four swaps it does not take yet.
        robotTakes: legs.length === 2,
      });
    }
  }
  return rankTrips(trips, 'profit');
}

/**
 * The most a trip can ever bring back, in its start coin's raw units, at any size and any gap: no
 * pool pays out more than it holds, and the swaps after it pay at most their price. Its thinnest
 * pool sets it.
 */
function reachOf(legs) {
  let reach = Infinity;
  let rate = 1; // start coin per unit of what leg i pays out, at the later legs' prices
  for (let i = legs.length - 1; i >= 0; i--) {
    reach = Math.min(reach, legs[i].rout * rate);
    rate *= legs[i].rout / legs[i].rin;
  }
  return reach;
}

/**
 * Trips that do not pay, nearest to paying first (each coin's closest, and the closest list). A trip
 * that can never bring back the floor goes last whatever its gap: a pool on it holds dust. Then the
 * dollars it makes at its best size; then, for trips that make nothing at any size, the gap less the
 * pools' fees.
 */
const canPay = (t) => Number(t.reachUsd >= t.floorUsd);
export const nearestFirst = (trips) => [...trips].sort((a, b) => canPay(b) - canPay(a) || b.gainUsd - a.gainUsd || b.gapPct - b.costPct - (a.gapPct - a.costPct));

/** The ticker a Metaplex metadata account claims (untrusted: shown as the token's claim only). */
export function metadataSymbol(data) {
  try {
    if (!Buffer.isBuffer(data) || data[0] !== 4) return null;
    const nameLen = u32(data, 65);
    const at = 69 + nameLen;
    const symLen = u32(data, at);
    if (nameLen > 64 || symLen > 16) return null;
    const s = data.subarray(at + 4, at + 4 + symLen).toString('utf8').replace(/\0/g, '').trim();
    return s ? s.slice(0, 16) : null;
  } catch {
    return null;
  }
}

/**
 * The last leg's slippage (keeper/plan.ts lastJupiterSlippage): the robot's tolerance, made
 * smaller when needed so the leg's minimum out stays at least `need`; null under `need`.
 */
export function lastSlippageBps(quotedOut, need, toleranceBps = ROBOT.slippageBps) {
  if (quotedOut < need) return null;
  const most = Number(((quotedOut - need) * 10_000n) / quotedOut);
  return Math.min(toleranceBps, most);
}
export const minOutAt = (quotedOut, bps) => (quotedOut * BigInt(10_000 - bps)) / 10_000n;

/**
 * Why a test run must not be sent, or null (keeper/plan.ts simulationProblem): the coin must
 * have grown by the floor, the token and the other coin must not have shrunk, and SOL may drop
 * by fees and rent only. Amounts in base units.
 */
export function testRunProblem(c, minProfit) {
  if (c.coinAfter - c.coinBefore < minProfit) return `the coin grew by ${c.coinAfter - c.coinBefore}, under the floor ${minProfit}`;
  if (c.tokenAfter < c.tokenBefore) return 'the token account shrank';
  if (c.otherAfter < c.otherBefore) return 'the robot’s other coin shrank';
  if ((c.via ?? []).some((v) => v.after < v.before)) return 'a coin held mid-trip shrank';
  if (c.lamportsBefore - c.lamportsAfter > BigInt(ROBOT.maxLamportsSpent)) return 'it costs more SOL than fees and rent';
  return null;
}

/** The tokens in GeckoTerminal's busiest Solana pools, with the ticker each pool lists (untrusted). */
export function busyTokens(json) {
  const out = new Map();
  for (const raw of json?.data ?? []) {
    const name = String(raw?.attributes?.name ?? '').replace(/\s+\d+(?:\.\d+)?%\s*$/, '').split(' / ');
    ['base_token', 'quote_token'].forEach((side, i) => {
      const mint = String(raw?.relationships?.[side]?.data?.id ?? '').replace(/^solana_/, '');
      if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(mint) || COINS[mint] || mint === USDT_MINT || out.has(mint)) return;
      out.set(mint, (name[i] ?? '').trim().slice(0, 16) || null);
    });
  }
  return out;
}

const ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

/**
 * Every pool a DexScreener `token-pairs/v1/solana/<mint>` answer lists for `mint` on Solana, deepest
 * first, at least `minUsd` deep by its own figure. Untrusted: it only says which accounts to read;
 * the chain says whose pool each is (its owner) and what it holds. One read per coin replaces
 * twelve one-coin getProgramAccounts calls, which the public RPC refuses.
 */
export function poolsFromListing(json, mint, minUsd) {
  const seen = new Set();
  const out = [];
  for (const raw of Array.isArray(json) ? json : []) {
    const address = String(raw?.pairAddress ?? '');
    const sides = [raw?.baseToken?.address, raw?.quoteToken?.address].map(String);
    const usd = Number(raw?.liquidity?.usd);
    if (raw?.chainId !== 'solana' || !ADDRESS.test(address) || seen.has(address) || !sides.includes(mint)) continue;
    if (!(usd >= minUsd)) continue;
    seen.add(address);
    out.push({ address, listedUsd: usd });
  }
  return out.sort((a, b) => b.listedUsd - a.listedUsd);
}

/**
 * Pools whose price the scanner misread: a test run's quote for a leg came back well under what the
 * pool's own figures said. Such a pool is left out of test runs for 10 minutes, doubling with
 * each misread to 6 hours, so one wrong reading cannot spend every test run (11-06: 153 of 160
 * test runs went to two such pools, TRUMP's Meteora pool and ZEC's Raydium CLMM pool).
 */
export class Misreads {
  constructor() {
    this.count = new Map();
    this.until = new Map();
  }
  /** A leg's quote (`quoted`) against the pool's own figure (`expected`), both raw out; true when misread. */
  judge(pool, expected, quoted, now, tolerance = 0.02) {
    if (!(expected > 0) || Number(quoted) >= Number(expected) * (1 - tolerance)) return false;
    const n = (this.count.get(pool) ?? 0) + 1;
    this.count.set(pool, n);
    this.until.set(pool, now + Math.min(10 * 60_000 * 2 ** (n - 1), 6 * 60 * 60_000));
    return true;
  }
  held(pool, now) {
    return (this.until.get(pool) ?? 0) > now;
  }
  list(now) {
    return [...this.until].filter(([, t]) => t > now).map(([pool, until]) => ({ pool, until, times: this.count.get(pool) }));
  }
}

/** The rows the robot may take now: two swaps, a test run that passed within `keepMs`. */
export const takeRows = (rows, now, keepMs) => rows.filter((r) => r.robotTakes && r.proof?.ok && now - r.proof.at < keepMs);
