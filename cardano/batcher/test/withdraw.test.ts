// The lock's WithdrawFeeSharing (src/lock.ts withdrawSpec, and readLockTx reading it back), on
// the chain test/withdraw-chain.ts builds from PR #1148's real preprod rehearsal: the Execute
// that switches the venue's share on, then a swap the batcher's own code fills, which leaves the
// share in the pool. With AIKEN set, Aiken judges each transaction with preprod's slot times
// against the real reference scripts: the honest ones pass, every tampered one fails in a script.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import CSL from '@emurgo/cardano-serialization-lib-nodejs';
import { encodeSetting, encodeState, lockTx, readLockTx, settingNow, shareOf, withdrawSpec, type LockDeployment, type LockSpec } from '../src/lock.ts';
import { valueFromCsl } from '../src/chain.ts';
import { mkConstr, mkInt } from '../src/plutus.ts';
import { planBatch, type Utxo } from '../src/plan.ts';
import { equals } from '../src/value.ts';
import { lpAssetName } from '../src/verify.ts';
import { BIG, BOTH, CHANGE_AFTER, COIN, D, DEX, EXECUTE, FX, GS, judge, LOCK, LOCK_AFTER, ORDER, outputs, POOL, POOL_AFTER, READY, REFS, slotOf, SWAPPED, WX } from './withdraw-chain.ts';

const AIKEN = process.env.AIKEN;
const big = (n: bigint) => CSL.BigNum.from_str(n.toString());
const validity = { start: slotOf(READY + 1_800_000n), ttl: slotOf(READY + 1_800_000n) + 7_200n };
const plan = { pp: FX.pp, funds: [CHANGE_AFTER], change: FX.deployment.deployer, validity };
const build = (spec: LockSpec) => lockTx(spec, plan).txHex;
const spec = (pool: Utxo = SWAPPED.pool, setting: Utxo = GS, d: LockDeployment = D, lock: Utxo = LOCK_AFTER) => withdrawSpec(d, REFS, lock, pool, setting, FX.pp);
const isPool = (o: CSL.TransactionOutput) => o.address().payment_cred()?.to_scripthash()?.to_hex() === D.pool;
const isTreasury = (o: CSL.TransactionOutput) => o.address().to_bech32(undefined) === D.treasury;
/** The spec with its pool output, or its treasury output, replaced. */
const withPool = (s: LockSpec, f: (o: CSL.TransactionOutput) => CSL.TransactionOutput): LockSpec => ({ ...s, outputs: s.outputs.map((o) => (isPool(o) ? f(o) : o)) });
const outputAt = (address: CSL.Address, v: CSL.Value, datum?: CSL.PlutusData) => {
  const o = CSL.TransactionOutput.new(address, v);
  if (datum) o.set_plutus_data(datum);
  return o;
};
const coin = (n: bigint) => CSL.Value.new(big(n));
const memetest = (o: CSL.TransactionOutput) => BigInt(o.amount().multiasset()?.get_asset(CSL.ScriptHash.from_hex(COIN.policyId), CSL.AssetName.new(Buffer.from(COIN.assetName, 'hex')))?.to_str() ?? '0');
/** The lock after the Execute, but still holding the real announcement: a withdrawal while a change waits. */
const WAITING: Utxo = (() => {
  const o = CSL.TransactionOutput.from_hex(LOCK_AFTER.outputHex);
  o.set_plutus_data(CSL.TransactionOutput.from_hex(LOCK.outputHex).plutus_data()!);
  return { ref: LOCK_AFTER.ref, outputHex: o.to_hex() };
})();
/** Judged by Aiken when it is here: true when every script passes. */
const passes = (txHex: string, extra: Utxo[] = []) => {
  const j = judge(AIKEN!, txHex, outputs(extra));
  return j.ok ? true : j.error;
};

test('the share a real swap leaves, once the venue share is on: 3,999 lovelace of a 10 tADA swap, read from the pool', () => {
  // The batcher's maths, replayed on the real fill first (the pool as opened, the real order): it
  // gives the pool the chain holds after that fill, its datum to the byte and its value exactly.
  const fill = planBatch(DEX, { ref: WX.refs.opened, outputHex: WX.outputs[WX.refs.opened]! }, [ORDER], [2_000_000n], 0n, null);
  const chainPool = CSL.FixedTransaction.from_hex(WX.fillTx).body().outputs().get(1);
  assert.equal(chainPool.to_hex(), POOL.outputHex);
  assert.equal(fill.poolOutput.datum.to_hex(), chainPool.plutus_data()!.to_hex());
  assert.ok(equals(fill.poolOutput.value, valueFromCsl(chainPool.amount())));
  assert.deepEqual(shareOf(POOL.outputHex), { ...shareOf(POOL.outputHex), a: 0n, b: 0n });
  assert.deepEqual(shareOf(POOL_AFTER.outputHex), { ...shareOf(POOL_AFTER.outputHex), a: 0n, b: 0n });
  // 10,000,000 x 30/10000 x 1333/10000, rounded down: about 0.04% of the trade.
  assert.equal(shareOf(SWAPPED.pool.outputHex).a, 3_999n);
  assert.equal(shareOf(SWAPPED.pool.outputHex).b, 0n);
  // The flipped swap, 2,000,000,000 MEMETEST in: its share is in MEMETEST.
  assert.deepEqual([shareOf(BOTH.pool.outputHex).a, shareOf(BOTH.pool.outputHex).b], [3_999n, 799_800n]);
  if (AIKEN) {
    assert.equal(passes(EXECUTE.txHex), true);
    assert.equal(passes(SWAPPED.txHex), true);
    assert.equal(passes(BOTH.txHex), true);
    assert.equal(passes(BIG.txHex), true);
  }
});

test('the withdrawal: the whole share to the treasury, the pool otherwise exactly as it was, the lock unchanged', () => {
  const tx = build(spec());
  const r = readLockTx(tx, outputs(), D)!;
  assert.equal(r.action, 'WithdrawFeeSharing');
  const words = r.words.join('\n');
  assert.match(words, /takes the venue's fee share out of pool ADA \/ MEMETEST \(1ac2931c06a56bbab07c21ab7fde8eb6cac7cf427a49b03f00aa234b\.4d454d4554455354\)/);
  assert.match(words, /leaves the pool: 3999 lovelace \(0\.003999 ADA\)/);
  assert.ok(words.includes(`to the treasury ${D.treasury}, and nowhere else`));
  assert.match(words, /reserves 119996001 \/ 416884555170, total liquidity 7071067812, LP balance 9223372029783708005, all unchanged/);
  assert.match(r.when, /waits for nothing; valid from 2026-11-10 03:04:24 UTC until 2026-11-10 05:04:24 UTC/);
  assert.deepEqual(r.withdrawal!.leaves, [{ ticker: 'ADA', policy: '', name: '', quantity: '3999' }]);
  assert.equal(r.withdrawal!.treasury, D.treasury);
  assert.deepEqual(r.announced, []);
  // The bytes: the pool keeps its address and datum to the byte, and loses exactly the share.
  const body = CSL.FixedTransaction.from_hex(tx).body();
  const outs = Array.from({ length: body.outputs().len() }, (_, i) => body.outputs().get(i));
  const before = CSL.TransactionOutput.from_hex(SWAPPED.pool.outputHex);
  const pool = outs.find(isPool)!;
  assert.equal(pool.address().to_hex(), before.address().to_hex());
  assert.equal(pool.plutus_data()!.to_hex(), before.plutus_data()!.to_hex());
  assert.equal(pool.amount().to_hex(), before.amount().checked_sub(coin(3_999n)).to_hex());
  assert.ok(BigInt(outs.find(isTreasury)!.amount().coin().to_str()) >= 3_999n);
  assert.equal(body.required_signers()!.len(), 2);
  if (AIKEN) assert.equal(passes(tx), true);
  // A share above an output's min-ADA (a 3,000 tADA swap): the treasury receives exactly it, nothing of the deployer's.
  const big = build(spec(BIG.pool));
  const rb = readLockTx(big, outputs(), D)!;
  assert.equal(shareOf(BIG.pool.outputHex).a, 1_199_700n);
  assert.deepEqual(rb.withdrawal!.receives, [{ ticker: 'ADA', policy: '', name: '', quantity: '1199700' }]);
  assert.doesNotMatch(rb.words.join('\n'), /own funds/);
  if (AIKEN) assert.equal(passes(big), true);
  // While a change waits in the lock: the withdrawal leaves it there.
  const waiting = build(spec(SWAPPED.pool, GS, D, WAITING));
  assert.match(readLockTx(waiting, outputs([WAITING]), D)!.words.join('\n'), /the lock: unchanged, 1 announced/);
  if (AIKEN) assert.equal(passes(waiting, [WAITING]), true);
});

test('a share in both coins: each leaves the pool for the treasury, with its ticker and whole policy id', () => {
  const tx = build(spec(BOTH.pool));
  const r = readLockTx(tx, outputs(), D)!;
  const words = r.words.join('\n');
  assert.match(words, /leaves the pool: 3999 lovelace/);
  assert.match(words, /leaves the pool: 799800 MEMETEST \(1ac2931c06a56bbab07c21ab7fde8eb6cac7cf427a49b03f00aa234b\.4d454d4554455354\)/);
  assert.deepEqual(r.withdrawal!.leaves[1], { ticker: 'MEMETEST', policy: COIN.policyId, name: COIN.assetName, quantity: '799800' });
  const t = Array.from({ length: CSL.FixedTransaction.from_hex(tx).body().outputs().len() }, (_, i) => CSL.FixedTransaction.from_hex(tx).body().outputs().get(i)).find(isTreasury)!;
  assert.equal(memetest(t), 799_800n);
  if (AIKEN) assert.equal(passes(tx), true);
});

test('refused: any of the share paid to anything but the treasury', () => {
  const s = spec(BOTH.pool);
  const deployer = CSL.Address.from_bech32(FX.deployment.deployer);
  // The treasury's output sent to the deployer instead.
  const away = build({ ...s, outputs: s.outputs.map((o) => (isTreasury(o) ? outputAt(deployer, o.amount()) : o)) });
  assert.throws(() => readLockTx(away, outputs(), D), /the treasury receives 0 of the 3999 lovelace that leave the pool/);
  // One MEMETEST of the share to the deployer, the rest to the treasury.
  const t = s.outputs.find(isTreasury)!;
  const ma = CSL.MultiAsset.new();
  ma.set_asset(CSL.ScriptHash.from_hex(COIN.policyId), CSL.AssetName.new(Buffer.from(COIN.assetName, 'hex')), big(1n));
  const one = CSL.Value.new_with_assets(big(0n), ma);
  const split = build({ ...s, outputs: [...s.outputs.map((o) => (o === t ? outputAt(o.address(), o.amount().checked_sub(one)) : o)), outputAt(deployer, CSL.Value.new_with_assets(big(1_500_000n), ma))] });
  assert.throws(() => readLockTx(split, outputs(), D), /the treasury receives 799799 of the 799800 MEMETEST/);
  // The treasury's payment script with another stake: not the treasury's whole address.
  const pay = CSL.BaseAddress.from_address(CSL.Address.from_bech32(D.treasury))!.payment_cred();
  const other = build({ ...s, outputs: s.outputs.map((o) => (o === t ? outputAt(CSL.EnterpriseAddress.new(0, pay).to_address(), o.amount()) : o)) });
  assert.throws(() => readLockTx(other, outputs(), D), /the treasury receives 0 of/);
  // A GlobalSetting whose fee-share taker is a key: the builder and the reading both refuse it.
  const g = CSL.TransactionOutput.from_hex(GS.outputHex);
  g.set_plutus_data(encodeSetting({ ...settingNow(GS.outputHex), feeSharingTaker: { kind: 'signature', hash: FX.deployment.ownerA } }));
  const rogue: Utxo = { ref: GS.ref, outputHex: g.to_hex() };
  assert.throws(() => spec(SWAPPED.pool, rogue), /fee share would be taken by signature 26fd40be.*not the lock/);
  assert.throws(() => readLockTx(build(spec()), outputs([rogue]), D), /fee share would be taken by signature/);
  if (AIKEN) for (const tx of [away, split, other]) assert.notEqual(passes(tx), true);
});

test("refused: any change to the pool's reserves, LP balance, datum or address beyond taking the share", () => {
  const s = spec();
  const fields = (o: CSL.TransactionOutput) => {
    const f = o.plutus_data()!.as_constr_plutus_data()!.data();
    return Array.from({ length: f.len() }, (_, i) => f.get(i));
  };
  // The datum's reserve A raised by one, the value as built.
  const raised = build(withPool(s, (o) => {
    const f = fields(o);
    f[4] = mkInt(BigInt(f[4]!.as_integer()!.to_str()) + 1n);
    return outputAt(o.address(), o.amount(), mkConstr(0, f));
  }));
  assert.throws(() => readLockTx(raised, outputs(), D), /the pool's datum changes/);
  // One LP token out of the pool (to the treasury, even): the LP balance changes.
  const lp = CSL.MultiAsset.new();
  lp.set_asset(CSL.ScriptHash.from_hex(D.authen), CSL.AssetName.new(Buffer.from(lpAssetName({ policyId: '', assetName: '' }, COIN), 'hex')), big(1n));
  const lpOut = build({ ...s, outputs: s.outputs.map((o) => (isPool(o) ? outputAt(o.address(), o.amount().checked_sub(CSL.Value.new_with_assets(big(0n), lp)), o.plutus_data()!) : isTreasury(o) ? outputAt(o.address(), o.amount().checked_add(CSL.Value.new_with_assets(big(2_000_000n), lp))) : o)) });
  assert.throws(() => readLockTx(lpOut, outputs(), D), /not the pool less its fee share: its reserves or its LP balance would change/);
  // One lovelace of the share left in the pool, or one lovelace of the reserves taken with it.
  const less = build(withPool(s, (o) => outputAt(o.address(), o.amount().checked_add(coin(1n)), o.plutus_data()!)));
  assert.throws(() => readLockTx(less, outputs(), D), /not the pool less its fee share/);
  const more = build(withPool(s, (o) => outputAt(o.address(), o.amount().checked_sub(coin(1n)), o.plutus_data()!)));
  assert.throws(() => readLockTx(more, outputs(), D), /not the pool less its fee share/);
  // The pool's stake moved to owner A's key.
  const moved = build(withPool(s, (o) => outputAt(CSL.BaseAddress.new(0, o.address().payment_cred()!, CSL.Credential.from_keyhash(CSL.Ed25519KeyHash.from_hex(D.ownerA))).to_address(), o.amount(), o.plutus_data()!)));
  assert.throws(() => readLockTx(moved, outputs(), D), /the pool's address changes/);
  // The pool spent by its fee-update path, or by a WithdrawFeeSharing carrying a field: not Minswap's WithdrawFeeSharing.
  const path = build({ ...s, spends: s.spends.map((x) => (x.utxo.ref === SWAPPED.pool.ref ? { ...x, redeemer: mkConstr(1, [mkConstr(0, [])]) } : x)) });
  assert.throws(() => readLockTx(path, outputs(), D), /spent other than by WithdrawFeeSharing/);
  const field = build({ ...s, spends: s.spends.map((x) => (x.utxo.ref === SWAPPED.pool.ref ? { ...x, redeemer: mkConstr(2, [mkInt(0n)]) } : x)) });
  assert.throws(() => readLockTx(field, outputs(), D), /spent other than by WithdrawFeeSharing/);
  // No GlobalSetting read: whose fee-share taker would the share go to?
  const unread = build({ ...s, reads: [] });
  assert.throws(() => readLockTx(unread, outputs(), D), /reads no GlobalSetting of ours/);
  // The lock's list changed on the way: a withdrawal changes nothing in the lock.
  const lockOut = s.outputs[0]!;
  const listed = build({ ...s, outputs: [outputAt(lockOut.address(), lockOut.amount().checked_add(coin(1_000_000n)), encodeState([{ change: { kind: 'SetGlobalSetting', setting: settingNow(GS.outputHex) }, readyAt: READY }])), ...s.outputs.slice(1)] });
  assert.throws(() => readLockTx(listed, outputs(), D), /leaves the lock's list as it was/);
  if (AIKEN) for (const tx of [raised, lpOut, less, more, moved, path, unread, listed]) assert.notEqual(passes(tx), true);
});

test('refused: a withdrawal on the wrong network', () => {
  const main: LockDeployment = { ...D, network: 1, treasury: 'addr1xy6kxswfkhnxfwllzcxkqfumhyjedvkvkvlt3p7mhwxwp3spv7vdp6er80lvtdm32cqvvetu93ams9yrggg5pm5tq3usr47kat' };
  assert.throws(() => readLockTx(build(spec()), outputs(), main), /preprod address, and this run says mainnet/);
  assert.throws(() => spec(SWAPPED.pool, GS, main), /preprod address, and this run says mainnet/);
  // A preprod run whose treasury is a mainnet address.
  assert.throws(() => spec(SWAPPED.pool, GS, { ...D, treasury: main.treasury }), /the treasury addr1.* is a mainnet address, and this run says preprod/);
  // A pool at its mainnet address (the same scripts), the lock and the setting on preprod.
  const p = CSL.TransactionOutput.from_hex(SWAPPED.pool.outputHex);
  const base = CSL.BaseAddress.from_address(p.address())!;
  const onMain = outputAt(CSL.BaseAddress.new(1, base.payment_cred(), base.stake_cred()).to_address(), p.amount(), p.plutus_data()!);
  assert.throws(() => spec({ ref: SWAPPED.pool.ref, outputHex: onMain.to_hex() }), /the pool [0-9a-f]{64}#1 is at addr1.* a mainnet address, and this run says preprod/);
});

test('refused by the builder: what is not our pool or our GlobalSetting, and a pool with no datum', () => {
  assert.throws(() => spec(GS), /is not one of our pools/);
  assert.throws(() => spec(SWAPPED.pool, SWAPPED.pool), /is not our GlobalSetting/);
  // A pool output with no datum: whatever it holds, no reserves to measure the share against.
  const p = CSL.TransactionOutput.from_hex(SWAPPED.pool.outputHex);
  assert.throws(() => spec({ ref: SWAPPED.pool.ref, outputHex: outputAt(p.address(), p.amount()).to_hex() }), /the pool holds no inline datum/);
});

test('refused: a withdrawal with nothing accrued (the chain would take it, for a fee and min-ADA, and nothing for the venue)', () => {
  // The pool as the chain holds it today (share off), and as the Execute leaves it (share on, no trade yet).
  assert.throws(() => spec(POOL), /nothing has accrued in 41b826378ae6bf3d3aeed52ecc88fcbaa30fbe3aa5c85c1379bdcc42e0661572#1/);
  assert.throws(() => spec(POOL_AFTER), /nothing has accrued/);
  // Bytes made by another tool: the pool spent and written back unchanged, the treasury paid min-ADA.
  const s = spec();
  const empty = build({
    ...s,
    spends: s.spends.map((x) => (x.utxo.ref === SWAPPED.pool.ref ? { ...x, utxo: POOL_AFTER } : x)),
    outputs: s.outputs.map((o) => (isPool(o) ? CSL.TransactionOutput.from_hex(POOL_AFTER.outputHex) : o)),
  });
  assert.throws(() => readLockTx(empty, outputs(), D), /nothing has accrued in the pool: the withdrawal would take nothing/);
  if (AIKEN) assert.equal(passes(empty), true, 'Minswap and the lock both allow a withdrawal of nothing: only this tool refuses it');
});
