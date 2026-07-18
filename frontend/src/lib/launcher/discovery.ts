// Launch discovery mapper — the missing seam that produces the CONSUMED launch
// list (LaunchBaseline[]) the outcomes enrichment path already accepts.
//
// The enrichment path (outcomesClient.ts + api/_lib/launcher-outcomes.js) takes
// { baselines: LaunchBaseline[], poolByToken } and pairs each baseline with a
// live market/chain read. It never discovers launches. This module fills that
// one gap with a PURE, network-free transform:
//
//   GeckoTerminal `new_pools` JSON  →  { baselines, poolByToken }
//
// It performs NO I/O — a caller (a future thin adapter behind the aggregator
// catchall, mirroring launcher-outcomes.js) does the fetch and hands the parsed
// JSON here. That keeps this logic unit-testable against fixtures and keeps the
// serverless function count unchanged (see api/SERVERLESS_BUDGET.md).
//
// GROUNDING (so discovery + enrichment agree on every number):
//   - launchPriceEth / launchLiquidityEth use the EXACT derivation in
//     poolAttrsToMarket() in api/_lib/launcher-outcomes.js — ETH is implied from
//     the base token itself (usdPerEth = base_token_price_usd / price_native), so
//     no side-channel ETH price is needed and it holds regardless of which side
//     of the pair is WETH.
//   - tier is 'none': structural tiering (gate.ts) is UNKNOWN at discovery time;
//     only enrichment/fact-sheet passes can raise it. Discovery never scores.
//   - creator is null: not exposed by GeckoTerminal `new_pools`; the enrichment
//     adapter degrades to holderCount-only when creator is null.
//
// Every field is hostile-JSON-safe: unparseable numbers collapse to 0, malformed
// addresses drop the pool, and a missing `created_at` degrades to 0 rather than
// throwing — a flaky upstream can never abort the batch.

import type { Address } from 'viem';
import type { LaunchBaseline } from './outcomesReader';

// ---------------------------------------------------------------------------
// Input shape — a loose view of the GeckoTerminal JSON:API `new_pools` entry.
// Typed permissively because the upstream is untrusted; every access is guarded.
// ---------------------------------------------------------------------------

/** One pool entry from GeckoTerminal `new_pools` (JSON:API `data[]` element). */
export interface GeckoPoolEntry {
  /** e.g. "eth_0xabc…" — network-prefixed pool id. */
  id?: unknown;
  type?: unknown;
  attributes?: Record<string, unknown>;
  relationships?: Record<string, unknown>;
}

/** The `new_pools` response, or just its `data` array. Either is accepted. */
export type GeckoNewPoolsResponse =
  | { data?: unknown }
  | readonly unknown[]
  | null
  | undefined;

/** The discovery output — the exact pair the enrichment path consumes. */
export interface DiscoveredLaunches {
  /** One baseline per DISTINCT base token (tier 'none', creator null). */
  baselines: LaunchBaseline[];
  /** Lowercased token address → its pool address, for the server token→pool skip. */
  poolByToken: Record<string, Address>;
}

export interface MapNewPoolsOptions {
  /**
   * Optional factory/integrator filter, applied to each RAW pool entry before
   * mapping. Return true to keep. Default: no filter (keep all). GeckoTerminal
   * `new_pools` does not expose a factory address directly, so the discriminator
   * (e.g. relationships.dex.data.id, or a name match) is left to the caller —
   * this keeps the mapper agnostic until an integrator source is wired.
   */
  filter?: (pool: GeckoPoolEntry) => boolean;
}

// ---------------------------------------------------------------------------
// Hostile-input helpers (mirror api/_lib/launcher-outcomes.js `num` + address RE).
// ---------------------------------------------------------------------------

const ETH_ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/;

/** Finite number or null (matches the adapter's `num`). */
function num(v: unknown): number | null {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * Extract a lowercased 0x address from a GeckoTerminal id/field. Handles the
 * network-prefixed form ("eth_0xabc…") and a bare "0xabc…". Returns null when no
 * well-formed 40-hex address is present.
 */
function parseAddress(raw: unknown): Address | null {
  if (typeof raw !== 'string') return null;
  // Strip an optional "{network}_" prefix, then validate strictly.
  const candidate = raw.includes('_') ? raw.slice(raw.lastIndexOf('_') + 1) : raw;
  if (!ETH_ADDRESS_RE.test(candidate)) return null;
  return candidate.toLowerCase() as Address;
}

/**
 * Parse `pool_created_at` into unix SECONDS. Accepts an ISO-8601 string (the
 * `new_pools` form) or an already-numeric unix value. Returns 0 when absent or
 * unparseable — a conservative default that never fabricates a launch time.
 */
function parseUnixSeconds(raw: unknown): number {
  if (typeof raw === 'number' && Number.isFinite(raw)) return Math.floor(raw);
  if (typeof raw === 'string') {
    const ms = Date.parse(raw);
    if (Number.isFinite(ms)) return Math.floor(ms / 1000);
  }
  return 0;
}

/** Read the base token address from `relationships.base_token.data.id`. */
function baseTokenAddress(entry: GeckoPoolEntry): Address | null {
  const rel = entry.relationships;
  if (!rel || typeof rel !== 'object') return null;
  const baseToken = (rel as Record<string, unknown>).base_token;
  const data =
    baseToken && typeof baseToken === 'object'
      ? (baseToken as Record<string, unknown>).data
      : null;
  const id = data && typeof data === 'object' ? (data as Record<string, unknown>).id : null;
  return parseAddress(id);
}

/** Read the pool address from `attributes.address`, falling back to the entry id. */
function poolAddress(entry: GeckoPoolEntry): Address | null {
  const fromAttrs = entry.attributes ? parseAddress(entry.attributes.address) : null;
  return fromAttrs ?? parseAddress(entry.id);
}

/**
 * ETH-denominated price + liquidity from a pool's attributes — byte-for-byte the
 * same derivation as poolAttrsToMarket() in the enrichment adapter, so discovery
 * baselines line up with the values enrichment later reads live.
 */
function priceAndLiquidityEth(attrs: Record<string, unknown> | undefined): {
  priceEth: number;
  liquidityEth: number;
} {
  if (!attrs) return { priceEth: 0, liquidityEth: 0 };
  const priceEth = num(attrs.base_token_price_native_currency);
  if (priceEth == null || priceEth < 0) return { priceEth: 0, liquidityEth: 0 };

  let liquidityEth = 0;
  const reserveUsd = num(attrs.reserve_in_usd);
  const baseUsd = num(attrs.base_token_price_usd);
  if (reserveUsd != null && baseUsd != null && priceEth > 0) {
    const usdPerEth = baseUsd / priceEth; // (USD/token) / (ETH/token) = USD/ETH
    if (usdPerEth > 0) liquidityEth = reserveUsd / usdPerEth;
  }
  return { priceEth, liquidityEth: liquidityEth >= 0 ? liquidityEth : 0 };
}

// ---------------------------------------------------------------------------
// The mapper.
// ---------------------------------------------------------------------------

/** Pull the `data[]` array out of a `new_pools` response (or accept a bare array). */
function extractEntries(response: GeckoNewPoolsResponse): GeckoPoolEntry[] {
  const arr = Array.isArray(response)
    ? response
    : response && typeof response === 'object' && Array.isArray((response as { data?: unknown }).data)
      ? ((response as { data: unknown[] }).data)
      : [];
  return arr.filter((e): e is GeckoPoolEntry => !!e && typeof e === 'object');
}

/**
 * Map a GeckoTerminal `new_pools` response into the { baselines, poolByToken }
 * pair the outcomes enrichment path consumes. Pure and total: never throws,
 * never fetches.
 *
 * Behavior:
 *   - Entries without a well-formed base token address are dropped (a baseline is
 *     un-keyable without one).
 *   - DISTINCT by base token: `new_pools` is newest-first, so the FIRST pool seen
 *     for a token wins (its newest pool). This keeps baselines one-per-token —
 *     matching how the enrichment adapter keys outcomes by token — and keeps
 *     poolByToken single-valued.
 *   - tier is always 'none' and creator always null at discovery (see file header).
 */
export function mapNewPoolsToBaselines(
  response: GeckoNewPoolsResponse,
  options: MapNewPoolsOptions = {},
): DiscoveredLaunches {
  const { filter } = options;
  const baselines: LaunchBaseline[] = [];
  const poolByToken: Record<string, Address> = {};
  const seen = new Set<string>();

  for (const entry of extractEntries(response)) {
    if (filter && !filter(entry)) continue;

    const token = baseTokenAddress(entry);
    if (!token) continue; // un-keyable without a base token — drop.
    if (seen.has(token)) continue; // newest-first ⇒ keep the first (newest) pool.
    seen.add(token);

    const { priceEth, liquidityEth } = priceAndLiquidityEth(entry.attributes);

    baselines.push({
      token,
      tier: 'none', // structural tier is unknown at discovery; only gating raises it.
      creator: null, // not exposed by `new_pools`.
      launchedAt: parseUnixSeconds(entry.attributes?.pool_created_at),
      launchPriceEth: priceEth,
      launchLiquidityEth: liquidityEth,
    });

    const pool = poolAddress(entry);
    if (pool) poolByToken[token] = pool;
  }

  return { baselines, poolByToken };
}
