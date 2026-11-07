// Gondi v3.2's signed loan offer, and the venue's rules for which offers the book takes.
//
// The EIP-712 shape is Gondi's, field for field: contracts/vendor/gondi-v3.2/sources/
// src/lib/utils/Hash.sol (LoanOffer, OfferValidator, Loan, Tranche). The loan contract
// checks every offer signature against it, so a drift here only ever fails closed: the
// contract refuses the signature. loanOffer.test.ts hashes both ways to catch that first.
//
// Plain JS so api/_lib/loanOffers.js can import it (types: loanOffer.d.ts).

/** Gondi's MultiSourceLoan v3.2 as deployed by contracts/script/DeployGondiLending.s.sol.
 *  Zero until the deploy: everything that sends to it refuses while it is zero. */
export const GONDI_LOAN_ADDRESS = '0x0000000000000000000000000000000000000000';

export const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';
export const WETH_ADDRESS = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2';
export const LOAN_CHAIN_ID = 1;

/** The collections the loan contract allows (its collection allow-list, set at deploy). */
export const LENDING_COLLECTIONS = Object.freeze([
  Object.freeze({ name: 'Jungle Bay Ape Club', symbol: 'JBAC', address: '0xd37264c71e9af940e49795F0d3a8336afAaFDdA9' }),
  Object.freeze({ name: 'Nakamigos', symbol: 'NAKA', address: '0xd774557b647330C91Bf44cfEAB205095f7E6c367' }),
  Object.freeze({ name: 'GNSS Art', symbol: 'GNSS', address: '0xa1De9f93c56C290C48849B1393b09eB616D55dbb' }),
]);

// BaseLoan's EIP-712 domain: name = the constructor's "GONDI_MULTI_SOURCE_LOAN", version =
// VERSION ("3.2"). Wallets show the name when a lender signs.
export const GONDI_DOMAIN_NAME = 'GONDI_MULTI_SOURCE_LOAN';
export const GONDI_DOMAIN_VERSION = '3.2';

export function gondiDomain(verifyingContract = GONDI_LOAN_ADDRESS, chainId = LOAN_CHAIN_ID) {
  return { name: GONDI_DOMAIN_NAME, version: GONDI_DOMAIN_VERSION, chainId, verifyingContract };
}

export const LOAN_OFFER_TYPES = Object.freeze({
  LoanOffer: [
    { name: 'offerId', type: 'uint256' },
    { name: 'lender', type: 'address' },
    { name: 'fee', type: 'uint256' },
    { name: 'capacity', type: 'uint256' },
    { name: 'nftCollateralAddress', type: 'address' },
    { name: 'nftCollateralTokenId', type: 'uint256' },
    { name: 'principalAddress', type: 'address' },
    { name: 'principalAmount', type: 'uint256' },
    { name: 'aprBps', type: 'uint256' },
    { name: 'expirationTime', type: 'uint256' },
    { name: 'duration', type: 'uint256' },
    { name: 'maxSeniorRepayment', type: 'uint256' },
    { name: 'validators', type: 'OfferValidator[]' },
    { name: 'lenderRefinanceDisabled', type: 'bool' },
    { name: 'borrower', type: 'address' },
  ],
  OfferValidator: [
    { name: 'validator', type: 'address' },
    { name: 'arguments', type: 'bytes' },
  ],
});

export const LOAN_TYPES = Object.freeze({
  Loan: [
    { name: 'borrower', type: 'address' },
    { name: 'nftCollateralTokenId', type: 'uint256' },
    { name: 'nftCollateralAddress', type: 'address' },
    { name: 'principalAddress', type: 'address' },
    { name: 'principalAmount', type: 'uint256' },
    { name: 'startTime', type: 'uint256' },
    { name: 'duration', type: 'uint256' },
    { name: 'tranche', type: 'Tranche[]' },
    { name: 'protocolFee', type: 'uint256' },
    { name: 'lenderRefinanceDisabled', type: 'bool' },
  ],
  Tranche: [
    { name: 'loanId', type: 'uint256' },
    { name: 'floor', type: 'uint256' },
    { name: 'principalAmount', type: 'uint256' },
    { name: 'lender', type: 'address' },
    { name: 'accruedInterest', type: 'uint256' },
    { name: 'startTime', type: 'uint256' },
    { name: 'aprBps', type: 'uint256' },
  ],
});

const UINT_FIELDS = [
  'offerId',
  'fee',
  'capacity',
  'nftCollateralTokenId',
  'principalAmount',
  'aprBps',
  'expirationTime',
  'duration',
  'maxSeniorRepayment',
];
const OFFER_KEYS = LOAN_OFFER_TYPES.LoanOffer.map((f) => f.name);

/** The venue's limits on an offer. The contract has almost none; these keep the book sane. */
export const OFFER_LIMITS = Object.freeze({
  maxPrincipalWei: 10n ** 21n, // 1,000 WETH
  maxAprBps: 100_000n, // 1,000% a year
  minDuration: 86_400n, // 1 day
  maxDuration: 365n * 86_400n,
  minOpenSeconds: 300n, // an offer must stay takeable for at least 5 minutes
  maxOpenSeconds: 30n * 86_400n,
  maxLoansPerOffer: 100n,
});

/** Gondi's whole-collection offer: token 0 plus one empty validator ("all IDs match"). */
export function wholeCollectionValidators() {
  return [{ validator: ZERO_ADDRESS, arguments: '0x' }];
}

/**
 * Gondi's `_checkValidators`, for the two shapes the venue takes. A non-zero token id is
 * always an exact match (Gondi's "backward comp" branch, even with the flag set); no
 * validators means an exact match too; one empty validator with token 0 takes any token.
 * Anything else (Gondi's plug-in validators) is not a shape this venue signs or shows.
 */
export function acceptsToken(offer, tokenId) {
  const offerToken = BigInt(offer.nftCollateralTokenId);
  const wanted = BigInt(tokenId);
  if (offerToken !== 0n) return offerToken === wanted;
  const v = offer.validators ?? [];
  if (v.length === 0) return wanted === 0n;
  return v.length === 1 && sameAddress(v[0].validator, ZERO_ADDRESS) && v[0].arguments === '0x';
}

export function isWholeCollectionOffer(offer) {
  const v = offer.validators ?? [];
  return (
    BigInt(offer.nftCollateralTokenId) === 0n &&
    v.length === 1 &&
    sameAddress(v[0].validator, ZERO_ADDRESS) &&
    v[0].arguments === '0x'
  );
}

/** How many loans an offer can fund: capacity 0 is Gondi's single-use offer. */
export function loansPerOffer(offer) {
  const capacity = BigInt(offer.capacity);
  const principal = BigInt(offer.principalAmount);
  if (capacity === 0n || principal === 0n) return 1n;
  return capacity / principal;
}

/** Offer with decimal-string numbers (the JSON the book stores) -> viem message (bigints). */
export function offerToMessage(json) {
  const out = { ...json };
  for (const k of UINT_FIELDS) out[k] = BigInt(json[k]);
  out.validators = json.validators.map((v) => ({ validator: v.validator, arguments: v.arguments }));
  return out;
}

/** viem message -> JSON with decimal strings and checksummed-as-given addresses. */
export function offerToJson(message) {
  const out = {};
  for (const k of OFFER_KEYS) out[k] = message[k];
  for (const k of UINT_FIELDS) out[k] = BigInt(message[k]).toString();
  out.validators = message.validators.map((v) => ({ validator: v.validator, arguments: v.arguments }));
  return out;
}

export function sameAddress(a, b) {
  return typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();
}

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const UINT_RE = /^(0|[1-9][0-9]{0,77})$/;
const MAX_UINT256 = (1n << 256n) - 1n;

/**
 * The venue's rules for an offer, on the JSON form. Returns `{ ok: true, offer }` (the
 * offer re-built from only the known keys) or `{ ok: false, error }` in plain words.
 * Same rules on the lend form (before signing) and in the book (before storing).
 */
export function validateOfferShape(json, nowSeconds) {
  if (!json || typeof json !== 'object' || Array.isArray(json)) return fail('Missing offer');
  const keys = Object.keys(json);
  if (keys.length !== OFFER_KEYS.length || !OFFER_KEYS.every((k) => keys.includes(k))) {
    return fail('Offer has missing or extra fields');
  }
  for (const k of UINT_FIELDS) {
    if (typeof json[k] !== 'string' || !UINT_RE.test(json[k]) || BigInt(json[k]) > MAX_UINT256) {
      return fail(`${k} must be a whole number`);
    }
  }
  for (const k of ['lender', 'nftCollateralAddress', 'principalAddress', 'borrower']) {
    if (typeof json[k] !== 'string' || !ADDRESS_RE.test(json[k])) return fail(`${k} must be an address`);
  }
  if (typeof json.lenderRefinanceDisabled !== 'boolean') return fail('lenderRefinanceDisabled must be true or false');
  if (!Array.isArray(json.validators)) return fail('validators must be a list');

  const now = BigInt(nowSeconds);
  const principal = BigInt(json.principalAmount);
  const capacity = BigInt(json.capacity);
  const apr = BigInt(json.aprBps);
  const duration = BigInt(json.duration);
  const expiry = BigInt(json.expirationTime);

  if (sameAddress(json.lender, ZERO_ADDRESS)) return fail('No lender');
  if (!LENDING_COLLECTIONS.some((c) => sameAddress(c.address, json.nftCollateralAddress))) {
    return fail('That collection is not on this venue');
  }
  if (!sameAddress(json.principalAddress, WETH_ADDRESS)) return fail('Offers are in WETH only');
  if (principal === 0n || principal > OFFER_LIMITS.maxPrincipalWei) return fail('Loan amount must be above 0 and at most 1,000 WETH');
  if (apr === 0n || apr > OFFER_LIMITS.maxAprBps) return fail('APR must be above 0% and at most 1,000%');
  if (duration < OFFER_LIMITS.minDuration || duration > OFFER_LIMITS.maxDuration) return fail('Loan length must be 1 to 365 days');
  if (expiry < now + OFFER_LIMITS.minOpenSeconds) return fail('Offer expires too soon');
  if (expiry > now + OFFER_LIMITS.maxOpenSeconds) return fail('Offers can stay open 30 days at most');
  if (capacity !== 0n && (capacity < principal || capacity > principal * OFFER_LIMITS.maxLoansPerOffer)) {
    return fail('An offer can fund 1 to 100 loans');
  }
  // Shapes the venue does not offer: an opening fee, a junior tranche, a private
  // borrower, opting out of refinancing.
  if (BigInt(json.fee) !== 0n) return fail('Opening fees are not offered');
  if (BigInt(json.maxSeniorRepayment) !== 0n) return fail('maxSeniorRepayment must be 0');
  if (!sameAddress(json.borrower, ZERO_ADDRESS)) return fail('Private offers are not offered');
  if (json.lenderRefinanceDisabled !== false) return fail('lenderRefinanceDisabled must be false');

  const token = BigInt(json.nftCollateralTokenId);
  if (token === 0n) {
    const v = json.validators;
    const whole =
      v.length === 1 &&
      v[0] &&
      typeof v[0] === 'object' &&
      Object.keys(v[0]).length === 2 &&
      typeof v[0].validator === 'string' &&
      sameAddress(v[0].validator, ZERO_ADDRESS) &&
      v[0].arguments === '0x';
    if (!whole) return fail('A whole-collection offer needs token 0 and one empty validator');
  } else if (json.validators.length !== 0) {
    return fail('A one-NFT offer takes no validators');
  }

  const offer = {};
  for (const k of OFFER_KEYS) offer[k] = json[k];
  offer.validators = json.validators.map((x) => ({ validator: x.validator, arguments: x.arguments }));
  return { ok: true, offer };
}

function fail(error) {
  return { ok: false, error };
}
