// The sweep (the owner's ruling, 2026-10-27): what the batcher holds above its float goes to the
// two-key treasury, instead of the batcher stopping at its cap. One plain transaction, no scripts:
// in, the batcher's own plain ADA UTxOs (never a collateral, never one a batch in flight spends);
// out, `keep` back to its own enterprise address (its next float, in two UTxOs once keep is at
// least two fee UTxOs, so two pools can batch at once), and the rest, less the ledger's own
// minimum fee, to the treasury.
// The treasury is the role timelock's `treasury` (cardano/role-timelock), the same address,
// named in the settings with its scripts: a base address (its payment and its stake part each a
// script) or an enterprise one (no stake part). Each script must need at least two distinct keys,
// be one they can satisfy, and not name the batcher's own key; a one-key wallet or stake part, a
// stake address, a time lock, "any of", n above its keys, or a script the address is not paid to
// is refused. Before the key signs, the built transaction is read back (verifySweep): it may
// spend only the UTxOs chosen, pay only those outputs, exactly, and do nothing else (no mint,
// certificate, withdrawal, vote, proposal, donation, collateral, reference input or extra
// signer), for a fee of at most MAX_SWEEP_FEE, whatever a source says the fees are.
import CSL from '@emurgo/cardano-serialization-lib-nodejs';
import { builderConfig, isPlainBatcherUtxo, type ProtocolParams } from './build.ts';
import { refKey } from './chain.ts';
import { shallowCbor } from './cbor.ts';
import { ledgerMinFee } from './fee.ts';
import type { Utxo } from './plan.ts';

export interface Treasury {
  /** The treasury's address, as the role timelock names it (bech32). */
  address: string;
  /** Its payment script: a native script, as hex. */
  script: string;
  /** Its stake part's script, for a base address. */
  stakeScript?: string;
}

/** At most this many UTxOs in one sweep: bounded bytes, whatever anyone sends the batcher. */
export const MAX_SWEEP_INPUTS = 50;
/** Less than this above the float is not worth a transaction. */
export const MIN_SWEEP = 5_000_000n;
/**
 * 50 inputs pay about 0.25 ADA at mainnet's fees: a sweep asked to pay more than this (a source
 * reporting fees wrong) is refused before it is signed, never paid.
 */
export const MAX_SWEEP_FEE = 500_000n;
/** The smallest float a batch pays from (src/watcher.ts): each output kept back is at least this. */
export const MIN_FLOAT = 10_000_000n;

/** What is kept back: two floats once keep is two of them, so two pools can have batches in flight. */
export const floatsOf = (keep: bigint): bigint[] => (keep >= 2n * MIN_FLOAT ? [keep - keep / 2n, keep / 2n] : [keep]);

/** One of the treasury's scripts, checked against the hash it must have: at least two distinct keys, all of them, or n of them with n no more than the keys. */
function checkKeysScript(hex: unknown, hash: string, name: string, batcherKeyHash: string): string {
  if (typeof hex !== 'string' || !/^([0-9a-f]{2})+$/.test(hex) || !shallowCbor(hex)) throw new Error(`settings: sweep.${name} is not a script, as hex`);
  let s: CSL.NativeScript;
  try {
    s = CSL.NativeScript.from_hex(hex);
  } catch {
    throw new Error(`settings: sweep.${name} is not a native script`);
  }
  if (s.hash().to_hex() !== hash) throw new Error(`settings: sweep.${name} is not the script sweep.treasury's address names`);
  const all = s.as_script_all();
  const nOfK = s.as_script_n_of_k();
  const parts = all?.native_scripts() ?? nOfK?.native_scripts();
  if (!parts) throw new Error(`settings: sweep.${name} must be "all of" or "at least n of" its keys`);
  const keys: string[] = [];
  for (let i = 0; i < parts.len(); i++) {
    const k = parts.get(i).as_script_pubkey()?.addr_keyhash().to_hex();
    if (!k) throw new Error(`settings: every part of sweep.${name} must be a key (no time lock, no script inside it)`);
    keys.push(k);
  }
  // One key twice is one key: one signature would answer for both.
  if (new Set(keys).size !== keys.length) throw new Error(`settings: sweep.${name} names one key twice`);
  const needs = all ? keys.length : nOfK!.n();
  if (needs < 2) throw new Error(`settings: sweep.${name} needs ${needs} key${needs === 1 ? '' : 's'} to sign: it must need at least two`);
  if (needs > keys.length) throw new Error(`settings: sweep.${name} needs ${needs} of its ${keys.length} keys: no one could ever spend from it`);
  // The hot key as one of the treasury's keys: whoever took it would need one key less.
  if (keys.includes(batcherKeyHash)) throw new Error(`settings: sweep.${name} names the batcher's own key: the treasury must not lean on the hot key`);
  return hex;
}

/** The treasury from the settings, checked; what is wrong is said by name. */
export function checkTreasury(t: { address?: unknown; script?: unknown; stakeScript?: unknown }, network: number, batcherKeyHash: string): Treasury {
  if (typeof t.address !== 'string' || typeof t.script !== 'string') throw new Error("settings: sweep.treasury and sweep.treasuryScript must be the treasury's address and its payment script, as hex");
  let a: CSL.Address;
  try {
    a = CSL.Address.from_bech32(t.address);
  } catch {
    throw new Error('settings: sweep.treasury is not an address');
  }
  if (a.network_id() !== network) throw new Error('settings: sweep.treasury is not a mainnet address');
  const base = CSL.BaseAddress.from_address(a);
  const enterprise = CSL.EnterpriseAddress.from_address(a);
  if (!base && !enterprise) throw new Error('settings: sweep.treasury must be a payment address (base or enterprise), never a stake address');
  const paidTo = a.payment_cred()?.to_scripthash()?.to_hex();
  if (!paidTo) throw new Error('settings: sweep.treasury is paid to one key, not a script: the treasury is the two-key wallet');
  const script = checkKeysScript(t.script, paidTo, 'treasuryScript', batcherKeyHash);
  if (enterprise) {
    if (t.stakeScript !== undefined) throw new Error('settings: sweep.treasury has no stake part, so sweep.treasuryStakeScript must not be given');
    return { address: t.address, script };
  }
  // Whoever holds the stake part chooses where the treasury's ADA is staked, and takes its rewards.
  const stakedTo = base!.stake_cred().to_scripthash()?.to_hex();
  if (!stakedTo) throw new Error("settings: sweep.treasury's stake part is one key: it must be the wallet's stake script, needing two keys as well");
  return { address: t.address, script, stakeScript: checkKeysScript(t.stakeScript, stakedTo, 'treasuryStakeScript', batcherKeyHash) };
}

export interface SweepRequest {
  batcher: { keyHash: string; address: string };
  treasury: Treasury;
  /** Plain ADA UTxOs at the batcher's key it may spend: never its collateral, never one in flight. */
  utxos: Utxo[];
  /** Left at the batcher's own address, as its next float (floatsOf: in one or two UTxOs). */
  keep: bigint;
  validToSlot: bigint;
}

export interface PreparedSweep {
  txHex: string;
  /** The UTxOs it spends, and what they hold. */
  refs: string[];
  inputs: bigint;
  /** To the treasury. */
  amount: bigint;
  fee: bigint;
}

const coin = (u: Utxo) => BigInt(CSL.TransactionOutput.from_hex(u.outputHex).amount().coin().to_str());
const big = (n: bigint) => CSL.BigNum.from_str(n.toString());
const parseRef = (ref: string) => {
  const [tx, ix] = ref.split('#');
  return CSL.TransactionInput.new(CSL.TransactionHash.from_hex(tx!), Number(ix));
};

/**
 * The sweep, built, its fee at least the ledger's own minimum, and read back; or null when what
 * may be spent is not at least MIN_SWEEP above `keep`. The largest UTxOs first, at most
 * MAX_SWEEP_INPUTS of them.
 */
export function buildSweep(req: SweepRequest, pp: ProtocolParams): PreparedSweep | null {
  for (const u of req.utxos) if (!isPlainBatcherUtxo(u, req.batcher.keyHash)) throw new Error(`${u.ref} is not plain ADA at the batcher's own key: never swept`);
  const chosen = [...req.utxos].sort((a, b) => (coin(a) > coin(b) ? -1 : coin(a) < coin(b) ? 1 : 0)).slice(0, MAX_SWEEP_INPUTS);
  const total = chosen.reduce((s, u) => s + coin(u), 0n);
  if (total - req.keep < MIN_SWEEP) return null;
  const known = Object.fromEntries(chosen.map((u) => [u.ref, u.outputHex]));
  const build = (minFee: bigint) => {
    const b = CSL.TransactionBuilder.new(builderConfig(pp));
    const ins = CSL.TxInputsBuilder.new();
    for (const u of chosen) {
      const o = CSL.TransactionOutput.from_hex(u.outputHex);
      ins.add_regular_input(o.address(), parseRef(u.ref), o.amount());
    }
    b.set_inputs(ins);
    for (const f of floatsOf(req.keep)) b.add_output(CSL.TransactionOutput.new(CSL.Address.from_bech32(req.batcher.address), CSL.Value.new(big(f))));
    b.set_ttl_bignum(big(req.validToSlot));
    if (minFee > 0n) b.set_min_fee(big(minFee));
    // The rest, less the fee, is the treasury's.
    if (!b.add_change_if_needed(CSL.Address.from_bech32(req.treasury.address))) throw new Error('the sweep cannot pay its fee');
    return b.build_tx();
  };
  let tx = build(0n);
  const min = ledgerMinFee(tx.to_hex(), known, pp);
  if (BigInt(tx.body().fee().to_str()) < min) tx = build(min);
  const fee = BigInt(tx.body().fee().to_str());
  const txHex = tx.to_hex();
  const refs = chosen.map((u) => u.ref);
  const amount = total - req.keep - fee;
  verifySweep(txHex, { refs, inputs: total, keep: req.keep, batcherAddress: req.batcher.address, treasuryAddress: req.treasury.address });
  return { txHex, refs, inputs: total, amount, fee };
}

/**
 * The money check before the key signs: the transaction spends exactly `refs` (worth `inputs`),
 * pays exactly `keep` to the batcher's own address (floatsOf) and the rest, less a fee of at most
 * MAX_SWEEP_FEE, to the treasury, in ADA alone, and does nothing else. Throws what is wrong.
 */
export function verifySweep(txHex: string, x: { refs: string[]; inputs: bigint; keep: bigint; batcherAddress: string; treasuryAddress: string }): void {
  const fail = (why: string): never => {
    throw new Error(`the sweep is not what it should be: ${why}`);
  };
  const tx = CSL.FixedTransaction.from_hex(txHex);
  const body = tx.body();
  const ins = body.inputs();
  const spent = Array.from({ length: ins.len() }, (_, i) => refKey(ins.get(i)));
  if (spent.length !== x.refs.length || new Set(spent).size !== spent.length || !spent.every((r) => x.refs.includes(r))) fail('it spends other UTxOs than those chosen');
  const outs = body.outputs();
  const floats = floatsOf(x.keep);
  if (outs.len() !== floats.length + 1) fail(`it has ${outs.len()} outputs, not ${floats.length + 1}`);
  const fee = BigInt(body.fee().to_str());
  if (fee > MAX_SWEEP_FEE) fail(`its fee of ${fee} lovelace is more than ${MAX_SWEEP_FEE}`);
  const batcher = CSL.Address.from_bech32(x.batcherAddress).to_hex();
  const treasury = CSL.Address.from_bech32(x.treasuryAddress).to_hex();
  const who = new Map([[batcher, "the batcher's own address"], [treasury, 'the treasury']]);
  const want = [...floats.map((coin) => ({ to: batcher, coin })), { to: treasury, coin: x.inputs - x.keep - fee }];
  for (let i = 0; i < outs.len(); i++) {
    const o = outs.get(i);
    const to = o.address().to_hex();
    const coin = BigInt(o.amount().coin().to_str());
    if (!who.has(to)) fail(`output ${i} pays an address that is neither the treasury nor the batcher's own`);
    const w = want.find((v) => v.to === to && v.coin === coin);
    if (!w) {
      const left = want.filter((v) => v.to === to).map((v) => v.coin);
      fail(`${who.get(to)} is paid ${coin} lovelace, not ${left.length ? left.join(' or ') : 'anything more'}`);
    }
    want.splice(want.indexOf(w!), 1);
    if (o.amount().multiasset()?.len()) fail(`output ${i} carries tokens`);
    if (o.has_plutus_data() || o.has_data_hash() || o.has_script_ref()) fail(`output ${i} carries a datum or a script`);
  }
  const extras: [string, unknown][] = [
    ['a mint', body.mint()],
    ['certificates', body.certs()],
    ['withdrawals', body.withdrawals()],
    ['collateral', body.collateral()],
    ['a collateral return', body.collateral_return()],
    ['a total collateral', body.total_collateral()],
    ['reference inputs', body.reference_inputs()],
    ['required signers', body.required_signers()],
    ['votes', body.voting_procedures()],
    ['proposals', body.voting_proposals()],
    ['a treasury value', body.current_treasury_value()],
    ['a donation', body.donation()],
    ['a protocol update', body.update()],
    ['metadata', body.auxiliary_data_hash()],
    ['a script data hash', body.script_data_hash()],
  ];
  for (const [what, v] of extras) if (v !== undefined) fail(`it carries ${what}`);
  const w = tx.witness_set();
  if (w.native_scripts() || w.plutus_scripts() || w.redeemers() || w.plutus_data()) fail('it carries scripts or data');
}
