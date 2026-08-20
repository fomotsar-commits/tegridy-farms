// `where` clauses for the copy-trading reads.
//
// Every one of them feeds the SHARED `INDEXED_SWAPS_QUERY` document in
// lib/indexer/queries.ts rather than a copy of it. That document's field list is
// pinned by its own test against indexer/ponder.schema.ts; a second selection
// written here would be a second thing to keep in step with the schema, and the
// failure mode of getting it wrong is a permanent silent outage of one surface.
//
// Two shape rules travel with these objects and neither is cosmetic:
//   · `{}` is the unfiltered clause, never `null` — Ponder's where-builder
//     iterates the object after an `=== undefined` guard, so an explicit null
//     500s inside the server and reaches the UI as an outage.
//   · uint256 values travel as DECIMAL STRINGS. Ponder coerces a bound variable
//     with `BigInt(value)`, so a JSON number would be accepted and would lose
//     precision above 2^53 without complaint.
//
// `_gte` / `_lte` / `_in` are Ponder's generated filter suffixes (numeric and
// singular respectively), not names invented here.

/** Hard ceiling on how many leaders one `user_in` clause may name. */
export const MAX_LEADERS_PER_QUERY = 20;

/** Venue-wide swaps from `since` to the head of the chain. */
export function leaderboardWhere(sinceUnixSeconds: number): Record<string, unknown> {
  return { timestamp_gte: unixString(sinceUnixSeconds) };
}

/**
 * Recent swaps by the followed wallets.
 *
 * Returns null when the follow list is empty. An empty `user_in` array is NOT
 * the same request with no leaders — drizzle's `inArray` on an empty list is a
 * degenerate clause, and the honest handling of "nothing is followed" is to make
 * no request at all, which is what a null here tells the hook to do.
 */
export function leaderSignalsWhere(
  leaders: readonly string[],
  sinceUnixSeconds: number,
): Record<string, unknown> | null {
  const unique = [...new Set(leaders.map((l) => l.toLowerCase()))].slice(0, MAX_LEADERS_PER_QUERY);
  if (unique.length === 0) return null;
  return { user_in: unique, timestamp_gte: unixString(sinceUnixSeconds) };
}

/** One wallet's own venue swaps, from `since` onward. */
export function followerFillsWhere(follower: string, sinceUnixSeconds: number): Record<string, unknown> {
  return { user: follower.toLowerCase(), timestamp_gte: unixString(sinceUnixSeconds) };
}

function unixString(seconds: number): string {
  if (!Number.isFinite(seconds)) return '0';
  return Math.max(0, Math.floor(seconds)).toString();
}
