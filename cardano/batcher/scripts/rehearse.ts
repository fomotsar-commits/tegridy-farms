// The preprod rehearsal of our pools after the deploy (PR #1148): a pool opened through our
// factory, an order for the batcher, and a change made through the 48-hour lock. Preprod only,
// signed with the throwaway keys; nothing here runs on mainnet. <dir> holds preprod-inputs.json,
// preprod-keys/ and preprod-run/ (the deploy's scripts.json and state.json); what each step makes
// is kept in preprod-run/rehearsal.json.
//   node scripts/rehearse.ts <dir> <step> [--submit]
//   steps: split | announce | open [--fee <lovelace>] [--to <bech32>] | order | early | execute [--simulate]
// Chain: OGMIOS_URL (parameters, tip, evaluation, submission), KOIOS_URL (UTxOs).
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import CSL from '@emurgo/cardano-serialization-lib-nodejs';
import { builderConfig, referenceScriptOf } from '../src/build.ts';
import { PREPROD_TIME, refKey, slotToPosixMs } from '../src/chain.ts';
import { MIN_POOL_ADA } from '../src/engine.ts';
import { ledgerMinFee } from '../src/fee.ts';
import { Koios } from '../src/koios.ts';
import { budgetsFromOgmios, OgmiosError, rpc, submit, tip, type Endpoint } from '../src/ogmios.ts';
import { mkBytes, mkConstr, mkInt, mkList, type PlutusData } from '../src/plutus.ts';
import { stringifyExact } from '../src/json.ts';
import { withArrayRedeemers, withoutSetTags } from '../src/simulate.ts';
import { keyFromFile } from '../src/signer.ts';
import { decodePoolDatum } from '../src/types.ts';
import { lpAssetName } from '../src/verify.ts';
import type { ChainUtxo } from '../src/view.ts';
import { addresses, NAMES, type Scripts } from '../src/deploy.ts';

const [dir, step] = process.argv.slice(2) as [string, string];
const flag = (f: string) => {
  const at = process.argv.indexOf(f);
  return at < 0 ? undefined : process.argv[at + 1];
};
const send = process.argv.includes('--submit');
const inputs = JSON.parse(readFileSync(join(dir, 'preprod-inputs.json'), 'utf8'));
if (inputs.network !== 0) throw new Error('the rehearsal is for preprod (network 0) only');
const run = join(dir, 'preprod-run');
const scripts: Scripts = JSON.parse(readFileSync(join(run, 'scripts.json'), 'utf8')).scripts;
const deployState = JSON.parse(readFileSync(join(run, 'state.json'), 'utf8')) as { refs: Record<string, string>; txs: Record<string, string> };
const statePath = join(run, 'rehearsal.json');
const state: Record<string, any> = existsSync(statePath) ? JSON.parse(readFileSync(statePath, 'utf8')) : { txs: {} };
const save = () => writeFileSync(statePath, `${JSON.stringify(state, (_k, v) => (typeof v === 'bigint' ? v.toString() : v), 1)}\n`);
const key = (n: string) => keyFromFile(join(dir, 'preprod-keys', `${n}.skey`));

const ogmios: Endpoint = { url: process.env.OGMIOS_URL ?? '', timeoutMs: 60_000 };
if (!ogmios.url || !process.env.KOIOS_URL) throw new Error('set OGMIOS_URL and KOIOS_URL');
const koios = new Koios({ url: process.env.KOIOS_URL, time: PREPROD_TIME });
const pp = await koios.protocolParams();
const deployerKey = key('deployer');
const deployerHash = deployerKey.to_public().hash().to_hex();
const deployer: string = inputs.deployer;
const A = addresses({ ...inputs, openingFee: BigInt(inputs.openingFee) }, scripts);
const authen = scripts.authen.hash;

const big = (n: bigint | number) => CSL.BigNum.from_str(n.toString());
const out = (u: ChainUtxo) => CSL.TransactionOutput.from_hex(u.outputHex);
const input = (ref: string) => {
  const [id, ix] = ref.split('#') as [string, string];
  return CSL.TransactionInput.new(CSL.TransactionHash.from_hex(id), Number(ix));
};
const cmpRef = (x: string, y: string) => {
  const [hx, ix] = x.split('#') as [string, string];
  const [hy, iy] = y.split('#') as [string, string];
  return hx < hy ? -1 : hx > hy ? 1 : Number(ix) - Number(iy);
};
async function one(ref: string): Promise<ChainUtxo> {
  const [u] = await koios.utxos([ref]);
  if (!u) throw new Error(`${ref} is spent or unknown`);
  return u;
}
function value(lovelace: bigint, tokens: [string, string, bigint][] = []): CSL.Value {
  const ma = CSL.MultiAsset.new();
  for (const [policy, name, q] of tokens) {
    const a = ma.get(CSL.ScriptHash.from_hex(policy)) ?? CSL.Assets.new();
    a.insert(CSL.AssetName.new(Buffer.from(name, 'hex')), big(q));
    ma.insert(CSL.ScriptHash.from_hex(policy), a);
  }
  return ma.len() ? CSL.Value.new_with_assets(big(lovelace), ma) : CSL.Value.new(big(lovelace));
}
const minAda = (o: CSL.TransactionOutput) => BigInt(CSL.min_ada_for_output(o, CSL.DataCost.new_coins_per_byte(big(pp.utxoCostPerByte))).to_str());
/** An output holding at least its min-ADA. */
function output(address: string, lovelace: bigint, tokens: [string, string, bigint][] = [], datum?: PlutusData): CSL.TransactionOutput {
  const o = CSL.TransactionOutput.new(CSL.Address.from_bech32(address), value(lovelace, tokens));
  if (datum) o.set_plutus_data(datum);
  const need = minAda(o);
  if (lovelace >= need) return o;
  const p = CSL.TransactionOutput.new(CSL.Address.from_bech32(address), value(need, tokens));
  if (datum) p.set_plutus_data(datum);
  return p;
}

// ---- Plutus data, as types.ak defines it ----
const TRUE = mkConstr(1, []);
const FALSE = mkConstr(0, []);
const NONE = mkConstr(1, []);
const some = (d: PlutusData) => mkConstr(0, [d]);
const asset = (policy: string, name: string) => mkConstr(0, [mkBytes(policy), mkBytes(name)]);

// ---- the test coin: minted by the deployer's key alone ----
const coinScript = CSL.NativeScript.new_script_pubkey(CSL.ScriptPubkey.new(CSL.Ed25519KeyHash.from_hex(deployerHash)));
const COIN = { policyId: coinScript.hash().to_hex(), assetName: Buffer.from('MEMETEST').toString('hex') };
const ADA = { policyId: '', assetName: '' };
const LP_NAME = lpAssetName(ADA, COIN);
const MAX_LP = 9_223_372_036_854_775_807n;
const POOL_ADA = 100_000_000n;
const POOL_COIN = 500_000_000_000n;
const poolStake = mkConstr(0, [mkConstr(inputs.poolStake.type === 'Key' ? 0 : 1, [mkBytes(inputs.poolStake.hash)])]); // Inline(credential)
/** The change the lock carries: our pool at 0.3% both ways, the venue's share 1333/10000 of it. */
const SET_POOL = mkConstr(1, [asset('', ''), asset(COIN.policyId, COIN.assetName), mkInt(30n), mkInt(30n), some(mkInt(1333n)), FALSE, some(poolStake)]);

// ---- one transaction: script spends and mints by reference, the deployer pays and signs ----
interface Spec {
  spends: { utxo: ChainUtxo; script: string; redeemer: PlutusData }[];
  plain: ChainUtxo[];
  mint?: { script: string; tokens: [string, bigint][]; redeemer: PlutusData };
  nativeMint?: { tokens: [string, bigint][] };
  reads: ChainUtxo[];
  outputs: CSL.TransactionOutput[];
  signers?: string[];
  validity?: { start: bigint; ttl: bigint };
}
type Budgets = Map<string, { mem: bigint; steps: bigint }>;
const DRAFT = { mem: 7_000_000n, steps: 4_000_000_000n };

async function scriptRefs(spec: Spec): Promise<Map<string, ChainUtxo>> {
  const refs = [...new Set([...spec.spends.map((s) => s.script), ...(spec.mint ? [spec.mint.script] : [])])];
  return new Map((await koios.utxos(refs)).map((u) => [u.ref, u]));
}

function costModels(): CSL.Costmdls {
  const all = CSL.Costmdls.new();
  const cm = CSL.CostModel.new();
  pp.costModelPlutusV2.forEach((v, k) => cm.set(k, v >= 0 ? CSL.Int.new(big(v)) : CSL.Int.new_negative(big(-v))));
  all.insert(CSL.Language.new_plutus_v2(), cm);
  return all;
}

function assemble(spec: Spec, refs: Map<string, ChainUtxo>, budgets: Budgets | null, minFee: bigint): CSL.Transaction {
  const tb = CSL.TransactionBuilder.new(builderConfig(pp));
  const order = [...spec.spends.map((s) => s.utxo.ref), ...spec.plain.map((u) => u.ref)].sort(cmpRef);
  const ins = CSL.TxInputsBuilder.new();
  const source = (ref: string) => {
    const r = referenceScriptOf(refs.get(ref)!);
    return CSL.PlutusScriptSource.new_ref_input(CSL.ScriptHash.from_hex(r.hash), input(ref), r.language, r.size);
  };
  for (const s of spec.spends) {
    const ix = order.indexOf(s.utxo.ref);
    const b = budgets?.get(`Spend:${ix}`) ?? DRAFT;
    const r = CSL.Redeemer.new(CSL.RedeemerTag.new_spend(), big(ix), s.redeemer, CSL.ExUnits.new(big(b.mem), big(b.steps)));
    ins.add_plutus_script_input(CSL.PlutusWitness.new_with_ref_without_datum(source(s.script), r), input(s.utxo.ref), out(s.utxo).amount());
  }
  for (const u of spec.plain) ins.add_regular_input(out(u).address(), input(u.ref), out(u).amount());
  tb.set_inputs(ins);
  const mb = CSL.MintBuilder.new();
  if (spec.mint) {
    const b = budgets?.get('Mint:0') ?? DRAFT;
    const w = CSL.MintWitness.new_plutus_script(source(spec.mint.script), CSL.Redeemer.new(CSL.RedeemerTag.new_mint(), big(0), spec.mint.redeemer, CSL.ExUnits.new(big(b.mem), big(b.steps))));
    for (const [name, q] of spec.mint.tokens) mb.add_asset(w, CSL.AssetName.new(Buffer.from(name, 'hex')), CSL.Int.new(big(q)));
  }
  if (spec.nativeMint) {
    const w = CSL.MintWitness.new_native_script(CSL.NativeScriptSource.new(coinScript));
    for (const [name, q] of spec.nativeMint.tokens) mb.add_asset(w, CSL.AssetName.new(Buffer.from(name, 'hex')), CSL.Int.new(big(q)));
  }
  if (spec.mint || spec.nativeMint) tb.set_mint_builder(mb);
  for (const r of spec.reads) tb.add_reference_input(input(r.ref));
  for (const o of spec.outputs) tb.add_output(o);
  for (const h of spec.signers ?? []) tb.add_required_signer(CSL.Ed25519KeyHash.from_hex(h));
  if (spec.validity) {
    tb.set_validity_start_interval_bignum(big(spec.validity.start));
    tb.set_ttl_bignum(big(spec.validity.ttl));
  }
  const plutus = spec.spends.length > 0 || !!spec.mint;
  if (plutus) {
    // The pledge: the deployer's largest coin, all of it back but 5 ADA (fees here stay far below 3.3 ADA).
    const c = [...spec.plain].sort((x, y) => (BigInt(out(x).amount().coin().to_str()) > BigInt(out(y).amount().coin().to_str()) ? -1 : 1))[0]!;
    const cb = CSL.TxInputsBuilder.new();
    cb.add_regular_input(out(c).address(), input(c.ref), out(c).amount());
    tb.set_collateral(cb);
    tb.set_total_collateral_and_return(big(5_000_000n), CSL.Address.from_bech32(deployer));
    tb.calc_script_data_hash(costModels());
  }
  if (minFee > 0n) tb.set_min_fee(big(minFee));
  tb.add_change_if_needed(CSL.Address.from_bech32(deployer));
  return tb.build_tx();
}

/** Every output the transaction spends, reads or pledges, for the ledger's own fee formula. */
function known(spec: Spec, refs: Map<string, ChainUtxo>): Record<string, string> {
  const k: Record<string, string> = {};
  for (const u of [...spec.spends.map((s) => s.utxo), ...spec.plain, ...spec.reads, ...refs.values()]) k[u.ref] = u.outputHex;
  return k;
}

async function evaluate(txHex: string): Promise<{ ok: true; budgets: Budgets; list: string[] } | { ok: false; code: number; error: string }> {
  try {
    const r = budgetsFromOgmios(await rpc(ogmios, 'evaluateTransaction', { transaction: { cbor: txHex } }));
    return { ok: true, budgets: new Map(r.map((x) => [`${x.tag}:${x.index}`, { mem: x.mem, steps: x.steps }])), list: r.map((x) => `${x.tag}:${x.index} ${x.mem} memory, ${x.steps} steps`) };
  } catch (e) {
    if (!(e instanceof OgmiosError)) throw e;
    return { ok: false, code: e.code, error: `${e.message} ${stringifyExact(e.data)}`.slice(0, 1500) };
  }
}

/** Built with the node's measured budgets (and 2% over), the fee raised to the ledger's own formula. */
async function built(spec: Spec, measured?: Budgets): Promise<{ txHex: string; txId: string; fee: bigint; budgets: Budgets | null; draft?: string }> {
  const refs = await scriptRefs(spec);
  const plutus = spec.spends.length > 0 || !!spec.mint;
  let budgets: Budgets | null = measured ?? null;
  if (plutus && !budgets) {
    const e = await evaluate(assemble(spec, refs, null, 0n).to_hex());
    if (!e.ok) return { txHex: assemble(spec, refs, null, 0n).to_hex(), txId: '', fee: 0n, budgets: null, draft: e.error };
    budgets = new Map([...e.budgets].map(([k, b]) => [k, { mem: (b.mem * 102n) / 100n, steps: (b.steps * 102n) / 100n }]));
    console.log(`  measured: ${e.list.join('; ')}`);
  }
  let floor = 0n;
  for (let pass = 0; pass < 4; pass++) {
    const tx = assemble(spec, refs, budgets, floor);
    const fee = BigInt(tx.body().fee().to_str());
    const min = ledgerMinFee(tx.to_hex(), known(spec, refs), pp);
    if (fee >= min) return { txHex: tx.to_hex(), txId: CSL.FixedTransaction.from_hex(tx.to_hex()).transaction_hash().to_hex(), fee, budgets };
    floor = min;
  }
  throw new Error('the fee did not settle');
}

function signed(txHex: string, keys: string[]): string {
  const tx = CSL.FixedTransaction.from_hex(txHex);
  for (const k of keys) tx.sign_and_add_vkey_signature(key(k));
  return tx.to_hex();
}

async function sendOrSay(name: string, txHex: string, keys: string[]): Promise<string | null> {
  const s = signed(txHex, keys);
  writeFileSync(join(run, `${name}.signed.tx.json`), `${JSON.stringify({ type: 'Tx ConwayEra', description: `memetics.finance preprod rehearsal: ${name}`, cborHex: s }, null, 1)}\n`);
  if (!send) return null;
  try {
    const id = await submit(ogmios, s);
    state.txs[name] = id;
    save();
    console.log(`  submitted ${id}`);
    return id;
  } catch (e) {
    console.log(`  submit REFUSED: ${e instanceof Error ? e.message.slice(0, 1500) : String(e)}`);
    return null;
  }
}

/** The deployer's plain-ADA coins, largest first. */
async function funds(): Promise<ChainUtxo[]> {
  const us = await koios.utxosAtCredential(deployerHash);
  // Plain ADA first (it can stand as collateral), then the most ADA first.
  const plainAda = (u: ChainUtxo) => !out(u).amount().multiasset()?.len();
  const ada = (u: ChainUtxo) => BigInt(out(u).amount().coin().to_str());
  return us.filter((u) => !out(u).has_script_ref() && !out(u).has_plutus_data()).sort((x, y) => (plainAda(x) !== plainAda(y) ? (plainAda(x) ? -1 : 1) : ada(x) > ada(y) ? -1 : 1));
}

/** A validity range around the node's tip: from a minute back to `ahead` slots on. */
async function window(ahead = 600n): Promise<{ start: bigint; ttl: bigint; tipSlot: bigint }> {
  const t = await tip(ogmios);
  return { start: t.slot - 60n, ttl: t.slot + ahead, tipSlot: t.slot };
}

const lockRef = deployState.txs.lock + '#0';
const gsRef = `${deployState.txs.init}#1`;
const lockData = (announced: PlutusData[]) => mkConstr(0, [mkList(announced)]);
const announcement = (readyAt: bigint) => mkConstr(0, [SET_POOL, mkInt(readyAt)]);
/**
 * The lock is one Aiken 1.0.24 script with a mint and a spend handler: it runs the mint handler
 * when its second argument is constructor 0, so a spend's redeemer goes wrapped, constr 1 [action]
 * (plutus.json: RedeemerWrapper<Action>). Unwrapped, Announce (constructor 0) reaches the mint handler.
 */
const lockAction = (action: PlutusData) => mkConstr(1, [action]);

if (step === 'split') {
  // The test coin minted, the deployer's coin split, and the batcher funded (collateral and float).
  const [f] = await funds();
  const batcher = CSL.EnterpriseAddress.new(0, CSL.Credential.from_keyhash(CSL.Ed25519KeyHash.from_hex(inputs.batcherKeyHash))).to_address().to_bech32(undefined);
  const outs = [
    output(deployer, 2_000_000n, [[COIN.policyId, COIN.assetName, 1_000_000_000_000n]]),
    ...Array.from({ length: 6 }, () => output(deployer, 300_000_000n)),
    output(batcher, 10_000_000n),
    output(batcher, 40_000_000n),
  ];
  const b = await built({ spends: [], plain: [f!], nativeMint: { tokens: [[COIN.assetName, 1_000_000_000_000n]] }, reads: [], outputs: outs });
  console.log(`split: ${b.txId}, fee ${b.fee}; coin ${COIN.policyId}.${COIN.assetName}`);
  state.coin = COIN;
  save();
  await sendOrSay('split', b.txHex, ['deployer']);
} else if (step === 'announce') {
  // The lock's Announce of SetPool: both owners sign; ready 48 hours after the upper bound.
  const lock = await one(lockRef);
  const [f] = await funds();
  const w = await window();
  const readyAt = slotToPosixMs(w.ttl, PREPROD_TIME) + 172_800_000n;
  const ann = announcement(readyAt);
  const lockOut = output(A.lock, 0n, [[scripts.lock.hash, NAMES.lock, 1n]], lockData([ann]));
  const b = await built({
    spends: [{ utxo: lock, script: deployState.refs.lock!, redeemer: lockAction(mkConstr(0, [ann])) }],
    plain: [f!],
    reads: [],
    outputs: [lockOut],
    signers: [inputs.ownerA, inputs.ownerB],
    validity: { start: w.start, ttl: w.ttl },
  });
  if (b.draft) {
    writeFileSync(join(run, "announce.draft.tx.json"), JSON.stringify({ cborHex: b.txHex }));
    throw new Error(`the node refused the draft: ${b.draft}`);
  }
  console.log(`announce: ${b.txId}, fee ${b.fee}; ready_at ${readyAt} = ${new Date(Number(readyAt)).toISOString()}; window ${w.start}..${w.ttl}`);
  state.announce = { readyAt, ttl: w.ttl, budgets: Object.fromEntries(b.budgets ?? []) };
  save();
  await sendOrSay('announce', b.txHex, ['deployer', 'owner1', 'owner2']);
} else if (step === 'open') {
  // The pool opened through our factory; --fee and --to build the two the chain must refuse.
  const fee = BigInt(flag('--fee') ?? inputs.openingFee);
  const to = flag('--to') ?? inputs.treasury;
  const factory = await one(`${deployState.txs.init}#0`);
  const gs = await one(gsRef);
  const coinUtxo = (await koios.utxosWithAsset(COIN.policyId, COIN.assetName, deployerHash))[0];
  if (!coinUtxo) throw new Error('no test coin at the deployer: run split');
  const [f] = await funds();
  const total = (() => {
    const p = POOL_ADA * POOL_COIN;
    let x = BigInt(Math.floor(Math.sqrt(Number(p))));
    while (x * x > p) x--;
    while ((x + 1n) * (x + 1n) <= p) x++;
    return x * x < p ? x + 1n : x;
  })();
  const fd = CSL.PlutusData.from_hex(CSL.TransactionOutput.from_hex(factory.outputHex).plutus_data()!.to_hex()).as_constr_plutus_data()!.data();
  const head = Buffer.from(fd.get(0).as_bytes()!).toString('hex');
  const tail = Buffer.from(fd.get(1).as_bytes()!).toString('hex');
  if (!(head < LP_NAME && LP_NAME < tail)) throw new Error('the factory entry does not hold this pair');
  const poolDatum = mkConstr(0, [mkConstr(0, [mkConstr(1, [mkBytes(scripts.poolBatching.hash)])]), asset('', ''), asset(COIN.policyId, COIN.assetName), mkInt(total), mkInt(POOL_ADA), mkInt(POOL_COIN), mkInt(30n), mkInt(30n), NONE, FALSE]);
  const factoryLovelace = BigInt(out(factory).amount().coin().to_str());
  const fac = (h: string, t: string, floor: bigint) => {
    const o = output(A.factory, 0n, [[authen, NAMES.factory, 1n]], mkConstr(0, [mkBytes(h), mkBytes(t)]));
    return BigInt(o.amount().coin().to_str()) >= floor ? o : output(A.factory, floor, [[authen, NAMES.factory, 1n]], mkConstr(0, [mkBytes(h), mkBytes(t)]));
  };
  const outputs = [
    output(A.pool, MIN_POOL_ADA + POOL_ADA, [[COIN.policyId, COIN.assetName, POOL_COIN], [authen, LP_NAME, MAX_LP - (total - 10n)], [authen, NAMES.pool, 1n]], poolDatum),
    fac(head, LP_NAME, factoryLovelace),
    fac(LP_NAME, tail, 0n),
    CSL.TransactionOutput.new(CSL.Address.from_bech32(to), CSL.Value.new(big(fee))),
    output(deployer, 0n, [[authen, LP_NAME, total - 10n]]),
  ];
  const spec: Spec = {
    spends: [{ utxo: factory, script: deployState.refs.factory!, redeemer: mkConstr(0, [asset('', ''), asset(COIN.policyId, COIN.assetName)]) }],
    plain: [f!, coinUtxo],
    mint: { script: deployState.refs.authen!, tokens: [[NAMES.factory, 1n], [NAMES.pool, 1n], [LP_NAME, MAX_LP]], redeemer: mkConstr(1, []) },
    reads: [gs],
    outputs,
  };
  const tampered = fee !== BigInt(inputs.openingFee) || to !== inputs.treasury;
  if (!tampered) {
    const b = await built(spec);
    if (b.draft) throw new Error(`the node refused the honest pool opening: ${b.draft}`);
    console.log(`open: ${b.txId}, fee ${b.fee}; LP ${LP_NAME}, total liquidity ${total}`);
    state.open = { lpName: LP_NAME, totalLiquidity: total, budgets: Object.fromEntries(b.budgets ?? []) };
    save();
    await sendOrSay('open', b.txHex, ['deployer']);
  } else {
    // The node's judgement of the same pool opening, the fee changed: evaluate, then submit with the honest budgets.
    const draft = await evaluate((await built(spec, new Map(Object.entries(state.open?.budgets ?? {}).map(([k, v]: [string, any]) => [k, { mem: BigInt(v.mem), steps: BigInt(v.steps) }])))).txHex);
    console.log(`open (fee ${fee} to ${to}): evaluate ${draft.ok ? `PASSED ${draft.list.join('; ')}` : `REFUSED ${draft.code}: ${draft.error}`}`);
    const b = await built(spec, new Map(Object.entries(state.open?.budgets ?? {}).map(([k, v]: [string, any]) => [k, { mem: BigInt(v.mem), steps: BigInt(v.steps) }])));
    const name = `open-refused-${fee}-${to === inputs.treasury ? 'treasury' : 'other'}`;
    console.log(`  ${name}: ${b.txId}`);
    state.refusals = { ...(state.refusals ?? {}), [name]: { evaluate: draft.ok ? 'PASSED' : `${draft.code}: ${draft.error.slice(0, 600)}` } };
    save();
    await sendOrSay(name, b.txHex, ['deployer']);
  }
} else if (step === 'order') {
  // A swap of 10 ADA for the test coin, placed at our order address with the deployer's stake key.
  const pool = (await koios.utxosWithAsset(authen, NAMES.pool, scripts.pool.hash))[0];
  if (!pool) throw new Error('no pool yet');
  const d = decodePoolDatum(CSL.TransactionOutput.from_hex(pool.outputHex).plutus_data()!);
  const swap = 10_000_000n;
  const outQ = (swap * 9970n * d.reserveB) / (d.reserveA * 10000n + swap * 9970n);
  const minimum = (outQ * 99n) / 100n;
  const self = mkConstr(0, [mkConstr(0, [mkBytes(deployerHash)]), NONE]);
  const datum = mkConstr(0, [mkConstr(0, [mkBytes(deployerHash)]), self, mkConstr(0, []), self, mkConstr(0, []), asset(authen, LP_NAME), mkConstr(0, [TRUE, mkConstr(0, [mkInt(swap)]), mkInt(minimum), TRUE]), mkInt(2_000_000n), NONE]);
  const orderAddress = CSL.BaseAddress.new(0, CSL.Credential.from_scripthash(CSL.ScriptHash.from_hex(scripts.order.hash)), CSL.Credential.from_keyhash(CSL.Ed25519KeyHash.from_hex(deployerHash))).to_address().to_bech32(undefined);
  const [f] = await funds();
  // The first order also set aside a plain 500 ADA coin for the Execute to spend. The order after
  // the Execute is paid from that coin's change (499.5 ADA), so it sets one aside only if it can.
  const spare = BigInt(out(f!).amount().coin().to_str()) >= swap + 4_000_000n + 500_000_000n + 2_000_000n;
  const b = await built({ spends: [], plain: [f!], reads: [], outputs: [output(orderAddress, swap + 4_000_000n, [], datum), ...(spare ? [output(deployer, 500_000_000n)] : [])] });
  console.log(`order: ${b.txId}, fee ${b.fee}; swap ${swap} lovelace, expects ${outQ}, minimum ${minimum}`);
  state.order = { swap, expected: outQ, minimum, address: orderAddress };
  save();
  await sendOrSay('order', b.txHex, ['deployer']);
} else if (step === 'early' || step === 'execute') {
  // Execute: the lock's change made on the pool, its own admin path (UpdatePoolParameters UpdatePoolFee).
  const lock = await one(state.txs.announce ? `${state.txs.announce}#0` : lockRef);
  const pool = (await koios.utxosWithAsset(authen, NAMES.pool, scripts.pool.hash))[0];
  if (!pool) throw new Error('no pool yet');
  const gs = await one(gsRef);
  const [f] = await funds();
  const po = CSL.TransactionOutput.from_hex(pool.outputHex);
  const pdat = po.plutus_data()!.as_constr_plutus_data()!.data();
  const fields = Array.from({ length: pdat.len() }, (_, i) => pdat.get(i));
  fields[8] = some(mkInt(1333n));
  const poolOut = CSL.TransactionOutput.new(po.address(), po.amount());
  poolOut.set_plutus_data(mkConstr(0, fields));
  const lockOut = output(A.lock, BigInt(out(lock).amount().coin().to_str()), [[scripts.lock.hash, NAMES.lock, 1n]], lockData([]));
  const readyAt = BigInt(state.announce.readyAt);
  const w = await window(300n);
  const t = await tip(ogmios);
  const nowMs = slotToPosixMs(t.slot, PREPROD_TIME);
  // --simulate: the Execute dated a minute after ready_at, judged offline by Aiken (the node cannot
  // place a time past its 36-hour horizon), with preprod's slot times. Nothing is sent.
  const simulated = step === 'execute' && process.argv.includes('--simulate');
  if (step === 'execute' && !simulated && nowMs < readyAt + 60_000n) throw new Error(`not ready: the chain's time is ${new Date(Number(nowMs)).toISOString()}, ready_at ${new Date(Number(readyAt)).toISOString()}`);
  const readySlot = PREPROD_TIME.zeroSlot + (readyAt + 60_000n - PREPROD_TIME.zeroTimeMs) / PREPROD_TIME.slotLengthMs;
  const start = step === 'early' ? w.start : simulated ? readySlot : t.slot - 30n;
  if (simulated) w.ttl = readySlot + 300n;
  const spec: Spec = {
    spends: [
      { utxo: lock, script: deployState.refs.lock!, redeemer: lockAction(mkConstr(2, [mkInt(0n)])) },
      { utxo: pool, script: deployState.refs.pool!, redeemer: mkConstr(1, [mkConstr(0, [])]) },
    ],
    plain: [f!],
    reads: [gs],
    outputs: [lockOut, poolOut],
    signers: [inputs.ownerA, inputs.ownerB],
    validity: { start, ttl: w.ttl },
  };
  console.log(`${step}: lower bound ${new Date(Number(slotToPosixMs(start, PREPROD_TIME))).toISOString()}, ready_at ${new Date(Number(readyAt)).toISOString()}`);
  if (simulated) {
    const refs = await scriptRefs(spec);
    const txHex = assemble(spec, refs, null, 0n).to_hex();
    const spent = known(spec, refs);
    const body = CSL.FixedTransaction.from_hex(txHex).body();
    const ins = [body.inputs(), body.reference_inputs(), body.collateral()].flatMap((l) => Array.from({ length: l?.len() ?? 0 }, (_, i) => l!.get(i)));
    const seen = [...new Map(ins.map((i) => [refKey(i), i])).values()];
    const head = (n: number) => (n < 24 ? (0x80 + n).toString(16) : `98${n.toString(16).padStart(2, '0')}`);
    const dir = mkdtempSync(join(tmpdir(), 'rehearse-sim-'));
    writeFileSync(join(dir, 'tx'), withoutSetTags(withArrayRedeemers(txHex)));
    writeFileSync(join(dir, 'inputs'), head(seen.length) + seen.map((i) => i.to_hex()).join(''));
    writeFileSync(join(dir, 'outputs'), head(seen.length) + seen.map((i) => spent[refKey(i)]).join(''));
    const r = spawnSync(process.env.AIKEN ?? 'aiken', ['tx', 'simulate', join(dir, 'tx'), join(dir, 'inputs'), join(dir, 'outputs'), '--zero-time', PREPROD_TIME.zeroTimeMs.toString(), '--zero-slot', PREPROD_TIME.zeroSlot.toString(), '--slot-length', PREPROD_TIME.slotLengthMs.toString()], { encoding: 'utf-8' });
    rmSync(dir, { recursive: true, force: true });
    const clean = (s: string | null) => (s ?? '').replace(/\x1b\[[0-9;]*m/g, '').trim();
    console.log(`  aiken tx simulate (exit ${r.status}): ${clean(r.stdout)} ${clean(r.stderr).slice(-600)}`);
    process.exit(r.status === 0 ? 0 : 1);
  }
  const draft = await evaluate(assemble(spec, await scriptRefs(spec), null, 0n).to_hex());
  console.log(`  evaluate ${draft.ok ? `PASSED ${draft.list.join('; ')}` : `REFUSED ${draft.code}: ${draft.error}`}`);
  if (step === 'early') {
    // The same Execute, budgeted as Announce measured the lock and generously for the pool, sent to the node.
    const budgets: Budgets = new Map([...Array(3).keys()].map((i) => [`Spend:${i}`, { mem: 3_000_000n, steps: 1_500_000_000n }]));
    const b = await built(spec, budgets);
    console.log(`  early: ${b.txId}`);
    state.refusals = { ...(state.refusals ?? {}), early: { evaluate: draft.ok ? 'PASSED' : `${draft.code}: ${draft.error.slice(0, 600)}` } };
    save();
    await sendOrSay('early-execute', b.txHex, ['deployer', 'owner1', 'owner2']);
  } else {
    const b = await built(spec);
    if (b.draft) throw new Error(`the node refused the Execute: ${b.draft}`);
    console.log(`execute: ${b.txId}, fee ${b.fee}`);
    await sendOrSay('execute', b.txHex, ['deployer', 'owner1', 'owner2']);
  }
} else throw new Error(`unknown step ${step}`);
