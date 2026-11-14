// Types for loanRequest.js. The runtime is plain JS so api/_lib/loanRequests.js can import
// it (loanOffer.d.ts has the same layout).
import type { Address } from 'viem';
import type { LoanOfferJson } from './loanOffer.js';

export declare const REQUEST_DOMAIN_NAME: 'Tegridy Farms Loan Request';
export declare const REQUEST_DOMAIN_VERSION: '1';
export declare function requestDomain(chainId?: number): { name: string; version: string; chainId: number };

export declare const LOAN_REQUEST_TYPES: { readonly LoanRequest: readonly { name: string; type: string }[] };
export declare const CANCEL_REQUEST_TYPES: { readonly CancelLoanRequest: readonly { name: string; type: string }[] };

/** The request as the book stores and serves it: numbers as decimal strings. */
export interface LoanRequestJson {
  borrower: Address;
  nftCollateralAddress: Address;
  nftCollateralTokenId: string;
  principalAmount: string;
  maxAprBps: string;
  duration: string;
  expirationTime: string;
  nonce: string;
}

/** The request as viem signs it: numbers as bigints. */
export interface LoanRequestMessage {
  borrower: Address;
  nftCollateralAddress: Address;
  nftCollateralTokenId: bigint;
  principalAmount: bigint;
  maxAprBps: bigint;
  duration: bigint;
  expirationTime: bigint;
  nonce: bigint;
}

export declare function requestToMessage(json: LoanRequestJson): LoanRequestMessage;
export declare function validateRequestShape(
  json: unknown,
  nowSeconds: number | bigint,
): { ok: true; request: LoanRequestJson } | { ok: false; error: string };
export declare function offerAnswersRequest(
  offer: Pick<LoanOfferJson, 'nftCollateralAddress' | 'nftCollateralTokenId' | 'validators' | 'principalAmount' | 'aprBps' | 'duration'>,
  request: LoanRequestJson,
): boolean;
