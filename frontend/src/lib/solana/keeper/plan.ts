import { PublicKey, type TransactionInstruction } from '@solana/web3.js';
import { getAssociatedTokenAddressSync } from '@solana/spl-token';
import { swapEnabled } from '../cpswap/program';
import { quoteOwnPool } from '../cpswap/read';
import type { PoolView } from '../lp/poolFinder';
import type { Arbitrage } from '../lp/poolList';
import { SOL_QUOTE, USDC_QUOTE, type QuoteCoin } from '../lp/quotes';
import type { TransferFee } from '../lp/transferFee';
import { coinBounds, type RuleSettings } from './rule';

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

/**
 * The robot's limits: the shared rule's (keeper/rule.ts: the cap, held to $25 until the Lighthouse
 * check is proven; the floor, the network fee plus `minProfitUsd`), and each leg's tolerance.
 */
export interface KeeperLimits extends RuleSettings {
  /**
   * Each leg's tolerance. The first leg's minimum is its quote less this; the last leg's is the
   * LARGER of that and spent + profit floor, so a sandwich can take at most this much of the
   * expected profit, never all of it down to the floor.
   */
  slippageBps: number;
}

export const DEFAULT_LIMITS: KeeperLimits = { maxTradeUsd: 25, minProfitUsd: 0.01, slippageBps: 50, microLamports: 10_000, lighthouseProven: false };

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
  const b = coinBounds(view.quote, usd.get(view.quote.mint), usd.get(SOL_QUOTE.mint), limits);
  if (typeof b === 'string') return b;
  if (!(arb.profitUsd >= b.floorUsd)) return 'listed profit under the floor';
  const scale = Math.min(1, b.capUsd / arb.tradeUsd);
  // Both sides are sized in coin: what goes into our pool buying, what goes into Jupiter selling.
  const coinIn = BigInt(Math.floor((arb.tradeUsd * scale) / b.unit));
  const minProfit = b.floor;
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

/** `jupiterLegProblem`'s answer for a route that names one of `untouchable`. */
export const NAMES_OTHER_ACCOUNT = 'the swap names another of the keeper’s accounts';

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
  if (k.some((p) => e.untouchable.some((u) => u.equals(p)))) return NAMES_OTHER_ACCOUNT;
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

/** The most SOL a sale of leftovers may cost: network fees only, it opens no account. */
export const MAX_FEE_LAMPORTS = 100_000n;

/**
 * Why a simulated round trip must not be sent, or null. Checked on what the simulation says
 * the accounts hold afterwards, not on any quote: the coin must have grown by the floor, the
 * token and the other coin must not have shrunk, and SOL may drop by fees and rent only.
 * `before` must be read at the same commitment the test run uses, or an earlier trip's gain
 * would count towards this one.
 */
export function simulationProblem(c: SimulatedChange, plan: Pick<Plan, 'minProfit'>): string | null {
  if (c.coinAfter - c.coinBefore < plan.minProfit) return `the coin grew by ${c.coinAfter - c.coinBefore}, under the floor ${plan.minProfit}`;
  if (c.tokenAfter < c.tokenBefore) return 'the token account shrank';
  if (c.otherCoinAfter < c.otherCoinBefore) return 'the keeper’s other coin shrank';
  if (c.lamportsBefore - c.lamportsAfter > MAX_LAMPORTS_SPENT) return 'it costs more SOL than fees and rent';
  return null;
}

/**
 * Why the keeper cannot trade a pool at all, or null when it can: the `pools` command's answer
 * and the first gate of every pass. `fee` is the list's own read of the token's transfer fee
 * (lp/poolList.ts `rowTokenFee`).
 */
export function poolProblem(view: PoolView, fee: TransferFee | null | 'unread'): string | null {
  if (!KEEPER_COINS.some((c) => c.mint === view.quote.mint)) return `priced in ${view.quote.symbol}; the keeper trades SOL and USDC pools`;
  if (view.vaultsFrozen) return 'a pool vault is frozen';
  if (!swapEnabled(view.snapshot.pool)) return 'trading is switched off in this pool';
  if (!view.config) return 'the pool’s fee settings were not read';
  if (fee === 'unread') return 'the coin’s transfer fee was not read';
  if (fee !== null) return 'the coin keeps a transfer fee';
  return null;
}

/**
 * A round trip between two of OUR pools of the same pair: buy the token where it is cheap,
 * sell it where it is dear. Both legs pay our pools' fee, so the venue earns twice, and no
 * outside venue sees the trip. Both legs are priced by the pool program's own maths.
 */
export interface OwnPairPlan {
  cheap: PoolView;
  dear: PoolView;
  coinMint: string;
  tokenMint: string;
  coinIn: bigint;
  /** What the cheap pool pays out, exactly: the first leg's minimum, and the second leg's input. */
  tokens: bigint;
  /** What the dear pool pays for them, by its maths now. */
  coinOut: bigint;
  minProfit: bigint;
}

/**
 * The best round trip between two pools of the same token and coin, or null when none clears
 * the floor. On two x·y = k pools the profit of a trip of size x rises, peaks and falls, so the
 * peak is found by narrowing the range (a ternary search on whole base units), never larger
 * than the shared rule's cap (keeper/rule.ts) or than `holds`, what the keeper has of the coin.
 */
export function ownPairPlan(a: PoolView, b: PoolView, nowSecs: number, usd: ReadonlyMap<string, number>, limits: RuleSettings, holds: bigint): OwnPairPlan | null {
  if (a.tokenMint !== b.tokenMint || a.quote.mint !== b.quote.mint || a.address === b.address) return null;
  if (!a.config || !b.config) return null;
  const bounds = coinBounds(a.quote, usd.get(a.quote.mint), usd.get(SOL_QUOTE.mint), limits);
  if (typeof bounds === 'string') return null;
  const { floor: minProfit, cap } = bounds;
  const most = holds < cap ? holds : cap;
  let best: OwnPairPlan | null = null;
  for (const [cheap, dear] of [[a, b], [b, a]] as const) {
    const trip = (x: bigint) => {
      const first = quoteOwnPool(cheap.snapshot, cheap.config!, cheap.quote.mint, x, nowSecs);
      if (!first || first.outAmount <= 0n) return null;
      const second = quoteOwnPool(dear.snapshot, dear.config!, dear.tokenMint, first.outAmount, nowSecs);
      if (!second) return null;
      return { tokens: first.outAmount, coinOut: second.outAmount, profit: second.outAmount - x };
    };
    const gain = (x: bigint) => trip(x)?.profit ?? -(10n ** 30n);
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
      if (!t || t.profit < minProfit) continue;
      if (!best || t.profit > best.coinOut - best.coinIn) {
        best = { cheap, dear, coinMint: a.quote.mint, tokenMint: a.tokenMint, coinIn: x, tokens: t.tokens, coinOut: t.coinOut, minProfit };
      }
    }
  }
  return best;
}

/** One swap of a loop through our pools: the pool, and which of its two sides goes in. */
export interface LoopLeg {
  view: PoolView;
  input: 'coin' | 'token';
}

const sideMint = (v: PoolView, side: LoopLeg['input']) => (side === 'coin' ? v.quote.mint : v.tokenMint);
const flip = (side: LoopLeg['input']): LoopLeg['input'] => (side === 'coin' ? 'token' : 'coin');
const SIDES = ['coin', 'token'] as const;

/**
 * Every round trip through three of OUR pools that starts and ends in one of the keeper's
 * coins, e.g. SOL → BAYLA (BAYLA / SOL) → USDC (BAYLA / USDC) → SOL (USDC / SOL), and the same
 * the other way round. No outside venue and no Jupiter call: every leg is our program's, and
 * all three fees stay with the venue. Each loop is listed once, from the first of KEEPER_COINS
 * it passes through. Two pools of one pair are `ownPairPlan`'s, not a loop.
 */
export function ownLoops(pools: readonly PoolView[]): LoopLeg[][] {
  const out: LoopLeg[][] = [];
  KEEPER_COINS.forEach((coin, i) => {
    const earlier = new Set(KEEPER_COINS.slice(0, i).map((c) => c.mint));
    for (const p1 of pools) {
      for (const s1 of SIDES) {
        if (sideMint(p1, s1) !== coin.mint) continue;
        const m1 = sideMint(p1, flip(s1));
        for (const p2 of pools) {
          if (p2 === p1) continue;
          for (const s2 of SIDES) {
            if (sideMint(p2, s2) !== m1) continue;
            const m2 = sideMint(p2, flip(s2));
            if (m2 === coin.mint || m2 === m1 || earlier.has(m1) || earlier.has(m2)) continue;
            for (const p3 of pools) {
              if (p3 === p1 || p3 === p2) continue;
              for (const s3 of SIDES) {
                if (sideMint(p3, s3) !== m2 || sideMint(p3, flip(s3)) !== coin.mint) continue;
                out.push([{ view: p1, input: s1 }, { view: p2, input: s2 }, { view: p3, input: s3 }]);
              }
            }
          }
        }
      }
    }
  });
  return out;
}

export interface OwnLoopPlan {
  legs: LoopLeg[];
  /** The coin the loop starts and ends in. */
  coin: QuoteCoin;
  /** The two coins it passes through, in order. */
  middle: [string, string];
  coinIn: bigint;
  /** What each leg pays out, exactly, by the pool program's maths now: each one the next leg's input. */
  outs: bigint[];
  coinOut: bigint;
  minProfit: bigint;
}

/**
 * The best size for one loop (`ownLoops`), or null when none clears the floor. Each leg is
 * x·y = k after its fee, so what comes back rises ever more slowly with what goes in: the
 * profit rises, peaks and falls, and the peak is found the way `ownPairPlan` finds it, never
 * larger than the shared rule's cap or than `holds`.
 */
export function ownLoopPlan(legs: LoopLeg[], nowSecs: number, usd: ReadonlyMap<string, number>, limits: RuleSettings, holds: bigint): OwnLoopPlan | null {
  if (legs.length < 2 || legs.some((l) => !l.view.config)) return null;
  const coin = KEEPER_COINS.find((c) => c.mint === sideMint(legs[0]!.view, legs[0]!.input));
  const last = legs[legs.length - 1]!;
  if (!coin || sideMint(last.view, flip(last.input)) !== coin.mint) return null;
  const bounds = coinBounds(coin, usd.get(coin.mint), usd.get(SOL_QUOTE.mint), limits);
  if (typeof bounds === 'string') return null;
  const { floor: minProfit, cap } = bounds;
  const most = holds < cap ? holds : cap;
  const run = (x: bigint): bigint[] | null => {
    const outs: bigint[] = [];
    let amount = x;
    for (const l of legs) {
      const q = quoteOwnPool(l.view.snapshot, l.view.config!, sideMint(l.view, l.input), amount, nowSecs);
      if (!q || q.outAmount <= 0n) return null;
      amount = q.outAmount;
      outs.push(amount);
    }
    return outs;
  };
  const gain = (x: bigint) => {
    const outs = run(x);
    return outs ? outs[outs.length - 1]! - x : -(10n ** 30n);
  };
  let lo = 1n;
  let hi = most;
  while (hi - lo > 2n) {
    const m1 = lo + (hi - lo) / 3n;
    const m2 = hi - (hi - lo) / 3n;
    if (gain(m1) < gain(m2)) lo = m1;
    else hi = m2;
  }
  let best: OwnLoopPlan | null = null;
  for (let x = lo; x <= hi; x++) {
    const outs = run(x);
    if (!outs) continue;
    const coinOut = outs[outs.length - 1]!;
    if (coinOut - x < minProfit || (best && coinOut - x <= best.coinOut - best.coinIn)) continue;
    best = { legs, coin, middle: [sideMint(legs[0]!.view, flip(legs[0]!.input)), sideMint(last.view, last.input)], coinIn: x, outs, coinOut, minProfit };
  }
  return best;
}

/**
 * Why a test-run sale of leftover tokens must not be sent, or null: the coin must have grown
 * by at least the sale's minimum, no more of the token may have left than was sold, the other
 * coin must not have shrunk, and SOL may drop by fees only.
 */
export function dustSaleProblem(c: SimulatedChange, minOut: bigint, sold: bigint): string | null {
  if (c.coinAfter - c.coinBefore < minOut) return `the coin grew by ${c.coinAfter - c.coinBefore}, under the sale’s minimum ${minOut}`;
  if (c.tokenBefore - c.tokenAfter > sold) return 'more of the token left than was sold';
  if (c.otherCoinAfter < c.otherCoinBefore) return 'the keeper’s other coin shrank';
  if (c.lamportsBefore - c.lamportsAfter > MAX_FEE_LAMPORTS) return 'it costs more SOL than fees';
  return null;
}

/** A price in steps of 0.25%: two reads in the same step are the same price for the quick check. */
export function priceStep(usdPrice: number): number {
  return Math.round(Math.log(usdPrice) / Math.log1p(0.0025));
}
