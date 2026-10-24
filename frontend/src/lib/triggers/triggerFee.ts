// The 0.1% execution fee on a triggered order. NOT a second mechanism: whether a fee
// exists and who receives it come from lib/fees/swapFee.ts. The one rule added here:
// docs/BATTLE_PLAN.md #16 publishes 0.1% per EXECUTION, and the dial can only lower it.
// Orders settle through CoW on CHAIN_ID, so that is the chain the fee is asked about.
// CoW's leg is `blocked` (its appData hash is not re-pinned), so this reads None today,
// and the disclosure says which reason. An untriggered order costs nothing.

import { CHAIN_ID } from '../constants';
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
 * The fee actually attached to one triggered execution on `path`. Display `bps` from
 * this object, never from `swapFeePolicy()`: the policy can be enabled while this
 * returns zero.
 */
export function triggerExecutionFee(path: TriggerPath): TriggerFeeState {
  const policy = swapFeePolicy(CHAIN_ID);
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
