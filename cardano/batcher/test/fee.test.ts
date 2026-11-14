// The ledger's minimum fee, proven on known answers before it sets any batch's fee: twelve real
// Minswap V2 batches mainnet accepted (so none paid less than the minimum), EMURGO's own
// reference-script tiers at every edge, and exact rates however the parameters print them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import CSL from '@emurgo/cardano-serialization-lib-nodejs';
import { ledgerMinFee, rational, refScriptFee, scriptFee } from '../src/fee.ts';
import { DecodeError } from '../src/plutus.ts';
import { PP } from './world.ts';

const fx = JSON.parse(readFileSync(new URL('./fixtures/minswap-batches.json', import.meta.url), 'utf8')) as {
  batches: { tx: string; cbor: string }[];
  spent: Record<string, string>;
};

test('every real Minswap batch paid at least the minimum, and within 0.01 ADA of it', () => {
  for (const b of fx.batches) {
    const fee = BigInt(CSL.Transaction.from_hex(b.cbor).body().fee().to_str());
    const slack = fee - ledgerMinFee(b.cbor, fx.spent, PP);
    // Minswap's batcher pays 6,380 to 6,644 lovelace over: one formula off by a reference
    // script (333,945), a signature (4,444) or the scripts' price lands outside.
    assert.ok(slack >= 0n && slack < 10_000n, `${b.tx}: ${slack}`);
  }
});

test('the reference-script tiers match EMURGO’s at every edge', () => {
  const perByte = CSL.UnitInterval.new(CSL.BigNum.from_str('15'), CSL.BigNum.from_str('1'));
  for (const size of [0, 1, 22_263, 25_599, 25_600, 25_601, 51_200, 60_000, 200_000]) {
    assert.equal(refScriptFee(size, { n: 15n, d: 1n }), BigInt(CSL.min_ref_script_fee(size, perByte).to_str()), `${size} bytes`);
  }
  assert.equal(refScriptFee(25_600 + 10, { n: 15n, d: 1n }), 384_000n + 180n); // the second tier at 18 a byte
});

test('rates are read exactly, however they print', () => {
  assert.deepEqual(rational(0.0577), { n: 577n, d: 10_000n });
  assert.deepEqual(rational(0.0000721), { n: 721n, d: 10_000_000n });
  assert.deepEqual(rational(7.2e-7), { n: 72n, d: 100_000_000n }); // prints as "7.2e-7"
  assert.deepEqual(rational('577/10000'), { n: 577n, d: 10_000n });
  assert.deepEqual(rational(15), { n: 15n, d: 1n });
  assert.deepEqual(rational(1e21), { n: 10n ** 21n, d: 1n }); // prints as "1e+21"
  for (const bad of ['-1', '1/0', 'NaN', '', '0x10']) assert.throws(() => rational(bad), DecodeError, bad);
});

test('the scripts are priced with one ceiling over the whole transaction, never a floor', () => {
  assert.equal(scriptFee(0n, 0n, PP), 0n);
  assert.equal(scriptFee(1n, 1n, PP), 1n); // 0.0577 + 0.0000721, rounded up
  assert.equal(scriptFee(10_000n, 0n, PP), 577n);
  assert.equal(scriptFee(10_001n, 10_000_000n, PP), 578n + 721n); // 577.0577 + 721
});
