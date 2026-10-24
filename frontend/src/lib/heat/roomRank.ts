// A wallet's place in a room, as Jungle Bay Island serves it: room_rank of room_holders.
// The venue prints the two numbers and never works out, repairs or re-orders either.

/** A served count: a whole number of one or more, or null. The island sends
 *  room_rank: null for a wallet it does not rank. */
export function servedCount(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 ? value : null;
}

/** 1 reads "1st", 12 "12th", 1204 "1,204th". 11, 12 and 13 take "th" in every hundred. */
export function ordinal(n: number): string {
  const lastTwo = n % 100;
  const last = n % 10;
  const suffix =
    lastTwo >= 11 && lastTwo <= 13 ? 'th' : last === 1 ? 'st' : last === 2 ? 'nd' : last === 3 ? 'rd' : 'th';
  return `${n.toLocaleString('en-US')}${suffix}`;
}

/** "12th of 498 measured", the island's own words for the line, or null when either
 *  number did not arrive: an unranked wallet prints nothing. */
export function roomRankLine(rank: number | null, holders: number | null): string | null {
  if (rank === null || holders === null) return null;
  return `${ordinal(rank)} of ${holders.toLocaleString('en-US')} measured`;
}
