import {
  AddressLookupTableAccount,
  ComputeBudgetProgram,
  PublicKey,
  TransactionMessage,
  VersionedTransaction,
  type TransactionInstruction,
} from '@solana/web3.js';
import { createAssociatedTokenAccountIdempotentInstruction, getAssociatedTokenAddressSync } from '@solana/spl-token';
import type { SolanaRpc } from '../../launcher/solana/curve/rpc';
import { PROGRAM_ID as LAUNCH_PROGRAM_ID } from '../../launcher/solana/curve/program';
import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, swapBaseInputIx } from '../cpswap/ix';
import { REGISTERED_PROGRAM_ID } from '../cpswap/program';
import { quoteOwnPool } from '../cpswap/read';
import { decodeRpcAccount, getMultipleAccounts, getTokenAccountsByOwner, type RawAccount } from '../lp/accounts';
import type { PoolView } from '../lp/poolFinder';
import { PRICE_IDS_MAX, arbitrage, listPools, marketPriceIds, readMarketPrices, rowTokenFee, tokenDecimalsOf } from '../lp/poolList';
import { SOL_QUOTE, USDC_QUOTE, type QuoteCoin } from '../lp/quotes';
import { readTokenSafety, type TokenSafety } from '../lp/tokenSafety';
import type { TransferFee } from '../lp/transferFee';
import type { GapSeen, Skip } from './gaps';
import { atLeastCheck } from './lighthouse';
import { MAX_TRIP_UNITS, coinBounds, tokenGate, type TripBans } from './rule';
import { KAMINO_LOOKUP_TABLE, flashBorrowIx, flashFee, flashRepayIx, loanFor } from './flashLoan';
import type { OutsideTake } from './takes';
import { refusedVenues, type JupiterApi, type JupiterQuote, type SwapInstructions } from './jupiterApi';
import { OUTSIDE_POOLS, outsideUsd, readOutsidePools, screenUsd, type Anchors, type OutsidePool } from './outside';
import {
  KEEPER_COINS,
  MAX_LAMPORTS_SPENT,
  NAMES_OTHER_ACCOUNT,
  NEW_ACCOUNT_RENT,
  decodeJupiterRoute,
  dustSaleProblem,
  isKeeperCoin,
  jupiterFloor,
  jupiterLegProblem,
  lamportsInCoin,
  lastJupiterSlippage,
  lastPoolMinimum,
  ownLoopPlan,
  ownLoops,
  ownPairPlan,
  planFor,
  poolProblem,
  priceStep,
  routeHeldTo,
  simulationProblem,
  viaOrder,
  type KeeperLimits,
  type LoopLeg,
  type Plan,
  type SimulatedChange,
} from './plan';

/**
 * One pass of the price keeper: read every pool, find the gaps worth closing, and for each
 * build the round trip, test-run it, and (live only) send it. Trips between two of OUR pools
 * go first: both fees stay with the venue. Then trips against Jupiter. Every refusal is a line
 * in the log and the next pool; nothing here throws past a pool.
 */

export interface KeeperIo {
  rpc: SolanaRpc;
  jupiter: JupiterApi;
  /** The keeper's wallet. A dry run names it without its key. */
  owner: PublicKey;
  /** The site's pool index (`/api/pools`), as a fetch for poolIndex.ts. */
  indexFetch: typeof fetch;
  /** Signs and sends; absent on a dry run, which stops after the test run. */
  send?: (tx: VersionedTransaction) => Promise<{ signature: string; outcome: 'confirmed' | 'reverted' | 'unknown' }>;
  /** Told of every sent trip, with what it really did once it confirmed. */
  record?: (r: TripRecord) => void;
  /** Pools whose sent trips the chain refused twice in a day: no trip through them for a day. */
  bans?: TripBans;
  /** Trips between two outside pools the scanner test-ran lately (keeper/takes.ts); absent: none are tried. */
  takes?: () => Promise<OutsideTake[]>;
  log: (line: string) => void;
}

export interface KeeperSettings extends KeeperLimits {
  /** Jupiter's route may use at most this many accounts, so both swaps fit one transaction. */
  maxAccounts: number;
  /**
   * Let Jupiter's leg go through Raydium. Off by default (owner ruling 2026-10-13: no money to
   * Raydium); the owner allowed it for the keeper on 2026-10-31, for coins Raydium alone trades.
   */
  allowRaydium: boolean;
  /**
   * Raydium's programs, refused in Jupiter's leg whatever Jupiter's venue list says. Handed in
   * by scripts/price-keeper.mjs (scripts/lib/raydium-programs.mjs): nothing the site ships
   * may name a Raydium key.
   */
  raydiumPrograms: readonly string[];
  /** Open a token account on a coin's first trip even when that trip does not earn its rent back (owner, 2026-10-31). */
  payNewAccountRent: boolean;
  /** Leftover tokens worth at least this, in USD at Jupiter's listed price, are sold for SOL. */
  dustMinUsd: number;
  /** Outside pools whose reserves, read from the chain, price their coin in place of Jupiter's listed price (keeper/outside.ts). */
  outsidePools: readonly string[];
  /**
   * Borrow inside the trip from Kamino (keeper/flashLoan.ts) when a SOL trip is bigger than the
   * keeper's float, so it is sized to the gap and the cap, not to what the keeper holds
   * (KEEPER_FLASH_LOANS; off by default). The fee is counted in the floor.
   */
  flashLoans: boolean;
}

export const DEFAULT_SETTINGS: Omit<KeeperSettings, keyof KeeperLimits | 'raydiumPrograms'> = {
  maxAccounts: 30,
  allowRaydium: false,
  payNewAccountRent: false,
  dustMinUsd: 1,
  outsidePools: OUTSIDE_POOLS,
  flashLoans: false,
};

/** One sent trip, for the keeper's earnings log. `gained`/`lamportsSpent` are null when it did not confirm. */
export interface TripRecord {
  at: string;
  kind: 'jupiter' | 'own-pools' | 'outside' | 'dust';
  pool: string;
  name: string;
  coin: QuoteCoin;
  coinIn: bigint;
  gained: bigint | null;
  lamportsSpent: bigint | null;
  signature: string;
  outcome: string;
}

/** What the quick check between passes watches: every pool's vaults, and every coin's price. */
export interface Watch {
  vaults: string[];
  mints: string[];
}

export interface CycleResult {
  pools: number;
  gaps: number;
  sent: number;
  watch: Watch;
  /** Every pool weighed against Jupiter this pass. One not here was not looked at: moved by a trip, or the pass stopped. */
  looked: string[];
  /** The gaps among them worth the floor at Jupiter's listed price, for the gap log (keeper/gaps.ts). */
  seen: GapSeen[];
  /** Loops through three of our pools weighed this pass: no Jupiter call each. */
  loops: number;
}

const SIM_UNITS = MAX_TRIP_UNITS;
/**
 * The route size asked for again when Jupiter finds none within `maxAccounts`: a coin traded on
 * Pump.fun's pools needs more (BAYLA, GRR, walked 2026-10-31). A route too big to sit beside our
 * pool's swap in one transaction is then refused when the transaction is built.
 */
const ROOMY_ACCOUNTS = 64;
const ALT_PROGRAM = 'AddressLookupTab1e1111111111111111111111111';
/** Leftover sales a round, at most. */
const MAX_DUST_SALES = 5;
/** A leftover sale's minimum must be at least this share of the coin's listed worth. */
const DUST_FLOOR_OF_WORTH = 0.9;
type Refused = { names: string[]; programs: Set<string> };
type Tried = 'sent' | 'unsure' | Skip;
type Outcome = 'none' | Tried;
/** Whether the trip went out: anything else is a reason it did not. */
const wentOut = (o: Outcome) => o === 'sent' || o === 'unsure';

interface Venue {
  pools: PoolView[];
  chainNow: bigint | null;
  safety: Map<string, TokenSafety>;
}

async function readVenue(io: Pick<KeeperIo, 'rpc' | 'indexFetch'>): Promise<Venue | string> {
  const listed = await listPools(io.rpc, { programId: REGISTERED_PROGRAM_ID, launchProgramId: LAUNCH_PROGRAM_ID, fetchImpl: io.indexFetch });
  if (listed.kind === 'unread') return listed.detail;
  // The list skips the coins the site names itself; the keeper reads every token's fee.
  const safety = await readTokenSafety(io.rpc, listed.list.pools.map((v) => v.tokenMint));
  return { pools: listed.list.pools, chainNow: listed.list.chainNow, safety };
}

/** The token's own claim of a ticker, untrusted, or null when it makes none. */
function symbolOf(view: PoolView, safety: ReadonlyMap<string, TokenSafety>): string | null {
  const checked = safety.get(view.tokenMint);
  return checked?.kind === 'read' && checked.symbol ? checked.symbol : null;
}

/** The token's own claim, untrusted: the whole address is always beside it. */
function nameOf(view: PoolView, safety: ReadonlyMap<string, TokenSafety>): string {
  return `${symbolOf(view, safety) ?? '?'} (${view.tokenMint}) / ${view.quote.symbol}`;
}

/** Why the keeper cannot trade a pool: the pool's own problem, then the shared token gate (keeper/rule.ts). */
const problemOf = (view: PoolView, safety: ReadonlyMap<string, TokenSafety>) =>
  poolProblem(view, rowTokenFee(view, safety.get(view.tokenMint) ?? null)) ?? tokenGate(safety.get(view.tokenMint));

export interface Coverage {
  name: string;
  pool: string;
  tokenMint: string;
  /** The token's own claim of a ticker (untrusted), or null. */
  symbol: string | null;
  /** The coin the pool prices the token in. */
  quote: QuoteCoin;
  /** Why the keeper cannot trade it, or null when it can. */
  problem: string | null;
  /** How many other pools of ours trade the same pair: the keeper trades between them. */
  siblings: number;
}

/** Every pool on the venue, and whether the keeper can trade it: the `pools` command. */
export async function poolCoverage(io: Pick<KeeperIo, 'rpc' | 'indexFetch'>): Promise<Coverage[] | string> {
  const venue = await readVenue(io);
  if (typeof venue === 'string') return venue;
  return venue.pools.map((v) => ({
    name: nameOf(v, venue.safety),
    pool: v.address,
    tokenMint: v.tokenMint,
    symbol: symbolOf(v, venue.safety),
    quote: v.quote,
    problem: problemOf(v, venue.safety),
    siblings: venue.pools.filter((o) => o !== v && o.tokenMint === v.tokenMint && o.quote.mint === v.quote.mint).length,
  }));
}

export async function runCycle(io: KeeperIo, s: KeeperSettings): Promise<CycleResult> {
  let outside: OutsidePool[] = [];
  const empty = (pools: PoolView[]): CycleResult => ({ pools: pools.length, gaps: 0, sent: 0, watch: watchOf(pools, outside), looked: [], seen: [], loops: 0 });
  const venue = await readVenue(io);
  if (typeof venue === 'string') {
    io.log(`Pools not read: ${venue}`);
    return empty([]);
  }
  const { pools, chainNow, safety } = venue;
  const listed = await readMarketPrices(pools, (m) => io.jupiter.prices(m));
  if (listed.kind === 'unread') {
    io.log('Jupiter prices not read: nothing is traded this pass');
    return empty(pools);
  }
  // Where a coin's deepest outside pool is read from the chain, its price is that pool's, now.
  let prices = listed;
  // The coins priced from their outside pool this pass, for the screen page.
  let byChain = new Set<string>();
  try {
    outside = await readOutsidePools(io.rpc, s.outsidePools, (b) => new PublicKey(b).toBase58(), io.log);
    const read = await withOutsidePrices(io.rpc, outside, pools, listed.usd);
    prices = { kind: 'ok', usd: read.usd };
    byChain = read.byChain;
  } catch (e) {
    io.log(`Outside pools not read (${e instanceof Error ? e.message : String(e)}): Jupiter's listed prices this pass`);
  }
  const refused = s.allowRaydium ? refusedVenues({}, [], true) : refusedVenues(await io.jupiter.labels(), s.raydiumPrograms);
  if (!s.allowRaydium && !refused.names.length) {
    io.log('Jupiter’s venue list names no Raydium venue, so Raydium cannot be left out: nothing is traded this pass');
    return empty(pools);
  }
  const usable = pools.filter((v) => problemOf(v, safety) === null);
  // The token's transfer fee as read; an unread one never got past problemOf.
  const feeOf = (v: PoolView): TransferFee | null => {
    const f = rowTokenFee(v, safety.get(v.tokenMint) ?? null);
    return f === 'unread' ? null : f;
  };
  // Trips through our pools alone price each leg without a transfer fee: only fee-free pools.
  const feeFree = usable.filter((v) => feeOf(v) === null);
  let gaps = 0;
  let sent = 0;
  // Pools a sent trip has moved: their read is old until the next pass.
  const moved = new Set<string>();
  const looked: string[] = [];
  const seen: GapSeen[] = [];
  const counted = (o: Outcome, ...touched: PoolView[]) => {
    if (wentOut(o)) {
      sent++;
      for (const v of touched) moved.add(v.address);
    }
    return o === 'unsure';
  };
  let loops = 0;
  const stop = () => stopForUnsure(io, { pools: pools.length, gaps, sent, watch: watchOf(pools, outside), looked, seen, loops });

  // 1. Between our own pools of one pair: both fees stay with the venue. Only a pair priced in a
  //    coin the keeper holds: a trip starts in the pool's own coin.
  for (const [i, a] of feeFree.entries()) {
    for (const b of feeFree.slice(i + 1)) {
      if (!isKeeperCoin(a.quote.mint)) continue;
      if (a.tokenMint !== b.tokenMint || a.quote.mint !== b.quote.mint || moved.has(a.address) || moved.has(b.address)) continue;
      if (chainNow === null) continue;
      try {
        const o = await ownPairTrip(io, s, a, b, chainNow, prices.usd, nameOf(a, safety));
        if (counted(o, a, b)) return stop();
      } catch (e) {
        io.log(`${nameOf(a, safety)}, between our pools: stopped, ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }

  // 1b. Round three of our own pools (BAYLA / SOL, BAYLA / USDC, USDC / SOL): no Jupiter call, every fee stays here.
  if (chainNow !== null) {
    for (const loop of ownLoops(feeFree)) {
      if (loop.some((l) => moved.has(l.view.address))) continue;
      loops++;
      const name = loopName(loop, safety);
      try {
        const o = await ownLoopTrip(io, s, loop, chainNow, prices.usd, name);
        if (counted(o, ...loop.map((l) => l.view))) return stop();
      } catch (e) {
        io.log(`${name}: stopped, ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }

  // 2. Against Jupiter.
  for (const view of usable) {
    if (moved.has(view.address)) continue;
    looked.push(view.address);
    const at = Date.now();
    const name = nameOf(view, safety);
    const fee = feeOf(view);
    const arb = arbitrage(view, prices.usd, chainNow, fee);
    if (!arb) continue;
    gaps++;
    // A gap under the floor even at the listed price is no gap to the gap log.
    const note = (outcome: Tried, remembered = false) => {
      if (arb.profitUsd >= s.minProfitUsd) {
        seen.push({ pool: view.address, tokenMint: view.tokenMint, coin: view.quote.symbol, at, listedUsd: arb.profitUsd, wantUsd: arb.tradeUsd, outcome, name, remembered, byChain: byChain.has(view.tokenMint) });
      }
    };
    const plan = planFor(view, arb, prices.usd, s);
    if (typeof plan === 'string') {
      io.log(`${name}: gap of up to $${arb.profitUsd.toFixed(2)} at Jupiter's listed price, skipped (${plan})`);
      note('no-plan');
      continue;
    }
    // Jupiter said no to this very gap, and neither our pool nor the price has moved since: no call.
    const sameGap = gapKey(view, prices.usd);
    const before = jupiterSaidNo.get(view.address);
    if (before && (before.outcome === 'no-route' || before.key === sameGap) && Date.now() < before.until) {
      note(before.outcome, true);
      continue;
    }
    const remember = (outcome: Tried) => {
      if (outcome === 'quote-short' || outcome === 'no-route') {
        jupiterSaidNo.set(view.address, { key: sameGap, until: Date.now() + (outcome === 'no-route' ? NO_ROUTE_KEEP_MS : QUOTE_SHORT_KEEP_MS), outcome });
      }
    };
    try {
      const o = plan.via
        ? await viaTrip(io, s, view, plan, chainNow, refused, name, fee)
        : await jupiterTrip(io, s, view, plan, chainNow, prices.usd, refused, name, fee);
      note(o);
      remember(o);
      if (counted(o, view)) return stop();
    } catch (e) {
      const said = e instanceof Error ? e.message : String(e);
      // The usual reason, said plainly: the coin's only market Jupiter knows is a refused venue's.
      io.log(`${name}: ${/NO_ROUTES_FOUND/.test(said) && refused.names.length ? 'skipped, Jupiter has no route for it that avoids Raydium' : `stopped, ${said}`}`);
      const outcome = /NO_ROUTES_FOUND/.test(said) ? 'no-route' : 'error';
      note(outcome);
      remember(outcome);
      // Too many calls: the keyless allowance is the whole PC's, so the rest of this pass asks nothing.
      if (/^Jupiter \S+ answered 429/.test(said)) {
        io.log('Jupiter says too many calls: no more Jupiter asks this pass');
        return { pools: pools.length, gaps, sent, watch: watchOf(pools, outside), looked, seen, loops };
      }
    }
  }

  // 3. Between two pools that are not ours, as the scanner found and test-ran them: our pools
  //    first, these after, a few a pass (up to four Jupiter calls each).
  if (io.takes) {
    let takes: OutsideTake[] = [];
    try {
      takes = await io.takes();
    } catch (e) {
      io.log(`Scanner not read (${e instanceof Error ? e.message : String(e)}): no trips between outside pools this pass`);
    }
    for (const t of takes.slice(0, MAX_OUTSIDE_TRIPS)) {
      const route = `outside ${t.coinMint} ${t.legs[0].pool} ${t.legs[1].pool}`;
      const before = jupiterSaidNo.get(route);
      if (before && Date.now() < before.until) continue;
      const name = `${t.tokenMint}, buy in ${t.legs[0].pool}, sell in ${t.legs[1].pool}`;
      try {
        const o = await outsideTrip(io, s, t, prices.usd, refused, name);
        if (o === 'quote-short' || o === 'no-route') jupiterSaidNo.set(route, { key: route, until: Date.now() + QUOTE_SHORT_KEEP_MS, outcome: o });
        if (counted(o)) return stop();
      } catch (e) {
        const said = e instanceof Error ? e.message : String(e);
        io.log(`${name}: stopped, ${said}`);
        if (/^Jupiter \S+ answered 429/.test(said)) break;
      }
    }
  }
  return { pools: pools.length, gaps, sent, watch: watchOf(pools, outside), looked, seen, loops };
}

/** Trips between two outside pools tried a pass, at most. */
const MAX_OUTSIDE_TRIPS = 2;

/**
 * Gaps Jupiter said no to, by pool: what the gap looked like then, and until when that answer
 * stands. A quote that fell short is asked again once our pool's reserves or either price
 * moves (0.25% steps, as the quick check sees prices), or after 5 minutes. No route stands an
 * hour whatever moves: it changes when a venue does, not when a price does.
 */
const jupiterSaidNo = new Map<string, { key: string; until: number; outcome: Tried }>();
const QUOTE_SHORT_KEEP_MS = 5 * 60_000;
export const NO_ROUTE_KEEP_MS = 60 * 60_000;

/** What a gap looks like to the keeper: our pool's two reserves and both prices, in 0.25% steps. */
export function gapKey(view: PoolView, usd: ReadonlyMap<string, number>): string {
  const step = (mint: string) => {
    const p = usd.get(mint);
    return p ? priceStep(p) : null;
  };
  return JSON.stringify([String(view.quoteReserve), String(view.tokenReserve), step(view.tokenMint), step(view.quote.mint)]);
}

function stopForUnsure(io: KeeperIo, result: CycleResult): CycleResult {
  // Until it is known whether that trip landed, no balance read can be trusted.
  io.log('A sent trip is not confirmed yet: the rest of this pass waits for the next read');
  return result;
}

function watchOf(pools: readonly PoolView[], outside: readonly OutsidePool[]): Watch {
  // The outside pools' vaults too: a trade there starts a pass, with no Jupiter call to notice it.
  const vaults = [...pools.flatMap((v) => [v.snapshot.pool.token0Vault, v.snapshot.pool.token1Vault]), ...outside.flatMap((p) => [p.tokenVault, p.solVault])];
  return { vaults, mints: marketPriceIds(pools) };
}

/** Where each outside pool's vault price stood when Jupiter's listed price last changed: kept for the run. */
const anchors: Anchors = new Map();

/** Jupiter's listed prices, with each outside pool's coin moved as far as that pool has moved since: one RPC read. */
async function withOutsidePrices(
  rpc: SolanaRpc,
  outside: readonly OutsidePool[],
  pools: readonly PoolView[],
  listed: ReadonlyMap<string, number>,
): Promise<{ usd: Map<string, number>; byChain: Set<string> }> {
  const usd = new Map(listed);
  const byChain = new Set<string>();
  const solUsd = listed.get(SOL_QUOTE.mint);
  if (!outside.length || !solUsd) return { usd, byChain };
  const vaults = outside.flatMap((p) => [p.tokenVault, p.solVault]);
  const got = await getMultipleAccounts(rpc, vaults);
  const amounts = new Map<string, bigint>();
  got.forEach((a, i) => {
    if (a) amounts.set(vaults[i]!, tokenAmount(a));
  });
  const decimalsOf = (mint: string) => {
    const v = pools.find((p) => p.tokenMint === mint);
    return v ? tokenDecimalsOf(v) : null;
  };
  for (const [mint, price] of screenUsd(listed, outsideUsd(outside, amounts, decimalsOf, solUsd), anchors)) {
    usd.set(mint, price);
    byChain.add(mint);
  }
  return { usd, byChain };
}

/**
 * What the quick check sees: every watched vault's balance, and every coin's price to the
 * nearest 0.25%. Two equal answers mean nothing a pass would act on has moved. One RPC read
 * and one Jupiter price read.
 */
export async function fingerprint(io: Pick<KeeperIo, 'rpc' | 'jupiter'>, w: Watch): Promise<string> {
  const amounts: string[] = [];
  for (let i = 0; i < w.vaults.length; i += 100) {
    const chunk = w.vaults.slice(i, i + 100);
    const r = (await io.rpc('getMultipleAccounts', [chunk, { encoding: 'base64', commitment: 'confirmed' }])) as { value?: unknown[] };
    if (!Array.isArray(r?.value) || r.value.length !== chunk.length) throw new Error('the pools’ vaults were not read');
    r.value.forEach((v, j) => amounts.push(v === null ? '-' : tokenAmount(decodeRpcAccount('getMultipleAccounts', chunk[j]!, v)).toString()));
  }
  const prices = await pricesOf(io, w.mints);
  return JSON.stringify([amounts, w.mints.map((m) => (prices[m] ? priceStep(prices[m]!) : null))]);
}

/** Jupiter's USD prices for any number of coins, PRICE_IDS_MAX at a time, one read after another. */
async function pricesOf(io: Pick<KeeperIo, 'jupiter'>, mints: readonly string[]): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  const ids = [...new Set(mints)];
  for (let i = 0; i < ids.length; i += PRICE_IDS_MAX) Object.assign(out, await io.jupiter.prices(ids.slice(i, i + PRICE_IDS_MAX)));
  return out;
}

/** The keeper's accounts for a trip in `view`'s pair. */
function accountsFor(owner: PublicKey, view: PoolView) {
  const { pool } = view.snapshot;
  const coinMint = new PublicKey(view.quote.mint);
  const tokenMint = new PublicKey(view.tokenMint);
  // Each side's token program as the pool names it: BAYLA, a pool's coin, is Token-2022.
  const coinProgram = new PublicKey(view.quoteIsToken0 ? pool.token0Program : pool.token1Program);
  const tokenProgram = new PublicKey(view.quoteIsToken0 ? pool.token1Program : pool.token0Program);
  const coinAta = getAssociatedTokenAddressSync(coinMint, owner, true, coinProgram);
  const tokenAta = getAssociatedTokenAddressSync(tokenMint, owner, true, tokenProgram);
  // The keeper's other float (USDC on a SOL trip, wrapped SOL on a USDC one): watched, never
  // touched. In the SOL/USDC pool the token IS that float, already watched as the token.
  const other = KEEPER_COINS.find((c) => c.mint !== view.quote.mint && c.mint !== view.tokenMint);
  const otherAta = other ? getAssociatedTokenAddressSync(new PublicKey(other.mint), owner, true, TOKEN_PROGRAM_ID) : tokenAta;
  return { coinMint, coinProgram, tokenMint, tokenProgram, coinAta, tokenAta, otherAta, hasOther: !!other };
}

/** The pool's two transfer fees, token0's then token1's, for `quoteOwnPool`: the token's as read, none on the pool's own coin. */
export function feesOf(view: PoolView, tokenFee: TransferFee | null): readonly [TransferFee | null, TransferFee | null] {
  return view.quoteIsToken0 ? [null, tokenFee] : [tokenFee, null];
}

/** A swap in one of our pools, from the keeper's account of one side to its account of the other. */
export function ownSwap(owner: PublicKey, view: PoolView, input: 'coin' | 'token', amountIn: bigint, minimumAmountOut: bigint): TransactionInstruction {
  const { pool } = view.snapshot;
  const a = accountsFor(owner, view);
  const coinVault = new PublicKey(view.quoteIsToken0 ? pool.token0Vault : pool.token1Vault);
  const tokenVault = new PublicKey(view.quoteIsToken0 ? pool.token1Vault : pool.token0Vault);
  const coinIn = input === 'coin';
  return swapBaseInputIx({
    programId: REGISTERED_PROGRAM_ID,
    payer: owner,
    ammConfig: new PublicKey(pool.ammConfig),
    poolState: new PublicKey(view.address),
    inputTokenAccount: coinIn ? a.coinAta : a.tokenAta,
    outputTokenAccount: coinIn ? a.tokenAta : a.coinAta,
    inputVault: coinIn ? coinVault : tokenVault,
    outputVault: coinIn ? tokenVault : coinVault,
    inputTokenProgram: coinIn ? a.coinProgram : a.tokenProgram,
    outputTokenProgram: coinIn ? a.tokenProgram : a.coinProgram,
    inputTokenMint: coinIn ? a.coinMint : a.tokenMint,
    outputTokenMint: coinIn ? a.tokenMint : a.coinMint,
    observationState: new PublicKey(pool.observationKey),
    amountIn,
    minimumAmountOut,
  });
}

const amountText = (coin: QuoteCoin) => (raw: bigint) => `${(Number(raw) / 10 ** coin.decimals).toFixed(Math.min(coin.decimals, 6))} ${coin.symbol}`;

/** The rent a coin's first trip must earn back, in the coin; 0 once its account is open or the owner pays it. */
function rentToEarn(s: KeeperSettings, tokenExists: boolean, coin: QuoteCoin, usd: ReadonlyMap<string, number>): bigint | null {
  if (tokenExists || s.payNewAccountRent) return 0n;
  return lamportsInCoin(NEW_ACCOUNT_RENT, coin, usd);
}

async function ownPairTrip(io: KeeperIo, s: KeeperSettings, a: PoolView, b: PoolView, chainNow: bigint, usd: ReadonlyMap<string, number>, name: string): Promise<Outcome> {
  const acc = accountsFor(io.owner, a);
  const before = await balances(io.rpc, [acc.coinAta, acc.tokenAta, acc.otherAta, io.owner]);
  const plan = ownPairPlan(a, b, Number(chainNow), usd, s, before.coin);
  if (!plan) return 'none';
  const amt = amountText(a.quote);
  const rent = rentToEarn(s, before.tokenExists, a.quote, usd);
  if (rent === null || plan.coinOut - plan.coinIn < plan.minProfit + rent) {
    io.log(`${name}, between our pools: skipped, the trip makes ${amt(plan.coinOut - plan.coinIn)}, under the floor and the new account’s rent`);
    return 'none';
  }
  const minProfit = plan.minProfit + rent;
  const lastMin = lastPoolMinimum(plan.coinOut, plan.coinIn + minProfit, s.slippageBps)!;
  return sendChecked(io, s, {
    name: `${name}, between our pools`,
    kind: 'own-pools',
    pool: `${plan.cheap.address} → ${plan.dear.address}`,
    coin: a.quote,
    coinIn: plan.coinIn,
    accounts: acc,
    before,
    legs: [ownSwap(io.owner, plan.cheap, 'coin', plan.coinIn, plan.tokens), ownSwap(io.owner, plan.dear, 'token', plan.tokens, lastMin)],
    lookupTables: [],
    floor: minProfit,
    verdict: (c) => simulationProblem(c, { minProfit }),
    says: (gained) => `buy in ${plan.cheap.address}, sell in ${plan.dear.address}, ${amt(plan.coinIn)} in, test run gains ${amt(gained)} (floor ${amt(minProfit)})`,
  });
}

/** A loop as the log says it: each coin by its claimed ticker and whole address, and each pool. */
function loopName(loop: LoopLeg[], safety: ReadonlyMap<string, TokenSafety>): string {
  const coinOf = (v: PoolView, side: LoopLeg['input']) => {
    if (side === 'coin') return `${v.quote.symbol} (${v.quote.mint})`;
    return `${symbolOf(v, safety) ?? '?'} (${v.tokenMint})`;
  };
  const first = loop[0]!;
  const steps = loop.map((l) => `${coinOf(l.view, l.input === 'coin' ? 'token' : 'coin')} in ${l.view.address}`);
  return `round our pools from ${coinOf(first.view, first.input)}: ${steps.join(' → ')}`;
}

async function ownLoopTrip(io: KeeperIo, s: KeeperSettings, loop: LoopLeg[], chainNow: bigint, usd: ReadonlyMap<string, number>, name: string): Promise<Outcome> {
  const owner = io.owner;
  const start = loop[0]!;
  const startMint = start.input === 'coin' ? start.view.quote.mint : start.view.tokenMint;
  const coin = KEEPER_COINS.find((c) => c.mint === startMint);
  if (!coin) return 'none';
  // Each coin's account, by the program its pool names for it.
  const programOf = (v: PoolView, mint: string) => new PublicKey(v.snapshot.pool.token0Mint === mint ? v.snapshot.pool.token0Program : v.snapshot.pool.token1Program);
  const outMint = (l: LoopLeg) => (l.input === 'coin' ? l.view.tokenMint : l.view.quote.mint);
  const [m1, m2] = [outMint(loop[0]!), outMint(loop[1]!)];
  const p1 = programOf(loop[0]!.view, m1);
  const p2 = programOf(loop[1]!.view, m2);
  const coinMint = new PublicKey(coin.mint);
  const ata = (mint: string, program: PublicKey) => getAssociatedTokenAddressSync(new PublicKey(mint), owner, true, program);
  const coinAta = ata(coin.mint, TOKEN_PROGRAM_ID);
  const tokenAta = ata(m1, p1);
  const otherAta = ata(m2, p2);
  const before = await balances(io.rpc, [coinAta, tokenAta, otherAta, owner]);
  const plan = ownLoopPlan(loop, Number(chainNow), usd, s, before.coin);
  if (!plan) return 'none';
  const amt = amountText(coin);
  // Rent for each middle account the loop opens. Two new ones cost more SOL than a trip may spend.
  const opens = (before.tokenExists ? 0 : 1) + (before.otherExists ? 0 : 1);
  if (opens > 1) {
    io.log(`${name}: skipped, it would open two new token accounts`);
    return 'none';
  }
  const rent = opens && !s.payNewAccountRent ? lamportsInCoin(NEW_ACCOUNT_RENT, coin, usd) : 0n;
  if (rent === null || plan.coinOut - plan.coinIn < plan.minProfit + rent) {
    io.log(`${name}: skipped, the trip makes ${amt(plan.coinOut - plan.coinIn)}, under the floor and any new account’s rent`);
    return 'none';
  }
  const minProfit = plan.minProfit + rent;
  const lastMin = lastPoolMinimum(plan.coinOut, plan.coinIn + minProfit, s.slippageBps)!;
  // Every leg but the last must pay exactly what the next one spends; the last pays the floor.
  const ins = [plan.coinIn, ...plan.outs.slice(0, -1)];
  const swaps = loop.map((l, i) => ownSwap(owner, l.view, l.input, ins[i]!, i === loop.length - 1 ? lastMin : plan.outs[i]!));
  return sendChecked(io, s, {
    name,
    kind: 'own-pools',
    pool: loop.map((l) => l.view.address).join(' → '),
    coin,
    coinIn: plan.coinIn,
    accounts: { coinAta, tokenAta, otherAta, tokenMint: new PublicKey(m1), tokenProgram: p1, coinMint },
    before,
    // sendChecked opens the coin's and the first middle coin's accounts; the second's is opened here.
    legs: [createAssociatedTokenAccountIdempotentInstruction(owner, otherAta, owner, new PublicKey(m2), p2), ...swaps],
    lookupTables: [],
    floor: minProfit,
    verdict: (c) => simulationProblem(c, { minProfit }),
    says: (gained) => `${amt(plan.coinIn)} in, test run gains ${amt(gained)} (floor ${amt(minProfit)})`,
  });
}

async function jupiterTrip(
  io: KeeperIo,
  s: KeeperSettings,
  view: PoolView,
  plan: Plan,
  chainNow: bigint | null,
  usd: ReadonlyMap<string, number>,
  refused: Refused,
  name: string,
  tokenFee: TransferFee | null,
): Promise<Tried> {
  if (!view.config || chainNow === null) throw new Error('pool fees or the clock not read');
  const owner = io.owner;
  const amt = amountText(view.quote);
  const fees = feesOf(view, tokenFee);
  const acc = accountsFor(owner, view);
  const before = await balances(io.rpc, [acc.coinAta, acc.tokenAta, acc.otherAta, owner]);
  if (before.coin <= 0n) {
    io.log(`${name}: skipped, the keeper holds no ${view.quote.symbol}`);
    return 'no-coin';
  }
  // Past the float: a loan inside the trip when loans are on (SOL only), else a smaller trip.
  const loan = loanFor(plan.coinMint, plan.coinIn, before.coin, s.flashLoans);
  if (before.coin < plan.coinIn && loan === 0n) {
    // A smaller trip than the gap allows still pays on x·y = k; the checks below say if it does not.
    io.log(`${name}: the gap takes ${amt(plan.coinIn)}, the keeper holds ${amt(before.coin)}: a smaller trip`);
    plan = { ...plan, coinIn: before.coin };
  }
  const rent = rentToEarn(s, before.tokenExists, view.quote, usd);
  if (rent === null) {
    io.log(`${name}: skipped, no SOL price to count the new token account’s rent`);
    return 'no-sol-price';
  }
  plan = { ...plan, minProfit: plan.minProfit + rent + flashFee(loan) };
  const need = plan.coinIn + plan.minProfit;
  const legExpect = { owner, refused: refused.programs, untouchable: acc.hasOther ? [acc.otherAta] : [] };
  let legs: TransactionInstruction[];
  let lookupTables: string[];
  if (plan.side === 'buy') {
    const own = quoteOwnPool(view.snapshot, view.config, plan.coinMint, plan.coinIn, Number(chainNow), fees);
    if (!own || own.outAmount <= 0n) throw new Error('our pool would not quote the buy');
    const q = await quoteWithRoom(io, s, { inputMint: plan.tokenMint, outputMint: plan.coinMint, amount: own.outAmount, slippageBps: s.slippageBps, excludeDexes: refused.names });
    const bps = lastJupiterSlippage(BigInt(q.outAmount), need, s.slippageBps);
    if (bps === null) {
      io.log(`${name}: skipped, Jupiter pays back ${amt(BigInt(q.outAmount))} for ${amt(plan.coinIn)}: under the profit floor`);
      return 'quote-short';
    }
    const minOut = jupiterFloor(BigInt(q.outAmount), bps);
    const si = await jupiterLeg(io.jupiter, owner, { ...q, slippageBps: bps, otherAmountThreshold: minOut.toString() }, (x) =>
      jupiterLegProblem(x.swap, { ...legExpect, inputMint: acc.tokenMint, inputProgram: acc.tokenProgram, outputMint: acc.coinMint, outputProgram: TOKEN_PROGRAM_ID, inAmount: own.outAmount, minOut }),
    );
    legs = [ownSwap(owner, view, 'coin', plan.coinIn, own.outAmount), si.swap];
    lookupTables = si.lookupTables;
  } else {
    const q = await quoteWithRoom(io, s, { inputMint: plan.coinMint, outputMint: plan.tokenMint, amount: plan.coinIn, slippageBps: s.slippageBps, excludeDexes: refused.names });
    // What Jupiter must deliver, as the chain will hold it to: the most our pool can be sold.
    // Anything Jupiter pays over that stays with the keeper as a little of the token.
    const si = await jupiterLeg(io.jupiter, owner, q, (x) =>
      jupiterLegProblem(x.swap, { ...legExpect, inputMint: acc.coinMint, inputProgram: TOKEN_PROGRAM_ID, outputMint: acc.tokenMint, outputProgram: acc.tokenProgram, inAmount: plan.coinIn, minOut: routeFloor(x) }),
    );
    const tokensIn = routeFloor(si);
    const own = quoteOwnPool(view.snapshot, view.config, plan.tokenMint, tokensIn, Number(chainNow), fees);
    const ownMin = own ? lastPoolMinimum(own.outAmount, need, s.slippageBps) : null;
    if (ownMin === null) {
      io.log(`${name}: skipped, our pool pays ${amt(own?.outAmount ?? 0n)} for what ${amt(plan.coinIn)} buys on Jupiter: under the profit floor`);
      return 'quote-short';
    }
    legs = [si.swap, ownSwap(owner, view, 'token', tokensIn, ownMin)];
    lookupTables = si.lookupTables;
  }
  const done = plan;
  return sendChecked(io, s, {
    name,
    kind: 'jupiter',
    pool: view.address,
    coin: view.quote,
    coinIn: done.coinIn,
    accounts: acc,
    before,
    legs,
    lookupTables,
    loan,
    floor: done.minProfit,
    verdict: (c) => simulationProblem(c, done),
    says: (gained) =>
      `${done.side === 'buy' ? 'buy here, sell on Jupiter' : 'buy on Jupiter, sell here'}, ${amt(done.coinIn)} in${borrowed(loan, amt)}, test run gains ${amt(gained)} (floor ${amt(done.minProfit)})`,
  });
}

/**
 * A pool priced in a coin the keeper does not hold (BAYLA): the trip starts and ends in SOL, and
 * Jupiter carries it to our pool and back, in one transaction. Buying (the token is cheap here):
 * SOL → BAYLA on Jupiter, BAYLA → token here, token → SOL on Jupiter. Selling: SOL → token on
 * Jupiter, token → BAYLA here, BAYLA → SOL on Jupiter. Each leg spends exactly the least the leg
 * before must pay, so neither middle account can shrink (the owner's own BAYLA, kept, sits in the
 * keeper's BAYLA account), and the last leg's minimum and the Lighthouse check hold the SOL to its
 * floor. The last leg is quoted before any swap is built: a trip that falls short costs two
 * Jupiter calls, not four.
 */
async function viaTrip(
  io: KeeperIo,
  s: KeeperSettings,
  view: PoolView,
  plan: Plan,
  chainNow: bigint | null,
  refused: Refused,
  name: string,
  tokenFee: TransferFee | null,
): Promise<Tried> {
  if (!view.config || chainNow === null || !plan.via) throw new Error('pool fees or the clock not read');
  const owner = io.owner;
  const { pool } = view.snapshot;
  const amt = amountText(SOL_QUOTE);
  const programOf = (mint: string) => new PublicKey(pool.token0Mint === mint ? pool.token0Program : pool.token1Program);
  const ata = (mint: string, program: PublicKey) => getAssociatedTokenAddressSync(new PublicKey(mint), owner, true, program);
  // `a`: what Jupiter buys with SOL, our pool's input. `b`: what our pool pays out, Jupiter's to sell.
  const [a, b] = viaOrder(plan.side, plan.via, view.tokenMint);
  const coinMint = new PublicKey(SOL_QUOTE.mint);
  const coinAta = ata(SOL_QUOTE.mint, TOKEN_PROGRAM_ID);
  const aAta = ata(a, programOf(a));
  const bAta = ata(b, programOf(b));
  // The keeper's USDC: no leg may name it.
  const usdcAta = ata(USDC_QUOTE.mint, TOKEN_PROGRAM_ID);
  const before = await balances(io.rpc, [coinAta, aAta, bAta, owner]);
  if (before.coin <= 0n) {
    io.log(`${name}: skipped, the keeper holds no SOL`);
    return 'no-coin';
  }
  let coinIn = plan.coinIn;
  const loan = loanFor(SOL_QUOTE.mint, coinIn, before.coin, s.flashLoans);
  if (before.coin < coinIn && loan === 0n) {
    io.log(`${name}: the gap takes ${amt(coinIn)}, the keeper holds ${amt(before.coin)}: a smaller trip`);
    coinIn = before.coin;
  }
  // Rent for each middle account the trip opens. Two new ones cost more SOL than a trip may spend.
  const opens = (before.tokenExists ? 0 : 1) + (before.otherExists ? 0 : 1);
  if (opens > 1) {
    io.log(`${name}: skipped, it would open two new token accounts`);
    return 'no-plan';
  }
  const minProfit = plan.minProfit + (opens && !s.payNewAccountRent ? NEW_ACCOUNT_RENT : 0n) + flashFee(loan);
  const need = coinIn + minProfit;
  const q1 = await quoteDirectFirst(io, s, { inputMint: SOL_QUOTE.mint, outputMint: a, amount: coinIn, slippageBps: s.slippageBps, excludeDexes: refused.names });
  // Our pool spends exactly the least the first leg must pay.
  const aIn = jupiterFloor(BigInt(q1.outAmount), q1.slippageBps);
  const own = quoteOwnPool(view.snapshot, view.config, a, aIn, Number(chainNow), feesOf(view, tokenFee));
  if (!own || own.outAmount <= 0n) throw new Error('our pool would not quote the middle swap');
  const q3 = await quoteDirectFirst(io, s, { inputMint: b, outputMint: SOL_QUOTE.mint, amount: own.outAmount, slippageBps: s.slippageBps, excludeDexes: refused.names });
  const bps = lastJupiterSlippage(BigInt(q3.outAmount), need, s.slippageBps);
  if (bps === null) {
    io.log(`${name}: skipped, ${amt(coinIn)} through ${view.quote.symbol} comes back as ${amt(BigInt(q3.outAmount))}: under the profit floor`);
    return 'quote-short';
  }
  const minOut = jupiterFloor(BigInt(q3.outAmount), bps);
  const si1 = await jupiterLeg(io.jupiter, owner, q1, (x) =>
    jupiterLegProblem(x.swap, {
      owner, refused: refused.programs, untouchable: [usdcAta, bAta],
      inputMint: coinMint, inputProgram: TOKEN_PROGRAM_ID, outputMint: new PublicKey(a), outputProgram: programOf(a), inAmount: coinIn, minOut: aIn,
    }),
  );
  const si3 = await jupiterLeg(io.jupiter, owner, { ...q3, slippageBps: bps, otherAmountThreshold: minOut.toString() }, (x) =>
    jupiterLegProblem(x.swap, {
      owner, refused: refused.programs, untouchable: [usdcAta, aAta],
      inputMint: new PublicKey(b), inputProgram: programOf(b), outputMint: coinMint, outputProgram: TOKEN_PROGRAM_ID, inAmount: own.outAmount, minOut,
    }),
  );
  return sendChecked(io, s, {
    name,
    kind: 'jupiter',
    pool: view.address,
    coin: SOL_QUOTE,
    coinIn,
    // Watched: the SOL grows by the floor; neither middle account shrinks.
    accounts: { coinAta, tokenAta: aAta, otherAta: bAta, tokenMint: new PublicKey(a), tokenProgram: programOf(a), coinMint },
    before,
    // sendChecked opens the SOL's and the first middle coin's accounts; the second's is opened here.
    legs: [
      createAssociatedTokenAccountIdempotentInstruction(owner, bAta, owner, new PublicKey(b), programOf(b)),
      si1.swap,
      ownSwap(owner, view, a === view.quote.mint ? 'coin' : 'token', aIn, own.outAmount),
      si3.swap,
    ],
    lookupTables: [...new Set([...si1.lookupTables, ...si3.lookupTables])],
    loan,
    floor: minProfit,
    verdict: (c) => simulationProblem(c, { minProfit }),
    says: (gained) =>
      `${plan.side === 'buy' ? `buy here with ${view.quote.symbol}, sell on Jupiter` : `buy on Jupiter, sell here for ${view.quote.symbol}`}, ${amt(coinIn)} in${borrowed(loan, amt)}, test run gains ${amt(gained)} (floor ${amt(minProfit)})`,
  });
}

/**
 * A trip between two pools that are not ours, as the scanner found and test-ran it: buy the token
 * through one outside exchange, sell it through another, in one transaction. Each leg is a Jupiter
 * swap held to its exchange and to one pool of it (`routeHeldTo`), the two in different pools; the
 * token passes the shared gate (keeper/rule.ts) on a fresh read of its mint; the size is the
 * scanner's, held to the rule's cap and the keeper's float; the second leg spends exactly the least
 * the first must pay, and its minimum and the Lighthouse check hold the coin to its floor. The
 * second leg is quoted before either swap is built: a trip that falls short costs two calls.
 */
async function outsideTrip(io: KeeperIo, s: KeeperSettings, t: OutsideTake, usd: ReadonlyMap<string, number>, refused: Refused, name: string): Promise<Tried> {
  const coin = KEEPER_COINS.find((c) => c.mint === t.coinMint);
  if (!coin || isKeeperCoin(t.tokenMint)) return 'no-plan';
  const [buy, sell] = t.legs;
  if (refused.programs.has(buy.program) || refused.programs.has(sell.program)) {
    io.log(`${name}: skipped, a leg is on a refused exchange`);
    return 'no-route';
  }
  const labels = await io.jupiter.labels();
  const [buyDex, sellDex] = [labels[buy.program], labels[sell.program]];
  if (!buyDex || !sellDex) {
    io.log(`${name}: skipped, Jupiter does not trade one of its exchanges`);
    return 'no-route';
  }
  const safety = (await readTokenSafety(io.rpc, [t.tokenMint])).get(t.tokenMint);
  const gate = tokenGate(safety);
  const facts = safety?.kind === 'read' ? safety.facts : null;
  if (gate || !facts) {
    io.log(`${name}: skipped, ${gate ?? 'its mint was not read'}`);
    return 'no-plan';
  }
  const owner = io.owner;
  const amt = amountText(coin);
  const coinMint = new PublicKey(coin.mint);
  const tokenMint = new PublicKey(t.tokenMint);
  const tokenProgram = facts.program === 'token-2022' ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID;
  const coinAta = getAssociatedTokenAddressSync(coinMint, owner, true, TOKEN_PROGRAM_ID);
  const tokenAta = getAssociatedTokenAddressSync(tokenMint, owner, true, tokenProgram);
  const otherAta = getAssociatedTokenAddressSync(new PublicKey(KEEPER_COINS.find((c) => c.mint !== coin.mint)!.mint), owner, true, TOKEN_PROGRAM_ID);
  const bounds = coinBounds(coin, usd.get(coin.mint), usd.get(SOL_QUOTE.mint), s);
  if (typeof bounds === 'string') {
    io.log(`${name}: skipped, ${bounds}`);
    return 'no-sol-price';
  }
  const before = await balances(io.rpc, [coinAta, tokenAta, otherAta, owner]);
  if (before.coin <= 0n) {
    io.log(`${name}: skipped, the keeper holds no ${coin.symbol}`);
    return 'no-coin';
  }
  // The scanner's size, never past the rule's cap, nor past what the keeper holds unless a loan
  // carries the rest (SOL, loans on): on x·y = k a smaller trip still pays.
  const sized = t.inRaw < bounds.cap ? t.inRaw : bounds.cap;
  const loan = loanFor(coin.mint, sized, before.coin, s.flashLoans);
  const coinIn = loan > 0n || sized <= before.coin ? sized : before.coin;
  const rent = rentToEarn(s, before.tokenExists, coin, usd);
  if (rent === null || coinIn <= 0n) return 'no-sol-price';
  const minProfit = bounds.floor + rent + flashFee(loan);
  const need = coinIn + minProfit;
  const held = (dex: string) => ({ slippageBps: s.slippageBps, excludeDexes: [], dexes: [dex], onlyDirectRoutes: true, maxAccounts: s.maxAccounts });
  const q1 = await io.jupiter.quote({ inputMint: coin.mint, outputMint: t.tokenMint, amount: coinIn, ...held(buyDex) });
  // The second leg spends exactly the least the first must pay.
  const tokensIn = jupiterFloor(BigInt(q1.outAmount), q1.slippageBps);
  const q2 = await io.jupiter.quote({ inputMint: t.tokenMint, outputMint: coin.mint, amount: tokensIn, ...held(sellDex) });
  const amm1 = q1.routePlan.map((r) => r.swapInfo?.ammKey);
  const amm2 = q2.routePlan.map((r) => r.swapInfo?.ammKey);
  if (amm1.length === 1 && amm1[0] === amm2[0]) {
    io.log(`${name}: skipped, Jupiter put both legs in one pool`);
    return 'no-route';
  }
  const bps = lastJupiterSlippage(BigInt(q2.outAmount), need, s.slippageBps);
  if (bps === null) {
    io.log(`${name}: skipped, ${amt(coinIn)} comes back as ${amt(BigInt(q2.outAmount))} through ${buyDex} then ${sellDex}: under the profit floor`);
    return 'quote-short';
  }
  const minOut = jupiterFloor(BigInt(q2.outAmount), bps);
  const legExpect = { owner, refused: refused.programs, untouchable: [otherAta] };
  const si1 = await jupiterLeg(io.jupiter, owner, q1, (x) =>
    routeHeldTo(x.swap, buy.program, amm1) ??
    jupiterLegProblem(x.swap, { ...legExpect, inputMint: coinMint, inputProgram: TOKEN_PROGRAM_ID, outputMint: tokenMint, outputProgram: tokenProgram, inAmount: coinIn, minOut: tokensIn }),
  );
  const si2 = await jupiterLeg(io.jupiter, owner, { ...q2, slippageBps: bps, otherAmountThreshold: minOut.toString() }, (x) =>
    routeHeldTo(x.swap, sell.program, amm2) ??
    jupiterLegProblem(x.swap, { ...legExpect, inputMint: tokenMint, inputProgram: tokenProgram, outputMint: coinMint, outputProgram: TOKEN_PROGRAM_ID, inAmount: tokensIn, minOut }),
  );
  return sendChecked(io, s, {
    name,
    kind: 'outside',
    // The pools Jupiter used, for the ban list: two refusals within a day leave either alone for a day.
    pool: `${amm1[0]} → ${amm2[0]}`,
    coin,
    coinIn,
    accounts: { coinAta, tokenAta, otherAta, tokenMint, tokenProgram, coinMint },
    before,
    legs: [si1.swap, si2.swap],
    lookupTables: [...new Set([...si1.lookupTables, ...si2.lookupTables])],
    loan,
    floor: minProfit,
    verdict: (c) => simulationProblem(c, { minProfit }),
    says: (gained) => `buy through ${buyDex}, sell through ${sellDex}, ${amt(coinIn)} in${borrowed(loan, amt)}, test run gains ${amt(gained)} (floor ${amt(minProfit)})`,
  });
}

/** A quote through one pool when Jupiter has one, so two Jupiter legs fit one transaction; else `quoteWithRoom`'s. */
async function quoteDirectFirst(io: KeeperIo, s: KeeperSettings, p: Omit<Parameters<JupiterApi['quote']>[0], 'maxAccounts' | 'onlyDirectRoutes'>): Promise<JupiterQuote> {
  try {
    return await io.jupiter.quote({ ...p, maxAccounts: s.maxAccounts, onlyDirectRoutes: true });
  } catch (e) {
    if (!(e instanceof Error && /NO_ROUTES_FOUND/.test(e.message))) throw e;
    return quoteWithRoom(io, s, p);
  }
}

/**
 * Jupiter's swap for `quote`, once `check` finds no problem with it. Asked first through the
 * keeper's own accounts. When that route names the keeper's other coin's account, it is asked
 * again through Jupiter's shared accounts, and checked the same way: a USDC trip whose only
 * route runs through SOL has its middle step in the keeper's wrapped SOL, which a route must
 * never touch (BAYLA against USDC, 2026-11-01). Anything Jupiter adds refuses it either way.
 */
export async function jupiterLeg(jupiter: JupiterApi, owner: PublicKey, quote: JupiterQuote, check: (si: SwapInstructions) => string | null): Promise<SwapInstructions> {
  const ask = async (shared: boolean) => {
    const si = await jupiter.swapInstructions(quote, owner, { shared });
    if (si.extra) throw new Error('Jupiter added instructions the keeper does not sign');
    return { si, problem: check(si) };
  };
  let leg = await ask(false);
  if (leg.problem === NAMES_OTHER_ACCOUNT) leg = await ask(true);
  if (leg.problem) throw new Error(leg.problem);
  return leg.si;
}

/** The least a Jupiter route pays, as the chain holds it to; 0 for one that is not a route (`jupiterLegProblem` refuses it). */
function routeFloor(si: SwapInstructions): bigint {
  const route = decodeJupiterRoute(si.swap.data);
  return route ? jupiterFloor(route.quotedOutAmount, route.slippageBps) : 0n;
}

/** A Jupiter quote within `maxAccounts`, or, when Jupiter finds none there, within ROOMY_ACCOUNTS. */
async function quoteWithRoom(io: KeeperIo, s: KeeperSettings, p: Omit<Parameters<JupiterApi['quote']>[0], 'maxAccounts'>): Promise<JupiterQuote> {
  try {
    return await io.jupiter.quote({ ...p, maxAccounts: s.maxAccounts });
  } catch (e) {
    if (!(e instanceof Error && /NO_ROUTES_FOUND/.test(e.message)) || s.maxAccounts >= ROOMY_ACCOUNTS) throw e;
    return io.jupiter.quote({ ...p, maxAccounts: ROOMY_ACCOUNTS });
  }
}

export interface Trip {
  name: string;
  kind: TripRecord['kind'];
  pool: string;
  coin: QuoteCoin;
  coinIn: bigint;
  accounts: { coinAta: PublicKey; tokenAta: PublicKey; otherAta: PublicKey; tokenMint: PublicKey; tokenProgram: PublicKey; coinMint: PublicKey };
  before: Balances;
  legs: TransactionInstruction[];
  lookupTables: string[];
  /** Lamports borrowed from Kamino inside the trip (SOL trips only, keeper/flashLoan.ts); absent or 0: none. */
  loan?: bigint;
  /**
   * The least the trip must gain, in the coin's base units (the network fee, $0.01, any new
   * account's rent, and any loan's fee). The last instruction, a Lighthouse check, holds the coin
   * account to what it held before plus this, or the chain undoes the whole trip.
   */
  floor: bigint;
  /** Why the test run's result must not be sent, or null. */
  verdict: (c: SimulatedChange) => string | null;
  says: (gained: bigint) => string;
}

/**
 * Every instruction of one trip, in order: the compute budget, the two coin accounts (opened if
 * missing), any loan's borrow, the swaps, the loan's repayment, and LAST the Lighthouse check
 * that the coin account holds at least `held` + the trip's floor (which counts the loan's fee).
 * Starting and ending in the same coin account, in one transaction.
 */
export function tripInstructions(
  owner: PublicKey,
  t: Pick<Trip, 'accounts' | 'legs' | 'floor' | 'loan'>,
  microLamports: number,
  units: number,
  held: bigint,
): TransactionInstruction[] {
  const { coinAta, tokenAta, tokenMint, tokenProgram, coinMint } = t.accounts;
  const head = [
    ComputeBudgetProgram.setComputeUnitLimit({ units }),
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports }),
    createAssociatedTokenAccountIdempotentInstruction(owner, coinAta, owner, coinMint, TOKEN_PROGRAM_ID),
    createAssociatedTokenAccountIdempotentInstruction(owner, tokenAta, owner, tokenMint, tokenProgram),
  ];
  const loan = t.loan ?? 0n;
  if (loan > 0n && coinMint.toBase58() !== SOL_QUOTE.mint) throw new Error('a loan is only taken on a SOL trip');
  // Kamino's repayment names the borrow by its place in the transaction.
  const borrowAt = head.length;
  return [
    ...head,
    ...(loan > 0n ? [flashBorrowIx(owner, coinAta, loan)] : []),
    ...t.legs,
    ...(loan > 0n ? [flashRepayIx(owner, coinAta, loan, borrowAt)] : []),
    atLeastCheck(coinAta, held + t.floor),
  ];
}

/** " (0.5 SOL of it borrowed)", or nothing without a loan. */
const borrowed = (loan: bigint, amt: (raw: bigint) => string) => (loan > 0n ? ` (${amt(loan)} of it borrowed)` : '');

/**
 * Build the trip, test-run it, judge what the test run did to the keeper's accounts, and send it
 * only when that passes (and only live). A confirmed trip's real result is read back for the log.
 */
async function sendChecked(io: KeeperIo, s: KeeperSettings, t: Trip): Promise<Tried> {
  const owner = io.owner;
  const { coinAta, tokenAta, otherAta } = t.accounts;
  const keys = [coinAta, tokenAta, otherAta, owner];
  const pools = t.pool.split(' → ');
  const banned = io.bans?.banned(pools, Date.now());
  if (banned) {
    io.log(`${t.name}: skipped, ${banned}`);
    return 'banned';
  }
  if (t.floor <= 0n) throw new Error('a trip with no floor is never built');
  // A loan's accounts sit in Kamino's lookup table, so they fit beside a Jupiter route.
  const alts = await lookupTablesOf(io.rpc, (t.loan ?? 0n) > 0n ? [...new Set([...t.lookupTables, KAMINO_LOOKUP_TABLE])] : t.lookupTables);
  // `held`: the coin account's amount the trip starts from. The Lighthouse check is last: it
  // holds the account to `held` + the floor once every swap has run, or the trip is undone.
  const build = async (units: number, held: bigint) => {
    const { blockhash } = ((await io.rpc('getLatestBlockhash', [{ commitment: 'confirmed' }])) as { value: { blockhash: string } }).value;
    const instructions = tripInstructions(owner, t, s.microLamports, units, held);
    return new VersionedTransaction(new TransactionMessage({ payerKey: owner, recentBlockhash: blockhash, instructions }).compileToV0Message(alts));
  };

  const sim = await simulate(io.rpc, await build(SIM_UNITS, t.before.coin), keys);
  if (sim.err) {
    io.log(`${t.name}: test run refused (${JSON.stringify(sim.err)})${sim.lastLog ? `: ${sim.lastLog}` : ''}`);
    return 'test-failed';
  }
  const change = changeOf(t.before, sim.after);
  const problem = t.verdict(change);
  if (problem) {
    io.log(`${t.name}: test run not sent, ${problem}`);
    return 'test-checks';
  }
  io.log(`${t.name}: ${t.says(change.coinAfter - change.coinBefore)}`);
  if (!io.send) return 'not-sent';
  // Read right before the send, so a top-up of the keeper's wallet meanwhile is no part of it:
  // the Lighthouse check counts from this amount.
  const atSend = await balances(io.rpc, keys);
  const tx = await build(Math.ceil(sim.units * 1.2) + 10_000, atSend.coin);
  const r = await io.send(tx);
  if (r.outcome === 'reverted') io.bans?.reverted(pools, Date.now());
  io.log(`${t.name}: sent ${r.signature}: ${r.outcome}`);
  let gained: bigint | null = null;
  // An unknown ending counts as the most a trip may cost, so the daily cap never counts it as free.
  let lamportsSpent: bigint | null = r.outcome === 'unknown' ? MAX_LAMPORTS_SPENT : null;
  // A refused trip still paid its fee: both endings are read back.
  if (r.outcome !== 'unknown') {
    try {
      const after = await balances(io.rpc, keys);
      gained = after.coin - atSend.coin;
      const spent = atSend.lamports - after.lamports;
      lamportsSpent = spent < 0n ? 0n : spent > MAX_LAMPORTS_SPENT ? MAX_LAMPORTS_SPENT : spent;
    } catch {
      // Unread: counted as the most a trip may cost.
      lamportsSpent = MAX_LAMPORTS_SPENT;
    }
  }
  try {
    io.record?.({ at: new Date().toISOString(), kind: t.kind, pool: t.pool, name: t.name, coin: t.coin, coinIn: t.coinIn, gained, lamportsSpent, signature: r.signature, outcome: r.outcome });
  } catch (e) {
    io.log(`${t.name}: the trip went out but was not logged: ${e instanceof Error ? e.message : String(e)}`);
  }
  return r.outcome === 'unknown' ? 'unsure' : 'sent';
}

/**
 * Sell what is left over in the keeper's wallet (any token but its two coins) for wrapped SOL,
 * once it is worth `dustMinUsd`. One Jupiter swap each, under every check a trip's Jupiter leg
 * gets, and test-run first: the SOL must grow by the swap's minimum. Returns how many it sent.
 */
export async function sellDust(io: KeeperIo, s: KeeperSettings): Promise<number> {
  const owner = io.owner;
  const toBase58 = (b: Uint8Array) => new PublicKey(b).toBase58();
  const held = [
    ...(await getTokenAccountsByOwner(io.rpc, owner.toBase58(), TOKEN_PROGRAM_ID.toBase58(), toBase58)).map((t) => ({ ...t, program: TOKEN_PROGRAM_ID })),
    ...(await getTokenAccountsByOwner(io.rpc, owner.toBase58(), TOKEN_2022_PROGRAM_ID.toBase58(), toBase58)).map((t) => ({ ...t, program: TOKEN_2022_PROGRAM_ID })),
  ].filter((t) => t.amount > 0n && !KEEPER_COINS.some((c) => c.mint === t.mint));
  if (!held.length) return 0;
  const prices = await pricesOf(io, [SOL_QUOTE.mint, ...held.map((t) => t.mint)]);
  const solUsd = prices[SOL_QUOTE.mint];
  if (!solUsd) return 0;
  const refused = s.allowRaydium ? refusedVenues({}, [], true) : refusedVenues(await io.jupiter.labels(), s.raydiumPrograms);
  if (!s.allowRaydium && !refused.names.length) return 0;
  const coinMint = new PublicKey(SOL_QUOTE.mint);
  const coinAta = getAssociatedTokenAddressSync(coinMint, owner, true, TOKEN_PROGRAM_ID);
  const otherAta = getAssociatedTokenAddressSync(new PublicKey(KEEPER_COINS.find((c) => c.mint !== SOL_QUOTE.mint)!.mint), owner, true, TOKEN_PROGRAM_ID);
  let sent = 0;
  let tried = 0;
  for (const t of held) {
    const tokenMint = new PublicKey(t.mint);
    const tokenAta = new PublicKey(t.address);
    // Only the keeper's own associated account: anything else in the wallet is not its to sell.
    if (!tokenAta.equals(getAssociatedTokenAddressSync(tokenMint, owner, true, t.program))) continue;
    const price = prices[t.mint];
    const decimals = await mintDecimals(io.rpc, t.mint);
    if (!price || decimals === null) continue;
    const worth = (Number(t.amount) / 10 ** decimals) * price;
    if (worth < s.dustMinUsd) continue;
    // A wallet anyone can send tokens to: a few sales a round, never one per airdropped coin.
    if (++tried > MAX_DUST_SALES) break;
    const name = `leftover ${t.mint} (about $${worth.toFixed(2)})`;
    try {
      const before = await balances(io.rpc, [coinAta, tokenAta, otherAta, owner]);
      const q = await quoteWithRoom(io, s, { inputMint: t.mint, outputMint: SOL_QUOTE.mint, amount: before.token, slippageBps: s.slippageBps, excludeDexes: refused.names });
      const si = await jupiterLeg(io.jupiter, owner, q, (x) =>
        jupiterLegProblem(x.swap, {
          owner, refused: refused.programs, untouchable: [otherAta],
          inputMint: tokenMint, inputProgram: t.program, outputMint: coinMint, outputProgram: TOKEN_PROGRAM_ID, inAmount: before.token, minOut: routeFloor(x),
        }),
      );
      // A route `jupiterLeg` took always decodes.
      const route = decodeJupiterRoute(si.swap.data)!;
      const minOut = routeFloor(si);
      if (route.slippageBps > s.slippageBps) throw new Error('the sale’s slippage is wider than the keeper allows');
      // Jupiter's listed price and its route differ by a few points on a thin coin; more is no sale.
      if ((Number(minOut) / 1e9) * solUsd < worth * DUST_FLOOR_OF_WORTH) throw new Error(`the sale pays under ${DUST_FLOOR_OF_WORTH * 100}% of the listed worth`);
      const amt = amountText(SOL_QUOTE);
      const o = await sendChecked(io, s, {
        name,
        kind: 'dust',
        pool: t.mint,
        coin: SOL_QUOTE,
        coinIn: 0n,
        accounts: { coinAta, tokenAta, otherAta, tokenMint, tokenProgram: t.program, coinMint },
        before,
        legs: [si.swap],
        lookupTables: si.lookupTables,
        // The sale's minimum: the Lighthouse check holds the wrapped SOL to growing by at least that.
        floor: minOut,
        verdict: (c) => dustSaleProblem(c, minOut, before.token),
        says: (gained) => `sold for ${amt(gained)} (minimum ${amt(minOut)})`,
      });
      if (wentOut(o)) sent++;
      if (o === 'unsure') break;
    } catch (e) {
      io.log(`${name}: not sold, ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return sent;
}

async function mintDecimals(rpc: SolanaRpc, mint: string): Promise<number | null> {
  const [m] = await getMultipleAccounts(rpc, [mint]);
  // Both token programs keep the decimals at byte 44 of the mint.
  return m && m.data.length >= 45 ? m.data[44]! : null;
}

interface Balances {
  coin: bigint;
  token: bigint;
  tokenExists: boolean;
  other: bigint;
  otherExists: boolean;
  lamports: bigint;
}

function changeOf(before: Balances, after: Balances): SimulatedChange {
  return {
    coinBefore: before.coin, coinAfter: after.coin, tokenBefore: before.token, tokenAfter: after.token,
    otherCoinBefore: before.other, otherCoinAfter: after.other, lamportsBefore: before.lamports, lamportsAfter: after.lamports,
  };
}

/** A token account's amount (offset 64), or 0 when the account does not exist yet. */
function tokenAmount(a: { data: Uint8Array } | null): bigint {
  if (!a || a.data.length < 72) return 0n;
  return new DataView(a.data.buffer, a.data.byteOffset, a.data.byteLength).getBigUint64(64, true);
}

/** Read at 'confirmed', the commitment the test run uses, so the two compare like with like. */
async function balances(rpc: SolanaRpc, keys: PublicKey[]): Promise<Balances> {
  const addresses = keys.map((k) => k.toBase58());
  const r = (await rpc('getMultipleAccounts', [addresses, { encoding: 'base64', commitment: 'confirmed' }])) as { value?: unknown[] };
  if (!Array.isArray(r?.value) || r.value.length !== addresses.length) throw new Error('the keeper’s balances were not read');
  const [c, t, x, o] = r.value.map((v, i) => (v === null ? null : decodeRpcAccount('getMultipleAccounts', addresses[i]!, v)));
  return { coin: tokenAmount(c ?? null), token: tokenAmount(t ?? null), tokenExists: !!t, other: tokenAmount(x ?? null), otherExists: !!x, lamports: BigInt(o?.lamports ?? 0) };
}

async function lookupTablesOf(rpc: SolanaRpc, addresses: string[]): Promise<AddressLookupTableAccount[]> {
  if (!addresses.length) return [];
  const got = await getMultipleAccounts(rpc, addresses);
  return got.map((a: RawAccount | null, i) => {
    if (!a || a.owner !== ALT_PROGRAM) throw new Error(`lookup table ${addresses[i]} not read`);
    return new AddressLookupTableAccount({ key: new PublicKey(addresses[i]!), state: AddressLookupTableAccount.deserialize(a.data) });
  });
}

interface Simulated {
  err: unknown;
  lastLog: string | null;
  units: number;
  after: Balances;
}

async function simulate(rpc: SolanaRpc, tx: VersionedTransaction, keys: PublicKey[]): Promise<Simulated> {
  let bytes: Uint8Array;
  try {
    bytes = tx.serialize();
  } catch {
    throw new Error('the trip’s swaps do not fit in one transaction');
  }
  const r = (await rpc('simulateTransaction', [
    Buffer.from(bytes).toString('base64'),
    {
      encoding: 'base64',
      sigVerify: false,
      replaceRecentBlockhash: true,
      commitment: 'confirmed',
      accounts: { encoding: 'base64', addresses: keys.map((k) => k.toBase58()) },
    },
  ])) as { value: { err: unknown; logs?: string[] | null; unitsConsumed?: number; accounts?: ({ data: [string, string]; lamports: number } | null)[] | null } };
  const v = r.value;
  const acc = v.accounts ?? [];
  const data = (i: number) => {
    const a = acc[i];
    return a ? { data: Uint8Array.from(Buffer.from(a.data[0], 'base64')) } : null;
  };
  const logs = v.logs ?? [];
  // An account the answer leaves out reads as empty, which every check then refuses.
  return {
    err: v.err,
    lastLog: logs.length ? logs[logs.length - 1]! : null,
    units: v.unitsConsumed ?? SIM_UNITS,
    after: { coin: tokenAmount(data(0)), token: tokenAmount(data(1)), tokenExists: !!acc[1], other: tokenAmount(data(2)), otherExists: !!acc[2], lamports: BigInt(acc[3]?.lamports ?? 0) },
  };
}
