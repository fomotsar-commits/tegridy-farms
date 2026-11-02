import { describe, it, expect } from 'vitest';
import { decodeFunctionData } from 'viem';
import { bindZapStep, type ZapBalances } from './calls';
import { planZap, type ZapDescriptor, type ZapRoutes } from './planner';
import {
  ERC20_ABI,
  LP_FARMING_ABI,
  SWAP_FEE_ROUTER_ABI,
  TEGRIDY_ROUTER_ABI,
  TEGRIDY_STAKING_ABI,
  UNISWAP_V2_ROUTER_ABI,
} from '../contracts';
import {
  LP_FARMING_ADDRESS,
  SWAP_FEE_ROUTER_ADDRESS,
  TEGRIDY_ROUTER_ADDRESS,
  TEGRIDY_STAKING_ADDRESS,
  TOWELI_ADDRESS,
  UNISWAP_V2_ROUTER,
  WETH_ADDRESS,
} from '../constants';

const ACCOUNT = '0x1111111111111111111111111111111111111111' as const;
const USDC = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48' as const;
const ONE_ETH = 10n ** 18n;
const NOW = 1_700_000_000;

function lpFarmPlan() {
  const d: ZapDescriptor = {
    venueId: 'lp-farm',
    account: ACCOUNT,
    chainId: 1,
    inputToken: WETH_ADDRESS,
    inputSymbol: 'ETH',
    inputIsNative: true,
    amountIn: ONE_ETH.toString(),
    slippageBps: 50,
  };
  const routes: ZapRoutes = {
    toTowelie: {
      executor: SWAP_FEE_ROUTER_ADDRESS,
      executorTakesMaxFee: true,
      amountIn: ONE_ETH / 2n,
      minOut: 400n * ONE_ETH,
      path: [WETH_ADDRESS, TOWELI_ADDRESS],
      slippageBps: 50,
    },
  };
  const r = planZap(d, routes, 1);
  if (!r.ok) throw new Error(r.detail);
  return r.plan;
}

const NOTHING: ZapBalances = { baseline: {}, current: {} };

describe('a measured leg refuses to bind until the previous leg has produced something', () => {
  it('blocks rather than encoding a zero-amount deposit', () => {
    const plan = lpFarmPlan();
    const stake = plan.steps.find((s) => s.id === 'farm-stake')!;
    expect(bindZapStep(stake, ACCOUNT, NOTHING, NOW)).toMatchObject({ kind: 'blocked' });
    expect(
      bindZapStep(stake, ACCOUNT, { baseline: { lp: 5n }, current: { lp: 5n } }, NOW),
    ).toMatchObject({ kind: 'blocked' });
  });

  it('deposits the DELTA, so a pre-existing balance is never swept in', () => {
    const plan = lpFarmPlan();
    const stake = plan.steps.find((s) => s.id === 'farm-stake')!;
    // The user held 100 LP before starting and the zap minted 7.
    const bound = bindZapStep(stake, ACCOUNT, { baseline: { lp: 100n }, current: { lp: 107n } }, NOW);
    expect(bound.kind).toBe('call');
    const call = (bound as { call: { to: string; data: `0x${string}` } }).call;
    expect(call.to.toLowerCase()).toBe(LP_FARMING_ADDRESS.toLowerCase());
    const decoded = decodeFunctionData({ abi: LP_FARMING_ABI, data: call.data });
    expect(decoded.functionName).toBe('stake');
    expect(decoded.args).toEqual([7n]);
  });

  it('blocks when the balance could not be read at all, rather than assuming zero', () => {
    const plan = lpFarmPlan();
    const stake = plan.steps.find((s) => s.id === 'farm-stake')!;
    const bound = bindZapStep(stake, ACCOUNT, { baseline: { lp: 0n }, current: {} }, NOW);
    expect(bound).toMatchObject({ kind: 'blocked' });
    expect((bound as { reason: string }).reason).toMatch(/could not be read/);
  });
});

describe('approvals', () => {
  it('skip only on a KNOWN sufficient allowance', () => {
    const plan = lpFarmPlan();
    const approve = plan.steps.find((s) => s.id === 'approve-router')!;
    const balances: ZapBalances = { baseline: { towelie: 0n }, current: { towelie: 500n } };

    // Unknown allowance → never assumed sufficient.
    expect(bindZapStep(approve, ACCOUNT, balances, NOW).kind).toBe('call');

    const key = `${TOWELI_ADDRESS.toLowerCase()}:${TEGRIDY_ROUTER_ADDRESS.toLowerCase()}`;
    expect(
      bindZapStep(approve, ACCOUNT, { ...balances, allowances: { [key]: 499n } }, NOW).kind,
    ).toBe('call');
    expect(
      bindZapStep(approve, ACCOUNT, { ...balances, allowances: { [key]: 500n } }, NOW).kind,
    ).toBe('skip');
  });

  it('approves exactly the measured amount, not an unlimited allowance', () => {
    const plan = lpFarmPlan();
    const approve = plan.steps.find((s) => s.id === 'approve-farm')!;
    const bound = bindZapStep(approve, ACCOUNT, { baseline: { lp: 0n }, current: { lp: 42n } }, NOW);
    const decoded = decodeFunctionData({
      abi: ERC20_ABI,
      data: (bound as { call: { data: `0x${string}` } }).call.data,
    });
    expect(decoded.args).toEqual([LP_FARMING_ADDRESS, 42n]);
  });
});

describe('the swap leg', () => {
  it('refuses to send without a floor — an unbounded swap is not an option', () => {
    const plan = lpFarmPlan();
    const swap = { ...plan.steps.find((s) => s.id === 'swap-towelie')!, route: { ...plan.steps.find((s) => s.id === 'swap-towelie')!.route!, minOut: 0n } };
    const bound = bindZapStep(swap, ACCOUNT, NOTHING, NOW);
    expect(bound).toMatchObject({ kind: 'blocked' });
    expect((bound as { reason: string }).reason).toMatch(/unbounded/i);
  });

  it('sends the route’s own minOut, not a recomputed one', () => {
    const plan = lpFarmPlan();
    const swap = plan.steps.find((s) => s.id === 'swap-towelie')!;
    const bound = bindZapStep(swap, ACCOUNT, NOTHING, NOW);
    const call = (bound as { call: { to: string; data: `0x${string}`; value?: string } }).call;
    expect(call.to.toLowerCase()).toBe(SWAP_FEE_ROUTER_ADDRESS.toLowerCase());
    expect(BigInt(call.value!)).toBe(ONE_ETH / 2n);
    const decoded = decodeFunctionData({ abi: SWAP_FEE_ROUTER_ABI, data: call.data });
    expect(decoded.functionName).toBe('swapExactETHForTokens');
    expect(decoded.args![0]).toBe(400n * ONE_ETH);
    // maxFeeBps — the frontrunning guard useSwap.ts already submits.
    expect(decoded.args![4]).toBe(100n);
  });

  it('uses the real Uniswap router, with no maxFeeBps, when that is the executor', () => {
    const d: ZapDescriptor = {
      venueId: 'staking-lock',
      account: ACCOUNT,
      chainId: 1,
      inputToken: USDC,
      inputSymbol: 'USDC',
      inputIsNative: false,
      amountIn: '1000000',
      slippageBps: 50,
      lockDurationSeconds: '7776000',
    };
    const r = planZap(
      d,
      {
        toTowelie: {
          executor: UNISWAP_V2_ROUTER,
          executorTakesMaxFee: false,
          amountIn: 1_000_000n,
          minOut: 10n ** 20n,
          path: [USDC, WETH_ADDRESS, TOWELI_ADDRESS],
          slippageBps: 50,
        },
      },
      1,
    );
    expect(r.ok).toBe(true);
    const swap = r.ok ? r.plan.steps.find((s) => s.id === 'swap-towelie')! : null;
    const call = (bindZapStep(swap!, ACCOUNT, NOTHING, NOW) as { call: { to: string; data: `0x${string}` } }).call;
    expect(call.to.toLowerCase()).toBe(UNISWAP_V2_ROUTER.toLowerCase());
    const decoded = decodeFunctionData({ abi: UNISWAP_V2_ROUTER_ABI, data: call.data });
    expect(decoded.functionName).toBe('swapExactTokensForTokens');
    expect(decoded.args).toHaveLength(5);
  });
});

describe('the liquidity leg', () => {
  it('pairs the measured TOWELI against the fixed ETH half, with both floors applied', () => {
    const plan = lpFarmPlan();
    const liq = plan.steps.find((s) => s.id === 'add-liquidity')!;
    const bound = bindZapStep(liq, ACCOUNT, { baseline: { towelie: 0n }, current: { towelie: 1000n } }, NOW);
    const call = (bound as { call: { to: string; data: `0x${string}`; value?: string } }).call;
    expect(call.to.toLowerCase()).toBe(TEGRIDY_ROUTER_ADDRESS.toLowerCase());
    expect(BigInt(call.value!)).toBe(ONE_ETH / 2n);
    const decoded = decodeFunctionData({ abi: TEGRIDY_ROUTER_ABI, data: call.data });
    expect(decoded.functionName).toBe('addLiquidityETH');
    const args = decoded.args as readonly [string, bigint, bigint, bigint, string, bigint];
    expect(args[1]).toBe(1000n);
    expect(args[2]).toBe(995n); // 50 bps floor, rounded down
    expect(args[3]).toBe((ONE_ETH / 2n * 9950n) / 10000n);
    expect(args[4]).toBe(ACCOUNT);
    expect(args[5]).toBe(BigInt(NOW + 1800));
  });
});

describe('the lock leg', () => {
  it('locks the measured TOWELI for the requested duration', () => {
    const r = planZap(
      {
        venueId: 'staking-lock',
        account: ACCOUNT,
        chainId: 1,
        inputToken: USDC,
        inputSymbol: 'USDC',
        inputIsNative: false,
        amountIn: '1000000',
        slippageBps: 50,
        lockDurationSeconds: '7776000',
      },
      {
        toTowelie: {
          executor: SWAP_FEE_ROUTER_ADDRESS,
          executorTakesMaxFee: true,
          amountIn: 1_000_000n,
          minOut: 10n ** 20n,
          path: [USDC, WETH_ADDRESS, TOWELI_ADDRESS],
          slippageBps: 50,
        },
      },
      1,
    );
    const lock = r.ok ? r.plan.steps.find((s) => s.id === 'staking-lock')! : null;
    const bound = bindZapStep(lock!, ACCOUNT, { baseline: { towelie: 3n }, current: { towelie: 903n } }, NOW);
    const call = (bound as { call: { to: string; data: `0x${string}` } }).call;
    expect(call.to.toLowerCase()).toBe(TEGRIDY_STAKING_ADDRESS.toLowerCase());
    const decoded = decodeFunctionData({ abi: TEGRIDY_STAKING_ABI, data: call.data });
    expect(decoded.functionName).toBe('stake');
    expect(decoded.args).toEqual([900n, 7776000n]);
  });
});
