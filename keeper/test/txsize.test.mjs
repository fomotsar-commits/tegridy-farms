import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { classify, compactLen, measure, sizeFromCompiled, MAX_TX_BYTES } from '../src/txsize.js';

const FIX = JSON.parse(readFileSync(new URL('./fixtures/mainnet.json', import.meta.url)));

test('the size formula gives the exact byte length of a real v0 transaction with lookup tables', () => {
  const t = FIX.transactions.jupiterSale;
  assert.equal(t.version, 0);
  assert.ok(t.lookups.length > 0, 'the fixture must exercise the lookup-table section');
  assert.equal(sizeFromCompiled(t), t.bytes);
});

test('the size formula gives the exact byte length of a real legacy transaction (our own swap page)', () => {
  const t = FIX.transactions.ownPoolSwap;
  assert.equal(t.version, 'legacy');
  assert.equal(sizeFromCompiled({ ...t, legacy: true }), t.bytes);
});

test('compact lengths change width at 128 and 16384', () => {
  assert.deepEqual([0, 127, 128, 16383, 16384].map(compactLen), [1, 1, 2, 2, 3]);
});

const A = (n) => `acct-${n}`; // keys are only compared, never decoded, in classify

test('a signer and an invoked program stay written out even when a lookup table holds them', () => {
  const c = classify({
    payer: A(0),
    instructions: [{ programId: A(9), accounts: [{ pubkey: A(1), isSigner: false, isWritable: true }, { pubkey: A(2), isSigner: true, isWritable: false }], dataLength: 1 }],
    lookupTables: { T: [A(0), A(1), A(2), A(9)] },
  });
  // payer + the second signer + the program stay; only A(1) moves into the table.
  assert.equal(c.staticKeys, 3);
  assert.equal(c.signatures, 2);
  assert.deepEqual(c.lookups, [{ table: 'T', writable: 1, readonly: 0 }]);
});

test('an account named twice is counted once, with the strongest flags', () => {
  const c = classify({
    payer: A(0),
    instructions: [
      { programId: A(9), accounts: [{ pubkey: A(1), isSigner: false, isWritable: false }], dataLength: 0 },
      { programId: A(9), accounts: [{ pubkey: A(1), isSigner: false, isWritable: true }], dataLength: 0 },
    ],
    lookupTables: { T: [A(1)] },
  });
  assert.deepEqual(c.lookups, [{ table: 'T', writable: 1, readonly: 0 }]);
  assert.equal(c.staticKeys, 2);
});

test('a lookup table nobody uses adds nothing', () => {
  const c = classify({ payer: A(0), instructions: [{ programId: A(9), accounts: [], dataLength: 0 }], lookupTables: { T: [A(5)] } });
  assert.deepEqual(c.lookups, []);
});

test('measure says when a transaction is too big', () => {
  const many = Array.from({ length: 40 }, (_, i) => ({ pubkey: A(100 + i), isSigner: false, isWritable: true }));
  const m = measure({ payer: A(0), instructions: [{ programId: A(9), accounts: many, dataLength: 24 }], lookupTables: {} });
  assert.ok(m.bytes > MAX_TX_BYTES);
  assert.equal(m.fits, false);
  const small = measure({ payer: A(0), instructions: [{ programId: A(9), accounts: many, dataLength: 24 }], lookupTables: { T: many.map((a) => a.pubkey) } });
  assert.equal(small.fits, true);
  assert.equal(small.accounts, 42);
});
