// Batches built for OUR contracts (the 1333 patch, test parameters) and run, every script, by
// Aiken 1.0.24 (`aiken tx simulate`): what the chain would run, offline. Needs AIKEN=<path>.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import CSL from '@emurgo/cardano-serialization-lib-nodejs';
import { Unsupported } from '../src/engine.ts';
import { BatchTooBig, SetupError, paysOnlyWhomItShould, prepareBatch } from '../src/prepare.ts';
import { simulate } from '../src/simulate.ts';
import { BatchMismatch, verifySinglePoolBatch } from '../src/verify.ts';
import type { PlutusData } from '../src/plutus.ts';
import type { Utxo } from '../src/plan.ts';
import { referenceScriptOf, type ProtocolParams } from '../src/build.ts';
import { ledgerMinFee, refScriptFee } from '../src/fee.ts';
import { BATCHER_ADDRESS, BATCHER_KEY, BATCHER_SKEY, DEX, LP_NAME, NETWORK, PP, S, TOK, order, scriptRefOf, step, traderAddress, utxo, value, world } from './world.ts';

type World = ReturnType<typeof world>;
import { plusFirstToken, withOutput } from './tamper.ts';

const AIKEN = process.env.AIKEN ?? '';
const skip = existsSync(AIKEN) ? false : 'needs Aiken 1.0.24: set AIKEN=<path to aiken>';
const evaluate = (tx: string, spent: Readonly<Record<string, string>>) => simulate(AIKEN, tx, spent);
const SLOT = 160_000_000n;
const ADA = 1_000_000n;

async function run(orders: { utxo: Utxo; datum: PlutusData }[], opts: { fees?: bigint[]; world?: (w: World) => void; pp?: ProtocolParams; rewardBalance?: bigint } = {}) {
  const w = world();
  opts.world?.(w);
  const spent: Record<string, string> = { ...w.spent };
  for (const u of [w.pool, w.globalSetting, w.batcher.collateral, ...w.batcher.feeUtxos, ...orders.map((o) => o.utxo)]) spent[u.ref] = u.outputHex;
  const datumsByHash = new Map(orders.map((o) => [CSL.hash_plutus_data(o.datum).to_hex(), o.datum]));
  const b = await prepareBatch(
    {
      network: NETWORK,
      dex: DEX,
      pool: w.pool,
      orders: orders.map((o) => o.utxo),
      fees: opts.fees ?? orders.map(() => 2n * ADA),
      globalSetting: w.globalSetting,
      scripts: w.scripts,
      batchingRewardBalance: opts.rewardBalance ?? 0n,
      batcher: w.batcher,
      batcherIndex: 0,
      volFee: null,
      validFromSlot: SLOT,
      validToSlot: SLOT + 180n,
      datumsByHash,
      spent,
    },
    opts.pp ?? PP,
    evaluate,
  );
  return { ...b, spent };
}

const tokenOf = (o: CSL.TransactionOutput, name = TOK.assetName, policy = TOK.policyId) =>
  BigInt(o.amount().multiasset()?.get(CSL.ScriptHash.from_hex(policy))?.get(CSL.AssetName.new(Buffer.from(name, 'hex')))?.to_str() ?? '0');

test('one swap, ADA in: built, every script passes, read back, the trader paid exactly', { skip }, async () => {
  const o = order(`${'c1'.repeat(32)}#0`, 1, 30n * ADA, [], step.swapIn(true, 25n * ADA, 1n));
  const b = await run([o]);
  assert.deepEqual(b.report.orders, [{ step: 'SwapExactIn', fee: 2n * ADA, filled: true }]);
  const tx = CSL.Transaction.from_hex(b.txHex);
  const out0 = tx.body().outputs().get(0);
  assert.equal(out0.address().to_bech32(undefined), traderAddress(1).to_bech32(undefined));
  assert.ok(tokenOf(out0) > 0n);
  assert.equal(BigInt(out0.amount().coin().to_str()), 3n * ADA); // 30 - 25 swapped - 2 fee
  // The batcher's key is the only required signer; the network fee is paid from the order fees.
  assert.equal(tx.body().required_signers()!.get(0).to_hex(), BATCHER_KEY);
  assert.ok(b.fee > 100_000n && b.fee < 2n * ADA, `fee ${b.fee}`);
  assert.ok(b.totalCollateral * 100n >= b.fee * BigInt(PP.collateralPercentage));
  assert.ok([...b.budgets.keys()].includes('reward:0'));
});

test('five orders of four types, processed in the batcher’s order, not the ledger’s', { skip }, async () => {
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
  const b = await run(orders);
  assert.deepEqual(b.report.orders.map((o) => o.step), ['SwapExactIn', 'SwapExactOut', 'Deposit', 'Withdraw', 'SwapExactIn']);
  assert.ok(b.report.orders.every((o) => o.filled));
  assert.deepEqual(b.report.redeemer.inputIndexes, [4, 1, 3, 2, 0]); // c5, c2, c4, c3, c1 among the sorted orders
  const out1 = CSL.Transaction.from_hex(b.txHex).body().outputs().get(1);
  assert.equal(tokenOf(out1), 1_000_000_000n); // the exact-out order got exactly what it asked
  // The fee share stayed in the pool: its ADA grew by more than its datum reserve did.
  const s = b.report;
  assert.ok(s.stateOut.valueReserveA - s.stateOut.datumReserveA > s.stateIn.valueReserveA - s.stateIn.datumReserveA);
});

test('a killable order the price no longer meets is refunded in the same batch, less only the fee', { skip }, async () => {
  const fill = order(`${'c1'.repeat(32)}#0`, 1, 30n * ADA, [], step.swapIn(true, 25n * ADA, 1n));
  const miss = order(`${'c2'.repeat(32)}#0`, 2, 30n * ADA, [], step.swapIn(true, 25n * ADA, 10n ** 15n));
  const b = await run([fill, miss], { fees: [2n * ADA, ADA] });
  assert.deepEqual(b.report.orders.map((o) => o.filled), [true, false]);
  const refund = CSL.Transaction.from_hex(b.txHex).body().outputs().get(1);
  assert.equal(BigInt(refund.amount().coin().to_str()), 29n * ADA);
  assert.equal(refund.amount().multiasset(), undefined);
});

test('an order holding only its datum hash: the datum is carried in the batch', { skip }, async () => {
  const o = order(`${'c1'.repeat(32)}#0`, 1, 30n * ADA, [], step.swapIn(true, 25n * ADA, 1n), { byHash: true });
  const b = await run([o]);
  assert.equal(b.report.orders[0]!.filled, true);
  assert.equal(CSL.Transaction.from_hex(b.txHex).witness_set().plutus_data()?.len(), 1);
});

test('an order that leaves too little ADA to carry its coins back is refused, never built', { skip }, async () => {
  const o = order(`${'c4'.repeat(32)}#0`, 4, 53n * ADA, [[TOK.policyId, TOK.assetName, 2_500_000_000n]], step.deposit(50n * ADA, 2_500_000_000n, 1n));
  await assert.rejects(() => run([o]), /its output cannot exist/);
});

test('a batch whose scripts need more than one transaction may use is refused, to be split', { skip }, async () => {
  const o = order(`${'c1'.repeat(32)}#0`, 1, 30n * ADA, [], step.swapIn(true, 25n * ADA, 1n));
  const tight = { ...PP, maxTxExecutionUnits: { memory: 1_000_000, steps: 1_000_000_000 } };
  await assert.rejects(() => run([o], { pp: tight }), BatchTooBig);
});

test('an order type the batcher does not build is refused before anything is built', { skip }, async () => {
  const o = order(`${'c1'.repeat(32)}#0`, 1, 30n * ADA, [], step.zapOut());
  await assert.rejects(() => run([o]), (e: unknown) => e instanceof Unsupported && e.kind === 'ZapOut');
});

test('our contracts reject the built batch with one order paid a unit short', { skip }, async () => {
  const o = order(`${'c1'.repeat(32)}#0`, 1, 30n * ADA, [], step.swapIn(true, 25n * ADA, 1n));
  const w = world();
  const b = await run([o]);
  const spent = { ...w.spent, [o.utxo.ref]: o.utxo.outputHex };
  const bad = withOutput(b.txHex, 0, (out) => ({ value: plusFirstToken(out.amount(), -1n) }));
  const sim = evaluate(bad, spent);
  assert.equal(sim.ok, false);
  assert.match(sim.ok ? '' : sim.error, /Reward, 0/);
  assert.throws(() => verifySinglePoolBatch(bad, spent, DEX), BatchMismatch);
});

// ---- The independent review's findings (2026-10-25), each proven fixed ----

const withScriptRef = (u: Utxo, sr: CSL.ScriptRef): Utxo => {
  const o = CSL.TransactionOutput.from_hex(u.outputHex);
  o.set_script_ref(sr);
  return { ref: u.ref, outputHex: o.to_hex() };
};
const swap = () => order(`${'c1'.repeat(32)}#0`, 1, 30n * ADA, [], step.swapIn(true, 25n * ADA, 1n));
const changeOf = (txHex: string) => {
  const outs = CSL.Transaction.from_hex(txHex).body().outputs();
  return BigInt(outs.get(outs.len() - 1).amount().coin().to_str());
};

test('a pool carrying a reference script: the batch pays the ledger for its bytes, and the pool comes out without it', { skip }, async () => {
  // Anyone can make a pool whose first output carries one (the factory never looks). Aiken 1.0.24
  // cannot run a batch whose inputs carry a script nothing in it uses (the ledger can), so the
  // script here is the pool's own.
  const plain = await run([swap()]);
  const b = await run([swap()], { world: (w) => void (w.pool = withScriptRef(w.pool, scriptRefOf('pool'))) });
  assert.ok(b.fee >= ledgerMinFee(b.txHex, b.spent, PP), `fee ${b.fee} below the ledger's ${ledgerMinFee(b.txHex, b.spent, PP)}`);
  // 22,263 bytes of reference scripts become 22,263 + the pool script's 3,965: past the first tier.
  const perByte = { n: 15n, d: 1n };
  const extra = refScriptFee(22_263 + S.pool.compiledCode.length / 2, perByte) - refScriptFee(22_263, perByte);
  assert.ok(b.fee >= ledgerMinFee(plain.txHex, plain.spent, PP) + extra, `fee ${b.fee}`);
  assert.equal(CSL.Transaction.from_hex(b.txHex).body().outputs().get(1).script_ref(), undefined);
});

test('the fee covers the transaction as signed by the batcher’s real key', { skip }, async () => {
  const b = await run([swap()]);
  const signed = CSL.FixedTransaction.from_hex(b.txHex);
  signed.sign_and_add_vkey_signature(BATCHER_SKEY);
  assert.equal(ledgerMinFee(signed.to_hex(), b.spent, PP), ledgerMinFee(b.txHex, b.spent, PP));
  assert.ok(b.fee >= ledgerMinFee(signed.to_hex(), b.spent, PP));
});

test('an order carrying a reference script is left alone: the batch would pay for its bytes', { skip }, async () => {
  const o = swap();
  const carrying = { utxo: withScriptRef(o.utxo, scriptRefOf('pool')), datum: o.datum };
  await assert.rejects(() => run([carrying]), (e: unknown) => e instanceof Unsupported && e.kind === 'ReferenceScript');
});

test('a UTxO someone sent the batcher is never spent: one with a reference script, a collateral with a token', { skip }, async () => {
  const refused = /not plain ADA at the batcher's own key/;
  await assert.rejects(() => run([swap()], { world: (w) => void (w.batcher.feeUtxos = [withScriptRef(w.batcher.feeUtxos[0]!, scriptRefOf('order'))]) }), refused);
  const tokenCollateral = utxo(`${'b1'.repeat(32)}#1`, BATCHER_ADDRESS, value(10n * ADA, [[TOK.policyId, TOK.assetName, 1n]]));
  await assert.rejects(() => run([swap()], { world: (w) => void (w.batcher.collateral = tokenCollateral) }), refused);
});

test('collateral of any size the fee allows: 1.1, 3 and 5.5 ADA all build, pledging no more than they hold', { skip }, async () => {
  for (const lovelace of [1_100_000n, 3n * ADA, 5_500_000n]) {
    const c = utxo(`${'b1'.repeat(32)}#1`, BATCHER_ADDRESS, value(lovelace));
    const b = await run([swap()], { world: (w) => void (w.batcher.collateral = c) });
    const back = BigInt(CSL.Transaction.from_hex(b.txHex).body().collateral_return()?.amount().coin().to_str() ?? '0');
    assert.equal(b.totalCollateral + back, lovelace, `${lovelace}`);
    assert.ok(b.totalCollateral * 100n >= b.fee * BigInt(PP.collateralPercentage), `${lovelace}`);
    // With room for one, the rest comes back: only the share of the fee is put at stake.
    if (lovelace >= 3n * ADA) assert.ok(back > 0n, `${lovelace}`);
  }
  // Too small for the fee's share: refused, never built short.
  const tiny = utxo(`${'b1'.repeat(32)}#1`, BATCHER_ADDRESS, value(900_000n));
  await assert.rejects(() => run([swap()], { world: (w) => void (w.batcher.collateral = tiny) }), /collateral UTxO holds 900000/);
});

test('a batch of more bytes than one transaction may be is refused as too big, to be split', { skip }, async () => {
  // Four orders, each carrying 56 tokens of its own, which go back to the trader.
  const junk = (k: number): [string, string, bigint][] => Array.from({ length: 56 }, (_, i) => [(k * 1000 + i).toString(16).padStart(56, '0'), 'aa'.repeat(32), 1n]);
  const orders = Array.from({ length: 4 }, (_, j) => order(`${(0xc1 + j).toString(16).repeat(32)}#0`, 1 + j, 60n * ADA, junk(j + 1), step.swapIn(true, 25n * ADA, 1n)));
  await assert.rejects(() => run(orders), (e: unknown) => e instanceof BatchTooBig && /more bytes than one transaction/.test(e.message));
});

test('a batch whose script runs out of the simulator’s budget is refused as too big, to be split', { skip }, async () => {
  const orders = Array.from({ length: 40 }, (_, j) => order(`${(0x10 + j).toString(16).repeat(32)}#0`, 1 + (j % 8), 14n * ADA, [], step.swapIn(true, 10n * ADA, 1n)));
  await assert.rejects(() => run(orders), (e: unknown) => e instanceof BatchTooBig && /ran out of budget/.test(e.message));
});

test('a reward balance someone paid into the batching account is withdrawn whole, into the batcher’s change', { skip }, async () => {
  const plain = await run([swap()]);
  const b = await run([swap()], { rewardBalance: 3n * ADA });
  const w = CSL.Transaction.from_hex(b.txHex).body().withdrawals()!;
  assert.equal(w.get(w.keys().get(0))!.to_str(), String(3n * ADA));
  assert.equal(changeOf(b.txHex) - changeOf(plain.txHex), 3n * ADA - (b.fee - plain.fee));
});

test('rates as Ogmios prints them ("n/d") give the same batch; a rate printed in e-notation builds', { skip }, async () => {
  const plain = await run([swap()]);
  const ogmios = { ...PP, executionUnitPrices: { priceMemory: '577/10000', priceSteps: '721/10000000' }, minFeeRefScriptCostPerByte: '15/1' };
  assert.equal((await run([swap()], { pp: ogmios })).fee, plain.fee);
  const tiny = { ...PP, executionUnitPrices: { ...PP.executionUnitPrices, priceSteps: 7.21e-7 } };
  assert.ok((await run([swap()], { pp: tiny })).fee < plain.fee);
});

test('each script’s language is read from its reference script: a V3 one with no V3 cost model is refused', { skip }, async () => {
  const v3 = CSL.ScriptRef.new_plutus_script(CSL.PlutusScript.new_with_version(Buffer.from(S.order.compiledCode, 'hex'), CSL.Language.new_plutus_v3()));
  assert.equal(referenceScriptOf(utxo(`${'a2'.repeat(32)}#1`, BATCHER_ADDRESS, value(ADA), undefined, v3)).language.kind(), CSL.LanguageKind.PlutusV3);
  await assert.rejects(
    () => run([swap()], { world: (w) => void (w.scripts.order = utxo(w.scripts.order.ref, BATCHER_ADDRESS, value(100n * ADA), undefined, v3)) }),
    (e: unknown) => e instanceof Unsupported && e.kind === 'PlutusV3',
  );
});

test('the batcher’s change goes to its own address only: another address is refused before anything is built', async () => {
  const stranger = traderAddress(7).to_bech32(undefined);
  await assert.rejects(() => run([swap()], { world: (w) => void (w.batcher.address = stranger) }), (e: unknown) => e instanceof SetupError && /not the batcher key's own enterprise address/.test(e.message));
});

test('a built batch pays the traders, the pool and the batcher’s own address, and no one else', { skip }, async () => {
  const b = await run([swap()]);
  const own = BATCHER_ADDRESS.to_bech32(undefined);
  paysOnlyWhomItShould(b.txHex, 1, own);
  const outs = CSL.Transaction.from_hex(b.txHex).body().outputs();
  // The change, sent anywhere else.
  const elsewhere = withOutput(b.txHex, outs.len() - 1, () => ({ address: traderAddress(7) }));
  assert.throws(() => paysOnlyWhomItShould(elsewhere, 1, own), (e: unknown) => e instanceof SetupError && /change to an address/.test(e.message));
  // One output more or fewer than the orders, the pool and the change.
  assert.throws(() => paysOnlyWhomItShould(b.txHex, 2, own), /outputs/);
});
