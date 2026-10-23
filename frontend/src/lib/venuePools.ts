// Every pool on the island, from the registry alone: the rows of /earn's index (VenuePoolIndex)
// and of the dashboard (IslandDashboard). One list, so the two can never disagree about which
// pools exist or what their terms are.
//
// It reads no chain, on purpose: see VenuePoolIndex.tsx for why a rate is never shown here.
import { BUNGALOWS, DEFAULT_BUNGALOW_ID } from './bungalows';
import { TEGRIDY_STAKING_ADDRESS, isDeployed } from './constants';
import { poolShape } from './poolShape';

export const CHAIN_LABEL: Record<string, string> = {
  ethereum: 'Ethereum',
  base: 'Base',
  solana: 'Solana',
  tbd: '—',
};

/** A row, whether it comes from the registry or from constants.ts. */
export interface VenuePoolRow {
  id: string;
  symbol: string;
  name: string;
  chain: string;
  accent?: string;
  terms: string;
}

/**
 * The row's lock words, from the registry's shape string. `poolShape` says
 * "Lock ladder · 7d–4y, 0.40×–4.00×"; the row says "Lock 7d–4y, 0.40×–4.00×",
 * the range and the multiplier, which is what a visitor compares across rows.
 * The word "ladder" names the program and lives in the small print.
 */
export function rowTerms(terms: string): string {
  return terms.replace(/^Lock ladder · /, 'Lock ');
}

/** True when the pool's terms include the lock ladder (its share grows with the lock). */
export function hasLadder(terms: string): boolean {
  return /lock ladder/i.test(terms);
}

export function venuePoolRows(): VenuePoolRow[] {
  // Every settled resident that actually has a staking program registered. A
  // bungalow with no `stakePool` has nothing to list, and listing it with a
  // dash would advertise a pool that does not exist.
  const rows: VenuePoolRow[] = BUNGALOWS.filter((b) => b.live && (b.stakePool || b.ladderPool)).map((b) => ({
    id: b.id,
    symbol: b.symbol,
    name: b.name,
    chain: b.chain,
    accent: b.accent,
    terms: poolShape(b),
  }));

  // TOWELI is a row like every other resident's, never a footnote. Its staking
  // program predates the registry, so its row is built here from
  // TEGRIDY_STAKING_ADDRESS (constants.ts) instead of a registry `stakePool`.
  const toweli = BUNGALOWS.find((b) => b.id === DEFAULT_BUNGALOW_ID);
  if (toweli && isDeployed(TEGRIDY_STAKING_ADDRESS)) {
    rows.push({
      id: toweli.id,
      symbol: toweli.symbol,
      name: toweli.name,
      chain: toweli.chain,
      accent: toweli.accent,
      terms: poolShape({ poolKind: 'ladder', chain: toweli.chain }),
    });
  }
  return rows;
}
