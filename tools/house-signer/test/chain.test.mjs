// The signer's RPC layer against a fake fetch: which answers it trusts when it has more than
// one read endpoint. Nothing here reaches a network.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createChain } from '../src/chain.mjs';
import { SELECTORS } from '../src/abi.mjs';

const HOUSE = '0x1111111111111111111111111111111111111111';
const JBAC = '0xd37264c71e9af940e49795f0d3a8336afaafdda9';
const TX = `0x${'ab'.repeat(32)}`;
const word = (n) => BigInt(n).toString(16).padStart(64, '0');

/** fetch for endpoints a.example and b.example; `answers[host](method, params)` gives the result, or throws for "down". */
function chainWith(answers) {
  const fetchImpl = async (url, init) => {
    const host = new URL(url).host;
    const body = JSON.parse(init.body);
    if (!answers[host]) throw new TypeError('fetch failed');
    const result = await answers[host](body.method, body.params);
    return { ok: true, status: 200, json: async () => ({ jsonrpc: '2.0', id: body.id, result }) };
  };
  return createChain({ readUrls: ['https://a.example/key', 'https://b.example/key'], sendUrls: [], fetchImpl });
}

const receipt = { status: '0x1', blockNumber: '0x10' };

test('a receipt counts only when every endpoint that answers has it: one endpoint alone cannot fake a mined transaction', async () => {
  const lying = chainWith({ 'a.example': () => receipt, 'b.example': () => null });
  assert.equal(await lying.receipt(TX), null, 'a has it, b does not: not mined yet');
  const both = chainWith({ 'a.example': () => receipt, 'b.example': () => receipt });
  assert.deepEqual(await both.receipt(TX), { status: 'success', blockNumber: 16n });
  const split = chainWith({ 'a.example': () => receipt, 'b.example': () => ({ status: '0x0', blockNumber: '0x10' }) });
  assert.equal(await split.receipt(TX), null, 'endpoints that disagree confirm nothing');
  const oneDown = chainWith({ 'a.example': () => receipt });
  assert.deepEqual(await oneDown.receipt(TX), { status: 'success', blockNumber: 16n }, 'an endpoint that does not answer is not a vote');
  await assert.rejects(chainWith({}).receipt(TX), /no endpoint answered/);
});

test('nonces asks every read endpoint and returns each answer', async () => {
  const chain = chainWith({ 'a.example': (m, p) => (m === 'eth_getTransactionCount' && p[1] === 'latest' ? '0x9' : '0xc'), 'b.example': () => '0x5' });
  assert.deepEqual(await chain.nonces(HOUSE, 'latest'), [9n, 5n]);
  assert.deepEqual(await chainWith({ 'b.example': () => '0x5' }).nonces(HOUSE, 'pending'), [5n]);
  await assert.rejects(chainWith({}).nonces(HOUSE, 'latest'), /no endpoint answered/);
});

test('one unreachable read endpoint does not stop the start-up chain check: it is listed as not answering', async () => {
  const chain = chainWith({ 'a.example': () => '0x1' });
  const ids = await chain.chainIds();
  assert.deepEqual(ids.map((x) => [x.host, x.chainId]), [['a.example', 1n], ['b.example', null]]);
  assert.match(ids[1].error, /b\.example: could not be reached/);
});

test('the house\'s NFT balance and its orders\' status are read from every endpoint, which must agree', async () => {
  const status = `0x${word(1)}${word(0)}${word(1)}${word(2)}`;
  const answer = (balance) => (m, p) => (p[0].data.startsWith(SELECTORS.balanceOf) ? `0x${word(balance)}` : status);
  const chain = chainWith({ 'a.example': answer(2), 'b.example': answer(2) });
  assert.equal(await chain.nftBalance(JBAC, HOUSE), 2n);
  assert.deepEqual(await chain.orderStatus(TX), { isValidated: true, isCancelled: false, totalFilled: 1n, totalSize: 2n });
  await assert.rejects(chainWith({ 'a.example': answer(0), 'b.example': answer(2) }).nftBalance(JBAC, HOUSE), (e) => e.kind === 'disagree');
  assert.equal(await chainWith({ 'b.example': answer(3) }).nftBalance(JBAC, HOUSE), 3n, 'an endpoint that is down is not a vote');
});
