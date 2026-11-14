import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { encodeAbiParameters, hashStruct, hashTypedData, keccak256, toBytes, concat, type Address, type Hex } from 'viem';
import {
  GONDI_DOMAIN_NAME,
  GONDI_DOMAIN_VERSION,
  LOAN_OFFER_TYPES,
  LOAN_TYPES,
  WETH_ADDRESS,
  ZERO_ADDRESS,
  acceptsToken,
  gondiDomain,
  isWholeCollectionOffer,
  loansPerOffer,
  offerToJson,
  offerToMessage,
  validateOfferShape,
  wholeCollectionValidators,
  type LoanOfferJson,
} from './loanOffer.js';

// Gondi's own type strings, read from the vendored source the contract is built from.

const VENDOR_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../contracts/vendor/gondi-v3.2');
const HASH_SOL = readFileSync(
  resolve(VENDOR_ROOT, 'sources/src/lib/utils/Hash.sol'),
  'utf8',
);
function gondiTypeString(constant: string): string {
  const m = HASH_SOL.match(new RegExp(`${constant} = keccak256\\(\\s*"([^"]+)"`));
  if (!m) throw new Error(`${constant} not found in Hash.sol`);
  return m[1]!;
}
const BASE_LOAN_SOL = readFileSync(
  resolve(VENDOR_ROOT, 'sources/src/lib/loans/BaseLoan.sol'),
  'utf8',
);
const MSL_SOL = readFileSync(
  resolve(VENDOR_ROOT, 'sources/src/lib/loans/MultiSourceLoan.sol'),
  'utf8',
);

const NAKA = '0xd774557b647330C91Bf44cfEAB205095f7E6c367' as Address;
const LENDER = '0x1111111111111111111111111111111111111111' as Address;
const LOAN = '0x2222222222222222222222222222222222222222' as Address;
const NOW = 1_800_000_000;

function offer(overrides: Partial<LoanOfferJson> = {}): LoanOfferJson {
  return {
    offerId: '42',
    lender: LENDER,
    fee: '0',
    capacity: '0',
    nftCollateralAddress: NAKA,
    nftCollateralTokenId: '0',
    principalAddress: WETH_ADDRESS,
    principalAmount: '1000000000000000000',
    aprBps: '1000',
    expirationTime: String(NOW + 7 * 86400),
    duration: String(30 * 86400),
    maxSeniorRepayment: '0',
    validators: wholeCollectionValidators(),
    lenderRefinanceDisabled: false,
    borrower: ZERO_ADDRESS,
    ...overrides,
  };
}

// Gondi's Hash.hash(LoanOffer) and BaseLoan._computeDomainSeparator, written out with
// abi.encode the way the Solidity does it.
function gondiOfferDigest(o: LoanOfferJson, verifyingContract: Address): Hex {
  const validatorTypehash = keccak256(toBytes(gondiTypeString('_VALIDATOR_HASH')));
  const offerTypehash = keccak256(toBytes(gondiTypeString('_LOAN_OFFER_HASH')));
  const validators = concat(
    o.validators.map((v) =>
      keccak256(
        encodeAbiParameters(
          [{ type: 'bytes32' }, { type: 'address' }, { type: 'bytes32' }],
          [validatorTypehash, v.validator, keccak256(v.arguments)],
        ),
      ),
    ),
  );
  const structHash = keccak256(
    encodeAbiParameters(
      [
        { type: 'bytes32' }, { type: 'uint256' }, { type: 'address' }, { type: 'uint256' }, { type: 'uint256' },
        { type: 'address' }, { type: 'uint256' }, { type: 'address' }, { type: 'uint256' }, { type: 'uint256' },
        { type: 'uint256' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'bytes32' }, { type: 'bool' }, { type: 'address' },
      ],
      [
        offerTypehash, BigInt(o.offerId), o.lender, BigInt(o.fee), BigInt(o.capacity), o.nftCollateralAddress,
        BigInt(o.nftCollateralTokenId), o.principalAddress, BigInt(o.principalAmount), BigInt(o.aprBps),
        BigInt(o.expirationTime), BigInt(o.duration), BigInt(o.maxSeniorRepayment),
        keccak256(o.validators.length ? validators : '0x'), o.lenderRefinanceDisabled, o.borrower,
      ],
    ),
  );
  const domainSeparator = keccak256(
    encodeAbiParameters(
      [{ type: 'bytes32' }, { type: 'bytes32' }, { type: 'bytes32' }, { type: 'uint256' }, { type: 'address' }],
      [
        keccak256(toBytes('EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)')),
        keccak256(toBytes(GONDI_DOMAIN_NAME)),
        keccak256(toBytes(GONDI_DOMAIN_VERSION)),
        1n,
        verifyingContract,
      ],
    ),
  );
  return keccak256(concat(['0x1901', domainSeparator, structHash]));
}

describe('Gondi signed offer: the shape the contract checks', () => {
  it('domain name and version are the ones in Gondi\'s source', () => {
    expect(MSL_SOL).toContain(`"${GONDI_DOMAIN_NAME}"`);
    expect(BASE_LOAN_SOL).toContain(`VERSION = "${GONDI_DOMAIN_VERSION}"`);
  });

  it.each([
    ['whole collection', offer()],
    ['one NFT', offer({ nftCollateralTokenId: '4242', validators: [] })],
    ['capacity + odd numbers', offer({ offerId: '281474976710655', capacity: '3000000000000000000', aprBps: '1' })],
  ])('viem signs the same digest Gondi verifies (%s)', (_label, o) => {
    const viemDigest = hashTypedData({
      domain: gondiDomain(LOAN),
      types: LOAN_OFFER_TYPES as unknown as Record<string, { name: string; type: string }[]>,
      primaryType: 'LoanOffer',
      message: offerToMessage(o) as unknown as Record<string, unknown>,
    });
    expect(viemDigest).toBe(gondiOfferDigest(o, LOAN));
  });

  it('a loan hashes the way Gondi\'s getLoanHash stores it', () => {
    const loan = {
      borrower: LENDER,
      nftCollateralTokenId: 4242n,
      nftCollateralAddress: NAKA,
      principalAddress: WETH_ADDRESS,
      principalAmount: 10n ** 18n,
      startTime: 1_800_000_000n,
      duration: 2_592_000n,
      tranche: [
        { loanId: 7n, floor: 0n, principalAmount: 10n ** 18n, lender: LOAN, accruedInterest: 0n, startTime: 1_800_000_000n, aprBps: 1000n },
      ],
      protocolFee: 500n,
      lenderRefinanceDisabled: false,
    };
    const trancheTypehash = keccak256(toBytes(gondiTypeString('_TRANCHE_HASH')));
    const t = loan.tranche[0]!;
    const trancheHash = keccak256(
      encodeAbiParameters(
        [{ type: 'bytes32' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'address' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'uint256' }],
        [trancheTypehash, t.loanId, t.floor, t.principalAmount, t.lender, t.accruedInterest, t.startTime, t.aprBps],
      ),
    );
    const gondi = keccak256(
      encodeAbiParameters(
        [{ type: 'bytes32' }, { type: 'address' }, { type: 'uint256' }, { type: 'address' }, { type: 'address' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'bytes32' }, { type: 'uint256' }, { type: 'bool' }],
        [keccak256(toBytes(gondiTypeString('_MULTI_SOURCE_LOAN_HASH'))), loan.borrower, loan.nftCollateralTokenId, loan.nftCollateralAddress, loan.principalAddress, loan.principalAmount, loan.startTime, loan.duration, keccak256(trancheHash), loan.protocolFee, loan.lenderRefinanceDisabled],
      ),
    );
    const viem = hashStruct({
      types: LOAN_TYPES as unknown as Record<string, { name: string; type: string }[]>,
      primaryType: 'Loan',
      data: loan as unknown as Record<string, unknown>,
    });
    expect(viem).toBe(gondi);
  });

  it('JSON and message forms round-trip', () => {
    const o = offer({ nftCollateralTokenId: '9', validators: [] });
    expect(offerToJson(offerToMessage(o))).toEqual(o);
  });
});

describe('which NFT an offer takes (Gondi _checkValidators)', () => {
  it('a whole-collection offer takes any token, a one-NFT offer only its own', () => {
    expect(acceptsToken(offer(), 1n)).toBe(true);
    expect(acceptsToken(offer(), 999_999n)).toBe(true);
    expect(isWholeCollectionOffer(offer())).toBe(true);
    const one = offer({ nftCollateralTokenId: '4242', validators: [] });
    expect(acceptsToken(one, 4242n)).toBe(true);
    expect(acceptsToken(one, 4243n)).toBe(false);
    expect(isWholeCollectionOffer(one)).toBe(false);
  });

  it('keeps Gondi\'s odd cases: the flag with a token id is still exact; no validators + token 0 is token 0 only', () => {
    const flagged = offer({ nftCollateralTokenId: '5' });
    expect(acceptsToken(flagged, 5n)).toBe(true);
    expect(acceptsToken(flagged, 6n)).toBe(false);
    expect(isWholeCollectionOffer(flagged)).toBe(false);
    const bare = offer({ validators: [] });
    expect(acceptsToken(bare, 0n)).toBe(true);
    expect(acceptsToken(bare, 1n)).toBe(false);
  });

  it('a plug-in validator is not taken for any token', () => {
    const plugin = offer({ validators: [{ validator: LOAN, arguments: '0x01' }] });
    expect(acceptsToken(plugin, 1n)).toBe(false);
  });

  it('loans per offer: capacity 0 is single use', () => {
    expect(loansPerOffer(offer())).toBe(1n);
    expect(loansPerOffer(offer({ capacity: '3000000000000000000' }))).toBe(3n);
  });
});

describe('the venue\'s offer rules', () => {
  it('takes a whole-collection offer and a one-NFT offer', () => {
    expect(validateOfferShape(offer(), NOW)).toEqual({ ok: true, offer: offer() });
    const one = offer({ nftCollateralTokenId: '4242', validators: [] });
    expect(validateOfferShape(one, NOW)).toEqual({ ok: true, offer: one });
  });

  it.each<[string, Partial<LoanOfferJson> | Record<string, unknown>, RegExp]>([
    ['another collection', { nftCollateralAddress: '0xBC4CA0EdA7647A8aB7C2061c2E118A18a936f13D' }, /not on this venue/],
    ['another currency', { principalAddress: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48' }, /WETH only/],
    ['an opening fee', { fee: '1' }, /Opening fees/],
    ['a private borrower', { borrower: LENDER }, /Private offers/],
    ['a junior tranche', { maxSeniorRepayment: '1' }, /maxSeniorRepayment/],
    ['no refinance', { lenderRefinanceDisabled: true }, /lenderRefinanceDisabled/],
    ['zero APR', { aprBps: '0' }, /APR/],
    ['a 2-year loan', { duration: String(730 * 86400) }, /1 to 365 days/],
    ['an expired offer', { expirationTime: String(NOW - 1) }, /too soon/],
    ['a 90-day offer', { expirationTime: String(NOW + 90 * 86400) }, /30 days/],
    ['capacity below one loan', { capacity: '1' }, /1 to 100 loans/],
    ['token 0 with no validators', { validators: [] }, /whole-collection offer needs/],
    ['a plug-in validator', { validators: [{ validator: LOAN, arguments: '0x' }] }, /whole-collection offer needs/],
    ['a token id plus the empty validator', { nftCollateralTokenId: '7' }, /one-NFT offer takes no validators/],
    ['a number with a sign', { principalAmount: '+1' }, /whole number/],
    ['a hex number', { aprBps: '0x10' }, /whole number/],
    ['an extra field', { extra: 'x' }, /missing or extra/],
  ])('refuses %s', (_label, overrides, error) => {
    const result = validateOfferShape({ ...offer(), ...overrides }, NOW);
    expect(result.ok).toBe(false);
    expect(result.ok ? '' : result.error).toMatch(error);
  });
});
