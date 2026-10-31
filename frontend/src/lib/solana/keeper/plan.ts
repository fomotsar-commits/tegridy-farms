import { PublicKey, type TransactionInstruction } from '@solana/web3.js';
import { getAssociatedTokenAddressSync } from '@solana/spl-token';
import type { PoolView } from '../lp/poolFinder';
import type { Arbitrage } from '../lp/poolList';
import { SOL_QUOTE, USDC_QUOTE } from '../lp/quotes';

/**
 * The price keeper's pure half: which gaps to close, how big a round trip to make, and the
 * checks every Jupiter instruction must pass before the keeper's key signs it.
 *
 * One round trip is ONE transaction with two swaps in it: the side where the token is cheap
 * buys it, the side where it is dear sells it, and both are in the same coin (SOL or USDC).
 * The LAST swap's minimum out is at least what the first swap spent plus a profit floor, so
 * the chain itself refuses any round trip that would end with less coin than it began with.
 * A refused round trip costs only the network fee. No quote, price or pool read is trusted
 * for that: the floor is set from the keeper's own amounts.
 *
 * `buy`  (the token is cheap in our pool): our pool coin → token, then Jupiter token → coin.
 *        Jupiter's leg is last, so ITS minimum is the floor: the keeper sets the quote's
 *        slippage so quoted × (1 − slippage) ≥ spent + profit floor, then reads the floor
 *        back out of the instruction Jupiter built before signing it.
 * `sell` (the token is dear in our pool): Jupiter coin → token, then our pool token → coin.
 *        Our pool's leg is last; its `minimum_amount_out` is the floor, set here.
 */

export const JUPITER_PROGRAM = new PublicKey('JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4');

/** Anchor discriminators, read from Jupiter's on-chain IDL 2026-10-31. */
export const ROUTE_V2 = Uint8Array.from([187, 100, 250, 204, 49, 196, 175, 20]);
export const SHARED_ACCOUNTS_ROUTE_V2 = Uint8Array.from([209, 152, 83, 147, 124, 254, 216, 233]);

/** The coins a round trip can start and end in. BAYLA-priced pools are left alone. */
export const KEEPER_COINS = [SOL_QUOTE, USDC_QUOTE] as const;

export interface KeeperLimits {
  /** The largest round trip, in USD at Jupiter's listed price. */
  maxTradeUsd: number;
  /** The least coin a round trip must end up with, in USD. Also the floor the chain enforces. */
  minProfitUsd: number;
  /**
   * Each leg's tolerance. The first leg's minimum is its quote less this; the last leg's is the
   * LARGER of that and spent + profit floor, so a sandwich can take at most this much of the
   * expected profit, never all of it down to the floor.
   */
  slippageBps: number;
}

export const DEFAULT_LIMITS: KeeperLimits = { maxTradeUsd: 25, minProfitUsd: 0.01, slippageBps: 50 };

/**
 * Raydium's programs as Jupiter named them on 2026-10-31 (AMM v4, CLMM, CP-Swap, LaunchLab).
 * Refused even when Jupiter's venue list does not answer or renames them: owner ruling
 * 2026-10-13, no money to Raydium, ever.
 */
export const RAYDIUM_PROGRAMS: readonly string[] = [
  '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8',
  'CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK',
  'CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C',
  'LanMV9sAd7wArD4vJFi2qDdfnVhFxYSUg6eADduJ3uj',
];

/**
 * Rent for a token account the keeper opens on its first trade of a token (a Token-2022
 * account with its one extension, the larger of the two kinds). It is a cost of that trade:
 * the round trip must earn it back on top of the floor.
 */
export const NEW_ACCOUNT_RENT = 2_074_080n;

/** `lamports` in the coin's base units, at Jupiter's listed prices; null without a price. */
export function lamportsInCoin(lamports: bigint, coin: { mint: string; decimals: number }, usd: ReadonlyMap<string, number>): bigint | null {
  if (coin.mint === SOL_QUOTE.mint) return lamports;
  const sol = usd.get(SOL_QUOTE.mint);
  const c = usd.get(coin.mint);
  if (!sol || !c || !(sol > 0) || !(c > 0)) return null;
  return BigInt(Math.ceil(((Number(lamports) / 1e9) * sol * 10 ** coin.decimals) / c));
}

export interface Plan {
  pool: string;
  side: 'buy' | 'sell';
  coinMint: string;
  tokenMint: string;
  /** Coin the round trip spends, in base units: into our pool (`buy`) or into Jupiter (`sell`). */
  coinIn: bigint;
  /** The least coin it must gain, in base units. */
  minProfit: bigint;
}

/**
 * The round trip for one pool's gap, or why there is none. `arb` is the list's own figure
 * (lp/poolList.ts `arbitrage`, against Jupiter's LISTED price, before the other leg's cost):
 * a gap whose listed profit is under the floor is not worth two quotes. A larger gap is
 * made smaller to `maxTradeUsd`: on x·y = k, any trade short of the best size still pays.
 */
export function planFor(view: PoolView, arb: Arbitrage, usd: ReadonlyMap<string, number>, limits: KeeperLimits): Plan | string {
  if (!KEEPER_COINS.some((c) => c.mint === view.quote.mint)) return `priced in ${view.quote.symbol}`;
  if (view.vaultsFrozen) return 'a pool vault is frozen';
  if (!(arb.profitUsd >= limits.minProfitUsd)) return 'listed profit under the floor';
  const coinUsd = usd.get(view.quote.mint);
  if (coinUsd === undefined || !(coinUsd > 0)) return 'no price for the coin';
  const coinUnit = coinUsd / 10 ** view.quote.decimals;
  const scale = Math.min(1, limits.maxTradeUsd / arb.tradeUsd);
  // Both sides are sized in coin: what goes into our pool buying, what goes into Jupiter selling.
  const coinIn = BigInt(Math.floor((arb.tradeUsd * scale) / coinUnit));
  const minProfit = BigInt(Math.ceil(limits.minProfitUsd / coinUnit));
  if (coinIn <= 0n || minProfit <= 0n) return 'too small to trade';
  return { pool: view.address, side: arb.side, coinMint: view.quote.mint, tokenMint: view.tokenMint, coinIn, minProfit };
}

/**
 * The slippage that makes Jupiter's floor at least `need`: Jupiter pays no less than
 * quoted × (10000 − bps) / 10000, rounded down. Null when even 0 would not reach it.
 */
export function floorSlippageBps(quotedOut: bigint, need: bigint): number | null {
  if (quotedOut <= 0n || quotedOut < need) return null;
  const bps = Number(((quotedOut - need) * 10_000n) / quotedOut);
  return Math.min(bps, 10_000);
}

export function jupiterFloor(quotedOut: bigint, slippageBps: number): bigint {
  return (quotedOut * BigInt(10_000 - slippageBps)) / 10_000n;
}

/**
 * The last leg's slippage when it is Jupiter's (`buy`): no more than the tolerance, and no more
 * than leaves the floor at `need`. Its minimum is the larger of the two. Null under `need`.
 */
export function lastJupiterSlippage(quotedOut: bigint, need: bigint, toleranceBps: number): number | null {
  const most = floorSlippageBps(quotedOut, need);
  return most === null ? null : Math.min(most, toleranceBps);
}

/** The last leg's minimum when it is our pool's (`sell`), the same rule. Null under `need`. */
export function lastPoolMinimum(expectedOut: bigint, need: bigint, toleranceBps: number): bigint | null {
  if (expectedOut < need) return null;
  const tolerated = jupiterFloor(expectedOut, toleranceBps);
  return tolerated > need ? tolerated : need;
}

export interface JupiterRoute {
  shared: boolean;
  inAmount: bigint;
  quotedOutAmount: bigint;
  slippageBps: number;
  platformFeeBps: number;
  positiveSlippageBps: number;
}

/**
 * `route_v2` / `shared_accounts_route_v2` (Jupiter's IDL): the amounts come first, right after
 * the discriminator (and `id: u8` for the shared one): in_amount u64, quoted_out_amount u64,
 * slippage_bps u16, platform_fee_bps u16, positive_slippage_bps u16, then the route plan.
 * Anything else is not a swap this keeper signs.
 */
export function decodeJupiterRoute(data: Uint8Array): JupiterRoute | null {
  const disc = data.subarray(0, 8);
  const shared = sameBytes(disc, SHARED_ACCOUNTS_ROUTE_V2);
  if (!shared && !sameBytes(disc, ROUTE_V2)) return null;
  const at = shared ? 9 : 8;
  if (data.length < at + 22) return null;
  const v = new DataView(data.buffer, data.byteOffset, data.byteLength);
  return {
    shared,
    inAmount: v.getBigUint64(at, true),
    quotedOutAmount: v.getBigUint64(at + 8, true),
    slippageBps: v.getUint16(at + 16, true),
    platformFeeBps: v.getUint16(at + 18, true),
    positiveSlippageBps: v.getUint16(at + 20, true),
  };
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i]);
}

export interface JupiterLegExpect {
  owner: PublicKey;
  inputMint: PublicKey;
  inputProgram: PublicKey;
  outputMint: PublicKey;
  outputProgram: PublicKey;
  inAmount: bigint;
  /** The least the leg must pay out, after its slippage. */
  minOut: bigint;
  /** Program ids the route must not pass through (Raydium's, owner ruling 2026-10-13). */
  refused: ReadonlySet<string>;
  /** The keeper's other accounts (its other coin's): the route must not name them at all. */
  untouchable: readonly PublicKey[];
}

/**
 * Why Jupiter's swap instruction must not be signed, or null. It must be a `route_v2` (or the
 * shared-accounts one) into Jupiter, spending exactly `inAmount` from the keeper's own account
 * of the input coin, paying the keeper's own account of the output coin, with no platform fee,
 * a floor of at least `minOut`, no signer but the keeper, and no refused program anywhere.
 * Account order is the IDL's.
 */
export function jupiterLegProblem(ix: TransactionInstruction, e: JupiterLegExpect): string | null {
  if (!ix.programId.equals(JUPITER_PROGRAM)) return 'the swap is not a call into Jupiter';
  const r = decodeJupiterRoute(ix.data);
  if (!r) return 'the swap is not a route_v2 Jupiter swap';
  if (r.inAmount !== e.inAmount) return `the swap spends ${r.inAmount}, not ${e.inAmount}`;
  if (r.platformFeeBps !== 0) return 'the swap carries a platform fee';
  if (r.positiveSlippageBps !== 0) return 'the swap gives away part of any better price';
  if (r.slippageBps > 10_000) return 'the swap names an impossible slippage';
  if (jupiterFloor(r.quotedOutAmount, r.slippageBps) < e.minOut) return 'the swap’s minimum is under the floor';
  const k = ix.keys.map((m) => m.pubkey);
  if (ix.keys.some((m) => m.isSigner && !m.pubkey.equals(e.owner))) return 'the swap asks another signer';
  if (k.some((p) => e.refused.has(p.toBase58()))) return 'the route passes through a refused venue';
  if (k.some((p) => e.untouchable.some((u) => u.equals(p)))) return 'the swap names another of the keeper’s accounts';
  const sourceAta = getAssociatedTokenAddressSync(e.inputMint, e.owner, true, e.inputProgram);
  const destAta = getAssociatedTokenAddressSync(e.outputMint, e.owner, true, e.outputProgram);
  const at = (i: number) => k[i] ?? PublicKey.default;
  if (r.shared) {
    // program_authority, user_transfer_authority, source_token_account, program_source, program_destination, destination_token_account, source_mint, destination_mint
    if (!at(1).equals(e.owner) || !at(2).equals(sourceAta) || !at(5).equals(destAta)) return 'the swap moves another wallet’s coins';
    if (!at(6).equals(e.inputMint) || !at(7).equals(e.outputMint)) return 'the swap is for other coins';
  } else {
    // user_transfer_authority, user_source_token_account, user_destination_token_account, source_mint, destination_mint, …, destination_token_account (optional: Jupiter's id when unset)
    if (!at(0).equals(e.owner) || !at(1).equals(sourceAta) || !at(2).equals(destAta)) return 'the swap moves another wallet’s coins';
    if (!at(3).equals(e.inputMint) || !at(4).equals(e.outputMint)) return 'the swap is for other coins';
    if (!at(7).equals(JUPITER_PROGRAM) && !at(7).equals(destAta)) return 'the swap pays out to another account';
  }
  return null;
}

/** What a simulated round trip did to the keeper's accounts, in base units (lamports for `fee`). */
export interface SimulatedChange {
  coinBefore: bigint;
  coinAfter: bigint;
  tokenBefore: bigint;
  tokenAfter: bigint;
  /** The keeper's other coin (USDC on a SOL trip, wrapped SOL on a USDC one). */
  otherCoinBefore: bigint;
  otherCoinAfter: bigint;
  lamportsBefore: bigint;
  lamportsAfter: bigint;
}

/** The most SOL a round trip may cost the keeper: network fees, plus rent for a new token account. */
export const MAX_LAMPORTS_SPENT = 3_000_000n;

/**
 * Why a simulated round trip must not be sent, or null. Checked on what the simulation says
 * the accounts hold afterwards, not on any quote: the coin must have grown by the floor, the
 * token and the other coin must not have shrunk, and SOL may drop by fees and rent only.
 * `before` must be read at the same commitment the test run uses, or an earlier trip's gain
 * would count towards this one.
 */
export function simulationProblem(c: SimulatedChange, plan: Plan): string | null {
  if (c.coinAfter - c.coinBefore < plan.minProfit) return `the coin grew by ${c.coinAfter - c.coinBefore}, under the floor ${plan.minProfit}`;
  if (c.tokenAfter < c.tokenBefore) return 'the token account shrank';
  if (c.otherCoinAfter < c.otherCoinBefore) return 'the keeper’s other coin shrank';
  if (c.lamportsBefore - c.lamportsAfter > MAX_LAMPORTS_SPENT) return 'it costs more SOL than fees and rent';
  return null;
}
