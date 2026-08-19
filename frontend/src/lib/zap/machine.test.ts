// The interrupted paths.
//
// The happy path of a zap is the case that needs the least proof: if every leg confirms,
// almost any implementation looks right. What this file pins is the set of endings where a
// wrong answer costs money — a run that stopped, a run whose outcome was never read, a
// resume that must not repeat a leg, and a record written by a tab that no longer agrees
// with this one.

import { describe, it, expect } from 'vitest';
import {
  applyZapEvent,
  confirmedSteps,
  initialRunState,
  pendingStepsOfStage,
  strandedHolding,
  zapProgress,
  zapReadout,
  zapResume,
  type ZapEvent,
  type ZapRunState,
} from './machine';
import { planZap, type ZapDescriptor, type ZapPlan, type ZapRoutes } from './planner';
import { TEGRIDY_ROUTER_ADDRESS, TOWELI_ADDRESS, WETH_ADDRESS } from '../constants';

const ACCOUNT = '0x1111111111111111111111111111111111111111' as const;
const USDC = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48' as const;
const T = 1_700_000_000_000;

function ethToLpFarmPlan(): ZapPlan {
  const descriptor: ZapDescriptor = {
    venueId: 'lp-farm',
    account: ACCOUNT,
    chainId: 1,
    inputToken: WETH_ADDRESS,
    inputSymbol: 'ETH',
    inputIsNative: true,
    amountIn: (10n ** 18n).toString(),
    slippageBps: 50,
  };
  const routes: ZapRoutes = {
    toTowelie: {
      executor: TEGRIDY_ROUTER_ADDRESS,
      executorTakesMaxFee: true,
      amountIn: 10n ** 18n / 2n,
      minOut: 400n * 10n ** 18n,
      path: [WETH_ADDRESS, TOWELI_ADDRESS],
      slippageBps: 50,
    },
  };
  const result = planZap(descriptor, routes, 1);
  if (!result.ok) throw new Error(`fixture plan refused: ${result.code} ${result.detail}`);
  return result.plan;
}

function usdcToStakingLockPlan(): ZapPlan {
  const descriptor: ZapDescriptor = {
    venueId: 'staking-lock',
    account: ACCOUNT,
    chainId: 1,
    inputToken: USDC,
    inputSymbol: 'USDC',
    inputIsNative: false,
    amountIn: '1000000000',
    slippageBps: 50,
    lockDurationSeconds: '7776000',
  };
  const routes: ZapRoutes = {
    toTowelie: {
      executor: TEGRIDY_ROUTER_ADDRESS,
      executorTakesMaxFee: true,
      amountIn: 1_000_000_000n,
      minOut: 10n ** 21n,
      path: [USDC, WETH_ADDRESS, TOWELI_ADDRESS],
      slippageBps: 50,
    },
  };
  const result = planZap(descriptor, routes, 1);
  if (!result.ok) throw new Error(`fixture plan refused: ${result.code} ${result.detail}`);
  return result.plan;
}

function fresh(plan: ZapPlan): ZapRunState {
  return initialRunState(plan, { towelie: 0n, lp: 0n }, T);
}

function fold(state: ZapRunState, events: ZapEvent[]): ZapRunState {
  return events.reduce(applyZapEvent, state);
}

/** Confirm every leg of `stage`, the way a clean run of that stage would. */
function confirmStage(state: ZapRunState, plan: ZapPlan, stage: number, hash: string): ZapRunState {
  const steps = pendingStepsOfStage(state, plan, stage);
  return fold(state, [
    { type: 'submitted', steps, txHash: hash, at: T + 1 },
    { type: 'confirmed', steps, txHash: hash, at: T + 2 },
  ]);
}

describe('the plan a zap run is folded over', () => {
  it('splits an ETH → LP-farm zap into three confirmations, not five transactions', () => {
    const plan = ethToLpFarmPlan();
    expect(plan.stageCount).toBe(3);
    expect(plan.steps.map((s) => s.id)).toEqual([
      'swap-towelie',
      'approve-router',
      'add-liquidity',
      'approve-farm',
      'farm-stake',
    ]);
  });
});

describe('a run that finishes', () => {
  it('is the only shape that reports success', () => {
    const plan = ethToLpFarmPlan();
    let state = fresh(plan);
    for (let stage = 0; stage < plan.stageCount; stage++) {
      state = confirmStage(state, plan, stage, `0xstage${stage}`);
    }
    const readout = zapReadout(state, plan);
    expect(zapProgress(state)).toEqual({ kind: 'complete' });
    expect(readout.isComplete).toBe(true);
    expect(readout.tone).toBe('success');
    expect(zapResume(state)).toEqual({ kind: 'nothing-to-resume' });
  });

  it('reports success with an approval skipped, because a skip settles the leg', () => {
    const plan = usdcToStakingLockPlan();
    let state = fresh(plan);
    state = applyZapEvent(state, { type: 'skipped', steps: [0], detail: 'allowance covers it', at: T });
    state = confirmStage(state, plan, 0, '0xswap');
    state = confirmStage(state, plan, 1, '0xlock');
    expect(zapReadout(state, plan).isComplete).toBe(true);
  });
});

describe('a run that stops part-way', () => {
  it('never reports success, and names what the user is holding', () => {
    const plan = ethToLpFarmPlan();
    let state = fresh(plan);
    state = confirmStage(state, plan, 0, '0xswap');
    state = confirmStage(state, plan, 1, '0xliq');
    // The farm leg reverts. The user now holds LP that is not staked.
    const farmSteps = pendingStepsOfStage(state, plan, 2);
    state = fold(state, [
      { type: 'submitted', steps: [farmSteps[0]!], txHash: '0xapprove', at: T + 3 },
      { type: 'confirmed', steps: [farmSteps[0]!], txHash: '0xapprove', at: T + 4 },
      { type: 'submitted', steps: [farmSteps[1]!], txHash: '0xstake', at: T + 5 },
      { type: 'reverted', steps: [farmSteps[1]!], txHash: '0xstake', detail: 'MIN_STAKE', at: T + 6 },
    ]);

    const readout = zapReadout(state, plan);
    expect(readout.isComplete).toBe(false);
    expect(readout.tone).toBe('warning');
    expect(readout.headline).not.toMatch(/complete/i);
    expect(readout.holding).toMatch(/LP tokens in your wallet, NOT staked/);
  });

  it('resumes at the leg that stopped, and at no earlier one', () => {
    const plan = ethToLpFarmPlan();
    let state = fresh(plan);
    state = confirmStage(state, plan, 0, '0xswap');
    const liqSteps = pendingStepsOfStage(state, plan, 1);
    state = fold(state, [
      { type: 'confirmed', steps: [liqSteps[0]!], txHash: '0xapprove', at: T + 3 },
      { type: 'rejected', steps: [liqSteps[1]!], detail: 'user rejected', at: T + 4 },
    ]);

    const resume = zapResume(state);
    expect(resume).toEqual({ kind: 'resume', fromStep: liqSteps[1] });
    // Everything before it is settled — a resume cannot repeat a confirmed leg.
    for (let i = 0; i < (resume as { fromStep: number }).fromStep; i++) {
      expect(['confirmed', 'skipped']).toContain(state.steps[i]!.status);
    }
  });

  it('treats an interrupted-between-stages run as not-sent, not as a failure', () => {
    const plan = ethToLpFarmPlan();
    let state = fresh(plan);
    state = confirmStage(state, plan, 0, '0xswap');
    const progress = zapProgress(state);
    expect(progress).toEqual({ kind: 'stopped', step: 1, reason: 'not-sent' });
    expect(zapReadout(state, plan).detail).toMatch(/never sent/);
    expect(zapResume(state)).toEqual({ kind: 'resume', fromStep: 1 });
  });
});

describe('a leg whose outcome was never read', () => {
  it('is not a failure, is not a success, and blocks the resume', () => {
    const plan = ethToLpFarmPlan();
    let state = fresh(plan);
    state = fold(state, [
      { type: 'submitted', steps: [0], txHash: '0xswap', at: T + 1 },
      { type: 'lost', steps: [0], detail: 'the tab was closed', at: T + 2 },
    ]);

    expect(state.steps[0]!.status).toBe('unknown');
    expect(zapProgress(state)).toEqual({ kind: 'needs-verification', step: 0 });

    const resume = zapResume(state);
    expect(resume.kind).toBe('blocked');
    expect((resume as { txHash?: string }).txHash).toBe('0xswap');
    expect((resume as { reason: string }).reason).toMatch(/may already have gone through/i);

    const readout = zapReadout(state, plan);
    expect(readout.isComplete).toBe(false);
    expect(readout.isBlocked).toBe(true);
    expect(readout.tone).toBe('danger');
  });

  it('does not contribute its holding — the holding is the thing in question', () => {
    const plan = ethToLpFarmPlan();
    let state = fresh(plan);
    state = fold(state, [
      { type: 'submitted', steps: [0], txHash: '0xswap', at: T + 1 },
      { type: 'lost', steps: [0], detail: 'RPC dropped', at: T + 2 },
    ]);
    expect(strandedHolding(state, plan)).toBe('your input asset, untouched');
  });

  it('clears once a receipt is finally read, and only then resumes', () => {
    const plan = ethToLpFarmPlan();
    let state = fresh(plan);
    state = fold(state, [
      { type: 'submitted', steps: [0], txHash: '0xswap', at: T + 1 },
      { type: 'lost', steps: [0], detail: 'the tab was closed', at: T + 2 },
    ]);
    expect(zapResume(state).kind).toBe('blocked');

    state = applyZapEvent(state, { type: 'observed', step: 0, outcome: 'confirmed', at: T + 9 });
    expect(state.steps[0]!.status).toBe('confirmed');
    expect(zapResume(state)).toEqual({ kind: 'resume', fromStep: 1 });
  });

  it('resumes from the unknown leg itself once it is observed to have reverted', () => {
    const plan = ethToLpFarmPlan();
    let state = fresh(plan);
    state = fold(state, [
      { type: 'submitted', steps: [0], txHash: '0xswap', at: T + 1 },
      { type: 'lost', steps: [0], detail: 'the tab was closed', at: T + 2 },
      { type: 'observed', step: 0, outcome: 'reverted', at: T + 9 },
    ]);
    expect(zapResume(state)).toEqual({ kind: 'resume', fromStep: 0 });
  });

  it('blocks a resume even when the legs AFTER it would be fine', () => {
    // The dangerous shape: leg 0 unread, so nothing downstream may run — its input amount
    // is leg 0's output, and running it would either revert or deposit the wrong size.
    const plan = ethToLpFarmPlan();
    let state = fresh(plan);
    state = fold(state, [
      { type: 'submitted', steps: [0], txHash: '0xswap', at: T + 1 },
      { type: 'lost', steps: [0], detail: 'lost', at: T + 2 },
    ]);
    expect(zapResume(state).kind).toBe('blocked');
    expect(zapProgress(state).kind).not.toBe('complete');
  });
});

describe('the reducer refuses events it cannot honour', () => {
  it('never moves a confirmed leg — the chain does not take things back', () => {
    const plan = ethToLpFarmPlan();
    let state = fresh(plan);
    state = confirmStage(state, plan, 0, '0xswap');
    const before = state.steps[0]!;
    for (const event of [
      { type: 'reverted', steps: [0], detail: 'late error', at: T + 50 },
      { type: 'rejected', steps: [0], detail: 'late reject', at: T + 51 },
      { type: 'lost', steps: [0], detail: 'late loss', at: T + 52 },
      { type: 'skipped', steps: [0], detail: 'late skip', at: T + 53 },
    ] satisfies ZapEvent[]) {
      state = applyZapEvent(state, event);
    }
    expect(state.steps[0]).toEqual(before);
  });

  it('never marks a pending leg unknown — a leg that was never sent has nothing to fear', () => {
    const plan = ethToLpFarmPlan();
    const state = applyZapEvent(fresh(plan), { type: 'lost', steps: [2], detail: 'lost', at: T + 1 });
    expect(state.steps[2]!.status).toBe('pending');
    expect(zapResume(state)).toEqual({ kind: 'resume', fromStep: 0 });
  });

  it('ignores a rejection once a hash exists — that reject is about a later prompt', () => {
    const plan = ethToLpFarmPlan();
    let state = applyZapEvent(fresh(plan), { type: 'submitted', steps: [0], txHash: '0xswap', at: T + 1 });
    state = applyZapEvent(state, { type: 'rejected', steps: [0], detail: 'user rejected', at: T + 2 });
    expect(state.steps[0]!.status).toBe('submitted');
  });

  it('ignores out-of-range indexes rather than growing the run', () => {
    const plan = ethToLpFarmPlan();
    const state = applyZapEvent(fresh(plan), { type: 'confirmed', steps: [99, -1], at: T + 1 });
    expect(state.steps).toHaveLength(plan.steps.length);
    expect(confirmedSteps(state)).toEqual([]);
  });

  it('returns the same object when nothing changed, so callers can trust identity', () => {
    const plan = ethToLpFarmPlan();
    const state = fresh(plan);
    expect(applyZapEvent(state, { type: 'confirmed', steps: [], at: T + 1 })).toBe(state);
  });

  it('does not mutate the state it was handed', () => {
    const plan = ethToLpFarmPlan();
    const state = fresh(plan);
    const snapshot = JSON.stringify(state);
    applyZapEvent(state, { type: 'confirmed', steps: [0], txHash: '0xswap', at: T + 1 });
    expect(JSON.stringify(state)).toBe(snapshot);
  });
});

describe('a record that disagrees with itself', () => {
  it('does NOT count a skipped leg sitting in front of a pending one', () => {
    // The ordinary shape of a stage mid-bind: its second approval was already covered by
    // an allowance while its first has not been signed yet. Nothing was sent out of order.
    const plan = ethToLpFarmPlan();
    const stage2 = [3, 4];
    let state = fresh(plan);
    state = confirmStage(state, plan, 0, '0xswap');
    state = confirmStage(state, plan, 1, '0xliq');
    state = applyZapEvent(state, { type: 'skipped', steps: [stage2[0]!], detail: 'covered', at: T });
    expect(zapProgress(state).kind).not.toBe('inconsistent');
    expect(zapResume(state)).toEqual({ kind: 'resume', fromStep: stage2[1] });
  });

  it('is reported as inconsistent and never resumed', () => {
    const plan = ethToLpFarmPlan();
    // Leg 0 pending while leg 2 confirmed — only two tabs, or a restore across a plan
    // change, can produce this. Either way the run cannot be continued from it.
    const state = applyZapEvent(fresh(plan), { type: 'confirmed', steps: [2], txHash: '0xliq', at: T + 1 });
    const progress = zapProgress(state);
    expect(progress.kind).toBe('inconsistent');
    expect(zapResume(state).kind).toBe('blocked');
    const readout = zapReadout(state, plan);
    expect(readout.isComplete).toBe(false);
    expect(readout.tone).toBe('danger');
  });
});

describe('a batch that partially executes', () => {
  it('records only the legs the wallet actually reported, leaving the rest resumable', () => {
    // EIP-5792 with atomicRequired false may execute part of a batch. The confirmed set
    // comes from the per-call receipts, so the unreported leg stays exactly where it was.
    const plan = usdcToStakingLockPlan();
    let state = fresh(plan);
    const stage1 = pendingStepsOfStage(state, plan, 1);
    state = confirmStage(state, plan, 0, '0xswap');
    state = fold(state, [
      { type: 'submitted', steps: stage1, batchId: '0xbatch', at: T + 3 },
      { type: 'confirmed', steps: [stage1[0]!], txHash: '0xapprove', at: T + 4 },
      { type: 'reverted', steps: [stage1[1]!], txHash: '0xlock', detail: 'paused', at: T + 5 },
    ]);
    expect(zapReadout(state, plan).isComplete).toBe(false);
    expect(zapResume(state)).toEqual({ kind: 'resume', fromStep: stage1[1] });
  });

  it('marks every leg of a lost batch unknown, so none of them is retried blindly', () => {
    const plan = usdcToStakingLockPlan();
    let state = fresh(plan);
    const stage1 = pendingStepsOfStage(state, plan, 1);
    state = confirmStage(state, plan, 0, '0xswap');
    state = fold(state, [
      { type: 'submitted', steps: stage1, batchId: '0xbatch', at: T + 3 },
      { type: 'lost', steps: stage1, detail: 'wallet_getCallsStatus never answered', at: T + 4 },
    ]);
    expect(state.steps[stage1[0]!]!.status).toBe('unknown');
    expect(state.steps[stage1[1]!]!.status).toBe('unknown');
    expect(zapResume(state).kind).toBe('blocked');
  });
});

describe('pendingStepsOfStage', () => {
  it('never offers a leg that already settled', () => {
    const plan = usdcToStakingLockPlan();
    const state = applyZapEvent(fresh(plan), { type: 'skipped', steps: [0], detail: 'covered', at: T });
    expect(pendingStepsOfStage(state, plan, 0)).toEqual([1]);
  });
});
