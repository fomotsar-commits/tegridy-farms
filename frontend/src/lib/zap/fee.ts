// What a zap costs in venue fees: nothing this module adds. It has NO dial of its own
// (fee.test.ts fails on any `import.meta.env.VITE_*` in the zap folders); it reads the venue
// dial in src/lib/fees/swapFee.ts, on CHAIN_ID, the only chain a zap executes on.
// The swap leg pays what its executing router takes: SwapFeeRouter's on-chain `feeBps`
// (a LIVE READ, so it can be unavailable, and unavailable is never rendered as 0%), or
// nothing to the venue on a real Uniswap route.

import { CHAIN_ID } from '../constants';
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
  const policy = swapFeePolicy(CHAIN_ID);

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
        'The swap leg fills on Uniswap, which the venue does not host, so the venue takes nothing from it. ' +
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
        "The swap leg routes through the venue's SwapFeeRouter, and its fee could not be read from the chain just " +
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
      "Taken by the venue's SwapFeeRouter on the swap leg, at the rate it reports on-chain. The zap adds nothing " +
      `on top of it. ${THIRD_PARTY_NOTE}`,
    unavailable: false,
    addedByZap: 0,
  };
}
