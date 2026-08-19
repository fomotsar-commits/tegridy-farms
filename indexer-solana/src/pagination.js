// Walking `getSignaturesForAddress` backwards from head to the resume point.
//
// The RPC only pages BACKWARD: newest first, `before` to go further back,
// `until` to stop. There is no forward cursor and no slot-range form. So
// catching up means walking back until the last signature we already have
// comes into view, then replaying what we collected oldest-first.
//
// The walk is BOUNDED, and the bound is the interesting part. A cursor that has
// fallen a long way behind — days of downtime, or an RPC that no longer retains
// the range — would otherwise page inside a single tick until it either found
// the resume point or ran out of history, writing nothing the whole time. That
// is indistinguishable from a hang, and it is also unbounded memory.
//
// When the bound is hit the walk stops and says so. The caller then does the
// only honest thing available: index what it fetched, move the cursor to the
// newest of it, and record the skipped span as a hole. The alternative — moving
// the cursor and staying quiet — turns a range of unread history into a range
// of "no trades", permanently, with nothing anywhere marking it.

/**
 * @param {object} opts
 * @param {(args:{before?:string, until?:string, limit:number}) => Promise<Array<{signature:string, slot:number, blockTime:number|null, err:unknown}>>} opts.fetchPage
 * @param {string|null} opts.until  resume signature, exclusive. null on a cold start.
 * @param {number} opts.pageLimit
 * @param {number} opts.maxPages
 * @returns {Promise<{ signatures: Array<object>, reachedUntil: boolean, pagesUsed: number }>}
 *   `signatures` is OLDEST-FIRST — the order it must be committed in, so the
 *   cursor is only ever advanced over a contiguous processed prefix.
 */
export async function collectNewSignatures({ fetchPage, until, pageLimit, maxPages }) {
  const collected = [];
  let before;
  let pagesUsed = 0;
  let reachedUntil = false;

  while (pagesUsed < maxPages) {
    const args = { limit: pageLimit };
    if (before) args.before = before;
    if (until) args.until = until;

    const page = await fetchPage(args);
    pagesUsed++;

    if (page.length === 0) {
      // Nothing older to see. On a cold start this means the address's entire
      // retained history is in hand; with `until` set it means we walked back
      // onto the resume point.
      reachedUntil = true;
      break;
    }

    collected.push(...page);

    // A short page is the cluster saying "that is all there is before this
    // point". A full page is not — the count alone cannot distinguish
    // "exactly `limit` remaining" from "more", so we ask again.
    if (page.length < pageLimit) {
      reachedUntil = true;
      break;
    }

    before = page[page.length - 1].signature;
  }

  // Newest-first in, oldest-first out.
  collected.reverse();
  return { signatures: collected, reachedUntil, pagesUsed };
}

/**
 * The hole left behind when a walk stops early, described well enough that
 * somebody reading the row later knows what is missing and why.
 *
 * A cold start with no `startSignature` is also a hole: the service holds only
 * as far back as one bounded walk reached, and everything before that was never
 * asked for. Calling that "no earlier trades" would be the exact lie this
 * table exists to prevent.
 *
 * @returns {{kind:string, fromSlot:number|null, toSlot:number|null, detail:string} | null}
 */
export function describeTruncation({ reachedUntil, hadCursor, cursorSlot, oldestFetchedSlot, pagesUsed }) {
  if (reachedUntil) return null;

  if (hadCursor) {
    return {
      kind: "backlog-truncated",
      fromSlot: cursorSlot ?? null,
      toSlot: oldestFetchedSlot ?? null,
      detail:
        `paged back ${pagesUsed} times without reaching the resume signature; ` +
        `signatures between the cursor and slot ${oldestFetchedSlot ?? "?"} were never read`,
    };
  }

  return {
    kind: "history-not-backfilled",
    fromSlot: null,
    toSlot: oldestFetchedSlot ?? null,
    detail:
      `cold start with no startSignature: history before slot ${oldestFetchedSlot ?? "?"} ` +
      `was never requested and is not indexed`,
  };
}
