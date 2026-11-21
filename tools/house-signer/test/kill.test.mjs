// The kill, against a fake chain: its order, that its first transaction replaces whatever
// is pending at the lowest nonce (same nonce, higher fees), that it covers every pending
// nonce, that it re-sends each block until mined, that a revoke which loses the race to
// a pending transaction is sent again, that it only reports success for steps that landed,
// and that it latches (STOP) before it sends anything.

import { mock, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createSigner, stopFilePresent } from '../src/signer.mjs';
import { SELECTORS } from '../src/abi.mjs';
import { bidRequest, fakeChain, fakeClock, HOUSE_KEY, makePolicy, tempDir } from './support/helpers.mjs';

const NOW_MS = 1_763_251_200_000;
const WETH = '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2';
const SEAPORT = '0x0000000000000068f116a894984e2db1123eb395';
const JBAC = '0xd37264c71e9af940e49795f0d3a8336afaafdda9';
const GNSS = '0xa1de9f93c56c290c48849b1393b09eb616d55dbb';

function setup({ chain = fakeChain(), policyEdit, mode = 'live', sendUrls = ['https://send.example'] } = {}) {
  const clock = fakeClock(NOW_MS);
  const keysDir = tempDir('kill');
  const policy = makePolicy(policyEdit);
  const signer = createSigner({
    privateKey: HOUSE_KEY, policy, policySha256: 'ab'.repeat(32), keysDir, chain, sendUrls, mode, nowMs: clock.nowMs, sleep: clock.sleep, watch: false,
  });
  return { signer, chain, clock, keysDir, policy };
}

const kindOf = (d) => {
  if (d.to === WETH && d.data.startsWith(SELECTORS.approve)) return BigInt(`0x${d.data.slice(74)}`) === 0n ? 'revokeWeth' : 'approveWeth';
  if (d.to === SEAPORT && d.data === SELECTORS.incrementCounter) return 'incrementCounter';
  if (d.data.startsWith(SELECTORS.setApprovalForAll)) return `setNftApproval:${d.to === JBAC ? 'junglebay' : d.to === GNSS ? 'gnssart' : d.to}:${BigInt(`0x${d.data.slice(74)}`)}`;
  return 'other';
};

test('kill sends revoke WETH, bump counter, then NFT revokes, at consecutive nonces from the lowest pending one, with the kill fees', async () => {
  const chain = fakeChain({ latest: 17n });
  const { signer, policy } = setup({ chain, policyEdit: (p) => { p.collections.gnssart.enabled = true; } });
  const res = await signer.handle({ id: 'k', op: 'kill' });
  assert.equal(res.ok, true, res.reason);
  assert.equal(res.allMined, true);
  const sent = chain.state.sent.map((s) => s.decoded);
  assert.deepEqual(sent.map(kindOf), ['revokeWeth', 'incrementCounter', 'setNftApproval:junglebay:0', 'setNftApproval:gnssart:0']);
  assert.deepEqual(sent.map((d) => d.nonce), [17n, 18n, 19n, 20n]);
  for (const d of sent) {
    assert.equal(d.maxFeePerGas, policy.gas.maxFeeWei);
    assert.equal(d.maxPriorityFeePerGas, policy.gas.killPriorityWei);
    assert.equal(d.value, 0n);
  }
  assert.deepEqual(res.txs.map((t) => [t.kind, t.nonce, t.status]), [
    ['revokeWeth', 17, 'mined'], ['incrementCounter', 18, 'mined'], ['setNftApproval', 19, 'mined'], ['setNftApproval', 20, 'mined'],
  ]);
});

test('the first kill transaction replaces a pending house transaction: same nonce, higher fees', async () => {
  const chain = fakeChain({ latest: 5n, baseFee: 2_000_000_000n });
  const { signer } = setup({ chain });
  // A normal transaction that never gets mined: it is still pending when the kill comes.
  chain.state.autoMine = false;
  const pending = await signer.handle({ id: 'a', op: 'sendTx', kind: 'approveWeth', params: { amountWei: '1000' } });
  assert.equal(pending.status, 'pending');
  assert.equal(pending.nonce, 5);
  const stuck = chain.state.sent[0].decoded;
  chain.state.autoMine = true;
  chain.state.neverMine.add(pending.txHash);
  const res = await signer.handle({ id: 'k', op: 'kill' });
  assert.equal(res.ok, true, res.reason);
  const first = chain.state.sent[1].decoded;
  assert.equal(kindOf(first), 'revokeWeth');
  assert.equal(first.nonce, stuck.nonce, 'the kill takes the pending transaction\'s nonce');
  // Nodes take a replacement only if both fees rise by at least 10%.
  assert.ok(first.maxFeePerGas * 10n >= stuck.maxFeePerGas * 11n, 'max fee up at least 10%');
  assert.ok(first.maxPriorityFeePerGas * 10n >= stuck.maxPriorityFeePerGas * 11n, 'tip up at least 10%');
});

test('works while STOP exists', async () => {
  const { signer, keysDir, chain } = setup();
  fs.writeFileSync(path.join(keysDir, 'STOP'), '');
  const res = await signer.handle({ id: 'k', op: 'kill' });
  assert.equal(res.ok, true, res.reason);
  assert.equal(chain.state.sent.length, 3);
});

test('more pending transactions than kill steps: extra revokes replace every one of them', async () => {
  const chain = fakeChain({ latest: 30n, pending: 35n });
  const { signer } = setup({ chain });
  const res = await signer.handle({ id: 'k', op: 'kill' });
  assert.equal(res.ok, true, res.reason);
  const sent = chain.state.sent.map((s) => s.decoded);
  assert.deepEqual(sent.map((d) => d.nonce), [30n, 31n, 32n, 33n, 34n]);
  assert.deepEqual(sent.map(kindOf), ['revokeWeth', 'incrementCounter', 'setNftApproval:junglebay:0', 'revokeWeth', 'revokeWeth']);
});

test('re-sends every block until mined', async () => {
  const chain = fakeChain({ latest: 0n });
  const { signer } = setup({ chain });
  chain.state.autoMine = false;
  let blocks = 0;
  const realBlock = chain.blockNumber;
  chain.blockNumber = async () => {
    blocks += 1;
    if (blocks === 6) chain.state.autoMine = true;
    return realBlock();
  };
  const res = await signer.handle({ id: 'k', op: 'kill' });
  assert.equal(res.ok, true, res.reason);
  assert.equal(res.allMined, true);
  for (const s of chain.state.sent) assert.ok(chain.state.broadcastCount.get(s.hash) >= 4, `re-sent per block (${chain.state.broadcastCount.get(s.hash)})`);
});

test('after three minutes unmined it answers pending rather than waiting forever', async () => {
  const chain = fakeChain();
  const { signer, clock } = setup({ chain });
  chain.state.autoMine = false;
  const start = clock.nowMs();
  const res = await signer.handle({ id: 'k', op: 'kill' });
  assert.equal(res.ok, true);
  assert.equal(res.allMined, false);
  assert.ok(res.txs.every((t) => t.status === 'pending'));
  assert.ok(clock.nowMs() - start >= 180_000 && clock.nowMs() - start < 200_000);
});

test('a revoke that loses the race to a pending transaction is sent again with a fresh nonce', async () => {
  const chain = fakeChain({ latest: 8n, pending: 9n });
  const { signer } = setup({ chain });
  // The transaction already pending at nonce 8 gets mined before the kill's revoke can
  // replace it: the revoke's nonce is used up and it never lands.
  chain.state.onBroadcast = ({ hash, decoded }) => {
    if (decoded.nonce === 8n && kindOf(decoded) === 'revokeWeth') {
      chain.state.neverMine.add(hash);
      chain.state.latest = 9n;
    }
  };
  const res = await signer.handle({ id: 'k', op: 'kill' });
  assert.equal(res.ok, true, res.reason);
  const revokes = chain.state.sent.filter((s) => kindOf(s.decoded) === 'revokeWeth').map((s) => s.decoded.nonce);
  assert.deepEqual(revokes, [8n, 11n]);
  assert.equal(res.txs.find((t) => t.nonce === 8).replaced, true);
  assert.equal(res.txs.find((t) => t.nonce === 11).status, 'mined');
  assert.equal(res.allMined, true);
});

test('PIN:D.kill dev mode refuses to send the kill anywhere but a local test chain', async () => {
  const { signer, chain } = setup({ mode: 'dev', sendUrls: ['https://rpc.flashbots.net/fast'] });
  const res = await signer.handle({ id: 'k', op: 'kill' });
  assert.equal(res.field, 'D.kill');
  assert.equal(chain.state.sent.length, 0);
});

test('a nonce read failure is reported, not guessed', async () => {
  const chain = fakeChain();
  chain.nonce = async () => {
    throw Object.assign(new Error('no read endpoint answered'), { kind: 'network' });
  };
  const { signer } = setup({ chain });
  const res = await signer.handle({ id: 'k', op: 'kill' });
  assert.equal(res.ok, false);
  assert.equal(res.field, 'rpc');
});

test('a kill whose WETH revoke never lands, in any round, answers ok:false, so neither the bot nor the CLI calls it done', async () => {
  const chain = fakeChain({ latest: 8n });
  const { signer } = setup({ chain });
  // Every revoke loses its nonce to a transaction already in flight (for example an approval
  // from a serve process that is still running while the owner runs the CLI kill).
  chain.state.onBroadcast = ({ hash, decoded }) => {
    if (kindOf(decoded) === 'revokeWeth') {
      chain.state.neverMine.add(hash);
      if (chain.state.latest <= decoded.nonce) chain.state.latest = decoded.nonce + 1n;
    }
  };
  const res = await signer.handle({ id: 'k', op: 'kill' });
  const revokes = res.txs.filter((t) => t.kind === 'revokeWeth');
  assert.equal(revokes.length, 3, 'the revoke is sent in each of the three rounds');
  assert.ok(revokes.every((t) => t.replaced), 'and its nonce is taken every time');
  assert.equal(res.ok, false, 'a kill whose revoke never landed is not a success');
  assert.equal(res.field, 'kill');
  assert.match(res.reason, /revokeWeth/);
  assert.notEqual(res.allMined, true);
});

test('a kill transaction that is mined but reverts did not happen either', async () => {
  const chain = fakeChain({ latest: 3n });
  const { signer } = setup({ chain });
  chain.state.onBroadcast = ({ hash, decoded }) => {
    if (kindOf(decoded) === 'incrementCounter') {
      chain.state.receipts.set(hash, { status: 'reverted', blockNumber: chain.state.block });
      chain.state.latest = decoded.nonce + 1n;
    }
  };
  const res = await signer.handle({ id: 'k', op: 'kill' });
  assert.equal(res.txs.find((t) => t.kind === 'incrementCounter').success, false);
  assert.equal(res.ok, false);
  assert.match(res.reason, /incrementCounter/);
});

test('an endpoint that reports a huge pending count cannot stall the kill: the fixed steps go first, the padding stops at 16 and the gap is reported', async () => {
  const chain = fakeChain({ latest: 5n });
  // One endpoint answers pending = latest + 1000 (a bug, or a lie).
  chain.nonce = async (_a, tag) => (tag === 'pending' ? 1005n : chain.state.latest);
  const { signer } = setup({ chain });
  const res = await signer.handle({ id: 'k', op: 'kill' });
  const sent = chain.state.sent.map((s) => s.decoded);
  assert.equal(sent.length, 16, `sent ${sent.length} kill transactions`);
  assert.deepEqual(sent.slice(0, 3).map(kindOf), ['revokeWeth', 'incrementCounter', 'setNftApproval:junglebay:0']);
  assert.deepEqual(sent.map((d) => d.nonce), Array.from({ length: 16 }, (_, i) => 5n + BigInt(i)));
  assert.equal(res.ok, false, 'pending transactions the kill did not replace are reported');
  assert.match(res.reason, /1000 pending/);
});

test('the kill takes the lowest latest nonce any endpoint reports, and pads up to the highest pending one', async () => {
  const chain = fakeChain({ latest: 5n });
  // The first endpoint (the one a single read would use) says latest 9: a kill sent there
  // would wait behind a nonce gap for ever. The second has the truth.
  chain.nonce = async () => 9n;
  chain.nonces = async (_a, tag) => (tag === 'pending' ? [9n, 7n] : [9n, chain.state.latest]);
  const { signer } = setup({ chain });
  const res = await signer.handle({ id: 'k', op: 'kill' });
  assert.equal(res.ok, true, res.reason);
  const sent = chain.state.sent.map((s) => s.decoded);
  assert.deepEqual(sent.map((d) => d.nonce), [5n, 6n, 7n, 8n]);
  assert.deepEqual(sent.map(kindOf), ['revokeWeth', 'incrementCounter', 'setNftApproval:junglebay:0', 'revokeWeth']);
});

test('PIN:T.killStop the kill latches: STOP is in the keys folder before anything is sent, and after it no signer on that folder signs a bid, approves WETH or wraps', async () => {
  const chain = fakeChain({ latest: 0n });
  const { signer, keysDir, clock } = setup({ chain });
  // The serve process the bot talks to, on the same keys folder (the CLI kill is another process).
  const serve = createSigner({
    privateKey: HOUSE_KEY, policy: makePolicy(), policySha256: 'ab'.repeat(32), keysDir, chain, sendUrls: ['https://send.example'], nowMs: clock.nowMs, sleep: clock.sleep, watch: false,
  });
  let stopAtFirstSend = null;
  chain.state.onBroadcast = () => {
    if (stopAtFirstSend === null) stopAtFirstSend = stopFilePresent(keysDir);
  };
  const kill = await signer.handle({ id: 'k', op: 'kill' });
  assert.equal(kill.ok, true, kill.reason);
  assert.equal(stopAtFirstSend, true, 'STOP was written before the first kill transaction went out');
  const nowSec = Math.floor(clock.nowMs() / 1000);
  for (const [name, s] of [['the kill\'s signer', signer], ['the serve signer', serve]]) {
    assert.equal((await s.handle(bidRequest({ id: 'b' }, nowSec))).field, 'P15', name);
    assert.equal((await s.handle({ id: 'a', op: 'sendTx', kind: 'approveWeth', params: { amountWei: '1000' } })).field, 'T.stop', name);
    assert.equal((await s.handle({ id: 'w', op: 'sendTx', kind: 'wrap', params: { amountWei: '1000' } })).field, 'T.stop', name);
    assert.equal((await s.handle({ id: 'r', op: 'sendTx', kind: 'revokeWeth', params: {} })).ok, true, `${name}: a revoke still goes out`);
  }
  // Only the owner deleting STOP lets bids through again.
  for (const f of fs.readdirSync(keysDir).filter((n) => /^stop/i.test(n))) fs.rmSync(path.join(keysDir, f));
  assert.equal((await serve.handle(bidRequest({ id: 'b2' }, nowSec))).ok, true);
});

test('a kill that cannot write STOP (a full disk) still latches this signer until it is restarted', async () => {
  const chain = fakeChain({ latest: 0n });
  const { signer, keysDir, clock } = setup({ chain });
  const realWrite = fs.writeFileSync;
  const full = mock.method(fs, 'writeFileSync', (file, ...rest) => {
    if (/stop/i.test(path.basename(String(file)))) throw Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' });
    return realWrite(file, ...rest);
  });
  try {
    const kill = await signer.handle({ id: 'k', op: 'kill' });
    assert.equal(kill.ok, true, kill.reason);
  } finally {
    full.mock.restore();
  }
  assert.equal(stopFilePresent(keysDir), false, 'no STOP file could be written');
  const nowSec = Math.floor(clock.nowMs() / 1000);
  assert.equal((await signer.handle(bidRequest({ id: 'b' }, nowSec))).field, 'P15');
  assert.equal((await signer.handle({ id: 'a', op: 'sendTx', kind: 'approveWeth', params: { amountWei: '1000' } })).field, 'T.stop');
  assert.equal((await signer.handle({ id: 'h', op: 'hello' })).stopped, true);
});
