// @vitest-environment node
//
// The bot's own check of what the signer signed: real EIP-712 signatures from a test key, the
// order compared field by field with what was asked, and the order hash compared with Seaport's.
// The fixture hash at the bottom was read from the Seaport 1.6 contract on mainnet (eth_call of
// getOrderHash, read-only), so the local hashing is proven equal to Seaport's own.
import { describe, it, expect } from 'vitest';
import { encodeFunctionData } from 'viem';
import { checkBuild, checkSignedBid, verifySignedBid, localOrderHash, orderComponentsFrom, seaportOrderHash, GET_ORDER_HASH_ABI } from '../verify.mjs';
import { COLLECTIONS, VENUE_FEE_SAFE } from '../../brain/constants.mjs';
import { fakeSigner, standardBuild, testAccount, testPolicy, milli } from './fakes.mjs';

const house = testAccount(1).address.toLowerCase();
const policy = testPolicy(house);
const T = 1_794_800_000;
const request = (over = {}) => ({ slug: 'junglebay', qty: 2, unitPriceWei: milli(35), startTime: T, endTime: T + 1800, build: standardBuild(house, 'junglebay', 2), ...over });

async function signed(over = {}, signerOpts = {}) {
  const req = request(over);
  const resp = await fakeSigner({ policy: signerOpts.policy ?? policy, ...signerOpts }).signBid(req);
  return { req, resp };
}

describe('checkBuild', () => {
  it('accepts OpenSea’s collection-bid build for the house', () => {
    expect(checkBuild(standardBuild(house, 'junglebay', 2), { slug: 'junglebay', qty: 2, house }).ok).toBe(true);
  });

  it('accepts the build shape OpenSea returned live (code-map/raw/opensea-build16-junglebay.json)', () => {
    // partialParameters as OpenSea sent them, with the offerer swapped for the test house
    const live = { zone: '0x000056f7000000ece9003ca63978907a00ffd100', zoneHash: '0x0000000000000000000000000000000000000000000000000000000000000000', consideration: [{ itemType: 4, token: '0xd37264c71e9af940e49795f0d3a8336afaafdda9', identifierOrCriteria: '0', startAmount: '1', endAmount: '1', recipient: house }] };
    expect(checkBuild(live, { slug: 'junglebay', qty: 1, house })).toEqual({ ok: true, problems: [] });
  });

  it('refuses anything else, naming what is wrong', () => {
    const b = standardBuild(house, 'junglebay', 1);
    expect(checkBuild({ ...b, consideration: [] }, { slug: 'junglebay', qty: 1, house }).problems[0]).toMatch(/0 consideration lines/);
    expect(checkBuild({ ...b, consideration: [{ ...b.consideration[0], itemType: 2 }] }, { slug: 'junglebay', qty: 1, house }).ok).toBe(false);
    expect(checkBuild({ ...b, consideration: [{ ...b.consideration[0], token: COLLECTIONS.gnssart.address }] }, { slug: 'junglebay', qty: 1, house }).ok).toBe(false);
    expect(checkBuild(null, { slug: 'junglebay', qty: 1, house }).ok).toBe(false);
  });
});

describe('checkSignedBid and verifySignedBid', () => {
  const getOrderHash = async (c) => localOrderHash(c);

  it('accepts a correct signature over the order asked for', async () => {
    const { req, resp } = await signed();
    const v = await verifySignedBid({ request: req, response: resp, build: req.build, house, policy, getOrderHash });
    expect(v.ok).toBe(true);
  });

  it('accepts a quantity-1 bid signed FULL_RESTRICTED and refuses a quantity-2 bid that cannot be partly filled', async () => {
    const one = await signed({ qty: 1, build: standardBuild(house, 'junglebay', 1) });
    expect(checkSignedBid({ request: one.req, response: one.resp, build: one.req.build, house, policy }).ok).toBe(true);
    const two = await signed();
    const bad = { ...two.resp, parameters: { ...two.resp.parameters, orderType: 2 } };
    expect(checkSignedBid({ request: two.req, response: bad, build: two.req.build, house, policy }).problems.join()).toMatch(/partial fills/);
  });

  it('refuses a signature from any other key', async () => {
    const { req, resp } = await signed({}, { keyN: 3 });
    // the order names the house, the signature is key 3's: the offerer check or the recovery fails
    const v = await verifySignedBid({ request: req, response: { ...resp, parameters: { ...resp.parameters, offerer: house } }, build: req.build, house, policy, getOrderHash });
    expect(v.ok).toBe(false);
    expect(v.field).toBe('signature');
  });

  it('refuses an order that is not what was asked: price, quantity, times, lines', async () => {
    const { req, resp } = await signed();
    const check = (r) => checkSignedBid({ request: req, response: r, build: req.build, house, policy });
    const p = resp.parameters;
    expect(check({ ...resp, parameters: { ...p, endTime: String(T + 3600) } }).ok).toBe(false);
    expect(check({ ...resp, parameters: { ...p, zone: '0x0000000000000000000000000000000000000000' } }).ok).toBe(false);
    expect(check({ ...resp, parameters: { ...p, conduitKey: `0x${'00'.repeat(32)}` } }).ok).toBe(false);
    const extra = { ...p.consideration[1], recipient: '0x6666666666666666666666666666666666666666' };
    expect(check({ ...resp, parameters: { ...p, consideration: [...p.consideration, extra], totalOriginalConsiderationItems: 3 } }).problems.join()).toMatch(/further fee lines/);
    const cheapFee = { ...p.consideration[1], startAmount: '1', endAmount: '1' };
    expect(check({ ...resp, parameters: { ...p, consideration: [p.consideration[0], cheapFee] } }).problems.join()).toMatch(/OpenSea's exact 1%/);
    expect(check({ ...resp, parameters: { ...p, totalOriginalConsiderationItems: 3 } }).ok).toBe(false);
    expect(check({ ...resp, signature: '0x1234' }).ok).toBe(false);
  });

  it('requires exactly the optional lines the policy turns on, creator and venue', async () => {
    const withFees = testPolicy(house, { venueFee: { recipient: VENUE_FEE_SAFE, bps: 50 } });
    withFees.collections.junglebay.creatorFee = { recipient: '0xa3cc58eaa3800dc163726e031a2da49a9bb64eb3', bps: 700 };
    const { req, resp } = await signed({}, { policy: withFees });
    expect(resp.parameters.consideration).toHaveLength(4);
    expect(checkSignedBid({ request: req, response: resp, build: req.build, house, policy: withFees }).ok).toBe(true);
    // the same order checked against a policy with the lines off is refused
    expect(checkSignedBid({ request: req, response: resp, build: req.build, house, policy }).ok).toBe(false);
  });

  it('refuses when the hash Seaport gives differs, and reports an unreachable Seaport as such', async () => {
    const { req, resp } = await signed();
    const wrong = await verifySignedBid({ request: req, response: resp, build: req.build, house, policy, getOrderHash: async () => `0x${'12'.repeat(32)}` });
    expect(wrong).toMatchObject({ ok: false, field: 'orderHash' });
    const down = await verifySignedBid({ request: req, response: resp, build: req.build, house, policy, getOrderHash: async () => Promise.reject(new Error('timeout')) });
    expect(down).toMatchObject({ ok: false, field: 'verify-unavailable' });
  });

  it('refuses an order hash that is not the hash of the signed order', async () => {
    const { req, resp } = await signed();
    const v = await verifySignedBid({ request: req, response: { ...resp, orderHash: `0x${'34'.repeat(32)}` }, build: req.build, house, policy, getOrderHash });
    expect(v.field).toBe('orderHash');
  });
});

describe('Seaport 1.6 getOrderHash', () => {
  // A fixed order (test house = keccak256("house-bidder test key 1")'s address
  // 0xbd00483ccb69c4fcc2f9f28e87fc29eeb308effa, which has no code on mainnet), hashed by the
  // Seaport 1.6 contract with eth_call at block 26,424,233 (2026-11-16 01:16 UTC, read-only,
  // eth.drpc.org), counter 7.
  const fixture = {
    offerer: house,
    zone: '0x000056f7000000ece9003ca63978907a00ffd100',
    offer: [{ itemType: 1, token: '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2', identifierOrCriteria: '0', startAmount: '70000000000000000', endAmount: '70000000000000000' }],
    consideration: [
      { itemType: 4, token: '0xd37264c71e9af940e49795f0d3a8336afaafdda9', identifierOrCriteria: '0', startAmount: '2', endAmount: '2', recipient: house },
      { itemType: 1, token: '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2', identifierOrCriteria: '0', startAmount: '700000000000000', endAmount: '700000000000000', recipient: '0x0000a26b00c1f0df003000390027140000faa719' },
    ],
    orderType: 3,
    startTime: '1794800000',
    endTime: '1794801800',
    zoneHash: `0x${'00'.repeat(32)}`,
    salt: '0x00000000000000000000000000000000000000000000000000000000000003e9',
    conduitKey: '0x0000007b02230091a7ed01230072f7006a004d60a8d4e71d599b8104250f0000',
    totalOriginalConsiderationItems: 2,
  };
  const SEAPORT_SAYS = '0xa34c31eea72ced42f03b23e3b6921187bf23979d0973a1822df5b737646863ed';

  it('encodes the call Seaport expects (selector 0x79df72bd)', () => {
    const data = encodeFunctionData({ abi: GET_ORDER_HASH_ABI, functionName: 'getOrderHash', args: [orderComponentsFrom(fixture, 7n)] });
    expect(data.slice(0, 10)).toBe('0x79df72bd');
  });

  it('hashes the fixture exactly as the Seaport 1.6 contract did', () => {
    expect(localOrderHash(orderComponentsFrom(fixture, 7n))).toBe(SEAPORT_SAYS);
  });

  it('decodes an eth_call answer into the hash', async () => {
    const reader = seaportOrderHash(async ({ to, data }) => {
      expect(to).toBe('0x0000000000000068f116a894984e2db1123eb395');
      expect(data.startsWith('0x79df72bd')).toBe(true);
      return SEAPORT_SAYS;
    });
    expect(await reader(orderComponentsFrom(fixture, 7n))).toBe(SEAPORT_SAYS);
  });
});
