// Gondi v3.2's loan arithmetic, for showing numbers before a transaction. The contract does
// the real math; these mirror it so the screen never promises a different figure.
//   interest   Interest._getInterest: principal * aprBps * seconds / (10000 * 365 days), up
//   repay      MultiSourceLoan._processRepayments: each tranche's principal + accrued +
//              new interest; the venue's cut (protocolFee of the interest, rounded up)
//              comes out of the lender's share, not on top
import { hashStruct, type Address, type Hex } from 'viem';
import { LOAN_TYPES } from './loanOffer.js';

export const SECONDS_PER_YEAR = 31_536_000n;
const PRECISION = 10_000n;

export interface Tranche {
  loanId: bigint;
  floor: bigint;
  principalAmount: bigint;
  lender: Address;
  accruedInterest: bigint;
  startTime: bigint;
  aprBps: bigint;
}

export interface Loan {
  borrower: Address;
  nftCollateralTokenId: bigint;
  nftCollateralAddress: Address;
  principalAddress: Address;
  principalAmount: bigint;
  startTime: bigint;
  duration: bigint;
  tranche: Tranche[];
  protocolFee: bigint;
  lenderRefinanceDisabled: boolean;
}

/** The loan as the book stores it: numbers as decimal strings. */
export type LoanJson = {
  [K in keyof Loan]: K extends 'tranche' ? { [T in keyof Tranche]: Tranche[T] extends bigint ? string : Tranche[T] }[] : Loan[K] extends bigint ? string : Loan[K];
};

function mulDivUp(x: bigint, y: bigint, d: bigint): bigint {
  return (x * y + d - 1n) / d;
}

export function interestFor(principal: bigint, aprBps: bigint, seconds: bigint): bigint {
  if (seconds <= 0n) return 0n;
  return mulDivUp(principal, aprBps * seconds, PRECISION * SECONDS_PER_YEAR);
}

/** What repaying at `timestamp` costs the borrower, and where it goes. */
export function owedAt(loan: Loan, timestamp: bigint): { total: bigint; interest: bigint; toVenue: bigint; toLenders: bigint } {
  let total = 0n;
  let interest = 0n;
  let toVenue = 0n;
  for (const t of loan.tranche) {
    const fresh = interestFor(t.principalAmount, t.aprBps, timestamp - t.startTime);
    const fee = loan.protocolFee === 0n ? 0n : mulDivUp(fresh, loan.protocolFee, PRECISION);
    interest += fresh + t.accruedInterest;
    toVenue += fee;
    total += t.principalAmount + t.accruedInterest + fresh;
  }
  return { total, interest, toVenue, toLenders: total - toVenue };
}

export function loanFromJson(j: LoanJson): Loan {
  return {
    borrower: j.borrower,
    nftCollateralTokenId: BigInt(j.nftCollateralTokenId),
    nftCollateralAddress: j.nftCollateralAddress,
    principalAddress: j.principalAddress,
    principalAmount: BigInt(j.principalAmount),
    startTime: BigInt(j.startTime),
    duration: BigInt(j.duration),
    tranche: j.tranche.map((t) => ({
      loanId: BigInt(t.loanId),
      floor: BigInt(t.floor),
      principalAmount: BigInt(t.principalAmount),
      lender: t.lender,
      accruedInterest: BigInt(t.accruedInterest),
      startTime: BigInt(t.startTime),
      aprBps: BigInt(t.aprBps),
    })),
    protocolFee: BigInt(j.protocolFee),
    lenderRefinanceDisabled: j.lenderRefinanceDisabled,
  };
}

/** Gondi's Hash.hash(Loan), which getLoanHash(loanId) stores. Standard EIP-712 struct hash. */
export function loanHash(loan: Loan): Hex {
  return hashStruct({
    types: LOAN_TYPES as unknown as Record<string, { name: string; type: string }[]>,
    primaryType: 'Loan',
    data: loan as unknown as Record<string, unknown>,
  });
}

export function loanEnd(loan: Loan): bigint {
  return loan.startTime + loan.duration;
}
