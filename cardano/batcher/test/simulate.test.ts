// The simulator itself, proven on known answers before it judges our batches: every real
// Minswap V2 batch from mainnet passes `aiken tx simulate`, and the same batch tampered fails.
// Needs AIKEN=<path to aiken 1.0.24>.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import CSL from '@emurgo/cardano-serialization-lib-nodejs';
import { simulate, withoutSetTags } from '../src/simulate.ts';
import { plusFirstToken, poolDatumPlus, withOutput } from './tamper.ts';

const AIKEN = process.env.AIKEN ?? '';
const skip = existsSync(AIKEN) ? false : 'needs Aiken 1.0.24: set AIKEN=<path to aiken>';
const fx = JSON.parse(readFileSync(new URL('./fixtures/minswap-batches.json', import.meta.url), 'utf8')) as {
  batches: { tx: string; covers: string; cbor: string }[];
  spent: Record<string, string>;
};

test('every real Minswap batch runs every script to success', { skip }, () => {
  for (const b of fx.batches) {
    const r = simulate(AIKEN, b.cbor, fx.spent);
    assert.ok(r.ok, `${b.tx}: ${r.ok ? '' : r.error}`);
    assert.ok(r.budgets.some((x) => x.tag === 'Reward' && x.index === 0), `${b.tx}: the batching script did not run`);
  }
});

test('the same batch tampered fails in the batching script', { skip }, () => {
  const buy = fx.batches[0]!.cbor;
  for (const bad of [withOutput(buy, 0, (o) => ({ value: plusFirstToken(o.amount(), -1n) })), withOutput(buy, 1, (o) => ({ datum: poolDatumPlus(o.plutus_data()!, 4, 1n) }))]) {
    const r = simulate(AIKEN, bad, fx.spent);
    assert.equal(r.ok, false);
    assert.match(r.ok ? '' : r.error, /Redeemer \(Reward, 0\).*error/s);
  }
});

test('the set tags come off by a real CBOR walk: same items, nothing else touched', () => {
  const hex = fx.batches[0]!.cbor;
  const plain = withoutSetTags(hex);
  assert.ok(!/^84a[0-9a-f]00d90102/.test(plain));
  // The same body, item for item: CSL reads both to the same inputs and outputs.
  const a = CSL.Transaction.from_hex(hex).body();
  const b = CSL.Transaction.from_hex(plain).body();
  assert.equal(b.inputs().len(), a.inputs().len());
  assert.equal(b.outputs().to_hex(), a.outputs().to_hex());
  // A byte string holding d9 01 02 is left alone.
  const bytes = CSL.PlutusData.new_bytes(Buffer.from('d90102d90102', 'hex')).to_hex();
  assert.equal(withoutSetTags(bytes), bytes);
});
