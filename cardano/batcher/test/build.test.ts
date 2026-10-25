// Batches built for OUR contracts (the 1333 patch, test parameters) and run, every script, by
// Aiken 1.0.24 (`aiken tx simulate`): what the chain would run, offline. Needs AIKEN=<path>.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import CSL from '@emurgo/cardano-serialization-lib-nodejs';
import { Unsupported } from '../src/engine.ts';
import { BatchTooBig, prepareBatch } from '../src/prepare.ts';
import { simulate } from '../src/simulate.ts';
import { BatchMismatch, verifySinglePoolBatch } from '../src/verify.ts';
import type { PlutusData } from '../src/plutus.ts';
import type { Utxo } from '../src/plan.ts';
import { DEX, LP_NAME, NETWORK, PP, TOK, order, step, traderAddress, world } from './world.ts';
import { plusFirstToken, withOutput } from './tamper.ts';

const AIKEN = process.env.AIKEN ?? '';
const skip = existsSync(AIKEN) ? false : 'needs Aiken 1.0.24: set AIKEN=<path to aiken>';
const evaluate = (tx: string, spent: Readonly<Record<string, string>>) => simulate(AIKEN, tx, spent);
const SLOT = 160_000_000n;
const ADA = 1_000_000n;

function run(orders: { utxo: Utxo; datum: PlutusData }[], opts: { fees?: bigint[]; byHash?: boolean } = {}) {
  const w = world();
  const spent = { ...w.spent };
  for (const o of orders) spent[o.utxo.ref] = o.utxo.outputHex;
  const datumsByHash = new Map(orders.map((o) => [CSL.hash_plutus_data(o.datum).to_hex(), o.datum]));
  return prepareBatch(
    {
      network: NETWORK,
      dex: DEX,
      pool: w.pool,
      orders: orders.map((o) => o.utxo),
      fees: opts.fees ?? orders.map(() => 2n * ADA),
      globalSetting: w.globalSetting,
      scripts: w.scripts,
      batcher: w.batcher,
      batcherIndex: 0,
      volFee: null,
      validFromSlot: SLOT,
      validToSlot: SLOT + 180n,
      datumsByHash,
      spent,
    },
    PP,
    evaluate,
  );
}

const tokenOf = (o: CSL.TransactionOutput, name = TOK.assetName, policy = TOK.policyId) =>
  BigInt(o.amount().multiasset()?.get(CSL.ScriptHash.from_hex(policy))?.get(CSL.AssetName.new(Buffer.from(name, 'hex')))?.to_str() ?? '0');

test('one swap, ADA in: built, every script passes, read back, the trader paid exactly', { skip }, () => {
  const o = order(`${'c1'.repeat(32)}#0`, 1, 30n * ADA, [], step.swapIn(true, 25n * ADA, 1n));
  const b = run([o]);
  assert.deepEqual(b.report.orders, [{ step: 'SwapExactIn', fee: 2n * ADA, filled: true }]);
  const tx = CSL.Transaction.from_hex(b.txHex);
  const out0 = tx.body().outputs().get(0);
  assert.equal(out0.address().to_bech32(undefined), traderAddress(1).to_bech32(undefined));
  assert.ok(tokenOf(out0) > 0n);
  assert.equal(BigInt(out0.amount().coin().to_str()), 3n * ADA); // 30 - 25 swapped - 2 fee
  // The batcher's key is the only required signer; the network fee is paid from the order fees.
  assert.equal(tx.body().required_signers()!.get(0).to_hex(), 'ba'.repeat(28));
  assert.ok(b.fee > 100_000n && b.fee < 2n * ADA, `fee ${b.fee}`);
  assert.ok(b.totalCollateral * 100n >= b.fee * BigInt(PP.collateralPercentage));
  assert.ok([...b.budgets.keys()].includes('reward:0'));
});

test('five orders of four types, processed in the batcher’s order, not the ledger’s', { skip }, () => {
  const lp = (n: bigint): [string, string, bigint] => [DEX.authenPolicy, LP_NAME, n];
  const tok = (n: bigint): [string, string, bigint] => [TOK.policyId, TOK.assetName, n];
  const orders = [
    order(`${'c5'.repeat(32)}#0`, 2, 3n * ADA, [tok(1_000_000_000n)], step.swapIn(false, 1_000_000_000n, 1n)),
    order(`${'c2'.repeat(32)}#0`, 3, 33n * ADA, [], step.swapOut(true, 30n * ADA, 1_000_000_000n)),
    // 50 ADA deposited + 2 ADA fee + the 2 ADA deposit that carries the LP tokens back.
    order(`${'c4'.repeat(32)}#0`, 4, 54n * ADA, [tok(2_500_000_000n)], step.deposit(50n * ADA, 2_500_000_000n, 1n)),
    order(`${'c3'.repeat(32)}#1`, 5, 4n * ADA, [lp(1_000_000n)], step.withdraw(1_000_000n, 1n, 1n)),
    order(`${'c1'.repeat(32)}#3`, 6, 14n * ADA, [], step.swapIn(true, 10n * ADA, 1n)),
  ];
  const b = run(orders);
  assert.deepEqual(b.report.orders.map((o) => o.step), ['SwapExactIn', 'SwapExactOut', 'Deposit', 'Withdraw', 'SwapExactIn']);
  assert.ok(b.report.orders.every((o) => o.filled));
  assert.deepEqual(b.report.redeemer.inputIndexes, [4, 1, 3, 2, 0]); // c5, c2, c4, c3, c1 among the sorted orders
  const out1 = CSL.Transaction.from_hex(b.txHex).body().outputs().get(1);
  assert.equal(tokenOf(out1), 1_000_000_000n); // the exact-out order got exactly what it asked
  // The fee share stayed in the pool: its ADA grew by more than its datum reserve did.
  const s = b.report;
  assert.ok(s.stateOut.valueReserveA - s.stateOut.datumReserveA > s.stateIn.valueReserveA - s.stateIn.datumReserveA);
});

test('a killable order the price no longer meets is refunded in the same batch, less only the fee', { skip }, () => {
  const fill = order(`${'c1'.repeat(32)}#0`, 1, 30n * ADA, [], step.swapIn(true, 25n * ADA, 1n));
  const miss = order(`${'c2'.repeat(32)}#0`, 2, 30n * ADA, [], step.swapIn(true, 25n * ADA, 10n ** 15n));
  const b = run([fill, miss], { fees: [2n * ADA, ADA] });
  assert.deepEqual(b.report.orders.map((o) => o.filled), [true, false]);
  const refund = CSL.Transaction.from_hex(b.txHex).body().outputs().get(1);
  assert.equal(BigInt(refund.amount().coin().to_str()), 29n * ADA);
  assert.equal(refund.amount().multiasset(), undefined);
});

test('an order holding only its datum hash: the datum is carried in the batch', { skip }, () => {
  const o = order(`${'c1'.repeat(32)}#0`, 1, 30n * ADA, [], step.swapIn(true, 25n * ADA, 1n), { byHash: true });
  const b = run([o]);
  assert.equal(b.report.orders[0]!.filled, true);
  assert.equal(CSL.Transaction.from_hex(b.txHex).witness_set().plutus_data()?.len(), 1);
});

test('an order that leaves too little ADA to carry its coins back is refused, never built', { skip }, () => {
  const o = order(`${'c4'.repeat(32)}#0`, 4, 53n * ADA, [[TOK.policyId, TOK.assetName, 2_500_000_000n]], step.deposit(50n * ADA, 2_500_000_000n, 1n));
  assert.throws(() => run([o]), /its output cannot exist/);
});

test('a batch whose scripts need more than one transaction may use is refused, to be split', { skip }, () => {
  const o = order(`${'c1'.repeat(32)}#0`, 1, 30n * ADA, [], step.swapIn(true, 25n * ADA, 1n));
  const w = world();
  const tight = { ...PP, maxTxExecutionUnits: { memory: 1_000_000, steps: 1_000_000_000 } };
  assert.throws(
    () =>
      prepareBatch(
        { network: NETWORK, dex: DEX, pool: w.pool, orders: [o.utxo], fees: [2n * ADA], globalSetting: w.globalSetting, scripts: w.scripts, batcher: w.batcher, batcherIndex: 0, volFee: null, validFromSlot: SLOT, validToSlot: SLOT + 180n, spent: { ...w.spent, [o.utxo.ref]: o.utxo.outputHex } },
        tight,
        evaluate,
      ),
    BatchTooBig,
  );
});

test('an order type the batcher does not build is refused before anything is built', { skip }, () => {
  const o = order(`${'c1'.repeat(32)}#0`, 1, 30n * ADA, [], step.zapOut());
  assert.throws(() => run([o]), (e: unknown) => e instanceof Unsupported && e.kind === 'ZapOut');
});

test('our contracts reject the built batch with one order paid a unit short', { skip }, () => {
  const o = order(`${'c1'.repeat(32)}#0`, 1, 30n * ADA, [], step.swapIn(true, 25n * ADA, 1n));
  const w = world();
  const b = run([o]);
  const spent = { ...w.spent, [o.utxo.ref]: o.utxo.outputHex };
  const bad = withOutput(b.txHex, 0, (out) => ({ value: plusFirstToken(out.amount(), -1n) }));
  const sim = evaluate(bad, spent);
  assert.equal(sim.ok, false);
  assert.match(sim.ok ? '' : sim.error, /Reward, 0/);
  assert.throws(() => verifySinglePoolBatch(bad, spent, DEX), BatchMismatch);
});
