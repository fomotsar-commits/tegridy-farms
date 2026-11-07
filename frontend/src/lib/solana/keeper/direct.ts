import { PublicKey, type TransactionInstruction } from '@solana/web3.js';
import type { SolanaRpc } from '../../launcher/solana/curve/rpc';
import { getMultipleAccounts, type RawAccount } from '../lp/accounts';
import type { PoolView } from '../lp/poolFinder';
import { SOL_QUOTE } from '../lp/quotes';
import { TOKEN_PROGRAM_ID } from '../cpswap/ix';
import { vaultAmountWithoutFee } from '../cpswap/math';
import { decodeAmmConfig, decodePoolState } from '../cpswap/program';
import { quoteOwnPool, type PoolSnapshot } from '../cpswap/read';
import {
  PUMP_AMM, PUMP_BUYBACK_RECIPIENTS, PUMP_FEE_CONFIG, PUMP_GLOBAL_CONFIG,
  ammV4Leg, ammV4Out, ammV4Swaps, cpLeg, decodeAmmV4, decodePumpFeeConfig, decodePumpPool,
  pumpBuyCost, pumpBuyLeg, pumpBuyOut, pumpFeesFor, pumpSellLeg, pumpSellOut,
} from './directLegs';
import { coinBounds, type RuleSettings } from './rule';
import type { StreamPool } from './streams';

/**
 * Direct trips (owner 2026-11-07: "finds better arbs faster and executes them"): one of OUR pools
 * against the same coin's pool on an outside exchange whose swap the robot builds itself
 * (keeper/directLegs.ts: PumpSwap, Raydium CPMM, Raydium AMM v4). Both legs are priced by each
 * program's own integer maths, so a trip is planned and test-run with NO Jupiter call: no
 * keyless-Jupiter allowance to wait for (one call per ~2 s per PC, refused 50-70 times an hour on
 * 11-06/07), and no quote that comes back short of the listed price. Most of our coins' deepest
 * outside pool is one of these three (BAYLA, BOBO, TBB, OGDOGE, SOY, APE, BRAINLET on PumpSwap;
 * KWIF, BIG BRAIN, Rizz, CRYING on AMM v4; GROYPER on CPMM, 2026-11-07).
 *
 * SOL trips only (every such pool here is priced in SOL), and only for coins with no transfer fee:
 * a fee changes what each leg receives, and these legs are priced without one.
 */

const SOL = SOL_QUOTE.mint;

/**
 * The lookup table a direct trip compiles with: Jupiter's, which its own PumpSwap routes use (241
 * addresses read 2026-11-07, among them PumpSwap's global config, fee accounts, event authority
 * and the token programs). A PumpSwap trip names 33-35 accounts, too many for one transaction
 * without it; with it the BAYLA trip is 909-945 bytes of 1,232 (scripts/direct-trip-proof.mjs).
 * A table that cannot be read stops the trip before its test run; KEEPER_DIRECT_ALTS names others.
 */
export const DIRECT_LOOKUP_TABLES: readonly string[] = ['9SJWZWkg567QtxKQxBQFffQHNtoDJZzk6PUXan2cbfDQ'];

/** Raydium's two programs (and AMM v4's authority), handed in by scripts/price-keeper.mjs: src/ may not name them. */
export interface DirectIds {
  cpmm: string;
  ammV4: string;
  ammV4Authority: string;
}

/** An outside pool of one coin against SOL, as the robot trades it: exact payouts, and the swaps. */
export interface DirectPool {
  address: string;
  venue: 'PumpSwap' | 'Raydium CPMM' | 'Raydium AMM v4';
  tokenMint: string;
  /** SOL in: the coin it buys, exactly, and the SOL it really takes (a PumpSwap buy can take a little less than offered). */
  buy(solIn: bigint): { tokens: bigint; spent: bigint } | null;
  /** The coin in: the SOL it sells for, exactly. */
  sell(tokensIn: bigint): bigint | null;
  /** The buy: `solIn` offered, at least `minTokens` out (a PumpSwap buy: exactly the coin `buy` says, for at most `solIn`). */
  buyIx(owner: PublicKey, solIn: bigint, minTokens: bigint): TransactionInstruction | null;
  sellIx(owner: PublicKey, tokensIn: bigint, minSol: bigint): TransactionInstruction | null;
}

const amountOf = (a: RawAccount | null | undefined): bigint | null => (a && a.data.length >= 72 ? new DataView(a.data.buffer, a.data.byteOffset, a.data.byteLength).getBigUint64(64, true) : null);

/**
 * The listed outside pools (the robot's own list, keeper/streams.ts) that are PumpSwap, or Raydium
 * CPMM or AMM v4 when `ids` is given (KEEPER_ALLOW_RAYDIUM), priced in SOL: read in two calls, and
 * each kept only once it decodes. `pick` chooses Pump's buyback fee recipient (spread over them).
 */
export async function readDirectPools(rpc: SolanaRpc, listed: readonly StreamPool[], ids: DirectIds | null, nowSecs: number, pick: () => number = Math.random): Promise<DirectPool[]> {
  const venueOf = (program: string) => (program === PUMP_AMM.toBase58() ? 'pump' : ids && program === ids.cpmm ? 'cpmm' : ids && program === ids.ammV4 ? 'ammV4' : null);
  const wanted = listed.filter((l) => venueOf(l.program));
  if (!wanted.length) return [];
  const first = await getMultipleAccounts(rpc, wanted.map((l) => l.pool));
  type Pending = { l: StreamPool; venue: 'pump' | 'cpmm' | 'ammV4'; a: RawAccount; more: string[] };
  const pending: Pending[] = [];
  wanted.forEach((l, i) => {
    const a = first[i];
    const venue = venueOf(l.program);
    if (!a || !venue || a.owner !== l.program) return;
    if (venue === 'pump') {
      const p = decodePumpPool(l.pool, a.data);
      if (p && p.quoteMint === SOL && p.baseMint === l.mint) pending.push({ l, venue, a, more: [p.baseVault, p.quoteVault, p.baseMint] });
    } else if (venue === 'cpmm') {
      const p = decodePoolState(l.pool, a.data);
      if (p && [p.token0Mint, p.token1Mint].includes(SOL) && [p.token0Mint, p.token1Mint].includes(l.mint)) pending.push({ l, venue, a, more: [p.token0Vault, p.token1Vault, p.ammConfig] });
    } else {
      const p = decodeAmmV4(l.pool, a.data);
      if (p && [p.coinMint, p.pcMint].includes(SOL) && [p.coinMint, p.pcMint].includes(l.mint)) pending.push({ l, venue, a, more: [p.coinVault, p.pcVault] });
    }
  });
  if (!pending.length) return [];
  const pumpShared = pending.some((x) => x.venue === 'pump') ? [PUMP_GLOBAL_CONFIG.toBase58(), PUMP_FEE_CONFIG.toBase58()] : [];
  const keys = [...new Set([...pending.flatMap((x) => x.more), ...pumpShared])];
  const got = new Map((await getMultipleAccounts(rpc, keys)).map((a, i) => [keys[i]!, a]));
  const out: DirectPool[] = [];
  for (const x of pending) {
    const d = x.venue === 'pump' ? pumpPool(x.a, x.l.pool, got, pick) : x.venue === 'cpmm' ? cpmmPool(x.a, x.l.pool, got, ids!, nowSecs) : ammV4Pool(x.a, x.l.pool, got, ids!, nowSecs);
    if (d) out.push(d);
  }
  return out;
}

function pumpPool(a: RawAccount, address: string, got: ReadonlyMap<string, RawAccount | null>, pick: () => number): DirectPool | null {
  const p = decodePumpPool(address, a.data)!;
  const cfgAcc = got.get(PUMP_FEE_CONFIG.toBase58());
  const global = got.get(PUMP_GLOBAL_CONFIG.toBase58());
  const mint = got.get(p.baseMint);
  const base = amountOf(got.get(p.baseVault));
  const vault = amountOf(got.get(p.quoteVault));
  const cfg = cfgAcc ? decodePumpFeeConfig(cfgAcc.data) : null;
  if (!cfg || !global || global.data.length < 89 || !mint || mint.data.length < 44 || base === null || vault === null) return null;
  const quote = vault + p.quoteExtra;
  if (base <= 0n || quote <= 0n) return null;
  const supply = new DataView(mint.data.buffer, mint.data.byteOffset, mint.data.byteLength).getBigUint64(36, true);
  const fees = pumpFeesFor(p, cfg, base, quote, supply);
  const recipients = PUMP_BUYBACK_RECIPIENTS;
  const ctx = {
    protocolFeeRecipient: new PublicKey(global.data.subarray(57, 89)),
    buybackRecipient: new PublicKey(recipients[Math.floor(pick() * recipients.length) % recipients.length]!),
    baseProgram: new PublicKey(mint.owner),
    quoteProgram: TOKEN_PROGRAM_ID,
  };
  return {
    address, venue: 'PumpSwap', tokenMint: p.baseMint,
    buy: (solIn) => {
      const tokens = pumpBuyOut(p, fees, base, quote, solIn);
      const spent = tokens === null ? null : pumpBuyCost(p, fees, base, quote, tokens);
      return tokens === null || spent === null ? null : { tokens, spent };
    },
    sell: (tokensIn) => pumpSellOut(p, fees, base, quote, tokensIn),
    buyIx: (owner, solIn, minTokens) => pumpBuyLeg(p, fees, base, quote, owner, ctx, solIn, minTokens)?.ix ?? null,
    sellIx: (owner, tokensIn, minSol) => pumpSellLeg(p, fees, base, quote, owner, ctx, tokensIn, minSol)?.ix ?? null,
  };
}

function cpmmPool(a: RawAccount, address: string, got: ReadonlyMap<string, RawAccount | null>, ids: DirectIds, nowSecs: number): DirectPool | null {
  const pool = decodePoolState(address, a.data)!;
  const cfgAcc = got.get(pool.ammConfig);
  const config = cfgAcc ? decodeAmmConfig(pool.ammConfig, cfgAcc.data) : null;
  const vault0 = amountOf(got.get(pool.token0Vault));
  const vault1 = amountOf(got.get(pool.token1Vault));
  if (!config || vault0 === null || vault1 === null) return null;
  const reserve0 = vaultAmountWithoutFee(vault0, pool.protocolFeesToken0, pool.fundFeesToken0, pool.creatorFeesToken0);
  const reserve1 = vaultAmountWithoutFee(vault1, pool.protocolFeesToken1, pool.fundFeesToken1, pool.creatorFeesToken1);
  if (reserve0 === null || reserve1 === null) return null;
  const snapshot: PoolSnapshot = { pool, vault0Amount: vault0, vault1Amount: vault1, reserve0, reserve1 };
  const token = pool.token0Mint === SOL ? pool.token1Mint : pool.token0Mint;
  const program = new PublicKey(ids.cpmm);
  const cp = { pool, config, vault0, vault1 };
  const out = (from: string, x: bigint) => quoteOwnPool(snapshot, config, from, x, nowSecs)?.outAmount ?? null;
  return {
    address, venue: 'Raydium CPMM', tokenMint: token,
    buy: (solIn) => {
      const tokens = out(SOL, solIn);
      return tokens !== null && tokens > 0n ? { tokens, spent: solIn } : null;
    },
    sell: (tokensIn) => out(token, tokensIn),
    buyIx: (owner, solIn, minTokens) => cpLeg(cp, owner, SOL, solIn, minTokens, program, nowSecs)?.ix ?? null,
    sellIx: (owner, tokensIn, minSol) => cpLeg(cp, owner, token, tokensIn, minSol, program, nowSecs)?.ix ?? null,
  };
}

function ammV4Pool(a: RawAccount, address: string, got: ReadonlyMap<string, RawAccount | null>, ids: DirectIds, nowSecs: number): DirectPool | null {
  const p = decodeAmmV4(address, a.data)!;
  const coinVault = amountOf(got.get(p.coinVault));
  const pcVault = amountOf(got.get(p.pcVault));
  if (coinVault === null || pcVault === null || !ammV4Swaps(p, nowSecs)) return null;
  const token = p.coinMint === SOL ? p.pcMint : p.coinMint;
  const amm = { program: new PublicKey(ids.ammV4), authority: new PublicKey(ids.ammV4Authority) };
  const out = (from: string, x: bigint) => ammV4Out(p, coinVault, pcVault, from === p.coinMint, x);
  return {
    address, venue: 'Raydium AMM v4', tokenMint: token,
    buy: (solIn) => {
      const tokens = out(SOL, solIn);
      return tokens !== null && tokens > 0n ? { tokens, spent: solIn } : null;
    },
    sell: (tokensIn) => out(token, tokensIn),
    buyIx: (owner, solIn, minTokens) => ammV4Leg(p, coinVault, pcVault, owner, SOL, solIn, minTokens, amm, nowSecs)?.ix ?? null,
    sellIx: (owner, tokensIn, minSol) => ammV4Leg(p, coinVault, pcVault, owner, token, tokensIn, minSol, amm, nowSecs)?.ix ?? null,
  };
}

/** The best trip between one of our pools and an outside pool of the same coin. */
export interface DirectPlan {
  /** Where the coin is bought: in our pool and sold outside, or outside and sold in ours. */
  buyIn: 'ours' | 'outside';
  /** SOL offered to the first leg. */
  coinIn: bigint;
  /** What the first leg pays out, exactly: the first leg's minimum and the second leg's input. */
  tokens: bigint;
  /** SOL the first leg really takes (at most coinIn). */
  spent: bigint;
  /** What the second leg pays, by its maths now. */
  coinOut: bigint;
  /** coinOut − spent. */
  profit: bigint;
  /** The rule's floor (keeper/rule.ts): the robot's minimum profit and the network fee. */
  minProfit: bigint;
}

/**
 * The best direct trip, or null when none clears the floor. As between two of our pools
 * (plan.ts ownPairPlan): on x·y = k legs a trip's profit rises with its size, peaks and falls, so
 * the peak is found by narrowing the range on whole lamports, never past the rule's cap or `holds`.
 */
export function directPlan(ours: PoolView, outside: DirectPool, nowSecs: number, usd: ReadonlyMap<string, number>, limits: RuleSettings, holds: bigint): DirectPlan | null {
  if (ours.quote.mint !== SOL || !ours.config || ours.tokenMint !== outside.tokenMint) return null;
  const bounds = coinBounds(ours.quote, usd.get(SOL), usd.get(SOL), limits);
  if (typeof bounds === 'string') return null;
  const { floor: minProfit, cap } = bounds;
  const most = holds < cap ? holds : cap;
  if (most < 1n) return null;
  const config = ours.config;
  const ourOut = (from: string, x: bigint) => quoteOwnPool(ours.snapshot, config, from, x, nowSecs)?.outAmount ?? null;
  const ways = {
    ours: (x: bigint) => {
      const tokens = ourOut(SOL, x);
      const back = tokens !== null && tokens > 0n ? outside.sell(tokens) : null;
      return tokens === null || back === null ? null : { tokens, spent: x, coinOut: back };
    },
    outside: (x: bigint) => {
      const b = outside.buy(x);
      const back = b ? ourOut(ours.tokenMint, b.tokens) : null;
      return !b || back === null ? null : { tokens: b.tokens, spent: b.spent, coinOut: back };
    },
  } as const;
  let best: DirectPlan | null = null;
  for (const buyIn of ['ours', 'outside'] as const) {
    const trip = ways[buyIn];
    const gain = (x: bigint) => {
      const t = trip(x);
      return t ? t.coinOut - t.spent : -(10n ** 30n);
    };
    let lo = 1n;
    let hi = most;
    while (hi - lo > 2n) {
      const m1 = lo + (hi - lo) / 3n;
      const m2 = hi - (hi - lo) / 3n;
      if (gain(m1) < gain(m2)) lo = m1;
      else hi = m2;
    }
    for (let x = lo; x <= hi; x++) {
      const t = trip(x);
      if (!t) continue;
      const profit = t.coinOut - t.spent;
      if (profit < minProfit || (best && profit <= best.profit)) continue;
      best = { buyIn, coinIn: x, tokens: t.tokens, spent: t.spent, coinOut: t.coinOut, profit, minProfit };
    }
  }
  return best;
}
