// Reading order data as strictly as the contract's own cast, and hashing data as the contract
// does (builtin serialise_data), not as the bytes happened to arrive.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import CSL from '@emurgo/cardano-serialization-lib-nodejs';
import { datumMatches, plutusDataHash, plutusSerialise } from '../src/chain.ts';
import { DecodeError, fieldsOf, mkBytes, mkConstr, mkInt, type PlutusData } from '../src/plutus.ts';
import { decodeOrderDatum } from '../src/types.ts';

const fx = JSON.parse(readFileSync(new URL('./fixtures/minswap-batches.json', import.meta.url), 'utf8')) as { spent: Record<string, string> };
// The venue's own 25 ADA buy order (order tx 2487374c...b1f1, output 0), as it sat on chain.
const BUY_ORDER = CSL.TransactionOutput.from_hex(fx.spent['2487374c1bcc496ef19b33614057d7b96cf6ade2d97faf6a52e5e61ad8eab1f1#0']!).plutus_data()!;
const hex = (b: Uint8Array) => Buffer.from(b).toString('hex');

const withCanceller = (canceller: PlutusData) => mkConstr(0, fieldsOf(BUY_ORDER, 0, 9, 'OrderDatum').map((f, i) => (i === 0 ? canceller : f)));

test('the real order reads, canceller and all', () => {
  assert.equal(decodeOrderDatum(BUY_ORDER).step.kind, 'SwapExactIn');
});

test('an order with a malformed canceller is refused, as the contract’s cast fails the batch', () => {
  for (const bad of [mkConstr(9, []), mkConstr(0, [mkInt(7n)]), mkConstr(0, [mkBytes('00'), mkBytes('00')]), mkConstr(4, [mkBytes('00')])]) {
    assert.throws(() => decodeOrderDatum(withCanceller(bad)), DecodeError);
  }
  for (let alt = 0; alt <= 3; alt++) assert.equal(decodeOrderDatum(withCanceller(mkConstr(alt, [mkBytes('ab'.repeat(28))]))).step.kind, 'SwapExactIn');
});

test('serialise_data: Plutus’s own encoding, whatever bytes the data arrived in', () => {
  // Constr 0 [1, 2] written with a definite-length array still serialises indefinite.
  const definite = CSL.PlutusData.from_hex('d879820102');
  assert.equal(hex(plutusSerialise(definite)), 'd8799f0102ff');
  assert.notEqual(plutusDataHash(definite), CSL.hash_plutus_data(definite).to_hex());
  assert.equal(plutusDataHash(definite), CSL.hash_plutus_data(CSL.PlutusData.from_hex('d8799f0102ff')).to_hex());
  assert.equal(hex(plutusSerialise(mkConstr(0, []))), 'd87980');
  assert.equal(hex(plutusSerialise(mkConstr(7, [mkInt(1n)]))), 'd905009f01ff');
  assert.equal(hex(plutusSerialise(mkConstr(200, []))), 'd8668218c880'); // tag 102 [200, []]
  assert.equal(hex(plutusSerialise(mkInt(-1n))), '20');
  assert.equal(hex(plutusSerialise(mkInt(1n << 64n))), 'c249010000000000000000');
  assert.equal(hex(plutusSerialise(mkInt(-(1n << 64n) - 1n))), 'c349010000000000000000');
  const long = 'ab'.repeat(65);
  assert.equal(hex(plutusSerialise(mkBytes(long))), `5f5840${'ab'.repeat(64)}41abff`);
  assert.equal(hex(plutusSerialise(mkBytes('ab'.repeat(64)))), `5840${'ab'.repeat(64)}`);
});

test('an inline receiver datum is matched by the hash of its Plutus serialisation', () => {
  const definite = CSL.PlutusData.from_hex('d879820102');
  const onChainHash = plutusDataHash(definite);
  assert.equal(datumMatches({ kind: 'inline', hash: onChainHash }, { kind: 'inline', data: definite }), true);
  // The hash of the arrival bytes is not what the contract computes.
  assert.equal(datumMatches({ kind: 'inline', hash: CSL.hash_plutus_data(definite).to_hex() }, { kind: 'inline', data: definite }), false);
});
