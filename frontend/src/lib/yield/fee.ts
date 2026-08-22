// The venue fee on a yield route — which is to say, the absence of one.
//
// This module deliberately holds NO rate of its own. lib/fees/swapFee.ts owns the
// dial, the ceiling and the per-provider legs, and its standing rule is that the
// number a caller SENDS and the number a surface DISPLAYS both come from
// `providerFeeAttachment` — one call, one object, per provider per quote. A yield
// surface that printed `swapFeePolicy().bps` would break that in the direction
// that matters: it would advertise a charge against a request no provider ever
// received.
//
// Which is why `yieldRouteFee` takes the provider as an argument and answers
// `charged: false` when there is not one. Routing into these venues is gated
// (see venues.ts — every deposit target is unwired), so today the argument is
// always null and the answer is always "no fee, because no route is submitted
// from here". When execution is wired, the figure arrives from the attachment or
// it does not arrive at all; there is no third source and none may be added.

import type { AggregatorSource } from '../aggregator';
import { providerFeeAttachment } from '../fees/swapFee';

export type YieldRouteFee =
  | {
      charged: false;
      /** Rendered verbatim. The zero case is the one that needs the sentence most. */
      reason: string;
    }
  | {
      charged: true;
      /** Straight off the attachment. Never recomputed, never re-derived from the policy. */
      bps: number;
      recipient: `0x${string}`;
      source: AggregatorSource;
    };

/**
 * Third-party costs this figure has never described.
 *
 * Kept adjacent to the fee wording for the same reason VenueFeeLine keeps its
 * own copy of the thought: "no venue fee" is heard as "free", and the pool spread,
 * the protocol's own cut and gas are all still paid by the depositor.
 */
export const YIELD_THIRD_PARTY_NOTE =
  'The destination protocol takes its own cut of the yield, and swap, deposit and gas costs are set by whoever you route through. None of that is part of this figure.';

const NO_ROUTE_REASON =
  'Tegridy adds no fee here. Nothing is submitted from this surface — it compares external venues and does not execute into them — so there is no request for a fee to ride on.';

const BLOCKED_LEG_REASON =
  'Tegridy adds no fee to this route. The provider that would carry it has no confirmed fee mechanism in this build, so none was attached to the request.';

/**
 * The fee actually attached to a yield route, or the reason there is none.
 *
 * `source === null` is the routing-gated state and returns the no-route reason.
 * A named provider whose leg is withheld returns the blocked reason — a different
 * sentence, because "we chose not to charge here" and "we could not charge here
 * safely" are different facts and an operator reading the surface needs to tell
 * them apart.
 */
export function yieldRouteFee(source: AggregatorSource | null): YieldRouteFee {
  if (source === null) return { charged: false, reason: NO_ROUTE_REASON };
  const attachment = providerFeeAttachment(source);
  if (attachment === null) return { charged: false, reason: BLOCKED_LEG_REASON };
  return { charged: true, bps: attachment.bps, recipient: attachment.recipient, source };
}

/** The value column's exact text, so display can be asserted without the DOM. */
export function yieldRouteFeeValue(fee: YieldRouteFee): string {
  return fee.charged ? `${Number((fee.bps / 100).toFixed(4))}%` : 'None';
}
