// What the all-time volume counter is made of and when it is behind, shared by the scheduled
// job (scripts/venue-volume.mjs) and the public read (venueVolume.js). No imports: the job
// runs with no npm install, next to the service key.

/** Every source the total is made of. A row missing from this list is not counted. */
export const VOLUME_SOURCES = Object.freeze(["solana-pools", "jupiter", "ethereum", "base", "robinhood"]);

/**
 * The job is scheduled hourly, but GitHub ran this repo's hourly jobs up to 7.8 h apart
 * (10-14..10-22), and an EVM count ends at the finalized block, ~16 min back. Nine hours
 * without a count is behind; a failed run is behind at once.
 */
export const STALE_AFTER_MS = 9 * 60 * 60 * 1000;

/**
 * The rows, summed. `unread` when any source has never finished a run (the sum would
 * leave it out). `behind` when a source's last run failed or the oldest is stale; asOf
 * is then the time every source was last complete. `staleAt` lets a cached answer
 * turn itself behind in the browser.
 */
export function summarize(rows, nowMs) {
  const bySource = new Map((Array.isArray(rows) ? rows : []).map((r) => [r.source, r]));
  let usd = 0;
  let swaps = 0;
  let unpriced = 0;
  let asOfMs = Infinity;
  let failing = false;
  for (const source of VOLUME_SOURCES) {
    const r = bySource.get(source);
    const countedTo = Date.parse(r?.counted_to ?? "");
    const okAt = Date.parse(r?.last_ok_at ?? "");
    const rowUsd = Number(r?.usd);
    const rowSwaps = Number(r?.swaps);
    if (!r || !Number.isFinite(countedTo) || !Number.isFinite(okAt) || !Number.isFinite(rowUsd) || !Number.isFinite(rowSwaps)) {
      return { state: "unread" };
    }
    usd += rowUsd;
    swaps += rowSwaps;
    unpriced += Number(r.unpriced) || 0;
    asOfMs = Math.min(asOfMs, countedTo);
    const errAt = Date.parse(r.last_error_at ?? "");
    if (Number.isFinite(errAt) && errAt > okAt) failing = true;
  }
  const staleAtMs = asOfMs + STALE_AFTER_MS;
  return {
    state: failing || nowMs > staleAtMs ? "behind" : "current",
    usd: Math.round(usd * 100) / 100,
    swaps,
    unpricedSwaps: unpriced,
    asOf: new Date(asOfMs).toISOString(),
    staleAt: new Date(staleAtMs).toISOString(),
  };
}
