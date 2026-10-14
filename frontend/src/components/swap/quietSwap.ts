import { OWN_ROUTE_COPY } from '../../lib/solana/swap/ownPoolRoute';
import { DECLINED_IN_WALLET } from '../../lib/solana/swap/walletCopy';
import type { PreparedTx, TxOutcome } from '../solana/curve/ports';
import { fractionToBps, impactWarning } from '../solana/curve/uiFormat';

// ONE PRESS. A swap in our own pool that built, passed its test run and carries nothing
// a trader has to read goes from Buy to the wallet, as a Jupiter swap does. Every check
// the review flow makes has already run by then. These two rules say which swaps skip
// the review screen and which endings skip the outcome card. Anything else stops.

/**
 * True when the review would tell the trader nothing the form did not: the swap pays at
 * least the minimum the form showed when Buy was pressed (`floorShown`), no notice, a
 * read priority fee, a price impact under the warning line, Jupiter asked just now, and
 * SOL that arrives as plain SOL.
 */
export function needsNoReview(p: PreparedTx, floorShown: bigint | null): boolean {
  const s = p.summary;
  if (s.kind !== 'venue-swap') return false;
  // The price moved under what was pressed on: the new figures are read before signing.
  if (floorShown === null || s.quoted.outAmount < floorShown) return false;
  if (s.notices.length > 0 || !p.fees.priorityFeeRead) return false;
  // A sale paid as WRAPPED SOL into an account the wallet already had is said on the review.
  if (s.coin.native && !s.paysCoin && !s.unwrapsWsol) return false;
  if (impactWarning(fractionToBps(s.quoted.priceImpact)) !== null) return false;
  // "Could not be asked", "an earlier quote" and "refused by its test run" are each said before signing.
  return s.aggregator.kind === 'no-route' || (s.aggregator.kind === 'quoted' && s.aggregator.when === 'now');
}

export type QuietEnding =
  | { kind: 'confirmed'; signature: string }
  /** The trader said no in their wallet: nothing left the page. */
  | { kind: 'not-signed'; message: string }
  /** The route was checked again at the press and is no longer our pool. */
  | { kind: 'route-changed'; message: string };

const ROUTE_CHANGED: ReadonlySet<string> = new Set([OWN_ROUTE_COPY.routeMoved, OWN_ROUTE_COPY.underLastQuote, OWN_ROUTE_COPY.poolGone]);

/**
 * An ending that one line can say, so the form comes back by itself. Never `unknown`
 * (the swap may still land: its card holds the screen), and never a refusal by the
 * network, by the test run, or of what a wallet handed back: each has a reason to read.
 */
export function quietEnding(o: TxOutcome): QuietEnding | null {
  if (o.status === 'confirmed') return { kind: 'confirmed', signature: o.signature };
  if (o.status !== 'not-sent') return null;
  if (o.stage === 'sign' && o.message === DECLINED_IN_WALLET) return { kind: 'not-signed', message: o.message };
  if (o.stage === 'build' && ROUTE_CHANGED.has(o.message)) return { kind: 'route-changed', message: o.message };
  return null;
}
