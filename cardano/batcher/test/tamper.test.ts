// The verifier must REJECT a batch that breaks a rule, naming the rule: real batches with one
// thing changed. This is its job when it reads back our own builds before they are signed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import CSL from '@emurgo/cardano-serialization-lib-nodejs';
import { MAINNET_TIME } from '../src/chain.ts';
import { BatchMismatch, verifySinglePoolBatch, type DexConstants } from '../src/verify.ts';
import { plusFirstToken, plusLovelace, plusStrayToken, poolDatumPlus, withOutput, withReversedIndexes } from './tamper.ts';

const MINSWAP_MAINNET: DexConstants = {
  authenPolicy: 'f5808c2c990d86da54bfc97d89cee6efa20cd8461616359478d96b4c',
  poolScriptHash: 'ea07b733d932129c378af627436e7cbc2ef0bf96e0036bb51b3bde6b',
  time: MAINNET_TIME,
};
const fx = JSON.parse(readFileSync(new URL('./fixtures/minswap-batches.json', import.meta.url), 'utf8')) as {
  batches: { tx: string; cbor: string }[];
  spent: Record<string, string>;
};
const batch = (prefix: string) => fx.batches.find((b) => b.tx.startsWith(prefix))!.cbor;
const BUY = batch('075110cd'); // one order: output 0 is the trader's, then the pool
const SEVEN = batch('fe7b2977'); // seven orders in the batcher's own order

function rejects(txHex: string, reason: RegExp) {
  assert.throws(
    () => verifySinglePoolBatch(txHex, fx.spent, MINSWAP_MAINNET),
    (e: unknown) => e instanceof BatchMismatch && e.problems.some((p) => reason.test(p)),
  );
}

const poolOutputIndex = (txHex: string) => {
  const outs = CSL.Transaction.from_hex(txHex).body().outputs();
  for (let i = 0; i < outs.len(); i++) if (outs.get(i).address().to_bech32(undefined).startsWith('addr1z84q0den')) return i;
  throw new Error('no pool output');
};

test('the untampered batches pass (the baseline for every case below)', () => {
  verifySinglePoolBatch(BUY, fx.spent, MINSWAP_MAINNET);
  verifySinglePoolBatch(SEVEN, fx.spent, MINSWAP_MAINNET);
});

test('an order paid one unit of its coin short', () => {
  rejects(withOutput(BUY, 0, (o) => ({ value: plusFirstToken(o.amount(), -1n) })), /order 0 .*value .*the contract demands/);
});

test('an order paid one lovelace short', () => {
  rejects(withOutput(BUY, 0, (o) => ({ value: plusLovelace(o.amount(), -1n) })), /order 0 .*value/);
});

test('an order paid to another address', () => {
  // The buy's own receiver is the venue's key A; key B is someone else to this order.
  const someoneElse = CSL.Address.from_bech32('addr1q96a7uf7pm942gq2usgv0fg2haevlmh3hfvpqja0va2sg7an5ldnfadxkransm76fn4mwx3z3kcyy3rtensd6fsp07xscv7juh');
  rejects(withOutput(BUY, 0, () => ({ address: someoneElse })), /order 0 .*wrong address/);
});

test('a pool reserve written one unit off', () => {
  const i = poolOutputIndex(BUY);
  rejects(withOutput(BUY, i, (o) => ({ datum: poolDatumPlus(o.plutus_data()!, 4, 1n) })), /pool state/);
});

test('a lovelace left over in the pool', () => {
  const i = poolOutputIndex(BUY);
  rejects(withOutput(BUY, i, (o) => ({ value: plusLovelace(o.amount(), 1n) })), /pool (state|output)/);
});

test('a stray token left in the pool (only the "pool holds exactly its reserves" rule sees it)', () => {
  const i = poolOutputIndex(BUY);
  rejects(withOutput(BUY, i, (o) => ({ value: plusStrayToken(o.amount()) })), /pool output holds more than its reserves/);
});

test("orders processed in another order than the batcher's", () => {
  assert.throws(() => verifySinglePoolBatch(withReversedIndexes(SEVEN), fx.spent, MINSWAP_MAINNET), BatchMismatch);
});
