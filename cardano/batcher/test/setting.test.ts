// The GlobalSetting our pools hold: Minswap's six fields, then the pool creation fee and its
// receiver (#1016). Read from the bytes #1016's own type writes: its factory test
// the_setting_as_the_batcher_reads_it pins them, and this test reads that same literal.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import CSL from '@emurgo/cardano-serialization-lib-nodejs';
import { DecodeError, fieldsOf, mkBytes, mkConstr, mkInt } from '../src/plutus.ts';
import { decodeGlobalSetting } from '../src/types.ts';

const ak = readFileSync(new URL('../../minswap-tests/factory_validator.ak', import.meta.url), 'utf8');
const pinned = /test the_setting_as_the_batcher_reads_it\(\) \{\s*builtin\.serialise_data\(test_setting\(test_fee\)\) == #"([0-9a-f]+)"/.exec(ak)?.[1];
const OURS = CSL.PlutusData.from_hex(pinned ?? '');
const fields = () => fieldsOf(OURS, 0, 8, 'GlobalSetting');

test('our GlobalSetting reads as #1016’s type writes it', () => {
  assert.ok(pinned, 'the factory test the_setting_as_the_batcher_reads_it is gone or reworded');
  const s = decodeGlobalSetting(OURS, 'ours');
  assert.deepEqual(s.batchers, [{ kind: 'signature', hash: '61'.repeat(28) }]);
  assert.deepEqual(s.poolCreation, { fee: 73_000_000n, receiver: { payment: { kind: 'script', hash: '70'.repeat(28) }, stake: null } });
});

test('Minswap’s own six-field setting is not ours, and ours is not Minswap’s', () => {
  const minswap = mkConstr(0, fields().slice(0, 6));
  assert.throws(() => decodeGlobalSetting(minswap, 'ours'), DecodeError);
  assert.deepEqual(decodeGlobalSetting(minswap, 'minswap'), { batchers: [{ kind: 'signature', hash: '61'.repeat(28) }], poolCreation: null });
  assert.throws(() => decodeGlobalSetting(OURS, 'minswap'), DecodeError);
});

test('a fee or receiver the contract’s cast would refuse is refused', () => {
  const with7 = (i: number, d: CSL.PlutusData) => mkConstr(0, fields().map((f, j) => (j === i ? d : f)));
  assert.throws(() => decodeGlobalSetting(with7(6, mkBytes('00')), 'ours'), DecodeError);
  assert.throws(() => decodeGlobalSetting(with7(7, mkInt(0n)), 'ours'), DecodeError);
  assert.throws(() => decodeGlobalSetting(with7(7, mkConstr(0, [mkConstr(1, [mkBytes('70'.repeat(28))])])), 'ours'), DecodeError);
});
