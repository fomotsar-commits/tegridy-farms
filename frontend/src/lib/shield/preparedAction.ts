// The one-click prepared action: the exact transaction, built here, signed by the
// user, sent by the user's wallet.
//
// `executor` is a field with one possible value. That is deliberate — it is the
// type system holding the product claim. There is no branch in this file that
// hands the request to a keeper, an API route or a relayer, and adding one would
// be a change to the type, which is a change a reviewer sees.
//
// The refusals matter as much as the build. Every `{ ok: false }` below is a case
// where a transaction COULD be encoded from the data on hand but would be a lie
// about what it does: an unread repayment quote (would revert on
// `InsufficientRepayment` and burn gas), a loan that already closed, a loan past
// its grace period (the collateral is the lender's; repaying does not buy it
// back). Encoding those anyway and letting the wallet's simulation catch them
// would put the venue's name on a transaction the venue knew was dead.
//
// VALUE INCLUDES A BUFFER, AND THE BUFFER IS DISCLOSED. `getRepaymentAmount` is a
// quote for the block it was read in; interest keeps accruing until inclusion, so
// sending exactly the quote races the clock and reverts. `TegridyNFTLending.
// repayLoan` refunds `msg.value - totalRepayment` to the caller (as ETH, or as
// WETH if the plain ETH send fails), so overpaying is safe and underpaying is
// not — the asymmetry is why the buffer exists rather than a tighter quote.

import { encodeFunctionData, type Address, type Hex } from 'viem';
import { TEGRIDY_NFT_LENDING_ABI } from '../contracts';
import { EXECUTION_IS_YOURS } from './automation';
import type { ShieldHealth } from './health';

/**
 * Headroom added to the quoted repayment, in basis points. Sized to cover
 * interest accrued between reading the quote and the transaction landing, with
 * room for a slow block; the contract refunds the remainder.
 */
export const REPAY_BUFFER_BPS = 50n;
const BPS = 10_000n;

export interface PreparedRepayInput {
  loanId: number;
  /** The lending contract. Only ever the venue's own — see venues.ts. */
  lendingContract: Address | null;
  chainId: number;
  /** The chain this app reads and writes. Mismatch is a refusal, not a warning. */
  expectedChainId: number;
  /** Connected wallet, or null when none is connected. */
  account: Address | null;
  /** The loan's borrower as read from the contract. */
  borrower: string;
  repaid: boolean;
  defaultClaimed: boolean;
  /** `getRepaymentAmount(loanId)`. Null when that read failed. */
  quotedRepayWei: bigint | null;
  health: ShieldHealth;
}

export interface PreparedRepay {
  kind: 'repay';
  /**
   * Who sends this. There is exactly one value and no code path produces
   * another: the venue runs no executor. See automation.ts.
   */
  executor: 'user';
  to: Address;
  data: Hex;
  /** Quote plus buffer. The contract refunds whatever is not owed. */
  value: bigint;
  quotedRepayWei: bigint;
  bufferWei: bigint;
  chainId: number;
  loanId: number;
  /** Short line naming the call. */
  summary: string;
  /** What signing this does — and what it does not do. Rendered verbatim. */
  disclosure: string;
}

export type PreparedRepayResult = { ok: true; action: PreparedRepay } | { ok: false; reason: string };

function bufferFor(quote: bigint): bigint {
  // Round up so a dust-sized quote still gets a non-zero buffer.
  return (quote * REPAY_BUFFER_BPS + BPS - 1n) / BPS;
}

export function prepareRepay(input: PreparedRepayInput): PreparedRepayResult {
  const { lendingContract, account, quotedRepayWei, health } = input;

  if (!lendingContract) {
    return {
      ok: false,
      reason: 'No lending contract is configured on this deployment, so no repayment could be built.',
    };
  }
  if (!account) {
    return { ok: false, reason: 'Connect the borrowing wallet to prepare its repayment.' };
  }
  if (input.chainId !== input.expectedChainId) {
    return {
      ok: false,
      reason: 'Switch to Ethereum Mainnet. This loan lives there, and a repayment built for another chain would not reach it.',
    };
  }
  if (account.toLowerCase() !== input.borrower.toLowerCase()) {
    return {
      ok: false,
      reason: 'Only the borrower can repay this loan — the contract rejects anyone else, so nothing is prepared for this wallet.',
    };
  }
  if (input.repaid) {
    return { ok: false, reason: 'This loan is already repaid. There is nothing left to send.' };
  }
  if (input.defaultClaimed) {
    return {
      ok: false,
      reason: 'The lender has already claimed the collateral for this loan. Repaying now would not return it, so no transaction is prepared.',
    };
  }
  if (health.status === 'unreadable') {
    return {
      ok: false,
      reason: `${health.detail} No repayment is prepared against a deadline nobody read.`,
    };
  }
  // Driven by the contract's own `isDefaulted`, never by a local clock against
  // the `GRACE_PERIOD` constant — that constant expires while the contract is
  // still accepting repayment after any mid-grace pause, and this refusal is the
  // sentence that would tell a borrower their still-recoverable NFT was gone.
  if (!health.repayable) {
    return {
      ok: false,
      reason: 'The lending contract reports this loan as defaulted, so the repayment window has closed. It rejects a repayment now, and the collateral is the lender’s to claim.',
    };
  }
  if (quotedRepayWei == null || quotedRepayWei <= 0n) {
    return {
      ok: false,
      reason: 'The repayment amount could not be read from the lending contract, so no transaction is prepared. Sending a figure nobody read would underpay and revert.',
    };
  }

  const bufferWei = bufferFor(quotedRepayWei);
  const value = quotedRepayWei + bufferWei;
  const data = encodeFunctionData({
    abi: TEGRIDY_NFT_LENDING_ABI,
    functionName: 'repayLoan',
    args: [BigInt(input.loanId)],
  });

  return {
    ok: true,
    action: {
      kind: 'repay',
      executor: 'user',
      to: lendingContract,
      data,
      value,
      quotedRepayWei,
      bufferWei,
      chainId: input.chainId,
      loanId: input.loanId,
      summary: `repayLoan(${input.loanId}) on ${lendingContract}`,
      disclosure: `Signing this sends the repayment from your wallet, closes the loan and returns the collateral NFT to you. The extra ${REPAY_BUFFER_BPS.toString()} basis points covers interest accruing before the transaction lands; the contract refunds whatever is not owed. ${EXECUTION_IS_YOURS}`,
    },
  };
}
