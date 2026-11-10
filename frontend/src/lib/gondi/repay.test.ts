// The repay ladder must be CLIMBABLE while time passes.
//
// What is owed grows every second. Before this file existed, the figure that sized the
// approval (owed 10 minutes on) was also the bar the allowance was checked against, so by
// the time an approval confirmed the bar had moved past it and the button asked for the same
// approval again, without end. CI never saw it: on its shared fork an earlier spec moves the
// chain's clock ahead of the browser's, which made the interest read as zero. Run alone on a
// fresh fork (chain time = wall time, as on mainnet) the borrower never reached Repay.
import { describe, expect, it } from 'vitest';
import { parseEther, type Address } from 'viem';
import { owedAt, type Loan } from './loanMath';
import { REPAY_COVER_SECONDS, REPAY_PAD_SECONDS, nextRepayStep, repayCovered, repayNeeded } from './repay';

const START = 1_800_000_000n;
const LENDER = '0x4444444444444444444444444444444444444444' as Address;
const loan: Loan = {
  borrower: '0x1111111111111111111111111111111111111111' as Address,
  nftCollateralTokenId: 77n,
  nftCollateralAddress: '0xd774557b647330C91Bf44cfEAB205095f7E6c367' as Address,
  principalAddress: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2' as Address,
  principalAmount: parseEther('0.06'),
  startTime: START,
  duration: 30n * 86_400n,
  tranche: [{ loanId: 7n, floor: 0n, principalAmount: parseEther('0.06'), lender: LENDER, accruedInterest: 0n, startTime: START, aprBps: 1400n }],
  protocolFee: 500n,
  lenderRefinanceDisabled: false,
};
const step = (balance: bigint, allowance: bigint, now: bigint) => nextRepayStep(balance, allowance, repayNeeded(loan, now), repayCovered(loan, now)).step;

describe('the repay ladder while the clock runs', () => {
  const t0 = START + 5n * 86_400n;

  it('what is owed really does grow every second, so a bar set to the approval itself is passed at once', () => {
    expect(repayNeeded(loan, t0 + 1n)).toBeGreaterThan(repayNeeded(loan, t0));
    expect(REPAY_COVER_SECONDS).toBeLessThan(REPAY_PAD_SECONDS);
  });

  it('an approval made now still stands when it confirms: the next step is Repay, not the same approval again', () => {
    const approved = repayNeeded(loan, t0); // what the Approve button sends
    const plenty = parseEther('1');
    expect(step(plenty, 0n, t0)).toBe('approve');
    for (const later of [1n, 15n, 60n, 300n, REPAY_PAD_SECONDS - REPAY_COVER_SECONDS]) {
      expect(step(plenty, approved, t0 + later), `${later} s after approving`).toBe('repay');
    }
  });

  it('the same holds for the wrap: WETH wrapped now is still enough a minute on', () => {
    const short = nextRepayStep(parseEther('0.06'), 0n, repayNeeded(loan, t0), repayCovered(loan, t0));
    expect(short.step).toBe('wrap');
    const after = parseEther('0.06') + short.wethShort; // exactly what the Wrap button sends
    expect(after).toBe(repayNeeded(loan, t0));
    expect(step(after, 0n, t0 + 60n)).toBe('approve');
  });

  it('an approval left too long is asked for again, before it could fall short on chain', () => {
    const approved = repayNeeded(loan, t0);
    const stale = t0 + REPAY_PAD_SECONDS - REPAY_COVER_SECONDS + 1n;
    expect(step(parseEther('1'), approved, stale)).toBe('approve');
    // And at that moment the old approval does still cover what is owed right now: the
    // screen asks early, never late.
    expect(approved).toBeGreaterThan(owedAt(loan, stale).total);
  });

  it('Repay is never offered on an allowance or a balance below what is owed 2 minutes on', () => {
    const bar = repayCovered(loan, t0);
    expect(step(parseEther('1'), bar - 1n, t0)).toBe('approve');
    expect(step(bar - 1n, parseEther('1'), t0)).toBe('wrap');
    expect(step(bar, bar, t0)).toBe('repay');
  });
});
