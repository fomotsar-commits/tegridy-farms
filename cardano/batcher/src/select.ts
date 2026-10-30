// What to batch next, from what the chain holds: pure, no chain access, no key.
// Pools are the outputs at the pool script holding a pool NFT, named by the pair in their datum
// (never by the coins they hold: one real Minswap pool holds another pool's LP token). Orders
// are the outputs at the order script; anyone can put anything there, so each is read as
// strictly as the contract reads it and anything unreadable, unsupported, expired or charging
// less than the batcher's fee is left alone, with its reason. Oldest order first, across pools.
import CSL from '@emurgo/cardano-serialization-lib-nodejs';
import { outputDatum, plutusDataHash, slotToPosixMs, valueFromCsl } from './chain.ts';
import { Unsupported, currentTimeApproximation, type OrderOutput } from './engine.ts';
import { ContractFailure } from './math.ts';
import { planBatch, type Utxo } from './plan.ts';
import { blaming } from './cbor.ts';
import { DecodeError, mkBytes, mkConstr, type PlutusData } from './plutus.ts';
import { decodeGlobalSetting, decodeOrderDatum, decodePoolDatum, type GlobalSetting, type OrderDatum, type PoolDatum } from './types.ts';
import { quantityOf } from './value.ts';
import { lpAssetName, type DexConstants } from './verify.ts';
import { compareAge, type ChainUtxo } from './view.ts';

export const POOL_NFT = '4d5350'; // "MSP"
export const GLOBAL_SETTING_TOKEN = '4d534753'; // "MSGS"

/** One deployment of the contracts: ours (or, read-only, Minswap's). */
export interface Deployment {
  network: number;
  dex: DexConstants;
  orderScriptHash: string;
  poolBatchingScriptHash: string;
  /** The UTxOs carrying the three scripts as reference scripts. */
  scriptRefs: { pool: string; order: string; poolBatching: string };
}

export interface Policy {
  /** Charged to every order, never more than the order's own maximum. */
  batcherFee: bigint;
  maxOrdersPerBatch: number;
  /** The validity window: from this many slots before the tip to this many after (at most 600 apart). */
  slotsBefore: bigint;
  slotsAfter: bigint;
}

export interface Skipped {
  ref: string;
  reason: string;
}

export interface Pool {
  utxo: ChainUtxo;
  datum: PoolDatum;
  lpName: string;
}

export interface Order {
  utxo: ChainUtxo;
  datum: OrderDatum;
  /** The datum and the hash the output holds, when it holds only the hash (the datum must travel in the batch). */
  witness: { hash: string; data: PlutusData } | null;
}

export interface Candidate {
  pool: Pool;
  orders: Order[];
  fees: bigint[];
  validFromSlot: bigint;
  validToSlot: bigint;
}

const scriptCredOf = (u: Utxo) => CSL.TransactionOutput.from_hex(u.outputHex).address().payment_cred()?.to_scripthash()?.to_hex();

/** The global setting: exactly one output holding the settings token, at the authen script. */
export function readGlobalSetting(dep: Deployment, utxos: ChainUtxo[]): { utxo: ChainUtxo; setting: GlobalSetting } {
  const found = utxos.filter((u) => scriptCredOf(u) === dep.dex.authenPolicy && quantityOf(valueFromCsl(CSL.TransactionOutput.from_hex(u.outputHex).amount()), { policyId: dep.dex.authenPolicy, assetName: GLOBAL_SETTING_TOKEN }) === 1n);
  if (found.length !== 1) throw new DecodeError(`${found.length} global settings found, not exactly one`);
  const d = outputDatum(CSL.TransactionOutput.from_hex(found[0]!.outputHex));
  if (d.kind !== 'inline') throw new DecodeError('the global setting has no inline datum');
  return { utxo: found[0]!, setting: decodeGlobalSetting(d.data) };
}

/** The global setting does not (or no longer) name this batcher's key: a person is needed. */
export class NotABatcher extends Error {}

/** This batcher's place in the global setting's list of batchers (the batching redeemer names it). */
export function batcherIndex(setting: GlobalSetting, keyHash: string): number {
  const i = setting.batchers.findIndex((b) => b.kind === 'signature' && b.hash === keyHash);
  if (i < 0) throw new NotABatcher(`the batcher key ${keyHash} is not among the global setting's batchers: name it there through the 48-hour lock, and redeploy once that has executed`);
  return i;
}

/** Every pool this batcher can batch, by LP token name. Two pools with one name: both left alone. */
export function readPools(dep: Deployment, utxos: ChainUtxo[]): { pools: Map<string, Pool>; skipped: Skipped[] } {
  const pools = new Map<string, Pool>();
  const skipped: Skipped[] = [];
  const twice = new Set<string>();
  for (const u of utxos) {
    const reason = blaming([u.ref], () => {
      const o = CSL.TransactionOutput.from_hex(u.outputHex);
      if (scriptCredOf(u) !== dep.dex.poolScriptHash) return 'not at the pool script';
      if (quantityOf(valueFromCsl(o.amount()), { policyId: dep.dex.authenPolicy, assetName: POOL_NFT }) !== 1n) return 'no pool NFT';
      const d = outputDatum(o);
      if (d.kind !== 'inline') return 'no inline datum';
      let datum: PoolDatum;
      try {
        datum = decodePoolDatum(d.data);
      } catch (e) {
        return `unreadable datum (${(e as Error).message})`;
      }
      // Inline(ScriptCredential(our batching script)), compared as Plutus serialises it (bytes may arrive in either list form).
      if (plutusDataHash(datum.batchingStakeCredential) !== plutusDataHash(mkConstr(0, [mkConstr(1, [mkBytes(dep.poolBatchingScriptHash)])]))) return 'batched by another script';
      const lpName = lpAssetName(datum.assetA, datum.assetB);
      if (pools.has(lpName)) twice.add(lpName);
      pools.set(lpName, { utxo: u, datum, lpName });
      return null;
    });
    if (reason) skipped.push({ ref: u.ref, reason });
  }
  for (const name of twice) {
    skipped.push({ ref: pools.get(name)!.utxo.ref, reason: 'two pools share this LP token name' });
    pools.delete(name);
  }
  return { pools, skipped };
}

/** Every order this batcher could fill, oldest first; `datums` holds the datums of hash-only orders. */
export function readOrders(dep: Deployment, policy: Policy, utxos: ChainUtxo[], datums: ReadonlyMap<string, PlutusData>): { orders: Order[]; skipped: Skipped[] } {
  const orders: Order[] = [];
  const skipped: Skipped[] = [];
  for (const u of [...utxos].sort(compareAge)) {
    const skip = (reason: string) => void skipped.push({ ref: u.ref, reason });
    blaming([u.ref], () => {
      const o = CSL.TransactionOutput.from_hex(u.outputHex);
      if (scriptCredOf(u) !== dep.orderScriptHash) return skip('not at the order script');
      if (o.has_script_ref()) return skip('carries a reference script');
      const d = outputDatum(o);
      const data = d.kind === 'inline' ? d.data : d.kind === 'hash' ? datums.get(d.hash) : undefined;
      if (!data) return skip(d.kind === 'hash' ? 'its datum is not known (hash only)' : 'no datum');
      let datum: OrderDatum;
      try {
        datum = decodeOrderDatum(data);
      } catch (e) {
        return skip(`unreadable datum (${(e as Error).message})`);
      }
      if (datum.step.kind === 'Unsupported') return skip(`order type ${datum.step.name} is not built by this batcher`);
      if (datum.lpAsset.policyId !== dep.dex.authenPolicy) return skip('names no pool of this deployment');
      if (datum.maxBatcherFee < policy.batcherFee) return skip(`allows a batcher fee of ${datum.maxBatcherFee}, below ${policy.batcherFee}`);
      orders.push({ utxo: u, datum, witness: d.kind === 'hash' ? { hash: d.hash, data } : null });
    });
  }
  return { orders, skipped };
}

/**
 * The next batch: the pool whose oldest order is oldest, and as many of its orders, oldest
 * first, as the contract would take one after another (an order it would refuse at that point
 * is left for a later batch). `exclude` holds every UTxO already in a batch still in flight.
 */
export function chooseBatch(
  dep: Deployment,
  policy: Policy,
  pools: ReadonlyMap<string, Pool>,
  orders: readonly Order[],
  exclude: ReadonlySet<string>,
  tipSlot: bigint,
  /** Why an order's output could not be built (build.ts orderOutputProblem), or null: such an order is left alone. */
  outputProblem: (o: OrderOutput) => string | null = () => null,
): { candidate: Candidate | null; skipped: Skipped[] } {
  const validFromSlot = tipSlot - policy.slotsBefore;
  const validToSlot = tipSlot + policy.slotsAfter;
  const now = currentTimeApproximation(slotToPosixMs(validFromSlot, dep.dex.time), slotToPosixMs(validToSlot, dep.dex.time));
  const skipped: Skipped[] = [];
  const byPool = new Map<string, Order[]>();
  for (const o of orders) {
    if (exclude.has(o.utxo.ref)) continue;
    const pool = pools.get(o.datum.lpAsset.assetName);
    if (!pool) {
      skipped.push({ ref: o.utxo.ref, reason: 'its pool does not exist (or is left alone)' });
      continue;
    }
    if (exclude.has(pool.utxo.ref)) continue;
    byPool.set(pool.lpName, [...(byPool.get(pool.lpName) ?? []), o]);
  }
  // Pools in the order of their oldest waiting order (orders are already oldest first).
  for (const [lpName, queue] of byPool) {
    const pool = pools.get(lpName)!;
    const taken: Order[] = [];
    for (const o of queue) {
      if (taken.length >= policy.maxOrdersPerBatch) break;
      const trial = [...taken, o];
      try {
        const plan = planBatch(
          dep.dex,
          pool.utxo,
          trial.map((x) => x.utxo),
          trial.map(() => policy.batcherFee),
          now,
          null,
          new Map(trial.flatMap((x) => (x.witness ? [[x.witness.hash, x.witness.data] as const] : []))),
        );
        const problem = outputProblem(plan.outputs[plan.outputs.length - 1]!);
        if (problem) {
          skipped.push({ ref: o.utxo.ref, reason: `no batch can carry its output (${problem})` });
          continue;
        }
        taken.push(o);
      } catch (e) {
        if (!(e instanceof ContractFailure || e instanceof DecodeError || e instanceof Unsupported)) throw e;
        skipped.push({ ref: o.utxo.ref, reason: `the contract would refuse it now (${e.message})` });
      }
    }
    if (taken.length) return { candidate: { pool, orders: taken, fees: taken.map(() => policy.batcherFee), validFromSlot, validToSlot }, skipped };
  }
  return { candidate: null, skipped };
}
