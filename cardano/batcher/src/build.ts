// Builds one batch transaction from a plan (src/plan.ts) with EMURGO's TransactionBuilder.
// Unsigned: the key signs elsewhere, after the batch has been simulated and read back.
// Layout, as pool_validator.ak and order_validation.ak require it:
//   inputs   the pool and every order (Plutus, reference scripts), the batcher's fee UTxOs
//   outputs  each order's output in processing order, then the pool, then the batcher's change
//   reference inputs  the global setting, the three reference scripts
//   withdrawal  the pool-batching script's whole reward balance (normally 0), its redeemer the
//               batch's instructions
//   required signer  the batcher's key; collateral from one pure-ADA batcher UTxO
// The fee is the larger of EMURGO's estimate and the ledger's own minimum (src/fee.ts).
import CSL from '@emurgo/cardano-serialization-lib-nodejs';
import { ContractFailure } from './math.ts';
import { DecodeError, mkConstr, type PlutusData } from './plutus.ts';
import { addressToCsl, batchingRedeemer, compareRefs, parseRef, type PlannedBatch, type Utxo } from './plan.ts';
import { Unsupported } from './engine.ts';
import { ledgerMinFee, rational } from './fee.ts';
import type { Value } from './value.ts';

export interface ProtocolParams {
  txFeePerByte: number;
  txFeeFixed: number;
  utxoCostPerByte: number;
  maxTxSize: number;
  maxValueSize: number;
  collateralPercentage: number;
  /** As published: a number (Koios) or an "n/d" string (Ogmios). */
  executionUnitPrices: { priceMemory: number | string; priceSteps: number | string };
  minFeeRefScriptCostPerByte: number | string;
  stakeAddressDeposit: number;
  stakePoolDeposit: number;
  costModelPlutusV2: number[];
  /** Needed once any script a batch runs is Plutus V3 (the order contract may be upgraded to one). */
  costModelPlutusV3?: number[];
  /** The most one transaction's scripts may use, together. */
  maxTxExecutionUnits: { memory: number; steps: number };
}

export interface ExUnits {
  mem: bigint;
  steps: bigint;
}

export interface BatchTxRequest {
  network: number;
  plan: PlannedBatch;
  pool: Utxo;
  /** In processing order, as planned. */
  orders: Utxo[];
  fees: bigint[];
  globalSetting: Utxo;
  /** The UTxOs carrying each script as a reference script. */
  scripts: { pool: Utxo; order: Utxo; poolBatching: Utxo };
  /**
   * What the pool-batching script's reward account holds, read from the chain for this batch.
   * The ledger only lets a withdrawal take the whole balance; anyone can pay into the account
   * (a governance deposit's refund names any reward account), so it is not assumed to be 0.
   */
  batchingRewardBalance: bigint;
  batcher: { keyHash: string; address: string; feeUtxos: Utxo[]; collateral: Utxo };
  batcherIndex: number;
  volFee: bigint | null;
  validFromSlot: bigint;
  validToSlot: bigint;
  /** Per redeemer, keyed "spend:<ledger index>" or "reward:0"; missing ones use generous placeholders. */
  budgets: ReadonlyMap<string, ExUnits>;
}

/**
 * The batch is bigger than one transaction may be (bytes, or what its scripts need): take fewer
 * orders. A batch of one order that is too big means that order can never be batched.
 */
export class BatchTooBig extends Error {}

const PLACEHOLDER: Record<'spend' | 'reward', ExUnits> = {
  spend: { mem: 1_000_000n, steps: 400_000_000n },
  reward: { mem: 8_000_000n, steps: 3_000_000_000n },
};
/** Collateral pledged above the required share of the fee, so a slightly larger final fee still fits. */
const COLLATERAL_MARGIN = 50_000n;

const big = (n: bigint | number) => CSL.BigNum.from_str(n.toString());

function valueToCsl(v: Value): CSL.Value {
  const ma = CSL.MultiAsset.new();
  let coin = 0n;
  const byPolicy = new Map<string, [string, bigint][]>();
  for (const [unit, q] of v) {
    if (q < 0n) throw new ContractFailure('an output would hold a negative amount');
    if (unit === '') {
      coin = q;
      continue;
    }
    const [policy, name] = unit.split('.') as [string, string];
    byPolicy.set(policy, [...(byPolicy.get(policy) ?? []), [name, q]]);
  }
  for (const [policy, assets] of byPolicy) {
    const a = CSL.Assets.new();
    for (const [name, q] of assets) a.insert(CSL.AssetName.new(Buffer.from(name, 'hex')), big(q));
    ma.insert(CSL.ScriptHash.from_hex(policy), a);
  }
  return byPolicy.size ? CSL.Value.new_with_assets(big(coin), ma) : CSL.Value.new(big(coin));
}

const interval = (x: number | string) => {
  const r = rational(x);
  return CSL.UnitInterval.new(big(r.n), big(r.d));
};

function config(pp: ProtocolParams): CSL.TransactionBuilderConfig {
  return CSL.TransactionBuilderConfigBuilder.new()
    .fee_algo(CSL.LinearFee.new(big(pp.txFeePerByte), big(pp.txFeeFixed)))
    .pool_deposit(big(pp.stakePoolDeposit))
    .key_deposit(big(pp.stakeAddressDeposit))
    .max_value_size(pp.maxValueSize)
    .max_tx_size(pp.maxTxSize)
    .coins_per_utxo_byte(big(pp.utxoCostPerByte))
    .ex_unit_prices(CSL.ExUnitPrices.new(interval(pp.executionUnitPrices.priceMemory), interval(pp.executionUnitPrices.priceSteps)))
    .ref_script_coins_per_byte(interval(pp.minFeeRefScriptCostPerByte))
    .build();
}

/** The cost models of the languages the batch's scripts are written in, and only those (the script data hash covers exactly these). */
function costModels(pp: ProtocolParams, languages: CSL.Language[]): CSL.Costmdls {
  const all = CSL.Costmdls.new();
  for (const lang of languages) {
    const kind = lang.kind();
    if (kind === CSL.LanguageKind.PlutusV1) throw new Unsupported('PlutusV1', 'a Plutus V1 script: this batcher has no V1 cost model');
    const costs = kind === CSL.LanguageKind.PlutusV2 ? pp.costModelPlutusV2 : pp.costModelPlutusV3;
    if (!costs) throw new Unsupported('PlutusV3', 'a Plutus V3 script, and the protocol parameters given carry no V3 cost model');
    const cm = CSL.CostModel.new();
    costs.forEach((v, i) => cm.set(i, v >= 0 ? CSL.Int.new(big(v)) : CSL.Int.new_negative(big(-v))));
    all.insert(lang, cm);
  }
  return all;
}

/** The Plutus script a UTxO carries as its reference script: hash, language and size, read from the UTxO itself. */
export function referenceScriptOf(u: Utxo): { hash: string; language: CSL.Language; size: number } {
  const sr = CSL.TransactionOutput.from_hex(u.outputHex).script_ref();
  const script = sr?.is_plutus_script() ? sr.plutus_script() : undefined;
  if (!script) throw new DecodeError(`${u.ref} carries no Plutus reference script`);
  return { hash: script.hash().to_hex(), language: script.language_version(), size: script.bytes().length };
}

/**
 * A UTxO the batcher may spend, or pledge as collateral: plain ADA at its own key, with no
 * reference script. Anyone can send the batcher a UTxO; one carrying a reference script would
 * make the batch pay for it, one carrying tokens would carry them into it.
 */
export function isPlainBatcherUtxo(u: Utxo, keyHash: string): boolean {
  const o = CSL.TransactionOutput.from_hex(u.outputHex);
  return o.address().payment_cred()?.to_keyhash()?.to_hex() === keyHash && !o.amount().multiasset()?.len() && !o.has_script_ref();
}

const out = (u: Utxo) => CSL.TransactionOutput.from_hex(u.outputHex);
const redeemer = (tag: CSL.RedeemerTag, data: PlutusData, u: ExUnits) => CSL.Redeemer.new(tag, big(0), data, CSL.ExUnits.new(big(u.mem), big(u.steps)));

/** The ledger order of every spent input, for redeemer indexes. */
export function spendIndexes(req: Pick<BatchTxRequest, 'pool' | 'orders' | 'batcher'>): Map<string, number> {
  const refs = [req.pool.ref, ...req.orders.map((o) => o.ref), ...req.batcher.feeUtxos.map((u) => u.ref)].sort(compareRefs);
  return new Map(refs.map((r, i) => [r, i]));
}

function assemble(req: BatchTxRequest, pp: ProtocolParams, totalCollateral: bigint, minFee: bigint): CSL.Transaction {
  const b = CSL.TransactionBuilder.new(config(pp));
  const ix = spendIndexes(req);
  const budget = (key: string, kind: 'spend' | 'reward') => req.budgets.get(key) ?? PLACEHOLDER[kind];
  const applyOrder = mkConstr(0, []); // OrderRedeemer ApplyOrder
  const batching = mkConstr(0, []); // PoolRedeemer Batching
  const scripts = { pool: referenceScriptOf(req.scripts.pool), order: referenceScriptOf(req.scripts.order), poolBatching: referenceScriptOf(req.scripts.poolBatching) };
  const source = (role: keyof typeof scripts) =>
    CSL.PlutusScriptSource.new_ref_input(CSL.ScriptHash.from_hex(scripts[role].hash), parseRef(req.scripts[role].ref), scripts[role].language, scripts[role].size);

  const ins = CSL.TxInputsBuilder.new();
  const poolOut = out(req.pool);
  ins.add_plutus_script_input(
    CSL.PlutusWitness.new_with_ref_without_datum(source('pool'), redeemer(CSL.RedeemerTag.new_spend(), batching, budget(`spend:${ix.get(req.pool.ref)}`, 'spend'))),
    parseRef(req.pool.ref),
    poolOut.amount(),
  );
  const witnessByHash = new Map(req.plan.witnessDatums.map((d) => [CSL.hash_plutus_data(d).to_hex(), d]));
  for (const o of req.orders) {
    const o2 = out(o);
    const r = redeemer(CSL.RedeemerTag.new_spend(), applyOrder, budget(`spend:${ix.get(o.ref)}`, 'spend'));
    const hash = o2.data_hash()?.to_hex();
    const witness = hash
      ? CSL.PlutusWitness.new_with_ref(source('order'), CSL.DatumSource.new(witnessByHash.get(hash) ?? (() => { throw new DecodeError(`no datum for order ${o.ref}`); })()), r)
      : CSL.PlutusWitness.new_with_ref_without_datum(source('order'), r);
    ins.add_plutus_script_input(witness, parseRef(o.ref), o2.amount());
  }
  for (const u of req.batcher.feeUtxos) ins.add_regular_input(out(u).address(), parseRef(u.ref), out(u).amount());
  b.set_inputs(ins);

  // Order outputs first, in processing order (order_validation.ak apply_orders consumes outputs from the head).
  req.plan.outputs.forEach((o, i) => {
    const output = CSL.TransactionOutput.new(addressToCsl(o.receiver, req.network), valueToCsl(o.value));
    if (o.receiver.payment.kind === 'script') {
      if (o.receiverDatum.kind === 'hash') output.set_data_hash(CSL.DataHash.from_hex(o.receiverDatum.hash));
      else if (o.receiverDatum.kind === 'inline') throw new Unsupported('InlineReceiverDatum', `order ${req.orders[i]!.ref}: an inline receiver datum this batcher does not hold`);
    }
    try {
      b.add_output(output);
    } catch (e) {
      // Usually too little ADA left to carry its coins (the ledger's minimum per output).
      throw new ContractFailure(`order ${req.orders[i]!.ref}: its output cannot exist (${e instanceof Error ? e.message : String(e)})`);
    }
  });
  const pool = CSL.TransactionOutput.new(req.plan.poolOutput.address, valueToCsl(req.plan.poolOutput.value));
  pool.set_plutus_data(req.plan.poolOutput.datum);
  b.add_output(pool);

  const w = CSL.WithdrawalsBuilder.new();
  w.add_with_plutus_witness(
    CSL.RewardAddress.new(req.network, CSL.Credential.from_scripthash(CSL.ScriptHash.from_hex(scripts.poolBatching.hash))),
    big(req.batchingRewardBalance),
    CSL.PlutusWitness.new_with_ref_without_datum(
      source('poolBatching'),
      redeemer(CSL.RedeemerTag.new_reward(), batchingRedeemer(req.batcherIndex, req.fees, req.plan.inputIndexes, req.volFee), budget('reward:0', 'reward')),
    ),
  );
  b.set_withdrawals_builder(w);

  b.add_reference_input(parseRef(req.globalSetting.ref));
  b.add_required_signer(CSL.Ed25519KeyHash.from_hex(req.batcher.keyHash));
  b.set_validity_start_interval_bignum(big(req.validFromSlot));
  b.set_ttl_bignum(big(req.validToSlot));

  const coll = CSL.TxInputsBuilder.new();
  const c = out(req.batcher.collateral);
  coll.add_regular_input(c.address(), parseRef(req.batcher.collateral.ref), c.amount());
  b.set_collateral(coll);
  b.set_total_collateral_and_return(big(totalCollateral), CSL.Address.from_bech32(req.batcher.address));

  if (minFee > 0n) b.set_min_fee(big(minFee));
  b.calc_script_data_hash(costModels(pp, [...new Map(Object.values(scripts).map((s) => [s.language.kind(), s.language])).values()]));
  if (!b.add_change_if_needed(CSL.Address.from_bech32(req.batcher.address))) throw new DecodeError('no change output: the batcher UTxOs do not cover the fee');
  return b.build_tx();
}

/** EMURGO's builder throws bare strings: as errors a caller can tell apart. */
function emurgo<T>(f: () => T): T {
  try {
    return f();
  } catch (e) {
    if (e instanceof Error) throw e;
    const message = String(e);
    if (/Maximum transaction size of \d+ exceeded/.test(message)) throw new BatchTooBig(`the batch is more bytes than one transaction may be: ${message}`);
    throw new Error(`EMURGO's builder refused the batch: ${message}`);
  }
}

/**
 * The unsigned batch. A draft (any redeemer still on a placeholder budget) is only for
 * measuring the scripts and is never sent: it pledges the whole collateral UTxO, whatever its
 * placeholder fee. Otherwise built once to learn the fee, pledging the whole collateral UTxO,
 * then again (at most four builds in all) until the fee is at least the ledger's own minimum
 * and the collateral pledged covers the collateral percentage of that fee.
 */
export function buildBatchTx(req: BatchTxRequest, pp: ProtocolParams): { txHex: string; fee: bigint; totalCollateral: bigint } {
  for (const u of [...req.batcher.feeUtxos, req.batcher.collateral]) {
    if (!isPlainBatcherUtxo(u, req.batcher.keyHash)) throw new DecodeError(`${u.ref} is not plain ADA at the batcher's own key: never spent by a batch`);
  }
  const known: Record<string, string> = {};
  for (const u of [req.pool, ...req.orders, ...req.batcher.feeUtxos, req.batcher.collateral, req.globalSetting, req.scripts.pool, req.scripts.order, req.scripts.poolBatching]) known[u.ref] = u.outputHex;

  const coin = BigInt(out(req.batcher.collateral).amount().coin().to_str());
  const ix = spendIndexes(req);
  const draft = ![`spend:${ix.get(req.pool.ref)}`, ...req.orders.map((o) => `spend:${ix.get(o.ref)}`), 'reward:0'].every((k) => req.budgets.has(k));
  if (draft) {
    const tx = emurgo(() => assemble(req, pp, coin, 0n));
    return { txHex: tx.to_hex(), fee: BigInt(tx.body().fee().to_str()), totalCollateral: coin };
  }
  const returnAddress = CSL.Address.from_bech32(req.batcher.address);
  const needed = (fee: bigint) => (fee * BigInt(pp.collateralPercentage) + 99n) / 100n;
  // The share of the fee plus a margin, with the rest returned; or all of it, when the rest would be too little to stand as an output.
  const pledge = (fee: bigint) => {
    const total = needed(fee) + COLLATERAL_MARGIN;
    if (total >= coin) return coin;
    const back = CSL.TransactionOutput.new(returnAddress, CSL.Value.new(big(coin - total)));
    const minAda = BigInt(CSL.min_ada_for_output(back, CSL.DataCost.new_coins_per_byte(big(pp.utxoCostPerByte))).to_str());
    return coin - total >= minAda ? total : coin;
  };

  let total = coin;
  let floor = 0n;
  for (let pass = 0; pass < 4; pass++) {
    const tx = emurgo(() => assemble(req, pp, total, floor));
    const fee = BigInt(tx.body().fee().to_str());
    const min = ledgerMinFee(tx.to_hex(), known, pp);
    if (needed(fee) > coin) throw new DecodeError(`the collateral UTxO holds ${coin} lovelace; this batch's fee needs ${needed(fee)} pledged`);
    if (pass > 0 && fee >= min && total >= needed(fee)) return { txHex: tx.to_hex(), fee, totalCollateral: total };
    if (min > floor) floor = min;
    total = pledge(fee > floor ? fee : floor);
  }
  throw new Error('the fee and the collateral did not settle in four builds');
}
