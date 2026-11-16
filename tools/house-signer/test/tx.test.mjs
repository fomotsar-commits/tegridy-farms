// EIP-1559 serialization and signing against viem's serializeTransaction and
// signTransaction (test/fixtures/viem-fixture.json): byte for byte, and the same hash.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gasLimitFor, serializeUnsigned, signTx } from '../src/tx.mjs';
import { rlpEncode } from '../src/rlp.mjs';
import { bytesToHex, hexToBytes } from '../src/hex.mjs';
import { decodeTx, FIXTURE, HOUSE, HOUSE_KEY, OTHER, txHashOf } from './support/helpers.mjs';

const toTx = (t) => ({
  type: 2,
  chainId: BigInt(t.chainId),
  nonce: BigInt(t.nonce),
  maxPriorityFeePerGas: BigInt(t.maxPriorityFeePerGas),
  maxFeePerGas: BigInt(t.maxFeePerGas),
  gas: BigInt(t.gas),
  to: t.to.toLowerCase(),
  value: BigInt(t.value),
  data: t.data,
  accessList: [],
});

for (const t of FIXTURE.txs) {
  test(`unsigned, signed and hash equal viem for: ${t.name}`, () => {
    const tx = toTx(t.tx);
    assert.equal(serializeUnsigned(tx), t.unsigned);
    const signed = signTx(tx, HOUSE_KEY, HOUSE);
    assert.equal(signed.ok, true, signed.reason);
    assert.equal(signed.raw, t.signed);
    assert.equal(signed.hash, t.hash);
    assert.equal(txHashOf(signed.raw), t.hash);
    // And read back with the tests' own decoder.
    const d = decodeTx(signed.raw);
    assert.equal(d.chainId, 1n);
    assert.equal(d.nonce, tx.nonce);
    assert.equal(d.to, tx.to);
    assert.equal(d.data, tx.data);
    assert.deepEqual(d.accessList, []);
  });
}

test('signTx refuses to produce a transaction from any key but the house', () => {
  const tx = toTx(FIXTURE.txs[0].tx);
  const r = signTx(tx, HOUSE_KEY, OTHER);
  assert.equal(r.ok, false);
  assert.equal(r.field, 'P16.recover');
});

test('signTx refuses anything but a type 2 mainnet transaction', () => {
  const tx = toTx(FIXTURE.txs[0].tx);
  assert.equal(signTx({ ...tx, type: 4 }, HOUSE_KEY, HOUSE).ok, false);
  assert.equal(signTx({ ...tx, chainId: 5n }, HOUSE_KEY, HOUSE).ok, false);
});

test('rlp encodes strings and lists by the yellow-paper rules', () => {
  assert.equal(bytesToHex(rlpEncode(new Uint8Array(0))), '0x80');
  assert.equal(bytesToHex(rlpEncode(Uint8Array.of(0x7f))), '0x7f');
  assert.equal(bytesToHex(rlpEncode(Uint8Array.of(0x80))), '0x8180');
  assert.equal(bytesToHex(rlpEncode([])), '0xc0');
  assert.equal(bytesToHex(rlpEncode(new Uint8Array(56).fill(1))).slice(0, 6), '0xb838');
  assert.equal(bytesToHex(rlpEncode([new Uint8Array(0), [new Uint8Array(0)]])), '0xc380c180');
  const long = new Uint8Array(1024).fill(2);
  assert.equal(bytesToHex(rlpEncode(long)).slice(0, 8), '0xb90400');
  assert.throws(() => rlpEncode('x'), /bytes or a list/);
  assert.equal(hexToBytes('0x').length, 0);
});

test('gas limits stay under the default policy cap, and a cancel grows per order', () => {
  for (const kind of ['approveWeth', 'revokeWeth', 'wrap', 'unwrap', 'returnWethToFunding', 'incrementCounter', 'setNftApproval', 'returnNftToFunding']) {
    assert.ok(gasLimitFor({ kind }) <= 300_000n, kind);
  }
  assert.equal(gasLimitFor({ kind: 'cancelOnChain', orders: [1] }), 80_000n);
  assert.equal(gasLimitFor({ kind: 'cancelOnChain', orders: [1, 2, 3, 4, 5, 6] }), 255_000n);
});
