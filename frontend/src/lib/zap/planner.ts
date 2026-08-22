// Composing a zap: the ordered list of calls, and the refusal when it cannot be built.
//
// SHAPE, NOT CALLDATA. This module decides which legs exist, which of them can share a
// wallet confirmation, and what the worst case costs. `calls.ts` turns a leg into
// calldata; `machine.ts` tracks what happened to it. Splitting it this way is what makes
// the interrupted paths testable without a wallet.
//
// STAGES ARE THE UNIT OF BATCHING, AND THE UNIT OF RISK.
// A stage is a run of legs whose amounts are all knowable when the stage begins. EIP-5792
// collapses a stage into one confirmation; a wallet without it signs each leg in turn.
// What a stage boundary means is that the next leg's amount depends on the previous
// stage's OUTPUT, which no client can know before it lands. That boundary is where a zap
// can strand a user, and it is deliberately visible in this type rather than buried in an
// executor, because the UI has to name it.
//
// There is no contract here and none is coming. Every target below is a hard-coded
// address from `src/lib/constants.ts` (docs/USER_VALUE_ROADMAP.md line 101).

import type { Address } from 'viem';
import {
  LP_FARMING_ADDRESS,
  TEGRIDY_LP_ADDRESS,
  TEGRIDY_ROUTER_ADDRESS,
  TEGRIDY_STAKING_ADDRESS,
  TOWELI_ADDRESS,
} from '../constants';
import { venueAvailability, type ZapVenue, type ZapVenueId } from './venues';

// ─── What the caller asks for ───────────────────────────────────────────────

/**
 * The zap request, in a form that survives a page reload.
 *
 * Everything is a string or a number on purpose: this is the record persistence writes,
 * and a resumed run must rebuild the SAME plan from it. `bigint` does not survive
 * `JSON.stringify`, and a plan rebuilt from a silently-truncated amount would resume into
 * a different transaction than the one the user started.
 */
export interface ZapDescriptor {
  venueId: ZapVenueId;
  account: Address;
  chainId: number;
  /** Input token address; the native sentinel is expressed by `inputIsNative`, not here. */
  inputToken: Address;
  inputSymbol: string;
  inputIsNative: boolean;
  /** Base-unit amount, decimal string. */
  amountIn: string;
  /** Per-leg slippage tolerance. The composed figure is derived, never configured. */
  slippageBps: number;
  /** Seconds, decimal string. Required by the staking-lock venue, ignored by the farm. */
  lockDurationSeconds?: string;
}

/**
 * One swap leg's live route, resolved by the caller from the meta-router.
 *
 * `minOut` is the floor that gets SUBMITTED, not a display figure — `planner` copies it
 * into the calldata unchanged. A caller that has no route must pass `null` rather than a
 * zero or a guess; a zero minOut is an unbounded swap, and a guess is a fabricated quote.
 */
export interface ZapSwapRoute {
  /** Contract that executes the swap, and that an ERC20 input must approve. */
  executor: Address;
  /** True when the executor takes `maxFeeBps` (the venue's own SwapFeeRouter). */
  executorTakesMaxFee: boolean;
  amountIn: bigint;
  minOut: bigint;
  path: readonly Address[];
  slippageBps: number;
}

/** Live routes for the legs a plan may need. A required leg with `null` refuses the plan. */
export interface ZapRoutes {
  /** Input → TOWELI. */
  toTowelie: ZapSwapRoute | null;
  /** Input → ETH. Only the LP venue needs it, and only for a non-native input. */
  toEth?: ZapSwapRoute | null;
}

// ─── The plan ───────────────────────────────────────────────────────────────

export type ZapStepId =
  | 'approve-swap-towelie'
  | 'swap-towelie'
  | 'approve-swap-eth'
  | 'swap-eth'
  | 'approve-router'
  | 'add-liquidity'
  | 'approve-farm'
  | 'farm-stake'
  | 'approve-vault'
  | 'vault-deposit'
  | 'approve-staking'
  | 'staking-lock';

/** Where a measured amount comes from. Both are ERC20 balances — see `measured` below. */
export type ZapMeasureKey = 'towelie' | 'lp';

export type ZapAmount =
  | { kind: 'fixed'; value: bigint }
  /**
   * The DELTA of an ERC20 balance since the run began, never the whole balance. A user
   * who already held TOWELI before starting must not have it swept into the position.
   *
   * Only ERC20 balances are measured. The native balance also pays gas, so its delta
   * cannot distinguish "the swap returned less" from "the last transaction cost more" —
   * the ETH side of the liquidity leg is a fixed amount for that reason.
   */
  | { kind: 'measured'; key: ZapMeasureKey };

export interface ZapStepPlan {
  id: ZapStepId;
  /** Legs sharing a stage can share one EIP-5792 confirmation. */
  stage: number;
  /** Shown in the progress list, verbatim. */
  label: string;
  kind: 'approve' | 'swap' | 'add-liquidity' | 'deposit';
  /**
   * What the user holds once THIS leg has confirmed, or null when the leg moves nothing.
   * An approval changes an allowance and no balance, so it can never be the thing that
   * strands someone — and the stranded-state readout must not claim it did.
   */
  holdingAfter: string | null;
  /** Token whose allowance this leg sets (approve legs only). */
  token?: Address;
  spender?: Address;
  /** Amount this leg spends/deposits. */
  amount?: ZapAmount;
  /** Swap legs only. */
  route?: ZapSwapRoute;
  /** Swap legs only: the input is native ETH, so it travels as value, not transferFrom. */
  nativeIn?: boolean;
  /** add-liquidity only. */
  liquidity?: {
    token: Address;
    tokenAmount: ZapAmount;
    /** Fixed by construction — see the note on `measured`. */
    ethAmount: bigint;
    slippageBps: number;
  };
  /** staking-lock only. */
  lockDurationSeconds?: bigint;
}

export interface ZapPlan {
  /** Stable across a rebuild from the same descriptor. Persistence keys resume on it. */
  id: string;
  descriptor: ZapDescriptor;
  venue: ZapVenue;
  steps: ZapStepPlan[];
  /** Number of wallet confirmations on a batching wallet; legs.length without one. */
  stageCount: number;
  /**
   * Worst case across the whole zap, compounded over the legs that pass value along.
   * Not the sum, and never a single leg's figure — see `composeSlippageBps`.
   */
  composedSlippageBps: number;
  /** Constraints the user has to know BEFORE signing. Rendered verbatim. */
  notes: string[];
}

export type ZapRefusalCode =
  | 'venue-unavailable'
  | 'route-unavailable'
  | 'amount-invalid'
  | 'lock-duration-missing'
  | 'chain-mismatch';

export type ZapPlanResult =
  | { ok: true; plan: ZapPlan }
  | { ok: false; code: ZapRefusalCode; detail: string };

// ─── Slippage composition ───────────────────────────────────────────────────

const BPS = 10_000n;

/**
 * Compound the tolerances of legs that hand value to each other.
 *
 * Two 0.5% legs is not 1.0% — it is 1 - 0.995² = 0.9975%, and stating the sum would
 * overstate the risk while stating one leg's figure would understate it. Integer math
 * throughout, and the LOSS rounds up: a worst case that rounds in the user's favour is
 * not a worst case.
 *
 * Legs that run in PARALLEL off the same input (the two swap legs of an LP zap) do not
 * compound with each other — each touches a different half — so callers pass one chain
 * at a time and take the maximum.
 */
export function composeSlippageBps(legBps: readonly number[]): number {
  if (legBps.length === 0) return 0;
  let numerator = 1n;
  let denominator = 1n;
  for (const bps of legBps) {
    const clamped = BigInt(Math.max(0, Math.min(10_000, Math.trunc(bps))));
    numerator *= BPS - clamped;
    denominator *= BPS;
  }
  // Truncating the remaining fraction rounds the loss up.
  const remaining = (numerator * BPS) / denominator;
  return Number(BPS - remaining);
}

// ─── Planning ───────────────────────────────────────────────────────────────

function sameToken(a: Address, b: Address): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

/** Stable id: the descriptor that produced the plan, plus the shape it produced. */
function planId(d: ZapDescriptor, steps: readonly ZapStepPlan[]): string {
  return [
    'zap1',
    d.venueId,
    d.account.toLowerCase(),
    d.chainId,
    d.inputIsNative ? 'native' : d.inputToken.toLowerCase(),
    d.amountIn,
    d.slippageBps,
    d.lockDurationSeconds ?? '-',
    steps.map((s) => s.id).join('+'),
  ].join('|');
}

const HOLDING_INPUT = 'your input asset, untouched';

/**
 * A route quoted for a different size than the leg will spend is not a usable route.
 *
 * Its `minOut` is the floor that gets submitted, and a floor priced for a bigger trade
 * reverts the leg while a floor priced for a smaller one under-protects it. Neither is a
 * thing to paper over with a rescale — the caller re-quotes.
 */
function routeSizeMismatch(route: ZapSwapRoute, expected: bigint, leg: string): string | null {
  if (route.amountIn === expected) return null;
  return `The ${leg} route was quoted for ${route.amountIn} base units but this leg spends ${expected}. Refresh the quote.`;
}

/**
 * Build the plan, or say why not.
 *
 * Refusing is a first-class outcome. A down quote source is the case this is written for:
 * the caller passes `null` for the route it could not fetch and gets a refusal it can
 * render, instead of a plan carrying a zero floor that the wallet would happily sign.
 */
export function planZap(descriptor: ZapDescriptor, routes: ZapRoutes, expectedChainId: number): ZapPlanResult {
  if (descriptor.chainId !== expectedChainId) {
    return {
      ok: false,
      code: 'chain-mismatch',
      detail: `This zap was composed for chain ${descriptor.chainId}; the wallet is on ${expectedChainId}.`,
    };
  }

  const availability = venueAvailability(descriptor.venueId);
  if (!availability.available) {
    return { ok: false, code: 'venue-unavailable', detail: availability.reason };
  }
  const venue = availability.venue;

  let amountIn: bigint;
  try {
    amountIn = BigInt(descriptor.amountIn);
  } catch {
    return { ok: false, code: 'amount-invalid', detail: 'The input amount is not a whole number of base units.' };
  }
  if (amountIn <= 0n) {
    return { ok: false, code: 'amount-invalid', detail: 'The input amount is zero.' };
  }

  // The farm and the vault take the SAME asset — the vault's constructor asserts
  // `farm.stakingToken() == asset` — so they share every leg but the last two.
  return venue.id === 'staking-lock'
    ? planStakingLock(descriptor, routes, venue, amountIn)
    : planLpPosition(descriptor, routes, venue, amountIn);
}

function planStakingLock(
  d: ZapDescriptor,
  routes: ZapRoutes,
  venue: ZapVenue,
  amountIn: bigint,
): ZapPlanResult {
  if (!d.lockDurationSeconds || BigInt(d.lockDurationSeconds) <= 0n) {
    return { ok: false, code: 'lock-duration-missing', detail: 'A staking lock needs a lock duration.' };
  }
  const lockDurationSeconds = BigInt(d.lockDurationSeconds);
  const steps: ZapStepPlan[] = [];
  const notes: string[] = [];
  const inputIsTowelie = !d.inputIsNative && sameToken(d.inputToken, TOWELI_ADDRESS);

  let stage = 0;
  let stakeAmount: ZapAmount = { kind: 'fixed', value: amountIn };
  let slippageChain: number[] = [];

  if (!inputIsTowelie) {
    const route = routes.toTowelie;
    if (!route) {
      return {
        ok: false,
        code: 'route-unavailable',
        detail: `No live route from ${d.inputSymbol} to TOWELI right now, so the swap leg has no floor to submit.`,
      };
    }
    const mismatch = routeSizeMismatch(route, amountIn, `${d.inputSymbol}→TOWELI`);
    if (mismatch) return { ok: false, code: 'route-unavailable', detail: mismatch };
    if (!d.inputIsNative) {
      steps.push({
        id: 'approve-swap-towelie',
        stage,
        label: `Approve ${d.inputSymbol} for the swap`,
        kind: 'approve',
        holdingAfter: null,
        token: d.inputToken,
        spender: route.executor,
        amount: { kind: 'fixed', value: amountIn },
      });
    }
    steps.push({
      id: 'swap-towelie',
      stage,
      label: `Swap ${d.inputSymbol} for TOWELI`,
      kind: 'swap',
      holdingAfter: 'TOWELI in your wallet, not yet locked',
      route,
      nativeIn: d.inputIsNative,
    });
    stage += 1;
    stakeAmount = { kind: 'measured', key: 'towelie' };
    slippageChain = [route.slippageBps];
    notes.push(
      'The lock deposits the TOWELI this zap actually received, read from your balance after the swap — not the quoted figure.',
    );
  }

  steps.push({
    id: 'approve-staking',
    stage,
    label: 'Approve TOWELI for the staking lock',
    kind: 'approve',
    holdingAfter: null,
    token: TOWELI_ADDRESS,
    spender: TEGRIDY_STAKING_ADDRESS,
    amount: stakeAmount,
  });
  steps.push({
    id: 'staking-lock',
    stage,
    label: 'Lock TOWELI',
    kind: 'deposit',
    holdingAfter: venue.positionLabel,
    token: TOWELI_ADDRESS,
    spender: TEGRIDY_STAKING_ADDRESS,
    amount: stakeAmount,
    lockDurationSeconds,
  });

  return {
    ok: true,
    plan: {
      id: planId(d, steps),
      descriptor: d,
      venue,
      steps,
      stageCount: stage + 1,
      composedSlippageBps: composeSlippageBps(slippageChain),
      notes,
    },
  };
}

function planLpPosition(d: ZapDescriptor, routes: ZapRoutes, venue: ZapVenue, amountIn: bigint): ZapPlanResult {
  const steps: ZapStepPlan[] = [];
  const notes: string[] = [];
  const inputIsTowelie = !d.inputIsNative && sameToken(d.inputToken, TOWELI_ADDRESS);

  // Half by amount, not by value. The router prices the pair itself and refunds the side
  // it could not use, so an imperfect split costs the user a residue in their own wallet,
  // never a failed leg. `notes` says so before they sign.
  //
  // Only the side the user does NOT already hold gets swapped: a TOWELI input swaps half
  // to ETH, an ETH input swaps half to TOWELI, and anything else swaps both halves.
  const swapHalf = amountIn / 2n;
  const keptHalf = amountIn - swapHalf;
  const halfForTowelie = inputIsTowelie ? 0n : swapHalf;
  const halfForEth = inputIsTowelie ? swapHalf : d.inputIsNative ? 0n : keptHalf;

  const toweliRoute = inputIsTowelie ? null : routes.toTowelie;
  if (!inputIsTowelie && !toweliRoute) {
    return {
      ok: false,
      code: 'route-unavailable',
      detail: `No live route from ${d.inputSymbol} to TOWELI right now, so the swap leg has no floor to submit.`,
    };
  }
  const needsEthLeg = !d.inputIsNative;
  const ethRoute = needsEthLeg ? (routes.toEth ?? null) : null;
  if (needsEthLeg && !ethRoute) {
    return {
      ok: false,
      code: 'route-unavailable',
      detail: `No live route from ${d.inputSymbol} to ETH right now, so the pairing leg has no floor to submit.`,
    };
  }
  for (const [route, expected, leg] of [
    [toweliRoute, halfForTowelie, `${d.inputSymbol}→TOWELI`],
    [ethRoute, halfForEth, `${d.inputSymbol}→ETH`],
  ] as const) {
    if (!route) continue;
    const mismatch = routeSizeMismatch(route, expected, leg);
    if (mismatch) return { ok: false, code: 'route-unavailable', detail: mismatch };
  }

  // Stage 0 — every swap leg. Both spend a KNOWN amount of the input, so they can share
  // one confirmation even though they are two separate trades.
  const approvals: { spender: Address; amount: bigint }[] = [];
  if (toweliRoute && !d.inputIsNative) approvals.push({ spender: toweliRoute.executor, amount: halfForTowelie });
  if (ethRoute) approvals.push({ spender: ethRoute.executor, amount: halfForEth });

  // Two legs routed through the same executor need ONE allowance covering both, not two
  // that overwrite each other — the second `approve` would leave the first leg short.
  const merged = new Map<string, bigint>();
  for (const a of approvals) {
    const key = a.spender.toLowerCase();
    merged.set(key, (merged.get(key) ?? 0n) + a.amount);
  }
  let approveIndex = 0;
  for (const [spender, amount] of merged) {
    steps.push({
      id: approveIndex === 0 ? 'approve-swap-towelie' : 'approve-swap-eth',
      stage: 0,
      label: `Approve ${d.inputSymbol} for the swap`,
      kind: 'approve',
      holdingAfter: null,
      token: d.inputToken,
      spender: spender as Address,
      amount: { kind: 'fixed', value: amount },
    });
    approveIndex += 1;
  }

  if (toweliRoute) {
    steps.push({
      id: 'swap-towelie',
      stage: 0,
      label: `Swap half your ${d.inputSymbol} for TOWELI`,
      kind: 'swap',
      holdingAfter: 'TOWELI in your wallet, with nothing paired yet',
      route: toweliRoute,
      nativeIn: d.inputIsNative,
    });
  }
  if (ethRoute) {
    steps.push({
      id: 'swap-eth',
      stage: 0,
      label: `Swap half your ${d.inputSymbol} for ETH`,
      kind: 'swap',
      holdingAfter: 'TOWELI and ETH in your wallet, with nothing paired yet',
      route: ethRoute,
      nativeIn: false,
    });
  }

  const hasSwapStage = steps.some((s) => s.kind === 'swap');
  const liquidityStage = hasSwapStage ? 1 : 0;

  // The ETH side is a FIXED amount, never a measured one: the native balance also pays
  // gas, so its delta cannot tell a short fill apart from an expensive transaction.
  // A swap-sourced ETH side uses that leg's own submitted floor, which is the largest
  // amount the chain can guarantee arrived. Anything above it stays in the wallet.
  const ethAmount = ethRoute ? ethRoute.minOut : keptHalf;
  const tokenAmount: ZapAmount = toweliRoute
    ? { kind: 'measured', key: 'towelie' }
    : { kind: 'fixed', value: keptHalf };

  steps.push({
    id: 'approve-router',
    stage: liquidityStage,
    label: 'Approve TOWELI for the liquidity router',
    kind: 'approve',
    holdingAfter: null,
    token: TOWELI_ADDRESS,
    spender: TEGRIDY_ROUTER_ADDRESS,
    amount: tokenAmount,
  });
  steps.push({
    id: 'add-liquidity',
    stage: liquidityStage,
    label: 'Pair TOWELI with ETH',
    kind: 'add-liquidity',
    holdingAfter: 'LP tokens in your wallet, NOT staked in the farm',
    liquidity: {
      token: TOWELI_ADDRESS,
      tokenAmount,
      ethAmount,
      slippageBps: d.slippageBps,
    },
  });

  const depositStage = liquidityStage + 1;
  const lpAmount: ZapAmount = { kind: 'measured', key: 'lp' };
  const isVault = venue.id === 'compounder-vault';
  const destination = isVault ? venue.target : LP_FARMING_ADDRESS;
  steps.push({
    id: isVault ? 'approve-vault' : 'approve-farm',
    stage: depositStage,
    label: isVault ? 'Approve LP for the vault' : 'Approve LP for the farm',
    kind: 'approve',
    holdingAfter: null,
    token: TEGRIDY_LP_ADDRESS,
    spender: destination,
    amount: lpAmount,
  });
  steps.push({
    id: isVault ? 'vault-deposit' : 'farm-stake',
    stage: depositStage,
    label: isVault ? 'Deposit LP into the vault' : 'Stake LP in the farm',
    kind: 'deposit',
    holdingAfter: venue.positionLabel,
    token: TEGRIDY_LP_ADDRESS,
    spender: destination,
    amount: lpAmount,
  });

  notes.push(
    'Your input is split in half by amount. The router prices the pair itself and returns whatever it cannot use, so a leftover of TOWELI or ETH stays in your wallet — it is not lost, and it is not staked either.',
  );
  if (hasSwapStage) {
    notes.push(
      'The liquidity leg pairs the TOWELI this zap actually received, read from your balance after the swap — not the quoted figure.',
    );
  }
  notes.push(
    `${isVault ? 'The vault takes' : 'The farm stakes'} the LP this zap actually minted, read from your balance after the liquidity leg.`,
  );

  // Worst case runs down one chain at a time: a swap hands value to the liquidity leg,
  // and both swap legs carry the same tolerance, so either chain gives the same answer.
  const swapBps = toweliRoute?.slippageBps ?? ethRoute?.slippageBps ?? 0;
  const chain = hasSwapStage ? [swapBps, d.slippageBps] : [d.slippageBps];

  return {
    ok: true,
    plan: {
      id: planId(d, steps),
      descriptor: d,
      venue,
      steps,
      stageCount: depositStage + 1,
      composedSlippageBps: composeSlippageBps(chain),
      notes,
    },
  };
}

/** The legs of one stage, in order. */
export function stageSteps(plan: ZapPlan, stage: number): { step: ZapStepPlan; index: number }[] {
  return plan.steps
    .map((step, index) => ({ step, index }))
    .filter((e) => e.step.stage === stage);
}

/** What the user holds before anything has happened. */
export const ZAP_INITIAL_HOLDING = HOLDING_INPUT;
