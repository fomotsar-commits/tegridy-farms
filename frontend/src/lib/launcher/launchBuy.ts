// One-click launch-buy — the LEGIT "bundler": a one-signature, single-address,
// fully-disclosed atomic buy, NOT a multi-wallet snipe/concealment tool
// (docs/LAUNCHER_LIQUIDITY_AND_UX_RESEARCH.md, Part B).
//
// Buying from a Doppler dynamic auction is a Uniswap V4 swap on the auction pool,
// executed through the V4 UniversalRouter. The V4 UR `execute(commands, inputs)`
// calldata is INTENTIONALLY the SDK's job: the Doppler SDK exposes a V4 Quoter
// (`quoteExactInputV4` → amountOut, for slippage) and its own `bundle()` API takes
// caller-supplied `commands, inputs`. So we do NOT hand-roll V4 UR calldata here —
// this composer only wraps the SDK/Quoter-produced swap call with the approve leg
// and the native-vs-WETH value handling, mirroring stakeBatch.ts's shape.
//
// Both amounts are known up front (exact `amountInWei`; the swap's min-out/slippage
// is baked into the SDK-encoded `swapCall`), so this is a CLEAN atomic batch — one
// wallet confirmation instead of two. The single-address atomic batch IS the
// anti-bundler transparency feature: one signature, one address, fully disclosed.
//
// GATING: `useOneClickLaunchBuy` guards on `isLauncherEnabled()` (there are no
// Tegridy launches to buy until the rail is live) AND on the wallet advertising
// EIP-5792 atomic-batch support, falling back to the sequential path otherwise.
//
// GO-LIVE TODO: the caller supplies `swapCall` from the Doppler SDK swap-encoding
// path (Quoter for min-out + UR command build). Fork-verify the end-to-end
// buy against a live auction pool before the rail un-gates (a create+buy fork run,
// like the create() proof) — the UR encoding is the one part not exercised here.

import { encodeFunctionData, type Address } from 'viem';
import { ERC20_ABI } from '../contracts';
import type { WalletCall } from '../eip5792';
import { NATIVE_ETH } from './airlock';

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

export interface LaunchBuyParams {
  /** Numeraire spent to buy: NATIVE_ETH (address(0)) or an ERC20 (WETH). */
  paymentToken: Address;
  /** Uniswap V4 UniversalRouter (from the Doppler SDK `getAddresses().universalRouter`). */
  router: Address;
  /** Exact numeraire spent (wei). */
  amountInWei: bigint;
  /**
   * The pre-encoded UniversalRouter `execute(commands, inputs)` swap that buys the
   * launch token for `amountInWei` with the caller's min-out (slippage) already baked
   * in — built by the Doppler SDK swap-encoding path, NOT hand-rolled here. Its `to`
   * MUST be `router`. For a native-ETH buy, `swapCall.value` MUST equal `amountInWei`;
   * for an ERC20 (WETH) buy, `value` must be absent/zero and an approve leg is prepended.
   */
  swapCall: WalletCall;
}

/**
 * Build the EIP-5792 one-click launch-buy call batch.
 *   - Native-ETH buy: `[swap]` (the swap carries `value == amountInWei`; no approve).
 *   - ERC20 (WETH) buy: `[approve exactly amountIn → router]` + `[swap]`.
 * Pure + unit-tested. `useOneClickLaunchBuy` wraps it with capability detection and
 * a fall-back to the existing sequential flow.
 */
export function buildLaunchBuyCalls(params: LaunchBuyParams): WalletCall[] {
  const { paymentToken, router, amountInWei, swapCall } = params;
  if (amountInWei <= 0n) throw new Error('amountInWei must be positive');
  if (swapCall.to.toLowerCase() !== router.toLowerCase()) {
    throw new Error('swapCall.to must be the UniversalRouter (router)');
  }

  const isNative = paymentToken.toLowerCase() === NATIVE_ETH.toLowerCase();
  if (isNative) {
    // Native buy: the swap must carry exactly amountInWei; no approve leg.
    if (swapCall.value === undefined || BigInt(swapCall.value) !== amountInWei) {
      throw new Error('native buy: swapCall.value must equal amountInWei');
    }
    return [swapCall];
  }

  // ERC20 (WETH) buy: approve EXACTLY amountIn to the router (no infinite approval),
  // then swap. The router pulls the approved numeraire — the swap carries no value.
  if (swapCall.value !== undefined && BigInt(swapCall.value) !== 0n) {
    throw new Error('ERC20 buy: swapCall.value must be absent or zero (numeraire is pulled via approve)');
  }
  return [
    {
      to: paymentToken,
      data: encodeFunctionData({
        abi: ERC20_ABI,
        functionName: 'approve',
        args: [router, amountInWei],
      }),
    },
    swapCall,
  ];
}
