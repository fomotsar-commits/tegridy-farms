import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { test } from 'node:test';
import CSL from '@emurgo/cardano-serialization-lib-nodejs';
import { assertSetting, burnAddress, checkInputs, checkLockReady, checkNothingPending, compiledParams, FLOAT_CAP, globalSetting, lockState, MAINNET_INPUTS, MINSWAP, NAMES, plainFunds, records, REF_ORDER, scriptAddress, scriptsFor, type DeployInputs, type DeployState, type Scripts } from '../src/deploy.ts';
import { parseSettings } from '../src/main.ts';
import { mkBytes, mkConstr, mkList } from '../src/plutus.ts';
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
  for (const k of ['deployer', 'seedTxIn', 'lockSeedTxIn']) assert.equal(raw[k], '', `${k} is left for the run`);
  // The key the batcher on Railway reported as key-found on 2026-11-25, and its address; 2 ADA per order (the owner, 2026-11-24).
  assert.equal(raw.batcherKeyHash, '3e2f5729e981aec203ddb0e15779f706a5e3d833cf5195c887b7767c');
  assert.equal(CSL.EnterpriseAddress.from_address(CSL.Address.from_bech32('addr1vylz74efaxq6assrmkcwz4me7ur2tc7cx084r9wgs7mhvlqyyg6gq'))!.payment_cred().to_keyhash()!.to_hex(), raw.batcherKeyHash);
  assert.equal(raw.batcherFee, '2000000');
  // The code pins the same treasury, scripts and pool stake.
  for (const k of ['treasury', 'treasuryScript', 'treasuryStakeScript', 'poolStake'] as const) assert.deepEqual(raw[k], MAINNET_INPUTS[k], k);
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
  const filled = { ...raw, deployer: WALLET_A, seedTxIn: `${'11'.repeat(32)}#0`, lockSeedTxIn: `${'11'.repeat(32)}#1`, openingFee: BigInt(raw.openingFee) };
  delete filled._pending;
  checkNothingPending(filled);
  checkInputs(filled);
});

// Another valid two-key treasury on mainnet (a stranger's), with both of its scripts.
const OTHER_TREASURY = (() => {
  const k = (n: string) => n.repeat(28);
  const pay = keyScript(k('31'), k('32'));
  const stake = keyScript(k('33'), k('34'));
  const h = (s: string) => CSL.NativeScript.from_hex(s).hash();
  const address = CSL.BaseAddress.new(1, CSL.Credential.from_scripthash(h(pay)), CSL.Credential.from_scripthash(h(stake))).to_address().to_bech32(undefined);
  return { treasury: address, treasuryScript: pay, treasuryStakeScript: stake, poolStake: { type: 'Script' as const, hash: h(stake).to_hex() } };
})();

test("mainnet inputs are pinned: the proven treasury and its stake script, and nothing of Minswap's", () => {
  // Valid on their own (a preprod run would take their shape), refused on mainnet.
  assert.throws(() => checkInputs({ ...BASE, ...OTHER_TREASURY }), /on mainnet the treasury is the venue's proven two-key treasury/);
  assert.throws(() => checkInputs({ ...BASE, poolStake: { type: 'Script', hash: 'ee'.repeat(28) } }), /on mainnet poolStake is the treasury's own stake script/);
  assert.throws(() => checkInputs({ ...BASE, poolStake: { type: 'Key', hash: MAINNET_INPUTS.poolStake.hash } }), /on mainnet poolStake/);
  assert.throws(() => checkInputs({ ...BASE, poolStake: { type: 'Key', hash: MINSWAP.stakeKey } }), /Minswap's stake key/);
  assert.throws(() => checkInputs({ ...BASE, batcherKeyHash: MINSWAP.batchers[0] }), /Minswap's batcher key/);
  // Minswap's are refused on preprod too.
  const pre = { network: 0, deployer: 'addr_test1vqjgm24g2wf6xjn5qux8w7np8tvmtpnfexfvsg8e7dgl8lqspf7sr', treasury: 'addr_test1xr0y9r8zxl9rujfrew5gnxl6430js7tta6q4cm7h6p80fqc3urxc980aqdksn0ljkuvzcus3cfsnyy0zjcq23qtsx6yq8z76re', treasuryScript: '8201828200581c687f4191e716452f679060c5de4befa1eec1193c1017206ab10672bf8200581c9b9f6bc73a6891efbd7e55a14fc416e9bc5aa1cb9f2a906b85b3e1f5', treasuryStakeScript: '8201828200581cf8b9a732621335bb5b9a7996c6045f3362f7ae7a4105cfd1a7eebafa8200581cef8033c95b2c473b4678c624d6d739b7bfe08e1cae28444dab8eb010', poolStake: { type: 'Script' as const, hash: '11e0cd829dfd036d09bff2b7182c7211c2613211e29600a881703688' } };
  checkInputs({ ...BASE, ...pre });
  assert.throws(() => checkInputs({ ...BASE, ...pre, poolStake: { type: 'Key', hash: MINSWAP.stakeKey } }), /Minswap's stake key/);
  assert.throws(() => checkInputs({ ...BASE, ...pre, batcherKeyHash: MINSWAP.batchers[0] }), /Minswap's batcher key/);
});

test('scripts.json records what compile applied, and inputs that differ are refused', () => {
  const json = { scripts: {} as Scripts, params: JSON.parse(JSON.stringify(compiledParams(BASE))) };
  assert.equal(scriptsFor(json, BASE), json.scripts);
  // Not compiled in: may change after compile.
  scriptsFor(json, { ...BASE, openingFee: 80_000_000n, batcherKeyHash: 'ee'.repeat(28), deployer: WALLET_B });
  assert.throws(() => scriptsFor(json, { ...BASE, ...OTHER_TREASURY }), /scripts.json was compiled with treasury "addr1xy6kx/);
  assert.throws(() => scriptsFor(json, { ...BASE, poolStake: { type: 'Script', hash: 'ee'.repeat(28) } }), /compiled with poolStake/);
  for (const k of ['seedTxIn', 'lockSeedTxIn'] as const) assert.throws(() => scriptsFor(json, { ...BASE, [k]: `${'22'.repeat(32)}#0` }), new RegExp(`compiled with ${k}`));
  for (const k of ['ownerA', 'ownerB'] as const) assert.throws(() => scriptsFor(json, { ...BASE, [k]: 'ee'.repeat(28) }), new RegExp(`compiled with ${k}`));
  assert.throws(() => scriptsFor({ scripts: json.scripts }, BASE), /records no parameters/);
});

// Made up: none of these is a script, UTxO or transaction on any network.
const h = (b: string) => ({ hash: b.repeat(28), compiledCode: '' });
const FAKE: Scripts = { authen: h('a1'), globalSetting: h('a1'), pool: h('a2'), poolBatching: h('a3'), order: h('a4'), factory: h('a5'), lock: h('a6'), expiredOrderCancel: { hash: 'c8b0cc61374d409ff9c8512317003e7196a3e4d48553398c656cc124', compiledCode: '' } };
const SIZES: Record<string, number> = { order: 2659, factory: 4049, authen: 5223, pool: 4096, poolBatching: 15589, lock: 6200 };
function done(): DeployState {
  const s: DeployState = { refs: {}, txs: {}, refSizes: {}, openPoolBudget: { factory: { mem: 1_500_000, steps: 500_000_000 }, authen: { mem: 800_000, steps: 300_000_000 } } };
  REF_ORDER.forEach((name, k) => {
    const tx = (k + 1).toString(16).padStart(2, '0').repeat(32);
    s.refs[name] = `${tx}#0`;
    s.txs[`ref-${name}`] = tx;
    s.refSizes[name] = SIZES[name]!;
  });
  return s;
}
const TEMPLATE = JSON.parse(readFileSync(new URL('../deploy/mainnet-inputs.template.json', import.meta.url), 'utf8'));
const MAINNET_RUN: DeployInputs = { ...TEMPLATE, deployer: WALLET_A, seedTxIn: `${'11'.repeat(32)}#0`, lockSeedTxIn: `${'11'.repeat(32)}#1`, openingFee: BigInt(TEMPLATE.openingFee) };
const SITE_RECORD = new URL('./fixtures/site-record.json', import.meta.url);

test("records: the site's whole record (its order script's reference included) and the batcher's float cap, only from a finished deploy", () => {
  checkInputs(MAINNET_RUN);
  const r = records(MAINNET_RUN, FAKE, done(), BigInt(TEMPLATE.batcherFee));
  // The site reads this fixture with its own reader (frontend .../ownPools/deployRecord.test.ts).
  const text = `${JSON.stringify(r.siteRecord, null, 1)}\n`;
  if (process.env.UPDATE_FIXTURES) writeFileSync(SITE_RECORD, text);
  assert.equal(readFileSync(SITE_RECORD, 'utf8'), text, 'records().siteRecord changed: UPDATE_FIXTURES=1 rewrites test/fixtures/site-record.json, which the site test reads');
  assert.deepEqual(r.siteRecord.orderRef, { ref: done().refs.order, scriptSize: SIZES.order });
  assert.equal(r.batcherSettings.floatCap, FLOAT_CAP);
  assert.equal(FLOAT_CAP, '100000000');
  // With the operator's own fields, the batcher takes the settings records() writes.
  const own = { maxOrdersPerBatch: 20, slotsBefore: 60, slotsAfter: 300, quarantineSlots: 3600, maxRefusalsInARow: 5, idleRoundMs: 30_000 };
  assert.equal(parseSettings(JSON.stringify({ ...r.batcherSettings, ...own })).floatCap, 100_000_000n);
  const { floatCap: _cap, ...noCap } = r.batcherSettings;
  assert.throws(() => parseSettings(JSON.stringify({ ...noCap, ...own })), /floatCap/);
});

test('records refuses a reference script whose transaction is not recorded as sent, and a site record with no opening budget', () => {
  const unsent = done();
  delete unsent.txs['ref-order'];
  assert.throws(() => records(MAINNET_RUN, FAKE, unsent, 2_000_000n), /ref-order's transaction [0-9a-f]{64} is not recorded as sent/);
  const other = done();
  other.txs['ref-factory'] = 'ee'.repeat(32);
  assert.throws(() => records(MAINNET_RUN, FAKE, other, 2_000_000n), /ref-factory's transaction .* is not recorded as sent/);
  const missing = done();
  delete missing.refs.lock;
  assert.throws(() => records(MAINNET_RUN, FAKE, missing, 2_000_000n), /lock reference script was never built/);
  const budgetless = done();
  delete budgetless.openPoolBudget;
  assert.throws(() => records(MAINNET_RUN, FAKE, budgetless, 2_000_000n), /no openPoolBudget/);
  const half = done();
  half.openPoolBudget = { factory: { mem: 1_500_000, steps: 0 }, authen: { mem: 800_000, steps: 300_000_000 } };
  assert.throws(() => records(MAINNET_RUN, FAKE, half, 2_000_000n), /no openPoolBudget/);
});

test("the deploy publishes no copy of the expired-order cancel: nothing of ours reads it, and Minswap's is on chain", () => {
  assert.deepEqual([...REF_ORDER], ['order', 'factory', 'authen', 'pool', 'poolBatching', 'lock']);
});

test('init waits for the lock: one UTxO on chain with its token, at its own address, nothing announced', () => {
  const lockAddr = CSL.Address.from_bech32(scriptAddress(1, FAKE.lock.hash));
  const out = (address: CSL.Address, datum: CSL.PlutusData, extra = 0n) => {
    const ma = CSL.MultiAsset.new();
    const as = CSL.Assets.new();
    as.insert(CSL.AssetName.new(Buffer.from(NAMES.lock, 'hex')), CSL.BigNum.from_str((1n + extra).toString()));
    ma.insert(CSL.ScriptHash.from_hex(FAKE.lock.hash), as);
    const o = CSL.TransactionOutput.new(address, CSL.Value.new_with_assets(CSL.BigNum.from_str('2000000'), ma));
    o.set_plutus_data(datum);
    return { ref: `${'77'.repeat(32)}#0`, outputHex: o.to_hex() };
  };
  assert.equal(checkLockReady([out(lockAddr, lockState())], FAKE, 1), `${'77'.repeat(32)}#0`);
  assert.throws(() => checkLockReady([], FAKE, 1), /0 UTxOs on chain hold the lock token/);
  assert.throws(() => checkLockReady([out(lockAddr, lockState()), out(lockAddr, lockState())], FAKE, 1), /2 UTxOs/);
  assert.throws(() => checkLockReady([out(CSL.Address.from_bech32(WALLET_A), lockState())], FAKE, 1), /not at the lock's own address/);
  assert.throws(() => checkLockReady([out(lockAddr, lockState(), 1n)], FAKE, 1), /does not hold exactly one/);
  const announced = mkConstr(0, [mkList([mkConstr(0, [mkBytes('00')])])]);
  assert.throws(() => checkLockReady([out(lockAddr, announced)], FAKE, 1), /does not hold State \{ announced: \[\] \}/);
});
