import assert from 'node:assert/strict';
import { test } from 'node:test';
import CSL from '@emurgo/cardano-serialization-lib-nodejs';
import { assertSetting, burnAddress, checkInputs, globalSetting, type DeployInputs } from '../src/deploy.ts';
import { mkBytes, mkConstr } from '../src/plutus.ts';
import { decodeGlobalSetting } from '../src/types.ts';

// The proven two-key treasury (docs/CARDANO_AUDIT_SCOPE.md) with both of its scripts.
const keyScript = (a: string, b: string) => {
  const p = CSL.NativeScripts.new();
  for (const k of [a, b]) p.add(CSL.NativeScript.new_script_pubkey(CSL.ScriptPubkey.new(CSL.Ed25519KeyHash.from_hex(k))));
  return CSL.NativeScript.new_script_all(CSL.ScriptAll.new(p)).to_hex();
};
const TREASURY = 'addr1xy6kxswfkhnxfwllzcxkqfumhyjedvkvkvlt3p7mhwxwp3spv7vdp6er80lvtdm32cqvvetu93ams9yrggg5pm5tq3usr47kat';
const BASE: DeployInputs = {
  network: 1,
  seedTxIn: `${'11'.repeat(32)}#0`,
  lockSeedTxIn: `${'11'.repeat(32)}#1`,
  ownerA: 'aa'.repeat(28),
  ownerB: 'bb'.repeat(28),
  batcherKeyHash: 'cc'.repeat(28),
  treasury: TREASURY,
  treasuryScript: keyScript('47901a27b081437abaeb2e6a16762388f68f3eb40de056a529e9dc39', '063f7b2abbf1cb581516c5b4a78929a118752cc3672c10709bb8bc21'),
  treasuryStakeScript: keyScript('a91f2db69b8b44ef8355a53e648d052680d009c70d07bc9017292b5a', 'f9824d0d357d21b5b12b1b83e0d1f567d6076aa74481cb1741f0be7c'),
  poolStake: { type: 'Script', hash: '016798d0eb233bfec5b7715600c6657c2c7bb81483421140ee8b0479' },
  openingFee: 73_000_000n,
};
const LOCK = 'dd'.repeat(28);

test('the proven treasury and two distinct owner keys are accepted', () => {
  checkInputs(BASE);
});

test('refused inputs', () => {
  assert.throws(() => checkInputs({ ...BASE, ownerB: BASE.ownerA }), /two different owner keys/);
  assert.throws(() => checkInputs({ ...BASE, lockSeedTxIn: BASE.seedTxIn }), /two different UTxOs/);
  assert.throws(() => checkInputs({ ...BASE, batcherKeyHash: BASE.ownerA }), /must not be an owner key/);
  assert.throws(() => checkInputs({ ...BASE, openingFee: -1n }), /negative/);
  assert.throws(() => checkInputs({ ...BASE, network: 0 }), /mainnet/);
  assert.throws(() => checkInputs({ ...BASE, poolStake: { type: 'Key', hash: 'zz' } }), /28-byte hash/);
});

test('the first GlobalSetting has eight fields, as the batcher reads ours', () => {
  const d = globalSetting(BASE, LOCK);
  assertSetting(d, BASE, LOCK);
  const gs = decodeGlobalSetting(d, 'ours');
  assert.deepEqual(gs.batchers, [{ kind: 'signature', hash: BASE.batcherKeyHash }]);
  assert.equal(gs.poolCreation?.fee, 73_000_000n);
  assert.throws(() => decodeGlobalSetting(d, 'minswap'));
});

test('a setting paying the opening fee elsewhere, or another amount, is refused', () => {
  const other = { ...BASE, treasury: 'addr1q9d34spgg2kdy47n82e7x9pdd6vql6d2engxmpj20jmhuc2047yqd4xnh7u6u5jp4t0q3fkxzckph4tgnzvamlu7k5psuahzcp' };
  assert.throws(() => assertSetting(globalSetting(other, LOCK), BASE, LOCK), /receiver is not the lock's treasury/);
  assert.throws(() => assertSetting(globalSetting({ ...BASE, openingFee: 1n }, LOCK), BASE, LOCK), /opening fee/);
  assert.throws(() => assertSetting(globalSetting({ ...BASE, batcherKeyHash: 'ee'.repeat(28) }, LOCK), BASE, LOCK), /batcher key/);
  assert.throws(() => assertSetting(globalSetting(BASE, 'ee'.repeat(28)), BASE, LOCK), /is not the lock/);
});

test('a role set to a signature, not the lock, is refused', () => {
  const d = globalSetting(BASE, LOCK).as_constr_plutus_data()!;
  const f = d.data();
  const fields = CSL.PlutusList.new();
  for (let k = 0; k < f.len(); k++) fields.add(k === 5 ? mkConstr(0, [mkBytes(LOCK)]) : f.get(k));
  assert.throws(() => assertSetting(CSL.PlutusData.new_constr_plutus_data(CSL.ConstrPlutusData.new(CSL.BigNum.zero(), fields)), BASE, LOCK), /role 5 is not the lock/);
});

test("the reference scripts go where Minswap's went: a payment key hash of 28 zero bytes", () => {
  const a = CSL.EnterpriseAddress.from_address(CSL.Address.from_bech32(burnAddress(1)))!;
  assert.equal(a.payment_cred().to_keyhash()!.to_hex(), '00'.repeat(28));
});
