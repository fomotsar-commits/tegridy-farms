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
import { PRICE_IDS_MAX, arbitrage, listPools, marketPriceIds, readMarketPrices, rowTokenFee } from '../lp/poolList';
import { SOL_QUOTE, type QuoteCoin } from '../lp/quotes';
import { readTokenSafety, type TokenSafety } from '../lp/tokenSafety';
import { refusedVenues, type JupiterApi, type JupiterQuote, type SwapInstructions } from './jupiterApi';
import {
  KEEPER_COINS,
  MAX_LAMPORTS_SPENT,
  NAMES_OTHER_ACCOUNT,
  NEW_ACCOUNT_RENT,
  decodeJupiterRoute,
  dustSaleProblem,
  jupiterFloor,
  jupiterLegProblem,
  lamportsInCoin,
  lastJupiterSlippage,
  lastPoolMinimum,
  ownPairPlan,
  planFor,
  poolProblem,
  priceStep,
  simulationProblem,
  type KeeperLimits,
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
  log: (line: string) => void;
}

export interface KeeperSettings extends KeeperLimits {
  /** Jupiter's route may use at most this many accounts, so both swaps fit one transaction. */
  maxAccounts: number;
  /** Priority fee, in micro-lamports per compute unit. */
  microLamports: number;
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
}

export const DEFAULT_SETTINGS: Omit<KeeperSettings, keyof KeeperLimits | 'raydiumPrograms'> = {
  maxAccounts: 30,
  microLamports: 10_000,
  allowRaydium: false,
  payNewAccountRent: false,
  dustMinUsd: 1,
};

/** One sent trip, for the keeper's earnings log. `gained`/`lamportsSpent` are null when it did not confirm. */
export interface TripRecord {
  at: string;
  kind: 'jupiter' | 'own-pools' | 'dust';
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
}

const SIM_UNITS = 1_400_000;
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
type Outcome = 'none' | 'sent' | 'unsure';

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

const problemOf = (view: PoolView, safety: ReadonlyMap<string, TokenSafety>) => poolProblem(view, rowTokenFee(view, safety.get(view.tokenMint) ?? null));

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
  const empty = (pools: PoolView[]): CycleResult => ({ pools: pools.length, gaps: 0, sent: 0, watch: watchOf(pools) });
  const venue = await readVenue(io);
  if (typeof venue === 'string') {
    io.log(`Pools not read: ${venue}`);
    return empty([]);
  }
  const { pools, chainNow, safety } = venue;
  const prices = await readMarketPrices(pools, (m) => io.jupiter.prices(m));
  if (prices.kind === 'unread') {
    io.log('Jupiter prices not read: nothing is traded this pass');
    return empty(pools);
  }
  const refused = s.allowRaydium ? refusedVenues({}, [], true) : refusedVenues(await io.jupiter.labels(), s.raydiumPrograms);
  if (!s.allowRaydium && !refused.names.length) {
    io.log('Jupiter’s venue list names no Raydium venue, so Raydium cannot be left out: nothing is traded this pass');
    return empty(pools);
  }
  const usable = pools.filter((v) => problemOf(v, safety) === null);
  let gaps = 0;
  let sent = 0;
  // Pools a sent trip has moved: their read is old until the next pass.
  const moved = new Set<string>();
  const counted = (o: Outcome, ...touched: PoolView[]) => {
    if (o !== 'none') {
      sent++;
      for (const v of touched) moved.add(v.address);
    }
    return o === 'unsure';
  };

  // 1. Between our own pools of one pair: both fees stay with the venue.
  for (const [i, a] of usable.entries()) {
    for (const b of usable.slice(i + 1)) {
      if (a.tokenMint !== b.tokenMint || a.quote.mint !== b.quote.mint || moved.has(a.address) || moved.has(b.address)) continue;
      if (chainNow === null) continue;
      try {
        const o = await ownPairTrip(io, s, a, b, chainNow, prices.usd, nameOf(a, safety));
        if (counted(o, a, b)) return stopForUnsure(io, pools, gaps, sent);
      } catch (e) {
        io.log(`${nameOf(a, safety)}, between our pools: stopped, ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }

  // 2. Against Jupiter.
  for (const view of usable) {
    if (moved.has(view.address)) continue;
    const name = nameOf(view, safety);
    const arb = arbitrage(view, prices.usd, chainNow, null);
    if (!arb) continue;
    gaps++;
    const plan = planFor(view, arb, prices.usd, s);
    if (typeof plan === 'string') {
      io.log(`${name}: gap of up to $${arb.profitUsd.toFixed(2)} at Jupiter's listed price, skipped (${plan})`);
      continue;
    }
    try {
      if (counted(await jupiterTrip(io, s, view, plan, chainNow, prices.usd, refused, name), view)) return stopForUnsure(io, pools, gaps, sent);
    } catch (e) {
      const said = e instanceof Error ? e.message : String(e);
      // The usual reason, said plainly: the coin's only market Jupiter knows is a refused venue's.
      io.log(`${name}: ${/NO_ROUTES_FOUND/.test(said) && refused.names.length ? 'skipped, Jupiter has no route for it that avoids Raydium' : `stopped, ${said}`}`);
    }
  }
  return { pools: pools.length, gaps, sent, watch: watchOf(pools) };
}

function stopForUnsure(io: KeeperIo, pools: PoolView[], gaps: number, sent: number): CycleResult {
  // Until it is known whether that trip landed, no balance read can be trusted.
  io.log('A sent trip is not confirmed yet: the rest of this pass waits for the next read');
  return { pools: pools.length, gaps, sent, watch: watchOf(pools) };
}

function watchOf(pools: readonly PoolView[]): Watch {
  return { vaults: pools.flatMap((v) => [v.snapshot.pool.token0Vault, v.snapshot.pool.token1Vault]), mints: marketPriceIds(pools) };
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
  const tokenProgram = new PublicKey(view.quoteIsToken0 ? pool.token1Program : pool.token0Program);
  const coinAta = getAssociatedTokenAddressSync(coinMint, owner, true, TOKEN_PROGRAM_ID);
  const tokenAta = getAssociatedTokenAddressSync(tokenMint, owner, true, tokenProgram);
  // The keeper's other float (USDC on a SOL trip, wrapped SOL on a USDC one): watched, never
  // touched. In the SOL/USDC pool the token IS that float, already watched as the token.
  const other = KEEPER_COINS.find((c) => c.mint !== view.quote.mint && c.mint !== view.tokenMint);
  const otherAta = other ? getAssociatedTokenAddressSync(new PublicKey(other.mint), owner, true, TOKEN_PROGRAM_ID) : tokenAta;
  return { coinMint, tokenMint, tokenProgram, coinAta, tokenAta, otherAta, hasOther: !!other };
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
    inputTokenProgram: coinIn ? TOKEN_PROGRAM_ID : a.tokenProgram,
    outputTokenProgram: coinIn ? a.tokenProgram : TOKEN_PROGRAM_ID,
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
    verdict: (c) => simulationProblem(c, { minProfit }),
    says: (gained) => `buy in ${plan.cheap.address}, sell in ${plan.dear.address}, ${amt(plan.coinIn)} in, test run gains ${amt(gained)} (floor ${amt(minProfit)})`,
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
): Promise<Outcome> {
  if (!view.config || chainNow === null) throw new Error('pool fees or the clock not read');
  const owner = io.owner;
  const amt = amountText(view.quote);
  const acc = accountsFor(owner, view);
  const before = await balances(io.rpc, [acc.coinAta, acc.tokenAta, acc.otherAta, owner]);
  if (before.coin <= 0n) {
    io.log(`${name}: skipped, the keeper holds no ${view.quote.symbol}`);
    return 'none';
  }
  if (before.coin < plan.coinIn) {
    // A smaller trip than the gap allows still pays on x·y = k; the checks below say if it does not.
    io.log(`${name}: the gap takes ${amt(plan.coinIn)}, the keeper holds ${amt(before.coin)}: a smaller trip`);
    plan = { ...plan, coinIn: before.coin };
  }
  const rent = rentToEarn(s, before.tokenExists, view.quote, usd);
  if (rent === null) {
    io.log(`${name}: skipped, no SOL price to count the new token account’s rent`);
    return 'none';
  }
  plan = { ...plan, minProfit: plan.minProfit + rent };
  const need = plan.coinIn + plan.minProfit;
  const legExpect = { owner, refused: refused.programs, untouchable: acc.hasOther ? [acc.otherAta] : [] };
  let legs: TransactionInstruction[];
  let lookupTables: string[];
  if (plan.side === 'buy') {
    const own = quoteOwnPool(view.snapshot, view.config, plan.coinMint, plan.coinIn, Number(chainNow));
    if (!own || own.outAmount <= 0n) throw new Error('our pool would not quote the buy');
    const q = await quoteWithRoom(io, s, { inputMint: plan.tokenMint, outputMint: plan.coinMint, amount: own.outAmount, slippageBps: s.slippageBps, excludeDexes: refused.names });
    const bps = lastJupiterSlippage(BigInt(q.outAmount), need, s.slippageBps);
    if (bps === null) {
      io.log(`${name}: skipped, Jupiter pays back ${amt(BigInt(q.outAmount))} for ${amt(plan.coinIn)}: under the profit floor`);
      return 'none';
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
    const own = quoteOwnPool(view.snapshot, view.config, plan.tokenMint, tokensIn, Number(chainNow));
    const ownMin = own ? lastPoolMinimum(own.outAmount, need, s.slippageBps) : null;
    if (ownMin === null) {
      io.log(`${name}: skipped, our pool pays ${amt(own?.outAmount ?? 0n)} for what ${amt(plan.coinIn)} buys on Jupiter: under the profit floor`);
      return 'none';
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
    verdict: (c) => simulationProblem(c, done),
    says: (gained) =>
      `${done.side === 'buy' ? 'buy here, sell on Jupiter' : 'buy on Jupiter, sell here'}, ${amt(done.coinIn)} in, test run gains ${amt(gained)} (floor ${amt(done.minProfit)})`,
  });
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

interface Trip {
  name: string;
  kind: TripRecord['kind'];
  pool: string;
  coin: QuoteCoin;
  coinIn: bigint;
  accounts: { coinAta: PublicKey; tokenAta: PublicKey; otherAta: PublicKey; tokenMint: PublicKey; tokenProgram: PublicKey; coinMint: PublicKey };
  before: Balances;
  legs: TransactionInstruction[];
  lookupTables: string[];
  /** Why the test run's result must not be sent, or null. */
  verdict: (c: SimulatedChange) => string | null;
  says: (gained: bigint) => string;
}

/**
 * Build the trip, test-run it, judge what the test run did to the keeper's accounts, and send it
 * only when that passes (and only live). A confirmed trip's real result is read back for the log.
 */
async function sendChecked(io: KeeperIo, s: KeeperSettings, t: Trip): Promise<Outcome> {
  const owner = io.owner;
  const { coinAta, tokenAta, otherAta, tokenMint, tokenProgram, coinMint } = t.accounts;
  const keys = [coinAta, tokenAta, otherAta, owner];
  const alts = await lookupTablesOf(io.rpc, t.lookupTables);
  const build = async (units: number) => {
    const { blockhash } = ((await io.rpc('getLatestBlockhash', [{ commitment: 'confirmed' }])) as { value: { blockhash: string } }).value;
    const instructions = [
      ComputeBudgetProgram.setComputeUnitLimit({ units }),
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports: s.microLamports }),
      createAssociatedTokenAccountIdempotentInstruction(owner, coinAta, owner, coinMint, TOKEN_PROGRAM_ID),
      createAssociatedTokenAccountIdempotentInstruction(owner, tokenAta, owner, tokenMint, tokenProgram),
      ...t.legs,
    ];
    return new VersionedTransaction(new TransactionMessage({ payerKey: owner, recentBlockhash: blockhash, instructions }).compileToV0Message(alts));
  };

  const sim = await simulate(io.rpc, await build(SIM_UNITS), keys);
  if (sim.err) {
    io.log(`${t.name}: test run refused (${JSON.stringify(sim.err)})${sim.lastLog ? `: ${sim.lastLog}` : ''}`);
    return 'none';
  }
  const change = changeOf(t.before, sim.after);
  const problem = t.verdict(change);
  if (problem) {
    io.log(`${t.name}: test run not sent, ${problem}`);
    return 'none';
  }
  io.log(`${t.name}: ${t.says(change.coinAfter - change.coinBefore)}`);
  if (!io.send) return 'none';
  const tx = await build(Math.ceil(sim.units * 1.2) + 10_000);
  // Read right before the send, so a top-up of the keeper's wallet meanwhile is no part of it.
  const atSend = await balances(io.rpc, keys);
  const r = await io.send(tx);
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
        verdict: (c) => dustSaleProblem(c, minOut, before.token),
        says: (gained) => `sold for ${amt(gained)} (minimum ${amt(minOut)})`,
      });
      if (o !== 'none') sent++;
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
  return { coin: tokenAmount(c ?? null), token: tokenAmount(t ?? null), tokenExists: !!t, other: tokenAmount(x ?? null), lamports: BigInt(o?.lamports ?? 0) };
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
    after: { coin: tokenAmount(data(0)), token: tokenAmount(data(1)), tokenExists: !!acc[1], other: tokenAmount(data(2)), lamports: BigInt(acc[3]?.lamports ?? 0) },
  };
}
