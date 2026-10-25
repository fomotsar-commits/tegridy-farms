// Builds one batch transaction from a plan (src/plan.ts) with EMURGO's TransactionBuilder.
// Unsigned: the key signs elsewhere, after the batch has been simulated and read back.
// Layout, as pool_validator.ak and order_validation.ak require it:
//   inputs   the pool and every order (Plutus, reference scripts), the batcher's fee UTxOs
//   outputs  each order's output in processing order, then the pool, then the batcher's change
//   reference inputs  the global setting, the three reference scripts
//   withdrawal  0 lovelace from the pool-batching script, its redeemer the batch's instructions
//   required signer  the batcher's key; collateral from one pure-ADA batcher UTxO
import CSL from '@emurgo/cardano-serialization-lib-nodejs';
import { ContractFailure } from './math.ts';
import { DecodeError, mkConstr, type PlutusData } from './plutus.ts';
import { addressToCsl, batchingRedeemer, compareRefs, parseRef, type PlannedBatch, type Utxo } from './plan.ts';
import { Unsupported } from './engine.ts';
import type { Value } from './value.ts';

export interface ProtocolParams {
  txFeePerByte: number;
  txFeeFixed: number;
  utxoCostPerByte: number;
  maxTxSize: number;
  maxValueSize: number;
  collateralPercentage: number;
  executionUnitPrices: { priceMemory: number; priceSteps: number };
  minFeeRefScriptCostPerByte: number;
  stakeAddressDeposit: number;
  stakePoolDeposit: number;
  costModelPlutusV2: number[];
  /** The most one transaction's scripts may use, together. */
  maxTxExecutionUnits: { memory: number; steps: number };
}

/** A script published as a reference script: where it sits, its hash and its size in bytes. */
export interface ScriptRef {
  utxo: Utxo;
  hash: string;
  size: number;
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
  scripts: { pool: ScriptRef; order: ScriptRef; poolBatching: ScriptRef };
  batcher: { keyHash: string; address: string; feeUtxos: Utxo[]; collateral: Utxo };
  batcherIndex: number;
  volFee: bigint | null;
  validFromSlot: bigint;
  validToSlot: bigint;
  /** Per redeemer, keyed "spend:<ledger index>" or "reward:0"; missing ones use generous placeholders. */
  budgets: ReadonlyMap<string, ExUnits>;
}

const PLACEHOLDER: Record<'spend' | 'reward', ExUnits> = {
  spend: { mem: 1_000_000n, steps: 400_000_000n },
  reward: { mem: 8_000_000n, steps: 3_000_000_000n },
};

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

function config(pp: ProtocolParams): CSL.TransactionBuilderConfig {
  const ratio = (x: number) => {
    // A decimal price as an exact fraction (the chain publishes them as rationals).
    const s = x.toString();
    const decimals = s.includes('.') ? s.split('.')[1]!.length : 0;
    return CSL.UnitInterval.new(big(BigInt(s.replace('.', ''))), big(10n ** BigInt(decimals)));
  };
  return CSL.TransactionBuilderConfigBuilder.new()
    .fee_algo(CSL.LinearFee.new(big(pp.txFeePerByte), big(pp.txFeeFixed)))
    .pool_deposit(big(pp.stakePoolDeposit))
    .key_deposit(big(pp.stakeAddressDeposit))
    .max_value_size(pp.maxValueSize)
    .max_tx_size(pp.maxTxSize)
    .coins_per_utxo_byte(big(pp.utxoCostPerByte))
    .ex_unit_prices(CSL.ExUnitPrices.new(ratio(pp.executionUnitPrices.priceMemory), ratio(pp.executionUnitPrices.priceSteps)))
    .ref_script_coins_per_byte(CSL.UnitInterval.new(big(pp.minFeeRefScriptCostPerByte), big(1)))
    .build();
}

function costModels(pp: ProtocolParams): CSL.Costmdls {
  const cm = CSL.CostModel.new();
  pp.costModelPlutusV2.forEach((v, i) => cm.set(i, v >= 0 ? CSL.Int.new(big(v)) : CSL.Int.new_negative(big(-v))));
  const all = CSL.Costmdls.new();
  all.insert(CSL.Language.new_plutus_v2(), cm);
  return all;
}

const out = (u: Utxo) => CSL.TransactionOutput.from_hex(u.outputHex);
const source = (s: ScriptRef) => CSL.PlutusScriptSource.new_ref_input(CSL.ScriptHash.from_hex(s.hash), parseRef(s.utxo.ref), CSL.Language.new_plutus_v2(), s.size);
const redeemer = (tag: CSL.RedeemerTag, data: PlutusData, u: ExUnits) => CSL.Redeemer.new(tag, big(0), data, CSL.ExUnits.new(big(u.mem), big(u.steps)));

/** The ledger order of every spent input, for redeemer indexes. */
export function spendIndexes(req: Pick<BatchTxRequest, 'pool' | 'orders' | 'batcher'>): Map<string, number> {
  const refs = [req.pool.ref, ...req.orders.map((o) => o.ref), ...req.batcher.feeUtxos.map((u) => u.ref)].sort(compareRefs);
  return new Map(refs.map((r, i) => [r, i]));
}

function assemble(req: BatchTxRequest, pp: ProtocolParams, totalCollateral: bigint): CSL.Transaction {
  const b = CSL.TransactionBuilder.new(config(pp));
  const ix = spendIndexes(req);
  const budget = (key: string, kind: 'spend' | 'reward') => req.budgets.get(key) ?? PLACEHOLDER[kind];
  const applyOrder = mkConstr(0, []); // OrderRedeemer ApplyOrder
  const batching = mkConstr(0, []); // PoolRedeemer Batching

  const ins = CSL.TxInputsBuilder.new();
  const poolOut = out(req.pool);
  ins.add_plutus_script_input(
    CSL.PlutusWitness.new_with_ref_without_datum(source(req.scripts.pool), redeemer(CSL.RedeemerTag.new_spend(), batching, budget(`spend:${ix.get(req.pool.ref)}`, 'spend'))),
    parseRef(req.pool.ref),
    poolOut.amount(),
  );
  const witnessByHash = new Map(req.plan.witnessDatums.map((d) => [CSL.hash_plutus_data(d).to_hex(), d]));
  for (const o of req.orders) {
    const o2 = out(o);
    const r = redeemer(CSL.RedeemerTag.new_spend(), applyOrder, budget(`spend:${ix.get(o.ref)}`, 'spend'));
    const hash = o2.data_hash()?.to_hex();
    const witness = hash
      ? CSL.PlutusWitness.new_with_ref(source(req.scripts.order), CSL.DatumSource.new(witnessByHash.get(hash) ?? (() => { throw new DecodeError(`no datum for order ${o.ref}`); })()), r)
      : CSL.PlutusWitness.new_with_ref_without_datum(source(req.scripts.order), r);
    ins.add_plutus_script_input(witness, parseRef(o.ref), o2.amount());
  }
  for (const u of req.batcher.feeUtxos) ins.add_regular_input(out(u).address(), parseRef(u.ref), out(u).amount());
  b.set_inputs(ins);

  // Order outputs first, in processing order (order_validation.ak apply_orders consumes outputs from the head).
  req.plan.outputs.forEach((o, i) => {
    const output = CSL.TransactionOutput.new(addressToCsl(o.receiver, req.network), valueToCsl(o.value));
    if (o.receiver.payment.kind === 'script') {
      if (o.receiverDatum.kind === 'hash') output.set_data_hash(CSL.DataHash.from_hex(o.receiverDatum.hash));
      else if (o.receiverDatum.kind === 'inline') throw new Unsupported(`order ${req.orders[i]!.ref}: an inline receiver datum this batcher does not hold`);
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
    CSL.RewardAddress.new(req.network, CSL.Credential.from_scripthash(CSL.ScriptHash.from_hex(req.scripts.poolBatching.hash))),
    big(0),
    CSL.PlutusWitness.new_with_ref_without_datum(
      source(req.scripts.poolBatching),
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

  b.calc_script_data_hash(costModels(pp));
  if (!b.add_change_if_needed(CSL.Address.from_bech32(req.batcher.address))) throw new DecodeError('no change output: the batcher UTxOs do not cover the fee');
  return b.build_tx();
}

/**
 * The unsigned batch. Collateral is sized from the fee: built once to learn the fee, then again
 * with total collateral = collateral percentage of that fee, rounded up, plus a margin.
 */
export function buildBatchTx(req: BatchTxRequest, pp: ProtocolParams): { txHex: string; fee: bigint; totalCollateral: bigint } {
  const needed = (fee: bigint) => (fee * BigInt(pp.collateralPercentage) + 99n) / 100n;
  const first = assemble(req, pp, 5_000_000n);
  const total = needed(BigInt(first.body().fee().to_str())) + 50_000n;
  const tx = assemble(req, pp, total);
  const fee = BigInt(tx.body().fee().to_str());
  if (total < needed(fee)) throw new DecodeError('collateral below the required share of the fee');
  return { txHex: tx.to_hex(), fee, totalCollateral: total };
}
