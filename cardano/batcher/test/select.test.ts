// Choosing what to batch: pools named by their datum's pair, orders read as strictly as the
// contract reads them and left alone with a reason otherwise, oldest first across pools, each
// order taken only if the contract would take it after the ones before it. Then every real
// Minswap V2 pool and order in the fixtures, read by the same rules.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import CSL from '@emurgo/cardano-serialization-lib-nodejs';
import { MAINNET_TIME } from '../src/chain.ts';
import type { Utxo } from '../src/plan.ts';
import { batcherIndex, chooseBatch, readGlobalSetting, readOrders, readPools, type Deployment, type Policy } from '../src/select.ts';
import type { ChainUtxo } from '../src/view.ts';
import { BATCHER_KEY, DEX, LP_NAME, NETWORK, S, TOK, order, orderDatum, scriptRefOf, step, utxo, value, world } from './world.ts';

const ADA = 1_000_000n;
const TIP = 160_000_000n;
const DEP: Deployment = { network: NETWORK, dex: DEX, orderScriptHash: S.order.hash, poolBatchingScriptHash: S.poolBatching.hash, scriptRefs: { pool: `${'a2'.repeat(32)}#0`, order: `${'a2'.repeat(32)}#1`, poolBatching: `${'a2'.repeat(32)}#2` } };
const POLICY: Policy = { batcherFee: 2n * ADA, maxOrdersPerBatch: 25, slotsBefore: 60n, slotsAfter: 240n };
const aged = (u: Utxo, slot: bigint, txIndex: number | null = 0): ChainUtxo => ({ ...u, createdSlot: slot, createdTxIndex: txIndex });
const swap = (ref: string, trader = 1, min = 1n, killable = true) => order(ref, trader, 30n * ADA, [], step.swapIn(true, 25n * ADA, min, killable));
const withOutput = (u: Utxo, f: (o: CSL.TransactionOutput) => void): Utxo => {
  const o = CSL.TransactionOutput.from_hex(u.outputHex);
  f(o);
  return { ref: u.ref, outputHex: o.to_hex() };
};

test('the pool is found by its NFT and named by its pair; anything else at the pool script is left alone', () => {
  const w = world();
  const poolOut = CSL.TransactionOutput.from_hex(w.pool.outputHex);
  const noNft = utxo(`${'e1'.repeat(32)}#0`, poolOut.address(), value(10n * ADA), poolOut.plutus_data()!);
  const { pools, skipped } = readPools(DEP, [aged(w.pool, 1n), aged(noNft, 1n)]);
  assert.deepEqual([...pools.keys()], [LP_NAME]);
  assert.deepEqual(skipped.map((s) => s.reason), ['no pool NFT']);
  // The same pool twice (a second NFT could only come from a second pool of the pair): both left alone.
  const twice = readPools(DEP, [aged(w.pool, 1n), aged({ ...w.pool, ref: `${'e2'.repeat(32)}#0` }, 2n)]);
  assert.equal(twice.pools.size, 0);
  assert.match(twice.skipped.at(-1)!.reason, /two pools share/);
  // A pool batched by another script than ours.
  const other = readPools({ ...DEP, poolBatchingScriptHash: '00'.repeat(28) }, [aged(w.pool, 1n)]);
  assert.deepEqual(other.skipped.map((s) => s.reason), ['batched by another script']);
});

test('orders are read oldest first, and every one the batcher cannot fill is left alone with its reason', () => {
  const w = world();
  void w;
  const ok1 = swap(`${'c1'.repeat(32)}#0`);
  const ok2 = swap(`${'c2'.repeat(32)}#0`, 2);
  const ok3 = swap(`${'c0'.repeat(32)}#5`, 3);
  const byHash = order(`${'c3'.repeat(32)}#0`, 4, 30n * ADA, [], step.swapIn(true, 25n * ADA, 1n), { byHash: true });
  const unknownHash = order(`${'c4'.repeat(32)}#0`, 5, 30n * ADA, [], step.swapIn(true, 25n * ADA, 1n), { byHash: true });
  const zap = order(`${'c5'.repeat(32)}#0`, 6, 30n * ADA, [], step.zapOut());
  const cheap = (() => {
    const o = CSL.TransactionOutput.from_hex(ok1.utxo.outputHex);
    o.set_plutus_data(orderDatum(7, step.swapIn(true, 25n * ADA, 1n), ADA));
    return { ref: `${'c6'.repeat(32)}#0`, outputHex: o.to_hex() };
  })();
  const withScript = withOutput({ ...ok1.utxo, ref: `${'c7'.repeat(32)}#0` }, (o) => o.set_script_ref(scriptRefOf('pool')));
  const elsewhere = { ref: `${'c8'.repeat(32)}#0`, outputHex: utxo('x#0', CSL.Address.from_hex(CSL.TransactionOutput.from_hex(w.pool.outputHex).address().to_hex()), value(30n * ADA)).outputHex };
  const junk = withOutput({ ...ok1.utxo, ref: `${'c9'.repeat(32)}#0` }, (o) => o.set_plutus_data(CSL.PlutusData.new_integer(CSL.BigInt.from_str('7'))));
  const utxos = [
    aged(ok2.utxo, 10n, 1),
    aged(ok1.utxo, 10n, 0),
    aged(ok3.utxo, 9n, 7),
    aged(byHash.utxo, 11n),
    aged(unknownHash.utxo, 11n, 1),
    aged(zap.utxo, 12n),
    aged(cheap, 12n, 1),
    aged(withScript, 12n, 2),
    aged(elsewhere, 12n, 3),
    aged(junk, 12n, 4),
  ];
  const datums = new Map([[CSL.hash_plutus_data(byHash.datum).to_hex(), byHash.datum]]);
  const { orders, skipped } = readOrders(DEP, POLICY, utxos, datums);
  assert.deepEqual(orders.map((o) => o.utxo.ref), [ok3.utxo.ref, ok1.utxo.ref, ok2.utxo.ref, byHash.utxo.ref]);
  assert.equal(orders[3]!.witness?.hash, CSL.TransactionOutput.from_hex(byHash.utxo.outputHex).data_hash()!.to_hex());
  assert.deepEqual(
    skipped.map((s) => [s.ref.slice(0, 2), s.reason.replace(/ \(.*\)$/, '')]),
    [
      ['c4', 'its datum is not known'],
      ['c5', 'order type ZapOut is not built by this batcher'],
      ['c6', `allows a batcher fee of ${ADA}, below ${2n * ADA}`],
      ['c7', 'carries a reference script'],
      ['c8', 'not at the order script'],
      ['c9', 'unreadable datum'],
    ],
  );
});

test('the next batch: oldest order’s pool, in order, each order only if the contract takes it after the ones before', () => {
  const w = world();
  const { pools } = readPools(DEP, [aged(w.pool, 1n)]);
  const a = swap(`${'d1'.repeat(32)}#0`, 1);
  const never = swap(`${'d2'.repeat(32)}#0`, 2, 10n ** 15n, false); // must fill, cannot: the contract refuses it
  const b = swap(`${'d3'.repeat(32)}#0`, 3);
  const inFlight = swap(`${'d4'.repeat(32)}#0`, 4);
  const { orders } = readOrders(DEP, POLICY, [aged(a.utxo, 1n), aged(never.utxo, 2n), aged(inFlight.utxo, 3n), aged(b.utxo, 4n)], new Map());
  const { candidate, skipped } = chooseBatch(DEP, POLICY, pools, orders, new Set([inFlight.utxo.ref]), TIP);
  assert.deepEqual(candidate!.orders.map((o) => o.utxo.ref), [a.utxo.ref, b.utxo.ref]);
  assert.deepEqual(candidate!.fees, [2n * ADA, 2n * ADA]);
  assert.equal(candidate!.validFromSlot, TIP - 60n);
  assert.equal(candidate!.validToSlot, TIP + 240n);
  assert.deepEqual(skipped.map((s) => s.ref), [never.utxo.ref]);
  assert.match(skipped[0]!.reason, /the contract would refuse it now/);
  // No more than the policy allows.
  assert.equal(chooseBatch(DEP, { ...POLICY, maxOrdersPerBatch: 1 }, pools, orders, new Set(), TIP).candidate!.orders.length, 1);
  // The pool itself in a batch still in flight: nothing for it until that batch is settled.
  assert.equal(chooseBatch(DEP, POLICY, pools, orders, new Set([w.pool.ref]), TIP).candidate, null);
  // An order whose pool is not there.
  const lonely = chooseBatch(DEP, POLICY, new Map(), orders, new Set(), TIP);
  assert.equal(lonely.candidate, null);
  assert.equal(lonely.skipped.length, 4);
});

test('the batcher’s place in the global setting, and a key that is not a batcher is refused', () => {
  const w = world();
  const g = readGlobalSetting(DEP, [aged(w.globalSetting, 1n)]);
  assert.equal(batcherIndex(g.setting, BATCHER_KEY), 0);
  assert.throws(() => batcherIndex(g.setting, '00'.repeat(28)), /not among the global setting's batchers/);
  assert.throws(() => readGlobalSetting(DEP, []), /0 global settings/);
  assert.throws(() => readGlobalSetting(DEP, [aged(w.globalSetting, 1n), aged({ ...w.globalSetting, ref: `${'a1'.repeat(32)}#1` }, 1n)]), /2 global settings/);
});

test('every real Minswap V2 pool and order in the fixtures is read by the same rules (only ZapOut left alone)', () => {
  const fx = JSON.parse(readFileSync(new URL('./fixtures/minswap-batches.json', import.meta.url), 'utf8')) as { spent: Record<string, string> };
  const minswap: Deployment = {
    network: 1,
    dex: { authenPolicy: 'f5808c2c990d86da54bfc97d89cee6efa20cd8461616359478d96b4c', poolScriptHash: 'ea07b733d932129c378af627436e7cbc2ef0bf96e0036bb51b3bde6b', time: MAINNET_TIME },
    orderScriptHash: 'c3e28c36c3447315ba5a56f33da6a6ddc1770a876a8d9f0cb3a97c4c',
    poolBatchingScriptHash: '1eae96baf29e27682ea3f815aba361a0c6059d45e4bfbe95bbd2f44a',
    scriptRefs: { pool: '', order: '', poolBatching: '' },
  };
  const utxos = Object.entries(fx.spent).map(([ref, outputHex]) => aged({ ref, outputHex }, 1n));
  const at = (h: string) => utxos.filter((u) => CSL.TransactionOutput.from_hex(u.outputHex).address().payment_cred()?.to_scripthash()?.to_hex() === h);
  // The fixtures hold some pools at several moments (each batch spends the last one's output): read each alone.
  const names = new Set<string>();
  for (const u of at(minswap.dex.poolScriptHash)) {
    const one = readPools(minswap, [u]);
    assert.equal(one.skipped.length, 0, `${u.ref}: ${JSON.stringify(one.skipped)}`);
    for (const name of one.pools.keys()) names.add(name);
  }
  assert.ok(names.size >= 8, `${names.size} pools`);
  // Minswap's orders allow its own fee (0.7 ADA here); hash-only datums are in the fixtures' batches.
  const orders = readOrders(minswap, { ...POLICY, batcherFee: 700_000n }, at(minswap.orderScriptHash), new Map());
  const reasons = orders.skipped.map((s) => s.reason);
  assert.ok(reasons.every((r) => /ZapOut|hash only/.test(r)), JSON.stringify(reasons));
  assert.ok(orders.orders.length >= 20, `${orders.orders.length}`);
  assert.ok(orders.orders.every((o) => names.has(o.datum.lpAsset.assetName)), 'an order names a pool not in the fixtures');
  void TOK;
});
