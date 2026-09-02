// The island's own pools, as addresses the market reader can ask about.
//
// PURE, and it reads the SAME `market` field the bungalow charts read
// (lib/bungalows.ts). That matters more than it looks: a second, hand-kept list
// of "our pools" would drift the first time a resident's pool moved, and the
// terminal would then be showing a dead pool under a live resident's name with
// nothing anywhere to catch it. Residents with no `market` are skipped rather
// than guessed at — no market surface is the honest state for a token whose pool
// this venue has not recorded.
//
// BEING LISTED HERE IS A FACT ABOUT THE REGISTRY, NOT A SAFETY RESULT. These
// rows go through the identical parser, the identical null rules and the
// identical per-row safety read as any stranger's pool from the new-pools feed.
// The one thing the island view adds is the resident's NAME, and the banner says
// exactly that.

import { BUNGALOWS, type Bungalow } from '../bungalows';
import { TOWELI_WETH_LP_ADDRESS } from '../constants';
import type { GeckoNetwork } from '../geckoTerminal/pools';

export interface IslandPool {
  network: GeckoNetwork;
  pool: string;
  label: string;
}

/**
 * The venue's own pool, listed alongside the residents.
 *
 * It carries NO static market claim — no "deepest pool", no depth figure, no
 * ranking. It is one more row, read from the same upstream, subject to the same
 * withholding rules. A venue that exempted its own pool from its own honesty
 * rules would have written those rules for other people.
 */
export const VENUE_POOL: IslandPool = {
  network: 'eth',
  pool: TOWELI_WETH_LP_ADDRESS,
  label: 'TOWELI (the venue’s own pool)',
};

/** Case rule per network — base58 is case-sensitive, hex is not. */
function dedupeKey(p: IslandPool): string {
  return `${p.network}:${p.network === 'solana' ? p.pool : p.pool.toLowerCase()}`;
}

export function islandPools(bungalows: readonly Bungalow[] = BUNGALOWS): IslandPool[] {
  const out: IslandPool[] = [];
  const seen = new Set<string>();

  for (const candidate of [VENUE_POOL, ...bungalows.flatMap(marketOf)]) {
    const key = dedupeKey(candidate);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(candidate);
  }
  return out;
}

function marketOf(b: Bungalow): IslandPool[] {
  return b.market ? [{ network: b.market.network, pool: b.market.pool, label: b.name }] : [];
}

/** The island's pool addresses on one network — the shape `pools/multi` takes. */
export function islandPoolsOn(
  network: GeckoNetwork,
  bungalows: readonly Bungalow[] = BUNGALOWS,
): string[] {
  return islandPools(bungalows)
    .filter((p) => p.network === network)
    .map((p) => p.pool);
}
