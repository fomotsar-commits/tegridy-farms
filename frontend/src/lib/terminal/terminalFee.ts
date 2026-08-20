// What the terminal charges, and where that number comes from.
//
// THERE IS NO FEE MECHANISM IN THIS FILE. Every figure below is read out of
// lib/fees/swapFee.ts — the venue's single fee dial — so the terminal inherits
// its off-by-default state rather than acquiring one of its own. A second rate
// living here would be a second thing to turn off, and the two would drift the
// first time one of them moved.
//
// The number displayed is the number ATTACHED, not the number configured.
// `providerFeeAttachment` returns null for a provider whose leg is withheld even
// while the dial is on, and this module passes that through: a row that
// advertised a fee the request never carried would be a fabricated charge, which
// is the same class of lie as a fabricated balance and lands on somebody's money.
//
// The one-click buy submits through the EXISTING in-app swap path (useSwap →
// SwapFeeRouter / UniswapV2Router), which is not an aggregator and carries no
// venue fee leg at all. So `source: null` is the honest description of what a
// terminal buy does today, and it reports None. When the F3 fee-on-top router
// lands, the executing route gains a source and this module reports it without
// a change here.

import type { AggregatorSource } from '../aggregator';
import { AGGREGATOR_NAMES } from '../aggregator';
import { providerFeeAttachment, swapFeePolicy } from '../fees/swapFee';

const THIRD_PARTY_NOTE =
  'Pool, aggregator and network gas costs are set by the venue you route through and are not part of this figure.';

export interface TerminalRoute {
  /** The aggregator that would fill, or null for the in-app router path. */
  source: AggregatorSource | null;
  /** True only when `source` names the route that will actually be submitted. */
  executes: boolean;
}

export interface TerminalFeeDisclosure {
  label: string;
  /** Rendered verbatim. */
  value: string;
  /** Rendered verbatim beneath. Never empty — the zero case needs it most. */
  note: string;
  /** Rate actually attached to the request, in bps. Display this; never recompute. */
  bps: number;
  /** True only when a nonzero fee is both attached AND taken on this route. */
  charged: boolean;
}

function formatBpsPct(bps: number): string {
  return `${Number((bps / 100).toFixed(4))}%`;
}

export function terminalFeeDisclosure(route: TerminalRoute): TerminalFeeDisclosure {
  const attachment = route.source === null ? null : providerFeeAttachment(route.source);
  const bps = attachment?.bps ?? 0;

  if (bps <= 0) {
    // Two different situations share this branch and the note tells them apart,
    // because "the venue charges nothing" and "the venue's fee could not be
    // attached to this route" are different promises about the next trade.
    const dialOn = swapFeePolicy().enabled;
    const note =
      route.source !== null && dialOn
        ? `The venue fee is configured but is not attached to ${AGGREGATOR_NAMES[route.source]} on this build, so it is not charged here. ${THIRD_PARTY_NOTE}`
        : `Tegridy adds no fee to this trade. ${THIRD_PARTY_NOTE}`;
    return { label: 'Terminal fee', value: 'None', note, bps: 0, charged: false };
  }

  const who = AGGREGATOR_NAMES[route.source!];
  if (!route.executes) {
    return {
      label: 'Terminal fee',
      value: `${formatBpsPct(bps)} (not charged)`,
      note: `This ${who} quote is shown for comparison and is not the route submitted, so the fee is not taken. ${THIRD_PARTY_NOTE}`,
      bps,
      charged: false,
    };
  }
  return {
    label: 'Terminal fee',
    value: formatBpsPct(bps),
    note: `Added by Tegridy to this ${who} route before you sign. ${THIRD_PARTY_NOTE}`,
    bps,
    charged: true,
  };
}
