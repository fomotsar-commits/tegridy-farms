// The order builder: from the inputs the signer receives (slug, qty, unit price, times, the
// build's NFT line) and its own salt and counter, the exact OrderComponents viem hashed in
// the fixture, and the parameters in the shape OpenSea's POST /api/v2/offers takes.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildBidOrder, fromJsonParameters, toJsonParameters } from '../src/order.mjs';
import { hashOrderComponents } from '../src/eip712.mjs';
import { FIXTURE, makePolicy } from './support/helpers.mjs';

const lowerItems = (items) => items.map((i) => Object.fromEntries(Object.entries(i).map(([k, v]) => [k, typeof v === 'string' && v.startsWith('0x') ? v.toLowerCase() : v])));

for (const o of FIXTURE.orders) {
  test(`buildBidOrder reproduces the fixture order exactly: ${o.name}`, () => {
    const { input, policyFees } = o;
    const house = o.components.offerer.toLowerCase();
    const policy = makePolicy((p) => {
      p.house = o.components.offerer;
      p.collections[input.slug].enabled = true;
      p.collections[input.slug].maxQty = 2;
      if (policyFees.creator) p.collections[input.slug].creatorFee = { recipient: input.slug === 'junglebay' ? '0xa3cc58eaa3800dc163726e031a2da49a9bb64eb3' : '0x209aa937ac59f60384a70b98fec5daf54ac7b967', bps: policyFees.creator };
      if (policyFees.venue) p.venueFee = { recipient: '0x7D2620243EdAd69Ec81A53c4A063B07995A4Bd7d', bps: 50 };
    });
    const nft = o.components.consideration[0];
    const nftLine = { itemType: 4, token: nft.token.toLowerCase(), identifierOrCriteria: 0n, startAmount: BigInt(nft.startAmount), endAmount: BigInt(nft.endAmount), recipient: house };
    const order = buildBidOrder({
      policy, slug: input.slug, qty: input.qty, unitPriceWei: BigInt(input.unitPriceWei), startTime: input.startTime, endTime: input.endTime, nftLine, house, salt: BigInt(input.salt), counter: BigInt(input.counter),
    });
    assert.equal(hashOrderComponents(order), o.orderHash);
    const json = toJsonParameters(order);
    assert.deepEqual(lowerItems(json.consideration), lowerItems(o.components.consideration));
    assert.deepEqual(lowerItems(json.offer), lowerItems(o.components.offer));
    assert.equal(json.orderType, 3);
    assert.equal(json.totalOriginalConsiderationItems, o.components.consideration.length);
    assert.equal(json.counter, o.components.counter);
    assert.equal(BigInt(json.salt), BigInt(o.components.salt));
  });
}

test('parameters use the OpenSea SeaportParameters shape: strings for amounts and times, numbers for types, counter included', () => {
  const o = FIXTURE.orders[1];
  const policy = makePolicy((p) => {
    p.collections.junglebay.creatorFee = { recipient: '0xa3cc58eaa3800dc163726e031a2da49a9bb64eb3', bps: 700 };
    p.venueFee = { recipient: '0x7D2620243EdAd69Ec81A53c4A063B07995A4Bd7d', bps: 50 };
  });
  const house = o.components.offerer.toLowerCase();
  const order = buildBidOrder({
    policy, slug: 'junglebay', qty: 2, unitPriceWei: 40_000_000_000_000_000n, startTime: 1_763_251_200, endTime: 1_763_253_000,
    nftLine: { itemType: 4, token: '0xd37264c71e9af940e49795f0d3a8336afaafdda9', identifierOrCriteria: 0n, startAmount: 2n, endAmount: 2n, recipient: house },
    house, salt: 0xabcn, counter: 5n,
  });
  const json = toJsonParameters(order);
  assert.deepEqual(Object.keys(json).sort(), ['conduitKey', 'consideration', 'counter', 'endTime', 'offer', 'offerer', 'orderType', 'salt', 'startTime', 'totalOriginalConsiderationItems', 'zone', 'zoneHash']);
  assert.equal(typeof json.startTime, 'string');
  assert.equal(typeof json.offer[0].startAmount, 'string');
  assert.equal(typeof json.offer[0].itemType, 'number');
  assert.equal(json.salt, `0x${'0'.repeat(61)}abc`);
  assert.equal(json.counter, '5');
  assert.equal(json.offer[0].startAmount, '80000000000000000');
  assert.equal('recipient' in json.offer[0], false);
  // JSON round trip (as stored in signer-orders.jsonl) gives back the same order hash.
  const back = fromJsonParameters(JSON.parse(JSON.stringify(json)));
  assert.equal(hashOrderComponents(back), hashOrderComponents(order));
});
