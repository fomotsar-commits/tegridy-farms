// Pure merge for the proof-of-life feed: combine independent event streams
// (trades, on-chain deltas, graded launches) into one newest-first list.
//
// Rules:
//   - Dedupe by `id` (first occurrence wins) so a stream re-emitting the same item
//     across polls can't duplicate a row. Streams use disjoint id namespaces
//     (trades: "<txHash>:<block>", fees: "fee:<n>", pol: "pol:<n>", launches:
//     "launch:<token>:<ts>"), but the guard is defensive regardless.
//   - Drop items with no honest timestamp (ts <= 0) rather than floating them to the top.
//   - Sort by ts descending; cap to `limit`.
//
// Pure: no clock, no I/O. Self-gating falls out naturally — empty streams → [].

import type { PulseItem } from './types';

export interface MergeOptions {
  /** Max items to return. Default 24 (the UI slices further for its own `limit`). */
  limit?: number;
}

export function mergeProtocolEvents(
  streams: ReadonlyArray<readonly PulseItem[] | null | undefined>,
  opts: MergeOptions = {},
): PulseItem[] {
  const limit = typeof opts.limit === 'number' && opts.limit > 0 ? Math.floor(opts.limit) : 24;
  const seen = new Set<string>();
  const merged: PulseItem[] = [];

  for (const stream of streams) {
    if (!stream) continue;
    for (const item of stream) {
      if (!item || !item.id) continue;
      if (!Number.isFinite(item.ts) || item.ts <= 0) continue; // no honest time → skip.
      if (seen.has(item.id)) continue;
      seen.add(item.id);
      merged.push(item);
    }
  }

  merged.sort((a, b) => b.ts - a.ts);
  return merged.slice(0, limit);
}
