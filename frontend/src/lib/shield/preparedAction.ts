// The one-click prepared action: the exact transaction, built here, signed by the
// user, sent by the user's wallet.
//
// `executor` is a field with one possible value. That is deliberate — it is the
// type system holding the product claim. There is no branch in this file that
// hands the request to a keeper, an API route or a relayer, and adding one would
// be a change to the type, which is a change a reviewer sees.
//
// Gondi repays in WETH, pulled by the loan contract, so a repayment is up to three
// transactions: wrap the ETH the wallet is short, approve the loan contract, repay. This
// builds whichever comes next, from the same pieces My Loans sends (lib/gondi/repay.ts). The
// amount held and approved is what is owed 10 minutes from now: interest accrues until the
// repayment lands, and the contract takes only what is owed then.
//
// The refusals matter as much as the build. Every `{ ok: false }` below is a case where a
// transaction COULD be encoded but would be a lie about what it does: a loan past its
// deadline (Gondi's `repayLoan` reverts with LoanExpiredError, and the collateral is the
// lender's to claim), or a WETH balance nobody read.

import { encodeFunctionData, type Address, type Hex } from 'viem';
import { ERC20_ABI } from '../contracts';
import { GONDI_LOAN_ABI } from '../gondi/abi.js';
import { WETH_ADDRESS } from '../gondi/loanOffer.js';
import type { Loan } from '../gondi/loanMath';
import { nextRepayStep, repayLoanArgs, repayNeeded, type RepayStep } from '../gondi/repay';
import { EXECUTION_IS_YOURS } from './automation';
import type { ShieldHealth } from './health';

const WETH_DEPOSIT_ABI = [
  { type: 'function', name: 'deposit', inputs: [], outputs: [], stateMutability: 'payable' },
] as const;

export interface PreparedRepayInput {
  loanId: number;
  /** The loan as `getLoanHash` confirmed it. */
  loan: Loan;
  /** Gondi's loan contract. Null when it is not deployed. */
  lendingContract: Address | null;
  chainId: number;
  /** The chain this app reads and writes. Mismatch is a refusal, not a warning. */
  expectedChainId: number;
  /** Connected wallet, or null when none is connected. */
  account: Address | null;
  health: ShieldHealth;
  nowUnix: number;
  /** The wallet's WETH balance. Null when that read failed or has not answered. */
  wethBalance: bigint | null;
  /** The wallet's WETH allowance to the loan contract. Null when unread. */
  wethAllowance: bigint | null;
}

export interface PreparedRepay {
  kind: RepayStep;
  /**
   * Who sends this. There is exactly one value and no code path produces
   * another: the venue runs no executor. See automation.ts.
   */
  executor: 'user';
  to: Address;
  data: Hex;
  /** ETH sent with the call: the WETH short for a wrap, zero otherwise. */
  value: bigint;
  /** WETH the wallet must hold and approve: what is owed 10 minutes from now. */
  neededWei: bigint;
  chainId: number;
  loanId: number;
  /** Short line naming the call. */
  summary: string;
  /** What signing this does — and what it does not do. Rendered verbatim. */
  disclosure: string;
}

export type PreparedRepayResult = { ok: true; action: PreparedRepay } | { ok: false; reason: string };

export function prepareRepay(input: PreparedRepayInput): PreparedRepayResult {
  const { lendingContract, account, health, loan } = input;

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
  if (account.toLowerCase() !== loan.borrower.toLowerCase()) {
    return {
      ok: false,
      reason: 'Only the borrower can repay this loan from here, so nothing is prepared for this wallet.',
    };
  }
  if (!health.repayable) {
    return {
      ok: false,
      reason: 'The deadline has passed, so the loan contract refuses repayment. The collateral is the lender’s to claim, and no transaction is prepared.',
    };
  }
  if (input.wethBalance == null || input.wethAllowance == null) {
    return {
      ok: false,
      reason: 'This wallet’s WETH balance or approval could not be read, so it is not known which step comes next. Nothing is prepared.',
    };
  }

  const neededWei = repayNeeded(loan, BigInt(input.nowUnix));
  const { step, wethShort } = nextRepayStep(input.wethBalance, input.wethAllowance, neededWei);
  const base = { executor: 'user' as const, neededWei, chainId: input.chainId, loanId: input.loanId };

  if (step === 'wrap') {
    return {
      ok: true,
      action: {
        ...base,
        kind: 'wrap',
        to: WETH_ADDRESS,
        data: encodeFunctionData({ abi: WETH_DEPOSIT_ABI, functionName: 'deposit' }),
        value: wethShort,
        summary: `deposit() on WETH ${WETH_ADDRESS}`,
        disclosure: `The loan is repaid in WETH, and this wallet holds less than it needs. Signing this wraps the ETH it is short into WETH in your own wallet. Nothing is repaid yet. ${EXECUTION_IS_YOURS}`,
      },
    };
  }
  if (step === 'approve') {
    return {
      ok: true,
      action: {
        ...base,
        kind: 'approve',
        to: WETH_ADDRESS,
        data: encodeFunctionData({ abi: ERC20_ABI, functionName: 'approve', args: [lendingContract, neededWei] }),
        value: 0n,
        summary: `approve(${lendingContract}) on WETH ${WETH_ADDRESS}`,
        disclosure: `Signing this lets the loan contract take up to this much WETH from your wallet when you repay. Nothing is repaid yet. ${EXECUTION_IS_YOURS}`,
      },
    };
  }
  return {
    ok: true,
    action: {
      ...base,
      kind: 'repay',
      to: lendingContract,
      data: encodeFunctionData({ abi: GONDI_LOAN_ABI, functionName: 'repayLoan', args: repayLoanArgs(BigInt(input.loanId), loan) }),
      value: 0n,
      summary: `repayLoan(${input.loanId}) on ${lendingContract}`,
      disclosure: `Signing this repays the loan from your WETH, closes it and returns the collateral NFT to you. The contract takes what is owed when it lands, never more than the approval. ${EXECUTION_IS_YOURS}`,
    },
  };
}
