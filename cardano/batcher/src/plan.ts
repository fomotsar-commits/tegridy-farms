// From a pool and its orders on chain to what one batch must write: each order's output and
// the pool's next state, computed by the engine (src/engine.ts), and the batching redeemer.
// Pure: no chain access, no key.
import CSL from '@emurgo/cardano-serialization-lib-nodejs';
import { outputDatum, valueFromCsl } from './chain.ts';
import { MIN_POOL_ADA, Unsupported, applyOrders, tradingFeeNumerator, type OrderInput, type OrderOutput, type PoolContext, type PoolState } from './engine.ts';
import { DecodeError, fieldsOf, mkBytes, mkConstr, mkInt, mkList, type PlutusData } from './plutus.ts';
import { decodeOrderDatum, decodePoolDatum, isAda, type Address, type Asset, type PoolDatum } from './types.ts';
import { quantityOf, valueOf, type Value } from './value.ts';
import { lpAssetName, type DexConstants } from './verify.ts';

/** An unspent output: "txhash#index" and its CBOR. */
export interface Utxo {
  ref: string;
  outputHex: string;
}

export interface PlannedBatch {
  pool: PoolDatum;
  ctx: PoolContext;
  stateIn: PoolState;
  stateOut: PoolState;
  /** One per order, in processing order. */
  outputs: OrderOutput[];
  poolOutput: { address: CSL.Address; value: Value; datum: PlutusData };
  /** Byte i: the i-th processed order's place among the order inputs in ledger order. */
  inputIndexes: number[];
  /** The order datums the batch must carry in its witness set (orders that hold only a hash). */
  witnessDatums: PlutusData[];
}

const POOL_NFT_NAME = '4d5350';

export function parseRef(ref: string): CSL.TransactionInput {
  const [hash, ix] = ref.split('#');
  if (!hash || ix === undefined) throw new DecodeError(`not a "txhash#index": ${ref}`);
  return CSL.TransactionInput.new(CSL.TransactionHash.from_hex(hash), Number(ix));
}

/** Ledger order of inputs: by transaction id, then index. */
export function compareRefs(a: string, b: string): number {
  const [ha, ia] = a.split('#') as [string, string];
  const [hb, ib] = b.split('#') as [string, string];
  return ha < hb ? -1 : ha > hb ? 1 : Number(ia) - Number(ib);
}

/**
 * The batch for `orders`, processed in the order given (the batcher's FIFO), each paying the
 * fee at the same place in `fees`. Throws ContractFailure when the contract would reject it,
 * Unsupported for an order this batcher leaves alone.
 */
export function planBatch(
  k: DexConstants,
  pool: Utxo,
  orders: Utxo[],
  fees: bigint[],
  nowMs: bigint,
  volFee: bigint | null,
  datumsByHash: ReadonlyMap<string, PlutusData> = new Map(),
): PlannedBatch {
  const poolOut = CSL.TransactionOutput.from_hex(pool.outputHex);
  const pd = outputDatum(poolOut);
  if (pd.kind !== 'inline') throw new DecodeError('the pool has no inline datum');
  const datum = decodePoolDatum(pd.data);
  const lpAsset: Asset = { policyId: k.authenPolicy, assetName: lpAssetName(datum.assetA, datum.assetB) };
  const nft: Asset = { policyId: k.authenPolicy, assetName: POOL_NFT_NAME };
  const vin = valueFromCsl(poolOut.amount());
  if (quantityOf(vin, nft) !== 1n) throw new DecodeError('the pool does not hold its NFT');
  const adaOffset = isAda(datum.assetA) ? MIN_POOL_ADA : 0n;
  const stateIn: PoolState = {
    datumReserveA: datum.reserveA,
    datumReserveB: datum.reserveB,
    valueReserveA: quantityOf(vin, datum.assetA) - adaOffset,
    valueReserveB: quantityOf(vin, datum.assetB),
    totalLiquidity: datum.totalLiquidity,
  };
  const ctx: PoolContext = {
    assetA: datum.assetA,
    assetB: datum.assetB,
    lpAsset,
    tradingFeeA: tradingFeeNumerator(datum.baseFeeA, volFee, datum.allowDynamicFee),
    tradingFeeB: tradingFeeNumerator(datum.baseFeeB, volFee, datum.allowDynamicFee),
    feeSharing: datum.feeSharing,
  };
  const witnessDatums: PlutusData[] = [];
  const inputs: OrderInput[] = orders.map((o) => {
    const out = CSL.TransactionOutput.from_hex(o.outputHex);
    // The ledger charges the batch for every reference script on its inputs, and the order
    // contract never looks: a trader could make every batch carrying the order pay for theirs.
    if (out.script_ref()) throw new Unsupported('ReferenceScript', `order ${o.ref} carries a reference script; it is left for its owner to cancel`);
    const d = outputDatum(out);
    let data: PlutusData | undefined;
    if (d.kind === 'inline') data = d.data;
    else if (d.kind === 'hash') {
      data = datumsByHash.get(d.hash);
      if (data) witnessDatums.push(data);
    }
    if (!data) throw new DecodeError(`order ${o.ref} has no datum this batcher holds`);
    return { value: valueFromCsl(out.amount()), datum: decodeOrderDatum(data) };
  });
  const applied = applyOrders(ctx, stateIn, inputs, fees, nowMs);
  const s = applied.state;
  const lpIn = quantityOf(vin, lpAsset);
  const lpOut = lpIn - (s.totalLiquidity - stateIn.totalLiquidity);
  const value = valueOf([
    [nft, 1n],
    [datum.assetA, s.valueReserveA],
    [datum.assetB, s.valueReserveB],
    [lpAsset, lpOut],
    [{ policyId: '', assetName: '' }, MIN_POOL_ADA],
  ]);
  // The pool's datum with only total liquidity and the two reserves changed (fields 3, 4, 5).
  const fields = fieldsOf(pd.data, 0, 10, 'PoolDatum');
  const next = fields.map((f, i) => (i === 3 ? mkInt(s.totalLiquidity) : i === 4 ? mkInt(s.datumReserveA) : i === 5 ? mkInt(s.datumReserveB) : f));
  const sortedRefs = [...orders.map((o) => o.ref)].sort(compareRefs);
  return {
    pool: datum,
    ctx,
    stateIn,
    stateOut: s,
    outputs: applied.outputs,
    poolOutput: { address: poolOut.address(), value, datum: mkConstr(0, next) },
    inputIndexes: orders.map((o) => sortedRefs.indexOf(o.ref)),
    witnessDatums,
  };
}

/** types.ak PoolBatchingRedeemer: batcher_index, orders_fee, input_indexes, None, [vol_fee]. */
export function batchingRedeemer(batcherIndex: number, fees: bigint[], inputIndexes: number[], volFee: bigint | null): PlutusData {
  return mkConstr(0, [
    mkInt(BigInt(batcherIndex)),
    mkList(fees.map(mkInt)),
    mkBytes(Buffer.from(inputIndexes).toString('hex')),
    mkConstr(1, []),
    mkList([volFee === null ? mkConstr(1, []) : mkConstr(0, [mkInt(volFee)])]),
  ]);
}

/** A domain address as a CSL address on `network` (0 testnet, 1 mainnet). Pointer addresses are refused. */
export function addressToCsl(a: Address, network: number): CSL.Address {
  const cred = (c: Address['payment']) => (c.kind === 'key' ? CSL.Credential.from_keyhash(CSL.Ed25519KeyHash.from_hex(c.hash)) : CSL.Credential.from_scripthash(CSL.ScriptHash.from_hex(c.hash)));
  if (a.stake === null) return CSL.EnterpriseAddress.new(network, cred(a.payment)).to_address();
  if (a.stake.kind === 'inline') return CSL.BaseAddress.new(network, cred(a.payment), cred(a.stake.credential)).to_address();
  throw new DecodeError('a pointer address');
}
