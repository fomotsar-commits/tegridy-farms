// Test helper: a real batch with one thing changed, rebuilt with CSL. Signatures are left as
// they were (the verifier reads the batch's terms, not its signatures), so each tamper tests
// exactly one rule the verifier must enforce.
import CSL from '@emurgo/cardano-serialization-lib-nodejs';
import { fieldsOf, mkBytes, mkConstr, mkInt, type PlutusData } from '../src/plutus.ts';

function rebuildBody(body: CSL.TransactionBody, outputs: CSL.TransactionOutputs): CSL.TransactionBody {
  const b = CSL.TransactionBody.new_tx_body(body.inputs(), outputs, body.fee());
  const ttl = body.ttl_bignum();
  if (ttl) b.set_ttl(ttl);
  const start = body.validity_start_interval_bignum();
  if (start) b.set_validity_start_interval_bignum(start);
  const w = body.withdrawals();
  if (w) b.set_withdrawals(w);
  const rs = body.required_signers();
  if (rs) b.set_required_signers(rs);
  const ri = body.reference_inputs();
  if (ri) b.set_reference_inputs(ri);
  const c = body.collateral();
  if (c) b.set_collateral(c);
  const cr = body.collateral_return();
  if (cr) b.set_collateral_return(cr);
  const tc = body.total_collateral();
  if (tc) b.set_total_collateral(tc);
  const sdh = body.script_data_hash();
  if (sdh) b.set_script_data_hash(sdh);
  const n = body.network_id();
  if (n) b.set_network_id(n);
  return b;
}

function rebuildOutput(o: CSL.TransactionOutput, change: { value?: CSL.Value; address?: CSL.Address; datum?: PlutusData }): CSL.TransactionOutput {
  const out = CSL.TransactionOutput.new(change.address ?? o.address(), change.value ?? o.amount());
  const inline = change.datum ?? o.plutus_data();
  if (inline) out.set_plutus_data(inline);
  else if (o.data_hash()) out.set_data_hash(o.data_hash()!);
  if (o.script_ref()) out.set_script_ref(o.script_ref()!);
  return out;
}

export function withOutput(txHex: string, index: number, change: (o: CSL.TransactionOutput) => { value?: CSL.Value; address?: CSL.Address; datum?: PlutusData }): string {
  const tx = CSL.Transaction.from_hex(txHex);
  const body = tx.body();
  const outs = CSL.TransactionOutputs.new();
  for (let i = 0; i < body.outputs().len(); i++) {
    const o = body.outputs().get(i);
    outs.add(i === index ? rebuildOutput(o, change(o)) : o);
  }
  return CSL.Transaction.new(rebuildBody(body, outs), tx.witness_set(), tx.auxiliary_data()).to_hex();
}

/** The value with `delta` added to the lovelace. */
export function plusLovelace(v: CSL.Value, delta: bigint): CSL.Value {
  const out = CSL.Value.from_hex(v.to_hex());
  out.set_coin(CSL.BigNum.from_str((BigInt(v.coin().to_str()) + delta).toString()));
  return out;
}

/** The value with `delta` added to its first token. */
export function plusFirstToken(v: CSL.Value, delta: bigint): CSL.Value {
  const ma = v.multiasset()!;
  const policy = ma.keys().get(0);
  const assets = ma.get(policy)!;
  const name = assets.keys().get(0);
  const next = CSL.MultiAsset.new();
  for (let i = 0; i < ma.keys().len(); i++) next.insert(ma.keys().get(i), ma.get(ma.keys().get(i))!);
  const changed = CSL.Assets.new();
  for (let j = 0; j < assets.keys().len(); j++) {
    const n = assets.keys().get(j);
    const q = BigInt(assets.get(n)!.to_str());
    changed.insert(n, CSL.BigNum.from_str((j === 0 ? q + delta : q).toString()));
  }
  next.insert(policy, changed);
  void name;
  return CSL.Value.new_with_assets(v.coin(), next);
}

/** The value with one unit of a token from an unrelated policy added. */
export function plusStrayToken(v: CSL.Value): CSL.Value {
  const ma = v.multiasset() ?? CSL.MultiAsset.new();
  const next = CSL.MultiAsset.from_hex(ma.to_hex());
  const assets = CSL.Assets.new();
  assets.insert(CSL.AssetName.new(Buffer.from('7374726179', 'hex')), CSL.BigNum.from_str('1'));
  next.insert(CSL.ScriptHash.from_hex('aa'.repeat(28)), assets);
  return CSL.Value.new_with_assets(v.coin(), next);
}

/** A PoolDatum with field `index` (an integer) moved by `delta`. */
export function poolDatumPlus(d: PlutusData, index: number, delta: bigint): PlutusData {
  const f = fieldsOf(d, 0, 10, 'PoolDatum');
  return mkConstr(
    0,
    f.map((x, i) => (i === index ? mkInt(BigInt(x.as_integer()!.to_str()) + delta) : x)),
  );
}

/** The batch with the batching redeemer's input_indexes reversed. */
export function withReversedIndexes(txHex: string): string {
  const tx = CSL.Transaction.from_hex(txHex);
  const ws = tx.witness_set();
  const rs = ws.redeemers()!;
  const next = CSL.Redeemers.new();
  for (let i = 0; i < rs.len(); i++) {
    const r = rs.get(i);
    let data = r.data();
    try {
      const f = fieldsOf(data, 0, 5, 'PoolBatchingRedeemer');
      const idx = Buffer.from(f[2]!.as_bytes()!);
      data = mkConstr(0, [f[0]!, f[1]!, mkBytes(Buffer.from([...idx].reverse()).toString('hex')), f[3]!, f[4]!]);
    } catch {
      /* not the batching redeemer */
    }
    next.add(CSL.Redeemer.new(r.tag(), r.index(), data, r.ex_units()));
  }
  ws.set_redeemers(next);
  return CSL.Transaction.new(tx.body(), ws, tx.auxiliary_data()).to_hex();
}
