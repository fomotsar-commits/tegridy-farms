// Changes through the 48-hour role lock (src/lock.ts), built and read back from their own bytes,
// against the real preprod deployment of PR #1148's rehearsal (test/fixtures/lock-preprod.json:
// every output is its producing transaction's bytes, read from Koios). The Execute of the real
// announcement (fb17d866, ready 2026-11-10T02:34:24Z) is built here dated after ready_at and,
// with AIKEN set, judged by Aiken with preprod's slot times. Nothing here touches a chain.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import CSL from '@emurgo/cardano-serialization-lib-nodejs';
import type { ProtocolParams } from '../src/build.ts';
import { PREPROD_TIME, plutusSerialise, slotToPosixMs } from '../src/chain.ts';
import {
  DELAY_MS,
  GRACE_MS,
  SLACK_MS,
  announceSpec,
  announceWindow,
  cancelSpec,
  decodeState,
  encodeChange,
  encodeSetting,
  encodeState,
  executeSpec,
  executeWindow,
  lockRedeemer,
  lockTx,
  matchesAnnounced,
  poolChange,
  poolNow,
  readLockTx,
  settingChange,
  settingNow,
  type Announcement,
  type LockDeployment,
  type LockRefs,
  type LockSpec,
  type PoolChange,
} from '../src/lock.ts';
import { mkBytes, mkConstr } from '../src/plutus.ts';
import { simulate } from '../src/simulate.ts';
import type { Utxo } from '../src/plan.ts';

const FX = JSON.parse(readFileSync(new URL('./fixtures/lock-preprod.json', import.meta.url), 'utf8')) as {
  announceTx: string;
  refs: Record<'lock' | 'pool' | 'globalSetting' | 'lockScript' | 'poolScript' | 'funds' | 'authenScript', string>;
  outputs: Record<string, string>;
  pp: ProtocolParams;
  deployment: { lock: string; policy: string; pool: string; ownerA: string; ownerB: string; treasury: string; deployer: string };
};
const D: LockDeployment = { network: 0, lock: FX.deployment.lock, authen: FX.deployment.policy, pool: FX.deployment.pool, ownerA: FX.deployment.ownerA, ownerB: FX.deployment.ownerB, treasury: FX.deployment.treasury };
const utxo = (ref: string): Utxo => ({ ref, outputHex: FX.outputs[ref]! });
const REFS: LockRefs = { lockScript: utxo(FX.refs.lockScript), poolScript: utxo(FX.refs.poolScript), settingScript: utxo(FX.refs.authenScript) };
const LOCK = utxo(FX.refs.lock);
const POOL = utxo(FX.refs.pool);
const GS = utxo(FX.refs.globalSetting);
const FUNDS = utxo(FX.refs.funds);
const outputs = (extra: Utxo[] = []) => {
  const all: Record<string, string> = { ...FX.outputs };
  for (const u of extra) all[u.ref] = u.outputHex;
  return (ref: string) => all[ref];
};
const READY = 1_794_278_064_000n; // 2026-11-10T02:34:24Z, as the real Announce says
const slotOf = (ms: bigint) => PREPROD_TIME.zeroSlot + (ms - PREPROD_TIME.zeroTimeMs) / PREPROD_TIME.slotLengthMs;
const plan = (validity: { start: bigint; ttl: bigint }) => ({ pp: FX.pp, funds: [FUNDS], change: FX.deployment.deployer, validity });
const big = (n: bigint) => CSL.BigNum.from_str(n.toString());
const AIKEN = process.env.AIKEN;
/** Every output the transaction spends, reads or pledges, for Aiken. */
function spentOf(txHex: string, extra: Utxo[] = []): Record<string, string> {
  const body = CSL.FixedTransaction.from_hex(txHex).body();
  const look = outputs(extra);
  const m: Record<string, string> = {};
  for (const l of [body.inputs(), body.reference_inputs(), body.collateral()]) {
    for (let i = 0; i < (l?.len() ?? 0); i++) {
      const r = `${l!.get(i).transaction_id().to_hex()}#${l!.get(i).index()}`;
      m[r] = look(r)!;
    }
  }
  return m;
}
const judged = (txHex: string, extra: Utxo[] = []) => simulate(AIKEN!, txHex, spentOf(txHex, extra), PREPROD_TIME);
/** A pool output as `o`, its datum's fee share set to `share` (Some) or none. */
function withShare(o: CSL.TransactionOutput, share: bigint | null): CSL.TransactionOutput {
  const f = o.plutus_data()!.as_constr_plutus_data()!.data();
  const fields = Array.from({ length: f.len() }, (_, i) => f.get(i));
  fields[8] = share === null ? mkConstr(1, []) : mkConstr(0, [CSL.PlutusData.new_integer(CSL.BigInt.from_str(share.toString()))]);
  const p = CSL.TransactionOutput.new(o.address(), o.amount());
  p.set_plutus_data(mkConstr(0, fields));
  return p;
}
/** The Execute of the real announcement, dated `at` (ms), as a spec the tests may change. */
function execute(at = READY + 10n * 60_000n): { spec: LockSpec; validity: { start: bigint; ttl: bigint } } {
  const validity = executeWindow(slotOf(at), 0, READY, 600n);
  return { spec: executeSpec(D, REFS, LOCK, 0, POOL, GS, FX.pp), validity };
}

test('the real preprod Announce (fb17d866), read from its bytes: SetPool, venue share off to 1333/10000, ready 2026-11-10 02:34:24 UTC', () => {
  const r = readLockTx(FX.announceTx, outputs(), D, { pool: POOL.outputHex, setting: GS.outputHex })!;
  assert.equal(r.action, 'Announce');
  assert.equal(r.readyAt, '2026-11-10 02:34:24 UTC');
  assert.equal(r.closesAt, '2026-11-24 02:34:24 UTC');
  const words = r.words.join('\n');
  assert.match(words, /pool ADA \/ MEMETEST \(1ac2931c06a56bbab07c21ab7fde8eb6cac7cf427a49b03f00aa234b\.4d454d4554455354\)/);
  assert.match(words, /venue share: off → 1333\/10000 of the trade fee/);
  assert.match(words, /base fee: 30\/30 \(0\.30% each way\), unchanged/);
  assert.match(words, /stake: kept, script 11e0cd829dfd036d09bff2b7182c7211c2613211e29600a881703688/);
  assert.match(r.when, /can run from 2026-11-10 02:34:24 UTC until 2026-11-24 02:34:24 UTC/);
  // The lock now holds exactly that announcement, and the change encodes back to the same data.
  const [ann] = decodeState(CSL.TransactionOutput.from_hex(LOCK.outputHex).plutus_data()!);
  assert.equal(ann!.readyAt, READY);
  const lockDatum = CSL.TransactionOutput.from_hex(LOCK.outputHex).plutus_data()!;
  assert.deepEqual(plutusSerialise(encodeState([ann!])), plutusSerialise(lockDatum));
});

test('the Execute of that announcement, after ready_at: the pool gets share 1333/10000, its value, stake, reserves and fees unchanged', () => {
  const { spec, validity } = execute();
  const b = lockTx(spec, plan(validity));
  const r = readLockTx(b.txHex, outputs(), D)!;
  assert.equal(r.action, 'Execute');
  assert.match(r.words.join('\n'), /venue share: off → 1333\/10000 of the trade fee/);
  assert.match(r.words.join('\n'), /base fee: 30\/30 \(0\.30% each way\), unchanged/);
  assert.match(r.words.join('\n'), /stake: kept/);
  assert.deepEqual(r.announced, []);
  const body = CSL.FixedTransaction.from_hex(b.txHex).body();
  assert.ok(slotToPosixMs(BigInt(body.validity_start_interval_bignum()!.to_str()), PREPROD_TIME) >= READY);
  const pool = Array.from({ length: body.outputs().len() }, (_, i) => body.outputs().get(i)).find((o) => o.address().to_bech32(undefined) === CSL.TransactionOutput.from_hex(POOL.outputHex).address().to_bech32(undefined))!;
  assert.equal(pool.amount().to_hex(), CSL.TransactionOutput.from_hex(POOL.outputHex).amount().to_hex());
  assert.deepEqual(poolNow(pool.to_hex()), { ...poolNow(POOL.outputHex), feeSharing: 1333n });
  if (AIKEN) {
    const j = judged(b.txHex);
    assert.ok(j.ok, j.ok ? '' : j.error);
    assert.equal(j.budgets.length, 2);
  }
});

test('refused: an Execute before ready_at (the builder waits for the chain, with slack for a slow clock; the reading refuses the bytes)', () => {
  assert.throws(() => executeWindow(slotOf(READY - 1_000n), 0, READY, 600n), /not ready/);
  // Ready, but within the slack: a PC clock 90 s slow would still see the lower bound ahead.
  assert.throws(() => executeWindow(slotOf(READY + 60_000n), 0, READY, 600n), /not ready/);
  const w = executeWindow(slotOf(READY + SLACK_MS + 1_000n), 0, READY, 600n);
  assert.ok(slotToPosixMs(w.start, PREPROD_TIME) >= READY);
  assert.ok(slotToPosixMs(w.start, PREPROD_TIME) <= READY + 1_000n + 1_000n);
  // Long after ready_at, the lower bound sits the slack behind the tip.
  const late = executeWindow(slotOf(READY + 86_400_000n), 0, READY, 600n);
  assert.equal(late.start, slotOf(READY + 86_400_000n) - SLACK_MS / 1_000n);
  assert.throws(() => executeWindow(slotOf(READY + GRACE_MS + 1_000n), 0, READY, 600n), /window closed/);
  assert.ok(slotToPosixMs(executeWindow(slotOf(READY + GRACE_MS - 200_000n), 0, READY, 600n).ttl, PREPROD_TIME) <= READY + GRACE_MS);
  // The same Execute, its lower bound one slot before ready_at: the reading refuses it, and so does the lock.
  const { spec } = execute();
  const early = lockTx(spec, plan({ start: slotOf(READY) - 1n, ttl: slotOf(READY) + 300n }));
  assert.throws(() => readLockTx(early.txHex, outputs(), D), /before ready_at/);
  if (AIKEN) assert.equal(judged(early.txHex).ok, false);
});

test('refused: an Execute whose change differs from the announced one', () => {
  const [ann] = decodeState(CSL.TransactionOutput.from_hex(LOCK.outputHex).plutus_data()!);
  const asked = ann!.change as PoolChange;
  matchesAnnounced(ann!.change, { ...asked });
  assert.throws(() => matchesAnnounced(ann!.change, { ...asked, feeSharing: 1334n }), /differs from the announced/);
  assert.throws(() => matchesAnnounced(ann!.change, { ...asked, baseFeeA: 25n }), /differs from the announced/);
  // The bytes: the pool output carrying share 1334 instead of the announced 1333.
  const { spec, validity } = execute();
  const tampered = { ...spec, outputs: spec.outputs.map((o) => (o.has_plutus_data() && CSL.Address.from_bech32(o.address().to_bech32(undefined)).payment_cred()?.to_scripthash()?.to_hex() === D.pool ? withShare(o, 1334n) : o)) };
  const b = lockTx(tampered, plan(validity));
  assert.throws(() => readLockTx(b.txHex, outputs(), D), /differs from the announced change/);
  if (AIKEN) assert.equal(judged(b.txHex).ok, false);
});

test('refused: a SetPool that would pay the fee share anywhere but the treasury', () => {
  // The pool's value leaves it: 1 tADA of it paid to the deployer.
  const { spec, validity } = execute();
  const poolOut = spec.outputs.find((o) => o.address().payment_cred()?.to_scripthash()?.to_hex() === D.pool)!;
  const less = CSL.TransactionOutput.new(poolOut.address(), poolOut.amount().checked_sub(CSL.Value.new(big(1_000_000n))));
  less.set_plutus_data(poolOut.plutus_data()!);
  const taken = { ...spec, outputs: [...spec.outputs.map((o) => (o === poolOut ? less : o)), CSL.TransactionOutput.new(CSL.Address.from_bech32(FX.deployment.deployer), CSL.Value.new(big(1_000_000n)))] };
  assert.throws(() => readLockTx(lockTx(taken, plan(validity)).txHex, outputs(), D), /the pool's value changes/);
  // A GlobalSetting whose fee-share taker is a key, not the lock (which pays only the treasury).
  const s = settingNow(GS.outputHex);
  const keyTaker = CSL.TransactionOutput.from_hex(GS.outputHex);
  keyTaker.set_plutus_data(encodeSetting({ ...s, feeSharingTaker: { kind: 'signature', hash: FX.deployment.ownerA } }));
  const rogue: Utxo = { ref: GS.ref, outputHex: keyTaker.to_hex() };
  assert.throws(() => executeSpec(D, REFS, LOCK, 0, POOL, rogue, FX.pp), /fee share .* not the lock/);
  assert.throws(() => readLockTx(lockTx(spec, plan(validity)).txHex, outputs([rogue]), D), /fee share .* not the lock/);
  assert.throws(() => readLockTx(FX.announceTx, outputs(), D, { pool: POOL.outputHex, setting: rogue.outputHex }), /fee share .* not the lock/);
});

test("refused: a SetPool that changes the pool's stake credential unasked", () => {
  const now = poolNow(POOL.outputHex);
  assert.deepEqual(now.stake, { kind: 'script', hash: '11e0cd829dfd036d09bff2b7182c7211c2613211e29600a881703688' });
  // Asked for a share only: the stake stays the pool's own.
  assert.deepEqual(poolChange(now, { feeSharing: 1500n }), { ...now, feeSharing: 1500n });
  // The stake moves only when asked, and then alone (the pool's admin path changes one thing a time).
  const key = { kind: 'key' as const, hash: FX.deployment.ownerA };
  assert.deepEqual(poolChange(now, { stake: key }).stake, key);
  assert.throws(() => poolChange(now, { feeSharing: 1500n, stake: key }), /one at a time/);
  assert.throws(() => poolChange(now, {}), /changes nothing/);
  assert.throws(() => poolChange(now, { feeSharing: 1000n }), /1333 to 5000/);
  assert.throws(() => poolChange(now, { baseFee: [4n, 30n] }), /5 to 2000/);
  // An Execute whose pool output moves the stake the announcement keeps: refused.
  const { spec, validity } = execute();
  const poolOut = spec.outputs.find((o) => o.address().payment_cred()?.to_scripthash()?.to_hex() === D.pool)!;
  const moved = CSL.TransactionOutput.new(CSL.BaseAddress.new(0, CSL.Credential.from_scripthash(CSL.ScriptHash.from_hex(D.pool)), CSL.Credential.from_keyhash(CSL.Ed25519KeyHash.from_hex(key.hash))).to_address(), poolOut.amount());
  moved.set_plutus_data(poolOut.plutus_data()!);
  const b = lockTx({ ...spec, outputs: spec.outputs.map((o) => (o === poolOut ? moved : o)) }, plan(validity));
  assert.throws(() => readLockTx(b.txHex, outputs(), D), /differs from the announced change: .*stake script 11e0cd82[0-9a-f]*; the output holds .*stake key 26fd40be/);
  // An announcement that moves it says so, loudly.
  const ann = announceSpec(D, REFS, LOCK, poolChange(now, { stake: key }), 0n, FX.pp);
  const w = announceWindow(slotOf(READY), 0, 600n);
  const a = lockTx(announceSpec(D, REFS, LOCK, poolChange(now, { stake: key }), w.readyAt, FX.pp), plan(w));
  assert.ok(ann);
  assert.match(readLockTx(a.txHex, outputs(), D, { pool: POOL.outputHex, setting: GS.outputHex })!.words.join('\n'), /stake: MOVES from script 11e0cd82.* to key 26fd40be/);
});

test('refused: a change on the wrong network', () => {
  const main: LockDeployment = { ...D, network: 1, treasury: 'addr1xy6kxswfkhnxfwllzcxkqfumhyjedvkvkvlt3p7mhwxwp3spv7vdp6er80lvtdm32cqvvetu93ams9yrggg5pm5tq3usr47kat' };
  // The real preprod Announce read as a mainnet run: its lock is a preprod address.
  assert.throws(() => readLockTx(FX.announceTx, outputs(), main), /preprod address, and this run says mainnet/);
  // Building on mainnet from preprod outputs.
  assert.throws(() => executeSpec(main, REFS, LOCK, 0, POOL, GS, FX.pp), /preprod address, and this run says mainnet/);
  assert.throws(() => announceSpec(main, REFS, LOCK, poolNow(POOL.outputHex), READY, FX.pp), /preprod address, and this run says mainnet/);
  assert.throws(() => announceWindow(100n, 2 as 0, 600n), /network/);
});

test('Announce: ready 48 hours after the latest moment it can land; a second announcement joins the first', () => {
  const tip = slotOf(READY - 3_600_000n);
  const w = announceWindow(tip, 0, 7_200n);
  assert.equal(w.start, tip - SLACK_MS / 1_000n);
  assert.equal(w.ttl, tip + 7_200n);
  assert.equal(w.readyAt, slotToPosixMs(w.ttl, PREPROD_TIME) + DELAY_MS);
  const change = poolChange(poolNow(POOL.outputHex), { baseFee: [25n, 25n] });
  const b = lockTx(announceSpec(D, REFS, LOCK, change, w.readyAt, FX.pp), plan(w));
  const r = readLockTx(b.txHex, outputs(), D, { pool: POOL.outputHex, setting: GS.outputHex })!;
  assert.equal(r.action, 'Announce');
  assert.match(r.words.join('\n'), /base fee: 30\/30 \(0\.30% each way\) → 25\/25 \(0\.25% each way\)/);
  assert.match(r.words.join('\n'), /venue share: off, unchanged/);
  assert.equal(r.announced.length, 2);
  // One millisecond short of 48 hours: refused.
  const short = lockTx(announceSpec(D, REFS, LOCK, change, w.readyAt - 1n, FX.pp), plan(w));
  assert.throws(() => readLockTx(short.txHex, outputs(), D), /48 hours/);
  // An Announce with no upper bound cannot say when it is ready.
  const open = lockTx(announceSpec(D, REFS, LOCK, change, w.readyAt, FX.pp), plan({ start: w.start, ttl: 0n }));
  assert.throws(() => readLockTx(open.txHex, outputs(), D), /both ends/);
  // The lock holds at most 16.
  const full = CSL.TransactionOutput.from_hex(LOCK.outputHex);
  const ann = decodeState(full.plutus_data()!)[0]!;
  full.set_plutus_data(encodeState(Array.from({ length: 16 }, () => ann)));
  assert.throws(() => announceSpec(D, REFS, { ref: LOCK.ref, outputHex: full.to_hex() }, change, w.readyAt, FX.pp), /16/);
});

test('Cancel removes exactly the one named; both owners must sign every lock transaction', () => {
  const w = announceWindow(slotOf(READY - 3_600_000n), 0, 600n);
  const b = lockTx(cancelSpec(D, REFS, LOCK, 0, FX.pp), plan(w));
  const r = readLockTx(b.txHex, outputs(), D, { pool: POOL.outputHex })!;
  assert.equal(r.action, 'Cancel');
  assert.deepEqual(r.announced, []);
  assert.match(r.words.join('\n'), /removes announcement #0, unmade/);
  assert.match(r.when, /it could have run from 2026-11-10 02:34:24 UTC/);
  assert.throws(() => cancelSpec(D, REFS, LOCK, 1, FX.pp), /no announcement #1/);
  const spec = cancelSpec(D, REFS, LOCK, 0, FX.pp);
  const one = lockTx({ ...spec, signers: [D.ownerA] }, plan(w));
  assert.throws(() => readLockTx(one.txHex, outputs(), D), /both owners/);
});

test('SetGlobalSetting: the roles stay the lock and the opening fee goes to the treasury; its Execute writes the setting first', () => {
  const now = settingNow(GS.outputHex);
  assert.equal(now.openingFee, 73_000_000n);
  const next = settingChange(now, { openingFee: 80_000_000n }, D);
  assert.throws(() => settingChange(now, {}, D), /changes nothing/);
  assert.throws(() => settingChange(now, { openingFee: -1n }, D), /negative/);
  assert.throws(() => settingChange(now, { batchers: [] }, D), /batcher/);
  const w = announceWindow(slotOf(READY - 3_600_000n), 0, 600n);
  const r = readLockTx(lockTx(announceSpec(D, REFS, LOCK, { kind: 'SetGlobalSetting', setting: next }, w.readyAt, FX.pp), plan(w)).txHex, outputs(), D, { setting: GS.outputHex })!;
  assert.match(r.words.join('\n'), /opening fee: 73 ADA → 80 ADA, paid to the treasury/);
  assert.match(r.words.join('\n'), /fee-share taker: the lock, unchanged/);
  // A setting moving a role off the lock, or paying the opening fee elsewhere: the builder refuses
  // it, and so does the reading of bytes that carry it (an announcement made by another tool).
  const good = announceSpec(D, REFS, LOCK, { kind: 'SetGlobalSetting', setting: next }, w.readyAt, FX.pp);
  const old = decodeState(CSL.TransactionOutput.from_hex(LOCK.outputHex).plutus_data()!);
  for (const [bad, re] of [
    [{ ...next, feeSharingTaker: { kind: 'signature' as const, hash: FX.deployment.ownerA } }, /fee-share taker is not the lock/],
    [{ ...next, admin: { kind: 'signature' as const, hash: FX.deployment.ownerA } }, /admin is not the lock/],
    [{ ...next, receiver: { payment: { kind: 'key' as const, hash: FX.deployment.ownerA }, stake: null } }, /not the treasury/],
  ] as const) {
    const announcement: Announcement = { change: { kind: 'SetGlobalSetting', setting: bad }, readyAt: w.readyAt };
    assert.throws(() => announceSpec(D, REFS, LOCK, announcement.change, w.readyAt, FX.pp), re);
    const lockOut = CSL.TransactionOutput.new(good.outputs[0]!.address(), good.outputs[0]!.amount());
    lockOut.set_plutus_data(encodeState([...old, announcement]));
    const spec: LockSpec = { ...good, spends: [{ ...good.spends[0]!, redeemer: lockRedeemer({ kind: 'Announce', announcement }) }], outputs: [lockOut] };
    const t = lockTx(spec, plan(w));
    assert.throws(() => readLockTx(t.txHex, outputs(), D), re);
  }
  // The Execute of such an announcement (a lock whose one announcement is ready now): the setting is output #0.
  const lockNow = CSL.TransactionOutput.from_hex(LOCK.outputHex);
  const announced: Announcement = { change: { kind: 'SetGlobalSetting', setting: next }, readyAt: READY };
  lockNow.set_plutus_data(encodeState([announced]));
  const lock2: Utxo = { ref: LOCK.ref, outputHex: lockNow.to_hex() };
  const x = lockTx(executeSpec(D, REFS, lock2, 0, GS, GS, FX.pp), plan(executeWindow(slotOf(READY + 600_000n), 0, READY, 600n)));
  const xr = readLockTx(x.txHex, outputs([lock2]), D)!;
  assert.equal(xr.action, 'Execute');
  assert.match(xr.words.join('\n'), /opening fee: 73 ADA → 80 ADA/);
  const first = CSL.FixedTransaction.from_hex(x.txHex).body().outputs().get(0);
  assert.deepEqual(plutusSerialise(first.plutus_data()!), plutusSerialise(encodeSetting(next)));
  if (AIKEN) {
    const j = judged(x.txHex, [lock2]);
    assert.ok(j.ok, j.ok ? '' : j.error);
  }
});

test('the change data is the contract’s: SetPool constructor 1, SetGlobalSetting 0, the stake Some(Inline(...))', () => {
  const now = poolNow(POOL.outputHex);
  const d = CSL.PlutusData.from_hex(encodeChange(now).to_hex()).as_constr_plutus_data()!;
  assert.equal(d.alternative().to_str(), '1');
  assert.equal(d.data().len(), 7);
  assert.equal(d.data().get(6).to_hex(), mkConstr(0, [mkConstr(0, [mkConstr(1, [mkBytes(now.stake!.hash)])])]).to_hex());
  assert.equal(CSL.PlutusData.from_hex(encodeChange({ kind: 'SetGlobalSetting', setting: settingNow(GS.outputHex) }).to_hex()).as_constr_plutus_data()!.alternative().to_str(), '0');
});

test("refused when read: a lock list not made by the action, the lock token leaving the lock, a move an Announce or Cancel never makes", () => {
  const w = announceWindow(slotOf(READY - 3_600_000n), 0, 600n);
  const lockOutWith = (spec: LockSpec, list: Announcement[], address?: CSL.Address) => {
    const o = CSL.TransactionOutput.new(address ?? spec.outputs[0]!.address(), spec.outputs[0]!.amount());
    o.set_plutus_data(encodeState(list));
    return o;
  };
  const old = decodeState(CSL.TransactionOutput.from_hex(LOCK.outputHex).plutus_data()!);
  const change = poolChange(poolNow(POOL.outputHex), { baseFee: [25n, 25n] });
  const a = announceSpec(D, REFS, LOCK, change, w.readyAt, FX.pp);
  // Announce: the old announcement dropped as the new one is added.
  assert.throws(() => readLockTx(lockTx({ ...a, outputs: [lockOutWith(a, [{ change, readyAt: w.readyAt }])] }, plan(w)).txHex, outputs(), D), /this announcement added/);
  // Cancel: the announcement kept.
  const c = cancelSpec(D, REFS, LOCK, 0, FX.pp);
  assert.throws(() => readLockTx(lockTx({ ...c, outputs: [lockOutWith(c, old)] }, plan(w)).txHex, outputs(), D), /with #0 removed/);
  // Execute: the announcement kept after it is made.
  const x = execute();
  assert.throws(() => readLockTx(lockTx({ ...x.spec, outputs: [lockOutWith(x.spec, old), x.spec.outputs[1]!] }, plan(x.validity)).txHex, outputs(), D), /with #0 removed/);
  // The lock token sent to the deployer's key instead of the lock.
  const away = lockTx({ ...a, outputs: [lockOutWith(a, [...old, { change, readyAt: w.readyAt }], CSL.Address.from_bech32(FX.deployment.deployer))] }, plan(w));
  assert.throws(() => readLockTx(away.txHex, outputs(), D), /leaves the lock's address/);
  // A Cancel that also spends the pool (its own admin path), or a fee-share withdrawal: never this tool's.
  const poolOut = CSL.TransactionOutput.from_hex(POOL.outputHex);
  const withPool: LockSpec = { ...c, spends: [...c.spends, { utxo: POOL, script: REFS.poolScript!, redeemer: mkConstr(1, [mkConstr(0, [])]) }], reads: [GS], outputs: [...c.outputs, poolOut] };
  assert.throws(() => readLockTx(lockTx(withPool, plan(w)).txHex, outputs(), D), /a Cancel moves no pool/);
  const withdraw: LockSpec = { ...c, spends: [{ ...c.spends[0]!, redeemer: lockRedeemer({ kind: 'WithdrawFeeSharing' }) }], outputs: [lockOutWith(c, old)] };
  assert.throws(() => readLockTx(lockTx(withdraw, plan(w)).txHex, outputs(), D), /fee-share withdrawal/);
  // A withdrawal riding along: a lock transaction withdraws nothing.
  const tx = CSL.Transaction.from_hex(lockTx(c, plan(w)).txHex);
  const body = CSL.TransactionBody.from_hex(tx.body().to_hex());
  const wd = CSL.Withdrawals.new();
  wd.insert(CSL.RewardAddress.new(0, CSL.Credential.from_keyhash(CSL.Ed25519KeyHash.from_hex(FX.deployment.ownerA))), big(0n));
  body.set_withdrawals(wd);
  assert.throws(() => readLockTx(CSL.Transaction.new(body, tx.witness_set()).to_hex(), outputs(), D), /withdraws/);
});

test('refused when read: an Execute past its 14-day window; a GlobalSetting written anywhere but output #0, or unlike its announcement', () => {
  const { spec } = execute();
  const late = lockTx(spec, plan({ start: slotOf(READY + 60_000n), ttl: slotOf(READY + GRACE_MS) + 1n }));
  assert.throws(() => readLockTx(late.txHex, outputs(), D), /past the window/);
  // The SetGlobalSetting Execute of a lock whose one announcement (opening fee 80 ADA) is ready.
  const next = settingChange(settingNow(GS.outputHex), { openingFee: 80_000_000n }, D);
  const lockNow = CSL.TransactionOutput.from_hex(LOCK.outputHex);
  lockNow.set_plutus_data(encodeState([{ change: { kind: 'SetGlobalSetting', setting: next }, readyAt: READY }]));
  const lock2: Utxo = { ref: LOCK.ref, outputHex: lockNow.to_hex() };
  const x = executeSpec(D, REFS, lock2, 0, GS, GS, FX.pp);
  const w = executeWindow(slotOf(READY + 600_000n), 0, READY, 600n);
  readLockTx(lockTx(x, plan(w)).txHex, outputs([lock2]), D);
  const swapped = lockTx({ ...x, outputs: [x.outputs[1]!, x.outputs[0]!] }, plan(w));
  assert.throws(() => readLockTx(swapped.txHex, outputs([lock2]), D), /must be output #0/);
  if (AIKEN) assert.equal(judged(swapped.txHex, [lock2]).ok, false);
  const other = CSL.TransactionOutput.new(x.outputs[0]!.address(), x.outputs[0]!.amount());
  other.set_plutus_data(encodeSetting({ ...next, openingFee: 81_000_000n }));
  const unlike = lockTx({ ...x, outputs: [other, x.outputs[1]!] }, plan(w));
  assert.throws(() => readLockTx(unlike.txHex, outputs([lock2]), D), /GlobalSetting after differs from the announced change/);
  if (AIKEN) assert.equal(judged(unlike.txHex, [lock2]).ok, false);
});

test("refused when read: an Announce moving the pool, a pool spent by another admin path, its reserves changed, no GlobalSetting read", () => {
  const w = announceWindow(slotOf(READY - 3_600_000n), 0, 600n);
  const a = announceSpec(D, REFS, LOCK, poolChange(poolNow(POOL.outputHex), { baseFee: [25n, 25n] }), w.readyAt, FX.pp);
  const withPool: LockSpec = { ...a, spends: [...a.spends, { utxo: POOL, script: REFS.poolScript!, redeemer: mkConstr(1, [mkConstr(0, [])]) }], reads: [GS], outputs: [...a.outputs, CSL.TransactionOutput.from_hex(POOL.outputHex)] };
  assert.throws(() => readLockTx(lockTx(withPool, plan(w)).txHex, outputs(), D), /an Announce moves no pool/);
  const { spec, validity } = execute();
  const poolIx = spec.spends.findIndex((s) => s.utxo.ref === POOL.ref);
  // UpdateDynamicFee where the change takes UpdatePoolFee.
  const dyn: LockSpec = { ...spec, spends: spec.spends.map((s, i) => (i === poolIx ? { ...s, redeemer: mkConstr(1, [mkConstr(1, [])]) } : s)) };
  assert.throws(() => readLockTx(lockTx(dyn, plan(validity)).txHex, outputs(), D), /spent other than by UpdatePoolFee/);
  // The datum's reserve A raised by one, the value the same.
  const po = spec.outputs.find((o) => o.address().payment_cred()?.to_scripthash()?.to_hex() === D.pool)!;
  const f = po.plutus_data()!.as_constr_plutus_data()!.data();
  const fs = Array.from({ length: f.len() }, (_, i) => f.get(i));
  fs[4] = CSL.PlutusData.new_integer(CSL.BigInt.from_str((BigInt(fs[4]!.as_integer()!.to_str()) + 1n).toString()));
  const moved = CSL.TransactionOutput.new(po.address(), po.amount());
  moved.set_plutus_data(mkConstr(0, fs));
  assert.throws(() => readLockTx(lockTx({ ...spec, outputs: spec.outputs.map((o) => (o === po ? moved : o)) }, plan(validity)).txHex, outputs(), D), /reserves, liquidity or batching credential change/);
  // No GlobalSetting read: whose fee-share taker would the share go to?
  assert.throws(() => readLockTx(lockTx({ ...spec, reads: [] }, plan(validity)).txHex, outputs(), D), /reads no GlobalSetting of ours/);
});
