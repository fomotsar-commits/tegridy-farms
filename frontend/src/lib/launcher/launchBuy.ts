// One-click launch-buy — the LEGIT "bundler": a one-signature, single-address,
// fully-disclosed atomic buy, NOT a multi-wallet snipe/concealment tool
// (docs/LAUNCHER_LIQUIDITY_AND_UX_RESEARCH.md, Part B).
//
// Buying from a Doppler dynamic auction is a Uniswap V4 swap on the auction pool,
// executed through the V4 UniversalRouter. The Doppler SDK supplies the PRICE half of
// that (a V4 Quoter) but no calldata builder: its own `bundle()` takes caller-supplied
// `commands, inputs` and points at `doppler-router`, which is a devDependency of the SDK
// and is not resolvable from this app. So the UR `execute(commands, inputs, deadline)`
// encoding lives here, deliberately narrowed to ONE shape — single-hop exact-input on a
// single V4 pool — and every other shape is refused rather than approximated.
//
// The encoding is transcribed from the vendored upstream, not invented:
//   contracts/lib/v4-periphery @ 7ebd04b161745b75ed0c24ba2df3bc7c25f65606
//     src/libraries/Actions.sol            SWAP_EXACT_IN_SINGLE / SETTLE_ALL / TAKE_ALL
//     src/interfaces/IV4Router.sol         ExactInputSingleParams field order
//     src/V4Router.sol                     SETTLE_ALL(currency,maxAmount) semantics,
//                                          TAKE_ALL(currency,minAmount) semantics
//     src/base/BaseActionsRouter.sol       inputs[0] == abi.encode(bytes, bytes[])
// UniversalRouter's V4_SWAP command byte (0x10) is from Uniswap's universal-router
// Commands.sol; it is not vendored here, so `encodeV4ExactInSingleSwap` is pinned by
// byte-level tests that re-derive the layout independently.
//
// PERMIT2 IS NOT OPTIONAL ON THE ERC20 LEG. UniversalRouter has no ERC20 allowance model
// of its own: V4Router `_settle` on a non-native currency routes through the router's
// `_pay`, which calls `permit2.transferFrom(payer, poolManager, ...)`. An ERC20 numeraire
// (TOWELI, WETH) therefore needs `token.approve(PERMIT2)` AND `PERMIT2.approve(token,
// router)` — approving the router directly leaves the swap reverting with the numeraire
// already committed. Native ETH takes neither: the router settles from `msg.value`.
//
// Both amounts are known up front (exact `amountInWei`; the min-out is baked into the
// encoded swap), so this is a CLEAN atomic batch — one wallet confirmation instead of
// three. The single-address atomic batch IS the anti-bundler transparency feature: one
// signature, one address, fully disclosed.
//
// GATING: `useOneClickLaunchBuy` guards on `isLauncherEnabled()` AND on the wallet
// advertising EIP-5792 atomic-batch support; there is no sequential launch-buy surface,
// so a wallet without atomic batching is told so rather than offered a partial path.
//
// NOT YET FORK-PROVEN END TO END. `create()` is (scripts/exotic-toweli-fork-rehearsal.mjs);
// a create+buy fork run against a live auction pool is the outstanding proof for this
// encoding, and the reason `planLaunchBuy` refuses on anything it cannot fully account
// for — a launch is paid for before the buy leg is reached.

import { decodeFunctionData, encodeAbiParameters, encodeFunctionData, type Address, type Hex } from 'viem';
import { ERC20_ABI } from '../contracts';
import type { WalletCall } from '../eip5792';
import { NATIVE_ETH } from './airlock';
import type { V4PoolKey } from './afterlife';

/**
 * Slippage-protected minimum-out from a V4 Quoter's exact-input `amountOut`.
 * `slippageBps` is whole basis points in [0, 10000] (e.g. 100 = 1%). Pure.
 */
export function minOutFromQuote(amountOut: bigint, slippageBps: number): bigint {
  if (!Number.isInteger(slippageBps) || slippageBps < 0 || slippageBps > 10_000) {
    throw new Error('slippageBps must be a whole number of basis points in [0, 10000]');
  }
  if (amountOut < 0n) throw new Error('amountOut must be non-negative');
  return (amountOut * BigInt(10_000 - slippageBps)) / 10_000n;
}

// ─── UniversalRouter / V4Router opcodes ──────────────────────────────────────

/** UniversalRouter `Commands.V4_SWAP`. The ONLY command this module ever emits. */
export const UR_COMMAND_V4_SWAP = 0x10;
/** v4-periphery `Actions.SWAP_EXACT_IN_SINGLE`. */
export const V4_ACTION_SWAP_EXACT_IN_SINGLE = 0x06;
/** v4-periphery `Actions.SETTLE_ALL` — pays the input debt, reverting above `maxAmount`. */
export const V4_ACTION_SETTLE_ALL = 0x0c;
/** v4-periphery `Actions.TAKE_ALL` — collects the output credit, reverting below `minAmount`. */
export const V4_ACTION_TAKE_ALL = 0x0f;

/** Canonical Permit2, identical on every chain it is deployed to. */
export const PERMIT2_ADDRESS: Address = '0x000000000022D473030F116dDEE9F6B43aC78BA3';

const UINT128_MAX = (1n << 128n) - 1n;
const UINT160_MAX = (1n << 160n) - 1n;
const UINT48_MAX = (1n << 48n) - 1n;

/** UniversalRouter's deadline-bearing `execute`. The 2-arg overload is deliberately
 *  absent: a launch-buy without a deadline is a signed order with no expiry. */
export const UNIVERSAL_ROUTER_EXECUTE_ABI = [
  {
    type: 'function',
    name: 'execute',
    stateMutability: 'payable',
    inputs: [
      { name: 'commands', type: 'bytes' },
      { name: 'inputs', type: 'bytes[]' },
      { name: 'deadline', type: 'uint256' },
    ],
    outputs: [],
  },
] as const;

/** Permit2's allowance grant. `amount` is uint160 and `expiration` uint48 — both
 *  narrower than the ERC20 word, so the caller's values are range-checked before use. */
export const PERMIT2_APPROVE_ABI = [
  {
    type: 'function',
    name: 'approve',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'token', type: 'address' },
      { name: 'spender', type: 'address' },
      { name: 'amount', type: 'uint160' },
      { name: 'expiration', type: 'uint48' },
    ],
    outputs: [],
  },
] as const;

/**
 * `poolKey()` on the Doppler auction hook. The buy must target the pool the launch
 * ACTUALLY created — reconstructing the key from wizard inputs would silently point a
 * signed swap at a pool that does not exist, or at someone else's.
 */
export const DOPPLER_HOOK_POOL_KEY_ABI = [
  {
    type: 'function',
    name: 'poolKey',
    stateMutability: 'view',
    inputs: [],
    outputs: [
      { name: 'currency0', type: 'address' },
      { name: 'currency1', type: 'address' },
      { name: 'fee', type: 'uint24' },
      { name: 'tickSpacing', type: 'int24' },
      { name: 'hooks', type: 'address' },
    ],
  },
] as const;

const POOL_KEY_COMPONENTS = [
  { name: 'currency0', type: 'address' },
  { name: 'currency1', type: 'address' },
  { name: 'fee', type: 'uint24' },
  { name: 'tickSpacing', type: 'int24' },
  { name: 'hooks', type: 'address' },
] as const;

/** `IV4Router.ExactInputSingleParams`. Field ORDER is consensus-critical — the router
 *  reads this struct positionally out of calldata. */
const EXACT_INPUT_SINGLE_PARAMS = [
  {
    type: 'tuple',
    components: [
      { name: 'poolKey', type: 'tuple', components: POOL_KEY_COMPONENTS },
      { name: 'zeroForOne', type: 'bool' },
      { name: 'amountIn', type: 'uint128' },
      { name: 'amountOutMinimum', type: 'uint128' },
      { name: 'hookData', type: 'bytes' },
    ],
  },
] as const;

/** `SETTLE_ALL` / `TAKE_ALL` both take `(Currency, uint256)`. */
const CURRENCY_AND_AMOUNT = [{ type: 'address' }, { type: 'uint256' }] as const;

const ACTIONS_EXACT_IN_SINGLE: Hex = `0x${[
  V4_ACTION_SWAP_EXACT_IN_SINGLE,
  V4_ACTION_SETTLE_ALL,
  V4_ACTION_TAKE_ALL,
]
  .map((b) => b.toString(16).padStart(2, '0'))
  .join('')}`;

export interface V4ExactInSingleSwap {
  poolKey: V4PoolKey;
  /** True when the INPUT currency is `poolKey.currency0`. */
  zeroForOne: boolean;
  amountIn: bigint;
  /** Enforced twice on-chain: by the swap params and again by TAKE_ALL. */
  minAmountOut: bigint;
  /** Unix seconds. The router reverts past it. */
  deadline: bigint;
  /** Doppler auction swaps carry none; overridable for hooks that require it. */
  hookData?: Hex;
}

/**
 * ABI-encode a UniversalRouter `execute` that performs one exact-input V4 swap.
 *
 * The three-action plan is the settled upstream idiom for a single-hop exact-in:
 * swap, settle the whole input debt (capped at `amountIn`), take the whole output
 * credit (floored at `minAmountOut`). Settling the FULL debt rather than a fixed
 * amount is what leaves no dust delta open for the router to strand.
 */
export function encodeV4ExactInSingleSwap(swap: V4ExactInSingleSwap): Hex {
  const { poolKey, zeroForOne, amountIn, minAmountOut, deadline, hookData = '0x' } = swap;
  if (amountIn <= 0n || amountIn > UINT128_MAX) {
    throw new Error('amountIn must be positive and fit in uint128');
  }
  if (minAmountOut <= 0n || minAmountOut > UINT128_MAX) {
    // A zero floor is a sandwich with the victim's own signature on it.
    throw new Error('minAmountOut must be positive and fit in uint128');
  }
  if (deadline <= 0n) throw new Error('deadline must be a positive unix timestamp');

  const currencyIn = zeroForOne ? poolKey.currency0 : poolKey.currency1;
  const currencyOut = zeroForOne ? poolKey.currency1 : poolKey.currency0;

  const swapParams = encodeAbiParameters(EXACT_INPUT_SINGLE_PARAMS, [
    { poolKey, zeroForOne, amountIn, amountOutMinimum: minAmountOut, hookData },
  ]);
  const settleParams = encodeAbiParameters(CURRENCY_AND_AMOUNT, [currencyIn, amountIn]);
  const takeParams = encodeAbiParameters(CURRENCY_AND_AMOUNT, [currencyOut, minAmountOut]);

  const v4Input = encodeAbiParameters([{ type: 'bytes' }, { type: 'bytes[]' }], [
    ACTIONS_EXACT_IN_SINGLE,
    [swapParams, settleParams, takeParams],
  ]);

  return encodeFunctionData({
    abi: UNIVERSAL_ROUTER_EXECUTE_ABI,
    functionName: 'execute',
    args: [commandByte(UR_COMMAND_V4_SWAP), [v4Input], deadline],
  });
}

function commandByte(command: number): Hex {
  return `0x${command.toString(16).padStart(2, '0')}`;
}

/**
 * Read back the command byte and deadline from an encoded UniversalRouter `execute`.
 * Throws when the calldata is not a UR `execute` at all — used to bind the composed
 * batch to the swap it claims to wrap rather than trusting the caller's parallel copy.
 */
function readExecute(data: Hex): { commands: Hex; deadline: bigint } {
  let decoded;
  try {
    decoded = decodeFunctionData({ abi: UNIVERSAL_ROUTER_EXECUTE_ABI, data });
  } catch {
    throw new Error('swapCall.data is not a UniversalRouter execute(commands, inputs, deadline)');
  }
  const [commands, , deadline] = decoded.args as readonly [Hex, readonly Hex[], bigint];
  return { commands, deadline };
}

export interface LaunchBuyParams {
  /** Numeraire spent to buy: NATIVE_ETH (address(0)) or an ERC20 (TOWELI, WETH). */
  paymentToken: Address;
  /** Uniswap V4 UniversalRouter (from the Doppler SDK `getAddresses().universalRouter`). */
  router: Address;
  /** Exact numeraire spent (wei). */
  amountInWei: bigint;
  /**
   * Unix-seconds expiry. MUST be the deadline encoded inside `swapCall`, and is reused
   * as the Permit2 allowance expiry so a granted allowance can never outlive the swap
   * it was granted for. Cross-checked against the calldata, not trusted.
   */
  deadline: bigint;
  /**
   * The encoded UniversalRouter `execute(commands, inputs, deadline)` swap that buys the
   * launch token for `amountInWei` with the caller's min-out already baked in — see
   * `encodeV4ExactInSingleSwap`. Its `to` MUST be `router`. For a native-ETH buy,
   * `swapCall.value` MUST equal `amountInWei`; for an ERC20 buy, `value` must be
   * absent/zero and the two Permit2 legs are prepended.
   */
  swapCall: WalletCall;
}

/**
 * Build the EIP-5792 one-click launch-buy call batch.
 *   - Native-ETH buy: `[swap]` (the swap carries `value == amountInWei`; no allowance).
 *   - ERC20 buy: `[approve amountIn → Permit2]` + `[Permit2.approve amountIn → router,
 *     expiring at `deadline`]` + `[swap]`.
 * Pure + unit-tested. `useOneClickLaunchBuy` wraps it with capability detection.
 */
export function buildLaunchBuyCalls(params: LaunchBuyParams): WalletCall[] {
  const { paymentToken, router, amountInWei, deadline, swapCall } = params;
  if (amountInWei <= 0n) throw new Error('amountInWei must be positive');
  if (swapCall.to.toLowerCase() !== router.toLowerCase()) {
    throw new Error('swapCall.to must be the UniversalRouter (router)');
  }
  if (!swapCall.data) throw new Error('swapCall.data is required');

  const encoded = readExecute(swapCall.data);
  if (encoded.commands.toLowerCase() !== commandByte(UR_COMMAND_V4_SWAP)) {
    // Anything else is a route this module did not build and cannot vouch for.
    throw new Error('swapCall must carry exactly the V4_SWAP command');
  }
  if (encoded.deadline !== deadline) {
    throw new Error('deadline must equal the deadline encoded in swapCall');
  }

  const isNative = paymentToken.toLowerCase() === NATIVE_ETH.toLowerCase();
  if (isNative) {
    // Native buy: the swap must carry exactly amountInWei; no allowance leg.
    if (swapCall.value === undefined || BigInt(swapCall.value) !== amountInWei) {
      throw new Error('native buy: swapCall.value must equal amountInWei');
    }
    return [swapCall];
  }

  // ERC20 buy: the router pulls the numeraire through Permit2, so the swap carries no
  // value. Both allowances are EXACT and the Permit2 grant expires with the swap.
  if (swapCall.value !== undefined && BigInt(swapCall.value) !== 0n) {
    throw new Error('ERC20 buy: swapCall.value must be absent or zero (numeraire is pulled via Permit2)');
  }
  if (amountInWei > UINT160_MAX) throw new Error('ERC20 buy: amountInWei must fit in uint160 for Permit2');
  if (deadline > UINT48_MAX) throw new Error('ERC20 buy: deadline must fit in uint48 for Permit2');

  return [
    {
      to: paymentToken,
      data: encodeFunctionData({
        abi: ERC20_ABI,
        functionName: 'approve',
        args: [PERMIT2_ADDRESS, amountInWei],
      }),
    },
    {
      to: PERMIT2_ADDRESS,
      data: encodeFunctionData({
        abi: PERMIT2_APPROVE_ABI,
        functionName: 'approve',
        args: [paymentToken, router, amountInWei, Number(deadline)],
      }),
    },
    swapCall,
  ];
}

// ─── Quote → plan ────────────────────────────────────────────────────────────

/** Floor on user-settable slippage. Below this a quote's own rounding dominates. */
export const MIN_LAUNCH_BUY_SLIPPAGE_BPS = 5;
/**
 * Ceiling on user-settable slippage. Mirrors `aggregator.ts`'s 50% clamp. Out-of-range
 * input is REFUSED rather than clamped: a silently-narrowed tolerance would mean the
 * number encoded in the swap is not the number the user was shown.
 */
export const MAX_LAUNCH_BUY_SLIPPAGE_BPS = 5_000;
/** Default tolerance offered by the buy surface. */
export const DEFAULT_LAUNCH_BUY_SLIPPAGE_BPS = 50;

/**
 * The slice of the Doppler SDK's `Quoter` this module needs, as a structural type so
 * the real `new Quoter(publicClient, chainId)` satisfies it and tests can supply a
 * double without the SDK's runtime weight.
 */
export interface V4QuoterLike {
  quoteExactInputV4(params: {
    poolKey: { currency0: Address; currency1: Address; fee: number; tickSpacing: number; hooks: Address };
    zeroForOne: boolean;
    exactAmount: bigint;
    hookData?: string;
  }): Promise<{ amountOut: bigint }>;
}

export interface LaunchBuyRequest {
  /** The auction pool, as read from the launch's Doppler hook. */
  poolKey: V4PoolKey;
  /** Numeraire being spent. Must be one of the pool's two currencies. */
  paymentToken: Address;
  amountInWei: bigint;
  slippageBps: number;
  /** Uniswap V4 UniversalRouter for this chain. */
  router: Address;
  /** Unix seconds. */
  deadline: bigint;
  hookData?: Hex;
}

export type LaunchBuyPlan =
  | {
      ok: true;
      /** Ready for `useOneClickLaunchBuy().buyOneClick`. */
      buy: LaunchBuyParams;
      /** What the Quoter actually returned, before slippage. */
      quotedAmountOut: bigint;
      /** The floor encoded into the swap. Display THIS, not a recomputation. */
      minAmountOut: bigint;
      /** The tolerance that produced `minAmountOut` — identical to the request's. */
      slippageBps: number;
      /** The token the buyer receives. */
      tokenOut: Address;
    }
  | { ok: false; reason: string };

/**
 * Quote the buy and, only if every part of it is accounted for, encode it.
 *
 * There is no unprotected fallback anywhere in here. A quote that cannot be obtained,
 * a quote of zero, or a floor that rounds to zero all end as a refusal carrying the
 * reason — the launch has already been paid for by the time this runs, so a swap that
 * might revert, or might fill at any price, is worse than a stated "not right now".
 */
export async function planLaunchBuy(
  quoter: V4QuoterLike,
  request: LaunchBuyRequest,
): Promise<LaunchBuyPlan> {
  const { poolKey, paymentToken, amountInWei, slippageBps, router, deadline, hookData = '0x' } = request;

  if (BigInt(poolKey.currency0) >= BigInt(poolKey.currency1)) {
    return { ok: false, reason: 'This pool’s currencies are not in canonical order, so we can’t build the swap.' };
  }
  const pay = paymentToken.toLowerCase();
  const isCurrency0 = pay === poolKey.currency0.toLowerCase();
  const isCurrency1 = pay === poolKey.currency1.toLowerCase();
  if (!isCurrency0 && !isCurrency1) {
    return { ok: false, reason: 'That payment token isn’t one of this pool’s two currencies.' };
  }
  if (amountInWei <= 0n) {
    return { ok: false, reason: 'Enter an amount to spend.' };
  }
  if (amountInWei > UINT128_MAX) {
    return { ok: false, reason: 'That amount is too large for a single V4 swap.' };
  }
  if (!Number.isInteger(slippageBps) || slippageBps < MIN_LAUNCH_BUY_SLIPPAGE_BPS || slippageBps > MAX_LAUNCH_BUY_SLIPPAGE_BPS) {
    return {
      ok: false,
      reason: `Slippage must be a whole number of basis points between ${MIN_LAUNCH_BUY_SLIPPAGE_BPS} and ${MAX_LAUNCH_BUY_SLIPPAGE_BPS}.`,
    };
  }
  if (deadline <= 0n || deadline > UINT48_MAX) {
    return { ok: false, reason: 'The buy deadline is not a usable timestamp.' };
  }

  const zeroForOne = isCurrency0;
  const tokenOut = zeroForOne ? poolKey.currency1 : poolKey.currency0;

  let quotedAmountOut: bigint;
  try {
    const quote = await quoter.quoteExactInputV4({ poolKey, zeroForOne, exactAmount: amountInWei, hookData });
    quotedAmountOut = quote.amountOut;
  } catch {
    // The quoter simulates the real hook. A revert here means the auction would not
    // have filled this swap either — and with no quote there is no honest floor.
    return {
      ok: false,
      reason: 'We couldn’t get a price for this pool just now, so we can’t set a minimum you’re protected by. Nothing was sent — try again in a moment.',
    };
  }

  if (quotedAmountOut <= 0n) {
    return { ok: false, reason: 'This pool quoted zero tokens out for that amount, so there is nothing to buy at this size.' };
  }

  const minAmountOut = minOutFromQuote(quotedAmountOut, slippageBps);
  if (minAmountOut <= 0n) {
    return { ok: false, reason: 'That amount is too small to leave any slippage protection — increase it, or lower your slippage.' };
  }

  const swapData = encodeV4ExactInSingleSwap({
    poolKey,
    zeroForOne,
    amountIn: amountInWei,
    minAmountOut,
    deadline,
    hookData,
  });

  const isNative = pay === NATIVE_ETH.toLowerCase();
  const swapCall: WalletCall = isNative
    ? { to: router, data: swapData, value: `0x${amountInWei.toString(16)}` }
    : { to: router, data: swapData };

  const buy: LaunchBuyParams = { paymentToken, router, amountInWei, deadline, swapCall };
  // Compose here too: a batch that cannot be built is a refusal, never a submitted call.
  try {
    buildLaunchBuyCalls(buy);
  } catch (e) {
    return { ok: false, reason: `We couldn’t assemble this buy safely: ${(e as Error).message}` };
  }

  return { ok: true, buy, quotedAmountOut, minAmountOut, slippageBps, tokenOut };
}
