import { describe, it, expect } from 'vitest';
import { composeSlippageBps, planZap, stageSteps, type ZapDescriptor, type ZapRoutes } from './planner';
import {
  LP_FARMING_ADDRESS,
  SWAP_FEE_ROUTER_ADDRESS,
  TEGRIDY_LP_ADDRESS,
  TEGRIDY_ROUTER_ADDRESS,
  TEGRIDY_STAKING_ADDRESS,
  TOWELI_ADDRESS,
  UNISWAP_V2_ROUTER,
  WETH_ADDRESS,
} from '../constants';

const ACCOUNT = '0x1111111111111111111111111111111111111111' as const;
const USDC = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48' as const;
const ONE_ETH = 10n ** 18n;

function descriptor(over: Partial<ZapDescriptor> = {}): ZapDescriptor {
  return {
    venueId: 'lp-farm',
    account: ACCOUNT,
    chainId: 1,
    inputToken: WETH_ADDRESS,
    inputSymbol: 'ETH',
    inputIsNative: true,
    amountIn: ONE_ETH.toString(),
    slippageBps: 50,
    ...over,
  };
}

function route(amountIn: bigint, over: Partial<ZapRoutes['toTowelie'] & object> = {}) {
  return {
    executor: SWAP_FEE_ROUTER_ADDRESS,
    executorTakesMaxFee: true,
    amountIn,
    minOut: 1n,
    path: [WETH_ADDRESS, TOWELI_ADDRESS] as const,
    slippageBps: 50,
    ...over,
  };
}

describe('composeSlippageBps', () => {
  it('compounds rather than adding — two 50 bps legs are 99.75 bps, not 100', () => {
    expect(composeSlippageBps([50, 50])).toBe(100);
    // The exact remaining fraction is 0.995² = 0.990025, i.e. 9900.25 bps kept. Truncating
    // the KEPT side to 9900 rounds the loss up to 100, which is the direction a worst case
    // is allowed to round.
    expect(composeSlippageBps([50])).toBe(50);
    expect(composeSlippageBps([])).toBe(0);
  });

  it('rounds the loss up, never down', () => {
    // 3 × 10 bps: kept = 0.999³ = 0.997002999 → 9970.02 bps → truncated to 9970 → loss 30.
    expect(composeSlippageBps([10, 10, 10])).toBe(30);
    // A tolerance too small to register on its own still cannot reduce the composed figure.
    expect(composeSlippageBps([50, 0])).toBe(50);
  });

  it('clamps nonsense instead of propagating it', () => {
    expect(composeSlippageBps([-100])).toBe(0);
    expect(composeSlippageBps([99_999])).toBe(10_000);
  });
});

describe('planZap — refusals', () => {
  it('refuses when the swap route is missing rather than planning a floorless leg', () => {
    const result = planZap(descriptor({ venueId: 'staking-lock', lockDurationSeconds: '100' }), { toTowelie: null }, 1);
    expect(result).toMatchObject({ ok: false, code: 'route-unavailable' });
    expect((result as { detail: string }).detail).toMatch(/no floor to submit/);
  });

  it('refuses a staking lock with no duration', () => {
    const result = planZap(descriptor({ venueId: 'staking-lock' }), { toTowelie: route(ONE_ETH) }, 1);
    expect(result).toMatchObject({ ok: false, code: 'lock-duration-missing' });
  });

  it('refuses a zero or unparseable amount', () => {
    expect(planZap(descriptor({ amountIn: '0' }), { toTowelie: route(0n) }, 1)).toMatchObject({
      ok: false,
      code: 'amount-invalid',
    });
    expect(planZap(descriptor({ amountIn: 'lots' }), { toTowelie: route(0n) }, 1)).toMatchObject({
      ok: false,
      code: 'amount-invalid',
    });
  });

  it('refuses when the wallet is on another chain', () => {
    expect(planZap(descriptor(), { toTowelie: route(ONE_ETH / 2n) }, 8453)).toMatchObject({
      ok: false,
      code: 'chain-mismatch',
    });
  });

  it('refuses a route quoted for a different size, instead of rescaling its floor', () => {
    const result = planZap(descriptor(), { toTowelie: route(ONE_ETH) }, 1);
    expect(result).toMatchObject({ ok: false, code: 'route-unavailable' });
    expect((result as { detail: string }).detail).toMatch(/Refresh the quote/);
  });
});

describe('planZap — ETH into the LP farm', () => {
  const result = planZap(descriptor(), { toTowelie: route(ONE_ETH / 2n) }, 1);
  const plan = result.ok ? result.plan : null;

  it('plans one swap leg, because the ETH side is already ETH', () => {
    expect(plan).not.toBeNull();
    expect(plan!.steps.filter((s) => s.kind === 'swap')).toHaveLength(1);
  });

  it('groups the legs into three stages, each bounded by an amount it cannot know early', () => {
    expect(plan!.stageCount).toBe(3);
    expect(stageSteps(plan!, 0).map((e) => e.step.id)).toEqual(['swap-towelie']);
    expect(stageSteps(plan!, 1).map((e) => e.step.id)).toEqual(['approve-router', 'add-liquidity']);
    expect(stageSteps(plan!, 2).map((e) => e.step.id)).toEqual(['approve-farm', 'farm-stake']);
  });

  it('measures the TOWELI side and fixes the ETH side', () => {
    const liq = plan!.steps.find((s) => s.id === 'add-liquidity')!.liquidity!;
    expect(liq.tokenAmount).toEqual({ kind: 'measured', key: 'towelie' });
    // The unswapped half, exactly. Not a measured native balance — that also pays gas.
    expect(liq.ethAmount).toBe(ONE_ETH - ONE_ETH / 2n);
  });

  it('states the composed worst case, not one leg s figure', () => {
    expect(plan!.composedSlippageBps).toBe(100);
    expect(plan!.composedSlippageBps).toBeGreaterThan(descriptor().slippageBps);
  });

  it('warns that the residue stays in the wallet, before anything is signed', () => {
    expect(plan!.notes.join(' ')).toMatch(/stays in your wallet/);
    expect(plan!.notes.join(' ')).toMatch(/not staked/);
  });

  it('targets only hard-coded venue addresses', () => {
    const targets = plan!.steps.map((s) => s.spender ?? s.route?.executor ?? TEGRIDY_ROUTER_ADDRESS);
    for (const t of targets) {
      expect([
        SWAP_FEE_ROUTER_ADDRESS,
        UNISWAP_V2_ROUTER,
        TEGRIDY_ROUTER_ADDRESS,
        LP_FARMING_ADDRESS,
        TEGRIDY_STAKING_ADDRESS,
      ].map((a) => a.toLowerCase())).toContain(t.toLowerCase());
    }
  });

  it('names an unstaked-LP holding on the liquidity leg, so a stop there reads honestly', () => {
    const liqStep = plan!.steps.find((s) => s.id === 'add-liquidity')!;
    expect(liqStep.holdingAfter).toMatch(/NOT staked/);
    // Approvals move nothing and must never be able to claim a holding.
    for (const step of plan!.steps.filter((s) => s.kind === 'approve')) {
      expect(step.holdingAfter).toBeNull();
    }
  });
});

describe('planZap — an ERC20 into the LP farm', () => {
  const d = descriptor({ inputToken: USDC, inputSymbol: 'USDC', inputIsNative: false, amountIn: '1000000' });
  const result = planZap(
    d,
    {
      toTowelie: route(500_000n, { executor: SWAP_FEE_ROUTER_ADDRESS, path: [USDC, WETH_ADDRESS, TOWELI_ADDRESS] }),
      toEth: route(500_000n, {
        executor: UNISWAP_V2_ROUTER,
        executorTakesMaxFee: false,
        path: [USDC, WETH_ADDRESS],
        minOut: 10n ** 15n,
      }),
    },
    1,
  );
  const plan = result.ok ? result.plan : null;

  it('plans both swap legs into ONE stage — both spend a known amount of the input', () => {
    expect(plan).not.toBeNull();
    expect(stageSteps(plan!, 0).map((e) => e.step.id)).toEqual([
      'approve-swap-towelie',
      'approve-swap-eth',
      'swap-towelie',
      'swap-eth',
    ]);
    expect(plan!.stageCount).toBe(3);
  });

  it('takes the ETH side from the swap floor, which is the amount the chain guarantees', () => {
    const liq = plan!.steps.find((s) => s.id === 'add-liquidity')!.liquidity!;
    expect(liq.ethAmount).toBe(10n ** 15n);
  });

  it('merges two legs on the same executor into one allowance, not two that overwrite', () => {
    const same = planZap(
      d,
      {
        toTowelie: route(500_000n, { path: [USDC, WETH_ADDRESS, TOWELI_ADDRESS] }),
        toEth: route(500_000n, { path: [USDC, WETH_ADDRESS], minOut: 10n ** 15n }),
      },
      1,
    );
    expect(same.ok).toBe(true);
    const approvals = same.ok ? same.plan.steps.filter((s) => s.kind === 'approve' && s.stage === 0) : [];
    expect(approvals).toHaveLength(1);
    expect(approvals[0]!.amount).toEqual({ kind: 'fixed', value: 1_000_000n });
  });
});

describe('planZap — TOWELI into the staking lock', () => {
  it('plans no swap at all, and no measurement to go with it', () => {
    const result = planZap(
      descriptor({
        venueId: 'staking-lock',
        inputToken: TOWELI_ADDRESS,
        inputSymbol: 'TOWELI',
        inputIsNative: false,
        lockDurationSeconds: '7776000',
      }),
      { toTowelie: null },
      1,
    );
    expect(result.ok).toBe(true);
    const plan = result.ok ? result.plan : null;
    expect(plan!.steps.map((s) => s.id)).toEqual(['approve-staking', 'staking-lock']);
    expect(plan!.stageCount).toBe(1);
    expect(plan!.composedSlippageBps).toBe(0);
    expect(plan!.steps.every((s) => s.amount?.kind === 'fixed')).toBe(true);
  });
});

describe('planZap — TOWELI into the LP farm', () => {
  it('swaps only the half it needs to pair, and keeps the other half fixed', () => {
    const result = planZap(
      descriptor({
        inputToken: TOWELI_ADDRESS,
        inputSymbol: 'TOWELI',
        inputIsNative: false,
        amountIn: (100n * ONE_ETH).toString(),
      }),
      {
        toTowelie: null,
        toEth: route(50n * ONE_ETH, {
          executor: UNISWAP_V2_ROUTER,
          executorTakesMaxFee: false,
          path: [TOWELI_ADDRESS, WETH_ADDRESS],
          minOut: ONE_ETH / 10n,
        }),
      },
      1,
    );
    expect(result.ok).toBe(true);
    const plan = result.ok ? result.plan : null;
    expect(plan!.steps.filter((s) => s.kind === 'swap').map((s) => s.id)).toEqual(['swap-eth']);
    const liq = plan!.steps.find((s) => s.id === 'add-liquidity')!.liquidity!;
    expect(liq.tokenAmount).toEqual({ kind: 'fixed', value: 50n * ONE_ETH });
    expect(liq.ethAmount).toBe(ONE_ETH / 10n);
  });
});

describe('the plan id', () => {
  it('is stable for the same request and different for a different one', () => {
    const a = planZap(descriptor(), { toTowelie: route(ONE_ETH / 2n) }, 1);
    const b = planZap(descriptor(), { toTowelie: route(ONE_ETH / 2n) }, 1);
    const c = planZap(descriptor({ amountIn: (2n * ONE_ETH).toString() }), { toTowelie: route(ONE_ETH) }, 1);
    expect(a.ok && b.ok && a.plan.id === b.plan.id).toBe(true);
    expect(a.ok && c.ok && a.plan.id === c.plan.id).toBe(false);
  });
});

describe('the LP token this venue stakes', () => {
  it('is the native pair, not the Uniswap one', () => {
    const result = planZap(descriptor(), { toTowelie: route(ONE_ETH / 2n) }, 1);
    const farmStep = result.ok ? result.plan.steps.find((s) => s.id === 'farm-stake') : null;
    expect(farmStep!.token!.toLowerCase()).toBe(TEGRIDY_LP_ADDRESS.toLowerCase());
  });
});
