// The signing service end to end, with a fake chain and a temp keys folder: what a bid
// signature covers, what gets recorded, and the checks that live in the service itself
// (house has code, STOP appearing mid-request and its file names, ledger and audit writes,
// dev-mode sends, the inventory cap and the approval it allows, the daily budget, no
// re-broadcast of an approval under STOP, shutting down).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createSigner, killPlan, stopFilePresent } from '../src/signer.mjs';
import { cancelDigest, hashOrderComponents, orderDigest } from '../src/eip712.mjs';
import { fromJsonParameters } from '../src/order.mjs';
import { recoverAddress } from '../src/sign.mjs';
import { serializeUnsigned } from '../src/tx.mjs';
import { SELECTORS } from '../src/abi.mjs';
import { keccak256 } from '../src/keccak.mjs';
import { bigintToBytes, bytesToHex, concatBytes, hexToBytes } from '../src/hex.mjs';
import {
  bidRequest, fakeChain, fakeClock, HOUSE, HOUSE_KEY, makePolicy, tempDir,
} from './support/helpers.mjs';

const NOW = 1_763_251_200;
const WETH = '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2';
const SEAPORT = '0x0000000000000068f116a894984e2db1123eb395';
const CONDUIT = '0x1e0049783f008a0085193e00003d00cd54003c71';

function setup({ chain = fakeChain(), policyEdit, mode = 'live', sendUrls = ['https://send.example'], keysDir = tempDir('signer') } = {}) {
  const clock = fakeClock(NOW * 1000);
  const policy = makePolicy(policyEdit);
  const signer = createSigner({
    privateKey: HOUSE_KEY, policy, policySha256: 'ab'.repeat(32), keysDir, chain, sendUrls, mode, pinCommit: 'c'.repeat(40),
    nowMs: clock.nowMs, sleep: clock.sleep, watch: false, randomBytes: (n) => Buffer.alloc(n, 7),
  });
  return { signer, chain, clock, keysDir, policy };
}

const lines = (file) => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
const sigFromTx = (d) => bytesToHex(concatBytes(bigintToBytes(d.r, 32), bigintToBytes(d.s, 32), Uint8Array.of(27 + Number(d.yParity))));
const txSigner = (d) => recoverAddress(bytesToHex(keccak256(hexToBytes(serializeUnsigned({ ...d, type: 2, accessList: [] })))), sigFromTx(d));

test('hello reports the house, the policy hash, STOP and the pinned commit', async () => {
  const { signer } = setup();
  const res = await signer.handle({ id: 'h', op: 'hello' });
  assert.deepEqual(res, { ok: true, id: 'h', house: HOUSE, policySha256: 'ab'.repeat(32), version: '1.0.0', stopped: false, pinCommit: 'c'.repeat(40), mode: 'live' });
});

test('signBid: the signer builds, checks, signs and records the order; the signature is the house\'s over exactly those parameters', async () => {
  const { signer, chain, keysDir } = setup({ chain: fakeChain({ counter: 123456789n }) });
  const res = await signer.handle(bidRequest({ qty: 2 }, NOW));
  assert.equal(res.ok, true, res.reason);
  assert.equal(res.counter, '123456789');
  assert.equal(res.parameters.counter, '123456789');
  assert.equal(res.parameters.orderType, 3);
  assert.equal(res.parameters.offer[0].startAmount, '60000000000000000');
  assert.equal(res.parameters.salt, `0x${'07'.repeat(32)}`);
  assert.equal(res.parameters.totalOriginalConsiderationItems, 2);
  const components = fromJsonParameters(res.parameters);
  const { orderHash, digest } = orderDigest(components);
  assert.equal(res.orderHash, orderHash);
  assert.equal(recoverAddress(digest, res.signature), HOUSE);
  // Recorded before it was returned, with its full parameters.
  const [rec] = lines(path.join(keysDir, 'signer-orders.jsonl'));
  assert.equal(rec.orderHash, orderHash);
  assert.equal(rec.slug, 'junglebay');
  assert.equal(rec.qty, 2);
  assert.equal(rec.unitPriceWei, '30000000000000000');
  assert.equal(hashOrderComponents(fromJsonParameters(rec.parameters)), orderHash);
  // Audited: the request and the decision.
  const audit = lines(path.join(keysDir, 'signer-audit.jsonl'));
  assert.deepEqual(audit.map((a) => a.event), ['request', 'decision']);
  assert.equal(audit[1].ok, true);
  assert.equal(audit[1].result.orderHash, orderHash);
  assert.equal(chain.state.sent.length, 0, 'a bid sends nothing on chain');
});

test('a refused bid is written to the audit file with its pin and reason', async () => {
  const { signer, keysDir } = setup();
  const res = await signer.handle(bidRequest({ unitPriceWei: '99000000000000000' }, NOW));
  assert.equal(res.ok, false);
  assert.equal(res.id, 'req-1');
  assert.equal(res.field, 'P7.max');
  const decision = lines(path.join(keysDir, 'signer-audit.jsonl')).find((a) => a.event === 'decision');
  assert.equal(decision.field, 'P7.max');
  assert.match(decision.reason, /ceiling/);
  assert.equal(lines(path.join(keysDir, 'signer-orders.jsonl')).length, 0);
});

test('PIN:P2.code nothing is signed while the house address has code (an EIP-7702 delegation)', async () => {
  const { signer } = setup({ chain: fakeChain({ code: `0xef0100${'11'.repeat(20)}` }) });
  const res = await signer.handle(bidRequest({}, NOW));
  assert.equal(res.field, 'P2.code');
  assert.equal(res.signature, undefined);
});

test('PIN:P15.sign a STOP file that appears while a bid is prepared stops the signature', async () => {
  const chain = fakeChain();
  const { signer, keysDir } = setup({ chain });
  chain.state.onCounter = () => fs.writeFileSync(path.join(keysDir, 'STOP.txt'), 'stop');
  const res = await signer.handle(bidRequest({}, NOW));
  assert.equal(res.field, 'P15.sign');
  assert.equal(res.signature, undefined);
  assert.equal(stopFilePresent(keysDir), true);
  assert.equal((await signer.handle({ id: 'h', op: 'hello' })).stopped, true);
});

test('a STOP file present before the request refuses it at the first check', async () => {
  const { signer, keysDir } = setup();
  fs.writeFileSync(path.join(keysDir, 'STOP'), '');
  assert.equal((await signer.handle(bidRequest({}, NOW))).field, 'P15');
});

test('endpoints that disagree about the counter stop the bid', async () => {
  const chain = fakeChain();
  chain.state.counterError = Object.assign(new Error('the read endpoints disagree about the Seaport counter'), { kind: 'disagree' });
  const { signer } = setup({ chain });
  const res = await signer.handle(bidRequest({}, NOW));
  assert.equal(res.ok, false);
  assert.equal(res.field, 'counter');
});

test('PIN:L.order a bid whose order cannot be recorded is not returned', async () => {
  const { signer, keysDir } = setup();
  fs.mkdirSync(path.join(keysDir, 'signer-orders.jsonl'));
  const res = await signer.handle(bidRequest({}, NOW));
  assert.equal(res.field, 'L.order');
  assert.equal(res.signature, undefined);
});

test('PIN:A.request with no audit file nothing is signed, but the kill still runs', async () => {
  const { signer, keysDir } = setup();
  fs.mkdirSync(path.join(keysDir, 'signer-audit.jsonl'));
  assert.equal((await signer.handle(bidRequest({}, NOW))).field, 'A.request');
  const kill = await signer.handle({ id: 'k', op: 'kill' });
  assert.equal(kill.ok, true, kill.reason);
});

test('signCancel signs the gasless-cancel message only for an order this signer signed, and survives a restart', async () => {
  const keysDir = tempDir('cancel');
  const { signer } = setup({ keysDir });
  const bid = await signer.handle(bidRequest({}, NOW));
  const res = await signer.handle({ id: 'c', op: 'signCancel', orderHash: bid.orderHash });
  assert.equal(res.ok, true, res.reason);
  assert.equal(recoverAddress(cancelDigest(bid.orderHash), res.signature), HOUSE);
  assert.equal((await signer.handle({ id: 'c2', op: 'signCancel', orderHash: `0x${'cd'.repeat(32)}` })).field, 'C.known');
  // A fresh signer on the same folder knows the order from signer-orders.jsonl.
  const again = setup({ keysDir }).signer;
  assert.equal((await again.handle({ id: 'c3', op: 'signCancel', orderHash: bid.orderHash })).ok, true);
});

test('an edited line in signer-orders.jsonl is ignored, not trusted', async () => {
  const keysDir = tempDir('tamper');
  const { signer } = setup({ keysDir });
  const bid = await signer.handle(bidRequest({}, NOW));
  const file = path.join(keysDir, 'signer-orders.jsonl');
  const rec = JSON.parse(fs.readFileSync(file, 'utf8'));
  rec.parameters.offer[0].startAmount = '1';
  rec.parameters.offer[0].endAmount = '1';
  fs.writeFileSync(file, `${JSON.stringify(rec)}\n`);
  const again = setup({ keysDir }).signer;
  assert.equal((await again.handle({ id: 'c', op: 'signCancel', orderHash: bid.orderHash })).field, 'C.known');
});

test('sendTx approveWeth: a type 2 mainnet transaction to WETH, approving the conduit, signed by the house, at the pending nonce and capped fees', async () => {
  const chain = fakeChain({ latest: 41n, pending: 42n, baseFee: 3_000_000_000n });
  const { signer, policy } = setup({ chain });
  // 0.135 ETH: the whole room under the default policy's caps (3 JBAC x 0.045 ETH).
  const res = await signer.handle({ id: 't', op: 'sendTx', kind: 'approveWeth', params: { amountWei: '135000000000000000' } });
  assert.equal(res.ok, true, res.reason);
  assert.equal(res.status, 'mined');
  assert.equal(res.success, true);
  assert.equal(res.nonce, 42);
  const [{ decoded: d, hash }] = chain.state.sent;
  assert.equal(res.txHash, hash);
  assert.equal(d.chainId, 1n);
  assert.equal(d.nonce, 42n);
  assert.equal(d.to, WETH);
  assert.equal(d.value, 0n);
  assert.equal(d.data.slice(0, 10), SELECTORS.approve);
  assert.equal(`0x${d.data.slice(34, 74)}`, CONDUIT);
  assert.equal(BigInt(`0x${d.data.slice(74)}`), 135_000_000_000_000_000n);
  assert.equal(d.maxPriorityFeePerGas, policy.gas.priorityWei);
  assert.equal(d.maxFeePerGas, 3_000_000_000n * 2n + policy.gas.priorityWei);
  assert.equal(d.gas, 60_000n);
  assert.equal(txSigner(d), HOUSE);
});

test('a normal transaction never offers more than its share of the fee cap', async () => {
  const chain = fakeChain({ baseFee: 50_000_000_000n });
  const { signer, policy } = setup({ chain });
  await signer.handle({ id: 't', op: 'sendTx', kind: 'revokeWeth', params: {} });
  assert.equal(chain.state.sent[0].decoded.maxFeePerGas, (policy.gas.maxFeeWei * 8n) / 10n);
});

test('every kind reaches its one contract with the signer-built calldata', async () => {
  const chain = fakeChain();
  const { signer } = setup({ chain });
  const bid = await signer.handle(bidRequest({}, NOW));
  const want = [
    ['wrap', { amountWei: '5' }, WETH, SELECTORS.deposit, 5n],
    ['unwrap', { amountWei: '5' }, WETH, SELECTORS.withdraw, 0n],
    ['returnWethToFunding', { amountWei: '5' }, WETH, SELECTORS.transfer, 0n],
    ['incrementCounter', {}, SEAPORT, SELECTORS.incrementCounter, 0n],
    ['cancelOnChain', { orderHashes: [bid.orderHash] }, SEAPORT, SELECTORS.cancel, 0n],
    ['setNftApproval', { slug: 'junglebay', approved: false }, '0xd37264c71e9af940e49795f0d3a8336afaafdda9', SELECTORS.setApprovalForAll, 0n],
    ['returnNftToFunding', { slug: 'gnssart', tokenId: '9' }, '0xa1de9f93c56c290c48849b1393b09eb616d55dbb', SELECTORS.safeTransferFrom, 0n],
  ];
  for (const [kind, params, to, selector, value] of want) {
    const res = await signer.handle({ id: kind, op: 'sendTx', kind, params });
    assert.equal(res.ok, true, `${kind}: ${res.field} ${res.reason}`);
    const d = chain.state.sent.at(-1).decoded;
    assert.equal(d.to, to, kind);
    assert.equal(d.data.slice(0, 10), selector, kind);
    assert.equal(d.value, value, kind);
    assert.equal(txSigner(d), HOUSE, kind);
  }
});

test('PIN:D.send dev mode refuses to send anywhere but a local test chain', async () => {
  const { signer } = setup({ mode: 'dev', sendUrls: ['https://eth.drpc.org'] });
  assert.equal((await signer.handle({ id: 't', op: 'sendTx', kind: 'revokeWeth', params: {} })).field, 'D.send');
  const local = setup({ mode: 'dev', sendUrls: ['http://127.0.0.1:8545'] }).signer;
  assert.equal((await local.handle({ id: 't', op: 'sendTx', kind: 'revokeWeth', params: {} })).ok, true);
  assert.equal((await local.handle({ id: 'h', op: 'hello' })).mode, 'dev');
});

test('PIN:T.stopSign a STOP file that appears while a transaction is prepared stops a risk-adding send', async () => {
  const chain = fakeChain();
  const { signer, keysDir } = setup({ chain });
  chain.state.onSimulate = () => fs.writeFileSync(path.join(keysDir, 'STOP'), '');
  const res = await signer.handle({ id: 't', op: 'sendTx', kind: 'approveWeth', params: { amountWei: '1' } });
  assert.equal(res.field, 'T.stopSign');
  assert.equal(chain.state.sent.length, 0);
  // A revoke still goes out under STOP.
  assert.equal((await signer.handle({ id: 'r', op: 'sendTx', kind: 'revokeWeth', params: {} })).ok, true);
});

test('a transaction that would revert is refused before it is signed', async () => {
  const chain = fakeChain();
  chain.state.simulateError = Object.assign(new Error('fake: execution reverted'), { kind: 'rpc' });
  const { signer } = setup({ chain });
  const res = await signer.handle({ id: 't', op: 'sendTx', kind: 'unwrap', params: { amountWei: '1' } });
  assert.equal(res.field, 'simulation');
  assert.equal(chain.state.sent.length, 0);
});

test('a transaction every endpoint refuses is reported, not waited on', async () => {
  const chain = fakeChain();
  chain.state.broadcastResult = () => [{ host: 'fake.send', ok: false, message: 'fake.send: insufficient funds for gas * price + value' }];
  const { signer } = setup({ chain });
  const res = await signer.handle({ id: 't', op: 'sendTx', kind: 'revokeWeth', params: {} });
  assert.equal(res.field, 'broadcast');
  assert.match(res.reason, /insufficient funds/);
});

test('requests without an id or with an unknown op are refused', async () => {
  const { signer } = setup();
  assert.deepEqual(await signer.handle({ op: 'hello' }), { ok: false, id: null, field: 'id', reason: 'every request needs an id: a string of 1 to 128 characters' });
  assert.equal((await signer.handle({ id: 'x', op: 'signTypedData' })).field, 'op');
  assert.equal((await signer.handle('hello')).field, 'id');
});

test('status reads the chain', async () => {
  const chain = fakeChain({ latest: 10n, counter: 5n, weth: 7n, allowance: 3n });
  const { signer } = setup({ chain });
  assert.deepEqual(await signer.handle({ id: 's', op: 'status' }), {
    ok: true, id: 's', house: HOUSE, stopped: false, lastNonce: 9, counter: '5', wethBalance: '7', wethAllowance: '3',
  });
});

test('the kill plan: revoke WETH, bump the counter, revoke NFT approval per enabled collection', () => {
  const policy = makePolicy((p) => { p.collections.gnssart.enabled = true; });
  assert.deepEqual(killPlan(policy).map((s) => [s.kind, s.slug ?? null]), [
    ['revokeWeth', null], ['incrementCounter', null], ['setNftApproval', 'junglebay'], ['setNftApproval', 'gnssart'],
  ]);
  assert.equal(killPlan(policy, 6).length, 6);
  assert.deepEqual(killPlan(policy, 6).slice(4).map((s) => s.kind), ['revokeWeth', 'revokeWeth']);
});

test('the key never appears in a response, the audit file or the order ledger', async () => {
  const { signer, keysDir } = setup();
  const answers = [];
  answers.push(await signer.handle({ id: 'h', op: 'hello' }));
  answers.push(await signer.handle(bidRequest({}, NOW)));
  answers.push(await signer.handle({ id: 'k', op: 'kill' }));
  const keyHex = Buffer.from(HOUSE_KEY).toString('hex');
  const everything = JSON.stringify(answers) + fs.readFileSync(path.join(keysDir, 'signer-audit.jsonl'), 'utf8') + fs.readFileSync(path.join(keysDir, 'signer-orders.jsonl'), 'utf8');
  assert.equal(everything.toLowerCase().includes(keyHex), false);
});

// --- inventory cap (held + open + this bid) and the approval it allows ------------------

const JBAC = '0xd37264c71e9af940e49795f0d3a8336afaafdda9';

test('PIN:P8.cap signBid refuses a bid that could take the house over its inventory cap: NFTs held + open bids + this one', async () => {
  // junglebay: maxQty 2, inventoryCap 3. The house already holds 2.
  const { signer } = setup({ chain: fakeChain({ nftBalances: { [JBAC]: 2n } }) });
  assert.equal((await signer.handle(bidRequest({ id: 'b1', qty: 2 }, NOW))).field, 'P8.cap', '2 held + 2 asked > 3');
  const one = await signer.handle(bidRequest({ id: 'b2', qty: 1 }, NOW));
  assert.equal(one.ok, true, one.reason);
  assert.equal((await signer.handle(bidRequest({ id: 'b3', qty: 1 }, NOW))).field, 'P8.cap', '2 held + 1 open + 1 asked > 3');
});

test('an open bid counts by what is still unfilled on chain, and stops counting once cancelled on chain', async () => {
  const chain = fakeChain();
  const { signer } = setup({ chain, keysDir: tempDir('cap-fill') });
  const a = await signer.handle(bidRequest({ id: 'a', qty: 2 }, NOW));
  assert.equal(a.ok, true, a.reason);
  // Half of it filled: the house holds 1 and 1 unit is still open.
  chain.state.nftBalances[JBAC] = 1n;
  chain.state.orderStatuses.set(a.orderHash, { isValidated: true, isCancelled: false, totalFilled: 1n, totalSize: 2n });
  assert.equal((await signer.handle(bidRequest({ id: 'b', qty: 2 }, NOW))).field, 'P8.cap', '1 held + 1 open + 2 > 3');
  const c = await signer.handle({ ...bidRequest({ id: 'c', qty: 1 }, NOW), unitPriceWei: '31000000000000000' });
  assert.equal(c.ok, true, c.reason);
  assert.equal((await signer.handle({ ...bidRequest({ id: 'd', qty: 1 }, NOW), unitPriceWei: '32000000000000000' })).field, 'P8.cap', 'full: 1 held + 2 open');
  chain.state.orderStatuses.set(a.orderHash, { isValidated: true, isCancelled: true, totalFilled: 1n, totalSize: 2n });
  const e = await signer.handle({ ...bidRequest({ id: 'e', qty: 1 }, NOW), unitPriceWei: '33000000000000000' });
  assert.equal(e.ok, true, `a cancelled order's last unit no longer counts: ${e.reason}`);
});

test('a bid stops counting once it has ended or the Seaport counter has moved past it', async () => {
  const chain = fakeChain();
  const { signer, clock } = setup({ chain, keysDir: tempDir('cap-end') });
  assert.equal((await signer.handle(bidRequest({ id: 'a', qty: 2 }, NOW))).ok, true);
  assert.equal((await signer.handle({ ...bidRequest({ id: 'b', qty: 2 }, NOW), unitPriceWei: '31000000000000000' })).field, 'P8.cap');
  chain.state.counter = 77n;
  assert.equal((await signer.handle({ ...bidRequest({ id: 'c', qty: 2 }, NOW), unitPriceWei: '32000000000000000' })).ok, true, 'the old order is dead after a counter bump');
  clock.advance(1830 * 1000);
  assert.equal((await signer.handle(bidRequest({ id: 'd', qty: 2 }, NOW + 1830))).field, 'P8.cap', 'a bid counts until a minute after its end time: a block\'s clock is not this PC\'s');
  clock.advance(31 * 1000);
  assert.equal((await signer.handle(bidRequest({ id: 'e', qty: 2 }, NOW + 1861))).ok, true, 'an order past its end time no longer counts');
});

test('an edited line in signer-orders.jsonl cannot hide an open bid from the cap after a restart', async () => {
  const keysDir = tempDir('cap-tamper');
  const { signer } = setup({ keysDir });
  assert.equal((await signer.handle(bidRequest({ id: 'a', qty: 2 }, NOW))).ok, true);
  const file = path.join(keysDir, 'signer-orders.jsonl');
  // The fields the order hash does not cover; the signed parameters stay as they were.
  const rec = JSON.parse(fs.readFileSync(file, 'utf8'));
  Object.assign(rec, { endTime: 0, qty: 0, slug: 'gnssart' });
  fs.writeFileSync(file, `${JSON.stringify(rec)}\n`);
  const again = setup({ keysDir }).signer;
  assert.equal((await again.handle({ ...bidRequest({ id: 'b', qty: 2 }, NOW), unitPriceWei: '31000000000000000' })).field, 'P8.cap');
});

test('two bids asked at the same moment cannot both take the last room', async () => {
  const { signer } = setup({ keysDir: tempDir('cap-race') });
  const [x, y] = await Promise.all([
    signer.handle(bidRequest({ id: 'x', qty: 2 }, NOW)),
    signer.handle({ ...bidRequest({ id: 'y', qty: 2 }, NOW), unitPriceWei: '31000000000000000' }),
  ]);
  assert.deepEqual([x.ok, y.ok].sort(), [false, true]);
  assert.equal((x.ok ? y : x).field, 'P8.cap');
});

test('PIN:T.approveRoom a WETH approval is capped at the room left under the inventory caps times the price ceilings', async () => {
  const chain = fakeChain({ nftBalances: { [JBAC]: 1n } });
  const { signer } = setup({ chain });
  // junglebay only (gnssart is off): (3 - 1) x 0.045 ETH = 0.09 ETH, under maxAllowanceWei.
  assert.equal((await signer.handle({ id: 'a1', op: 'sendTx', kind: 'approveWeth', params: { amountWei: '90000000000000001' } })).field, 'T.approveRoom');
  const ok = await signer.handle({ id: 'a2', op: 'sendTx', kind: 'approveWeth', params: { amountWei: '90000000000000000' } });
  assert.equal(ok.ok, true, ok.reason);
  chain.state.nftBalances[JBAC] = 3n;
  assert.equal((await signer.handle({ id: 'a3', op: 'sendTx', kind: 'approveWeth', params: { amountWei: '1' } })).field, 'T.approveRoom', 'a full house gets no approval');
  // Summed over every enabled collection: 1 more JBAC at 0.045 plus 2 GNSS at 0.016.
  const both = setup({ chain: fakeChain({ nftBalances: { [JBAC]: 2n } }), policyEdit: (p) => { p.collections.gnssart.enabled = true; } }).signer;
  assert.equal((await both.handle({ id: 'b1', op: 'sendTx', kind: 'approveWeth', params: { amountWei: '77000000000000001' } })).field, 'T.approveRoom');
  assert.equal((await both.handle({ id: 'b2', op: 'sendTx', kind: 'approveWeth', params: { amountWei: '77000000000000000' } })).ok, true);
});

// --- shutting down ------------------------------------------------------------------------

test('PIN:S.closing once the signer is closing it answers nothing but a kill', async () => {
  const { signer } = setup();
  signer.close();
  assert.equal((await signer.handle({ id: 'h', op: 'hello' })).field, 'S.closing');
  assert.equal((await signer.handle(bidRequest({}, NOW))).field, 'S.closing');
  assert.equal((await signer.handle({ id: 't', op: 'sendTx', kind: 'revokeWeth', params: {} })).field, 'S.closing');
  assert.equal((await signer.handle({ id: 'k', op: 'kill' })).ok, true);
});

// --- STOP names -------------------------------------------------------------------------

test('STOP is any file whose name starts with "stop", in any letter case: the STOP.txt.txt Explorer makes counts', () => {
  for (const name of ['STOP', 'STOP.txt', 'stop', 'Stop.TXT', 'STOP.txt.txt', 'STOP.md', 'stop-now', 'STOPPED']) {
    const dir = tempDir('stopname');
    fs.writeFileSync(path.join(dir, name), '');
    assert.equal(stopFilePresent(dir), true, name);
  }
  for (const name of ['signer-audit.jsonl', 'signer-orders.jsonl', 'status.json', 'policy.json', 'nonstop.txt', 'unstop', 'keystore.json']) {
    const dir = tempDir('stopname');
    fs.writeFileSync(path.join(dir, name), '');
    assert.equal(stopFilePresent(dir), false, name);
  }
  // A keys folder that cannot be read is no proof the owner did not ask to stop.
  assert.equal(stopFilePresent(path.join(tempDir('stopname'), 'missing')), true);
});

// --- daily budget -------------------------------------------------------------------------

test('PIN:T.dailyTxs with no daily budget in policy.json, at most 20 transactions go out in any 24 hours, and the kill is never held back', async () => {
  const chain = fakeChain();
  const { signer, clock } = setup({ chain });
  for (let i = 0; i < 20; i++) {
    const r = await signer.handle({ id: `r${i}`, op: 'sendTx', kind: 'revokeWeth', params: {} });
    assert.equal(r.ok, true, `${i}: ${r.field} ${r.reason}`);
  }
  assert.equal((await signer.handle({ id: 'r20', op: 'sendTx', kind: 'revokeWeth', params: {} })).field, 'T.dailyTxs');
  const before = chain.state.sent.length;
  const kill = await signer.handle({ id: 'k', op: 'kill' });
  assert.equal(kill.ok, true, kill.reason);
  assert.ok(chain.state.sent.length > before, 'the kill went out');
  clock.advance(24 * 3600 * 1000);
  assert.equal((await signer.handle({ id: 'r21', op: 'sendTx', kind: 'revokeWeth', params: {} })).ok, true, 'a new 24 hours, a new budget');
});

test('PIN:T.dailyGas the most a day of transactions could cost in gas (gas limit x max fee) stays within policy.daily.maxGasWei', async () => {
  // Base fee 5 gwei: a normal max fee is 2 x 5 + 0.05 = 10.05 gwei; a revoke's limit is 60000
  // gas, so each may cost up to 0.000603 ETH.
  const { signer } = setup({ policyEdit: (p) => { p.daily = { maxTxs: 20, maxGasWei: '1000000000000000' }; } });
  assert.equal((await signer.handle({ id: 'r1', op: 'sendTx', kind: 'revokeWeth', params: {} })).ok, true);
  assert.equal((await signer.handle({ id: 'r2', op: 'sendTx', kind: 'revokeWeth', params: {} })).field, 'T.dailyGas');
});

// --- STOP and re-broadcasts ---------------------------------------------------------------

test('PIN:T.stopResend once STOP appears, an approval still waiting to be mined is no longer re-broadcast; a revoke still is', async () => {
  const chain = fakeChain();
  const { signer, keysDir } = setup({ chain });
  chain.state.autoMine = false;
  const isApprove = (d) => d.data.startsWith(SELECTORS.approve) && BigInt(`0x${d.data.slice(74)}`) !== 0n;
  chain.state.onBroadcast = ({ decoded }) => {
    if (isApprove(decoded)) fs.writeFileSync(path.join(keysDir, 'STOP'), '');
  };
  const res = await signer.handle({ id: 'a', op: 'sendTx', kind: 'approveWeth', params: { amountWei: '1000' } });
  assert.equal(res.ok, true, res.reason);
  assert.equal(res.status, 'pending');
  assert.equal(chain.state.broadcastCount.get(res.txHash), 1, 'sent once, then never pushed again under STOP');
  const rev = await signer.handle({ id: 'r', op: 'sendTx', kind: 'revokeWeth', params: {} });
  assert.ok(chain.state.broadcastCount.get(rev.txHash) > 1, 'a revoke keeps being pushed under STOP');
});

test('the kill pads with revokes up to 16 pending transactions and no further', () => {
  const policy = makePolicy();
  assert.equal(killPlan(policy, 16).length, 16);
  assert.equal(killPlan(policy, 100).length, 16);
  assert.deepEqual(killPlan(policy, 0).map((s) => s.kind), ['revokeWeth', 'incrementCounter', 'setNftApproval']);
});
