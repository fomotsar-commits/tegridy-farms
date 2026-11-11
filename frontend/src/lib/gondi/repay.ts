// Gondi v3.2's repayment, as My Loans and the loan shield both send it.
//
// `repayLoan` takes the whole loan back (Gondi stores only its hash), pulls what is owed in
// WETH with transferFrom (no ETH value, no refund), and reverts with LoanExpiredError from the
// deadline second on: MultiSourceLoan._baseLoanChecks refuses `startTime + duration <=
// block.timestamp`. So the borrower needs WETH and an allowance covering what is owed when the
// transaction lands, and the window shuts AT the deadline. There is no grace period.
import type { Hex } from 'viem';
import { owedAt, type Loan } from './loanMath';

/** Repaying pulls interest up to the block it lands in: hold and approve 10 more minutes' worth. */
export const REPAY_PAD_SECONDS = 600n;

/** The one argument `repayLoan` takes, for the borrower repaying their own loan. */
export function repayLoanArgs(loanId: bigint, loan: Loan) {
  return [{ data: { loanId, callbackData: '0x' as Hex, shouldDelegate: false }, loan, borrowerSignature: '0x' as Hex }] as const;
}

/** The WETH a repayment sent now must have on hand and approved: what is owed 10 minutes on. */
export function repayNeeded(loan: Loan, nowUnix: bigint): bigint {
  return owedAt(loan, nowUnix + REPAY_PAD_SECONDS).total;
}

/**
 * How far ahead a step must already be covered before the next one is offered: 2 minutes,
 * time for a transaction sent now to land.
 *
 * WHY THERE ARE TWO NUMBERS. What is owed grows every second. `repayNeeded` (10 minutes on)
 * is how much to WRAP and APPROVE; if the same figure also decided whether enough is wrapped
 * and approved, it would have moved on by the time the approval confirmed, and the button
 * would ask for the same approval again, for good: a borrower could never reach Repay. So
 * the amount aims 10 minutes ahead and the check asks only for 2. An approval then stays
 * good for about 8 minutes, and one left longer than that is asked for again, rightly.
 */
export const REPAY_COVER_SECONDS = 120n;

/** The WETH that must ALREADY be on hand and approved for the next step to be offered. */
export function repayCovered(loan: Loan, nowUnix: bigint): bigint {
  return owedAt(loan, nowUnix + REPAY_COVER_SECONDS).total;
}

export type RepayStep = 'wrap' | 'approve' | 'repay';

/**
 * Which of the three transactions comes next: wrap the WETH short, approve it, then repay.
 * `needed` (repayNeeded) sizes the wrap; `covered` (repayCovered) is the lower bar the
 * balance and the allowance are checked against. Both must be given: a caller that checks
 * against `needed` itself never gets past its own approval.
 */
export function nextRepayStep(wethBalance: bigint, allowance: bigint, needed: bigint, covered: bigint): { step: RepayStep; wethShort: bigint } {
  if (wethBalance < covered) return { step: 'wrap', wethShort: needed > wethBalance ? needed - wethBalance : 0n };
  return { step: allowance < covered ? 'approve' : 'repay', wethShort: 0n };
}
