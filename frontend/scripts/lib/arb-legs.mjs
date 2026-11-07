/**
 * The swaps of a trip the engine hands the robot (keeper/engine.ts), built by the robot from its
 * OWN read of each pool, one leg a pool, for every venue the engine prices to the unit:
 *
 *   ours, Raydium CPMM   cp-swap swap_base_input (keeper/directLegs.ts cpLeg)
 *   Raydium AMM v4       swap_base_in_v2 (directLegs.ts ammV4Leg)
 *   PumpSwap             buy (the quote coin in) and sell (the base coin in) (directLegs.ts); a pool
 *                        priced in a coin other than SOL (a memecoin's pool in another memecoin)
 *                        is built the same way, its quote's token program read from its mint
 *   Orca                 swap_v2 with the three tick arrays in the walk's direction and the pool's
 *                        Oracle (an adaptive-fee pool reads its fee from it; a static one passes
 *                        the address unread), quoted by lib/arb-venues.mjs orcaQuote
 *   Raydium CLMM         swap_v2 (clmm/ix.ts, Raydium's program id handed in) with the tick
 *                        arrays the range-pool port walked and the far-band map when it reached
 *                        past the pool's own, quoted by quoteSwapAsRaydium
 *   Meteora DLMM         swap2 with the bin arrays in the walk's direction, quoted by dlmmQuote
 *   Meteora DAMM v2      swap, quoted by dammQuote
 *
 * Each leg answers what the program pays for an amount in, exactly, and the instruction for an
 * amount in and a minimum out; a walk that would need an array the instruction does not carry
 * answers null, never a guess. Kept here, out of src/: Raydium's program ids are handed in
 * (scripts/lib/raydium-programs.mjs), and nothing the site ships may name one. Every account
 * list is held to a mainnet simulation by scripts/arb-route-proof.mjs.
 */
import { createHash } from 'node:crypto';
import { PublicKey, TransactionInstruction } from '@solana/web3.js';
import { getAssociatedTokenAddressSync } from '@solana/spl-token';
import * as C from './arb-chain.mjs';
import * as V from './arb-venues.mjs';
import {
  PUMP_BUYBACK_RECIPIENTS, PUMP_FEE_CONFIG, PUMP_GLOBAL_CONFIG,
  ammV4Leg, ammV4Out, ammV4Swaps, cpLeg, decodeAmmV4, decodePumpFeeConfig, decodePumpPool, pumpBuyLeg, pumpBuyOut, pumpFeesFor, pumpSellLeg, pumpSellOut,
} from '../../src/lib/solana/keeper/directLegs.ts';
import { REGISTERED_PROGRAM_ID, decodeAmmConfig, decodePoolState } from '../../src/lib/solana/cpswap/program.ts';
import { MEMO_PROGRAM_ID } from '../../src/lib/solana/cpswap/ix.ts';
import { vaultAmountWithoutFee } from '../../src/lib/solana/cpswap/math.ts';
import { quoteOwnPool } from '../../src/lib/solana/cpswap/read.ts';
import { swapV2Ix } from '../../src/lib/solana/clmm/ix.ts';
import { quoteSwapAsRaydium } from '../../src/lib/solana/clmm/quote.ts';

const pk = (s) => (s instanceof PublicKey ? s : new PublicKey(s));
const anchorTag = (name) => createHash('sha256').update(`global:${name}`).digest().subarray(0, 8);
const le64 = (n) => {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(BigInt(n));
  return b;
};
const le128 = (n) => {
  const b = Buffer.alloc(16);
  b.writeBigUInt64LE(BigInt(n) & ((1n << 64n) - 1n));
  b.writeBigUInt64LE(BigInt(n) >> 64n, 8);
  return b;
};
const meta = (key, isWritable, isSigner = false) => ({ pubkey: pk(key), isSigner, isWritable });
const pda = (program, seeds) => PublicKey.findProgramAddressSync(seeds.map((s) => (typeof s === 'string' ? Buffer.from(s) : pk(s).toBuffer())), pk(program))[0];
const tokenAmount = (a) => (a?.data && a.data.length >= 72 ? a.data.readBigUInt64LE(64) : null);

/** The instruction tags (Anchor: sha256("global:<name>")[0..8]) of the swaps built here. */
export const TAGS = Object.freeze({ orcaSwapV2: anchorTag('swap_v2'), dlmmSwap2: anchorTag('swap2'), dammSwap: anchorTag('swap') });

export const ORCA_PROGRAM = new PublicKey(V.WHIRLPOOL_PROGRAM);
export const DLMM_PROGRAM = new PublicKey(V.DLMM_PROGRAM);
export const DAMM_PROGRAM = new PublicKey(V.DAMM_PROGRAM);
/** Meteora's event authorities (["__event_authority"]) and DAMM v2's pool authority (["pool_authority"]). */
export const DLMM_EVENT_AUTHORITY = pda(DLMM_PROGRAM, ['__event_authority']);
export const DAMM_EVENT_AUTHORITY = pda(DAMM_PROGRAM, ['__event_authority']);
export const DAMM_POOL_AUTHORITY = pda(DAMM_PROGRAM, ['pool_authority']);
/** A DLMM pool's Oracle sits at byte 552 of its LbPair (after the two reward infos). */
export const DLMM_ORACLE_AT = 552;
/**
 * Orca's price bounds (whirlpool's MIN_SQRT_PRICE_X64 and MAX_SQRT_PRICE_X64, ticks ±443,636):
 * the limit a swap passes to take all the liquidity there is. Raydium's upper bound is a little
 * higher, and Orca refuses it (SqrtPriceOutOfBounds, proven 2026-11-07).
 */
export const ORCA_MIN_SQRT_PRICE = 4295048016n;
export const ORCA_MAX_SQRT_PRICE = 79226673515401279992447579055n;

/* ───────────────────────────── Orca Whirlpools ───────────────────────────── */

/**
 * The three tick arrays an Orca swap passes, in the walk's direction from the array holding the
 * current tick (the SDK's choice: for b → a the tick one spacing up, so a tick on an array's
 * edge starts the next array). Arrays the chain has not made are passed too: the program reads
 * one it cannot find as empty (sparse swaps).
 */
export function orcaSwapArrays(pool, w, aToB) {
  const per = V.ORCA_TICKS_PER_ARRAY * w.tickSpacing;
  const start = V.orcaArrayStart(w.tickCurrent + (aToB ? 0 : w.tickSpacing), w.tickSpacing);
  return [0, 1, 2].map((i) => start + (aToB ? -i : i) * per).map((s) => ({ start: s, address: V.orcaArrayAddress(pool, s) }));
}

/**
 * Orca `swap_v2`: exactly `amountIn` of one coin for at least `minOut` of the other, through the
 * three arrays given (in walking order) and the pool's Oracle. `programs` are the two coins' token
 * programs (A's, B's), as their mints say.
 */
export function orcaSwapIx(pool, owner, aToB, amountIn, minOut, arrays, programs) {
  const [progA, progB] = programs;
  const limit = aToB ? ORCA_MIN_SQRT_PRICE : ORCA_MAX_SQRT_PRICE;
  const keys = [
    meta(progA, false), meta(progB, false), meta(MEMO_PROGRAM_ID, false), meta(owner, false, true), meta(pool.address, true),
    meta(pool.mintA, false), meta(pool.mintB, false),
    meta(getAssociatedTokenAddressSync(pk(pool.mintA), pk(owner), true, pk(progA)), true), meta(pool.vaultA, true),
    meta(getAssociatedTokenAddressSync(pk(pool.mintB), pk(owner), true, pk(progB)), true), meta(pool.vaultB, true),
    ...arrays.slice(0, 3).map((a) => meta(a, true)),
    meta(V.orcaOracleAddress(pool.address), true),
  ];
  // amount, other_amount_threshold, sqrt_price_limit, amount_specified_is_input, a_to_b, remaining_accounts_info: None
  const data = Buffer.concat([TAGS.orcaSwapV2, le64(amountIn), le64(minOut), le128(limit), Buffer.from([1, aToB ? 1 : 0, 0])]);
  return new TransactionInstruction({ programId: ORCA_PROGRAM, keys, data });
}

/* ───────────────────────────── Meteora DLMM ─────────────────────────────── */

/** The bin arrays a DLMM swap passes: the active bin's and the next two in the walk's direction, those the map marks in use. */
export function dlmmSwapArrays(pool, p, swapForY) {
  const idx = V.dlmmArrayIndex(p.activeId);
  return [0, 1, 2].map((i) => idx + (swapForY ? -i : i)).filter((i) => V.dlmmArrayInUse(p, i)).map((i) => ({ index: i, address: V.dlmmArrayAddress(pool, i) }));
}

/**
 * Meteora DLMM `swap2`: exactly `amountIn` of one coin for at least `minOut` of the other, the bin
 * arrays given as remaining accounts. No bitmap extension and no host fee account (the program's
 * own id stands in for each, as Anchor reads an absent optional account); no remaining-account
 * slices (no transfer hooks).
 */
export function dlmmSwapIx(pool, oracle, owner, swapForY, amountIn, minOut, arrays, programs) {
  const [progX, progY] = programs;
  const [mintIn, mintOut, progIn, progOut] = swapForY ? [pool.mintA, pool.mintB, progX, progY] : [pool.mintB, pool.mintA, progY, progX];
  const keys = [
    meta(pool.address, true), meta(DLMM_PROGRAM, false), meta(pool.vaultA, true), meta(pool.vaultB, true),
    meta(getAssociatedTokenAddressSync(pk(mintIn), pk(owner), true, pk(progIn)), true), meta(getAssociatedTokenAddressSync(pk(mintOut), pk(owner), true, pk(progOut)), true),
    meta(pool.mintA, false), meta(pool.mintB, false), meta(oracle, true), meta(DLMM_PROGRAM, false), meta(owner, false, true),
    meta(progX, false), meta(progY, false), meta(MEMO_PROGRAM_ID, false), meta(DLMM_EVENT_AUTHORITY, false), meta(DLMM_PROGRAM, false),
    ...arrays.map((a) => meta(a, true)),
  ];
  // amount_in, min_amount_out, remaining_accounts_info { slices: [] }
  const data = Buffer.concat([TAGS.dlmmSwap2, le64(amountIn), le64(minOut), Buffer.alloc(4)]);
  return new TransactionInstruction({ programId: DLMM_PROGRAM, keys, data });
}

/* ───────────────────────────── Meteora DAMM v2 ───────────────────────────── */

/** Meteora DAMM v2 `swap`: exactly `amountIn` of one coin for at least `minOut` of the other; no referral account. */
export function dammSwapIx(pool, owner, aToB, amountIn, minOut, programs) {
  const [progA, progB] = programs;
  const [mintIn, mintOut, progIn, progOut] = aToB ? [pool.mintA, pool.mintB, progA, progB] : [pool.mintB, pool.mintA, progB, progA];
  const keys = [
    meta(DAMM_POOL_AUTHORITY, false), meta(pool.address, true),
    meta(getAssociatedTokenAddressSync(pk(mintIn), pk(owner), true, pk(progIn)), true), meta(getAssociatedTokenAddressSync(pk(mintOut), pk(owner), true, pk(progOut)), true),
    meta(pool.vaultA, true), meta(pool.vaultB, true), meta(pool.mintA, false), meta(pool.mintB, false), meta(owner, false, true),
    meta(progA, false), meta(progB, false), meta(DAMM_PROGRAM, false), meta(DAMM_EVENT_AUTHORITY, false), meta(DAMM_PROGRAM, false),
  ];
  const data = Buffer.concat([TAGS.dammSwap, le64(amountIn), le64(minOut)]);
  return new TransactionInstruction({ programId: DAMM_PROGRAM, keys, data });
}

/* ───────────────────────────── the reader ───────────────────────────────── */

/**
 * A reader of routes: given a handover (keeper/engine.ts EngineRecord), the robot's wallet and
 * the chain's clock, reads every account each leg needs (two rounds at most, one call a round
 * per hundred accounts) and answers the legs built, or why not. `rpc(method, params)` is the
 * robot's; `ids` Raydium's program ids ({ cpmm, ammV4, ammV4Authority, clmm }); `pick` chooses
 * PumpSwap's buyback recipient.
 */
export function routeLegReader({ rpc, ids, pick = Math.random, commitment = 'confirmed' }) {
  const idOf = { ours: REGISTERED_PROGRAM_ID.toBase58(), cpmm: ids?.cpmm, ammV4: ids?.ammV4, clmm: ids?.clmm, pumpswap: C.DEXES.pumpswap.program, whirlpool: V.WHIRLPOOL_PROGRAM, dlmm: V.DLMM_PROGRAM, damm: V.DAMM_PROGRAM };
  const acc = new Map();
  let slot = null;
  async function read(keys) {
    const want = [...new Set(keys)].filter((k) => k && !acc.has(k));
    for (let i = 0; i < want.length; i += 100) {
      const part = want.slice(i, i + 100);
      const r = await rpc('getMultipleAccounts', [part, { encoding: 'base64', commitment }]);
      if (!Array.isArray(r?.value) || r.value.length !== part.length) throw new Error('the pools were not read');
      slot = Math.max(slot ?? 0, Number(r.context?.slot ?? 0));
      part.forEach((k, j) => acc.set(k, r.value[j] ? { owner: r.value[j].owner, data: Buffer.from(r.value[j].data[0], 'base64') } : null));
    }
  }
  const programOf = (rec, mint) => {
    const read = acc.get(mint)?.owner;
    const p = read ?? rec.mints[mint] ?? null;
    return p ? pk(p) : null;
  };

  return async function readRouteLegs(rec, owner, nowSecs) {
    acc.clear();
    slot = null;
    const mints = [...new Set(rec.legs.flatMap((l) => [l.from, l.to]))];
    const pump = rec.legs.some((l) => l.dex === 'pumpswap');
    await read([...rec.legs.flatMap((l) => [l.pool, ...l.accounts]), ...mints, ...(pump ? [PUMP_GLOBAL_CONFIG.toBase58(), PUMP_FEE_CONFIG.toBase58()] : [])]);
    // Round two: what each pool's account names (vaults, a fee config, the arrays near its price).
    const more = [];
    const pools = [];
    for (const l of rec.legs) {
      const a = acc.get(l.pool);
      if (!a) return `pool ${l.pool} not found`;
      if (a.owner !== idOf[l.dex]) return `pool ${l.pool} is not a ${C.DEXES[l.dex]?.name ?? l.dex} pool`;
      const p = C.decodePool(l.dex, l.pool, a.data);
      if (!p || ![p.mintA, p.mintB].includes(l.from) || ![p.mintA, p.mintB].includes(l.to)) return `pool ${l.pool} is not a ${C.DEXES[l.dex]?.name ?? l.dex} pool of this pair`;
      if (p.stopped) return `pool ${l.pool}: ${p.stopped}`;
      pools.push(p);
      const aToB = p.mintA === l.from;
      if (l.dex === 'ours' || l.dex === 'cpmm') more.push(p.config, p.vaultA, p.vaultB);
      else if (l.dex === 'ammV4' || l.dex === 'pumpswap') more.push(p.vaultA, p.vaultB);
      else if (l.dex === 'whirlpool') {
        const w = V.whirlpoolState(a.data);
        if (w) more.push(...orcaSwapArrays(l.pool, w, aToB).map((x) => x.address), ...(w.adaptive ? [V.orcaOracleAddress(l.pool)] : []));
      } else if (l.dex === 'clmm') {
        const pool = V.decodeClmmPool(l.pool, a.data);
        if (pool) more.push(pool.ammConfig, V.clmmExtensionAddress(l.pool), ...V.clmmArraysNear(l.pool, pool, null).map((x) => x.address));
      } else if (l.dex === 'dlmm') {
        const st = V.lbPairState(a.data);
        if (st) more.push(...dlmmSwapArrays(l.pool, st, aToB).map((x) => x.address));
      }
    }
    await read(more);
    const legs = [];
    for (const [i, l] of rec.legs.entries()) {
      const p = pools[i];
      const [progFrom, progTo] = [programOf(rec, l.from), programOf(rec, l.to)];
      if (!progFrom || !progTo) return `the token program of a coin in ${l.pool} was not read`;
      const built = buildLeg(l, p, acc, owner, nowSecs, { ids, pick, programOf: (m) => programOf(rec, m), slot });
      if (typeof built === 'string') return `${C.DEXES[l.dex]?.name ?? l.dex} ${l.pool}: ${built}`;
      legs.push({ pool: l.pool, dex: l.dex, venue: C.DEXES[l.dex]?.name ?? l.dex, from: l.from, to: l.to, fromProgram: progFrom, toProgram: progTo, ...built });
    }
    return { legs, slot };
  };
}

/** One leg's `out` and `ix` from the accounts read, or why it cannot be built. */
function buildLeg(l, p, acc, owner, nowSecs, { ids, pick, programOf, slot }) {
  const aToB = p.mintA === l.from;
  const own = pk(owner);
  switch (l.dex) {
    case 'ours':
    case 'cpmm': {
      const pool = decodePoolState(l.pool, acc.get(l.pool).data);
      const cfgAcc = acc.get(p.config);
      const config = cfgAcc && decodeAmmConfig(p.config, cfgAcc.data);
      const vault0 = tokenAmount(acc.get(pool?.token0Vault));
      const vault1 = tokenAmount(acc.get(pool?.token1Vault));
      if (!pool || !config || vault0 === null || vault1 === null) return 'its fee settings or vaults were not read';
      const reserve0 = vaultAmountWithoutFee(vault0, pool.protocolFeesToken0, pool.fundFeesToken0, pool.creatorFeesToken0);
      const reserve1 = vaultAmountWithoutFee(vault1, pool.protocolFeesToken1, pool.fundFeesToken1, pool.creatorFeesToken1);
      if (reserve0 === null || reserve1 === null) return 'its vaults hold less than the fees it owes';
      const snapshot = { pool, vault0Amount: vault0, vault1Amount: vault1, reserve0, reserve1 };
      const programId = l.dex === 'ours' ? REGISTERED_PROGRAM_ID : pk(ids.cpmm);
      const cp = { pool, config, vault0, vault1 };
      return {
        out: (x) => quoteOwnPool(snapshot, config, l.from, x, nowSecs)?.outAmount ?? null,
        ix: (x, minOut) => cpLeg(cp, own, l.from, x, minOut, programId, nowSecs)?.ix ?? null,
      };
    }
    case 'ammV4': {
      const pool = decodeAmmV4(l.pool, acc.get(l.pool).data);
      const coinVault = tokenAmount(acc.get(pool?.coinVault));
      const pcVault = tokenAmount(acc.get(pool?.pcVault));
      if (!pool || coinVault === null || pcVault === null) return 'its vaults were not read';
      if (!ammV4Swaps(pool, nowSecs)) return 'it is not trading now';
      const amm = { program: pk(ids.ammV4), authority: pk(ids.ammV4Authority) };
      return {
        out: (x) => ammV4Out(pool, coinVault, pcVault, l.from === pool.coinMint, x),
        ix: (x, minOut) => ammV4Leg(pool, coinVault, pcVault, own, l.from, x, minOut, amm, nowSecs)?.ix ?? null,
      };
    }
    case 'pumpswap': {
      const pool = decodePumpPool(l.pool, acc.get(l.pool).data);
      if (!pool) return 'not a PumpSwap pool';
      if (l.from !== pool.quoteMint && l.from !== pool.baseMint) return 'not a pool of this coin';
      const quoteProgram = programOf(pool.quoteMint);
      if (!quoteProgram) return 'its quote coin’s mint was not read';
      const cfgAcc = acc.get(PUMP_FEE_CONFIG.toBase58());
      const global = acc.get(PUMP_GLOBAL_CONFIG.toBase58());
      const mint = acc.get(pool.baseMint);
      const base = tokenAmount(acc.get(pool.baseVault));
      const vault = tokenAmount(acc.get(pool.quoteVault));
      const cfg = cfgAcc && decodePumpFeeConfig(cfgAcc.data);
      if (!cfg || !global || global.data.length < 89 || !mint || mint.data.length < 44 || base === null || vault === null) return 'its fee settings, vaults or mint were not read';
      const quote = vault + pool.quoteExtra;
      if (base <= 0n || quote <= 0n) return 'it is empty';
      const fees = pumpFeesFor(pool, cfg, base, quote, mint.data.readBigUInt64LE(36));
      const ctx = {
        protocolFeeRecipient: new PublicKey(global.data.subarray(57, 89)),
        buybackRecipient: new PublicKey(PUMP_BUYBACK_RECIPIENTS[Math.floor(pick() * PUMP_BUYBACK_RECIPIENTS.length) % PUMP_BUYBACK_RECIPIENTS.length]),
        baseProgram: pk(mint.owner),
        quoteProgram,
      };
      if (l.from === pool.quoteMint) {
        return {
          out: (x) => pumpBuyOut(pool, fees, base, quote, x),
          ix: (x, minOut) => pumpBuyLeg(pool, fees, base, quote, own, ctx, x, minOut)?.ix ?? null,
        };
      }
      return {
        out: (x) => pumpSellOut(pool, fees, base, quote, x),
        ix: (x, minOut) => pumpSellLeg(pool, fees, base, quote, own, ctx, x, minOut)?.ix ?? null,
      };
    }
    case 'whirlpool': {
      const w = V.whirlpoolState(acc.get(l.pool).data);
      if (!w) return 'not a whirlpool';
      const arrays = orcaSwapArrays(l.pool, w, aToB);
      const oracleK = V.orcaOracleAddress(l.pool);
      const oracle = w.adaptive ? V.decodeOrcaOracle(acc.get(oracleK)?.data) : null;
      if (w.adaptive && !oracle) return 'its adaptive fee’s Oracle was not read';
      const decoded = new Map(arrays.map((a) => [a.start, acc.get(a.address)?.data ? V.decodeOrcaTickArray(acc.get(a.address).data) : null]));
      // An array beyond the three the swap carries is not read: a walk reaching it is refused, as the program would.
      const array = (start) => (decoded.has(start) ? decoded.get(start) : undefined);
      const programs = [programOf(p.mintA), programOf(p.mintB)];
      if (!programs[0] || !programs[1]) return 'a mint was not read';
      const quote = (x) => {
        const q = V.orcaQuote(w, x, aToB, array, oracle, nowSecs);
        return q.needs === null && q.used === x && q.out > 0n ? q.out : null;
      };
      return { out: quote, ix: (x, minOut) => (quote(x) === null ? null : orcaSwapIx(p, own, aToB, x, minOut, arrays.map((a) => a.address), programs)) };
    }
    case 'clmm': {
      const pool = V.decodeClmmPool(l.pool, acc.get(l.pool).data);
      const cfgAcc = pool && acc.get(pool.ammConfig);
      const config = cfgAcc && V.decodeClmmConfig(pool.ammConfig, cfgAcc.data);
      if (!pool || !config) return 'its fee settings were not read';
      const extK = V.clmmExtensionAddress(l.pool);
      const extAcc = acc.get(extK);
      const ext = extAcc?.data ? V.decodeClmmExtension(extK, extAcc.data) : null;
      const band = (start) => {
        const k = V.clmmArrayAddress(l.pool, start);
        const a = acc.get(k);
        return a?.data ? (V.decodeClmmArray(k, a.data) ?? undefined) : undefined;
      };
      const quote = (x) => {
        const q = quoteSwapAsRaydium({ pool, config, extension: ext, band, zeroForOne: aToB, isBaseInput: true, amount: x, sqrtPriceLimitX64: 0n, blockTimestamp: nowSecs });
        return q.kind === 'ok' && q.filled && q.amountOut > 0n ? q : null;
      };
      return {
        out: (x) => quote(x)?.amountOut ?? null,
        ix: (x, minOut) => {
          const q = quote(x);
          if (!q) return null;
          return swapV2Ix({
            programId: pk(ids.clmm), payer: own, pool, zeroForOne: aToB,
            inputTokenAccount: getAssociatedTokenAddressSync(pk(l.from), own, true, programOf(l.from)),
            outputTokenAccount: getAssociatedTokenAddressSync(pk(l.to), own, true, programOf(l.to)),
            tickArrays: q.bands.map((start) => pk(V.clmmArrayAddress(l.pool, start))),
            bitmapExtension: q.passExtension && ext ? pk(extK) : null,
            amount: x, otherAmountThreshold: minOut, sqrtPriceLimitX64: 0n, isBaseInput: true,
          });
        },
      };
    }
    case 'dlmm': {
      const st = V.lbPairState(acc.get(l.pool).data);
      if (!st) return 'not a DLMM pair';
      if (st.status !== 0) return 'trading switched off';
      const arrays = dlmmSwapArrays(l.pool, st, aToB);
      const decoded = new Map(arrays.map((a) => [a.index, acc.get(a.address)?.data ? V.decodeBinArray(acc.get(a.address).data) : null]));
      const array = (index) => (decoded.has(index) ? decoded.get(index) : undefined);
      const oracle = new PublicKey(acc.get(l.pool).data.subarray(DLMM_ORACLE_AT, DLMM_ORACLE_AT + 32));
      const programs = [programOf(p.mintA), programOf(p.mintB)];
      if (!programs[0] || !programs[1]) return 'a mint was not read';
      const quote = (x) => {
        const q = V.dlmmQuote(st, x, aToB, nowSecs, array);
        return q.needs === null && q.used === x && q.out > 0n ? q.out : null;
      };
      const carried = arrays.filter((a) => decoded.get(a.index)).map((a) => a.address);
      return { out: quote, ix: (x, minOut) => (quote(x) === null || !carried.length ? null : dlmmSwapIx(p, oracle, own, aToB, x, minOut, carried, programs)) };
    }
    case 'damm': {
      const st = V.dammState(acc.get(l.pool).data);
      if (!st) return 'not a DAMM v2 pool';
      const programs = [programOf(p.mintA), programOf(p.mintB)];
      if (!programs[0] || !programs[1]) return 'a mint was not read';
      const when = { now: nowSecs, slot: slot ?? 0 };
      const quote = (x) => {
        const q = V.dammQuote(st, x, aToB, when);
        return !q.refused && q.out > 0n ? q.out : null;
      };
      return { out: quote, ix: (x, minOut) => (quote(x) === null ? null : dammSwapIx(p, own, aToB, x, minOut, programs)) };
    }
    default:
      return 'an exchange the robot does not build swaps for';
  }
}
