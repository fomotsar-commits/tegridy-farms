// Outcomes/summary population from external data (docs/LAUNCHER_STRATEGY.md §2.5/§2.7).
//
// The outcomes.ts and ordering.ts cores are pure and shape-only: they DERIVE flags
// and scores from an OutcomeRecord / LaunchSummary, but they don't say where those
// records come from. This module is the honest bridge — it assembles those records
// from live market + chain data WITHOUT touching the network directly.
//
// Why dependency-injected fetchers (not a new /api function):
//   - Vercel Hobby caps 12 serverless fns (main=9); the aggregator catchall is
//     load-bearing and we must NOT add a new api/ endpoint. Instead the HTTP call
//     lives behind the injected `LauncherDataFetcher` interface, so a thin adapter
//     can be wired into the existing aggregator catchall later (see integrationSteps
//     in the build report) and the pure logic here stays unit-testable with a mock.
//   - eth_getLogs is DEAD on free RPCs, so we do NOT scan logs for launch discovery.
//     The launch list is CONSUMED as input (from GeckoTerminal 'new pools' or an
//     Etherscan token-tx feed / indexer). This reader never discovers launches; it
//     enriches a provided address list.
//
// Disclosure-only, never endorsement. Everything here is factual market/chain data;
// no "rug"/"scam"/"safe"/"guaranteed" wording enters. Missing data degrades safely
// (fields fall back to conservative defaults, no throw) so a flaky upstream never
// fabricates a rosy — or a damning — picture.

import type { Address } from 'viem';
import type { LaunchTier } from './factSheet';
import type { OutcomeRecord, UnlockEvent } from './outcomes';
import type { LaunchSummary } from './ordering';

// ---------------------------------------------------------------------------
// Injected fetcher interface (the ONLY network boundary — mocked in tests).
// ---------------------------------------------------------------------------

/**
 * Live market data for a token's pool, sourced from GeckoTerminal.
 *
 * Mainnet endpoint shape (documented for the thin adapter, NOT called here):
 *   GET https://api.geckoterminal.com/api/v2/networks/eth/tokens/{tokenAddress}
 *     ?include=top_pools
 *   Response (JSON:API):
 *     data.attributes.price_usd            -> string USD price
 *     data.attributes.total_reserve_in_usd -> string pooled liquidity (USD)
 *   Or per-pool:
 *   GET https://api.geckoterminal.com/api/v2/networks/eth/pools/{poolAddress}
 *     data.attributes.base_token_price_native_currency -> string price in WETH
 *     data.attributes.reserve_in_usd                   -> string liquidity USD
 *     data.attributes.transactions.h24.buyers          -> number unique buyers 24h
 *     data.attributes.volume_usd.h24                   -> string 24h volume
 * We normalize everything to ETH/WETH-denominated numbers in the adapter so the
 * pure core never handles USD<->ETH conversion or string parsing.
 */
export interface TokenMarket {
  /** Current price, denominated in ETH (WETH). */
  priceEth: number;
  /** Current pooled liquidity, denominated in ETH (WETH). */
  liquidityEth: number;
  /** Unique buyer addresses in the trailing 24h (anti-wash activity signal). */
  uniqueBuyers24h: number;
  /** Protocol/pool fee revenue attributable to the trailing 24h, in ETH. */
  feeRevenueEth24h: number;
}

/**
 * On-chain accounting data, sourced from the Etherscan (Etherscan V2 / eth) API.
 *
 * Mainnet endpoint shapes (documented for the adapter, NOT called here):
 *   Holder count (Pro-tier stat, else derive from an indexer):
 *     GET https://api.etherscan.io/api?module=token&action=tokenholdercount
 *         &contractaddress={token}&apikey={KEY}
 *       result -> decimal string holder count
 *   Creator's last on-chain activity (normal tx list, newest first, 1 row):
 *     GET https://api.etherscan.io/api?module=account&action=txlist
 *         &address={creator}&startblock=0&endblock=99999999
 *         &page=1&offset=1&sort=desc&apikey={KEY}
 *       result[0].timeStamp -> unix seconds of most recent tx
 * The adapter parses these to numbers; missing/rate-limited responses should
 * resolve to nulls (never throw) so this core can degrade.
 */
export interface TokenChainStats {
  /** Distinct holder count, or null when unavailable (Etherscan Pro-gated / indexer down). */
  holderCount: number | null;
  /** Unix seconds of the creator/team address's most recent tx, or null if unknown. */
  lastTeamActivityAt: number | null;
}

/** The injected async boundary. A real adapter fulfills these via HTTP behind the catchall. */
export interface LauncherDataFetcher {
  fetchMarket(token: Address): Promise<TokenMarket | null>;
  fetchChainStats(token: Address, creator: Address | null): Promise<TokenChainStats | null>;
}

// ---------------------------------------------------------------------------
// Raw per-launch input the reader is HANDED (from the discovery list + fact sheet).
// This is NOT discovered here — it's the known, disclosed-at-graduation baseline.
// ---------------------------------------------------------------------------

/**
 * The immutable, known-at-graduation facts for one launch. Comes from the launch's
 * own fact sheet / graduation record — NOT from any live upstream. Pairing these
 * baselines with live market/chain reads is what produces a trajectory.
 */
export interface LaunchBaseline {
  token: Address;
  tier: LaunchTier;
  /** Creator/team address, for last-activity lookups. Null if not disclosed. */
  creator: Address | null;
  /** Unix seconds the launch graduated / went live. */
  launchedAt: number;
  /** Price at graduation, in ETH. */
  launchPriceEth: number;
  /** Pooled liquidity at graduation, in ETH. */
  launchLiquidityEth: number;
  /** Disclosed vesting/unlock schedule with observed sell-through, from the tracker. */
  unlocks?: UnlockEvent[];
}

// ---------------------------------------------------------------------------
// Safe-default helpers. Any missing/garbage number collapses to a conservative 0.
// ---------------------------------------------------------------------------

function finiteOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/** Non-negative finite number, else fallback. Prevents negative liquidity/price poisoning flags. */
function nonNegOr(value: unknown, fallback: number): number {
  const n = finiteOr(value, fallback);
  return n < 0 ? fallback : n;
}

const EMPTY_MARKET: TokenMarket = {
  priceEth: 0,
  liquidityEth: 0,
  uniqueBuyers24h: 0,
  feeRevenueEth24h: 0,
};

const EMPTY_CHAIN: TokenChainStats = {
  holderCount: null,
  lastTeamActivityAt: null,
};

/** Coerce a possibly-partial/hostile TokenMarket into fully-defined safe numbers. */
function normalizeMarket(m: TokenMarket | null | undefined): TokenMarket {
  if (!m) return { ...EMPTY_MARKET };
  return {
    priceEth: nonNegOr(m.priceEth, 0),
    liquidityEth: nonNegOr(m.liquidityEth, 0),
    uniqueBuyers24h: Math.floor(nonNegOr(m.uniqueBuyers24h, 0)),
    feeRevenueEth24h: nonNegOr(m.feeRevenueEth24h, 0),
  };
}

/** Coerce possibly-partial/hostile TokenChainStats; null holder count stays null (unknown ≠ zero). */
function normalizeChain(c: TokenChainStats | null | undefined): TokenChainStats {
  if (!c) return { ...EMPTY_CHAIN };
  const holder =
    c.holderCount == null ? null : Math.max(0, Math.floor(finiteOr(c.holderCount, 0)));
  const last =
    c.lastTeamActivityAt == null ? null : Math.max(0, Math.floor(finiteOr(c.lastTeamActivityAt, 0)));
  return { holderCount: holder, lastTeamActivityAt: last };
}

// ---------------------------------------------------------------------------
// Builders — the exported pure(ish) surface. Async only because the injected
// fetcher is async; all decisioning is deterministic and side-effect-free.
// ---------------------------------------------------------------------------

/**
 * Assemble a point-in-time {@link OutcomeRecord} for one launch by pairing its
 * known baseline with a live market + chain read. Never throws on upstream
 * failure — a null/partial fetch degrades to a conservative snapshot (price 0,
 * liquidity 0, holderCount 0, unknown team activity) so the derived flags stay
 * factual rather than fabricated.
 *
 * @param observedAt unix seconds of this observation (injected — deterministic tests).
 */
export async function buildOutcomeRecord(
  baseline: LaunchBaseline,
  fetcher: LauncherDataFetcher,
  observedAt: number,
): Promise<OutcomeRecord> {
  // DISCLOSURE INTEGRITY: distinguish "market not observed" (upstream null/outage)
  // from "market observed as zero" (a real drain). Collapsing a failed fetch to 0
  // would make deriveOutcomeFlags fabricate a -100% crash + 100% liquidity drain
  // for a perfectly healthy launch — a defamatory false signal. So when the market
  // is UNOBSERVED we mirror the baseline (→ 0% change, no drain flag) and flag
  // marketObserved:false so the UI renders "unavailable" instead of "no adverse signals".
  const rawMarket = await safeCall(() => fetcher.fetchMarket(baseline.token));
  const marketObserved = rawMarket != null;
  const market = normalizeMarket(rawMarket);
  const chain = normalizeChain(
    await safeCall(() => fetcher.fetchChainStats(baseline.token, baseline.creator)),
  );

  const launchPriceEth = nonNegOr(baseline.launchPriceEth, 0);
  const launchLiquidityEth = nonNegOr(baseline.launchLiquidityEth, 0);

  return {
    token: baseline.token,
    tier: baseline.tier,
    launchedAt: baseline.launchedAt,
    observedAt,
    priceEth: marketObserved ? market.priceEth : launchPriceEth,
    launchPriceEth,
    liquidityEth: marketObserved ? market.liquidityEth : launchLiquidityEth,
    launchLiquidityEth,
    // holderCount is a required number on OutcomeRecord; unknown degrades to 0.
    holderCount: chain.holderCount ?? 0,
    unlocks: baseline.unlocks ?? [],
    lastTeamActivityAt: chain.lastTeamActivityAt,
    marketObserved,
  };
}

/**
 * Assemble a {@link LaunchSummary} (the ordering input) for one launch. Same
 * injected-fetcher, same safe-degradation contract. Note the summary shape has NO
 * pay-to-rank field by construction; this builder cannot introduce one.
 */
export async function buildLaunchSummary(
  baseline: LaunchBaseline,
  fetcher: LauncherDataFetcher,
): Promise<LaunchSummary | null> {
  // If the market is unobserved (outage/rate-limit) we return null rather than a
  // zero-activity summary — an outage-hit launch keeps its PRIOR rank instead of
  // being unfairly deranked to the bottom. buildLaunchSummaries filters nulls.
  const rawMarket = await safeCall(() => fetcher.fetchMarket(baseline.token));
  if (rawMarket == null) return null;
  const market = normalizeMarket(rawMarket);
  const chain = normalizeChain(
    await safeCall(() => fetcher.fetchChainStats(baseline.token, baseline.creator)),
  );

  return {
    token: baseline.token,
    tier: baseline.tier,
    launchedAt: baseline.launchedAt,
    uniqueBuyers24h: market.uniqueBuyers24h,
    liquidityEth: market.liquidityEth,
    feeRevenueEth24h: market.feeRevenueEth24h,
    holderCount: chain.holderCount ?? 0,
  };
}

/**
 * Batch helper: build OutcomeRecords for a CONSUMED launch list (the list itself
 * comes from GeckoTerminal 'new pools' / Etherscan token-tx / an indexer upstream —
 * this reader does not discover it). Each launch is enriched independently; one
 * launch's upstream failure never aborts the batch.
 */
export async function buildOutcomeRecords(
  baselines: readonly LaunchBaseline[],
  fetcher: LauncherDataFetcher,
  observedAt: number,
): Promise<OutcomeRecord[]> {
  return Promise.all(baselines.map((b) => buildOutcomeRecord(b, fetcher, observedAt)));
}

/** Batch helper for the ordering surface. Same consumed-list contract as above.
 *  Outage-hit launches (null market) are FILTERED OUT rather than deranked to zero. */
export async function buildLaunchSummaries(
  baselines: readonly LaunchBaseline[],
  fetcher: LauncherDataFetcher,
): Promise<LaunchSummary[]> {
  const rows = await Promise.all(baselines.map((b) => buildLaunchSummary(b, fetcher)));
  return rows.filter((r): r is LaunchSummary => r !== null);
}

/** Run an injected fetch, converting any rejection into a null so callers can degrade. */
async function safeCall<T>(fn: () => Promise<T | null>): Promise<T | null> {
  try {
    return await fn();
  } catch {
    return null;
  }
}
