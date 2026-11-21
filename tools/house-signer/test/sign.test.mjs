// Signatures: 65 bytes r||s||v with v 27/28, low-s, equal to viem's, and never returned
// unless they recover to the house address (PIN:P16).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { addressOf, isValidPrivateKey, recoverAddress, signDigest } from '../src/sign.mjs';
import { FIXTURE, HOUSE, HOUSE_KEY, OTHER, OTHER_KEY } from './support/helpers.mjs';

const N = secp256k1.CURVE.n;

test('the test keys give the addresses viem derives', () => {
  assert.equal(HOUSE, FIXTURE.testKeys[1].address.toLowerCase());
  assert.equal(OTHER, FIXTURE.testKeys[2].address.toLowerCase());
});

for (const o of FIXTURE.orders) {
  test(`order and cancel signatures equal viem signTypedData for: ${o.name}`, () => {
    const key = o.components.offerer.toLowerCase() === HOUSE ? HOUSE_KEY : OTHER_KEY;
    const expected = addressOf(key);
    const sig = signDigest({ digest: o.digest, privateKey: key, expected });
    assert.equal(sig.ok, true, sig.reason);
    assert.equal(sig.signature, o.signature);
    assert.equal(recoverAddress(o.digest, sig.signature), expected);
    const cancel = signDigest({ digest: o.cancel.digest, privateKey: key, expected });
    assert.equal(cancel.signature, o.cancel.signature);
  });
}

test('signatures are 65 bytes, v is 27 or 28, s is low', () => {
  for (const o of FIXTURE.orders) {
    const key = o.components.offerer.toLowerCase() === HOUSE ? HOUSE_KEY : OTHER_KEY;
    const sig = signDigest({ digest: o.digest, privateKey: key, expected: addressOf(key) });
    assert.match(sig.signature, /^0x[0-9a-f]{130}$/);
    assert.ok([27, 28].includes(parseInt(sig.signature.slice(130), 16)));
    assert.ok(sig.s <= N / 2n);
  }
});

test('PIN:P16.recover a signature that does not recover to the house is never returned', () => {
  const r = signDigest({ digest: FIXTURE.orders[0].digest, privateKey: HOUSE_KEY, expected: OTHER });
  assert.equal(r.ok, false);
  assert.equal(r.field, 'P16.recover');
  assert.equal(r.signature, undefined);
});

test('PIN:P16.lowS a high-s signature is refused even though it would recover', () => {
  // A broken signer: flips s to n - s (and the recovery bit with it), the malleable twin.
  const highS = (hash, key, opts) => {
    const sig = secp256k1.sign(hash, key, opts);
    return { r: sig.r, s: N - sig.s, recovery: sig.recovery ^ 1 };
  };
  const r = signDigest({ digest: FIXTURE.orders[0].digest, privateKey: HOUSE_KEY, expected: HOUSE, signImpl: highS });
  assert.equal(r.ok, false);
  assert.equal(r.field, 'P16.lowS');
});

test('a malformed digest or a missing recovery bit is refused', () => {
  assert.equal(signDigest({ digest: '0x1234', privateKey: HOUSE_KEY, expected: HOUSE }).ok, false);
  const noBit = (hash, key, opts) => ({ ...secp256k1.sign(hash, key, opts), recovery: undefined });
  assert.equal(signDigest({ digest: FIXTURE.orders[0].digest, privateKey: HOUSE_KEY, expected: HOUSE, signImpl: noBit }).ok, false);
});

test('private key validation', () => {
  assert.equal(isValidPrivateKey(HOUSE_KEY), true);
  assert.equal(isValidPrivateKey(new Uint8Array(32)), false);
  assert.equal(isValidPrivateKey(new Uint8Array(31).fill(1)), false);
  assert.throws(() => addressOf(new Uint8Array(32)), /not a valid/);
  assert.throws(() => recoverAddress(FIXTURE.orders[0].digest, `0x${'00'.repeat(64)}1b00`), /65 bytes/);
});
