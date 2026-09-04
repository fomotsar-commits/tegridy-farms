// WHICH POOLS /chart OFFERS. Pure: no React, no network, no clock.
//
// The list is a REGISTRY READ, not a hardcoded menu: TOWELI's own pool
// (lib/chart/market.ts → constants.ts → scripts/addresses.json) plus every
// island resident that carries a `market` field (lib/bungalows.ts). Adding a
// resident with a pool adds a chartable pool here with no edit to this file,
// and removing the last one empties this list — which is what the nav pill
// reads (`hasChartableMarket`), so the pill cannot drift from the page.
//
// WHAT THESE POOL STRINGS ARE. They are GeckoTerminal PATH IDENTIFIERS and are
// passed to exactly one host: api.geckoterminal.com. They are never handed to an
// RPC, never used as a call target, and never checksummed — the ten resident
// pools are stored lowercase/un-checksummed and are deliberately NOT in
// scripts/addresses.json (verify-addresses.mjs scopes its rule to constants.ts
// literals). Their provenance is the live 2026-08-30 read recorded in
// lib/bungalows.ts, and the same identifiers are already fetched in production
// by components/bungalow/BungalowMarket.tsx. ANY future on-chain use of one of
// them — reading reserves, routing a swap, approving a spender — has to
// checksum and register it FIRST; a string that is only ever a URL segment does
// not carry the guarantees an address in the registry does.

import { BUNGALOWS } from '../bungalows';
import { TOWELI_MARKET } from './market';
import type { GeckoNetwork } from '../geckoTerminal/pools';

/**
 * One chartable pool.
 *
 * Deliberately NOT a re-declared network union: `GeckoNetwork` is the shared
 * closed union the pool readers and the bungalow registry already speak, so a
 * market from here can be handed to either with no adapter and a typo cannot
 * compile. The shape is structurally a `ChartMarket` (lib/chart/market.ts), so
 * `chartPoolUrl` takes one as-is.
 */
export interface ChartableMarket {
  network: GeckoNetwork;
  pool: string;
  label: string;
}

/**
 * The identity of a pool for lookup and caching.
 *
 * CASE IS NOT UNIFORM ACROSS NETWORKS and folding it uniformly would be a bug in
 * both directions. Hex addresses are case-insensitive, so `0xAB…` and `0xab…`
 * are the same pool and must collapse to one key or the picker shows the pool
 * twice. Base58 is case-SENSITIVE, so two Solana strings differing only in case
 * are two different accounts and folding them would silently chart one pool
 * under another's name.
 */
export function marketKey(network: GeckoNetwork, pool: string): string {
  const id = pool.trim();
  return `${network}:${network === 'solana' ? id : id.toLowerCase()}`;
}

/**
 * Every pool this page can chart, TOWELI first and then registry order.
 *
 * Built fresh on each call rather than frozen at module load: the registry is a
 * literal today, but a memoised list would be the kind of thing that keeps
 * answering after the input it was derived from changed.
 */
export function chartableMarkets(): ChartableMarket[] {
  const out: ChartableMarket[] = [];
  const seen = new Set<string>();

  const push = (m: ChartableMarket) => {
    const key = marketKey(m.network, m.pool);
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ ...m, pool: m.pool.trim() });
  };

  // The venue's own pool leads. `network` is written as the literal rather than
  // read off TOWELI_MARKET because that type's `network` is the wider
  // `ChartMarket` one; markets.test.ts pins that the two agree, so a change to
  // the constant cannot silently point this entry at a different chain.
  push({ network: 'eth', pool: TOWELI_MARKET.pool, label: TOWELI_MARKET.label });

  for (const b of BUNGALOWS) {
    if (!b.market) continue;
    // The resident's ticker leads the label so the picker reads as a list of
    // island residents rather than a list of pair strings; the registry's own
    // pair label follows it unchanged.
    push({ network: b.market.network, pool: b.market.pool, label: `${b.symbol} · ${b.market.label}` });
  }

  return out;
}

/**
 * Is there anything to chart at all?
 *
 * This is what the /chart nav pill reads. It answers the only question the pill
 * asks — "can I do the thing this entry names?" — from a client-readable fact,
 * and self-returns false the moment the registry holds no market. It says
 * nothing about GeckoTerminal being up: a runtime outage is the page banner's
 * job, and a pill that flickered with a rate limit would be less honest.
 */
export function hasChartableMarket(): boolean {
  return chartableMarkets().length > 0;
}

/** The registry market for a (network, pool), or null. The ONLY way an untrusted pool string becomes a URL. */
export function findMarket(network: GeckoNetwork, pool: string): ChartableMarket | null {
  const key = marketKey(network, pool);
  return chartableMarkets().find((m) => marketKey(m.network, m.pool) === key) ?? null;
}

/** First chartable pool on a network, or null when that network offers none. */
export function defaultMarketFor(network: GeckoNetwork): ChartableMarket | null {
  return chartableMarkets().find((m) => m.network === network) ?? null;
}

/** Network slug → the word a reader uses for it. Group headings in the picker. */
export const NETWORK_LABELS: Record<GeckoNetwork, string> = {
  eth: 'Ethereum',
  base: 'Base',
  solana: 'Solana',
};
