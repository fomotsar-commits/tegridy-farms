// Can /competitions do the thing its label names?
//
// The nav entry says "Competitions", which promises a standings board. A board
// exists whenever EITHER source can be read:
//
//   · the island registry names at least one resident pool whose trade feed the
//     browser can fetch under the existing CSP — twelve of them today, needing
//     no env variable and no operator action; or
//   · an indexer is configured, which is what Season 1 scores from.
//
// Both halves are READS OF CONFIG, evaluated at the moment every sibling pill in
// navConfig.ts is computed (isIndexerConfigured, hasRoutableYieldVenue,
// isDeployed) — not a hardcoded literal. The pill self-clears back to SOON if
// every market is removed from the registry and no indexer is configured.
//
// FEED REACHABILITY AT RENDER TIME IS DELIBERATELY NOT FOLDED IN, the same
// convention /swap follows (its pill does not probe the aggregator). A pill
// describes what the page is FOR; an outage of a third-party feed is reported on
// the page itself as 'unavailable', with the pool that failed and the reason it
// gave. Probing here would put a network round trip in front of the navigation
// bar and would make the menu flicker on somebody's bad wifi.

import { isIndexerConfigured } from '../indexer/client';
import { cupPools } from './islandCup';

export function hasScoreableBoard(): boolean {
  return cupPools().length > 0 || isIndexerConfigured();
}
