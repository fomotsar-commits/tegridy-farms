// The island's own pools, offered as one-tap subjects for a pool rule.
//
// Every settled resident already carries the GeckoTerminal pool its chart and
// market strip read (lib/bungalows.ts `market`), so a rule can be aimed at one
// without anybody typing a base58 pool id by hand — which is the step where a
// Solana subject gets mistyped or, worse, silently lower-cased.
//
// It is a CONVENIENCE, not a registry the engine trusts: evaluate.ts stays
// registry-free and titles a pool by GeckoTerminal's own name or by the
// network:pool pair. This module only decides what the builder offers and what a
// rule is CALLED on screen, so a resident being renamed can never change what a
// rule watches.

import { BUNGALOWS } from '../bungalows';
import { isGeckoNetwork, type GeckoNetwork } from '../geckoTerminal/pools';

export interface ResidentPool {
  id: string;
  symbol: string;
  network: GeckoNetwork;
  pool: string;
  /** The pair label the bungalow already publishes, e.g. "BAYLA / SOL · PumpSwap". */
  label: string;
  /** Exactly what a rule's subject field wants: `network:pool`. */
  subject: string;
}

/**
 * Residents with a readable pool, in the order the island lists them.
 *
 * Computed on each call rather than frozen at module load: BUNGALOWS is a plain
 * array other surfaces read, and a snapshot taken at import time is the shape
 * that goes stale without anybody noticing.
 */
export function residentPools(): ResidentPool[] {
  const out: ResidentPool[] = [];
  for (const b of BUNGALOWS) {
    const market = b.market;
    if (!market || !isGeckoNetwork(market.network)) continue;
    // Byte-preserved. A Solana pool id is base58 and case IS the value; the only
    // normalisation that happens to it is the EVM lower-casing inside
    // canonicalSubject, which never touches a solana subject.
    out.push({
      id: b.id,
      symbol: b.symbol,
      network: market.network,
      pool: market.pool,
      label: market.label,
      subject: `${market.network}:${market.pool}`,
    });
  }
  return out;
}

/** The friendly name for a canonical `network:pool` subject, or null when it is not a resident's. */
export function residentLabelForSubject(subject: string): string | null {
  const wanted = subject.trim();
  for (const resident of residentPools()) {
    if (resident.subject === wanted) return resident.label;
    // EVM subjects are canonicalised to lower case before they are stored, so a
    // resident whose pool id is checksum-cased in bungalows.ts still matches.
    if (resident.network !== 'solana' && resident.subject.toLowerCase() === wanted.toLowerCase()) {
      return resident.label;
    }
  }
  return null;
}
