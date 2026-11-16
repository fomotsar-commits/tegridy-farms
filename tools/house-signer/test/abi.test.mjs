// Calldata for every transaction kind and every read the signer makes, against viem's
// encodeFunctionData (test/fixtures/viem-fixture.json), plus the selectors pinned by value.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  addressAt, argsOf, componentsTuple, encodeCall, ORDER, ORDER_COMPONENTS, SELECTORS, SIGNATURES, stringAt, wordAt,
} from '../src/abi.mjs';
import { buildCall } from '../src/tx.mjs';
import { checkTxRequest } from '../src/policy.mjs';
import { toChecksumAddress } from '../src/keccak.mjs';
import { FIXTURE, HOUSE, makePolicy } from './support/helpers.mjs';

const toComponents = (c) => ({
  ...c,
  offer: c.offer.map((i) => ({ ...i, identifierOrCriteria: BigInt(i.identifierOrCriteria), startAmount: BigInt(i.startAmount), endAmount: BigInt(i.endAmount) })),
  consideration: c.consideration.map((i) => ({ ...i, identifierOrCriteria: BigInt(i.identifierOrCriteria), startAmount: BigInt(i.startAmount), endAmount: BigInt(i.endAmount) })),
  startTime: BigInt(c.startTime),
  endTime: BigInt(c.endTime),
  salt: BigInt(c.salt),
  counter: BigInt(c.counter),
});

test('every selector equals viem toFunctionSelector, and the well-known ones by value', () => {
  for (const [name, sel] of Object.entries(FIXTURE.selectors)) assert.equal(SELECTORS[name], sel, name);
  assert.deepEqual(
    [SELECTORS.approve, SELECTORS.deposit, SELECTORS.withdraw, SELECTORS.transfer, SELECTORS.incrementCounter, SELECTORS.cancel, SELECTORS.setApprovalForAll, SELECTORS.safeTransferFrom, SELECTORS.getCounter, SELECTORS.getOrderHash, SELECTORS.validate],
    ['0x095ea7b3', '0xd0e30db0', '0x2e1a7d4d', '0xa9059cbb', '0x5b34b966', '0xfd9f1e10', '0xa22cb465', '0x42842e0e', '0xf07ec373', '0x79df72bd', '0x88147732'],
  );
  // Seaport 1.6 getOrderStatus(bytes32), which the inventory cap reads.
  assert.equal(SELECTORS.getOrderStatus, '0x46423aa7');
});

// The signer's builder (tx.mjs buildCall), fed through the policy's request parser, must
// produce exactly viem's calldata for each kind.
const policy = makePolicy((p) => { p.fundingWallet = FIXTURE.calls.returnWethToFunding.funding; });
const known = new Map(FIXTURE.orders.map((o) => [o.orderHash, { orderHash: o.orderHash, components: toComponents(o.components) }]));
const plan = (kind, params) => {
  const r = checkTxRequest({ id: 'x', op: 'sendTx', kind, params }, { policy, stopped: false, knownOrders: known });
  assert.equal(r.ok, true, r.reason);
  return r.plan;
};
const house = FIXTURE.testKeys[1].address.toLowerCase();

const kinds = [
  ['approveWeth', { amountWei: FIXTURE.calls.approveWeth.amountWei }, FIXTURE.calls.approveWeth.data],
  ['revokeWeth', {}, FIXTURE.calls.revokeWeth.data],
  ['wrap', { amountWei: FIXTURE.calls.wrap.amountWei }, FIXTURE.calls.wrap.data],
  ['unwrap', { amountWei: FIXTURE.calls.unwrap.amountWei }, FIXTURE.calls.unwrap.data],
  ['returnWethToFunding', { amountWei: FIXTURE.calls.returnWethToFunding.amountWei }, FIXTURE.calls.returnWethToFunding.data],
  ['incrementCounter', {}, FIXTURE.calls.incrementCounter.data],
  ['cancelOnChain', { orderHashes: [FIXTURE.orders[0].orderHash, FIXTURE.orders[1].orderHash] }, FIXTURE.calls.cancelOnChain.data],
  ['setNftApproval', { slug: 'junglebay', approved: false }, FIXTURE.calls.setNftApprovalOff.data],
  ['returnNftToFunding', { slug: 'junglebay', tokenId: FIXTURE.calls.returnNftToFunding.tokenId }, FIXTURE.calls.returnNftToFunding.data],
];
for (const [kind, params, want] of kinds) {
  test(`${kind} calldata equals viem`, () => {
    const call = buildCall(plan(kind, params), { policy, house });
    assert.equal(call.data, want);
  });
}

test('each kind goes to its one contract with the right value', () => {
  const to = (kind, params) => buildCall(plan(kind, params), { policy, house });
  assert.equal(to('approveWeth', { amountWei: '1' }).to, '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2');
  assert.equal(to('wrap', { amountWei: '7' }).value, 7n);
  assert.equal(to('unwrap', { amountWei: '7' }).value, 0n);
  assert.equal(to('incrementCounter', {}).to, '0x0000000000000068f116a894984e2db1123eb395');
  assert.equal(to('setNftApproval', { slug: 'gnssart', approved: false }).to, '0xa1de9f93c56c290c48849b1393b09eb616d55dbb');
});

test('getOrderHash and validate calldata equal viem (the live check sends these)', () => {
  for (const o of FIXTURE.orders) {
    const c = toComponents(o.components);
    assert.equal(encodeCall(SIGNATURES.getOrderHash, [ORDER_COMPONENTS], [componentsTuple(c)]), o.calldata.getOrderHash);
    const parameters = componentsTuple(c, BigInt(c.consideration.length));
    assert.equal(encodeCall(SIGNATURES.validate, [{ array: ORDER }], [[[parameters, o.signature]]]), o.calldata.validate);
  }
});

test('read calls equal viem', () => {
  const a = FIXTURE.testKeys[1].address;
  assert.equal(encodeCall(SIGNATURES.getCounter, ['address'], [a]), FIXTURE.calls.getCounter.data);
  assert.equal(encodeCall(SIGNATURES.balanceOf, ['address'], [a]), FIXTURE.calls.balanceOf.data);
  assert.equal(encodeCall(SIGNATURES.allowance, ['address', 'address'], [a, '0x1E0049783F008A0085193E00003D00cd54003c71']), FIXTURE.calls.allowance.data);
});

test('return-data readers', () => {
  const data = `0x${'00'.repeat(31)}05${'00'.repeat(12)}${'ab'.repeat(20)}`;
  assert.equal(wordAt(data, 0), 5n);
  assert.equal(addressAt(data, 1), `0x${'ab'.repeat(20)}`);
  assert.throws(() => wordAt(data, 2), /too short/);
  assert.throws(() => addressAt(`0x${'ff'.repeat(32)}`, 0), /not an address/);
  // information() returns (string version, bytes32 domainSeparator, address conduitController)
  const info = `0x${(96).toString(16).padStart(64, '0')}${'11'.repeat(32)}${'00'.repeat(12)}${'22'.repeat(20)}${'3'.padStart(64, '0')}${Buffer.from('1.6').toString('hex').padEnd(64, '0')}`;
  assert.equal(stringAt(info, 0), '1.6');
  assert.equal(argsOf(`0x095ea7b3${'00'.repeat(32)}`), `0x${'00'.repeat(32)}`);
});

test('encoder refuses values it cannot encode exactly', () => {
  assert.throws(() => encodeCall(SIGNATURES.withdraw, ['uint256'], [5]), /bigint/);
  assert.throws(() => encodeCall(SIGNATURES.withdraw, ['uint256'], [-1n]), /non-negative/);
  assert.throws(() => encodeCall(SIGNATURES.withdraw, ['uint256'], [1n << 256n]), /does not fit/);
  assert.throws(() => encodeCall(SIGNATURES.approve, ['address', 'uint256'], ['0x12', 1n]), /address/);
});

test('EIP-55 checksums equal viem getAddress', () => {
  for (const { lower, checksummed } of FIXTURE.checksums) assert.equal(toChecksumAddress(lower), checksummed);
  assert.equal(toChecksumAddress(HOUSE), FIXTURE.testKeys[1].address);
});
