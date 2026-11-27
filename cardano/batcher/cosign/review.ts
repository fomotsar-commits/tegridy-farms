// The co-signing page's checks (scripts/cosign.ts serves the page): what a deploy transaction
// does, read from its own bytes; which keys must sign it; and each wallet's signatures, checked
// before they are kept. The owner signs in his own wallets (CIP-30 signTx(tx, true)), so no
// owner key is ever a file. Refused, by name:
//   - a signature from a key the transaction does not need;
//   - a signature that is not over this transaction's body (the wallet signed other bytes);
//   - signatures kept for one body and a transaction that now has another (it changed between
//     signatures);
//   - any address, wallet or chain on another network than the run's inputs name (mainnet only
//     when they say network 1);
//   - what none of the deploy's transactions holds: votes, proposals, a donation, a protocol
//     update, a native script, a Byron input, a certificate other than the legacy stake
//     registration, an input no one can show;
//   - a change through the 48-hour lock that src/lock.ts's reading refuses (an Execute before
//     ready_at or unlike its announcement, a pool's value or fee share leaving for anywhere but
//     the treasury, a role off the lock, the wrong network). What the change does is shown in
//     plain words, with when it can run; a fee-share withdrawal, with each coin that leaves the
//     pool and the treasury's whole address;
//   - a deploy step (lock, init, ref-*, register) that does anything but what it is for, read
//     from its bytes against scripts.json and the inputs (readDeployStep); the first
//     GlobalSetting is shown in plain words.
import CSL from '@emurgo/cardano-serialization-lib-nodejs';
import { MAINNET_TIME, PREPROD_TIME, refKey, slotToPosixMs } from '../src/chain.ts';
import { NAMES, REF_ORDER, addresses, burnAddress, factoryDatum, isEmptyLockState, type DeployInputs, type Scripts } from '../src/deploy.ts';
import { checkSetting, decodeSetting, LockRefused, readLockTx, type LockDeployment, type LockReading } from '../src/lock.ts';
import { DecodeError } from '../src/plutus.ts';

export class Refused extends Error {}

/** The network magic each run's network must answer with: mainnet, or preprod for network 0. */
export const MAGIC: Record<0 | 1, number> = { 1: 764_824_073, 0: 1 };
export const networkName = (n: number) => (n === 1 ? 'mainnet' : n === 0 ? 'preprod' : `network ${n}`);

/** The chain (Koios or Ogmios) answered with this magic: it must be the run's network. */
export function checkMagic(magic: unknown, network: 0 | 1, source: string): void {
  if (Number(magic) !== MAGIC[network]) throw new Refused(`${source} is not on ${networkName(network)} (network magic ${String(magic)}): this run's inputs say ${networkName(network)}`);
}

/** The wallet says which network it is on: it must be the run's. */
export function checkWalletNetwork(walletNetwork: unknown, network: 0 | 1): void {
  if (walletNetwork !== network) throw new Refused(`the wallet is on ${networkName(Number(walletNetwork))}, and this run's inputs say ${networkName(network)}: switch the wallet's network, or use the run meant for it`);
}

export interface Coin {
  policy: string;
  name: string;
  /** The name as text, when it is printable. */
  text?: string;
  quantity: string;
}
export interface Held {
  address: string;
  lovelace: string;
  coins: Coin[];
  datum?: string;
  datumHash?: string;
  scriptRef?: { hash: string; bytes: number };
}
export interface InputRow extends Held {
  ref: string;
  /** Where the output was read: "the chain", or the run's transaction that makes it. */
  from: string;
  /** The key that must sign to spend it, or the script that judges it. */
  key?: string;
  script?: string;
}
export interface Need {
  key: string;
  label?: string;
  why: string[];
}
export interface Review {
  txId: string;
  network: 0 | 1;
  fee: string;
  inputs: InputRow[];
  collateral: InputRow[];
  collateralReturn?: Held;
  totalCollateral?: string;
  referenceInputs: InputRow[];
  outputs: (Held & { index: number })[];
  mint: { policy: string; name: string; text?: string; quantity: string }[];
  certificates: { kind: string; credential: string; script: boolean }[];
  withdrawals: { rewardAddress: string; lovelace: string }[];
  requiredSigners: string[];
  validity: { from?: { slot: string; time: string }; until?: { slot: string; time: string } };
  metadataHash?: string;
  scriptDataHash?: string;
  plutusScripts: string[];
  redeemers: { tag: string; index: string; mem: string; steps: string }[];
  /** Every key that must sign, and why. */
  needs: Need[];
  /** A change through the 48-hour lock: what it does, in plain words, and when it can run. */
  lock?: LockReading;
  /** A deploy step, read from its bytes against scripts.json and the inputs (readDeployStep). */
  deploy?: { step: string; words: string[] };
}

/** The run's deployment (scripts.json), to read lock transactions; `current`: the pool's and the GlobalSetting's outputs now. */
export interface LockView {
  deployment: LockDeployment;
  current?: { pool?: string; setting?: string };
}

/** An input's output, as hex, and where it was read; undefined when no one can show it. */
export type Resolver = (ref: string) => { outputHex: string; from: string } | undefined;

const text = (hex: string) => {
  const s = Buffer.from(hex, 'hex').toString('utf8');
  return /^[\x20-\x7e]+$/.test(s) ? s : undefined;
};

function coinsOf(ma: CSL.MultiAsset | undefined): Coin[] {
  const out: Coin[] = [];
  if (!ma) return out;
  const ps = ma.keys();
  for (let i = 0; i < ps.len(); i++) {
    const p = ps.get(i);
    const as = ma.get(p)!;
    const ns = as.keys();
    for (let j = 0; j < ns.len(); j++) {
      const name = Buffer.from(ns.get(j).name()).toString('hex');
      out.push({ policy: p.to_hex(), name, ...(text(name) ? { text: text(name) } : {}), quantity: as.get(ns.get(j))!.to_str() });
    }
  }
  return out;
}

function addressOn(a: CSL.Address, network: 0 | 1, what: string): string {
  const bech = a.to_bech32(undefined);
  if (a.network_id() !== network) throw new Refused(`${what} ${bech} is a ${networkName(a.network_id())} address, and this run's inputs say ${networkName(network)}`);
  return bech;
}

function held(o: CSL.TransactionOutput, network: 0 | 1, what: string): Held {
  const v = o.amount();
  const h: Held = { address: addressOn(o.address(), network, what), lovelace: v.coin().to_str(), coins: coinsOf(v.multiasset()) };
  const d = o.plutus_data();
  if (d) h.datum = d.to_hex();
  const dh = o.data_hash();
  if (dh) h.datumHash = dh.to_hex();
  const s = o.script_ref();
  if (s) {
    const ps = s.plutus_script();
    const ns = s.native_script();
    if (ps) h.scriptRef = { hash: ps.hash().to_hex(), bytes: ps.bytes().length };
    else if (ns) h.scriptRef = { hash: ns.hash().to_hex(), bytes: ns.to_bytes().length };
  }
  return h;
}

const list = <T>(l: { len(): number; get(i: number): T } | undefined): T[] => Array.from({ length: l?.len() ?? 0 }, (_, i) => l!.get(i));

/** What the transaction does, from its bytes, and who must sign it. `labels` names known keys (ownerA, the deployer). */
export function review(txHex: string, network: 0 | 1, resolve: Resolver, labels: Record<string, string> = {}, lockView?: LockView): Review {
  let tx: CSL.FixedTransaction;
  try {
    tx = CSL.FixedTransaction.from_hex(txHex);
  } catch {
    throw new Refused('this is not a transaction CSL can read');
  }
  const body = tx.body();
  const ws = tx.witness_set();
  const txId = tx.transaction_hash().to_hex();
  // None of the deploy's transactions holds these: a page that only signs deploys refuses them.
  if (body.voting_procedures()) throw new Refused('the transaction votes: this page signs no votes');
  if (body.voting_proposals()) throw new Refused('the transaction makes a governance proposal: this page signs none');
  if (body.donation()) throw new Refused('the transaction donates to the treasury: this page signs no donation');
  if (body.current_treasury_value()) throw new Refused('the transaction names a treasury value: this page signs none');
  if (body.update()) throw new Refused('the transaction carries a protocol update: this page signs none');
  if (ws.native_scripts()?.len()) throw new Refused('the transaction carries a native script: this page signs only plain and Plutus spends');
  if (ws.vkeys()?.len() || ws.bootstraps()?.len()) throw new Refused('the transaction already carries signatures: give the page the unsigned one deploy.ts wrote');
  const nid = body.network_id();
  if (nid && nid.kind() !== (network === 1 ? CSL.NetworkIdKind.Mainnet : CSL.NetworkIdKind.Testnet)) throw new Refused(`the transaction names another network than ${networkName(network)}`);

  const needs = new Map<string, Need>();
  const need = (key: string, why: string) => {
    const n = needs.get(key) ?? { key, ...(labels[key] ? { label: labels[key] } : {}), why: [] };
    if (!n.why.includes(why)) n.why.push(why);
    needs.set(key, n);
  };
  const row = (i: CSL.TransactionInput, what: string, spends: boolean): InputRow => {
    const ref = refKey(i);
    const r = resolve(ref);
    if (!r) throw new Refused(`${what} ${ref} is not on the chain unspent, and no transaction in this run makes it: the page cannot show what it holds`);
    const o = CSL.TransactionOutput.from_hex(r.outputHex);
    const h = held(o, network, `${what} ${ref}, at`);
    const pay = o.address().payment_cred();
    if (!pay) throw new Refused(`${what} ${ref} sits at a Byron address: this page signs none`);
    const key = pay.to_keyhash()?.to_hex();
    const script = pay.to_scripthash()?.to_hex();
    if (key && spends) need(key, `${what} ${ref}`);
    return { ref, from: r.from, ...h, ...(key ? { key } : {}), ...(script ? { script } : {}) };
  };

  const inputs = list(body.inputs()).map((i) => row(i, 'input', true));
  const collateral = list(body.collateral()).map((i) => row(i, 'collateral', true));
  const referenceInputs = list(body.reference_inputs()).map((i) => row(i, 'reference input', false));
  const outputs = list(body.outputs()).map((o, index) => ({ index, ...held(o, network, `output #${index} pays`) }));
  const cr = body.collateral_return();

  const mint: Review['mint'] = [];
  const m = body.mint();
  for (const p of list(m?.keys())) {
    for (const assets of list(m!.get(p))) {
      if (!assets) continue;
      for (const n of list(assets.keys())) {
        const name = Buffer.from(n.name()).toString('hex');
        mint.push({ policy: p.to_hex(), name, ...(text(name) ? { text: text(name) } : {}), quantity: assets.get(n)!.to_str() });
      }
    }
  }

  const certificates: Review['certificates'] = [];
  for (const c of list(body.certs())) {
    const reg = c.as_stake_registration();
    // Only the legacy registration (no deposit named in it), which needs no one's signature.
    if (c.kind() !== CSL.CertificateKind.StakeRegistration || !reg || reg.coin() !== undefined) throw new Refused(`the transaction holds a ${CSL.CertificateKind[c.kind()]} certificate: this page signs only the legacy stake registration`);
    const cred = reg.stake_credential();
    certificates.push({ kind: 'stake registration (legacy)', credential: (cred.to_scripthash() ?? cred.to_keyhash())!.to_hex(), script: cred.kind() === CSL.CredKind.Script });
  }

  const withdrawals: Review['withdrawals'] = [];
  const w = body.withdrawals();
  for (const ra of list(w?.keys())) {
    const addr = addressOn(ra.to_address(), network, 'a withdrawal from');
    const key = ra.payment_cred().to_keyhash()?.to_hex();
    if (key) need(key, `the withdrawal from ${addr}`);
    withdrawals.push({ rewardAddress: addr, lovelace: w!.get(ra)!.to_str() });
  }

  const requiredSigners = list(body.required_signers()).map((k) => k.to_hex());
  for (const k of requiredSigners) need(k, 'named as a required signer');

  const time = network === 1 ? MAINNET_TIME : PREPROD_TIME;
  const at = (slot: CSL.BigNum | undefined) => (slot ? { slot: slot.to_str(), time: new Date(Number(slotToPosixMs(BigInt(slot.to_str()), time))).toISOString() } : undefined);
  const from = at(body.validity_start_interval_bignum());
  const until = at(body.ttl_bignum());

  let lock: LockReading | undefined;
  if (lockView) {
    if (lockView.deployment.network !== network) throw new Refused(`the deployment read is for ${networkName(lockView.deployment.network)}, and this run's inputs say ${networkName(network)}`);
    try {
      lock = readLockTx(txHex, (ref) => resolve(ref)?.outputHex, lockView.deployment, lockView.current);
    } catch (e) {
      if (e instanceof LockRefused || e instanceof DecodeError) throw new Refused(`the lock transaction is refused: ${e.message}`);
      throw e;
    }
  }

  const rs = ws.redeemers();
  return {
    txId,
    network,
    fee: body.fee().to_str(),
    inputs,
    collateral,
    ...(cr ? { collateralReturn: held(cr, network, 'the collateral return pays') } : {}),
    ...(body.total_collateral() ? { totalCollateral: body.total_collateral()!.to_str() } : {}),
    referenceInputs,
    outputs,
    mint,
    certificates,
    withdrawals,
    requiredSigners,
    validity: { ...(from ? { from } : {}), ...(until ? { until } : {}) },
    ...(body.auxiliary_data_hash() ? { metadataHash: body.auxiliary_data_hash()!.to_hex() } : {}),
    ...(body.script_data_hash() ? { scriptDataHash: body.script_data_hash()!.to_hex() } : {}),
    plutusScripts: list(ws.plutus_scripts()).map((s) => s.hash().to_hex()),
    redeemers: list(rs).map((r) => ({ tag: CSL.RedeemerTagKind[r.tag().kind()]!, index: r.index().to_str(), mem: r.ex_units().mem().to_str(), steps: r.ex_units().steps().to_str() })),
    needs: [...needs.values()],
    ...(lock ? { lock } : {}),
  };
}

/** The signatures a wallet sent back (a CIP-30 witness set, hex), each checked: needed, and over this body. */
export function checkWitnessSet(txHex: string, witnessSetHex: string, needs: readonly string[]): { key: string; witness: string }[] {
  const tx = CSL.FixedTransaction.from_hex(txHex);
  const bodyHash = tx.transaction_hash().to_bytes();
  let ws: CSL.TransactionWitnessSet;
  try {
    if (typeof witnessSetHex !== 'string' || !/^([0-9a-f]{2})+$/i.test(witnessSetHex)) throw new Error('not hex');
    ws = CSL.TransactionWitnessSet.from_hex(witnessSetHex);
  } catch {
    throw new Refused('the wallet did not send a witness set');
  }
  if (ws.native_scripts()?.len() || ws.plutus_scripts()?.len() || ws.plutus_data()?.len() || ws.redeemers()?.len() || ws.bootstraps()?.len()) throw new Refused('the wallet sent more than signatures: only key signatures are kept');
  const vkeys = list(ws.vkeys());
  if (!vkeys.length) throw new Refused('the wallet signed with none of the keys this transaction needs: switch to the wallet that holds one');
  return vkeys.map((v) => {
    const pub = v.vkey().public_key();
    const key = pub.hash().to_hex();
    if (!needs.includes(key)) throw new Refused(`the wallet signed with key ${key}, which this transaction does not need: nothing from this wallet was kept`);
    if (!pub.verify(bodyHash, v.signature())) throw new Refused(`the signature from key ${key} is not over this transaction's body: the wallet signed other bytes, so the body it saw had another hash. Nothing from this wallet was kept`);
    return { key, witness: v.to_hex() };
  });
}

/** The signatures kept for one transaction (<step>.witnesses.json). */
export interface WitnessFile {
  txId: string;
  witnesses: Record<string, string>;
}

/** The signatures kept so far, and the new ones: all for the same body, or none are kept. */
export function addWitnesses(file: WitnessFile | null, txId: string, rows: { key: string; witness: string }[]): WitnessFile {
  if (file && file.txId !== txId) throw new Refused(`the transaction changed between signatures: the ones kept are for ${file.txId}, this one is ${txId}. Delete the witnesses file and sign again`);
  const witnesses = { ...(file?.witnesses ?? {}) };
  for (const r of rows) witnesses[r.key] = r.witness;
  return { txId, witnesses };
}

/** The keys still to sign. */
export const missing = (r: Pick<Review, 'needs'>, file: WitnessFile | null) => r.needs.map((n) => n.key).filter((k) => !file?.witnesses[k]);

/** The signed transaction: the unsigned bytes as written, and every needed signature, each checked again. */
export function assemble(txHex: string, file: WitnessFile | null, needs: readonly string[]): string {
  const tx = CSL.FixedTransaction.from_hex(txHex);
  const txId = tx.transaction_hash().to_hex();
  if (!file) throw new Refused('no one has signed this transaction yet');
  if (file.txId !== txId) throw new Refused(`the transaction changed between signatures: the ones kept are for ${file.txId}, this one is ${txId}. Delete the witnesses file and sign again`);
  const left = needs.filter((k) => !file.witnesses[k]);
  if (left.length) throw new Refused(`still to sign: ${left.join(', ')}`);
  for (const [key, w] of Object.entries(file.witnesses)) {
    const ws = CSL.TransactionWitnessSet.new();
    const vs = CSL.Vkeywitnesses.new();
    vs.add(CSL.Vkeywitness.from_hex(w));
    ws.set_vkeys(vs);
    const [ok] = checkWitnessSet(txHex, ws.to_hex(), needs);
    if (ok!.key !== key) throw new Refused(`the signature kept under ${key} is from ${ok!.key}`);
    tx.add_vkey_witness(CSL.Vkeywitness.from_hex(w));
  }
  return tx.to_hex();
}

/** The output `ix` of a transaction in this run, for the inputs a chain of unsent transactions spends. */
export function outputOf(txHex: string, ix: number): string | undefined {
  const outs = CSL.FixedTransaction.from_hex(txHex).body().outputs();
  return ix < outs.len() ? outs.get(ix).to_hex() : undefined;
}

/** The payment key hashes of a wallet's addresses (CIP-30: hex), each on the run's network. */
export function walletKeys(addressesHex: unknown, network: 0 | 1): string[] {
  if (!Array.isArray(addressesHex)) throw new Refused('the wallet sent no addresses');
  const keys = new Set<string>();
  for (const h of addressesHex.slice(0, 500)) {
    let a: CSL.Address;
    try {
      a = CSL.Address.from_hex(String(h));
    } catch {
      continue;
    }
    if (a.network_id() !== network) throw new Refused(`the wallet's address ${a.to_bech32(undefined)} is on ${networkName(a.network_id())}, and this run's inputs say ${networkName(network)}`);
    const k = a.payment_cred()?.to_keyhash()?.to_hex();
    if (k) keys.add(k);
  }
  return [...keys];
}

/** The deploy's steps, in the order they run (scripts/deploy.ts). */
export const DEPLOY_STEPS: readonly string[] = ['lock', 'init', ...REF_ORDER.map((n) => `ref-${n}`), 'register'];

/** Steps as the page lists them: the deploy's in the order they run, then the rest by name. */
export function runOrder(steps: string[]): string[] {
  const rank = (s: string) => (DEPLOY_STEPS.includes(s) ? DEPLOY_STEPS.indexOf(s) : DEPLOY_STEPS.length);
  return [...steps].sort((a, b) => rank(a) - rank(b) || (a < b ? -1 : a > b ? 1 : 0));
}

const adaText = (lovelace: string) => {
  const n = BigInt(lovelace);
  const part = n % 1_000_000n ? `.${(n % 1_000_000n).toString().padStart(6, '0').replace(/0+$/, '')}` : '';
  return `${n / 1_000_000n}${part} ADA`;
};

/**
 * A deploy step read from its own bytes against scripts.json (`s`) and the run's inputs: what it
 * mints, where each output goes and what it holds, what it registers, who must sign. Every output
 * that is not the step's own must be the deployer's plain change. Anything else is refused.
 * Returns what the step does, in plain words.
 */
export function readDeployStep(step: string, txHex: string, s: Scripts, i: DeployInputs): string[] {
  function no(why: string): never {
    throw new Refused(`${step} is refused: ${why}`);
  }
  if (!DEPLOY_STEPS.includes(step)) no('it is not a step of the deploy');
  const network = i.network;
  const body = CSL.FixedTransaction.from_hex(txHex).body();
  const a = addresses(i, s);
  const outs = list(body.outputs());
  const at = (o: CSL.TransactionOutput) => o.address().to_bech32(undefined);
  const tokens = (o: CSL.TransactionOutput) => coinsOf(o.amount().multiasset());
  const onlyToken = (o: CSL.TransactionOutput, policy: string, name: string) => {
    const c = tokens(o);
    return c.length === 1 && c[0]!.policy === policy && c[0]!.name === name && c[0]!.quantity === '1';
  };
  const holding = (policy: string, name: string) => outs.filter((o) => tokens(o).some((c) => c.policy === policy && c.name === name));
  const mint: { policy: string; name: string; quantity: string }[] = [];
  const m = body.mint();
  for (const p of list(m?.keys())) for (const assets of list(m!.get(p))) for (const n of list(assets?.keys())) mint.push({ policy: p.to_hex(), name: Buffer.from(n.name()).toString('hex'), quantity: assets!.get(n)!.to_str() });
  const mints = (want: [string, string][]) => mint.length === want.length && want.every(([p, n]) => mint.some((x) => x.policy === p && x.name === n && x.quantity === '1'));
  const certs = list(body.certs());
  const signers = list(body.required_signers()).map((k) => k.to_hex());
  const spends = list(body.inputs()).map(refKey);
  if (body.withdrawals()?.len()) no('it withdraws rewards');
  if (body.reference_inputs()?.len()) no('it reads reference inputs');
  if (body.auxiliary_data_hash()) no('it carries metadata');
  const cr = body.collateral_return();
  if (cr && at(cr) !== i.deployer) no(`its collateral returns to ${at(cr)}, not the deployer`);
  /** Every output but the step's own is the deployer's plain ADA change. */
  const change = (own: CSL.TransactionOutput[]) =>
    outs.forEach((o, k) => {
      if (own.includes(o)) return;
      if (at(o) !== i.deployer || tokens(o).length || o.plutus_data() || o.data_hash() || o.script_ref()) no(`output #${k} pays ${at(o)} and is not the deployer's plain change`);
    });

  if (step === 'lock') {
    if (!mints([[s.lock.hash, NAMES.lock]])) no(`it does not mint exactly one lock token under the lock's policy ${s.lock.hash}`);
    if (certs.length) no('it holds a certificate');
    if (!spends.includes(i.lockSeedTxIn)) no(`it does not spend the lock seed ${i.lockSeedTxIn}`);
    if (signers.length !== 2 || !signers.includes(i.ownerA) || !signers.includes(i.ownerB)) no('its required signers are not exactly the two owners');
    const [lock, ...more] = holding(s.lock.hash, NAMES.lock);
    if (!lock || more.length) no('the lock token does not go to exactly one output');
    if (at(lock) !== a.lock) no(`the lock token goes to ${at(lock)}, not the lock ${a.lock}`);
    if (!onlyToken(lock, s.lock.hash, NAMES.lock) || lock.script_ref()) no('the lock holds more than its token and ADA');
    if (!isEmptyLockState(lock.plutus_data())) no('the lock does not start with nothing announced');
    change([lock]);
    return [
      `mints the lock token once (policy ${s.lock.hash}, "role-timelock"), spending the lock seed ${i.lockSeedTxIn}`,
      `into the lock ${a.lock}, with ${adaText(lock.amount().coin().to_str())}, nothing announced`,
      `both owners sign: owner A ${i.ownerA}, owner B ${i.ownerB}`,
    ];
  }
  if (step === 'init') {
    if (!mints([[s.authen.hash, NAMES.factory], [s.authen.hash, NAMES.globalSetting]])) no(`it does not mint exactly the factory token and the GlobalSetting token under the authen policy ${s.authen.hash}`);
    if (certs.length || signers.length) no('it holds a certificate or names a required signer');
    if (!spends.includes(i.seedTxIn)) no(`it does not spend the authen seed ${i.seedTxIn}`);
    const [factory, ...f2] = holding(s.authen.hash, NAMES.factory);
    const [gs, ...g2] = holding(s.authen.hash, NAMES.globalSetting);
    if (!factory || f2.length || !gs || g2.length) no('the factory token and the GlobalSetting token do not each go to exactly one output');
    if (at(factory) !== a.factory) no(`the factory token goes to ${at(factory)}, not the factory ${a.factory}`);
    if (!onlyToken(factory, s.authen.hash, NAMES.factory) || factory.script_ref()) no('the factory output holds more than its token and ADA');
    if (factory.plutus_data()?.to_hex() !== factoryDatum().to_hex()) no("the factory's datum is not Minswap's empty list");
    if (at(gs) !== a.globalSetting) no(`the GlobalSetting token goes to ${at(gs)}, not the authen script ${a.globalSetting}`);
    if (!onlyToken(gs, s.authen.hash, NAMES.globalSetting) || gs.script_ref()) no('the GlobalSetting output holds more than its token and ADA');
    const d = gs.plutus_data();
    if (!d) no('the GlobalSetting has no inline datum');
    let setting: ReturnType<typeof decodeSetting>;
    try {
      setting = decodeSetting(d);
      checkSetting(setting, { network: network as 0 | 1, lock: s.lock.hash, authen: s.authen.hash, pool: s.pool.hash, ownerA: i.ownerA, ownerB: i.ownerB, treasury: i.treasury });
    } catch (e) {
      if (e instanceof LockRefused || e instanceof DecodeError) no(`its GlobalSetting: ${e.message}`);
      throw e;
    }
    const [b, ...b2] = setting.batchers;
    if (!b || b2.length || b.kind !== 'signature' || b.hash !== i.batcherKeyHash) no(`its GlobalSetting's batchers are not exactly our batcher key ${i.batcherKeyHash}: ${setting.batchers.map((x) => `${x.kind} ${x.hash}`).join(', ')}`);
    if (setting.openingFee !== i.openingFee) no(`its GlobalSetting's opening fee is ${setting.openingFee} lovelace, not the inputs' ${i.openingFee}`);
    change([factory, gs]);
    return [
      `mints the factory token (MSF) and the GlobalSetting token (MSGS) once, under the authen policy ${s.authen.hash}, spending the authen seed ${i.seedTxIn}`,
      `the factory: ${a.factory}, Minswap's empty list`,
      `the GlobalSetting, at ${a.globalSetting}:`,
      `batcher: key ${b.hash}, our batcher key`,
      `admin, pool-fee updater, fee-share taker, stake-key updater and dynamic-fee updater: all the lock, script ${s.lock.hash}`,
      `opening fee: ${adaText(setting.openingFee.toString())} (${setting.openingFee} lovelace), paid to the treasury ${i.treasury}`,
    ];
  }
  if (step === 'register') {
    if (mint.length || signers.length) no('it mints or names a required signer');
    const [c, ...c2] = certs;
    const reg = c?.as_stake_registration();
    const cred = reg?.stake_credential();
    if (!c || c2.length || c.kind() !== CSL.CertificateKind.StakeRegistration || !reg || reg.coin() !== undefined || cred?.kind() !== CSL.CredKind.Script || cred.to_scripthash()?.to_hex() !== s.poolBatching.hash) no(`it does not hold exactly the legacy registration of the pool-batching script ${s.poolBatching.hash}`);
    change([]);
    return [`registers the pool-batching script's reward account ${a.poolBatchingReward} (script ${s.poolBatching.hash}); its deposit stays with the account`];
  }
  const name = step.slice('ref-'.length) as (typeof REF_ORDER)[number];
  if (mint.length || certs.length || signers.length) no('it mints, holds a certificate or names a required signer');
  const [ref, ...r2] = outs.filter((o) => o.script_ref());
  if (!ref || r2.length) no('it does not publish exactly one reference script');
  const ps = ref.script_ref()!.plutus_script();
  if (!ps || ps.hash().to_hex() !== s[name].hash) no(`its reference script is not scripts.json's ${name}, ${s[name].hash}`);
  if (at(ref) !== burnAddress(network)) no(`its reference script goes to ${at(ref)}, not the address no key can spend, ${burnAddress(network)}`);
  if (tokens(ref).length || ref.plutus_data() || ref.data_hash()) no('the reference script output holds more than ADA');
  change([ref]);
  return [`publishes the ${name} script ${s[name].hash} (${ps.bytes().length} bytes) as a reference script`, `at ${burnAddress(network)}, which no key can spend: its ${adaText(ref.amount().coin().to_str())} stays there for good`];
}
