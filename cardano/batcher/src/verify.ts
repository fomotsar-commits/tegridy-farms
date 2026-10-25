// Reads a single-pool batch transaction the way the pool contract does
// (validators/pool_validator.ak validate_pool_batching + pool_validation.ak get_batching_pool)
// and recomputes it with the engine. Every disagreement is collected, never patched over.
// Used two ways: replaying Minswap's real batches (the proof the engine is right), and reading
// back every batch this batcher builds before it is signed.
import { createHash } from 'node:crypto';
import CSL from '@emurgo/cardano-serialization-lib-nodejs';
import { addressFromCsl, datumMatches, ledgerOrder, outputDatum, refKey, slotToPosixMs, valueFromCsl, type NetworkTime } from './chain.ts';
import { MIN_POOL_ADA, applyOrders, currentTimeApproximation, tradingFeeNumerator, type OrderInput, type PoolContext, type PoolState } from './engine.ts';
import { ContractFailure } from './math.ts';
import { DecodeError, bytes, constr, type PlutusData } from './plutus.ts';
import {
  addressKey,
  decodeBatchingRedeemer,
  decodeGlobalSetting,
  decodeOrderDatum,
  decodePoolDatum,
  isAda,
  type Asset,
  type AuthorizationMethod,
  type PoolBatchingRedeemer,
  type PoolDatum,
} from './types.ts';
import { equals, quantityOf, show, valueOf, type Value } from './value.ts';

/** The deployment a batch is checked against: whose contracts these are. */
export interface DexConstants {
  /** The authen minting policy: it mints every pool's NFT and LP token, and the settings token. */
  authenPolicy: string;
  /** The pool validator's script hash: every pool sits under it. */
  poolScriptHash: string;
  time: NetworkTime;
}

const POOL_NFT_NAME = '4d5350'; // "MSP"
const GLOBAL_SETTING_NAME = '4d534753'; // "MSGS"
const REDEEMER_TAG_REWARD = 3;

export class BatchMismatch extends Error {
  readonly problems: string[];
  constructor(problems: string[]) {
    super(`the batch does not hold: ${problems.join('; ')}`);
    this.problems = problems;
  }
}

export interface BatchReport {
  batcher: AuthorizationMethod;
  redeemer: PoolBatchingRedeemer;
  pool: PoolDatum;
  stateIn: PoolState;
  stateOut: PoolState;
  orders: { step: string; fee: bigint; filled: boolean }[];
}

const sha3 = (hex: string) => createHash('sha3-256').update(Buffer.from(hex, 'hex')).digest('hex');

/** utils.ak compute_lp_asset_name. */
export function lpAssetName(a: Asset, b: Asset): string {
  return sha3(sha3(a.policyId + a.assetName) + sha3(b.policyId + b.assetName));
}

const cborOf = (d: PlutusData) => Buffer.from(d.to_bytes()).toString('hex');

export function verifySinglePoolBatch(txHex: string, spentHex: Readonly<Record<string, string>>, k: DexConstants): BatchReport {
  const problems: string[] = [];
  const check = (ok: boolean, what: string) => {
    if (!ok) problems.push(what);
  };
  const tx = CSL.FixedTransaction.from_hex(txHex);
  const body = tx.body();
  const ws = tx.witness_set();
  const resolve = (i: CSL.TransactionInput): CSL.TransactionOutput => {
    const hex = spentHex[refKey(i)];
    if (hex === undefined) throw new DecodeError(`the output spent by ${refKey(i)} is unknown`);
    return CSL.TransactionOutput.from_hex(hex);
  };
  const paymentOf = (o: CSL.TransactionOutput) => addressFromCsl(o.address()).payment;

  // Global setting: the first reference input at the authen script, holding exactly one settings token.
  const global = ledgerOrder(body.reference_inputs())
    .map(resolve)
    .find((o) => {
      const p = paymentOf(o);
      return p.kind === 'script' && p.hash === k.authenPolicy;
    });
  if (!global) throw new DecodeError('no global setting among the reference inputs');
  check(quantityOf(valueFromCsl(global.amount()), { policyId: k.authenPolicy, assetName: GLOBAL_SETTING_NAME }) === 1n, 'the global setting does not hold exactly one settings token');
  const globalDatum = outputDatum(global);
  if (globalDatum.kind !== 'inline') throw new DecodeError('the global setting has no inline datum');
  const setting = decodeGlobalSetting(globalDatum.data);

  // The batching withdrawal's redeemer.
  const redeemers = ws.redeemers();
  const rewardRedeemers: PlutusData[] = [];
  for (let i = 0; redeemers && i < redeemers.len(); i++) {
    const r = redeemers.get(i);
    if (r.tag().kind() === REDEEMER_TAG_REWARD) rewardRedeemers.push(r.data());
  }
  const decoded = rewardRedeemers.flatMap((d) => {
    try {
      return [decodeBatchingRedeemer(d)];
    } catch {
      return [];
    }
  });
  if (decoded.length !== 1) throw new DecodeError(`expected one pool batching redeemer, found ${decoded.length}`);
  const redeemer = decoded[0]!;

  // The batcher, and its authorization.
  const batcher = setting.batchers[Number(redeemer.batcherIndex)];
  if (!batcher) throw new DecodeError(`batcher_index ${redeemer.batcherIndex} is not in the batcher list`);
  const inputs = ledgerOrder(body.inputs()).map((i) => ({ ref: refKey(i), out: resolve(i) }));
  const withdrawalCreds: string[] = [];
  const w = body.withdrawals();
  if (w) {
    const keys = w.keys();
    for (let i = 0; i < keys.len(); i++) {
      const s = keys.get(i).payment_cred().to_scripthash();
      if (s) withdrawalCreds.push(s.to_hex());
    }
  }
  if (batcher.kind === 'signature') {
    const signers = body.required_signers();
    let signed = false;
    for (let i = 0; signers && i < signers.len(); i++) signed ||= signers.get(i).to_hex() === batcher.hash;
    check(signed, 'the batcher key is not a required signer');
  } else if (batcher.kind === 'spendScript') {
    check(inputs.some((i) => { const p = paymentOf(i.out); return p.kind === 'script' && p.hash === batcher.hash; }), 'the batcher script is not spent');
  } else {
    check(withdrawalCreds.includes(batcher.hash), 'the batcher script does not withdraw');
  }
  check(!body.mint(), 'the batch mints');

  // Pool in and out, and the orders: every input that is neither the pool nor the batcher.
  const isPool = (o: CSL.TransactionOutput) => { const p = paymentOf(o); return p.kind === 'script' && p.hash === k.poolScriptHash; };
  const isBatcher = (o: CSL.TransactionOutput) => { const p = paymentOf(o); return p.hash === batcher.hash && (p.kind === 'key') === (batcher.kind === 'signature'); };
  const poolIns = inputs.filter((i) => isPool(i.out));
  const outputs: CSL.TransactionOutput[] = [];
  for (let i = 0; i < body.outputs().len(); i++) outputs.push(body.outputs().get(i));
  const poolOuts = outputs.filter(isPool);
  if (poolIns.length !== 1 || poolOuts.length !== 1) throw new DecodeError(`a single-pool batch has one pool in and out, not ${poolIns.length} and ${poolOuts.length}`);
  const poolIn = poolIns[0]!.out;
  const poolOut = poolOuts[0]!;
  const orderInputs = inputs.filter((i) => !isPool(i.out) && !isBatcher(i.out));
  check(redeemer.inputIndexes.length === orderInputs.length, `input_indexes names ${redeemer.inputIndexes.length} orders, the batch spends ${orderInputs.length}`);
  check(redeemer.inputIndexes.length > 0 && new Set(redeemer.inputIndexes).size === redeemer.inputIndexes.length && redeemer.inputIndexes.every((x) => x < 64), 'input_indexes must be non-empty, unique and below 64');
  const sorted = redeemer.inputIndexes.map((x) => orderInputs[x]);
  if (sorted.some((s) => s === undefined)) throw new DecodeError('an input index points past the order inputs');

  // Pool datums and values (get_batching_pool).
  const inDatum = outputDatum(poolIn);
  const outDatum = outputDatum(poolOut);
  if (inDatum.kind !== 'inline' || outDatum.kind !== 'inline') throw new DecodeError('a pool datum is not inline');
  const pin = decodePoolDatum(inDatum.data);
  const pout = decodePoolDatum(outDatum.data);
  check(cborOf(pin.batchingStakeCredential) === cborOf(pout.batchingStakeCredential), 'the pool batching stake credential changed');
  // The pool spends only when its own batching credential withdraws (pool_validator.ak Batching).
  const batching = constr(pin.batchingStakeCredential, 'pool_batching_stake_credential');
  const batchingCred = batching.alt === 0 && batching.fields.length === 1 ? constr(batching.fields[0]!, 'batching credential') : null;
  check(
    batchingCred !== null && batchingCred.alt === 1 && withdrawalCreds.includes(bytes(batchingCred.fields[0]!, 'batching script hash')),
    "the pool's batching script does not withdraw: the batching validator never runs",
  );
  check(addressKey(addressFromCsl(poolIn.address())) === addressKey(addressFromCsl(poolOut.address())), 'the pool address changed');
  check(
    pin.assetA.policyId === pout.assetA.policyId && pin.assetA.assetName === pout.assetA.assetName && pin.assetB.policyId === pout.assetB.policyId && pin.assetB.assetName === pout.assetB.assetName,
    'the pool assets changed',
  );
  check(pin.baseFeeA === pout.baseFeeA && pin.baseFeeB === pout.baseFeeB && pin.feeSharing === pout.feeSharing && pin.allowDynamicFee === pout.allowDynamicFee, 'the pool fees changed');
  const lpAsset: Asset = { policyId: k.authenPolicy, assetName: lpAssetName(pin.assetA, pin.assetB) };
  const nft: Asset = { policyId: k.authenPolicy, assetName: POOL_NFT_NAME };
  const vin = valueFromCsl(poolIn.amount());
  const vout = valueFromCsl(poolOut.amount());
  const adaOffset = isAda(pin.assetA) ? MIN_POOL_ADA : 0n;
  const reserveAIn = quantityOf(vin, pin.assetA) - adaOffset;
  const reserveAOut = quantityOf(vout, pin.assetA) - adaOffset;
  const lpIn = quantityOf(vin, lpAsset);
  const lpOut = quantityOf(vout, lpAsset);
  const poolValue = (ra: bigint, rb: bigint, lp: bigint): Value => valueOf([[nft, 1n], [pin.assetA, ra], [pin.assetB, rb], [lpAsset, lp], [{ policyId: '', assetName: '' }, MIN_POOL_ADA]]);
  check(equals(poolValue(reserveAIn, quantityOf(vin, pin.assetB), lpIn), vin), `the pool input holds more than its reserves: ${show(vin)}`);
  check(equals(poolValue(reserveAOut, quantityOf(vout, pin.assetB), lpOut), vout), `the pool output holds more than its reserves: ${show(vout)}`);
  check(lpOut - lpIn === pin.totalLiquidity - pout.totalLiquidity, 'the pool LP supply does not match total liquidity');

  // Apply the orders.
  check(redeemer.volFees.length === 1, 'a single-pool batch carries one vol fee');
  const ctx: PoolContext = {
    assetA: pin.assetA,
    assetB: pin.assetB,
    lpAsset,
    tradingFeeA: tradingFeeNumerator(pin.baseFeeA, redeemer.volFees[0] ?? null, pin.allowDynamicFee),
    tradingFeeB: tradingFeeNumerator(pin.baseFeeB, redeemer.volFees[0] ?? null, pin.allowDynamicFee),
    feeSharing: pin.feeSharing,
  };
  const stateIn: PoolState = { datumReserveA: pin.reserveA, datumReserveB: pin.reserveB, valueReserveA: reserveAIn, valueReserveB: quantityOf(vin, pin.assetB), totalLiquidity: pin.totalLiquidity };
  const stateOut: PoolState = { datumReserveA: pout.reserveA, datumReserveB: pout.reserveB, valueReserveA: reserveAOut, valueReserveB: quantityOf(vout, pin.assetB), totalLiquidity: pout.totalLiquidity };
  const start = body.validity_start_interval_bignum();
  const ttl = body.ttl_bignum();
  const now = currentTimeApproximation(start ? slotToPosixMs(BigInt(start.to_str()), k.time) : null, ttl ? slotToPosixMs(BigInt(ttl.to_str()), k.time) : null);
  const datumMap = new Map<string, PlutusData>();
  const wsData = ws.plutus_data();
  for (let i = 0; wsData && i < wsData.len(); i++) datumMap.set(CSL.hash_plutus_data(wsData.get(i)).to_hex(), wsData.get(i));
  const orders: OrderInput[] = sorted.map((s, i) => {
    const d = outputDatum(s!.out);
    const data = d.kind === 'inline' ? d.data : d.kind === 'hash' ? datumMap.get(d.hash) : undefined;
    if (!data) throw new DecodeError(`order ${i} (${s!.ref}) has no datum the batch carries`);
    return { value: valueFromCsl(s!.out.amount()), datum: decodeOrderDatum(data) };
  });
  let applied: ReturnType<typeof applyOrders>;
  try {
    applied = applyOrders(ctx, stateIn, orders, redeemer.ordersFee, now);
  } catch (e) {
    if (e instanceof ContractFailure) throw new BatchMismatch([...problems, e.message]);
    throw e;
  }
  applied.outputs.forEach((expected, i) => {
    const actual = outputs[i];
    if (!actual) {
      problems.push(`order ${i} has no output`);
      return;
    }
    const where = `order ${i} (${sorted[i]!.ref})`;
    check(addressKey(addressFromCsl(actual.address())) === addressKey(expected.receiver), `${where}: paid to the wrong address`);
    check(equals(valueFromCsl(actual.amount()), expected.value), `${where}: value ${show(valueFromCsl(actual.amount()))}, the contract demands ${show(expected.value)}`);
    if (expected.receiver.payment.kind === 'script') check(datumMatches(expected.receiverDatum, outputDatum(actual)), `${where}: the receiver's datum does not match`);
  });
  const s = applied.state;
  check(
    s.datumReserveA === stateOut.datumReserveA && s.datumReserveB === stateOut.datumReserveB && s.valueReserveA === stateOut.valueReserveA && s.valueReserveB === stateOut.valueReserveB && s.totalLiquidity === stateOut.totalLiquidity,
    `pool state: computed ${JSON.stringify(s, (_, v) => (typeof v === 'bigint' ? v.toString() : v))}, the batch wrote ${JSON.stringify(stateOut, (_, v) => (typeof v === 'bigint' ? v.toString() : v))}`,
  );
  if (problems.length) throw new BatchMismatch(problems);
  return {
    batcher,
    redeemer,
    pool: pin,
    stateIn,
    stateOut,
    orders: orders.map((o, i) => ({ step: o.datum.step.kind, fee: redeemer.ordersFee[i]!, filled: applied.outputs[i]!.filled })),
  };
}
