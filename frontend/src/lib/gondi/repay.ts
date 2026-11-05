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

export type RepayStep = 'wrap' | 'approve' | 'repay';

/** Which of the three transactions comes next: wrap the WETH short, approve it, then repay. */
export function nextRepayStep(wethBalance: bigint, allowance: bigint, needed: bigint): { step: RepayStep; wethShort: bigint } {
  const wethShort = wethBalance < needed ? needed - wethBalance : 0n;
  if (wethShort > 0n) return { step: 'wrap', wethShort };
  return { step: allowance < needed ? 'approve' : 'repay', wethShort };
}
