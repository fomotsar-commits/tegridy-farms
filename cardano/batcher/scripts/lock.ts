// Changes through the 48-hour role lock (src/lock.ts), and the withdrawal of a pool's venue fee
// share to the treasury, written UNSIGNED to <out>/lock-<what>-<n>.tx.json for the co-signing
// page (scripts/cosign.ts), which reads each one in plain words and gets every signature from
// the owners' own wallets. This script signs and submits nothing. Each transaction is judged by
// the node (Ogmios evaluateTransaction) and read back with the page's own reading before it is
// written.
//   node scripts/lock.ts show <inputs.json> <out>
//   node scripts/lock.ts announce <inputs.json> <out> --pool <A>,<B> [--fee-share <n>|off] [--base-fee <a>/<b>] [--dynamic-fee on|off] [--stake key:<hash>|script:<hash>|none]
//   node scripts/lock.ts announce <inputs.json> <out> --setting [--opening-fee <lovelace>] [--batchers <hash>,<hash>]
//   node scripts/lock.ts execute <inputs.json> <out> --index <n> [the change's flags, checked against the announced one] [--simulate]
//   node scripts/lock.ts cancel <inputs.json> <out> --index <n>
//   node scripts/lock.ts withdraw <inputs.json> <out> --pool <A>,<B>
// Assets: "ada", or "<policy hex>.<name hex>". --valid-for <minutes> (default 120, at most 720):
// how long the owners have to sign and send it. An Announce is ready 48 hours after that. A
// withdrawal waits for nothing: it takes the pool's whole earned share to the inputs' treasury.
// --simulate (execute only): the Execute dated just after ready_at, judged offline by Aiken
// (AIKEN=<aiken 1.0.24>) with the network's slot times, written as a .draft (never signable).
// <out> is deploy.ts's: scripts.json and state.json (the reference scripts) name the lock, the pool
// and the GlobalSetting. Chain: KOIOS_URL (UTxOs), OGMIOS_URL (tip, parameters, the judge); both
// must answer with the inputs' network.
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import CSL from '@emurgo/cardano-serialization-lib-nodejs';
import { checkMagic } from '../cosign/review.ts';
import { checkInputs, checkNothingPending, NAMES, plainFunds, type DeployInputs, type Scripts } from '../src/deploy.ts';
import { Koios } from '../src/koios.ts';
import {
  GRACE_MS,
  SLACK_MS,
  announceSpec,
  announceWindow,
  cancelSpec,
  decodeState,
  executeSpec,
  executeWindow,
  LockRefused,
  lockTx,
  matchesAnnounced,
  poolChange,
  poolNow,
  readLockTx,
  settingChange,
  settingNow,
  shareOf,
  summary,
  timeOf,
  utc,
  withdrawSpec,
  type Change,
  type LockDeployment,
  type LockPlan,
  type LockRefs,
  type LockSpec,
  type PoolAsk,
  type SettingAsk,
} from '../src/lock.ts';
import { budgetsFromOgmios, OgmiosError, protocolParams, rpc, tip, type Endpoint } from '../src/ogmios.ts';
import type { Utxo } from '../src/plan.ts';
import { simulate } from '../src/simulate.ts';
import { slotToPosixMs } from '../src/chain.ts';
import type { Asset, Credential } from '../src/types.ts';
import { lpAssetName } from '../src/verify.ts';

const [cmd, inputsPath, outArg] = process.argv.slice(2);
if (!cmd || !inputsPath || !outArg) throw new Error('usage: node scripts/lock.ts <show|announce|execute|cancel|withdraw> <inputs.json> <out> [flags]');
const out: string = outArg;
const has = (f: string) => process.argv.includes(f);
const flag = (f: string) => {
  const at = process.argv.indexOf(f);
  return at < 0 ? undefined : (process.argv[at + 1] ?? '');
};
const raw = JSON.parse(readFileSync(inputsPath, 'utf8'));
checkNothingPending(raw);
const inputs: DeployInputs = { ...raw, openingFee: BigInt(raw.openingFee) };
checkInputs(inputs);
const network = inputs.network as 0 | 1;
const scripts: Scripts = JSON.parse(readFileSync(join(out, 'scripts.json'), 'utf8')).scripts;
const state = JSON.parse(readFileSync(join(out, 'state.json'), 'utf8')) as { refs: Record<string, string>; txs: Record<string, string> };
const d: LockDeployment = { network, lock: scripts.lock.hash, authen: scripts.authen.hash, pool: scripts.pool.hash, ownerA: inputs.ownerA, ownerB: inputs.ownerB, treasury: inputs.treasury };

const koiosUrl = process.env.KOIOS_URL ?? '';
const ogmios: Endpoint = { url: process.env.OGMIOS_URL ?? '', timeoutMs: 60_000 };
if (!koiosUrl || !ogmios.url) throw new Error('set KOIOS_URL and OGMIOS_URL');
const koios = new Koios({ url: koiosUrl, time: timeOf(network) });

// Both sources must be on the inputs' network before anything they say is used.
const g = await (await fetch(`${koiosUrl}/genesis`, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(30_000) })).json() as { networkmagic?: unknown }[];
checkMagic(g[0]?.networkmagic, network, `Koios (${koiosUrl})`);
checkMagic(((await rpc(ogmios, 'queryNetwork/genesisConfiguration', { era: 'shelley' })) as { networkMagic?: unknown })?.networkMagic, network, `Ogmios (${ogmios.url})`);

const holdsOne = (u: Utxo, policy: string, name: string) => (CSL.TransactionOutput.from_hex(u.outputHex).amount().multiasset()?.get_asset(CSL.ScriptHash.from_hex(policy), CSL.AssetName.new(Buffer.from(name, 'hex')))?.to_str() ?? '0') === '1';
async function only(what: string, us: Utxo[]): Promise<Utxo> {
  if (us.length !== 1) throw new LockRefused(`${us.length} UTxOs hold ${what}, not one`);
  return us[0]!;
}
const lock = await only('the lock token', await koios.utxosWithAsset(d.lock, NAMES.lock, d.lock));
const setting = await only('the GlobalSetting token', await koios.utxosWithAsset(d.authen, NAMES.globalSetting, d.authen));
const announced = decodeState(CSL.TransactionOutput.from_hex(lock.outputHex).plutus_data()!);
const t = await tip(ogmios);
const now = slotToPosixMs(t.slot, timeOf(network));

if (cmd === 'show') {
  console.log(`the lock ${lock.ref} on ${network === 1 ? 'mainnet' : 'preprod'}, the chain's time ${utc(now)}: ${announced.length} announced`);
  announced.forEach((a, i) => {
    const status = now < a.readyAt ? `waiting, ready ${utc(a.readyAt)}` : now > a.readyAt + GRACE_MS ? `CLOSED ${utc(a.readyAt + GRACE_MS)}: cancel it` : `READY until ${utc(a.readyAt + GRACE_MS)}`;
    console.log(`  #${i}: ${summary(a.change)}; ${status}`);
  });
} else await build();

/** Announce, Execute or Cancel: built, judged, read back, written. (No process.exit: on Windows it crashes with sockets open.) */
async function build(): Promise<void> {

// ---- what is asked ----
function asset(s: string): Asset {
  if (s.toLowerCase() === 'ada') return { policyId: '', assetName: '' };
  const m = /^([0-9a-f]{56})\.([0-9a-f]{0,64})$/.exec(s);
  if (!m) throw new LockRefused(`${s}: an asset is "ada" or "<policy hex>.<name hex>"`);
  return { policyId: m[1]!, assetName: m[2]! };
}
const cmpAsset = (x: Asset, y: Asset) => (x.policyId + x.assetName < y.policyId + y.assetName ? -1 : 1);
function stakeArg(s: string): Credential | null {
  if (s === 'none') return null;
  const m = /^(key|script):([0-9a-f]{56})$/.exec(s);
  if (!m) throw new LockRefused(`--stake ${s}: key:<hash>, script:<hash> or none`);
  return { kind: m[1] as 'key' | 'script', hash: m[2]! };
}
function poolAsk(): PoolAsk {
  const ask: PoolAsk = {};
  const share = flag('--fee-share');
  if (share !== undefined) ask.feeSharing = share === 'off' ? null : BigInt(share);
  const fee = flag('--base-fee');
  if (fee !== undefined) {
    const m = /^(\d+)\/(\d+)$/.exec(fee);
    if (!m) throw new LockRefused('--base-fee <a>/<b>, in 10000ths');
    ask.baseFee = [BigInt(m[1]!), BigInt(m[2]!)];
  }
  const dyn = flag('--dynamic-fee');
  if (dyn !== undefined) ask.allowDynamicFee = dyn === 'on' ? true : dyn === 'off' ? false : (() => { throw new LockRefused('--dynamic-fee on|off'); })();
  const stake = flag('--stake');
  if (stake !== undefined) ask.stake = stakeArg(stake);
  return ask;
}
function settingAsk(): SettingAsk {
  const ask: SettingAsk = {};
  const fee = flag('--opening-fee');
  if (fee !== undefined) ask.openingFee = BigInt(fee);
  const b = flag('--batchers');
  if (b !== undefined) ask.batchers = b.split(',').map((h) => {
    if (!/^[0-9a-f]{56}$/.test(h)) throw new LockRefused(`--batchers: ${h} is not a key hash`);
    return { kind: 'signature' as const, hash: h };
  });
  return ask;
}
async function poolOf(a: Asset, b: Asset): Promise<Utxo> {
  const [x, y] = [a, b].sort(cmpAsset) as [Asset, Asset];
  const pools = (await koios.utxosWithAsset(d.authen, lpAssetName(x, y), d.pool)).filter((u) => holdsOne(u, d.authen, NAMES.pool));
  return only(`the pool token of ${x.policyId || 'ada'}.${x.assetName} / ${y.policyId}.${y.assetName}`, pools);
}
const asksPool = ['--fee-share', '--base-fee', '--dynamic-fee', '--stake'].some(has);
const asksSetting = ['--opening-fee', '--batchers'].some(has);

// ---- the parts every lock transaction needs ----
const refUtxo = async (name: string) => only(`the ${name} reference script`, await koios.utxos([state.refs[name] ?? '']));
const refs: LockRefs = { lockScript: await refUtxo('lock'), poolScript: await refUtxo('pool'), settingScript: await refUtxo('authen') };
const pp = await protocolParams(ogmios);
const fundsRes = await fetch(`${koiosUrl}/address_utxos`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' }, body: JSON.stringify({ _addresses: [inputs.deployer], _extended: true }) });
if (!fundsRes.ok) throw new Error(`Koios answered ${fundsRes.status}: the deployer's UTxOs could not be read`);
const plain = plainFunds(await fundsRes.json(), inputs.deployer, []).sort((x, y) => (x.lovelace > y.lovelace ? -1 : 1));
if (!plain.length || plain[0]!.lovelace < 10_000_000n) throw new LockRefused('the deployer needs one plain-ADA UTxO of at least 10 ADA (the fee, and 5 ADA pledged as collateral)');
const [fund] = await koios.utxos([plain[0]!.ref]);
if (!fund) throw new LockRefused(`${plain[0]!.ref} is gone`);
const validFor = BigInt(flag('--valid-for') ?? '120') * 60n;
if (validFor < 600n || validFor > 43_200n) throw new LockRefused('--valid-for is 10 to 720 minutes');

// An unsent lock transaction in <out> already spending this lock UTxO: send or delete it first.
const sent = new Set(Object.values(state.txs ?? {}));
for (const f of readdirSync(out).filter((f) => /^lock-.*\.tx\.json$/.test(f) && !/\.(signed|draft)\.tx\.json$/.test(f))) {
  const hex = (JSON.parse(readFileSync(join(out, f), 'utf8')) as { cborHex: string }).cborHex;
  const tx = CSL.FixedTransaction.from_hex(hex);
  const ins = tx.body().inputs();
  const spends = Array.from({ length: ins.len() }, (_, i) => `${ins.get(i).transaction_id().to_hex()}#${ins.get(i).index()}`);
  if (!sent.has(tx.transaction_hash().to_hex()) && spends.includes(lock.ref)) throw new LockRefused(`${f} (unsent) already spends the lock ${lock.ref}: send it through the page, or delete it, before writing another`);
}

const index = () => {
  const i = Number(flag('--index'));
  if (!Number.isInteger(i) || i < 0) throw new LockRefused('--index <n>: the announcement, as `show` numbers it');
  return i;
};

let spec: LockSpec;
let validity: { start: bigint; ttl: bigint };
let current: { pool?: string; setting?: string } = { setting: setting.outputHex };
const extra: Utxo[] = [];
if (cmd === 'announce') {
  let change: Change;
  if (has('--setting')) {
    if (asksPool) throw new LockRefused('a pool flag with --setting: announce them apart');
    change = { kind: 'SetGlobalSetting', setting: settingChange(settingNow(setting.outputHex), settingAsk(), d) };
  } else {
    const p = (flag('--pool') ?? '').split(',');
    if (p.length !== 2) throw new LockRefused('--pool <A>,<B> (or --setting)');
    if (asksSetting) throw new LockRefused('a setting flag with --pool: announce them apart');
    const pool = await poolOf(asset(p[0]!), asset(p[1]!));
    change = poolChange(poolNow(pool.outputHex), poolAsk());
    current = { ...current, pool: pool.outputHex };
  }
  const w = announceWindow(t.slot, network, validFor);
  validity = w;
  spec = announceSpec(d, refs, lock, change, w.readyAt, pp);
} else if (cmd === 'cancel') {
  const i = index();
  const a = announced[i];
  if (a?.change.kind === 'SetPool') current = { ...current, pool: (await poolOf(a.change.assetA, a.change.assetB)).outputHex };
  validity = announceWindow(t.slot, network, validFor);
  spec = cancelSpec(d, refs, lock, i, pp);
} else if (cmd === 'execute') {
  const i = index();
  const a = announced[i];
  if (!a) throw new LockRefused(`no announcement #${i}: the lock holds ${announced.length}`);
  const target = a.change.kind === 'SetPool' ? await poolOf(a.change.assetA, a.change.assetB) : setting;
  // Asked again: the change must be the announced one, exactly.
  if (a.change.kind === 'SetPool' && asksPool) matchesAnnounced(a.change, poolChange(poolNow(target.outputHex), poolAsk()));
  if (a.change.kind === 'SetGlobalSetting' && asksSetting) matchesAnnounced(a.change, { kind: 'SetGlobalSetting', setting: settingChange(settingNow(setting.outputHex), settingAsk(), d) });
  if ((a.change.kind === 'SetPool' && asksSetting) || (a.change.kind === 'SetGlobalSetting' && asksPool)) throw new LockRefused(`announcement #${i} is a ${a.change.kind}: those flags change something else`);
  if (has('--simulate')) {
    const time = timeOf(network);
    const at = time.zeroSlot + (a.readyAt + SLACK_MS + 60_000n - time.zeroTimeMs) / time.slotLengthMs;
    validity = executeWindow(at, network, a.readyAt, 300n);
  } else validity = executeWindow(t.slot, network, a.readyAt, validFor);
  spec = executeSpec(d, refs, lock, i, target, setting, pp);
  if (target.ref !== setting.ref) extra.push(target);
} else if (cmd === 'withdraw') {
  const p = (flag('--pool') ?? '').split(',');
  if (p.length !== 2) throw new LockRefused('--pool <A>,<B>: the pool to take the venue share from');
  if (asksPool || asksSetting || has('--simulate')) throw new LockRefused('a withdrawal changes nothing and waits for nothing: it takes only --pool and --valid-for');
  const pool = await poolOf(asset(p[0]!), asset(p[1]!));
  const s = shareOf(pool.outputHex);
  console.log(`the venue's share in ${pool.ref}: ${s.a} of ${s.assetA.policyId ? `${s.assetA.policyId}.${s.assetA.assetName}` : 'lovelace'}, ${s.b} of ${s.assetB.policyId}.${s.assetB.assetName}`);
  const w = announceWindow(t.slot, network, validFor);
  validity = { start: w.start, ttl: w.ttl };
  spec = withdrawSpec(d, refs, lock, pool, setting, pp);
  extra.push(pool);
} else throw new Error(`unknown command ${cmd}`);

// ---- built, judged, read back, written ----
const plan = (budgets?: LockPlan['budgets']): LockPlan => ({ pp, funds: [fund], change: inputs.deployer, validity, ...(budgets ? { budgets } : {}) });
const known: Record<string, string> = {};
for (const u of [lock, setting, fund, refs.lockScript, refs.poolScript!, refs.settingScript!, ...extra]) known[u.ref] = u.outputHex;
const output = (ref: string) => known[ref];
const name = (() => {
  const n = readdirSync(out).map((f) => /^lock-[a-z]+-(\d+)\./.exec(f)?.[1]).filter(Boolean).map(Number);
  return `lock-${cmd}-${(n.length ? Math.max(...n) : 0) + 1}`;
})();
const draft = lockTx(spec, plan());
if (has('--simulate')) {
  const aiken = process.env.AIKEN;
  if (!aiken) throw new Error('--simulate needs AIKEN=<aiken 1.0.24>');
  const spent: Record<string, string> = {};
  const body = CSL.FixedTransaction.from_hex(draft.txHex).body();
  for (const l of [body.inputs(), body.reference_inputs(), body.collateral()]) for (let i = 0; i < (l?.len() ?? 0); i++) { const r = `${l!.get(i).transaction_id().to_hex()}#${l!.get(i).index()}`; spent[r] = known[r]!; }
  const j = simulate(aiken, draft.txHex, spent, timeOf(network));
  const r = readLockTx(draft.txHex, output, d, current)!;
  writeFileSync(join(out, `${name}.draft.tx.json`), `${JSON.stringify({ type: 'Tx ConwayEra', description: `memetics.finance lock, SIMULATED (never signable): ${r.words[0]} ${summary(announced[index()]!.change)}`, cborHex: draft.txHex }, null, 1)}\n`);
  console.log(`${name} (simulated, dated ${utc(slotToPosixMs(validity.start, timeOf(network)))}): ${draft.txId}`);
  for (const w of r.words) console.log(`  ${w}`);
  console.log(`  ${r.when}`);
  console.log(`  aiken tx simulate: ${j.ok ? `PASSED ${j.budgets.map((b) => `${b.tag}:${b.index} ${b.mem} memory, ${b.steps} steps`).join('; ')}` : `REFUSED ${j.error.slice(0, 800)}`}`);
  process.exitCode = j.ok ? 0 : 1;
  return;
}
async function judge(txHex: string): Promise<NonNullable<LockPlan['budgets']>> {
  try {
    const r = budgetsFromOgmios(await rpc(ogmios, 'evaluateTransaction', { transaction: { cbor: txHex } }));
    return new Map(r.map((x) => [`${x.tag}:${x.index}`, { mem: (x.mem * 102n) / 100n, steps: (x.steps * 102n) / 100n }]));
  } catch (e) {
    if (e instanceof OgmiosError) throw new LockRefused(`the node refused it (${e.code}): ${e.message} ${JSON.stringify(e.data, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)).slice(0, 1200)}`);
    throw e;
  }
}
const budgets = await judge(draft.txHex);
const b = lockTx(spec, plan(budgets));
await judge(b.txHex); // judged again at its final budgets and fee
const r = readLockTx(b.txHex, output, d, current);
if (!r) throw new LockRefused('the transaction built spends no lock: nothing written');
writeFileSync(join(out, `${name}.tx.json`), `${JSON.stringify({ type: 'Tx ConwayEra', description: `memetics.finance lock: ${r.action}${r.index === undefined ? '' : ` #${r.index}`}`, cborHex: b.txHex }, null, 1)}\n`);
console.log(`${name}: ${b.txId}, fee ${b.fee} lovelace, judged by the node (${[...budgets].map(([k, v]) => `${k} ${v.mem} memory, ${v.steps} steps`).join('; ')}), written to ${join(out, `${name}.tx.json`)}`);
for (const w of r.words) console.log(`  ${w}`);
console.log(`  ${r.when}`);
console.log(`  valid from ${utc(slotToPosixMs(validity.start, timeOf(network)))} until ${utc(slotToPosixMs(validity.ttl, timeOf(network)))}: both owners and the deployer sign on the page before then`);
if (r.withdrawal) console.log(`  the network fee, ${b.fee} lovelace, is the deployer's; so is any min-ADA the treasury's output holds above the share`);
console.log(`next: KOIOS_URL=... node scripts/cosign.ts serve "${inputsPath}" "${out}", open ${name}, sign in each wallet; then cosign.ts submit ... ${name}`);
}
