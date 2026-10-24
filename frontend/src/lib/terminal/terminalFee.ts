// What the terminal charges. NO FEE MECHANISM LIVES HERE: every figure is read from
// lib/fees/swapFee.ts, the single venue dial, and the number shown is the number
// ATTACHED to the request, never the number configured.
// A terminal buy submits through the in-app swap path (useSwap: SwapFeeRouter or
// UniswapV2Router on CHAIN_ID), which has no aggregator fee leg, so `source: null`
// reports None. The fee is asked about on CHAIN_ID because that is where it executes.

import type { AggregatorSource } from '../aggregator';
import { AGGREGATOR_NAMES } from '../aggregator';
import { CHAIN_ID } from '../constants';
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
  const attachment = route.source === null ? null : providerFeeAttachment(route.source, CHAIN_ID);
  const bps = attachment?.bps ?? 0;

  if (bps <= 0) {
    // Two different situations share this branch and the note tells them apart,
    // because "the venue charges nothing" and "the venue's fee could not be
    // attached to this route" are different promises about the next trade.
    const dialOn = swapFeePolicy(CHAIN_ID).enabled;
    const note =
      route.source !== null && dialOn
        ? `The venue fee is configured but is not attached to ${AGGREGATOR_NAMES[route.source]} on this build, so it is not charged here. ${THIRD_PARTY_NOTE}`
        : `The venue adds no fee to this trade. ${THIRD_PARTY_NOTE}`;
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
    note: `Added by the venue to this ${who} route before you sign. ${THIRD_PARTY_NOTE}`,
    bps,
    charged: true,
  };
}
