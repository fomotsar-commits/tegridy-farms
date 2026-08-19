// What a zap costs the user in venue fees, which is: nothing this module adds.
//
// The zap composes calls the app already makes. It introduces NO dial of its own — there
// is no `VITE_ZAP_FEE_*`, and `zapFeeDial.test.ts` fails the build if one appears in
// `src/lib/zap`, `src/hooks/useZap*` or `src/components/zap`. The single venue dial is
// `src/lib/fees/swapFee.ts`, off by default and off until an operator sets BOTH halves;
// this module reads it rather than restating it, so a rate can never be advertised here
// that the rest of the app does not agree with.
//
// The fee a zap's swap leg actually pays comes from the router that executes it, exactly
// as it does on the swap page:
//   · the venue's own SwapFeeRouter takes its on-chain `feeBps`, which is a LIVE READ and
//     therefore can be unavailable;
//   · a real Uniswap route pays Uniswap, and the venue takes nothing (you cannot fee a
//     trade you do not host).
//
// An unavailable read renders as unavailable. Rendering it as 0% would be the same class
// of lie as an outage rendering as a legitimate zero.

import { swapFeePolicy } from '../fees/swapFee';

export type ZapExecutorKind = 'swap-fee-router' | 'uniswap-v2';

export interface ZapFeeInput {
  /** Which contract the swap leg goes through, or null when the zap has no swap leg. */
  executor: ZapExecutorKind | null;
  /**
   * `SwapFeeRouter.feeBps()` as read from the chain. `null` means the read did not answer
   * — NOT that the fee is zero. Callers must pass null on a failed or pending read.
   */
  routerFeeBps: number | null;
}

export interface ZapFeeDisclosure {
  label: string;
  /** Rendered verbatim. 'Unavailable' when the live read did not answer. */
  value: string;
  /** Rendered verbatim beneath the row. Never empty. */
  note: string;
  /** True when the figure is missing rather than zero. Gates the signing affordance. */
  unavailable: boolean;
  /** Always 0. The zap adds no fee, and the type keeps that a stated fact. */
  addedByZap: 0;
}

const THIRD_PARTY_NOTE =
  'Pool, aggregator and network gas costs are set by the venues this zap routes through and are not part of this figure.';

function formatBpsPct(bps: number): string {
  return `${Number((bps / 100).toFixed(4))}%`;
}

export function zapFeeDisclosure(input: ZapFeeInput): ZapFeeDisclosure {
  // Read the single dial even when it plays no part in this route. It is the thing that
  // would have to change for the venue to start charging, so a surface that never consults
  // it could keep saying "no fee" after one was switched on.
  const policy = swapFeePolicy();

  if (input.executor === null) {
    return {
      label: 'Venue fee',
      value: 'None',
      note: `This zap has no swap leg, so no venue takes a cut of it. ${THIRD_PARTY_NOTE}`,
      unavailable: false,
      addedByZap: 0,
    };
  }

  if (input.executor === 'uniswap-v2') {
    return {
      label: 'Venue fee',
      value: 'None',
      note:
        'The swap leg fills on Uniswap, which Tegridy does not host, so the venue takes nothing from it. ' +
        `The zap itself adds no fee${policy.enabled ? ', including while the venue swap fee is switched on' : ''}. ` +
        THIRD_PARTY_NOTE,
      unavailable: false,
      addedByZap: 0,
    };
  }

  if (input.routerFeeBps === null) {
    return {
      label: 'Venue fee',
      value: 'Unavailable',
      note:
        "The swap leg routes through Tegridy's SwapFeeRouter, and its fee could not be read from the chain just " +
        'now. That is a missing number, not a zero — refresh before signing if you want it stated. ' +
        THIRD_PARTY_NOTE,
      unavailable: true,
      addedByZap: 0,
    };
  }

  if (input.routerFeeBps <= 0) {
    return {
      label: 'Venue fee',
      value: 'None',
      note: `The SwapFeeRouter's on-chain fee reads as zero. The zap adds nothing to it. ${THIRD_PARTY_NOTE}`,
      unavailable: false,
      addedByZap: 0,
    };
  }

  return {
    label: 'Venue fee',
    value: formatBpsPct(input.routerFeeBps),
    note:
      "Taken by Tegridy's SwapFeeRouter on the swap leg, at the rate it reports on-chain. The zap adds nothing " +
      `on top of it. ${THIRD_PARTY_NOTE}`,
    unavailable: false,
    addedByZap: 0,
  };
}
