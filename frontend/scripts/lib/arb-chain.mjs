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
 * the robot's float and cap, and the floor (the network fee and $0.01). This file reads the pools;
 * the scanner's test run from the robot's wallet decides.
 */
import { createHash } from 'node:crypto';
import bs58 from 'bs58';
import { judgeTrip, rankTrips } from '../../src/lib/solana/keeper/rule.ts';

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

/** The robot's wallet and the two figures of its (keeper/plan.ts DEFAULT_LIMITS, MAX_LAMPORTS_SPENT) a test run needs. Its cap and floor are keeper/rule.ts's. */
export const ROBOT = Object.freeze({
  wallet: '9WAugU3g3YECwuEuoPy3NEH5Co475fHATGdjr2dy2Fcz',
  slippageBps: 50,
  maxLamportsSpent: 3_000_000,
});

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

/** PumpSwap's one fee setting for every pool (its GlobalConfig). */
export const PUMPSWAP_GLOBAL = 'ADyA8hdefvWN2dbGGWFotbzWxrAvLW83WG6QCVXvJKqw';

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
      return { ...base, kind: 'pair', mintA: key(data, 43), mintB: key(data, 75), vaultA: key(data, 139), vaultB: key(data, 171), creatorSet: !data.subarray(211, 243).equals(Buffer.alloc(32)) };
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
/** PumpSwap's fees (GlobalConfig): LP + protocol, and the coin creator's on top when a pool has one. */
export const pumpGlobalFee = (data) =>
  Buffer.isBuffer(data) && data.length >= 321 ? { base: Number(u64(data, 40) + u64(data, 48)) / 1e4, creator: Number(u64(data, 313)) / 1e4 } : null;

/** The pool with its real fee filled in from `configs` (address → decoded fee config); null when unread. */
export function withFee(pool, configs) {
  if (pool.dex === 'clmm') {
    const f = configs.get(pool.config);
    return typeof f === 'number' ? { ...pool, fee: f } : null;
  }
  if (pool.dex === 'ours' || pool.dex === 'cpmm') {
    const f = configs.get(pool.config);
    return f ? { ...pool, fee: f.trade + (pool.creatorOn ? f.creator : 0) } : null;
  }
  if (pool.dex === 'pumpswap') {
    const f = configs.get(PUMPSWAP_GLOBAL);
    return f ? { ...pool, fee: f.base + (pool.creatorSet ? f.creator : 0) } : null;
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
    const b = Number(vb - pool.owedB);
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
  const usable = pools.filter((p) => !p.stopped && ctx.depths.get(p.address) && COINS[p.mintA === ctx.token ? p.mintB : p.mintA]);
  const coinOf = (p) => (p.mintA === ctx.token ? p.mintB : p.mintA);
  for (const buy of usable) {
    for (const sell of usable) {
      if (buy === sell) continue;
      const start = coinOf(buy);
      const end = coinOf(sell);
      const legs = [legOf(buy, ctx.depths.get(buy.address), start), legOf(sell, ctx.depths.get(sell.address), ctx.token)];
      if (end !== start) {
        if (!ctx.bridge) continue;
        legs.push(legOf(ctx.bridge.pool, ctx.bridge.depth, end));
      }
      const coin = COINS[start];
      const holds = ctx.holds?.get(start);
      const judged = judgeTrip(legs, { decimals: coin.decimals, coinUsd: ctx.usd.get(start), solUsd: ctx.usd.get(SOL_MINT), holdsRaw: holds === undefined ? null : holds, settings: ctx.settings });
      if (typeof judged === 'string') continue;
      const tokenUsd = (l) => (l.from === ctx.token ? l.rout / l.rin : l.rin / l.rout) * 10 ** (ctx.decimals - COINS[l.from === ctx.token ? l.to : l.from].decimals) * ctx.usd.get(l.from === ctx.token ? l.to : l.from);
      const priceBuy = tokenUsd(legs[0]);
      const priceSell = tokenUsd(legs[1]);
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
        capUsd: judged.capUsd,
        floatUsd: judged.floatUsd,
        pays: judged.takes,
        why: judged.why,
        sizedBy: judged.sizedBy,
        threeSwap: legs.length === 3,
      });
    }
  }
  return rankTrips(trips, 'profit');
}

/** spl-token-2022 extensions the robot refuses in a coin (keeper token gate, plan step 8). */
const REFUSED_EXTENSIONS = { 9: 'it cannot be transferred', 12: 'a permanent delegate can take it from any account', 14: 'a transfer hook runs on every transfer', 26: 'a pause switch can stop every transfer' };
const FREEZE_OK = new Set([USDC_MINT, USDT_MINT]);

/**
 * The token gate, read from the mint account itself: `{ decimals, program, problem }`, where
 * `problem` (null when it passes) says why the robot must not trade the token: a transfer fee,
 * a transfer hook, a permanent delegate, accounts frozen from the start, or a live freeze
 * authority (USDC and USDT keep one by design).
 */
export function tokenGate(mint, account) {
  if (!account || !Buffer.isBuffer(account.data)) return { decimals: null, program: null, problem: 'its mint was not read' };
  const { data, owner } = account;
  if ((owner !== TOKEN_PROGRAM && owner !== TOKEN_2022_PROGRAM) || data.length < 82 || data[45] !== 1) return { decimals: null, program: owner, problem: 'not a token mint' };
  const out = { decimals: data[44], program: owner, problem: null };
  if (u32(data, 46) === 1 && !FREEZE_OK.has(mint)) return { ...out, problem: 'a live freeze authority can freeze any account of it' };
  if (owner === TOKEN_2022_PROGRAM && data.length > 166 && data[165] === 1) {
    for (let at = 166; at + 4 <= data.length; ) {
      const type = u16(data, at);
      const len = u16(data, at + 2);
      const v = data.subarray(at + 4, at + 4 + len);
      if (type === 0) break;
      if (type === 1 && v.length >= 108 && (u16(v, 88) > 0 || u16(v, 106) > 0)) return { ...out, problem: 'it keeps a fee out of every transfer' };
      if (type === 6 && v[0] === 2) return { ...out, problem: 'new accounts of it start frozen' };
      const set = (from) => v.length >= from + 32 && !v.subarray(from, from + 32).equals(Buffer.alloc(32));
      // A delegate or hook slot left empty is no delegate or hook.
      if (type === 9 || type === 26 || (type === 12 && set(0)) || (type === 14 && set(32))) return { ...out, problem: REFUSED_EXTENSIONS[type] };
      at += 4 + len;
    }
  }
  return out;
}

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
