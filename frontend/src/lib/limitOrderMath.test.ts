import { describe, it, expect } from 'vitest';
import { resolveLimitFill } from './limitOrderMath';

// The browser-watched limit order triggers on the market (Uniswap) price but
// executes on the thin native pool. These tests pin the fill-safety invariant:
// the signed minOut is derived from the USER'S TARGET (never the worse native
// quote), and the order ABORTS rather than filling below that target.
const FEE = 100n;   // 1% fee cap (MAX_FEE_BPS)
const SLIP = 100n;  // 1% slippage (SLIPPAGE_BPS)

// Reference haircut = fee then slippage, matching the helper.
const hc = (x: bigint) => {
  const af = (x * (10000n - FEE)) / 10000n;
  return af - (af * SLIP) / 10000n;
};

describe('resolveLimitFill — never fills below the user target', () => {
  const TARGET = 1_000_000n; // output at the user's exact target price

  it('native pool ABOVE target: sign the TARGET floor, not the fatter native quote', () => {
    // The old min() would also have signed the target here — this pins that the
    // user still gets at least their target when the pool is generous.
    const { minOut, abort } = resolveLimitFill(TARGET, 1_500_000n, FEE, SLIP);
    expect(abort).toBe(false);
    expect(minOut).toBe(hc(TARGET));
  });

  it('native pool EXACTLY at target: fills at the target floor', () => {
    const { minOut, abort } = resolveLimitFill(TARGET, TARGET, FEE, SLIP);
    expect(abort).toBe(false);
    expect(minOut).toBe(hc(TARGET));
  });

  it('native pool BELOW target (the bug case): ABORT — do not underfill', () => {
    // Native pool 20% worse than the market target. The OLD code took
    // min(targetFloor, nativeFloor) = the low native quote and signed it,
    // filling ~20% below target. The fix aborts instead.
    const nativeQuote = (TARGET * 80n) / 100n;
    const { minOut, abort } = resolveLimitFill(TARGET, nativeQuote, FEE, SLIP);
    expect(abort).toBe(true);
    // minOut, if it were ever used, is still the target floor — never the low
    // native-derived value the old code would have signed.
    expect(minOut).toBe(hc(TARGET));
    expect(minOut).toBeGreaterThan(hc(nativeQuote));
  });

  it('the ~50%-below-target scenario from the finding is refused', () => {
    const { abort } = resolveLimitFill(TARGET, TARGET / 2n, FEE, SLIP);
    expect(abort).toBe(true);
  });

  it('zero native quote aborts', () => {
    expect(resolveLimitFill(TARGET, 0n, FEE, SLIP).abort).toBe(true);
  });

  it('MUTATION GUARD: the old min(target, native) would have signed below target', () => {
    // Reconstruct the pre-fix decision and assert it violated the invariant, so
    // this test would fail if the code regressed to it.
    const nativeQuote = (TARGET * 70n) / 100n;
    const oldMinOut = hc(TARGET) < hc(nativeQuote) ? hc(TARGET) : hc(nativeQuote);
    expect(oldMinOut).toBe(hc(nativeQuote));                 // old code signed the LOW native floor
    expect(oldMinOut).toBeLessThan(hc(TARGET));              // i.e. below the user's target
    // The fix refuses this fill entirely.
    expect(resolveLimitFill(TARGET, nativeQuote, FEE, SLIP).abort).toBe(true);
  });
});
