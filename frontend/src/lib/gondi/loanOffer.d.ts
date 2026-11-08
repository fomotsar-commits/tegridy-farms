// Types for loanOffer.js. The runtime is plain JS so api/_lib/loanOffers.js can import it
// (src/lib/fetchWholeBody.d.ts has the same layout).
import type { Address, Hex } from 'viem';

export declare const GONDI_LOAN_ADDRESS: Address;
export declare const ZERO_ADDRESS: Address;
export declare const WETH_ADDRESS: Address;
export declare const LOAN_CHAIN_ID: 1;
export declare const LENDING_COLLECTIONS: readonly { readonly name: string; readonly symbol: string; readonly address: Address }[];
export declare const GONDI_DOMAIN_NAME: 'GONDI_MULTI_SOURCE_LOAN';
export declare const GONDI_DOMAIN_VERSION: '3.2';

export declare function gondiDomain(
  verifyingContract?: Address,
  chainId?: number,
): { name: string; version: string; chainId: number; verifyingContract: Address };

export declare const LOAN_OFFER_TYPES: {
  readonly LoanOffer: readonly { name: string; type: string }[];
  readonly OfferValidator: readonly { name: string; type: string }[];
};
export declare const LOAN_TYPES: {
  readonly Loan: readonly { name: string; type: string }[];
  readonly Tranche: readonly { name: string; type: string }[];
};

export interface OfferValidator {
  validator: Address;
  arguments: Hex;
}

/** The offer as the book stores and serves it: numbers as decimal strings. */
export interface LoanOfferJson {
  offerId: string;
  lender: Address;
  fee: string;
  capacity: string;
  nftCollateralAddress: Address;
  nftCollateralTokenId: string;
  principalAddress: Address;
  principalAmount: string;
  aprBps: string;
  expirationTime: string;
  duration: string;
  maxSeniorRepayment: string;
  validators: OfferValidator[];
  lenderRefinanceDisabled: boolean;
  borrower: Address;
}

/** The offer as viem signs it and the contract takes it: numbers as bigints. */
export interface LoanOfferMessage {
  offerId: bigint;
  lender: Address;
  fee: bigint;
  capacity: bigint;
  nftCollateralAddress: Address;
  nftCollateralTokenId: bigint;
  principalAddress: Address;
  principalAmount: bigint;
  aprBps: bigint;
  expirationTime: bigint;
  duration: bigint;
  maxSeniorRepayment: bigint;
  validators: OfferValidator[];
  lenderRefinanceDisabled: boolean;
  borrower: Address;
}

type OfferLike = Pick<LoanOfferJson | LoanOfferMessage, 'nftCollateralTokenId' | 'validators' | 'capacity' | 'principalAmount'>;

export declare const OFFER_LIMITS: {
  readonly maxPrincipalWei: bigint;
  readonly maxAprBps: bigint;
  readonly minDuration: bigint;
  readonly maxDuration: bigint;
  readonly minOpenSeconds: bigint;
  readonly maxOpenSeconds: bigint;
  readonly maxLoansPerOffer: bigint;
};

export declare function wholeCollectionValidators(): OfferValidator[];
export declare function acceptsToken(offer: Pick<OfferLike, 'nftCollateralTokenId' | 'validators'>, tokenId: bigint | string | number): boolean;
export declare function isWholeCollectionOffer(offer: Pick<OfferLike, 'nftCollateralTokenId' | 'validators'>): boolean;
export declare function loansPerOffer(offer: Pick<OfferLike, 'capacity' | 'principalAmount'>): bigint;
export declare function offerToMessage(json: LoanOfferJson): LoanOfferMessage;
export declare function offerToJson(message: LoanOfferMessage): LoanOfferJson;
export declare function sameAddress(a: unknown, b: unknown): boolean;
export declare function validateOfferShape(
  json: unknown,
  nowSeconds: number | bigint,
): { ok: true; offer: LoanOfferJson } | { ok: false; error: string };
