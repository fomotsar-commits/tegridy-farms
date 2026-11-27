// The co-signing page reads each deploy step from its own bytes (cosign/review.ts readDeployStep),
// against scripts.json and the inputs, and refuses anything a step is not for: the bytes the owner
// signs, not the inputs they were built from. Each step is built by src/deploy.ts, as deploy.ts
// builds it; each refused case is that step with one thing changed. Also the page's order, and a
// batcher that is not ours named as such.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import CSL from '@emurgo/cardano-serialization-lib-nodejs';
import { readDeployStep, Refused, runOrder } from '../cosign/review.ts';
import type { ProtocolParams } from '../src/build.ts';
import { initTx, lockTx, REF_ORDER, refTx, registerTx, type DeployInputs, type Scripts, type TxPlan } from '../src/deploy.ts';
import { changeWords, checkBatchers, settingNow, type LockDeployment, type Setting } from '../src/lock.ts';

const FX = JSON.parse(readFileSync(new URL('./fixtures/lock-preprod.json', import.meta.url), 'utf8')) as { pp: ProtocolParams; inputs: Record<string, unknown> & { deployer: string } };
const DEP = (JSON.parse(readFileSync(new URL('./fixtures/test-deployment.json', import.meta.url), 'utf8')) as { scripts: Record<string, { hash: string; compiledCode: string }> }).scripts;
/** Stand-in scripts: bytes no one runs here, hashed as the ledger hashes a Plutus V2 script. */
const made = (hex: string) => ({ compiledCode: hex, hash: CSL.PlutusScript.new_v2(Buffer.from(hex, 'hex')).hash().to_hex() });
const S = { ...DEP, factory: made('4e4d01000033222220051200120011'), lock: made('4e4d01000033222220051200120012') } as Scripts;
const key = () => CSL.PrivateKey.generate_ed25519().to_public().hash().to_hex();
const I: DeployInputs = { ...(FX.inputs as unknown as DeployInputs), batcherKeyHash: key(), openingFee: 73_000_000n };
const STRANGER = key();
const plan = (i: DeployInputs = I): TxPlan => ({
  pp: FX.pp,
  funds: [i.seedTxIn, i.lockSeedTxIn, `${'99'.repeat(32)}#0`].map((ref) => ({ ref, address: i.deployer, lovelace: 200_000_000n })),
  change: i.deployer,
  network: 0,
});
const refused = (step: string, hex: string, why: RegExp) => assert.throws(() => readDeployStep(step, hex, S, I), (e: unknown) => e instanceof Refused && why.test(e.message), `${step}: ${why}`);

test('each deploy step, as deploy.ts builds it, reads in plain words; the first GlobalSetting in full', () => {
  const lock = readDeployStep('lock', lockTx(I, S, plan()).txHex, S, I);
  assert.match(lock.join('\n'), new RegExp(`mints the lock token once \\(policy ${S.lock.hash}`));
  assert.match(lock.join('\n'), /nothing announced/);
  const init = readDeployStep('init', initTx(I, S, plan()).txHex, S, I).join('\n');
  assert.match(init, new RegExp(`batcher: key ${I.batcherKeyHash}, our batcher key`));
  assert.match(init, new RegExp(`dynamic-fee updater: all the lock, script ${S.lock.hash}`));
  assert.ok(init.includes(`opening fee: 73 ADA (73000000 lovelace), paid to the treasury ${I.treasury}`), init);
  for (const name of REF_ORDER) assert.match(readDeployStep(`ref-${name}`, refTx(I, name, S, plan()).txHex, S, I).join('\n'), new RegExp(`publishes the ${name} script ${S[name].hash}`));
  assert.match(readDeployStep('register', registerTx(S, plan()).txHex, S, I).join('\n'), new RegExp(`registers the pool-batching script's reward account .* \\(script ${S.poolBatching.hash}\\)`));
});

test('init is refused unless its bytes hand every role to the lock, our batcher, the fee to the treasury', () => {
  // CertiK's MIN-01: the first GlobalSetting is checked by no one on chain.
  refused('init', initTx(I, { ...S, lock: made('4e4d01000033222220051200120013') }, plan()).txHex, /is not the lock/);
  refused('init', initTx({ ...I, batcherKeyHash: STRANGER }, S, plan()).txHex, /batchers are not exactly our batcher key/);
  refused('init', initTx({ ...I, openingFee: 0n }, S, plan()).txHex, /opening fee is 0 lovelace, not the inputs' 73000000/);
  refused('init', initTx({ ...I, treasury: I.deployer }, S, plan()).txHex, /not the treasury/);
  refused('init', initTx(I, { ...S, factory: made('4e4d01000033222220051200120014') }, plan()).txHex, /the factory token goes to/);
  refused('init', initTx(I, { ...S, authen: DEP.pool!, globalSetting: DEP.pool! }, plan()).txHex, /does not mint exactly the factory token and the GlobalSetting token/);
  const elsewhere = { ...I, seedTxIn: `${'98'.repeat(32)}#0` };
  refused('init', initTx(elsewhere, S, plan(elsewhere)).txHex, /does not spend the authen seed/);
});

test('the lock, the reference scripts and the registration are refused unless they are exactly what scripts.json names', () => {
  refused('lock', lockTx(I, { ...S, lock: made('4e4d01000033222220051200120013') }, plan()).txHex, /does not mint exactly one lock token under the lock's policy/);
  refused('lock', lockTx({ ...I, ownerB: STRANGER }, S, plan()).txHex, /required signers are not exactly the two owners/);
  refused('ref-order', refTx(I, 'pool', S, plan()).txHex, /is not scripts.json's order/);
  refused('register', registerTx({ ...S, poolBatching: DEP.order! }, plan()).txHex, /legacy registration of the pool-batching script/);
  refused('ref-expiredOrderCancel', refTx(I, 'order', S, plan()).txHex, /not a step of the deploy/);
  // The same reference-script transaction, paying a stranger as well.
  const tx = CSL.Transaction.from_hex(refTx(I, 'order', S, plan()).txHex);
  const outs = tx.body().outputs();
  outs.add(CSL.TransactionOutput.new(CSL.EnterpriseAddress.new(0, CSL.Credential.from_keyhash(CSL.Ed25519KeyHash.from_hex(STRANGER))).to_address(), CSL.Value.new(CSL.BigNum.from_str('5000000'))));
  const body = CSL.TransactionBody.new_tx_body(tx.body().inputs(), outs, tx.body().fee());
  refused('ref-order', CSL.Transaction.new(body, CSL.TransactionWitnessSet.new()).to_hex(), /output #2 pays addr_test1.* and is not the deployer's plain change/);
});

test('the page lists the deploy in the order it runs, then lock changes by name', () => {
  assert.deepEqual(runOrder(['register', 'ref-pool', 'lock-announce-1', 'init', 'ref-lock', 'lock', 'ref-order', 'ref-authen', 'ref-factory', 'ref-poolBatching', 'lock-cancel-2']), [
    'lock', 'init', 'ref-order', 'ref-factory', 'ref-authen', 'ref-pool', 'ref-poolBatching', 'ref-lock', 'register', 'lock-announce-1', 'lock-cancel-2',
  ]);
});

test("a setting change naming any batcher but ours is refused, and the page says which one is NOT our batcher key", () => {
  const D: LockDeployment = { network: 0, lock: S.lock.hash, authen: S.authen.hash, pool: S.pool.hash, ownerA: I.ownerA, ownerB: I.ownerB, treasury: I.treasury, batcher: I.batcherKeyHash };
  const gs = CSL.TransactionOutput.from_hex(CSL.Transaction.from_hex(initTx(I, S, plan()).txHex).body().outputs().get(1).to_hex());
  const now: Setting = settingNow(gs.to_hex());
  checkBatchers(now, I.batcherKeyHash);
  const added: Setting = { ...now, batchers: [...now.batchers, { kind: 'signature', hash: STRANGER }] };
  assert.throws(() => checkBatchers(added, I.batcherKeyHash), new RegExp(`signature ${STRANGER}, NOT our batcher key ${I.batcherKeyHash}`));
  assert.throws(() => checkBatchers({ ...now, batchers: [{ kind: 'spendScript', hash: I.batcherKeyHash }] }, I.batcherKeyHash), /NOT our batcher key/);
  const words = changeWords({ kind: 'SetGlobalSetting', setting: added }, now, D).join('\n');
  assert.ok(words.includes(`signature ${I.batcherKeyHash}, signature ${STRANGER} (NOT our batcher key)`), words);
  assert.ok(!words.includes(`${I.batcherKeyHash} (NOT`), words);
});
