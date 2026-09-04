// The round-trip rule, and the ranking, stated once over a shape that is not
// tied to any one feed.
//
// WHY THIS FILE EXISTS. The rule used to live inside scoring.ts, keyed directly
// on an `IndexedSwap` — the indexer's row shape. A second scoreboard then wanted
// the same rule over a completely different source (GeckoTerminal fills on the
// island's own pools), and the only ways forward were to fake an IndexedSwap or
// to write the rule twice. A rule written twice is a rule that will differ, and
// the difference will be invisible: both boards would still render, both would
// still look plausible, and one of them would be rewarding wash trades.
//
// So the rule is stated here over a `Leg` — one directional move by one wallet
// on one pair, with a size and a time — and each source keeps a small adapter
// that produces Legs. The adapter is where a source's own conventions live.
//
// ─── ONE RULE THIS FILE ENFORCES ABOUT ITSELF ────────────────────────────────
//
// NOTHING HERE RE-CASES A WALLET. `wallet` is an opaque identity string and is
// compared byte-for-byte. That is not fastidiousness: the original rule called
// `.toLowerCase()` on every wallet, which is correct for EVM hex and CORRUPTING
// for base58 — a lowercased Solana address is a different, valid-looking, wrong
// key, and two distinct traders can collide into one row under it. Casing is a
// per-chain fact, so it belongs in the per-chain adapter and nowhere else.

/**
 * How long a reversal still counts as the same round trip, in seconds.
 *
 * One hour. Short enough that a position held across a session and exited later
 * is treated as trading rather than as a wash; long enough that the obvious
 * pattern — buy and sell back within a few blocks, repeated — is removed on both
 * legs. There is no value here that separates the two cases perfectly, which is
 * why the limit is disclosed rather than tuned quietly.
 */
export const WASH_WINDOW_SECONDS = 3600;

/**
 * One directional move, by one wallet, on one pair.
 *
 * `direction` is deliberately abstract — 'a>b' and 'b>a' — rather than
 * 'buy'/'sell'. The rule only needs to know that two legs oppose each other on
 * the same pair; which of them a given source calls a buy is the source's
 * vocabulary, and baking it in here would make the rule wrong for any feed that
 * names the sides differently.
 */
export interface Leg {
  /** Traceable back to its source row. Not used by the rule; kept for debugging. */
  id: string;
  /** Opaque identity. Compared byte-for-byte — see the file header. */
  wallet: string;
  /** Opaque pair identity. Two legs pair off only when this matches exactly. */
  pairKey: string;
  direction: 'a>b' | 'b>a';
  /** Size in whatever smallest unit the adapter chose. Summed, never converted. */
  amount: bigint;
  /** False when the leg is real activity whose size cannot be added to the total. */
  counted: boolean;
  /** Unix seconds. */
  at: number;
  txHash: string;
}

/**
 * Indices of the legs struck by the round-trip rule.
 *
 * Separated from the aggregation so the rule can be tested on its own: the
 * question "would this wallet's self-reversal climb the board" has one answer
 * and it must not depend on how a total is later summed.
 *
 * Greedy and oldest-first per wallet. Each leg is consumed once, so three buys
 * followed by one sell strike exactly one buy — the other two are open positions
 * and remain real volume.
 */
export function washedLegIndices(
  legs: readonly Leg[],
  windowSeconds: number = WASH_WINDOW_SECONDS,
): Set<number> {
  const ordered = legs
    .map((leg, index) => ({ leg, index }))
    .sort((a, b) => a.leg.at - b.leg.at || a.index - b.index);

  const struck = new Set<number>();
  // wallet -> "pairKey|direction" -> indices of legs still open, oldest first.
  const open = new Map<string, Map<string, { index: number; at: number }[]>>();

  for (const { leg, index } of ordered) {
    let byPair = open.get(leg.wallet);
    if (!byPair) {
      byPair = new Map();
      open.set(leg.wallet, byPair);
    }

    const reverse = leg.direction === 'a>b' ? 'b>a' : 'a>b';
    const reverseKey = `${leg.pairKey}|${reverse}`;
    const queue = byPair.get(reverseKey);
    let matched = false;
    if (queue) {
      // Oldest first: entries older than the window can never match anything
      // later either, so they are dropped as they are passed rather than
      // re-scanned on every subsequent leg.
      while (queue.length > 0 && leg.at - queue[0]!.at > windowSeconds) queue.shift();
      const partner = queue.shift();
      if (partner) {
        struck.add(partner.index);
        struck.add(index);
        matched = true;
      }
    }

    if (!matched) {
      const ownKey = `${leg.pairKey}|${leg.direction}`;
      const ownQueue = byPair.get(ownKey) ?? [];
      ownQueue.push({ index, at: leg.at });
      byPair.set(ownKey, ownQueue);
    }
  }

  return struck;
}

/** One wallet's line on a board, before any source-specific decoration. */
export interface RankRow {
  wallet: string;
  /** Sum of `amount` over legs that survived the rule and were countable. */
  countedVolume: bigint;
  countedTrades: number;
  /** Legs struck by the round-trip rule. Shown, never hidden. */
  washedLegs: number;
  /** Legs that survived but whose size could not be added. Counted, never summed. */
  uncountedTrades: number;
  lastTradeAt: number;
}

export interface RankResult {
  rows: RankRow[];
  legsRead: number;
  washedLegs: number;
  /** Oldest and newest leg seen. Null when nothing was read — never a fabricated span. */
  window: { from: number; to: number } | null;
}

export interface RankLegsOptions {
  windowSeconds?: number;
}

/**
 * Aggregate legs into a ranked board.
 *
 * The sort is total and deterministic: volume, then trade count, then wallet.
 * A ranking that depended on input order would put a different wallet in first
 * place on two reads of the same data, which is the kind of instability nobody
 * reports as a bug and everybody notices.
 */
export function rankLegs(legs: readonly Leg[], opts: RankLegsOptions = {}): RankResult {
  const struck = washedLegIndices(legs, opts.windowSeconds ?? WASH_WINDOW_SECONDS);

  const byWallet = new Map<string, RankRow>();
  let from: number | null = null;
  let to: number | null = null;

  legs.forEach((leg, index) => {
    if (from === null || leg.at < from) from = leg.at;
    if (to === null || leg.at > to) to = leg.at;

    let row = byWallet.get(leg.wallet);
    if (!row) {
      row = {
        wallet: leg.wallet,
        countedVolume: 0n,
        countedTrades: 0,
        washedLegs: 0,
        uncountedTrades: 0,
        lastTradeAt: leg.at,
      };
      byWallet.set(leg.wallet, row);
    }
    if (leg.at > row.lastTradeAt) row.lastTradeAt = leg.at;

    if (struck.has(index)) {
      row.washedLegs += 1;
      return;
    }
    if (leg.counted) {
      row.countedVolume += leg.amount;
      row.countedTrades += 1;
    } else {
      row.uncountedTrades += 1;
    }
  });

  const rows = [...byWallet.values()].sort((a, b) => {
    if (a.countedVolume !== b.countedVolume) return a.countedVolume > b.countedVolume ? -1 : 1;
    if (a.countedTrades !== b.countedTrades) return b.countedTrades - a.countedTrades;
    return a.wallet < b.wallet ? -1 : a.wallet > b.wallet ? 1 : 0;
  });

  return {
    rows,
    legsRead: legs.length,
    washedLegs: struck.size,
    window: from !== null && to !== null ? { from, to } : null,
  };
}
