// The venue-fee row for the swap route panel.
//
// Reads the fee off the QUOTE, not off the policy. `AggregatorQuote.venueFeeBps` is
// stamped with the fee that was actually attached to that provider's request, so a
// provider whose leg is withheld (see lib/fees/swapFee.ts) renders 0 while the policy
// is enabled — which is the honest reading, since that provider was never sent a fee.
// Deriving the row from `swapFeePolicy()` instead would advertise a charge the request
// did not carry.
//
// `executes` exists because the meta-router is a COMPARISON surface today: useSwap
// submits through SwapFeeRouter / UniswapV2Router and never through an aggregator, so
// an aggregator quote's fee is quoted but not taken. A row that said "0.25%" over a
// route nobody signs would be a fabricated charge in the other direction.
//
// The zero state deliberately does not say "no fees". Pool, aggregator and gas costs
// are still paid to third parties on every route, and this figure has never described
// them.

import type { AggregatorSource } from '../../lib/aggregator';
import { AGGREGATOR_NAMES } from '../../lib/aggregator';

export interface VenueFeeQuote {
  source: AggregatorSource;
  venueFeeBps: number;
}

export interface VenueFeeDisclosure {
  label: string;
  /** Rendered verbatim in the value column. */
  value: string;
  /** Rendered verbatim beneath the row. Never empty — the zero case needs it most. */
  note: string;
}

const THIRD_PARTY_NOTE =
  'Pool, aggregator and network gas costs are set by the venue you route through and are not part of this figure.';

function formatBpsPct(bps: number): string {
  return `${Number((bps / 100).toFixed(4))}%`;
}

/**
 * The exact strings the row renders, split out so the display can be asserted against
 * the fee that was sent without going through the DOM.
 */
export function venueFeeDisclosure(
  quote: VenueFeeQuote | null,
  executes: boolean,
): VenueFeeDisclosure {
  const bps = quote?.venueFeeBps ?? 0;
  if (bps <= 0) {
    return {
      label: 'Venue fee',
      value: 'None',
      note: `Tegridy adds no fee to this route. ${THIRD_PARTY_NOTE}`,
    };
  }
  const who = AGGREGATOR_NAMES[quote!.source];
  if (!executes) {
    return {
      label: 'Venue fee',
      value: `${formatBpsPct(bps)} (not charged)`,
      note: `This ${who} quote is shown for comparison and is not submitted in-app, so the venue fee is not taken. ${THIRD_PARTY_NOTE}`,
    };
  }
  return {
    label: 'Venue fee',
    value: formatBpsPct(bps),
    note: `Added by Tegridy to this ${who} route before you sign. ${THIRD_PARTY_NOTE}`,
  };
}

export interface VenueFeeLineProps {
  /** The quote that would fill, or null when the executing route is not an aggregator. */
  quote: VenueFeeQuote | null;
  /** True only when `quote` names the route that will actually be submitted. */
  executes: boolean;
}

export function VenueFeeLine({ quote, executes }: VenueFeeLineProps) {
  const { label, value, note } = venueFeeDisclosure(quote, executes);
  const charged = (quote?.venueFeeBps ?? 0) > 0 && executes;
  return (
    <div className="mt-1">
      <div className="flex justify-between">
        <span className="text-white">{label}</span>
        <span className={`font-mono ${charged ? 'text-amber-200' : 'text-white'}`}>{value}</span>
      </div>
      <p className="mt-0.5 text-[10px] text-white/70" style={{ textShadow: '0 1px 3px rgba(0,0,0,0.8)' }}>
        {note}
      </p>
    </div>
  );
}
