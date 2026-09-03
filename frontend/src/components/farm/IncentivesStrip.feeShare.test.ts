import { describe, it, expect } from 'vitest';
import { feeShareLabel } from './IncentivesStrip';

// F109 (T3): the "Fee Share" chip must derive from the live on-chain split so it
// can't drift if governance retunes it — while never rendering a stale literal.
//
// CORRECTED 2026-09-03. The original version of this suite asserted
// `feeShareLabel(undefined) === '100% to stakers'` and called it "the honest
// current default". It was neither honest nor a default: it was a literal that
// asserted something the chain did not say. SwapFeeRouter.stakerShareBps is
// genuinely 10000, but that is 100% of what REACHES the distributor —
// ReferralSplitter.referralFeeBps takes its cut off the top first
// (ReferralSplitter.sol:400). Read live on mainnet 2026-09-03:
//
//     SwapFeeRouter.stakerShareBps       = 10000   (100%)
//     ReferralSplitter.referralFeeBps    =  2000   (20%)
//     ReferralSplitter.MAX_REFERRAL_FEE  =  3000
//
// so the end-to-end ceiling is 80%, and the app cannot raise it. The chip said
// 100%. These tests exist to keep it saying 80.
describe('feeShareLabel — end-to-end staker share', () => {
  it('states what a staker actually receives, not the router share alone', () => {
    // The live mainnet case, and the regression this suite exists for.
    // A value of '100% to stakers' here means the referral cut was dropped again.
    expect(feeShareLabel(100, 2000)).toBe('80% to stakers');
  });

  it('tracks a retuned referral fee without a frontend change', () => {
    // referralFeeBps is settable up to MAX_REFERRAL_FEE behind a timelock, so a
    // hardcoded 2000 would be tomorrow's drift.
    expect(feeShareLabel(100, 3000)).toBe('70% to stakers');
    expect(feeShareLabel(100, 1000)).toBe('90% to stakers');
  });

  it('tracks a retuned staker share too — both halves are live', () => {
    expect(feeShareLabel(50, 2000)).toBe('40% to stakers');
  });

  it('renders the full share only when the referral cut is genuinely zero', () => {
    // 0 is a real reading, not a missing one: with no referral cut the router
    // share IS the end-to-end share, and 100% is then the true statement.
    expect(feeShareLabel(100, 0)).toBe('100% to stakers');
  });

  it('refuses to quote a share until BOTH reads have landed', () => {
    // The old behaviour filled these in with 100%. An unread value must never
    // render as a real one — the repo's most repeated bug class.
    expect(feeShareLabel(undefined, 2000)).toBe('–');
    expect(feeShareLabel(100, null)).toBe('–');
    expect(feeShareLabel(undefined, null)).toBe('–');
  });

  it('distinguishes a real zero share from an unread one', () => {
    // Governance really could route 0% to stakers. That is a number, not a gap,
    // and it must not collapse into the same '–' as a failed read.
    expect(feeShareLabel(0, 2000)).toBe('0% to stakers');
    expect(feeShareLabel(0, 0)).toBe('0% to stakers');
  });

  it('keeps two decimals for a non-integer result and drops a trailing .00', () => {
    // 33.33 * (1 - 0.2) = 26.664
    expect(feeShareLabel(33.33, 2000)).toBe('26.66% to stakers');
    // 100 * (1 - 0.25) = 75 exactly — no ".00" tail.
    expect(feeShareLabel(100, 2500)).toBe('75% to stakers');
  });
});
