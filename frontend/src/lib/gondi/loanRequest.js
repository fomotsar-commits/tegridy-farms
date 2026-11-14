// A borrower's request for a loan: "I hold this NFT and want this much WETH, for this long,
// at this rate or lower". Lenders see it on the Lend tab and answer with an ordinary signed
// offer on that one NFT (loanOffer.js), which the borrower then takes as usual.
//
// How money moves: it does not. A request is a note. It is signed so the book can tell the
// NFT's holder wrote it, under its OWN signing domain: a different name from Gondi's, and no
// verifying contract. No contract reads this domain, so the signature can lock nothing, lend
// nothing and approve nothing. The venue and lenders earn only if a loan follows, exactly as
// for any other offer. The wallet shows the domain's name, so it is the venue's own.
import { LENDING_COLLECTIONS, LOAN_CHAIN_ID, OFFER_LIMITS, ZERO_ADDRESS, acceptsToken, sameAddress } from './loanOffer.js';

export const REQUEST_DOMAIN_NAME = 'memetics.finance loan request';
export const REQUEST_DOMAIN_VERSION = '1';

export function requestDomain(chainId = LOAN_CHAIN_ID) {
  return { name: REQUEST_DOMAIN_NAME, version: REQUEST_DOMAIN_VERSION, chainId };
}

export const LOAN_REQUEST_TYPES = Object.freeze({
  LoanRequest: [
    { name: 'borrower', type: 'address' },
    { name: 'nftCollateralAddress', type: 'address' },
    { name: 'nftCollateralTokenId', type: 'uint256' },
    { name: 'principalAmount', type: 'uint256' },
    { name: 'maxAprBps', type: 'uint256' },
    { name: 'duration', type: 'uint256' },
    { name: 'expirationTime', type: 'uint256' },
    { name: 'nonce', type: 'uint256' },
  ],
});

export const CANCEL_REQUEST_TYPES = Object.freeze({
  CancelLoanRequest: [
    { name: 'borrower', type: 'address' },
    { name: 'nonce', type: 'uint256' },
  ],
});

const UINT_FIELDS = ['nftCollateralTokenId', 'principalAmount', 'maxAprBps', 'duration', 'expirationTime', 'nonce'];
const REQUEST_KEYS = LOAN_REQUEST_TYPES.LoanRequest.map((f) => f.name);
const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const UINT_RE = /^(0|[1-9][0-9]{0,77})$/;
const MAX_UINT256 = (1n << 256n) - 1n;

/** Request with decimal-string numbers (the JSON the book stores) -> viem message (bigints). */
export function requestToMessage(json) {
  const out = { ...json };
  for (const k of UINT_FIELDS) out[k] = BigInt(json[k]);
  return out;
}

/**
 * The venue's rules for a request, on the JSON form. Returns `{ ok: true, request }` (rebuilt
 * from only the known keys) or `{ ok: false, error }` in plain words. The limits are the
 * offer's own (OFFER_LIMITS), so every request the book holds can be answered by an offer
 * the book accepts. Same rules on the ask form (before signing) and in the book.
 */
export function validateRequestShape(json, nowSeconds) {
  if (!json || typeof json !== 'object' || Array.isArray(json)) return fail('Missing request');
  const keys = Object.keys(json);
  if (keys.length !== REQUEST_KEYS.length || !REQUEST_KEYS.every((k) => keys.includes(k))) {
    return fail('Request has missing or extra fields');
  }
  for (const k of UINT_FIELDS) {
    if (typeof json[k] !== 'string' || !UINT_RE.test(json[k]) || BigInt(json[k]) > MAX_UINT256) {
      return fail(`${k} must be a whole number`);
    }
  }
  for (const k of ['borrower', 'nftCollateralAddress']) {
    if (typeof json[k] !== 'string' || !ADDRESS_RE.test(json[k])) return fail(`${k} must be an address`);
  }

  const now = BigInt(nowSeconds);
  const principal = BigInt(json.principalAmount);
  const apr = BigInt(json.maxAprBps);
  const duration = BigInt(json.duration);
  const expiry = BigInt(json.expirationTime);

  if (sameAddress(json.borrower, ZERO_ADDRESS)) return fail('No borrower');
  if (!LENDING_COLLECTIONS.some((c) => sameAddress(c.address, json.nftCollateralAddress))) {
    return fail('That collection is not on this venue');
  }
  // An offer on one NFT cannot name token #0 (Gondi reads 0 as "any"), so a request for it
  // could never be answered the way the Lend tab answers one.
  if (BigInt(json.nftCollateralTokenId) === 0n) return fail('Token #0 cannot be named in an offer, so it cannot be asked for here');
  if (principal === 0n || principal > OFFER_LIMITS.maxPrincipalWei) return fail('Loan amount must be above 0 and at most 1,000 WETH');
  if (apr === 0n || apr > OFFER_LIMITS.maxAprBps) return fail('Highest APR must be above 0% and at most 1,000%');
  if (duration < OFFER_LIMITS.minDuration || duration > OFFER_LIMITS.maxDuration) return fail('Loan length must be 1 to 365 days');
  if (expiry < now + OFFER_LIMITS.minOpenSeconds) return fail('Request expires too soon');
  if (expiry > now + OFFER_LIMITS.maxOpenSeconds) return fail('Requests can stay open 30 days at most');

  const request = {};
  for (const k of REQUEST_KEYS) request[k] = json[k];
  return { ok: true, request };
}

/**
 * Does this offer answer this request? The one NFT (or any NFT of its collection), at least
 * the amount asked, at the asked rate or lower, for at least the asked length.
 */
export function offerAnswersRequest(offer, request) {
  if (!sameAddress(offer.nftCollateralAddress, request.nftCollateralAddress)) return false;
  if (!acceptsToken(offer, request.nftCollateralTokenId)) return false;
  return (
    BigInt(offer.principalAmount) >= BigInt(request.principalAmount) &&
    BigInt(offer.aprBps) <= BigInt(request.maxAprBps) &&
    BigInt(offer.duration) >= BigInt(request.duration)
  );
}

function fail(error) {
  return { ok: false, error };
}
