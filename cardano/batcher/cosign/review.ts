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
//     pool and the treasury's whole address.
import CSL from '@emurgo/cardano-serialization-lib-nodejs';
import { MAINNET_TIME, PREPROD_TIME, refKey, slotToPosixMs } from '../src/chain.ts';
import { LockRefused, readLockTx, type LockDeployment, type LockReading } from '../src/lock.ts';
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
