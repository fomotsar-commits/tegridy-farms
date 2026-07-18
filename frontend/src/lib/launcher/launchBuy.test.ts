import { describe, it, expect } from 'vitest';
import { decodeFunctionData, type Address, type Hex } from 'viem';
import { ERC20_ABI } from '../contracts';
import { NATIVE_ETH } from './airlock';
import { minOutFromQuote, buildLaunchBuyCalls, type LaunchBuyParams } from './launchBuy';
import type { WalletCall } from '../eip5792';

const ROUTER = '0x66a9893cc07d91d95644aedd05d03f95e1dba8af' as Address; // stand-in UniversalRouter
const WETH = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2' as Address;
const SWAP_DATA = ('0x' + '11'.repeat(32)) as Hex; // opaque SDK-encoded UR execute() calldata

function swapCall(overrides: Partial<WalletCall> = {}): WalletCall {
  return { to: ROUTER, data: SWAP_DATA, ...overrides };
}

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

describe('buildLaunchBuyCalls — ERC20 (WETH) path', () => {
  it('prepends an EXACT-amount approve to the router, then the swap', () => {
    const amountIn = 5n * 10n ** 17n; // 0.5 WETH
    const calls = buildLaunchBuyCalls({ paymentToken: WETH, router: ROUTER, amountInWei: amountIn, swapCall: swapCall() });
    expect(calls).toHaveLength(2);
    // Leg 1: approve(router, amountIn) on WETH.
    expect(calls[0]!.to).toBe(WETH);
    const decoded = decodeFunctionData({ abi: ERC20_ABI, data: calls[0]!.data! });
    expect(decoded.functionName).toBe('approve');
    expect(String((decoded.args as readonly unknown[])[0]).toLowerCase()).toBe(ROUTER.toLowerCase());
    expect((decoded.args as readonly unknown[])[1]).toBe(amountIn); // exact, not infinite
    // Leg 2: the SDK-encoded swap, unchanged.
    expect(calls[1]).toEqual(swapCall());
  });

  it('rejects a WETH swap that carries a non-zero value', () => {
    expect(() =>
      buildLaunchBuyCalls({ paymentToken: WETH, router: ROUTER, amountInWei: 1n, swapCall: swapCall({ value: '0x1' }) }),
    ).toThrow(/must be absent or zero/);
  });
});

describe('buildLaunchBuyCalls — native ETH path', () => {
  it('is a single swap carrying value == amountIn, no approve', () => {
    const amountIn = 3n * 10n ** 17n;
    const calls = buildLaunchBuyCalls({
      paymentToken: NATIVE_ETH,
      router: ROUTER,
      amountInWei: amountIn,
      swapCall: swapCall({ value: `0x${amountIn.toString(16)}` }),
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.to).toBe(ROUTER);
    expect(BigInt(calls[0]!.value!)).toBe(amountIn);
  });

  it('rejects a native buy whose swap value does not equal amountIn (or is missing)', () => {
    expect(() =>
      buildLaunchBuyCalls({ paymentToken: NATIVE_ETH, router: ROUTER, amountInWei: 100n, swapCall: swapCall({ value: '0x1' }) }),
    ).toThrow(/must equal amountInWei/);
    expect(() =>
      buildLaunchBuyCalls({ paymentToken: NATIVE_ETH, router: ROUTER, amountInWei: 100n, swapCall: swapCall() }),
    ).toThrow(/must equal amountInWei/);
  });
});

describe('buildLaunchBuyCalls — guards', () => {
  it('rejects a non-positive amountIn', () => {
    expect(() => buildLaunchBuyCalls({ paymentToken: WETH, router: ROUTER, amountInWei: 0n, swapCall: swapCall() })).toThrow(
      /positive/,
    );
  });

  it('rejects a swap whose target is not the router', () => {
    const params: LaunchBuyParams = {
      paymentToken: WETH,
      router: ROUTER,
      amountInWei: 1n,
      swapCall: { to: WETH, data: SWAP_DATA },
    };
    expect(() => buildLaunchBuyCalls(params)).toThrow(/must be the UniversalRouter/);
  });
});
