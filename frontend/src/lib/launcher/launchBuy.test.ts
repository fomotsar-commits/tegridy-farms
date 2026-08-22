// The launch-buy encoder sits on a money path with a one-way door in front of it: the
// launch is already paid for and mined by the time the buy leg runs. Two properties are
// pinned hardest here, because a bug in either is silent at build time and expensive
// exactly once:
//
//   1. THE BYTES. `encodeV4ExactInSingleSwap` is checked against a reference layout
//      rebuilt word-by-word in this file, not against viem decoding viem. A round-trip
//      through the same encoder cannot catch a wrong field order or a wrong action byte;
//      re-deriving the ABI layout independently can.
//   2. THE FLOOR. The `minAmountOut` a caller is TOLD is the one read back out of the
//      encoded calldata — in both places the router enforces it. No path reaches a
//      submitted swap with a zero floor.

import { describe, it, expect } from 'vitest';
import { decodeAbiParameters, decodeFunctionData, encodeAbiParameters, type Address, type Hex } from 'viem';
import { ERC20_ABI } from '../contracts';
import { NATIVE_ETH } from './airlock';
import type { V4PoolKey } from './afterlife';
import {
  minOutFromQuote,
  buildLaunchBuyCalls,
  encodeV4ExactInSingleSwap,
  planLaunchBuy,
  PERMIT2_ADDRESS,
  PERMIT2_APPROVE_ABI,
  UNIVERSAL_ROUTER_EXECUTE_ABI,
  UR_COMMAND_V4_SWAP,
  V4_ACTION_SETTLE_ALL,
  V4_ACTION_SWAP_EXACT_IN_SINGLE,
  V4_ACTION_TAKE_ALL,
  MIN_LAUNCH_BUY_SLIPPAGE_BPS,
  MAX_LAUNCH_BUY_SLIPPAGE_BPS,
  type LaunchBuyParams,
  type V4QuoterLike,
} from './launchBuy';
import type { WalletCall } from '../eip5792';

/** Mainnet UniversalRouter, per the Doppler SDK's `getAddresses(1).universalRouter`. */
const ROUTER = '0x66a9893cc07d91d95644aedd05d03f95e1dba8af' as Address;
const TOWELI = '0x4200000000000000000000000000000000000042' as Address;
const TOKEN = '0xcccccccccccccccccccccccccccccccccccccccc' as Address;
const HOOK = '0xdddddddddddddddddddddddddddddddddddddddd' as Address;
const DEADLINE = 1_800_000_000n;

/** Native-ETH auction pool: numeraire is currency0 (address(0) sorts lowest). */
const ETH_POOL: V4PoolKey = {
  currency0: NATIVE_ETH,
  currency1: TOKEN,
  fee: 8_388_608, // DYNAMIC_FEE_FLAG
  tickSpacing: -60, // negative on purpose: int24 sign extension is load-bearing
  hooks: HOOK,
};

/** Exotic pool: TOWELI (0x42…) is still currency0, exactly as ETH would be. */
const TOWELI_POOL: V4PoolKey = { ...ETH_POOL, currency0: TOWELI };

function quoterReturning(amountOut: bigint): V4QuoterLike {
  return { quoteExactInputV4: async () => ({ amountOut }) };
}
const quoterThatFails: V4QuoterLike = {
  quoteExactInputV4: async () => {
    throw new Error('execution reverted');
  },
};

// ─── independent reference encoding ──────────────────────────────────────────

const word = (v: bigint | number): string => {
  let n = BigInt(v);
  if (n < 0n) n += 1n << 256n; // two's complement, as the ABI sign-extends int24
  return n.toString(16).padStart(64, '0');
};
const addrWord = (a: Address): string => a.toLowerCase().replace(/^0x/, '').padStart(64, '0');

/**
 * `abi.encode(IV4Router.ExactInputSingleParams)` rebuilt from the struct definition in
 * contracts/lib/v4-periphery/src/interfaces/IV4Router.sol: one leading offset word
 * (the struct is dynamic because of `hookData`), then PoolKey inline, then the three
 * scalars, then the bytes offset + length.
 */
function referenceSwapParams(
  key: V4PoolKey,
  zeroForOne: boolean,
  amountIn: bigint,
  minOut: bigint,
): string {
  return (
    '0x' +
    word(0x20) + // offset to the struct
    addrWord(key.currency0) +
    addrWord(key.currency1) +
    word(key.fee) +
    word(key.tickSpacing) +
    addrWord(key.hooks) +
    word(zeroForOne ? 1 : 0) +
    word(amountIn) +
    word(minOut) +
    word(0x120) + // offset to hookData, measured from the start of the struct
    word(0) // hookData length
  );
}

function referenceCurrencyAndAmount(currency: Address, amount: bigint): string {
  return '0x' + addrWord(currency) + word(amount);
}

/** Decode a UR `execute` back to its command byte, V4 action plan and action params. */
function readSwap(data: Hex) {
  const { args } = decodeFunctionData({ abi: UNIVERSAL_ROUTER_EXECUTE_ABI, data });
  const [commands, inputs, deadline] = args as readonly [Hex, readonly Hex[], bigint];
  const [actions, params] = decodeAbiParameters(
    [{ type: 'bytes' }, { type: 'bytes[]' }],
    inputs[0]!,
  ) as readonly [Hex, readonly Hex[]];
  return { commands, deadline, actions, params, inputCount: inputs.length };
}

// ─── minOutFromQuote ─────────────────────────────────────────────────────────

describe('minOutFromQuote', () => {
  it('applies whole-bps slippage', () => {
    expect(minOutFromQuote(1_000_000n, 100)).toBe(990_000n); // 1% off
    expect(minOutFromQuote(1_000_000n, 0)).toBe(1_000_000n); // no slippage
    expect(minOutFromQuote(1_000_000n, 10_000)).toBe(0n); // 100% off
  });

  it('rejects out-of-range or fractional bps and negative amounts', () => {
    expect(() => minOutFromQuote(1n, -1)).toThrow(/basis points/);
    expect(() => minOutFromQuote(1n, 10_001)).toThrow(/basis points/);
    expect(() => minOutFromQuote(1n, 1.5)).toThrow(/basis points/);
    expect(() => minOutFromQuote(-1n, 100)).toThrow(/non-negative/);
  });
});

// ─── the encoding ────────────────────────────────────────────────────────────

describe('encodeV4ExactInSingleSwap — byte layout', () => {
  const amountIn = 5n * 10n ** 17n;
  const minOut = 1_234_567n;
  const data = encodeV4ExactInSingleSwap({
    poolKey: ETH_POOL,
    zeroForOne: true,
    amountIn,
    minAmountOut: minOut,
    deadline: DEADLINE,
  });

  it('emits exactly one V4_SWAP command carrying one input', () => {
    const s = readSwap(data);
    expect(s.commands).toBe('0x10');
    expect(UR_COMMAND_V4_SWAP).toBe(0x10);
    expect(s.inputCount).toBe(1);
    expect(s.deadline).toBe(DEADLINE);
  });

  it('plans swap → settle-all → take-all, one action byte each', () => {
    const s = readSwap(data);
    const expected =
      '0x' +
      [V4_ACTION_SWAP_EXACT_IN_SINGLE, V4_ACTION_SETTLE_ALL, V4_ACTION_TAKE_ALL]
        .map((b) => b.toString(16).padStart(2, '0'))
        .join('');
    expect(s.actions).toBe(expected);
    expect(s.actions).toBe('0x060c0f'); // the upstream opcodes, spelled out
    expect(s.params).toHaveLength(3);
  });

  it('matches a reference ExactInputSingleParams layout rebuilt from the struct', () => {
    const s = readSwap(data);
    expect(s.params[0]).toBe(referenceSwapParams(ETH_POOL, true, amountIn, minOut));
  });

  it('settles the input currency capped at amountIn and takes the output floored at minOut', () => {
    const s = readSwap(data);
    expect(s.params[1]).toBe(referenceCurrencyAndAmount(ETH_POOL.currency0, amountIn));
    expect(s.params[2]).toBe(referenceCurrencyAndAmount(ETH_POOL.currency1, minOut));
  });

  it('flips both settle and take currencies when the numeraire is currency1', () => {
    const flipped = encodeV4ExactInSingleSwap({
      poolKey: ETH_POOL,
      zeroForOne: false,
      amountIn,
      minAmountOut: minOut,
      deadline: DEADLINE,
    });
    const s = readSwap(flipped);
    expect(s.params[1]).toBe(referenceCurrencyAndAmount(ETH_POOL.currency1, amountIn));
    expect(s.params[2]).toBe(referenceCurrencyAndAmount(ETH_POOL.currency0, minOut));
    expect(s.params[0]).toBe(referenceSwapParams(ETH_POOL, false, amountIn, minOut));
  });

  it('carries hookData through when a hook needs it', () => {
    const withHookData = encodeV4ExactInSingleSwap({
      poolKey: ETH_POOL,
      zeroForOne: true,
      amountIn,
      minAmountOut: minOut,
      deadline: DEADLINE,
      hookData: '0xbeef',
    });
    const s = readSwap(withHookData);
    const [decoded] = decodeAbiParameters(
      [
        {
          type: 'tuple',
          components: [
            {
              name: 'poolKey',
              type: 'tuple',
              components: [
                { name: 'currency0', type: 'address' },
                { name: 'currency1', type: 'address' },
                { name: 'fee', type: 'uint24' },
                { name: 'tickSpacing', type: 'int24' },
                { name: 'hooks', type: 'address' },
              ],
            },
            { name: 'zeroForOne', type: 'bool' },
            { name: 'amountIn', type: 'uint128' },
            { name: 'amountOutMinimum', type: 'uint128' },
            { name: 'hookData', type: 'bytes' },
          ],
        },
      ],
      s.params[0]!,
    ) as readonly [{ hookData: Hex; amountOutMinimum: bigint; poolKey: { tickSpacing: number } }];
    expect(decoded.hookData).toBe('0xbeef');
    expect(decoded.amountOutMinimum).toBe(minOut);
    expect(decoded.poolKey.tickSpacing).toBe(-60); // sign survived the round trip
  });

  it('refuses a zero or unrepresentable floor, and a zero amount', () => {
    const base = { poolKey: ETH_POOL, zeroForOne: true, amountIn, deadline: DEADLINE };
    expect(() => encodeV4ExactInSingleSwap({ ...base, minAmountOut: 0n })).toThrow(/minAmountOut/);
    expect(() => encodeV4ExactInSingleSwap({ ...base, minAmountOut: 1n << 128n })).toThrow(/minAmountOut/);
    expect(() => encodeV4ExactInSingleSwap({ ...base, amountIn: 0n, minAmountOut: 1n })).toThrow(/amountIn/);
    expect(() => encodeV4ExactInSingleSwap({ ...base, amountIn: 1n << 128n, minAmountOut: 1n })).toThrow(/amountIn/);
    expect(() => encodeV4ExactInSingleSwap({ ...base, minAmountOut: 1n, deadline: 0n })).toThrow(/deadline/);
  });
});

// ─── batch composition ───────────────────────────────────────────────────────

function nativeSwapCall(amountIn: bigint): WalletCall {
  return {
    to: ROUTER,
    data: encodeV4ExactInSingleSwap({
      poolKey: ETH_POOL,
      zeroForOne: true,
      amountIn,
      minAmountOut: 1n,
      deadline: DEADLINE,
    }),
    value: `0x${amountIn.toString(16)}`,
  };
}
function erc20SwapCall(amountIn: bigint): WalletCall {
  return {
    to: ROUTER,
    data: encodeV4ExactInSingleSwap({
      poolKey: TOWELI_POOL,
      zeroForOne: true,
      amountIn,
      minAmountOut: 1n,
      deadline: DEADLINE,
    }),
  };
}

describe('buildLaunchBuyCalls — ERC20 (Permit2) path', () => {
  const amountIn = 5n * 10n ** 17n;
  const calls = buildLaunchBuyCalls({
    paymentToken: TOWELI,
    router: ROUTER,
    amountInWei: amountIn,
    deadline: DEADLINE,
    swapCall: erc20SwapCall(amountIn),
  });

  it('approves Permit2 — not the router — for exactly amountIn', () => {
    // Approving the router directly is the failure this asserts against: UniversalRouter
    // pulls ERC20s through Permit2 and would revert with the numeraire already committed.
    expect(calls).toHaveLength(3);
    expect(calls[0]!.to).toBe(TOWELI);
    const approve = decodeFunctionData({ abi: ERC20_ABI, data: calls[0]!.data! });
    expect(approve.functionName).toBe('approve');
    const args = approve.args as readonly unknown[];
    expect(String(args[0]).toLowerCase()).toBe(PERMIT2_ADDRESS.toLowerCase());
    expect(args[1]).toBe(amountIn); // exact, not infinite
  });

  it('grants the router an exact Permit2 allowance that expires with the swap', () => {
    expect(calls[1]!.to).toBe(PERMIT2_ADDRESS);
    const grant = decodeFunctionData({ abi: PERMIT2_APPROVE_ABI, data: calls[1]!.data! });
    expect(grant.functionName).toBe('approve');
    const [token, spender, amount, expiration] = grant.args as readonly [Address, Address, bigint, number];
    expect(token.toLowerCase()).toBe(TOWELI.toLowerCase());
    expect(spender.toLowerCase()).toBe(ROUTER.toLowerCase());
    expect(amount).toBe(amountIn);
    expect(BigInt(expiration)).toBe(DEADLINE);
  });

  it('ends with the swap, unchanged', () => {
    expect(calls[2]).toEqual(erc20SwapCall(amountIn));
  });

  it('rejects an ERC20 swap that carries a non-zero value', () => {
    expect(() =>
      buildLaunchBuyCalls({
        paymentToken: TOWELI,
        router: ROUTER,
        amountInWei: amountIn,
        deadline: DEADLINE,
        swapCall: { ...erc20SwapCall(amountIn), value: '0x1' },
      }),
    ).toThrow(/must be absent or zero/);
  });
});

describe('buildLaunchBuyCalls — native ETH path', () => {
  it('is a single swap carrying value == amountIn, no allowance legs', () => {
    const amountIn = 3n * 10n ** 17n;
    const calls = buildLaunchBuyCalls({
      paymentToken: NATIVE_ETH,
      router: ROUTER,
      amountInWei: amountIn,
      deadline: DEADLINE,
      swapCall: nativeSwapCall(amountIn),
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.to).toBe(ROUTER);
    expect(BigInt(calls[0]!.value!)).toBe(amountIn);
  });

  it('rejects a native buy whose swap value does not equal amountIn (or is missing)', () => {
    const amountIn = 100n;
    expect(() =>
      buildLaunchBuyCalls({
        paymentToken: NATIVE_ETH,
        router: ROUTER,
        amountInWei: amountIn,
        deadline: DEADLINE,
        swapCall: { ...nativeSwapCall(amountIn), value: '0x1' },
      }),
    ).toThrow(/must equal amountInWei/);
    const { value: _dropped, ...noValue } = nativeSwapCall(amountIn);
    expect(() =>
      buildLaunchBuyCalls({
        paymentToken: NATIVE_ETH,
        router: ROUTER,
        amountInWei: amountIn,
        deadline: DEADLINE,
        swapCall: noValue,
      }),
    ).toThrow(/must equal amountInWei/);
  });
});

describe('buildLaunchBuyCalls — guards', () => {
  const amountIn = 1n;

  it('rejects a non-positive amountIn', () => {
    expect(() =>
      buildLaunchBuyCalls({
        paymentToken: TOWELI,
        router: ROUTER,
        amountInWei: 0n,
        deadline: DEADLINE,
        swapCall: erc20SwapCall(amountIn),
      }),
    ).toThrow(/positive/);
  });

  it('rejects a swap whose target is not the router', () => {
    const params: LaunchBuyParams = {
      paymentToken: TOWELI,
      router: ROUTER,
      amountInWei: amountIn,
      deadline: DEADLINE,
      swapCall: { ...erc20SwapCall(amountIn), to: TOWELI },
    };
    expect(() => buildLaunchBuyCalls(params)).toThrow(/must be the UniversalRouter/);
  });

  it('rejects calldata that is not a UniversalRouter execute at all', () => {
    expect(() =>
      buildLaunchBuyCalls({
        paymentToken: TOWELI,
        router: ROUTER,
        amountInWei: amountIn,
        deadline: DEADLINE,
        swapCall: { to: ROUTER, data: `0x${'11'.repeat(32)}` },
      }),
    ).toThrow(/UniversalRouter execute/);
  });

  it('rejects a swap whose encoded deadline disagrees with the batch', () => {
    expect(() =>
      buildLaunchBuyCalls({
        paymentToken: TOWELI,
        router: ROUTER,
        amountInWei: amountIn,
        deadline: DEADLINE + 1n,
        swapCall: erc20SwapCall(amountIn),
      }),
    ).toThrow(/deadline must equal/);
  });

  it('rejects a command plan that is not exactly V4_SWAP', () => {
    // A UR execute is a general-purpose escape hatch; this module vouches for one shape.
    const foreign = encodeAbiParameters([{ type: 'bytes' }, { type: 'bytes[]' }], ['0x060c0f', ['0x']]);
    const data = ('0x3593564c' +
      encodeAbiParameters(
        [{ type: 'bytes' }, { type: 'bytes[]' }, { type: 'uint256' }],
        ['0x0b10', [foreign, foreign], DEADLINE],
      ).slice(2)) as Hex;
    expect(() =>
      buildLaunchBuyCalls({
        paymentToken: TOWELI,
        router: ROUTER,
        amountInWei: amountIn,
        deadline: DEADLINE,
        swapCall: { to: ROUTER, data },
      }),
    ).toThrow(/exactly the V4_SWAP command/);
  });
});

// ─── quote → plan ────────────────────────────────────────────────────────────

const baseRequest = {
  poolKey: ETH_POOL,
  paymentToken: NATIVE_ETH,
  amountInWei: 10n ** 18n,
  slippageBps: 50,
  router: ROUTER,
  deadline: DEADLINE,
};

describe('planLaunchBuy — the floor the user is shown is the floor that is encoded', () => {
  it('encodes exactly the reported minAmountOut, in both places the router checks it', async () => {
    const plan = await planLaunchBuy(quoterReturning(1_000_000n), { ...baseRequest, slippageBps: 250 });
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.quotedAmountOut).toBe(1_000_000n);
    expect(plan.minAmountOut).toBe(975_000n); // 2.5% off the quote
    expect(plan.slippageBps).toBe(250); // the tolerance asked for, not a clamped one
    expect(plan.tokenOut).toBe(TOKEN);

    const s = readSwap(plan.buy.swapCall.data!);
    expect(s.params[0]).toBe(referenceSwapParams(ETH_POOL, true, baseRequest.amountInWei, 975_000n));
    expect(s.params[2]).toBe(referenceCurrencyAndAmount(TOKEN, 975_000n));
  });

  it('sends the native buy as value on the swap and no allowance legs', async () => {
    const plan = await planLaunchBuy(quoterReturning(1_000_000n), baseRequest);
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(BigInt(plan.buy.swapCall.value!)).toBe(baseRequest.amountInWei);
    expect(buildLaunchBuyCalls(plan.buy)).toHaveLength(1);
  });

  it('routes an exotic (TOWELI) numeraire through Permit2 with no value', async () => {
    const plan = await planLaunchBuy(quoterReturning(1_000_000n), {
      ...baseRequest,
      poolKey: TOWELI_POOL,
      paymentToken: TOWELI,
    });
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.buy.swapCall.value).toBeUndefined();
    const calls = buildLaunchBuyCalls(plan.buy);
    expect(calls).toHaveLength(3);
    expect(calls[1]!.to).toBe(PERMIT2_ADDRESS);
  });
});

describe('planLaunchBuy — refusals never degrade into an unprotected buy', () => {
  it('refuses when the quote cannot be obtained, and says so', async () => {
    const plan = await planLaunchBuy(quoterThatFails, baseRequest);
    expect(plan.ok).toBe(false);
    if (plan.ok) return;
    expect(plan.reason).toMatch(/couldn’t get a price/i);
    expect(plan.reason).toMatch(/nothing was sent/i);
    // The refusal carries no buy to submit — there is no zero-floor fallback to reach.
    expect('buy' in plan).toBe(false);
  });

  it('refuses a zero quote rather than encoding a zero floor', async () => {
    const plan = await planLaunchBuy(quoterReturning(0n), baseRequest);
    expect(plan.ok).toBe(false);
    if (plan.ok) return;
    expect(plan.reason).toMatch(/zero tokens out/i);
  });

  it('refuses when slippage would round the floor away entirely', async () => {
    const plan = await planLaunchBuy(quoterReturning(1n), { ...baseRequest, slippageBps: 5_000 });
    expect(plan.ok).toBe(false);
    if (plan.ok) return;
    expect(plan.reason).toMatch(/slippage protection/i);
  });

  it('refuses out-of-range slippage instead of clamping it', async () => {
    for (const bps of [MIN_LAUNCH_BUY_SLIPPAGE_BPS - 1, MAX_LAUNCH_BUY_SLIPPAGE_BPS + 1, 25.5, -10]) {
      const plan = await planLaunchBuy(quoterReturning(1_000_000n), { ...baseRequest, slippageBps: bps });
      expect(plan.ok, `slippageBps ${bps} must be refused`).toBe(false);
    }
  });

  it('refuses a payment token that is not in the pool', async () => {
    const plan = await planLaunchBuy(quoterReturning(1_000_000n), { ...baseRequest, paymentToken: TOWELI });
    expect(plan.ok).toBe(false);
    if (plan.ok) return;
    expect(plan.reason).toMatch(/isn’t one of this pool/i);
  });

  it('refuses an unsorted pool key rather than guessing the swap direction', async () => {
    const plan = await planLaunchBuy(quoterReturning(1_000_000n), {
      ...baseRequest,
      poolKey: { ...ETH_POOL, currency0: TOKEN, currency1: NATIVE_ETH },
      paymentToken: TOKEN,
    });
    expect(plan.ok).toBe(false);
    if (plan.ok) return;
    expect(plan.reason).toMatch(/canonical order/i);
  });

  it('refuses a non-positive or oversized amount, and an unusable deadline', async () => {
    const q = quoterReturning(1_000_000n);
    expect((await planLaunchBuy(q, { ...baseRequest, amountInWei: 0n })).ok).toBe(false);
    expect((await planLaunchBuy(q, { ...baseRequest, amountInWei: 1n << 128n })).ok).toBe(false);
    expect((await planLaunchBuy(q, { ...baseRequest, deadline: 0n })).ok).toBe(false);
    expect((await planLaunchBuy(q, { ...baseRequest, deadline: 1n << 48n })).ok).toBe(false);
  });

  it('never asks the quoter for a swap it has already refused', async () => {
    let asked = 0;
    const counting: V4QuoterLike = {
      quoteExactInputV4: async () => {
        asked += 1;
        return { amountOut: 1_000_000n };
      },
    };
    await planLaunchBuy(counting, { ...baseRequest, paymentToken: TOWELI });
    await planLaunchBuy(counting, { ...baseRequest, amountInWei: 0n });
    expect(asked).toBe(0);
  });
});
