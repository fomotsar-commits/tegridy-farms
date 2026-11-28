// The house bidder's own numbers. They live in code, not in a file the bot reads, so changing
// one is a commit (and the live run is pinned to a commit): the published rules change only for
// a published reason. policy.json holds the limits the SIGNER also enforces; these are the bot's
// judgement on top of them, and every one is at least as strict.

export const DEFAULT_PARAMS = Object.freeze({
  // ── planner (BUILD-SPEC 3.5 step 2) ──
  /** The discount to fair value every bid starts at: 12%. */
  baseEdgeBps: 1200,
  /** Each NFT already held adds 5 points: the more the house holds, the less it wants another. */
  perHeldEdgeBps: 500,
  /** A falling market adds 5 points... */
  trendEdgeBps: 500,
  /** ...when fair value S is down more than 10% on 24 hours ago. */
  trendDownBps: 1000,
  /** The arbitrage line: at most 99% of the cheapest fillable listing... */
  arbitrageBps: 9900,
  /** ...less 0.001 ETH. Above it, a flipper can buy the floor and sell it straight into the house bid. */
  arbitrageBufferWei: 10n ** 15n,

  // ── orders (step 6) ──
  /** Every bid ends this soon after it starts; the signer's own cap (policy.maxLifetimeSec) is the ceiling. */
  bidLifetimeSec: 30 * 60,
  /** A live bid this far from the planned price is worth a discretionary re-price. */
  repriceBps: 300,
  /** At most one discretionary re-price per collection per hour (arbitrage-line and risk cancels are outside it). */
  repriceEveryMs: 60 * 60 * 1000,

  // ── market breakers (step 4) ──
  floorDrop1hBps: 1500,
  floorDrop24hBps: 2500,
  /** The stream counts as silent after this long without a message... */
  streamSilentMs: 2 * 60 * 1000,
  /** ...and the burst breaker trips at this many units bought in any 24 hours. */
  burstUnits: 3,
  burstWindowMs: 24 * 60 * 60 * 1000,
  /**
   * Chain snapshots that keep failing for this long pause the bot (market breaker 'chain-stale').
   * Without one it cannot see fills, mints or its own approval, so it bids blind; it resumes on
   * the first good snapshot, however long that takes.
   */
  chainStaleMs: 3 * 60 * 1000,
  /** A market pause lifts on its own after this long... */
  marketPauseMs: 2 * 60 * 60 * 1000,
  /** ...and the bot then bids for one unit at a time until a day passes with no market trip. */
  resumeQtyOneMs: 24 * 60 * 60 * 1000,

  // ── daily caps (UTC days) and the monthly stolen-item cap ──
  dailyMaxWethWei: 150_000_000_000_000_000n,
  dailyMaxUnits: 3,
  /**
   * Gas is counted at its policy maximum per transaction (300k gas at 20 gwei = 0.006 ETH) unless
   * the signer reports what it cost, so in practice this is "about 8 transactions a day": enough
   * for an approval per fill and a kill, not enough for a loop that keeps sending.
   */
  dailyMaxGasWei: 50_000_000_000_000_000n,
  stolenLossPerMonth: 1,

  // ── the loop (step 8) ──
  tickMs: 60_000,
  /** The least time between two ticks however often a fill or an admin change wakes the loop. */
  minWakeMs: 2_000,
  /** ...and when a market event (a listing, a sale) wakes it: the OpenSea read budget is shared with the site. */
  marketWakeMs: 15_000,
  /**
   * How many cheapest listings are read each tick: 200, OpenSea's one-read maximum. On 2026-11-15
   * the cheapest 165 GNSS listings were 11-to-15-minute bot relists, too young for the listing
   * check, so a shorter read left GNSS with no listing check at all.
   */
  listingsLimit: 200,
  /** Sales are re-read this far back each tick, so a late-indexed sale is not missed. */
  salesOverlapSec: 30 * 60,
  /** How far back the tape is read at start: the 14-day window, the 24-hour trend and the 30-day round-trip rule. */
  tapeDays: 31,
  /** OpenSea's view of the house's own offers is read this often (advisory only). */
  accountOffersEveryMs: 10 * 60 * 1000,
  /** A fill's OpenSea item check is retried this many ticks before it goes to a person... */
  itemCheckRetries: 5,
  /**
   * ...and after that, this often, until it passes or a person acknowledges it (--ack-halt). No
   * new bid is posted meanwhile ('checks-pending'): a token whose history was never read could be
   * an insider's. A 90-day history read is about 65 log reads, too many to repeat every minute.
   */
  checksRetryEveryMs: 10 * 60 * 1000,
  /**
   * Under this much free space on the keys folder's drive the bot will not start and posts no new
   * bid: a full disk would stop it writing down the cancels, fills and kills it makes.
   */
  minFreeDiskBytes: 1_000_000_000,
  /** Insider provenance looks back this far (BUILD-SPEC 3.5 step 4). */
  provenanceDays: 90,
  /** House fills are re-read from the chain this far back on start. */
  reseedFillDays: 30,
});

/** The defaults with `over` laid on top; an unknown name is refused so a typo cannot silently do nothing. */
export function withParams(over = {}) {
  for (const k of Object.keys(over)) {
    if (!(k in DEFAULT_PARAMS)) throw new Error(`unknown bot parameter "${k}"`);
  }
  return Object.freeze({ ...DEFAULT_PARAMS, ...over });
}
