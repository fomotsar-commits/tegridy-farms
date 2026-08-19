// The vocabulary of the unified portfolio.
//
// A portfolio total is the one number on this venue that a user will act on without
// re-deriving it: they will size a trade against it, decide whether to de-risk against
// it, and tell other people what they are worth using it. Every other surface here can
// be wrong and be caught by the next screen. This one cannot, because there is no next
// screen — it IS the summary.
//
// So the states below are deliberately finer-grained than "loaded / error". The
// distinction that matters is not whether a read succeeded, it is whether a MISSING
// leg is a real zero or an unknown, because those two render identically as `0` and
// mean opposite things. `unavailable` and `unpriced` exist so that neither can ever
// collapse into `ok` with a value of nothing.

/** Every leg the unified portfolio knows about, in display order. */
export type PortfolioSourceId =
  | 'wallet-eth'
  | 'wallet-toweli'
  | 'staking'
  | 'lp'
  | 'claimable'
  | 'nft'
  | 'launched-tokens';

/**
 * What this build was able to establish about one leg.
 *
 * `ok`          — the read returned, and a price existed to mark it at. `usd` is a number
 *                 (possibly 0, because a returned zero is a fact).
 * `loading`     — the read is in flight and has never landed. Not a zero.
 * `unavailable` — the read was attempted and failed. Transient; a retry may fix it.
 *                 Emphatically not a zero: this is the state the old dashboard erased.
 * `unpriced`    — the QUANTITY is known and the MARK is not. The holding is real and its
 *                 dollar value is unknown. Reusing the last good price, or substituting
 *                 zero, would both publish a number nobody read.
 * `out-of-scope`— nothing in this build reads this leg at all. Permanent until something
 *                 is built, and therefore disclosed standing rather than as an alert.
 */
export type PortfolioSourceState =
  | 'ok'
  | 'loading'
  | 'unavailable'
  | 'unpriced'
  | 'out-of-scope';

export interface PortfolioSourceReport {
  id: PortfolioSourceId;
  /** Human label; rendered verbatim in the source list and in omission notices. */
  label: string;
  state: PortfolioSourceState;
  /** USD mark. A number ONLY when `state === 'ok'`; null in every other state. */
  usd: number | null;
  /**
   * Why this leg is in the state it is, or — for `unpriced` — what is actually held.
   * Rendered verbatim, so it must read as a sentence to a user, not to a maintainer.
   */
  detail?: string;
  /**
   * Unix seconds at which the read behind this report landed. Required for a
   * contributing leg: a figure whose age cannot be stated cannot be summed with
   * others whose age can. Null for legs that were never read.
   */
  asOf: number | null;
}

export type PortfolioCompleteness = 'complete' | 'partial' | 'unavailable';

export interface PortfolioOmission {
  id: PortfolioSourceId;
  label: string;
  state: PortfolioSourceState;
  /** Short phrase completing "…, <reason>". Rendered verbatim. */
  reason: string;
}

export interface PortfolioTotal {
  /**
   * Sum of the contributing legs, or null when nothing contributed. Null is not zero
   * and callers must not coerce it: `usd ?? 0` on this field re-creates the exact
   * fabrication this module exists to prevent.
   */
  usd: number | null;
  completeness: PortfolioCompleteness;
  /** Legs folded into `usd`, in report order. */
  counted: PortfolioSourceId[];
  /** In-scope legs left out, each with the reason. Non-empty ⇒ completeness is not 'complete'. */
  omitted: PortfolioOmission[];
  /** Legs this build never reads. Always disclosed; never affects `completeness`. */
  outOfScope: PortfolioOmission[];
  /** Oldest / newest read among contributing legs. The total is only as fresh as `asOfOldest`. */
  asOfOldest: number | null;
  asOfNewest: number | null;
  /** newest − oldest, in seconds. Null when fewer than one contributing leg carries an age. */
  freshnessSpreadSec: number | null;
  /** True when the spread exceeds tolerance — the legs were NOT read together. */
  mixedFreshness: boolean;
}
