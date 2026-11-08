// Deploys our pools (src/deploy.ts), one step at a time, each step's transaction written to
// <out>/<step>.tx.json (cardano-cli's text envelope) before anything is signed:
//   AIKEN=<aiken 1.0.24> node scripts/deploy.ts compile <inputs.json> <out>
//   node scripts/deploy.ts <lock|init|refs|register> <inputs.json> <out> [--sign <a.skey,b.skey>] [--submit]
//   node scripts/deploy.ts records <inputs.json> <out>
// Chain: OGMIOS_URL (protocol parameters, evaluation, submission), KOIOS_URL (the deployer's
// UTxOs). --sign takes key files and is for preprod's throwaway keys: on mainnet the owner signs
// the written transaction with their own wallets and keys, and submits it themselves.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import CSL from '@emurgo/cardano-serialization-lib-nodejs';
import { budgetsFromOgmios, protocolParams, rpc, submit, type Endpoint } from '../src/ogmios.ts';
import { keyFromFile } from '../src/signer.ts';
import { REF_ORDER, addresses, checkInputs, initTx, lockTx, records, refTx, registerTx, type Built, type DeployInputs, type Scripts, type TxPlan, type Utxo } from '../src/deploy.ts';

const [cmd, inputsPath, outArg] = process.argv.slice(2);
const flag = (f: string) => {
  const at = process.argv.indexOf(f);
  return at < 0 ? undefined : (process.argv[at + 1] ?? '');
};
if (!cmd || !inputsPath || !outArg) throw new Error('usage: node scripts/deploy.ts <compile|lock|init|refs|register|records> <inputs.json> <out> [--sign a.skey,b.skey] [--submit]');
const out: string = outArg;
const raw = JSON.parse(readFileSync(inputsPath, 'utf8'));
const inputs: DeployInputs & { deployer: string; batcherFee: string } = { ...raw, openingFee: BigInt(raw.openingFee) };
checkInputs(inputs);
mkdirSync(out, { recursive: true });
const statePath = join(out, 'state.json');
const state: { refs: Record<string, string>; txs: Record<string, string>; locked: Record<string, string>; fees: Record<string, string>; refSizes: Record<string, number> } = existsSync(statePath)
  ? JSON.parse(readFileSync(statePath, 'utf8'))
  : { refs: {}, txs: {}, locked: {}, fees: {}, refSizes: {} };
const save = () => writeFileSync(statePath, `${JSON.stringify(state, null, 1)}\n`);

if (cmd === 'compile') {
  const { compileDeployment } = await import('./deploy-compile.mjs');
  const c = compileDeployment(inputs);
  writeFileSync(join(out, 'scripts.json'), `${JSON.stringify(c, null, 1)}\n`);
  for (const [k, s] of Object.entries(c.scripts as Scripts)) console.log(`${k}: ${s.hash} (${s.compiledCode.length / 2} bytes)`);
  console.log(JSON.stringify(addresses(inputs, c.scripts), null, 1));
  process.exit(0);
}

const scripts: Scripts = JSON.parse(readFileSync(join(out, 'scripts.json'), 'utf8')).scripts;
if (cmd === 'records') {
  const r = records(inputs, scripts, state.refs, { batcherFee: BigInt(inputs.batcherFee), refSizes: state.refSizes });
  console.log(JSON.stringify({ ...r, txs: state.txs, locked: state.locked, fees: state.fees }, null, 1));
  process.exit(0);
}

const ogmios: Endpoint = { url: process.env.OGMIOS_URL ?? '', timeoutMs: 60_000 };
const koios = process.env.KOIOS_URL ?? '';
if (!ogmios.url || !koios) throw new Error('set OGMIOS_URL and KOIOS_URL');
const pp = await protocolParams(ogmios);

/** The deployer's plain-ADA UTxOs, but `exclude` (a seed another step spends). */
async function funds(exclude: string[]): Promise<Utxo[]> {
  const r = await fetch(`${koios}/address_utxos`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' }, body: JSON.stringify({ _addresses: [inputs.deployer] }) });
  if (!r.ok) throw new Error(`Koios answered ${r.status}: the deployer's UTxOs could not be read`);
  const rows = (await r.json()) as { tx_hash: string; tx_index: number; value: string; asset_list: unknown[]; reference_script: unknown; datum_hash: unknown; inline_datum: unknown }[];
  return rows
    .filter((u) => !u.asset_list?.length && !u.reference_script && !u.datum_hash && !u.inline_datum)
    .map((u) => ({ ref: `${u.tx_hash}#${u.tx_index}`, address: inputs.deployer, lovelace: BigInt(u.value) }))
    .filter((u) => !exclude.includes(u.ref));
}

/** Built once with a generous draft budget, judged by the node, built again with what it measured. */
async function judged(make: (plan: TxPlan) => Built, plan: TxPlan, plutus: boolean): Promise<Built> {
  const draft = make(plan);
  if (!plutus) return draft;
  const budgets = budgetsFromOgmios(await rpc(ogmios, 'evaluateTransaction', { transaction: { cbor: draft.txHex } }));
  const b = make({ ...plan, budgets: new Map(budgets.map((x) => [`${x.tag}:${x.index}`, { mem: x.mem, steps: x.steps }])) });
  for (const x of budgets) console.log(`  ${x.tag}:${x.index} ${x.mem} memory, ${x.steps} steps`);
  return b;
}

async function finish(step: string, b: Built) {
  writeFileSync(join(out, `${step}.tx.json`), `${JSON.stringify({ type: 'Tx ConwayEra', description: `memetics.finance pools deploy: ${step}`, cborHex: b.txHex }, null, 1)}\n`);
  console.log(`${step}: ${b.txId}, fee ${b.fee} lovelace, written to ${join(out, `${step}.tx.json`)}`);
  for (const [k, v] of Object.entries(b.locked)) state.locked[`${step}:${k}`] = v.toString();
  state.fees[step] = b.fee.toString();
  const keys = flag('--sign');
  if (keys === undefined) return save();
  if (inputs.network === 1) throw new Error('--sign is for preprod only: on mainnet the owner signs with their own keys');
  const tx = CSL.FixedTransaction.from_hex(b.txHex);
  for (const k of keys.split(',')) tx.sign_and_add_vkey_signature(keyFromFile(k));
  writeFileSync(join(out, `${step}.signed.tx.json`), `${JSON.stringify({ type: 'Tx ConwayEra', description: step, cborHex: tx.to_hex() }, null, 1)}\n`);
  if (process.argv.includes('--submit')) {
    const id = await submit(ogmios, tx.to_hex());
    if (id !== b.txId) throw new Error(`the node took ${id}, not ${b.txId}`);
    state.txs[step] = id;
    console.log(`  submitted ${id}`);
  }
  save();
}

const plan = (f: Utxo[]): TxPlan => ({ pp, funds: f, change: inputs.deployer, network: inputs.network });
if (cmd === 'lock') {
  const f = await funds([inputs.seedTxIn]);
  await finish('lock', await judged((p) => lockTx(inputs, scripts, p), plan(f), true));
} else if (cmd === 'init') {
  const f = await funds([inputs.lockSeedTxIn]);
  await finish('init', await judged((p) => initTx(inputs, scripts, p), plan(f), true));
} else if (cmd === 'refs') {
  // Minswap's: one script per transaction, each spending the one before's change.
  let f = await funds([inputs.seedTxIn, inputs.lockSeedTxIn]);
  for (const name of REF_ORDER) {
    if (state.refs[name]) continue;
    const b = refTx(inputs, name, scripts, plan(f));
    await finish(`ref-${name}`, b);
    state.refs[name] = b.outputs[name]!;
    state.refSizes[name] = scripts[name].compiledCode.length / 2;
    save();
    const change = CSL.Transaction.from_hex(b.txHex).body().outputs().get(1);
    f = [{ ref: b.outputs.change!, address: inputs.deployer, lovelace: BigInt(change.amount().coin().to_str()) }];
  }
} else if (cmd === 'register') {
  const f = await funds([inputs.seedTxIn, inputs.lockSeedTxIn]);
  await finish('register', registerTx(scripts, plan(f)));
} else throw new Error(`unknown step ${cmd}`);
