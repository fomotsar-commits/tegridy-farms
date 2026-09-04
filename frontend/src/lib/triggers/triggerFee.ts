// The 0.1% execution fee on a triggered order.
//
// This is NOT a second fee mechanism. Whether a fee exists at all, and who receives
// it, come from lib/fees/swapFee.ts — the same two dials, both default-off, that
// gate every other venue fee. What this module adds is one number and one rule:
//
//   docs/BATTLE_PLAN.md #16 publishes the trigger rate as 0.1% per EXECUTION. The
//   operator's dial can only LOWER that; a dial set for the swap surface's higher
//   rate does not raise what a triggered order pays. A published rate that the
//   configuration can quietly exceed is not a published rate.
//
// And one consequence, which is why the fee is currently uncollectable on the only
// executor that exists: a triggered order settles through CoW, and CoW's fee leg is
// `blocked` in the policy table because it rides an appData document whose hash has
// not been re-pinned. Blocked means withheld, so the honest figure here is None —
// and the disclosure says which of the two reasons it is, because "the venue turned
// its fee off" and "the venue cannot attach its fee to this route" are different
// facts about the same zero.
//
// Untriggered orders cost nothing: there is no execution to charge.

import { PROVIDER_FEE_LEGS, swapFeePolicy } from '../fees/swapFee';
import type { TriggerPath } from './armState';

/** The published schedule. A ceiling, not a default — see the module note. */
export const TRIGGER_EXECUTION_FEE_BPS = 10;

const THIRD_PARTY_NOTE =
  'CoW solver fees, pool costs and network gas are set by whoever fills the order and are not part of this figure.';

export type TriggerFeeState =
  | {
      charged: true;
      bps: number;
      recipient: `0x${string}`;
      /** Merge into the executing request. The rate here is the one displayed. */
      params: Record<string, string>;
    }
  | {
      charged: false;
      bps: 0;
      /** The rate that WOULD apply, so the surface can state the schedule honestly. */
      scheduleBps: number;
      reason: string;
    };

/**
 * The fee actually attached to one triggered execution on `path`.
 *
 * Callers display `bps` from this object and never from `swapFeePolicy()`: the
 * policy can be enabled while this returns zero, and a surface reading the policy
 * would advertise a charge no request carried.
 */
export function triggerExecutionFee(path: TriggerPath): TriggerFeeState {
  const policy = swapFeePolicy();
  if (!policy.enabled || policy.recipient === null) {
    return {
      charged: false,
      bps: 0,
      scheduleBps: TRIGGER_EXECUTION_FEE_BPS,
      reason: 'The venue fee is switched off for this deployment.',
    };
  }
  if (path === 'keeper') {
    return {
      charged: false,
      bps: 0,
      scheduleBps: TRIGGER_EXECUTION_FEE_BPS,
      reason: 'No keeper executes these orders yet, so there is no execution to charge for.',
    };
  }
  const leg = PROVIDER_FEE_LEGS.cowswap;
  if (leg.status !== 'ready') {
    return {
      charged: false,
      bps: 0,
      scheduleBps: TRIGGER_EXECUTION_FEE_BPS,
      reason: `The venue fee cannot be attached to a CoW order yet: ${leg.mustConfirm}.`,
    };
  }
  const bps = Math.min(policy.bps, TRIGGER_EXECUTION_FEE_BPS);
  return {
    charged: true,
    bps,
    recipient: policy.recipient,
    params: leg.query({ bps, recipient: policy.recipient }),
  };
}

export interface TriggerFeeDisclosure {
  label: string;
  /** Rendered verbatim in the value column. */
  value: string;
  /** Rendered verbatim beneath the row. Never empty — the zero case needs it most. */
  note: string;
}

function formatBpsPct(bps: number): string {
  return `${Number((bps / 100).toFixed(4))}%`;
}

/** The exact strings the fee row renders, so display can be asserted without the DOM. */
export function triggerFeeDisclosure(path: TriggerPath): TriggerFeeDisclosure {
  const fee = triggerExecutionFee(path);
  if (!fee.charged) {
    return {
      label: 'Venue fee on execution',
      value: 'None',
      note: `${fee.reason} The published rate for a triggered execution is ${formatBpsPct(fee.scheduleBps)}, taken only when an order actually fills. ${THIRD_PARTY_NOTE}`,
    };
  }
  return {
    label: 'Venue fee on execution',
    value: formatBpsPct(fee.bps),
    note: `Taken by the venue from the proceeds when — and only when — this order fills. An order that never triggers costs nothing. ${THIRD_PARTY_NOTE}`,
  };
}
