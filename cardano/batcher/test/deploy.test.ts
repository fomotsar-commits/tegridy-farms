import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import CSL from '@emurgo/cardano-serialization-lib-nodejs';
import { assertSetting, burnAddress, checkInputs, checkNothingPending, globalSetting, plainFunds, type DeployInputs } from '../src/deploy.ts';
import { mkBytes, mkConstr } from '../src/plutus.ts';
import { decodeGlobalSetting } from '../src/types.ts';

// The proven two-key treasury (docs/CARDANO_AUDIT_SCOPE.md) with both of its scripts.
const keyScript = (a: string, b: string) => {
  const p = CSL.NativeScripts.new();
  for (const k of [a, b]) p.add(CSL.NativeScript.new_script_pubkey(CSL.ScriptPubkey.new(CSL.Ed25519KeyHash.from_hex(k))));
  return CSL.NativeScript.new_script_all(CSL.ScriptAll.new(p)).to_hex();
};
const TREASURY = 'addr1xy6kxswfkhnxfwllzcxkqfumhyjedvkvkvlt3p7mhwxwp3spv7vdp6er80lvtdm32cqvvetu93ams9yrggg5pm5tq3usr47kat';
// Owner A's Eternl wallet (mem2): a deployer can be a wallet, signing on the co-signing page.
const WALLET_A = 'addr1qyppzmwvfz5dk6eny849hcsp9390cj7ml769fd00twvct5yk3nxuz23aapvfjckhjndl86jknefaarvky4yxw9njvt0q8f5ref';
const WALLET_B = 'addr1q8axzalz877tpqp9ytsd3v48gkyk6t64u2fmuljfdu0vskugqsplyt0mzmm8avnasxywcm8qq6kmt7feyt8naf65lpaqcgmw0e';
const BASE: DeployInputs = {
  network: 1,
  deployer: WALLET_A,
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
  assert.throws(() => checkInputs({ ...BASE, network: 0, deployer: 'addr_test1vqjgm24g2wf6xjn5qux8w7np8tvmtpnfexfvsg8e7dgl8lqspf7sr' }), /sweep.treasury is not a preprod address/);
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

test("the deployer is an address paid to a key, on the run's network", () => {
  // A key file's enterprise address (preprod's --sign path) is a deployer too.
  checkInputs({ ...BASE, deployer: CSL.EnterpriseAddress.new(1, CSL.Credential.from_keyhash(CSL.Ed25519KeyHash.from_hex('ee'.repeat(28)))).to_address().to_bech32(undefined) });
  assert.throws(() => checkInputs({ ...BASE, deployer: 'addr_test1vqjgm24g2wf6xjn5qux8w7np8tvmtpnfexfvsg8e7dgl8lqspf7sr' }), /deployer is not a mainnet address/);
  assert.throws(() => checkInputs({ ...BASE, deployer: TREASURY }), /paid to a key/);
  assert.throws(() => checkInputs({ ...BASE, deployer: 'not an address' }), /deployer is not an address/);
});

test("inputs still pending the owner's OK are refused", () => {
  checkNothingPending({});
  assert.throws(() => checkNothingPending({ _pending: ['ownerA'] }), /pending the owner's OK \(\["ownerA"\]\)/);
  assert.throws(() => checkNothingPending({ _pending: [] }), /pending/);
});

// Koios address_utxos, as preprod answered it for the rehearsal's deployer on 2026-11-08: the same
// UTxO asked without and with _extended (MEMETEST tokens in it), and a plain-ADA one.
const DEPLOYER = 'addr_test1vqjgm24g2wf6xjn5qux8w7np8tvmtpnfexfvsg8e7dgl8lqspf7sr';
const row = (tx_index: number, value: string, asset_list: unknown) => ({ tx_hash: '6636f96770014ab0cb750f3360757aca03296b0d97aeb2b3740c15d32747cea5', tx_index, address: DEPLOYER, value, datum_hash: null, inline_datum: null, reference_script: null, asset_list });
const TOKENS = [{ decimals: 0, quantity: '500000000000', policy_id: '1ac2931c35f8c8a68b2ccdd2a6b3bcc4d3ac2bc0e7e3e29a7a7ee7d7', asset_name: '4d454d4554455354' }];

test("the deployer's funds are plain ADA only, read with _extended", () => {
  // Without _extended, Koios sends asset_list null for every UTxO: one holding tokens is refused, never taken as plain ADA.
  assert.throws(() => plainFunds([row(2, '9059179069', null)], DEPLOYER, []), /did not say which coins .*#2 holds/);
  const got = plainFunds([row(2, '9059179069', TOKENS), row(1, '500000000', []), { ...row(3, '7000000', []), address: WALLET_A }], DEPLOYER, []);
  assert.deepEqual(got, [{ ref: `${row(1, '', []).tx_hash}#1`, address: DEPLOYER, lovelace: 500_000_000n }]);
  assert.deepEqual(plainFunds([row(1, '500000000', [])], DEPLOYER, [`${row(1, '', []).tx_hash}#1`]), []);
  assert.deepEqual(plainFunds([{ ...row(1, '500000000', []), inline_datum: { bytes: 'd87980' } }], DEPLOYER, []), []);
});

test("the mainnet inputs template: the proven treasury, both owners from their wallets, the owner's picks confirmed", () => {
  const raw = JSON.parse(readFileSync(new URL('../deploy/mainnet-inputs.template.json', import.meta.url), 'utf8'));
  // The owner confirmed ownerA, ownerB and poolStake on 2026-11-08 ("Use your picks"): nothing is pending.
  assert.equal(raw._pending, undefined);
  assert.match(raw._confirmed, /2026-11-08/);
  checkNothingPending(raw);
  for (const k of ['deployer', 'seedTxIn', 'lockSeedTxIn', 'batcherKeyHash']) assert.equal(raw[k], '', `${k} is left for the run`);
  const payKey = (a: string) => CSL.BaseAddress.from_address(CSL.Address.from_bech32(a))!.payment_cred().to_keyhash()!.to_hex();
  assert.equal(raw.ownerA, payKey(WALLET_A));
  assert.equal(raw.ownerB, payKey(WALLET_B));
  const t = CSL.BaseAddress.from_address(CSL.Address.from_bech32(raw.treasury))!;
  assert.equal(CSL.NativeScript.from_hex(raw.treasuryScript).hash().to_hex(), t.payment_cred().to_scripthash()!.to_hex());
  assert.equal(CSL.NativeScript.from_hex(raw.treasuryScript).hash().to_hex(), '356341c9b5e664bbff160d60279bb92596b2ccb33eb887dbbb8ce0c6');
  assert.equal(CSL.NativeScript.from_hex(raw.treasuryStakeScript).hash().to_hex(), t.stake_cred().to_scripthash()!.to_hex());
  assert.deepEqual(raw.poolStake, { type: 'Script', hash: '016798d0eb233bfec5b7715600c6657c2c7bb81483421140ee8b0479' });
  assert.equal(raw.poolStake.hash, CSL.NativeScript.from_hex(raw.treasuryStakeScript).hash().to_hex());
  assert.equal(raw.openingFee, '73000000');
  assert.equal(raw.network, 1);
  const filled = { ...raw, deployer: WALLET_A, seedTxIn: `${'11'.repeat(32)}#0`, lockSeedTxIn: `${'11'.repeat(32)}#1`, batcherKeyHash: 'cc'.repeat(28), openingFee: BigInt(raw.openingFee) };
  delete filled._pending;
  checkNothingPending(filled);
  checkInputs(filled);
});
