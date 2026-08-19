// Turning one planned leg into one wallet call.
//
// Every `to` below comes from `src/lib/constants.ts` or from a plan step whose spender was
// itself set from constants. Nothing here takes an address, a selector or a calldata blob
// from a caller, a quote response or a URL — which is the whole reason this zap needs no
// contract of its own, and the reason it cannot be made into the arbitrary-call drain that
// docs/USER_VALUE_ROADMAP.md line 101 forbids.
//
// Binding is a separate answer from encoding on purpose. A leg whose amount depends on the
// previous stage can only be bound once that stage has landed, and `bindZapStep` reports
// "not yet" as a value rather than encoding a zero — a zero-amount deposit is a wasted
// transaction and a zero minOut is an unbounded swap.

import { encodeFunctionData, type Address } from 'viem';
import {
  ERC20_ABI,
  LP_FARMING_ABI,
  SWAP_FEE_ROUTER_ABI,
  TEGRIDY_ROUTER_ABI,
  TEGRIDY_STAKING_ABI,
  UNISWAP_V2_ROUTER_ABI,
} from '../contracts';
import { TEGRIDY_ROUTER_ADDRESS, WETH_ADDRESS } from '../constants';

/**
 * The one ERC-4626 entry point a zap needs, declared here rather than in `lib/contracts.ts`
 * because the vault has no deployed address yet and this slice does not own that file. When
 * the vault ships and its address joins `constants.ts`, this belongs there with it —
 * `venues.test.ts` fails on that day and says so.
 *
 * Signature checked against `contracts/src/vaults/TegridyHarvestVault.sol`, which overrides
 * `deposit(uint256,address)` with the standard shape.
 */
const ERC4626_DEPOSIT_ABI = [
  {
    type: 'function',
    name: 'deposit',
    inputs: [
      { name: 'assets', type: 'uint256' },
      { name: 'receiver', type: 'address' },
    ],
    outputs: [{ name: 'shares', type: 'uint256' }],
    stateMutability: 'nonpayable',
  },
] as const;
import type { WalletCall } from '../eip5792';
import type { ZapAmount, ZapMeasureKey, ZapStepPlan } from './planner';

/**
 * Balances as they stand right now, against the run's baseline.
 *
 * `current` is read fresh at bind time; `baseline` was read before the run started. A
 * measured amount is the DELTA, so the user's pre-existing holdings stay theirs.
 */
export interface ZapBalances {
  baseline: Partial<Record<ZapMeasureKey, bigint>>;
  current: Partial<Record<ZapMeasureKey, bigint>>;
  /** Allowances already granted, keyed `token:spender` lowercased. Absent = unknown. */
  allowances?: Record<string, bigint>;
}

export type ZapBind =
  | { kind: 'call'; call: WalletCall; amount: bigint }
  /** Nothing to do — the allowance already covers this leg. */
  | { kind: 'skip'; reason: string }
  /** Cannot be built yet or at all, with the reason a user can act on. */
  | { kind: 'blocked'; reason: string };

/** The maximum fee the venue's own router may take on a leg, matching useSwap.ts. */
const MAX_FEE_BPS = 100n;
/** Router deadline. Matches the 30-minute window useAddLiquidity submits. */
const DEADLINE_WINDOW_SECONDS = 1800;

function resolveAmount(amount: ZapAmount, balances: ZapBalances): bigint | { blocked: string } {
  if (amount.kind === 'fixed') return amount.value;
  const before = balances.baseline[amount.key] ?? 0n;
  const now = balances.current[amount.key];
  if (now === undefined) {
    return { blocked: 'This step deposits what the previous step produced, and that balance could not be read.' };
  }
  const delta = now - before;
  if (delta <= 0n) {
    return {
      blocked:
        'The previous step has not produced anything measurable yet. Nothing is sent until it has — an empty ' +
        'deposit would cost gas and move nothing.',
    };
  }
  return delta;
}

/** Slippage floor. Rounds DOWN, so the submitted floor is never higher than intended. */
function applySlippage(amount: bigint, slippageBps: number): bigint {
  const bps = BigInt(Math.max(0, Math.min(10_000, Math.trunc(slippageBps))));
  return (amount * (10_000n - bps)) / 10_000n;
}

/**
 * Bind one leg to the amounts that exist right now, and encode it.
 *
 * `nowSeconds` is passed in rather than read from the clock so a deadline is reproducible
 * in a test — a router deadline that moves between the assertion and the call is a test
 * that proves nothing.
 */
export function bindZapStep(
  step: ZapStepPlan,
  account: Address,
  balances: ZapBalances,
  nowSeconds: number,
): ZapBind {
  const deadline = BigInt(Math.floor(nowSeconds) + DEADLINE_WINDOW_SECONDS);

  switch (step.kind) {
    case 'approve': {
      if (!step.token || !step.spender || !step.amount) {
        return { kind: 'blocked', reason: 'This approval is missing its token, spender or amount.' };
      }
      const resolved = resolveAmount(step.amount, balances);
      if (typeof resolved !== 'bigint') return { kind: 'blocked', reason: resolved.blocked };
      const key = `${step.token.toLowerCase()}:${step.spender.toLowerCase()}`;
      const existing = balances.allowances?.[key];
      // Skipping on a KNOWN sufficient allowance saves a transaction. An UNKNOWN allowance
      // is never treated as sufficient: the approval is cheap and the alternative is a
      // deposit leg that reverts for a reason the user cannot see.
      if (existing !== undefined && existing >= resolved) {
        return { kind: 'skip', reason: 'Your existing allowance already covers this step.' };
      }
      return {
        kind: 'call',
        amount: resolved,
        call: {
          to: step.token,
          data: encodeFunctionData({
            abi: ERC20_ABI,
            functionName: 'approve',
            args: [step.spender, resolved],
          }),
        },
      };
    }

    case 'swap': {
      const route = step.route;
      if (!route) return { kind: 'blocked', reason: 'This swap has no route.' };
      if (route.minOut <= 0n) {
        return {
          kind: 'blocked',
          reason: 'The route came back without a floor, so the swap will not be sent. An unbounded swap is not an option.',
        };
      }
      const path = [...route.path] as Address[];
      const outIsNative = path[path.length - 1]?.toLowerCase() === WETH_ADDRESS.toLowerCase();

      if (route.executorTakesMaxFee) {
        // The venue's own SwapFeeRouter. Its fee is the existing on-chain dial and this
        // module adds nothing to it — see fee.ts.
        if (step.nativeIn) {
          return {
            kind: 'call',
            amount: route.amountIn,
            call: {
              to: route.executor,
              data: encodeFunctionData({
                abi: SWAP_FEE_ROUTER_ABI,
                functionName: 'swapExactETHForTokens',
                args: [route.minOut, path, account, deadline, MAX_FEE_BPS],
              }),
              value: `0x${route.amountIn.toString(16)}`,
            },
          };
        }
        return {
          kind: 'call',
          amount: route.amountIn,
          call: {
            to: route.executor,
            data: encodeFunctionData({
              abi: SWAP_FEE_ROUTER_ABI,
              functionName: outIsNative ? 'swapExactTokensForETH' : 'swapExactTokensForTokens',
              args: [route.amountIn, route.minOut, path, account, deadline, MAX_FEE_BPS],
            }),
          },
        };
      }

      if (step.nativeIn) {
        return {
          kind: 'call',
          amount: route.amountIn,
          call: {
            to: route.executor,
            data: encodeFunctionData({
              abi: UNISWAP_V2_ROUTER_ABI,
              functionName: 'swapExactETHForTokens',
              args: [route.minOut, path, account, deadline],
            }),
            value: `0x${route.amountIn.toString(16)}`,
          },
        };
      }
      return {
        kind: 'call',
        amount: route.amountIn,
        call: {
          to: route.executor,
          data: encodeFunctionData({
            abi: UNISWAP_V2_ROUTER_ABI,
            functionName: outIsNative ? 'swapExactTokensForETH' : 'swapExactTokensForTokens',
            args: [route.amountIn, route.minOut, path, account, deadline],
          }),
        },
      };
    }

    case 'add-liquidity': {
      const liq = step.liquidity;
      if (!liq) return { kind: 'blocked', reason: 'This liquidity step has no amounts.' };
      const tokenAmount = resolveAmount(liq.tokenAmount, balances);
      if (typeof tokenAmount !== 'bigint') return { kind: 'blocked', reason: tokenAmount.blocked };
      if (liq.ethAmount <= 0n) return { kind: 'blocked', reason: 'The ETH side of the pair is zero.' };
      return {
        kind: 'call',
        amount: tokenAmount,
        call: {
          to: TEGRIDY_ROUTER_ADDRESS,
          data: encodeFunctionData({
            abi: TEGRIDY_ROUTER_ABI,
            functionName: 'addLiquidityETH',
            args: [
              liq.token,
              tokenAmount,
              applySlippage(tokenAmount, liq.slippageBps),
              applySlippage(liq.ethAmount, liq.slippageBps),
              account,
              deadline,
            ],
          }),
          value: `0x${liq.ethAmount.toString(16)}`,
        },
      };
    }

    case 'deposit': {
      if (!step.amount || !step.spender) {
        return { kind: 'blocked', reason: 'This deposit is missing its amount or its destination.' };
      }
      const resolved = resolveAmount(step.amount, balances);
      if (typeof resolved !== 'bigint') return { kind: 'blocked', reason: resolved.blocked };
      if (step.id === 'staking-lock') {
        if (step.lockDurationSeconds === undefined) {
          return { kind: 'blocked', reason: 'This lock has no duration.' };
        }
        return {
          kind: 'call',
          amount: resolved,
          call: {
            to: step.spender,
            data: encodeFunctionData({
              abi: TEGRIDY_STAKING_ABI,
              functionName: 'stake',
              args: [resolved, step.lockDurationSeconds],
            }),
          },
        };
      }
      if (step.id === 'vault-deposit') {
        // The receiver is the caller, always. An ERC-4626 deposit can mint shares to any
        // address, and the one thing this zap must never do is take a destination from
        // anywhere but the connected account.
        return {
          kind: 'call',
          amount: resolved,
          call: {
            to: step.spender,
            data: encodeFunctionData({
              abi: ERC4626_DEPOSIT_ABI,
              functionName: 'deposit',
              args: [resolved, account],
            }),
          },
        };
      }
      return {
        kind: 'call',
        amount: resolved,
        call: {
          to: step.spender,
          data: encodeFunctionData({
            abi: LP_FARMING_ABI,
            functionName: 'stake',
            args: [resolved],
          }),
        },
      };
    }
  }
}
