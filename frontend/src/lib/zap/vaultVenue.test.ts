// The compounder-vault venue, proven against the day it is switched on.
//
// The vault ships zero-address-gated, so `planZap` refuses it on this build and its branch
// would otherwise be code nobody has ever run — the exact shape this repo keeps finding and
// killing. The gate is stubbed here, and ONLY the gate: the planner, the encoder and the
// ERC-4626 signature are the real ones, so the operator filling in an address turns on a
// path these assertions already walked.
//
// Signature source of truth: contracts/src/vaults/TegridyHarvestVault.sol, whose
// constructor asserts `farm.stakingToken() == asset` — which is why this venue reuses the
// LP-farm plan wholesale and differs only in its last two legs.

import { describe, it, expect, vi } from 'vitest';
import { decodeFunctionData, parseAbi } from 'viem';
import { LP_FARMING_ADDRESS, SWAP_FEE_ROUTER_ADDRESS, TEGRIDY_LP_ADDRESS, TOWELI_ADDRESS, WETH_ADDRESS } from '../constants';

const DEPLOYED_VAULT = '0x4626462646264626462646264626462646264626' as const;
const ACCOUNT = '0x1111111111111111111111111111111111111111' as const;
const ONE_ETH = 10n ** 18n;

vi.mock('./venues', async (importOriginal) => {
  const real = await importOriginal<typeof import('./venues')>();
  return {
    ...real,
    // Only the availability answer is stubbed. Everything the plan is built FROM — the LP
    // token, the router, the deposit asset — stays real.
    venueAvailability: (id: string) =>
      id === 'compounder-vault'
        ? {
            available: true,
            venue: {
              id: 'compounder-vault',
              label: 'Auto-compounding LP vault',
              positionLabel: 'shares in the auto-compounding LP vault',
              target: DEPLOYED_VAULT,
              depositAsset: TEGRIDY_LP_ADDRESS,
            },
          }
        : real.venueAvailability(id as 'lp-farm' | 'staking-lock'),
  };
});

const { planZap } = await import('./planner');
const { bindZapStep } = await import('./calls');

function vaultPlan() {
  const r = planZap(
    {
      venueId: 'compounder-vault',
      account: ACCOUNT,
      chainId: 1,
      inputToken: WETH_ADDRESS,
      inputSymbol: 'ETH',
      inputIsNative: true,
      amountIn: ONE_ETH.toString(),
      slippageBps: 50,
    },
    {
      toTowelie: {
        executor: SWAP_FEE_ROUTER_ADDRESS,
        executorTakesMaxFee: true,
        amountIn: ONE_ETH / 2n,
        minOut: 400n * ONE_ETH,
        path: [WETH_ADDRESS, TOWELI_ADDRESS],
        slippageBps: 50,
      },
    },
    1,
  );
  if (!r.ok) throw new Error(`${r.code}: ${r.detail}`);
  return r.plan;
}

describe('a zap into the auto-compounding vault', () => {
  it('reuses the LP plan and differs only in the last two legs', () => {
    const plan = vaultPlan();
    expect(plan.steps.map((s) => s.id)).toEqual([
      'swap-towelie',
      'approve-router',
      'add-liquidity',
      'approve-vault',
      'vault-deposit',
    ]);
    expect(plan.stageCount).toBe(3);
    expect(plan.composedSlippageBps).toBe(100);
  });

  it('sends the LP to the vault, never to the farm', () => {
    const plan = vaultPlan();
    for (const id of ['approve-vault', 'vault-deposit'] as const) {
      const step = plan.steps.find((s) => s.id === id)!;
      expect(step.spender!.toLowerCase()).toBe(DEPLOYED_VAULT.toLowerCase());
      expect(step.spender!.toLowerCase()).not.toBe(LP_FARMING_ADDRESS.toLowerCase());
      expect(step.token!.toLowerCase()).toBe(TEGRIDY_LP_ADDRESS.toLowerCase());
    }
  });

  it('names the unstaked-LP holding on the liquidity leg, so a stop there still reads right', () => {
    const plan = vaultPlan();
    expect(plan.steps.find((s) => s.id === 'add-liquidity')!.holdingAfter).toMatch(/NOT staked/);
    expect(plan.steps.find((s) => s.id === 'vault-deposit')!.holdingAfter).toMatch(/vault/);
  });

  it('encodes ERC-4626 deposit with the measured LP and the caller as receiver', () => {
    const plan = vaultPlan();
    const step = plan.steps.find((s) => s.id === 'vault-deposit')!;
    const bound = bindZapStep(step, ACCOUNT, { baseline: { lp: 3n }, current: { lp: 20n } }, 1_700_000_000);
    expect(bound.kind).toBe('call');
    const call = (bound as { call: { to: string; data: `0x${string}` } }).call;
    expect(call.to.toLowerCase()).toBe(DEPLOYED_VAULT.toLowerCase());
    const decoded = decodeFunctionData({
      abi: parseAbi(['function deposit(uint256 assets, address receiver) returns (uint256)']),
      data: call.data,
    });
    expect(decoded.functionName).toBe('deposit');
    // 17 = the delta, not the whole balance: a pre-existing 3 LP stays the user's.
    expect(decoded.args).toEqual([17n, ACCOUNT]);
  });

  it('never mints shares to anyone but the connected account', () => {
    const plan = vaultPlan();
    const step = plan.steps.find((s) => s.id === 'vault-deposit')!;
    const other = '0x2222222222222222222222222222222222222222' as const;
    const bound = bindZapStep(step, other, { baseline: { lp: 0n }, current: { lp: 5n } }, 1_700_000_000);
    const decoded = decodeFunctionData({
      abi: parseAbi(['function deposit(uint256 assets, address receiver) returns (uint256)']),
      data: (bound as { call: { data: `0x${string}` } }).call.data,
    });
    // The receiver is the caller passed in, and the caller is the connected wallet —
    // there is no path by which a receiver arrives from anywhere else.
    expect((decoded.args as readonly unknown[])[1]).toBe(other);
  });

  it('blocks the deposit until the liquidity leg has actually minted LP', () => {
    const plan = vaultPlan();
    const step = plan.steps.find((s) => s.id === 'vault-deposit')!;
    expect(bindZapStep(step, ACCOUNT, { baseline: { lp: 5n }, current: { lp: 5n } }, 1).kind).toBe('blocked');
  });
});
