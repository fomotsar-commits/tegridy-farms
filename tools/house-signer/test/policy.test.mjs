// Every pin in src/policy.mjs, one named case each: a valid input, changed in exactly one
// way, must be refused by exactly that pin (the refusal's field is the pin id). The test
// titles carry the pin ids; test/mutate.mjs checks that removing a pin fails its own test.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  checkBidOrder, checkBidRequest, checkCancelRequest, checkTx, checkTxRequest, normalFeeCap, orderTypeForBid, validatePolicy,
} from '../src/policy.mjs';
import { buildBidOrder } from '../src/order.mjs';
import { buildCall, gasLimitFor } from '../src/tx.mjs';
import { SEAPORT_DOMAIN } from '../src/eip712.mjs';
import { encodeCall, SIGNATURES, ORDER_COMPONENTS, componentsTuple } from '../src/abi.mjs';
import {
  bidRequest, buildFor, FUNDING, GNSS, HOUSE, JBAC, makePolicy, OTHER, rawPolicy, STRANGER, ZERO32,
} from './support/helpers.mjs';

const NOW = 1_763_251_200;
const WETH = '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2';
const SEAPORT = '0x0000000000000068f116a894984e2db1123eb395';
const CONDUIT = '0x1e0049783f008a0085193e00003d00cd54003c71';
const OS_FEE = '0x0000a26b00c1f0df003000390027140000faa719';
const VENUE = '0x7d2620243edad69ec81a53c4a063b07995a4bd7d';
const JBAC_CREATOR = '0xa3cc58eaa3800dc163726e031a2da49a9bb64eb3';

const refusedBy = (result, pin) => {
  assert.equal(result.ok, false, `expected a refusal by ${pin}, got ok`);
  assert.equal(result.field, pin, `expected ${pin}, refused by ${result.field}: ${result.reason}`);
  assert.equal(typeof result.reason, 'string');
};

// ---------------------------------------------------------------------------------------
// policy.json
// ---------------------------------------------------------------------------------------

test('a valid policy is accepted and normalized', () => {
  const v = validatePolicy(rawPolicy());
  assert.equal(v.ok, true, v.reason);
  assert.equal(v.policy.house, HOUSE.toLowerCase());
  assert.equal(v.policy.collections.junglebay.maxUnitPriceWei, 45_000_000_000_000_000n);
  assert.equal(v.policy.gas.priorityWei, 50_000_000n);
  assert.equal(v.policy.gas.killPriorityWei, 2_000_000_000n);
  assert.equal(v.policy.gas.maxFeeWei, 20_000_000_000n);
  assert.equal(normalFeeCap(v.policy), 16_000_000_000n);
  const withFees = validatePolicy(rawPolicy((p) => {
    p.collections.junglebay.creatorFee = { recipient: '0xa3cc58eaa3800dc163726e031a2da49a9bb64eb3', bps: 700 };
    p.venueFee = { recipient: '0x7D2620243EdAd69Ec81A53c4A063B07995A4Bd7d', bps: 50 };
  }));
  assert.equal(withFees.ok, true, withFees.reason);
  assert.equal(withFees.policy.collections.junglebay.creatorFee.bps, 700n);
  assert.equal(withFees.policy.venueFee.recipient, VENUE);
});

const policyCases = [
  ['F.shape', 'a missing key', (p) => { delete p.listing; }],
  ['F.shape', 'an unknown key (a typo would otherwise be ignored)', (p) => { p.venuefee = null; }],
  ['F.version', 'version 2', (p) => { p.version = 2; }],
  ['F.chainId', 'another chain', (p) => { p.chainId = 8453; }],
  ['F.house', 'a house that is not an address', (p) => { p.house = 'house'; }],
  ['F.house', 'a house with a broken checksum', (p) => { p.house = '0xBD00483cCB69C4fCc2F9f28E87FC29eeb308EFFA'; }],
  ['F.house', 'the zero address', (p) => { p.house = '0x0000000000000000000000000000000000000000'; }],
  ['F.funding', 'a funding wallet that is not an address', (p) => { p.fundingWallet = '0x1234'; }],
  ['F.fundingHouse', 'the house as its own funding wallet', (p) => { p.fundingWallet = p.house; }],
  ['F.fundingContract', 'WETH as the funding wallet', (p) => { p.fundingWallet = WETH; }],
  ['F.fundingContract', 'a collection contract as the funding wallet', (p) => { p.fundingWallet = JBAC; }],
  ['F.collections', 'no collections', (p) => { p.collections = {}; }],
  ['F.slug', 'a collection the signer does not know', (p) => { p.collections.cryptopunks = p.collections.gnssart; }],
  ['F.cshape', 'a collection with an extra key', (p) => { p.collections.junglebay.traits = []; }],
  ['F.caddress', 'junglebay pointing at another contract', (p) => { p.collections.junglebay.address = GNSS; }],
  ['F.enabled', 'enabled given as a string', (p) => { p.collections.junglebay.enabled = 'true'; }],
  ['F.maxUnit', 'a zero price ceiling', (p) => { p.collections.junglebay.maxUnitPriceWei = '0'; }],
  ['F.maxUnit', 'a price ceiling as a JSON number', (p) => { p.collections.junglebay.maxUnitPriceWei = 45000000000000000; }],
  ['F.maxQty', 'maxQty 0', (p) => { p.collections.junglebay.maxQty = 0; }],
  ['F.maxQty', 'maxQty as a string', (p) => { p.collections.junglebay.maxQty = '2'; }],
  ['F.inventoryCap', 'a negative inventory cap', (p) => { p.collections.junglebay.inventoryCap = -1; }],
  ['F.creatorShape', 'a creator fee without bps', (p) => { p.collections.junglebay.creatorFee = { recipient: JBAC_CREATOR }; }],
  ['F.creatorRecipient', "a creator fee paid to someone other than the creator", (p) => { p.collections.junglebay.creatorFee = { recipient: STRANGER, bps: 700 }; }],
  ['F.creatorBps', 'a creator fee above the collection optional fee', (p) => { p.collections.junglebay.creatorFee = { recipient: JBAC_CREATOR, bps: 701 }; }],
  ['F.creatorBps', 'a creator fee of 0 bps', (p) => { p.collections.junglebay.creatorFee = { recipient: JBAC_CREATOR, bps: 0 }; }],
  ['F.osShape', 'an OpenSea fee with an extra key', (p) => { p.openseaFee.token = WETH; }],
  ['F.osRecipient', 'an OpenSea fee to another address', (p) => { p.openseaFee.recipient = STRANGER; }],
  ['F.osBps', 'an OpenSea fee of 2.5%', (p) => { p.openseaFee.bps = 250; }],
  ['F.venueShape', 'a venue fee without a recipient', (p) => { p.venueFee = { bps: 50 }; }],
  ['F.venueRecipient', 'a venue fee to anyone but the venue Safe', (p) => { p.venueFee = { recipient: STRANGER, bps: 50 }; }],
  ['F.venueBps', 'a venue fee of 1%', (p) => { p.venueFee = { recipient: VENUE, bps: 100 }; }],
  ['F.lifetime', 'a bid lifetime under a minute', (p) => { p.maxLifetimeSec = 30; }],
  ['F.lifetime', 'a bid lifetime over 7 days', (p) => { p.maxLifetimeSec = 8 * 24 * 3600; }],
  ['F.allowance', 'maxAllowanceWei as a JSON number', (p) => { p.maxAllowanceWei = 150000000000000000; }],
  ['F.wrap', 'a negative maxWrapWei', (p) => { p.maxWrapWei = '-1'; }],
  ['F.gasShape', 'gas without maxGasLimit', (p) => { delete p.gas.maxGasLimit; }],
  ['F.maxFee', 'a zero fee cap', (p) => { p.gas.maxFeeGwei = 0; }],
  ['F.maxFee', 'a fee cap over 1000 gwei', (p) => { p.gas.maxFeeGwei = 1001; }],
  ['F.priority', 'a normal tip outside the share of the cap normal transactions use', (p) => { p.gas.priorityGwei = 17; }],
  ['F.killPriority', 'a kill tip no higher than the normal tip', (p) => { p.gas.killPriorityGwei = 0.05; }],
  ['F.killPriority', 'a kill tip above the fee cap', (p) => { p.gas.killPriorityGwei = 21; }],
  ['F.gasLimit', 'a gas limit under 21000', (p) => { p.gas.maxGasLimit = 20000; }],
  ['F.gasLimit', 'a gas limit too low for the kill\'s counter bump and NFT revokes (60000)', (p) => { p.gas.maxGasLimit = 60000; }],
  ['F.gasLimit', 'a gas limit one under what an on-chain cancel of 6 orders needs', (p) => { p.gas.maxGasLimit = 254999; }],
  ['F.dailyShape', 'a daily budget with an unknown key', (p) => { p.daily = { maxTxs: 20, maxGasWei: '50000000000000000', perHour: 3 }; }],
  ['F.dailyShape', 'a daily budget of null', (p) => { p.daily = null; }],
  ['F.dailyTxs', 'a daily budget of 0 transactions', (p) => { p.daily = { maxTxs: 0, maxGasWei: '50000000000000000' }; }],
  ['F.dailyTxs', 'a daily transaction count as a string', (p) => { p.daily = { maxTxs: '20', maxGasWei: '50000000000000000' }; }],
  ['F.dailyGas', 'a daily gas budget of 0', (p) => { p.daily = { maxTxs: 20, maxGasWei: '0' }; }],
  ['F.dailyGas', 'a daily gas budget as a JSON number', (p) => { p.daily = { maxTxs: 20, maxGasWei: 50000000000000000 }; }],
  ['F.dailyGas', 'a daily gas budget over 1 ETH', (p) => { p.daily = { maxTxs: 20, maxGasWei: '1000000000000000001' }; }],
  ['F.listingShape', 'listing without its fields', (p) => { p.listing = { enabled: false }; }],
  ['F.listingOff', 'listings switched on (not supported in this version)', (p) => { p.listing.enabled = true; }],
];

for (const [pin, what, edit] of policyCases) {
  test(`PIN:${pin} refuses a policy with ${what}`, () => {
    refusedBy(validatePolicy(rawPolicy(edit)), pin);
  });
}

test('the lowest gas.maxGasLimit a policy may set still fits every transaction the signer builds, the kill and a 6-order cancel included', () => {
  const v = validatePolicy(rawPolicy((p) => { p.gas.maxGasLimit = 255000; }));
  assert.equal(v.ok, true, v.reason);
  for (const kind of ['approveWeth', 'revokeWeth', 'wrap', 'unwrap', 'returnWethToFunding', 'incrementCounter', 'setNftApproval', 'returnNftToFunding']) {
    assert.ok(gasLimitFor({ kind }) <= v.policy.gas.maxGasLimit, kind);
  }
  assert.ok(gasLimitFor({ kind: 'cancelOnChain', orders: [1, 2, 3, 4, 5, 6] }) <= v.policy.gas.maxGasLimit);
});

test('the daily budget is optional: without it a policy gets 20 transactions and 0.05 ETH of gas a day; with it, its own numbers', () => {
  const v = validatePolicy(rawPolicy());
  assert.equal(v.ok, true, v.reason);
  assert.deepEqual(v.policy.daily, { maxTxs: 20, maxGasWei: 50_000_000_000_000_000n });
  const own = validatePolicy(rawPolicy((p) => { p.daily = { maxTxs: 5, maxGasWei: '10000000000000000' }; }));
  assert.equal(own.ok, true, own.reason);
  assert.deepEqual(own.policy.daily, { maxTxs: 5, maxGasWei: 10_000_000_000_000_000n });
});

// ---------------------------------------------------------------------------------------
// signBid: the request
// ---------------------------------------------------------------------------------------

const policy = makePolicy();
const req = (overrides) => bidRequest(overrides, NOW);
const checkReq = (r, extra = {}) => checkBidRequest(r, { policy, nowSec: NOW, stopped: false, ...extra });

test('a well-formed bid request passes and is parsed', () => {
  const r = checkReq(req());
  assert.equal(r.ok, true, r.reason);
  assert.equal(r.qty, 1);
  assert.equal(r.unitPriceWei, 30_000_000_000_000_000n);
  assert.deepEqual(r.nftLine, { itemType: 4, token: JBAC, identifierOrCriteria: 0n, startAmount: 1n, endAmount: 1n, recipient: HOUSE.toLowerCase() });
  assert.equal(checkReq(req({ qty: 2, build: buildFor({ qty: 2 }) })).ok, true);
});

const requestCases = [
  ['P15', 'when a STOP file exists', () => [req(), { stopped: true }]],
  ['P0.shape', 'that carries its own salt', () => [{ ...req(), salt: '1' }]],
  ['P0.shape', 'that carries EIP-712 types', () => [{ ...req(), types: { Permit: [] } }]],
  ['P8.slug', 'for a collection not in the policy', () => [req({ slug: 'cryptopunks' })]],
  ['P8.slug', 'for an inherited property name', () => [req({ slug: 'constructor' })]],
  ['P8.enabled', 'for a switched-off collection', () => [req({ slug: 'gnssart', build: buildFor({ token: GNSS }) })]],
  ['P8.int', 'with a fractional quantity', () => [req({ qty: 1.5 })]],
  ['P8.min', 'with quantity 0', () => [req({ qty: 0, build: buildFor({ qty: 0 }) })]],
  ['P8.max', 'above maxQty', () => [req({ qty: 3, build: buildFor({ qty: 3 }) })]],
  ['P7.format', 'with the price as a JSON number', () => [req({ unitPriceWei: 30000000000000000 })]],
  ['P7.format', 'with the price in hex', () => [req({ unitPriceWei: '0x6a94d74f430000' })]],
  ['P7.positive', 'with a zero price', () => [req({ unitPriceWei: '0' })]],
  ['P7.tick', 'with a price off the 10^13 tick', () => [req({ unitPriceWei: '30000000000000001' })]],
  ['P7.max', 'above the price ceiling', () => [req({ unitPriceWei: '45010000000000000' })]],
  ['P12.int', 'with a fractional start time', () => [req({ startTime: NOW + 0.5 })]],
  ['P12.start', 'starting more than 300 s from the clock', () => [req({ startTime: NOW + 301, endTime: NOW + 900 })]],
  ['P12.start', 'starting more than 300 s ago', () => [req({ startTime: NOW - 301 })]],
  ['P12.order', 'ending when it starts', () => [req({ endTime: NOW })]],
  ['P12.lifetime', 'living longer than maxLifetimeSec', () => [req({ endTime: NOW + 1801 })]],
  ['P3.shape', 'whose build carries an offer', () => [req({ build: { ...buildFor(), offer: [] } })]],
  ['P3.zone', 'whose build has no zone', () => [req({ build: { ...buildFor(), zone: '0x0000000000000000000000000000000000000000' } })]],
  ['P3.zoneHash', 'whose build has a zoneHash', () => [req({ build: { ...buildFor(), zoneHash: `0x${'00'.repeat(31)}01` } })]],
  ['P9.count', 'whose build returns two lines', () => {
    const b = buildFor();
    b.consideration.push({ ...b.consideration[0], itemType: 1, token: WETH, recipient: STRANGER });
    return [req({ build: b })];
  }],
  ['P9.shape', 'whose NFT line lacks a recipient', () => {
    const b = buildFor();
    delete b.consideration[0].recipient;
    return [req({ build: b })];
  }],
  ['P9.itemType', 'whose NFT line is a single token (itemType 2)', () => {
    const b = buildFor();
    b.consideration[0].itemType = 2;
    return [req({ build: b })];
  }],
  ['P9.token', 'whose NFT line is for another collection', () => [req({ build: buildFor({ token: GNSS }) })]],
  ['P9.criteria', 'whose NFT line has trait criteria', () => {
    const b = buildFor();
    b.consideration[0].identifierOrCriteria = '123';
    return [req({ build: b })];
  }],
  ['P9.start', 'whose NFT line asks for a different quantity', () => {
    const b = buildFor();
    b.consideration[0].startAmount = '2';
    return [req({ build: b })];
  }],
  ['P9.end', 'whose NFT line quantity changes over time', () => {
    const b = buildFor();
    b.consideration[0].endAmount = '2';
    return [req({ build: b })];
  }],
  ['P9.recipient', 'whose NFT line delivers to someone else', () => [req({ build: buildFor({ recipient: STRANGER }) })]],
];

for (const [pin, what, make] of requestCases) {
  test(`PIN:${pin} refuses a bid request ${what}`, () => {
    const [r, extra] = make();
    refusedBy(checkReq(r, extra), pin);
  });
}

// ---------------------------------------------------------------------------------------
// signBid: the finished order
// ---------------------------------------------------------------------------------------

function goodOrder({ policyEdit, qty = 1, unit = 30_000_000_000_000_000n } = {}) {
  const pol = makePolicy(policyEdit);
  const nftLine = { itemType: 4, token: JBAC, identifierOrCriteria: 0n, startAmount: BigInt(qty), endAmount: BigInt(qty), recipient: HOUSE.toLowerCase() };
  const salt = 0x5a17n;
  const counter = 0n;
  const order = buildBidOrder({ policy: pol, slug: 'junglebay', qty, unitPriceWei: unit, startTime: NOW, endTime: NOW + 1800, nftLine, house: HOUSE.toLowerCase(), salt, counter });
  const ctx = { policy: pol, house: HOUSE.toLowerCase(), domain: SEAPORT_DOMAIN, slug: 'junglebay', nftLine, salt, counter, nowSec: NOW };
  return { order, ctx };
}

const allFees = (p) => {
  p.collections.junglebay.creatorFee = { recipient: JBAC_CREATOR, bps: 700 };
  p.venueFee = { recipient: VENUE, bps: 50 };
};

test('the orders the signer builds pass the order check', () => {
  for (const opts of [{}, { qty: 2 }, { qty: 2, policyEdit: allFees }, { policyEdit: allFees, unit: 45_000_000_000_000_000n }]) {
    const { order, ctx } = goodOrder(opts);
    const r = checkBidOrder(order, ctx);
    assert.equal(r.ok, true, `${opts.qty ?? 1} x ${opts.unit ?? 'default'}: ${r.field} ${r.reason}`);
  }
});

test('PIN:P4 every collection bid is PARTIAL_RESTRICTED, as OpenSea\'s SDK makes it', () => {
  assert.equal(orderTypeForBid(1), 3);
  assert.equal(orderTypeForBid(2), 3);
  const { order, ctx } = goodOrder();
  order.orderType = 2;
  refusedBy(checkBidOrder(order, ctx), 'P4');
});

const orderCases = [
  ['P1.chainId', 'signed for another chain', (o, c) => { c.domain = { ...c.domain, chainId: 5n }; }],
  ['P1.name', 'under another domain name', (o, c) => { c.domain = { ...c.domain, name: 'Seaport2' }; }],
  ['P1.version', 'under Seaport 1.5', (o, c) => { c.domain = { ...c.domain, version: '1.5' }; }],
  ['P1.contract', 'for another verifying contract', (o, c) => { c.domain = { ...c.domain, verifyingContract: '0x00000000000000adc04c56bf30ac9d3c0aaf14dc' }; }],
  ['P2.key', 'whose offerer is not the key', (o) => { o.offerer = OTHER; }],
  ['P2.policy', 'whose offerer is the key but not policy.house', (o, c) => { o.offerer = OTHER; c.house = OTHER; }],
  ['P3.orderZone', 'with no zone', (o) => { o.zone = '0x0000000000000000000000000000000000000000'; }],
  ['P3.orderZoneHash', 'with a zoneHash', (o) => { o.zoneHash = `0x${'00'.repeat(31)}01`; }],
  ['P8.orderEnabled', 'for a switched-off collection', (o, c) => { c.slug = 'gnssart'; }],
  ['P11.minLines', 'with no fee line at all', (o) => { o.consideration = [o.consideration[0]]; o.totalOriginalConsiderationItems = 1; }],
  ['P8.orderQty', 'for more NFTs than maxQty', (o, c) => { c.policy = makePolicy((p) => { p.collections.junglebay.maxQty = 1; }); }, { qty: 2 }],
  ['P5', 'with another conduit key', (o) => { o.conduitKey = ZERO32; }],
  ['P6.count', 'offering two items', (o) => { o.offer = [o.offer[0], o.offer[0]]; }],
  ['P6.itemType', 'offering native ETH', (o) => { o.offer[0].itemType = 0; }],
  ['P6.token', 'offering another token', (o) => { o.offer[0].token = STRANGER; }],
  ['P6.id', 'with an offer identifier', (o) => { o.offer[0].identifierOrCriteria = 1n; }],
  ['P6.flat', 'whose offer rises over time', (o) => { o.offer[0].endAmount += 10n ** 13n; }],
  ['P11.offerDivisible', 'whose offer does not divide by the quantity', (o) => { o.offer[0].startAmount += 1n; o.offer[0].endAmount += 1n; }, { qty: 2 }],
  ['P7.orderPositive', 'offering nothing', (o) => { o.offer[0].startAmount = 0n; o.offer[0].endAmount = 0n; }],
  ['P7.orderTick', 'whose unit price is off the tick', (o) => { o.offer[0].startAmount += 1n; o.offer[0].endAmount += 1n; }],
  ['P7.orderMax', 'whose unit price is above the ceiling', (o) => { o.offer[0].startAmount = 46_000_000_000_000_000n; o.offer[0].endAmount = 46_000_000_000_000_000n; }],
  ['P9.orderItemType', 'whose NFT line is itemType 2', (o) => { o.consideration[0].itemType = 2; }],
  ['P9.orderToken', 'whose NFT line is for another contract', (o) => { o.consideration[0].token = GNSS; }],
  ['P9.orderCriteria', 'whose NFT line has criteria', (o) => { o.consideration[0].identifierOrCriteria = 5n; }],
  ['P9.orderFlat', 'whose NFT quantity changes over time', (o) => { o.consideration[0].endAmount = 2n; }],
  ['P9.orderRecipient', 'whose NFT goes to someone else', (o) => { o.consideration[0].recipient = STRANGER; }],
  ['P9.build', 'whose NFT line is not the one the build returned', (o, c) => { c.nftLine = { ...c.nftLine, startAmount: 2n }; }],
  ['P11.count', 'carrying an extra line', (o) => {
    o.consideration.push({ itemType: 1, token: WETH, identifierOrCriteria: 0n, startAmount: 10n ** 9n, endAmount: 10n ** 9n, recipient: STRANGER });
    o.totalOriginalConsiderationItems += 1;
  }],
  ['P11.divisible', 'whose fee line does not divide by the quantity', (o) => { o.consideration[1].startAmount += 1n; o.consideration[1].endAmount += 1n; }, { qty: 2 }],
  ['P11.nonZero', 'with a zero fee line', (o) => { o.consideration[1].startAmount = 0n; o.consideration[1].endAmount = 0n; }],
  ['P10', 'paying the OpenSea fee to someone else', (o) => { o.consideration[1].recipient = STRANGER; }],
  ['P10', 'paying OpenSea a different amount', (o) => { o.consideration[1].startAmount *= 2n; o.consideration[1].endAmount *= 2n; }],
  ['P10', 'paying the OpenSea fee in another token', (o) => { o.consideration[1].token = STRANGER; }],
  ['P11.second', 'paying the creator line to someone else', (o) => { o.consideration[2].recipient = STRANGER; }, { policyEdit: allFees }],
  ['P11.third', 'paying the venue line to someone else', (o) => { o.consideration[3].recipient = STRANGER; }, { policyEdit: allFees }],
  ['P12.orderInt', 'with a start time that is not a whole number', (o) => { o.startTime = NOW; }],
  ['P12.orderStart', 'starting more than 300 s ahead', (o) => { o.startTime += 301n; o.endTime += 301n; }],
  ['P12.orderOrder', 'ending when it starts', (o) => { o.endTime = o.startTime; }],
  ['P12.orderLifetime', 'living longer than the policy allows', (o) => { o.endTime = o.startTime + 1801n; }],
  ['P13.salt', 'with a salt the signer did not generate', (o) => { o.salt += 1n; }],
  ['P13.counter', 'with a counter the signer did not read', (o) => { o.counter += 1n; }],
  ['P14', 'with a wrong totalOriginalConsiderationItems', (o) => { o.totalOriginalConsiderationItems += 1; }],
];

for (const [pin, what, edit, opts] of orderCases) {
  test(`PIN:${pin} refuses an order ${what}`, () => {
    const { order, ctx } = goodOrder(opts);
    const c = { ...ctx };
    edit(order, c);
    refusedBy(checkBidOrder(order, c), pin);
  });
}

test('the fee lines are exact: 1% of 0.08 ETH, 7% creator, 0.5% venue', () => {
  const { order } = goodOrder({ qty: 2, unit: 40_000_000_000_000_000n, policyEdit: allFees });
  assert.deepEqual(order.consideration.slice(1).map((i) => [i.recipient, i.startAmount]), [
    [OS_FEE, 800_000_000_000_000n],
    [JBAC_CREATOR, 5_600_000_000_000_000n],
    [VENUE, 400_000_000_000_000n],
  ]);
});

// ---------------------------------------------------------------------------------------
// signCancel
// ---------------------------------------------------------------------------------------

const KNOWN = `0x${'ab'.repeat(32)}`;
const ownOrder = (offerer) => ({
  offerer, zone: '0x000056f7000000ece9003ca63978907a00ffd100', offer: [], consideration: [], orderType: 3, startTime: 1n, endTime: 2n, zoneHash: ZERO32, salt: 1n, conduitKey: ZERO32, counter: 0n,
});
// A stored order needs real components: cancelOnChain builds its calldata from them.
const known = new Map([[KNOWN, { orderHash: KNOWN, components: ownOrder(HOUSE.toLowerCase()) }]]);

test('a cancel for an order the signer signed passes', () => {
  assert.equal(checkCancelRequest({ id: 'c', op: 'signCancel', orderHash: KNOWN.toUpperCase().replace('0X', '0x') }, { knownOrders: known }).ok, true);
});

const cancelCases = [
  ['C.shape', 'with an extra field', { id: 'c', op: 'signCancel', orderHash: KNOWN, domain: {} }],
  ['C.format', 'with a hash that is not 32 bytes', { id: 'c', op: 'signCancel', orderHash: '0xabcd' }],
  ['C.known', 'for an order the signer never signed', { id: 'c', op: 'signCancel', orderHash: `0x${'cd'.repeat(32)}` }],
];
for (const [pin, what, r] of cancelCases) {
  test(`PIN:${pin} refuses a cancel ${what}`, () => {
    refusedBy(checkCancelRequest(r, { knownOrders: known }), pin);
  });
}

// ---------------------------------------------------------------------------------------
// sendTx: the request
// ---------------------------------------------------------------------------------------

const txReq = (kind, params) => ({ id: 't', op: 'sendTx', kind, params });
const checkTxReq = (r, extra = {}) => checkTxRequest(r, { policy, stopped: false, knownOrders: known, ...extra });

test('every allowed kind passes with good parameters', () => {
  const good = [
    txReq('approveWeth', { amountWei: '150000000000000000' }),
    txReq('revokeWeth', {}),
    txReq('wrap', { amountWei: '200000000000000000' }),
    txReq('unwrap', { amountWei: '1' }),
    txReq('returnWethToFunding', { amountWei: '5' }),
    txReq('incrementCounter', {}),
    txReq('cancelOnChain', { orderHashes: [KNOWN] }),
    txReq('setNftApproval', { slug: 'junglebay', approved: false }),
    txReq('setNftApproval', { slug: 'gnssart', approved: false }),
    txReq('returnNftToFunding', { slug: 'gnssart', tokenId: '42' }),
  ];
  for (const r of good) assert.equal(checkTxReq(r).ok, true, `${r.kind}: ${checkTxReq(r).reason}`);
});

test('a STOP file still lets every risk-reducing kind through', () => {
  for (const r of [
    txReq('revokeWeth', {}), txReq('incrementCounter', {}), txReq('cancelOnChain', { orderHashes: [KNOWN] }),
    txReq('setNftApproval', { slug: 'junglebay', approved: false }), txReq('returnWethToFunding', { amountWei: '5' }),
    txReq('unwrap', { amountWei: '5' }), txReq('returnNftToFunding', { slug: 'junglebay', tokenId: '1' }),
  ]) assert.equal(checkTxReq(r, { stopped: true }).ok, true, r.kind);
});

const txRequestCases = [
  ['T.shape', 'with raw calldata attached', () => [{ ...txReq('revokeWeth', {}), data: '0x' }]],
  ['T.kind', 'of a kind not on the list', () => [txReq('transferEth', { amountWei: '1' })]],
  ['T.kind', 'of an inherited property name', () => [txReq('toString', {})]],
  ['T.params', 'with a spender of its own choosing', () => [txReq('approveWeth', { amountWei: '1', spender: STRANGER })]],
  ['T.amount', 'approving zero (a revoke is its own kind)', () => [txReq('approveWeth', { amountWei: '0' })]],
  ['T.amount', 'with an amount as a JSON number', () => [txReq('unwrap', { amountWei: 5 })]],
  ['T.approveMax', 'approving above maxAllowanceWei', () => [txReq('approveWeth', { amountWei: '150000000000000001' })]],
  ['T.wrapMax', 'wrapping above maxWrapWei', () => [txReq('wrap', { amountWei: '200000000000000001' })]],
  ['T.cancelCount', 'cancelling nothing', () => [txReq('cancelOnChain', { orderHashes: [] })]],
  ['T.cancelCount', 'cancelling more than fits in one transaction', () => [txReq('cancelOnChain', { orderHashes: Array(7).fill(KNOWN) })]],
  ['T.cancelFormat', 'with a malformed order hash', () => [txReq('cancelOnChain', { orderHashes: ['0x12'] })]],
  ['T.cancelDupes', 'listing an order twice', () => [txReq('cancelOnChain', { orderHashes: [KNOWN, KNOWN] })]],
  ['T.cancelKnown', 'for an order the signer never signed', () => [txReq('cancelOnChain', { orderHashes: [`0x${'cd'.repeat(32)}`] })]],
  ['T.nftSlug', 'for a collection not in the policy', () => [txReq('setNftApproval', { slug: 'cryptopunks', approved: false })]],
  ['T.nftBool', 'with approved given as a string', () => [txReq('setNftApproval', { slug: 'junglebay', approved: 'false' })]],
  ['T.nftEnabled', 'approving NFTs of a switched-off collection', () => [txReq('setNftApproval', { slug: 'gnssart', approved: true })]],
  ['T.nftListing', 'approving NFTs while listing is off', () => [txReq('setNftApproval', { slug: 'junglebay', approved: true })]],
  ['T.tokenId', 'with a token id that is not a decimal string', () => [txReq('returnNftToFunding', { slug: 'junglebay', tokenId: 42 })]],
  ['T.stop', 'that adds risk while STOP exists', () => [txReq('approveWeth', { amountWei: '1' }), { stopped: true }]],
  ['T.stop', 'that wraps while STOP exists', () => [txReq('wrap', { amountWei: '1' }), { stopped: true }]],
];
for (const [pin, what, make] of txRequestCases) {
  test(`PIN:${pin} refuses a sendTx ${what}`, () => {
    const [r, extra] = make();
    refusedBy(checkTxReq(r, extra), pin);
  });
}

// ---------------------------------------------------------------------------------------
// sendTx: the built transaction
// ---------------------------------------------------------------------------------------

function goodTx(kind, params, { kill = false, pol = policy } = {}) {
  const r = checkTxRequest(txReq(kind, params), { policy: pol, stopped: false, knownOrders: known });
  assert.equal(r.ok, true, r.reason);
  const call = buildCall(r.plan, { policy: pol, house: HOUSE.toLowerCase() });
  const tx = {
    type: 2, chainId: 1n, nonce: 3n, maxFeePerGas: kill ? pol.gas.maxFeeWei : normalFeeCap(pol), maxPriorityFeePerGas: kill ? pol.gas.killPriorityWei : pol.gas.priorityWei,
    gas: gasLimitFor(r.plan), to: call.to, value: call.value, data: call.data, accessList: [],
  };
  return { tx, ctx: { policy: pol, house: HOUSE.toLowerCase(), plan: r.plan, kill } };
}

test('every kind builds a transaction that passes the final check', () => {
  for (const [kind, params] of [
    ['approveWeth', { amountWei: '150000000000000000' }], ['revokeWeth', {}], ['wrap', { amountWei: '200000000000000000' }],
    ['unwrap', { amountWei: '9' }], ['returnWethToFunding', { amountWei: '9' }], ['incrementCounter', {}],
    ['setNftApproval', { slug: 'junglebay', approved: false }], ['returnNftToFunding', { slug: 'junglebay', tokenId: '7' }],
  ]) {
    const { tx, ctx } = goodTx(kind, params);
    assert.equal(checkTx(tx, ctx).ok, true, `${kind}: ${checkTx(tx, ctx).reason}`);
    const k = goodTx(kind, params, { kill: true });
    assert.equal(checkTx(k.tx, k.ctx).ok, true, `${kind} (kill)`);
  }
});

const enc = (sig, types, values) => encodeCall(sig, types, values);

const txCases = [
  ['T.type', 'an EIP-7702 (type 4) transaction', () => goodTx('revokeWeth', {}), (t) => { t.type = 4; }],
  ['T.type', 'a legacy transaction', () => goodTx('revokeWeth', {}), (t) => { t.type = 0; }],
  ['T.chainId', 'a transaction for another chain', () => goodTx('revokeWeth', {}), (t) => { t.chainId = 8453n; }],
  ['T.auth', 'a transaction carrying an authorization list', () => goodTx('revokeWeth', {}), (t) => { t.authorizationList = []; }],
  ['T.accessList', 'a transaction with an access list', () => goodTx('revokeWeth', {}), (t) => { t.accessList = [{ address: STRANGER, storageKeys: [] }]; }],
  ['T.create', 'contract creation (no recipient)', () => goodTx('revokeWeth', {}), (t) => { t.to = null; }],
  ['T.to', 'an approval sent to Seaport instead of WETH', () => goodTx('approveWeth', { amountWei: '1' }), (t) => { t.to = SEAPORT; }],
  ['T.to', 'an NFT return sent to another collection', () => goodTx('returnNftToFunding', { slug: 'junglebay', tokenId: '1' }), (t) => { t.to = GNSS; }],
  ['T.selector', 'an approval whose calldata is a transfer', () => goodTx('approveWeth', { amountWei: '1' }), (t) => { t.data = enc(SIGNATURES.transfer, ['address', 'uint256'], [CONDUIT, 1n]); }],
  ['T.value', 'an approval that also sends ETH', () => goodTx('approveWeth', { amountWei: '1' }), (t) => { t.value = 1n; }],
  ['T.value', 'a wrap whose value differs from its amount', () => goodTx('wrap', { amountWei: '5' }), (t) => { t.value = 6n; }],
  ['T.valueMax', 'a wrap above maxWrapWei', () => {
    const g = goodTx('wrap', { amountWei: '5' });
    g.ctx.plan = { ...g.ctx.plan, amount: 200_000_000_000_000_001n };
    g.tx.value = 200_000_000_000_000_001n;
    return g;
  }, () => {}],
  ['T.maxFee', 'a normal transaction above its share of the fee cap', () => goodTx('revokeWeth', {}), (t) => { t.maxFeePerGas += 1n; }],
  ['T.maxFee', 'a kill transaction above the fee cap', () => goodTx('revokeWeth', {}, { kill: true }), (t) => { t.maxFeePerGas += 1n; }],
  ['T.tip', 'a tip above the max fee', () => goodTx('revokeWeth', {}), (t) => { t.maxFeePerGas = 1n; t.maxPriorityFeePerGas = 2n; }],
  ['T.tipCap', 'a normal transaction tipping above the policy tip', () => goodTx('revokeWeth', {}), (t) => { t.maxPriorityFeePerGas += 1n; }],
  ['T.gas', 'a gas limit above maxGasLimit', () => goodTx('revokeWeth', {}), (t) => { t.gas = 300_001n; }],
  ['T.spender', 'WETH approved to someone other than the conduit', () => goodTx('approveWeth', { amountWei: '1' }), (t) => { t.data = enc(SIGNATURES.approve, ['address', 'uint256'], [STRANGER, 1n]); }],
  ['T.allowance', 'calldata approving above maxAllowanceWei', () => goodTx('approveWeth', { amountWei: '1' }), (t) => { t.data = enc(SIGNATURES.approve, ['address', 'uint256'], [CONDUIT, 150_000_000_000_000_001n]); }],
  ['T.revokeZero', 'a revoke that leaves an allowance', () => goodTx('revokeWeth', {}), (t) => { t.data = enc(SIGNATURES.approve, ['address', 'uint256'], [CONDUIT, 1n]); }],
  ['T.fundingWeth', 'WETH sent anywhere but the funding wallet', () => goodTx('returnWethToFunding', { amountWei: '5' }), (t) => { t.data = enc(SIGNATURES.transfer, ['address', 'uint256'], [STRANGER, 5n]); }],
  ['T.fundingNft', 'an NFT sent anywhere but the funding wallet', () => goodTx('returnNftToFunding', { slug: 'junglebay', tokenId: '1' }), (t) => { t.data = enc(SIGNATURES.safeTransferFrom, ['address', 'address', 'uint256'], [HOUSE, STRANGER, 1n]); }],
  ['T.fundingNft', 'an NFT moved from someone else', () => goodTx('returnNftToFunding', { slug: 'junglebay', tokenId: '1' }), (t) => { t.data = enc(SIGNATURES.safeTransferFrom, ['address', 'address', 'uint256'], [STRANGER, FUNDING, 1n]); }],
  ['T.operator', 'NFT approval for someone other than the conduit', () => goodTx('setNftApproval', { slug: 'junglebay', approved: false }), (t) => { t.data = enc(SIGNATURES.setApprovalForAll, ['address', 'bool'], [STRANGER, false]); }],
  ['T.operatorEnabled', 'calldata granting NFT approval on a switched-off collection', () => goodTx('setNftApproval', { slug: 'gnssart', approved: false }), (t) => { t.data = enc(SIGNATURES.setApprovalForAll, ['address', 'bool'], [CONDUIT, true]); }],
  ['T.cancelOwn', 'an on-chain cancel carrying someone else\'s order', () => {
    const g = goodTx('cancelOnChain', { orderHashes: [KNOWN] });
    return g;
  }, (t) => { t.data = enc(SIGNATURES.cancel, [{ array: ORDER_COMPONENTS }], [[componentsTuple(ownOrder(HOUSE)), componentsTuple(ownOrder(STRANGER))]]); }],
];


for (const [pin, what, make, edit] of txCases) {
  test(`PIN:${pin} refuses ${what}`, () => {
    const { tx, ctx } = make();
    edit(tx);
    refusedBy(checkTx(tx, ctx), pin);
  });
}

test('an on-chain cancel of the house\'s own orders passes the final check', () => {
  const { tx, ctx } = goodTx('cancelOnChain', { orderHashes: [KNOWN] });
  assert.equal(checkTx(tx, ctx).ok, true);
});
