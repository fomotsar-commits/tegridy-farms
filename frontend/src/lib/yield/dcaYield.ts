// What a DCA schedule's unspent budget could be doing, and what it is actually doing.
//
// THE HONEST FRAME, which the copy this module produces has to carry all the way
// to the screen: a DCA schedule here is a REMINDER, not an escrow. It holds no
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

/**
 * What a budget figure is denominated in.
 *
 * Carried on every input because `useDCA` validates a persisted schedule's token
 * to "any ticker, 0 to 18 decimals" and then reads its own amounts back with
 * `parseUnits(amount, fromToken.decimals)`. A consumer that narrows that to ETH
 * without checking prints a six-decimal balance at eighteen-decimal scale under
 * an ETH label, which is a wrong number rather than a missing one.
 */
export interface DcaAsset {
  /** Ticker. Rendered verbatim beside the figure; never substituted for another. */
  symbol: string;
  decimals: number;
}

/** The parts of a schedule that decide how much is still unspent. */
export interface DcaBudgetInput {
  /** Per-swap amount as typed, in whole units of `asset`. */
  amountPerSwap: string;
  totalSwaps: number;
  completedSwaps: number;
  /** Required, not defaulted — a default here is the assumption this field exists to refuse. */
  asset: DcaAsset;
}

export type DcaYieldLeg =
  | { state: 'available'; venue: YieldVenue }
  | { state: 'unavailable'; reason: string };

export interface DcaYieldPlan {
  /** Base units this schedule has not spent yet. Exact; never a rounded display value. */
  idleWei: bigint;
  /** The same figure for display. Derived from `idleWei`, not re-parsed from input. */
  idleAmount: string;
  /** What `idleAmount` counts. Rendered with it so the figure cannot be read as ETH. */
  asset: DcaAsset;
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
  // Checked before the amount is touched. `safeParseEther` and `formatEther` are
  // both eighteen-decimal operations and this module converts no units of its
  // own, so an asset of any other width is refused rather than computed at a
  // scale nobody chose. The refusal is the honest answer: a figure at the wrong
  // scale is off by a factor of a million and still looks like a balance.
  if (input.asset.decimals !== 18) {
    return {
      ok: false,
      reason:
        `This panel reads amounts at 18 decimals and ${input.asset.symbol} uses ${input.asset.decimals}, ` +
        'so its unspent budget is left out rather than shown at the wrong scale.',
    };
  }

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
      idleAmount: formatEther(idleWei),
      asset: input.asset,
      remainingSwaps,
      parking: parkingLeg(remainingSwaps, input.asset),
      autoStake: autoStakeLeg(input.asset),
      execution: DCA_YIELD_EXECUTION_NOTE,
    },
  };
}

export interface DcaIdleTotal {
  /** Sum over the schedules whose budget could be read, in `denomination`'s base units. */
  idleWei: bigint;
  idleAmount: string;
  /** The ticker this sum counts. Rendered with the figure, never assumed by the caller. */
  denomination: string;
  /** How many schedules that sum covers. */
  counted: number;
  /**
   * Schedules whose amount could not be parsed, and are therefore NOT in the sum.
   *
   * Surfaced rather than swallowed because a total that quietly omits a row is
   * understated, and understated is the direction that reads as reassuring.
   */
  unreadable: number;
  /**
   * Schedules denominated in something other than `denomination`.
   *
   * A separate count from `unreadable` because they are a different sentence to a
   * reader: those rows were read fine, they simply are not this asset and adding
   * them would produce a number that is not a quantity of anything.
   */
  otherDenomination: number;
}

/**
 * Unspent budget across several schedules, in ONE asset.
 *
 * The denomination is an argument rather than an inference, because the failure
 * being guarded is silent: nothing about summing a USDC row into an ETH total
 * throws, and the result renders as a plausible balance. Rows in another asset
 * are excluded and counted, never converted — this module holds no price and
 * would have to invent one.
 *
 * Summed in base units and formatted once at the end. Adding formatted strings,
 * or adding through `Number`, loses the low digits of an 18-decimal amount —
 * small per row and not small once a wallet has twenty schedules.
 */
export function dcaIdleTotal(
  inputs: readonly DcaBudgetInput[],
  denomination: string,
): DcaIdleTotal {
  let idleWei = 0n;
  let counted = 0;
  let unreadable = 0;
  let otherDenomination = 0;
  for (const input of inputs) {
    // Asked before the plan so a different-asset row is reported as a different
    // asset rather than as something this module failed to parse.
    if (input.asset.symbol !== denomination) {
      otherDenomination += 1;
      continue;
    }
    const result = dcaYieldPlan(input);
    if (!result.ok) {
      unreadable += 1;
      continue;
    }
    idleWei += result.plan.idleWei;
    counted += 1;
  }
  return {
    idleWei,
    idleAmount: formatEther(idleWei),
    denomination,
    counted,
    unreadable,
    otherDenomination,
  };
}

/**
 * Where an unspent budget could sit.
 *
 * The empty-catalogue branch is the live one in this build and it names the
 * missing piece rather than the feature — an operator reading it learns what to
 * wire, and a user reading it learns that nothing is being held anywhere.
 */
function parkingLeg(remainingSwaps: number, asset: DcaAsset): DcaYieldLeg {
  if (remainingSwaps === 0) {
    return { state: 'unavailable', reason: `This schedule has no swaps left to make, ${REMAINING_NOTE}` };
  }
  // KEYED TO THE BUDGET'S OWN TOKEN, not merely to the first routable lending
  // market. Before venues were wired this distinction cost nothing, because the
  // catalogue was empty and every branch refused. The moment Aave's USDC market
  // became routable, an unkeyed lookup would have told the holder of an ETH
  // schedule that their idle ETH "would route to Aave v3 — USDC market", which
  // is a token they do not hold and a deposit that would revert.
  const venue = routableYieldVenues('stable-lending').find(
    (v) => v.route.kind === 'erc20-supply' && v.route.asset.symbol === asset.symbol,
  );
  if (venue === undefined) {
    return {
      state: 'unavailable',
      reason:
        `No lending market on the Yield Routing page accepts ${asset.symbol}. The USDC and USDS markets take those ` +
        'tokens, which this schedule does not hold, so its unspent budget stays in your wallet earning nothing.',
    };
  }
  return { state: 'available', venue };
}

/** Where a completed buy could be staked. Same keying, other half of the catalogue. */
function autoStakeLeg(asset: DcaAsset): DcaYieldLeg {
  if (asset.symbol !== 'ETH' && asset.symbol !== 'WETH') {
    return {
      state: 'unavailable',
      reason:
        `The staking venues on the Yield Routing page all take ETH, and this schedule holds ${asset.symbol}, so a ` +
        'completed buy cannot be staked from here. It stays in your wallet as the token you bought.',
    };
  }
  const venue = routableYieldVenues(['lst', 'lrt']).find(
    (v) => v.route.kind === 'native-payable' && v.route.asset === 'ETH',
  );
  if (venue === undefined) {
    return {
      state: 'unavailable',
      reason:
        'No staking venue has a wired deposit address in this build, so a completed buy cannot be staked from here. ' +
        'It stays in your wallet as the token you bought.',
    };
  }
  return { state: 'available', venue };
}
