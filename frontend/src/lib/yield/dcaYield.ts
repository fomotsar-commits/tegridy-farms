// What a DCA schedule's unspent budget could be doing, and what it is actually doing.
//
// THE HONEST FRAME, which the copy this module produces has to carry all the way
// to the screen: a Tegridy DCA schedule is a REMINDER, not an escrow. It holds no
// funds, so an "unfilled budget" is money still sitting in the user's own wallet.
// Nothing here moves it, nothing here can move it, and the figure below is the
// size of an opportunity rather than a balance under management.
//
// TWO SEPARATE REASONS NOTHING FIRES ON ITS OWN, and both must be said because
// fixing either one alone changes nothing:
//   · the venue runs NO KEEPER, so there is no process to notice a schedule is due
//     while the tab is shut — the existing DCA panel already says this;
//   · every leg is a wallet signature, because this venue is non-custodial and no
//     server holds or derives a key. "Auto-stake" therefore means "prepared, then
//     you sign", and any wording that implies otherwise is a lie about custody.
//
// So "auto" is a scheduling word here, never an execution word. `execution` below
// is a required field on every plan for exactly that reason: a caller cannot
// render a leg without also having the sentence that qualifies it in hand.

import { formatEther } from 'viem';
import { safeParseEther } from '../safeParseEther';
import { routableYieldVenues, type YieldVenue } from './venues';

/** The parts of a schedule that decide how much is still unspent. */
export interface DcaBudgetInput {
  /** Per-swap amount as typed, in ETH. */
  amountPerSwap: string;
  totalSwaps: number;
  completedSwaps: number;
}

export type DcaYieldLeg =
  | { state: 'available'; venue: YieldVenue }
  | { state: 'unavailable'; reason: string };

export interface DcaYieldPlan {
  /** Wei this schedule has not spent yet. Exact; never a rounded display value. */
  idleWei: bigint;
  /** The same figure for display. Derived from `idleWei`, not re-parsed from input. */
  idleEth: string;
  /** Swaps still to come. Zero once a schedule has run its course. */
  remainingSwaps: number;
  /** Where the unspent budget could earn while it waits. */
  parking: DcaYieldLeg;
  /** Where a completed buy could be staked. */
  autoStake: DcaYieldLeg;
  /** The qualification every leg is rendered with. Never optional. */
  execution: string;
}

export type DcaYieldPlanResult =
  | { ok: true; plan: DcaYieldPlan }
  | { ok: false; reason: string };

/**
 * Rendered verbatim beneath both legs.
 *
 * One string rather than two so the two panels cannot drift into disagreeing
 * about how automatic any of this is.
 */
export const DCA_YIELD_EXECUTION_NOTE =
  'Neither leg runs on its own. This venue operates no keeper, and no server here holds or can derive your key — so each deposit, withdrawal and stake is a transaction you sign yourself, in an open tab. A schedule left closed does nothing at all.';

/**
 * The cost this plan does not net out, stated rather than modelled.
 *
 * Parking an unfilled budget and pulling it back out for each buy adds two
 * transactions per swap, and at a small per-swap amount those can exceed the
 * yield earned in the interval. Estimating that trade-off would mean inventing a
 * gas figure and a rate, so it is disclosed as a question the user answers with
 * numbers this surface refuses to guess at.
 */
export const DCA_YIELD_ROUND_TRIP_NOTE =
  'Parking the budget and withdrawing it for each buy adds two signed transactions per swap. Whether that costs more in gas than it earns depends on your amount, your interval and the gas price at the time — this panel does not estimate it for you.';

/**
 * Why the same idea does NOT transfer to a TWAP order.
 *
 * A DCA schedule signs each swap as it comes due, so its unspent budget is free
 * to be somewhere else in the meantime. A ComposableCoW TWAP is one signed order
 * the solver settles in parts, and every part settles against the sell balance
 * and allowance that must still be there when it fires. Parking that balance does
 * not delay a part, it fails it — so this is a refusal with a mechanism behind
 * it, not a missing feature.
 */
export const TWAP_IDLE_NOTE =
  'The WETH this order has not sold yet stays in your wallet and earns nothing while it waits — and it has to. Each part settles against that balance and its allowance, so moving it into a yield venue would make the remaining parts fail rather than merely postpone them.';

const REMAINING_NOTE = 'so there is nothing left unspent for this schedule to park.';

/**
 * Unspent budget and the legs it could reach.
 *
 * Refuses rather than defaults on unusable input: an unparseable amount returns
 * `ok: false`, because a DCA panel that answers "0 ETH idle" to a malformed field
 * has told the user their budget is fully deployed when it has read nothing at
 * all. `safeParseEther` is the repo's existing guard against the same class of
 * bug on the input path, and this is that guard applied one step later.
 */
export function dcaYieldPlan(input: DcaBudgetInput): DcaYieldPlanResult {
  const perSwapWei = safeParseEther(input.amountPerSwap);
  if (perSwapWei === null) {
    return {
      ok: false,
      reason: 'The per-swap amount could not be read as a number, so no unspent budget can be worked out from it.',
    };
  }
  if (!Number.isInteger(input.totalSwaps) || !Number.isInteger(input.completedSwaps)) {
    return { ok: false, reason: 'This schedule’s swap counts are not whole numbers, so its remaining budget cannot be worked out.' };
  }
  if (input.totalSwaps < 0 || input.completedSwaps < 0) {
    return { ok: false, reason: 'This schedule’s swap counts are negative, so its remaining budget cannot be worked out.' };
  }

  // Clamped rather than allowed negative: a schedule that overran its own count
  // has already spent everything, and a negative "idle" figure would render as a
  // debt this venue is in no position to assert.
  const remainingSwaps = Math.max(0, input.totalSwaps - input.completedSwaps);
  const idleWei = perSwapWei * BigInt(remainingSwaps);

  return {
    ok: true,
    plan: {
      idleWei,
      idleEth: formatEther(idleWei),
      remainingSwaps,
      parking: parkingLeg(remainingSwaps),
      autoStake: autoStakeLeg(),
      execution: DCA_YIELD_EXECUTION_NOTE,
    },
  };
}

export interface DcaIdleTotal {
  /** Sum over the schedules whose budget could be read. */
  idleWei: bigint;
  idleEth: string;
  /** How many schedules that sum covers. */
  counted: number;
  /**
   * Schedules whose amount could not be parsed, and are therefore NOT in the sum.
   *
   * Surfaced rather than swallowed because a total that quietly omits a row is
   * understated, and understated is the direction that reads as reassuring.
   */
  unreadable: number;
}

/**
 * Unspent budget across several schedules.
 *
 * Summed in wei and formatted once at the end. Adding formatted ETH strings, or
 * adding through `Number`, loses the low digits of an 18-decimal amount — small
 * per row and not small once a wallet has twenty schedules.
 */
export function dcaIdleTotal(inputs: readonly DcaBudgetInput[]): DcaIdleTotal {
  let idleWei = 0n;
  let counted = 0;
  let unreadable = 0;
  for (const input of inputs) {
    const result = dcaYieldPlan(input);
    if (!result.ok) {
      unreadable += 1;
      continue;
    }
    idleWei += result.plan.idleWei;
    counted += 1;
  }
  return { idleWei, idleEth: formatEther(idleWei), counted, unreadable };
}

/**
 * Where an unspent budget could sit.
 *
 * The empty-catalogue branch is the live one in this build and it names the
 * missing piece rather than the feature — an operator reading it learns what to
 * wire, and a user reading it learns that nothing is being held anywhere.
 */
function parkingLeg(remainingSwaps: number): DcaYieldLeg {
  if (remainingSwaps === 0) {
    return { state: 'unavailable', reason: `This schedule has no swaps left to make, ${REMAINING_NOTE}` };
  }
  const venue = routableYieldVenues('stable-lending')[0];
  if (venue === undefined) {
    return {
      state: 'unavailable',
      reason:
        'No lending market has a wired deposit address in this build, so an unfilled budget cannot be parked from here. It stays in your wallet, earning nothing.',
    };
  }
  return { state: 'available', venue };
}

/** Where a completed buy could be staked. Same gate, different half of the catalogue. */
function autoStakeLeg(): DcaYieldLeg {
  const venue = routableYieldVenues(['lst', 'lrt'])[0];
  if (venue === undefined) {
    return {
      state: 'unavailable',
      reason:
        'No staking venue has a wired deposit address in this build, so a completed buy cannot be staked from here. It stays in your wallet as the token you bought.',
    };
  }
  return { state: 'available', venue };
}
