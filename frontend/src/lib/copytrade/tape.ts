// THE ISLAND TAPE — the fills that actually happened in the island's own pools.
//
// ─── WHAT THIS REPLACES, AND WHY IT IS A DIFFERENT KIND OF SOURCE ────────────
//
// Copy trading was built against the venue's Ponder indexer, which is hosted
// nowhere: every panel parked in "could not be read" and the page was a form
// nobody could act on. The indexer is still the only source for SwapFeeRouter
// swaps and for history older than a page, so it is kept — but it is no longer
// the ONLY source, because there is a second one this app already reads in
// production: GeckoTerminal's per-pool trade tape, over the twelve island pools
// this registry names. No key, no proxy, no new function, and the CSP already
// allows the host.
//
// ─── THE FOUR THINGS A POOL TAPE CANNOT TELL YOU ─────────────────────────────
//
// 1. WHO TRADED. GeckoTerminal returns the address that SENT the transaction.
//    A bot, a relayer, an aggregator or a smart-contract wallet sends on
//    somebody else's behalf, so the address on a row is the sender and is
//    called the sender everywhere it is rendered. `TAPE_SENDER_NOTICE`.
// 2. A ROUND TRIP. One row is one leg. The matching exit may be in another
//    pool, on another chain, or a plain transfer — so no realised return exists
//    for anybody here, and none is computed. `TAPE_RETURN_RANKING`.
// 3. WHICH SIDE, from `kind` alone. GT's `kind` is relative to whichever token
//    it calls base for that pool, which is not necessarily the token this
//    registry calls base. Side is therefore DERIVED from the two token
//    addresses against this registry's own base/quote pair, and `kind` is used
//    only as a cross-check that forces 'unclassified' on disagreement.
// 4. HOW FAR BACK IT REACHES. One request per pool returns what upstream chose
//    to return. Coverage is stated as the oldest and newest block_timestamp
//    actually seen, never as a promised window.
//
// ─── AND THE READ ITSELF IS PART OF THE DATA ─────────────────────────────────
//
// Twelve keyless requests to a throttled upstream will sometimes be nine. A pool
// that could not be read is NOT a quiet pool, so it never becomes `read` with an
// empty array: it stays `unread` with its own reason, and the surface names it.

import { BUNGALOWS } from '../bungalows';
import { TOWELI_MARKET } from '../chart/market';
import { TOWELI_ADDRESS, WETH_ADDRESS } from '../constants';
import { contractOn } from '../chains/registry';
import { SOL_MINT } from '../solana';
import { ETH_ADDRESS_RE } from '../scanner/scanner';
import type { GeckoNetwork } from '../geckoTerminal/pools';
import {
  readPoolTrades,
  type PoolTrade,
  type PoolTradesRead,
  type PoolTradesUnreadReason,
} from '../geckoTerminal/poolTrades';
import { isSolanaPubkey, isSolanaSignature } from './base58';

/** How an address on a network is compared and validated. */
export type PoolFamily = 'evm' | 'solana';

export interface IslandPool {
  /** Registry id of the resident, or 'toweli' for the venue's own pool. */
  bungalowId: string;
  symbol: string;
  network: GeckoNetwork;
  family: PoolFamily;
  /** Pool address, exactly as the registry stores it (base58 is case-sensitive). */
  pool: string;
  /** The pair's own label, e.g. 'BOBO / SOL'. */
  label: string;
  /** The resident's token: mint on Solana, contract on EVM. Lowercased on EVM. */
  baseToken: string;
  /**
   * The pool's quote asset — network-specific WETH, or the wrapped-SOL mint.
   *
   * Null when the chain registry does not carry one. Null is not a shrug: every
   * fill on such a pool is 'unclassified' and none is ever sized, which is the
   * fail-closed direction. Guessing mainnet WETH for a Base pool would classify
   * every Base fill as unclassified anyway — but silently, and by accident.
   */
  quoteToken: string | null;
}

/** Base mainnet (OP-stack L2). The chain registry owns the WETH9 address. */
const BASE_CHAIN_ID = 8453;

function quoteTokenFor(network: GeckoNetwork): string | null {
  if (network === 'eth') return WETH_ADDRESS.toLowerCase();
  if (network === 'solana') return SOL_MINT;
  const weth = contractOn(BASE_CHAIN_ID, 'weth');
  return weth.status === 'deployed' ? weth.address.toLowerCase() : null;
}

function familyFor(network: GeckoNetwork): PoolFamily {
  return network === 'solana' ? 'solana' : 'evm';
}

/** Registry-form address: base58 is case-sensitive, hex is not. */
function normaliseToken(family: PoolFamily, address: string): string {
  return family === 'solana' ? address.trim() : address.trim().toLowerCase();
}

/**
 * Every island pool with both a readable market and a token behind it.
 *
 * Registry order, then the venue's own TOWELI/WETH pool last. TOWELI is appended
 * rather than filtered in because its market lives in lib/chart/market.ts (the
 * chart's pool), not on its registry row — a filter over `market` alone silently
 * drops the venue's own pool, which is the one pool this page has the most
 * reason to read.
 */
export function islandPools(): IslandPool[] {
  const out: IslandPool[] = [];
  for (const b of BUNGALOWS) {
    if (!b.market || !b.address) continue;
    const family = familyFor(b.market.network);
    out.push({
      bungalowId: b.id,
      symbol: b.symbol,
      network: b.market.network,
      family,
      pool: b.market.pool,
      label: b.market.label,
      baseToken: normaliseToken(family, b.address),
      quoteToken: quoteTokenFor(b.market.network),
    });
  }
  out.push({
    bungalowId: 'toweli',
    symbol: 'TOWELI',
    network: TOWELI_MARKET.network,
    family: familyFor(TOWELI_MARKET.network),
    pool: TOWELI_MARKET.pool,
    label: TOWELI_MARKET.label,
    baseToken: TOWELI_ADDRESS.toLowerCase(),
    quoteToken: quoteTokenFor(TOWELI_MARKET.network),
  });
  return out;
}

/**
 * The identity of one pool across a stored record.
 *
 * Carries the NETWORK as well as the address, for the same reason the trades
 * cache key does: a pool-only key is a cross-network collision the moment two
 * chains are in play, and the failure mode is not an error but one token's fills
 * reconciled against another's mirror.
 */
export function poolKeyOf(pool: IslandPool): string {
  return `${pool.network}:${pool.pool}`;
}

/**
 * THE PILL INPUT. True when there is at least one island pool to read.
 *
 * Registry-constant on purpose, in the same shape as /eth-curve's deployment
 * check: the pill clears because a readable pool is REGISTERED, not because a
 * read succeeded. A failed read is described by the page's own ledger, which can
 * name the pool and the reason; a pill can do neither, and a pill keyed to a
 * live read would flicker "SOON" during an upstream outage on a page that still
 * has a follow list, a mirror queue and a personal record to show.
 */
export function hasCopyTapeSource(): boolean {
  return islandPools().length > 0;
}

// ─── Transaction links ───────────────────────────────────────────────────────

/**
 * Per-network transaction explorer.
 *
 * DUPLICATE, KNOWINGLY: the same table exists in
 * components/bungalow/BungalowTrades.tsx. It belongs in lib/bungalows.ts so both
 * read one copy, and that lift is filed as a shared edit — this lane cannot
 * touch either file. Until it lands, this copy is the one the tape uses.
 */
export const MARKET_TX_EXPLORER: Record<GeckoNetwork, { base: string; name: string }> = {
  solana: { base: 'https://solscan.io/tx/', name: 'Solscan' },
  eth: { base: 'https://etherscan.io/tx/', name: 'Etherscan' },
  base: { base: 'https://basescan.org/tx/', name: 'Basescan' },
};

/**
 * An explorer URL for a transaction hash, or null.
 *
 * Null for anything that does not pass the family's own hash rule. An upstream
 * string is not a hash because it arrived in a hash-shaped field: interpolating
 * one into a link makes this app the thing that published it.
 */
export function marketTxUrl(network: GeckoNetwork, hash: string | null): string | null {
  if (!hash) return null;
  const h = hash.trim();
  const ok = network === 'solana' ? isSolanaSignature(h) : /^0x[0-9a-fA-F]{64}$/.test(h);
  return ok ? `${MARKET_TX_EXPLORER[network].base}${encodeURIComponent(h)}` : null;
}

// ─── Fills ───────────────────────────────────────────────────────────────────

export type FillSide = 'buy' | 'sell' | 'unclassified';

export interface TapeFill {
  pool: IslandPool;
  /** Null when the upstream value fails the family's hash rule — never linked. */
  txHash: string | null;
  /** The SENDER, validated for the family. Lowercased on EVM, exact on Solana. */
  wallet: string | null;
  side: FillSide;
  /** Unix seconds, from the row's own block_timestamp. */
  at: number;
  /** GeckoTerminal's USD valuation of the fill. Null stays null. */
  usd: number | null;
  /** The QUOTE-side amount as a decimal string, or null when the side is unclear. */
  quoteAmount: string | null;
  blockNumber: number | null;
}

/** Most fills one pool contributes. Beyond this the read is reported as capped. */
export const TAPE_CAP = 300;

/**
 * Which side of the pool's own pair this fill was, from the token legs alone.
 *
 * `kind` is NOT the source of truth. It is relative to whichever token
 * GeckoTerminal calls base for the pool, and this registry names its own base
 * (the resident's token) and quote (network WETH / wrapped SOL). When the two
 * disagree the honest answer is that we do not know, so the fill is
 * 'unclassified' — counted and shown, never sized and never labelled.
 */
export function classifySide(trade: PoolTrade, pool: IslandPool): FillSide {
  if (pool.quoteToken === null) return 'unclassified';
  const from = trade.fromTokenAddress;
  const to = trade.toTokenAddress;
  if (!from || !to) return 'unclassified';

  const f = normaliseToken(pool.family, from);
  const t = normaliseToken(pool.family, to);
  const base = pool.baseToken;
  const quote = pool.quoteToken;

  let derived: FillSide;
  if (f === quote && t === base) derived = 'buy';
  else if (f === base && t === quote) derived = 'sell';
  else return 'unclassified';

  // Cross-check. A row whose legs say "buy" while upstream says "sell" is a row
  // one of us has misread, and there is no way to tell which — so neither
  // answer is rendered.
  return trade.kind === derived ? derived : 'unclassified';
}

/** The address, if it is one on this family. Otherwise null — never the raw string. */
function walletFor(family: PoolFamily, raw: string | null): string | null {
  if (!raw) return null;
  const s = raw.trim();
  if (family === 'solana') return isSolanaPubkey(s) ? s : null;
  return ETH_ADDRESS_RE.test(s) ? s.toLowerCase() : null;
}

export type PoolTapeRead =
  | {
      status: 'read';
      pool: IslandPool;
      fills: TapeFill[];
      fetchedAt: number;
      /** Bounds of what upstream actually returned. The ONLY coverage claim made. */
      newestAt: number | null;
      oldestAt: number | null;
      /** The response filled the cap, so older fills exist and were not read. */
      capped: boolean;
      /** Rows dropped for an unparseable block_timestamp. Never silently zero. */
      undated: number;
    }
  | { status: 'unread'; pool: IslandPool; reason: PoolTradesUnreadReason; detail: string };

/**
 * One pool's read, turned into fills.
 *
 * A row whose block_timestamp does not parse is DROPPED and COUNTED rather than
 * dated 0: an epoch-zero fill sorts to the bottom of every window, ages out of
 * every signal check, and lands outside every coverage bound — it would be
 * invisible while still being counted as read.
 */
export function toTapeFills(pool: IslandPool, read: PoolTradesRead): PoolTapeRead {
  if (read.status === 'unread') {
    return { status: 'unread', pool, reason: read.reason, detail: read.detail };
  }

  const fills: TapeFill[] = [];
  let undated = 0;
  let newestAt: number | null = null;
  let oldestAt: number | null = null;

  for (const trade of read.trades) {
    const ms = Date.parse(trade.at);
    if (!Number.isFinite(ms)) {
      undated += 1;
      continue;
    }
    const at = Math.floor(ms / 1000);
    const side = classifySide(trade, pool);
    // The quote leg is what a cap is denominated in, so it is taken from the
    // side that was DERIVED: on a buy the quote token is what was given
    // (from_token_amount), on a sell it is what was received. An unclassified
    // fill has no known quote leg at all.
    const quoteAmount =
      side === 'buy' ? trade.fromTokenAmount : side === 'sell' ? trade.toTokenAmount : null;

    fills.push({
      pool,
      txHash: marketTxUrl(pool.network, trade.txHash) === null ? null : trade.txHash.trim(),
      wallet: walletFor(pool.family, trade.wallet),
      side,
      at,
      usd: trade.usd,
      quoteAmount,
      blockNumber: trade.blockNumber,
    });

    if (newestAt === null || at > newestAt) newestAt = at;
    if (oldestAt === null || at < oldestAt) oldestAt = at;
  }

  return {
    status: 'read',
    pool,
    fills,
    fetchedAt: read.fetchedAt,
    newestAt,
    oldestAt,
    capped: read.trades.length >= TAPE_CAP,
    undated,
  };
}

// ─── The walk ────────────────────────────────────────────────────────────────

export interface IslandTape {
  reads: PoolTapeRead[];
  fetchedAt: number;
  /** True when a 429 ended the walk, so the remaining pools were never asked. */
  stoppedEarly: boolean;
}

/** Gap between requests. The upstream is keyless and throttles by IP. */
export const REQUEST_SPACING_MS = 250;

/** How long a manual refresh is refused for. Nothing polls; this bounds the button. */
export const MIN_TAPE_REFRESH_SECONDS = 60;

const NOT_ATTEMPTED_DETAIL =
  'The trades feed started rate-limiting part-way through this pass, so this pool was never asked. That is a gap in the read, not a quiet pool.';

export interface ReadIslandTapeOptions {
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
  now?: () => number;
  /** Injected so a test does not have to wait out the real spacing. */
  sleep?: (ms: number) => Promise<void>;
  spacingMs?: number;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Read every island pool, ONE AT A TIME.
 *
 * Sequential and spaced, following the pattern useSourceVerification already
 * uses against a keyless upstream: twelve parallel requests is the fastest way
 * to turn a working feed into twelve 429s. A 429 stops the walk and everything
 * still outstanding is marked 'not-attempted' — the one state that says "we did
 * not ask", as opposed to "we asked and there was nothing".
 */
export async function readIslandTape(
  pools: readonly IslandPool[],
  opts: ReadIslandTapeOptions = {},
): Promise<IslandTape> {
  const clock = opts.now ?? Date.now;
  const sleep = opts.sleep ?? defaultSleep;
  const spacing = opts.spacingMs ?? REQUEST_SPACING_MS;

  const reads: PoolTapeRead[] = [];
  let stoppedEarly = false;

  for (let i = 0; i < pools.length; i++) {
    const pool = pools[i]!;

    if (stoppedEarly || opts.signal?.aborted) {
      reads.push({ status: 'unread', pool, reason: 'not-attempted', detail: NOT_ATTEMPTED_DETAIL });
      continue;
    }

    const read = await readPoolTrades(pool.network, pool.pool, {
      signal: opts.signal,
      fetchImpl: opts.fetchImpl,
      now: clock,
    });
    reads.push(toTapeFills(pool, read));

    if (read.status === 'unread' && read.reason === 'rate-limited') {
      // Throttled, not flaky. Burning the rest of the queue converts one 429
      // into eleven, and every one of them would render as a pool with no fills.
      stoppedEarly = true;
      continue;
    }
    if (i < pools.length - 1) await sleep(spacing);
  }

  return { reads, fetchedAt: clock(), stoppedEarly };
}
