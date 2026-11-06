import { PublicKey, TransactionInstruction } from '@solana/web3.js';
import { getAssociatedTokenAddressSync } from '@solana/spl-token';
import { swapBaseInputIx, TOKEN_PROGRAM_ID } from '../cpswap/ix';
import { vaultAmountWithoutFee } from '../cpswap/math';
import type { AmmConfigView, PoolStateView } from '../cpswap/program';
import { quoteOwnPool } from '../cpswap/read';

/**
 * Swap legs the robot builds itself, with no Jupiter in the loop (owner, 2026-11-06: watch the
 * pools live and build the outside swaps ourselves, so a gap is test-run and sent within about a
 * second). Each leg gives the EXACT amount the program pays out, in its own integer rounding, and
 * the instruction, for the three x·y = k venues the scanner reads (scripts/lib/arb-chain.mjs):
 *   - Raydium CPMM: the cp-swap program, our own pools' family (cpswap/ix.ts, cpswap/read.ts);
 *   - Raydium AMM v4: swap_base_in_v2, which takes no OpenBook accounts;
 *   - PumpSwap: sell (coin in) and buy (SOL in, for an exact coin out).
 * Every account list and amount is held by a test to a mainnet simulation the program accepted.
 */

export interface DirectLeg {
  /** What the program pays out, exactly (before any Token-2022 fee on the way out). */
  out: bigint;
  ix: TransactionInstruction;
}

const pk = (s: string) => new PublicKey(s);
const ata = (owner: PublicKey, mint: string, program: string | PublicKey) => getAssociatedTokenAddressSync(pk(mint), owner, true, typeof program === 'string' ? pk(program) : program);
const u64 = (d: Uint8Array, at: number) => new DataView(d.buffer, d.byteOffset, d.byteLength).getBigUint64(at, true);
const key = (d: Uint8Array, at: number) => new PublicKey(d.subarray(at, at + 32)).toBase58();
const ceilDiv = (a: bigint, b: bigint) => (a + b - 1n) / b;
const le64 = (n: bigint) => {
  const b = new Uint8Array(8);
  new DataView(b.buffer).setBigUint64(0, n, true);
  return b;
};

/* ───────────────────────────── Raydium CPMM ───────────────────────────── */

export const RAYDIUM_CPMM = new PublicKey('CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C');

/** A cp-swap pool (Raydium CPMM or ours) as read: its state, its fee config and its two vault balances. */
export interface CpPool {
  pool: PoolStateView;
  config: Pick<AmmConfigView, 'tradeFeeRate' | 'protocolFeeRate' | 'fundFeeRate' | 'creatorFeeRate'>;
  vault0: bigint;
  vault1: bigint;
}

/** swap_base_input on a cp-swap pool: the program's own maths (cpswap/read.ts quoteOwnPool) and builder (cpswap/ix.ts). */
export function cpLeg(p: CpPool, owner: PublicKey, fromMint: string, amountIn: bigint, minOut: bigint, programId: PublicKey = RAYDIUM_CPMM, nowSecs?: number): DirectLeg | null {
  const s = p.pool;
  const reserve0 = vaultAmountWithoutFee(p.vault0, s.protocolFeesToken0, s.fundFeesToken0, s.creatorFeesToken0);
  const reserve1 = vaultAmountWithoutFee(p.vault1, s.protocolFeesToken1, s.fundFeesToken1, s.creatorFeesToken1);
  if (reserve0 === null || reserve1 === null) return null;
  const q = quoteOwnPool({ pool: s, vault0Amount: p.vault0, vault1Amount: p.vault1, reserve0, reserve1 }, p.config, fromMint, amountIn, nowSecs);
  if (!q || q.outAmount <= 0n) return null;
  const in0 = fromMint === s.token0Mint;
  const [mIn, mOut] = in0 ? [s.token0Mint, s.token1Mint] : [s.token1Mint, s.token0Mint];
  const [pIn, pOut] = in0 ? [s.token0Program, s.token1Program] : [s.token1Program, s.token0Program];
  const [vIn, vOut] = in0 ? [s.token0Vault, s.token1Vault] : [s.token1Vault, s.token0Vault];
  const ix = swapBaseInputIx({
    programId, payer: owner, ammConfig: pk(s.ammConfig), poolState: pk(s.address),
    inputTokenAccount: ata(owner, mIn, pIn), outputTokenAccount: ata(owner, mOut, pOut),
    inputVault: pk(vIn), outputVault: pk(vOut), inputTokenProgram: pk(pIn), outputTokenProgram: pk(pOut),
    inputTokenMint: pk(mIn), outputTokenMint: pk(mOut), observationState: pk(s.observationKey),
    amountIn, minimumAmountOut: minOut,
  });
  return { out: q.outAmount, ix };
}

/* ──────────────────────────── Raydium AMM v4 ──────────────────────────── */

export const RAYDIUM_AMM_V4 = new PublicKey('675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8');
/** The program's authority: PDA ["amm authority"]. */
export const AMM_V4_AUTHORITY = new PublicKey('5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1');
export const AMM_V4_SWAP_BASE_IN_V2 = 16;
const AMM_V4_SIZE = 752;
/** Initialized, SwapOnly, WaitingTrade (after its open time): the statuses that swap. */
const AMM_V4_SWAPS = new Set([1n, 6n, 7n]);

export interface AmmV4Pool {
  address: string;
  status: bigint;
  swapFeeNumerator: bigint;
  swapFeeDenominator: bigint;
  needTakePnlCoin: bigint;
  needTakePnlPc: bigint;
  openTime: bigint;
  coinVault: string;
  pcVault: string;
  coinMint: string;
  pcMint: string;
}

/** An AmmInfo account (the offsets arb-chain.mjs decodePool reads), or null when it is not one. */
export function decodeAmmV4(address: string, data: Uint8Array): AmmV4Pool | null {
  if (data.length !== AMM_V4_SIZE) return null;
  return {
    address, status: u64(data, 0), swapFeeNumerator: u64(data, 176), swapFeeDenominator: u64(data, 184),
    needTakePnlCoin: u64(data, 192), needTakePnlPc: u64(data, 200), openTime: u64(data, 224),
    coinVault: key(data, 336), pcVault: key(data, 368), coinMint: key(data, 400), pcMint: key(data, 432),
  };
}

/**
 * swap_base_in's payout: the swap fee rounded UP off what goes in, then x·y = k rounded down, on
 * the vaults less the profit the pool still owes (no order book: calc_total_without_take_pnl_no_orderbook).
 */
export function ammV4Out(p: AmmV4Pool, coinVault: bigint, pcVault: bigint, coinIn: boolean, amountIn: bigint): bigint | null {
  if (amountIn <= 0n || p.swapFeeDenominator <= 0n) return null;
  const coin = coinVault - p.needTakePnlCoin;
  const pc = pcVault - p.needTakePnlPc;
  if (coin <= 0n || pc <= 0n) return null;
  const inAfterFee = amountIn - ceilDiv(amountIn * p.swapFeeNumerator, p.swapFeeDenominator);
  const [rin, rout] = coinIn ? [coin, pc] : [pc, coin];
  return (rout * inAfterFee) / (rin + inAfterFee);
}

/** swap_base_in_v2: the token program, the pool, its authority, its two vaults, the trader's two accounts, the trader. */
export function ammV4Leg(p: AmmV4Pool, coinVault: bigint, pcVault: bigint, owner: PublicKey, fromMint: string, amountIn: bigint, minOut: bigint, nowSecs = Math.floor(Date.now() / 1000)): DirectLeg | null {
  if (!AMM_V4_SWAPS.has(p.status) || BigInt(nowSecs) < p.openTime) return null;
  const coinIn = fromMint === p.coinMint;
  if (!coinIn && fromMint !== p.pcMint) return null;
  const out = ammV4Out(p, coinVault, pcVault, coinIn, amountIn);
  if (out === null || out <= 0n) return null;
  const [mIn, mOut] = coinIn ? [p.coinMint, p.pcMint] : [p.pcMint, p.coinMint];
  const data = new Uint8Array(17);
  data[0] = AMM_V4_SWAP_BASE_IN_V2;
  data.set(le64(amountIn), 1);
  data.set(le64(minOut), 9);
  const w = (k: PublicKey | string, isWritable: boolean, isSigner = false) => ({ pubkey: typeof k === 'string' ? pk(k) : k, isSigner, isWritable });
  const ix = new TransactionInstruction({
    programId: RAYDIUM_AMM_V4,
    keys: [
      w(TOKEN_PROGRAM_ID, false), w(p.address, true), w(AMM_V4_AUTHORITY, false), w(p.coinVault, true), w(p.pcVault, true),
      w(ata(owner, mIn, TOKEN_PROGRAM_ID), true), w(ata(owner, mOut, TOKEN_PROGRAM_ID), true), w(owner, false, true),
    ],
    data: Buffer.from(data),
  });
  return { out, ix };
}

/* ─────────────────────────────── PumpSwap ─────────────────────────────── */

export const PUMP_AMM = new PublicKey('pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA');
export const PUMP_FEE_PROGRAM = new PublicKey('pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ');
const ASSOCIATED_TOKEN_PROGRAM = new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');
const SYSTEM_PROGRAM = new PublicKey('11111111111111111111111111111111');
const enc = new TextEncoder();
const pda = (seeds: (Uint8Array | string)[], program = PUMP_AMM) => PublicKey.findProgramAddressSync(seeds.map((s) => (typeof s === 'string' ? enc.encode(s) : s)), program)[0];
export const PUMP_GLOBAL_CONFIG = pda(['global_config']);
export const PUMP_EVENT_AUTHORITY = pda(['__event_authority']);
export const PUMP_FEE_CONFIG = pda(['fee_config', PUMP_AMM.toBytes()], PUMP_FEE_PROGRAM);
export const PUMP_GLOBAL_VOLUME = pda(['global_volume_accumulator']);
/** Anchor's instruction tags: sha256("global:sell"), sha256("global:buy"), first 8 bytes. */
export const PUMP_SELL = Uint8Array.from([51, 230, 133, 164, 1, 127, 131, 173]);
export const PUMP_BUY = Uint8Array.from([102, 6, 61, 18, 1, 218, 235, 234]);

export interface PumpPool {
  address: string;
  baseMint: string;
  quoteMint: string;
  baseVault: string;
  quoteVault: string;
  coinCreator: string;
  /** A newer pool's signed quote adjustment (byte 245, arb-chain.mjs): its quote reserve is the vault plus it. */
  quoteExtra: bigint;
}

/** A PumpSwap Pool account (arb-chain.mjs decodePool's offsets), or null. */
export function decodePumpPool(address: string, data: Uint8Array): PumpPool | null {
  if (data.length < 243) return null;
  const extra = data.length >= 261 ? BigInt.asIntN(128, u64(data, 245) + (u64(data, 253) << 64n)) : 0n;
  return { address, baseMint: key(data, 43), quoteMint: key(data, 75), baseVault: key(data, 139), quoteVault: key(data, 171), coinCreator: key(data, 211), quoteExtra: extra };
}

/** The three fees a trade pays, in basis points of the quote side. */
export interface PumpFees {
  lpBps: bigint;
  protocolBps: bigint;
  creatorBps: bigint;
}

/** The pump fee program's FeeConfig for PumpSwap: flat fees, and tiers by market cap (lamports). */
export interface PumpFeeConfig {
  flat: PumpFees;
  tiers: { threshold: bigint; fees: PumpFees }[];
}

export function decodePumpFeeConfig(data: Uint8Array): PumpFeeConfig | null {
  if (data.length < 73) return null;
  const fees = (at: number): PumpFees => ({ lpBps: u64(data, at), protocolBps: u64(data, at + 8), creatorBps: u64(data, at + 16) });
  const n = new DataView(data.buffer, data.byteOffset, data.byteLength).getUint32(65, true);
  if (n === 0 || data.length < 69 + n * 40) return null;
  const tiers = Array.from({ length: n }, (_, i) => ({ threshold: u64(data, 69 + i * 40) + (u64(data, 77 + i * 40) << 64n), fees: fees(69 + i * 40 + 16) }));
  return { flat: fees(41), tiers };
}

/**
 * The fees a pool pays (arb-chain.mjs pumpFee): a pool with a coin creator, priced in SOL, by its
 * market cap's tier (quote reserve × supply ÷ base reserve); any other, the flat fees.
 */
export function pumpFeesFor(p: PumpPool, cfg: PumpFeeConfig, baseReserve: bigint, quoteReserve: bigint, supply: bigint): PumpFees {
  const noCreator = p.coinCreator === SYSTEM_PROGRAM.toBase58();
  if (noCreator || p.quoteMint !== 'So11111111111111111111111111111111111111112' || baseReserve <= 0n) return cfg.flat;
  const cap = (quoteReserve * supply) / baseReserve;
  let fees = cfg.tiers[0]!.fees;
  for (const t of cfg.tiers) if (cap >= t.threshold) fees = t.fees;
  return fees;
}

const feeOf = (amount: bigint, bps: bigint) => ceilDiv(amount * bps, 10_000n);
const hasCreator = (p: PumpPool) => p.coinCreator !== SYSTEM_PROGRAM.toBase58();

/** sell: the coin in; what the curve gives in SOL, less each fee rounded UP (pump-amm sell). */
export function pumpSellOut(p: PumpPool, f: PumpFees, baseReserve: bigint, quoteReserve: bigint, baseIn: bigint): bigint | null {
  if (baseIn <= 0n || baseReserve <= 0n || quoteReserve <= 0n) return null;
  const gross = (quoteReserve * baseIn) / (baseReserve + baseIn);
  const out = gross - feeOf(gross, f.lpBps) - feeOf(gross, f.protocolBps) - (hasCreator(p) ? feeOf(gross, f.creatorBps) : 0n);
  return out > 0n ? out : null;
}

/** buy: an exact coin out; the SOL it costs, the curve rounded UP and each fee rounded UP on top (pump-amm buy). */
export function pumpBuyCost(p: PumpPool, f: PumpFees, baseReserve: bigint, quoteReserve: bigint, baseOut: bigint): bigint | null {
  if (baseOut <= 0n || baseOut >= baseReserve || quoteReserve <= 0n) return null;
  const net = ceilDiv(quoteReserve * baseOut, baseReserve - baseOut);
  return net + feeOf(net, f.lpBps) + feeOf(net, f.protocolBps) + (hasCreator(p) ? feeOf(net, f.creatorBps) : 0n);
}

/** The most coin `quoteIn` buys: the largest coin out whose cost is within it (pumpBuyCost rises with it). */
export function pumpBuyOut(p: PumpPool, f: PumpFees, baseReserve: bigint, quoteReserve: bigint, quoteIn: bigint): bigint | null {
  let lo = 0n;
  let hi = baseReserve - 1n;
  while (lo < hi) {
    const mid = (lo + hi + 1n) / 2n;
    const cost = pumpBuyCost(p, f, baseReserve, quoteReserve, mid);
    if (cost !== null && cost <= quoteIn) lo = mid;
    else hi = mid - 1n;
  }
  return lo > 0n ? lo : null;
}

/** What a PumpSwap trade needs beyond the pool: who takes the protocol fee, and each coin's token program. */
export interface PumpContext {
  protocolFeeRecipient: PublicKey;
  baseProgram: PublicKey;
  quoteProgram: PublicKey;
}

function pumpKeys(p: PumpPool, owner: PublicKey, c: PumpContext) {
  const w = (k: PublicKey | string, isWritable: boolean, isSigner = false) => ({ pubkey: typeof k === 'string' ? pk(k) : k, isSigner, isWritable });
  const creatorVault = pda(['creator_vault', pk(p.coinCreator).toBytes()]);
  return {
    head: [
      w(p.address, true), w(owner, true, true), w(PUMP_GLOBAL_CONFIG, false), w(p.baseMint, false), w(p.quoteMint, false),
      w(ata(owner, p.baseMint, c.baseProgram), true), w(ata(owner, p.quoteMint, c.quoteProgram), true),
      w(p.baseVault, true), w(p.quoteVault, true), w(c.protocolFeeRecipient, false), w(ata(c.protocolFeeRecipient, p.quoteMint, c.quoteProgram), true),
      w(c.baseProgram, false), w(c.quoteProgram, false), w(SYSTEM_PROGRAM, false), w(ASSOCIATED_TOKEN_PROGRAM, false),
      w(PUMP_EVENT_AUTHORITY, false), w(PUMP_AMM, false), w(ata(creatorVault, p.quoteMint, c.quoteProgram), true), w(creatorVault, false),
    ],
    fees: [w(PUMP_FEE_CONFIG, false), w(PUMP_FEE_PROGRAM, false)],
    volume: [w(PUMP_GLOBAL_VOLUME, false), w(pda(['user_volume_accumulator', owner.toBytes()]), true)],
  };
}

/** sell: exactly `baseIn` of the coin for at least `minOut` SOL. */
export function pumpSellLeg(p: PumpPool, f: PumpFees, baseReserve: bigint, quoteReserve: bigint, owner: PublicKey, c: PumpContext, baseIn: bigint, minOut: bigint): DirectLeg | null {
  const out = pumpSellOut(p, f, baseReserve, quoteReserve, baseIn);
  if (out === null) return null;
  const k = pumpKeys(p, owner, c);
  const data = Buffer.concat([PUMP_SELL, le64(baseIn), le64(minOut)]);
  return { out, ix: new TransactionInstruction({ programId: PUMP_AMM, keys: [...k.head, ...k.fees], data }) };
}

/** buy: the most coin `quoteIn` SOL buys (exact out), paying at most `quoteIn`; volume not tracked. */
export function pumpBuyLeg(p: PumpPool, f: PumpFees, baseReserve: bigint, quoteReserve: bigint, owner: PublicKey, c: PumpContext, quoteIn: bigint, minOut: bigint): DirectLeg | null {
  const out = pumpBuyOut(p, f, baseReserve, quoteReserve, quoteIn);
  if (out === null || out < minOut) return null;
  const k = pumpKeys(p, owner, c);
  const data = Buffer.concat([PUMP_BUY, le64(out), le64(quoteIn), Uint8Array.from([0])]);
  return { out, ix: new TransactionInstruction({ programId: PUMP_AMM, keys: [...k.head, ...k.volume, ...k.fees], data }) };
}
