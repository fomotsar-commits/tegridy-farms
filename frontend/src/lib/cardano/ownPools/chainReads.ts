// The venue's own pools on chain: its pools, its factory list and its global setting, read
// through /api/cardano's own-pool reads (api/_lib/cardano-ops.js), which exist only once the
// deployment record does. Each answer is the chain's or 'unread' with a reason, never an empty
// list or a zero standing in for a failed read.

import type { PlutusData } from '@emurgo/cardano-serialization-lib-browser';
import type { Csl } from '../csl';
import { chainUtxoFromKoios, getJson, isRecord, type Read } from '../chain';
import { bytesToHex, type ParsedAddress } from '../address';
import { ADA, lpAssetName, MINSWAP_V2, readPool, type CardanoAsset, type ChainUtxo, type PoolState } from '../minswapV2';
import type { OwnPools } from './deployment';

/** utils.ak: the factory's NFT ("MSF") and the global setting's ("MSGS"), under the authen policy. */
export const FACTORY_NFT_NAME = '4d5346';
export const GLOBAL_SETTING_NFT_NAME = '4d534753';
/** Koios answers at most this many rows a read: a list that long may have more behind it. */
export const KOIOS_PAGE = 1000;

const unread = (reason: string): { status: 'unread'; reason: string } => ({ status: 'unread', reason });

function rowCarries(row: unknown, policy: string, name: string): boolean {
  if (!isRecord(row) || !Array.isArray(row.asset_list)) return false;
  return row.asset_list.some((a) => isRecord(a) && a.policy_id === policy && a.asset_name === name);
}

function fields(d: PlutusData | undefined, alternative: number, count: number): PlutusData[] | null {
  const c = d?.as_constr_plutus_data();
  if (!c || c.alternative().to_str() !== String(alternative) || c.data().len() !== count) return null;
  return Array.from({ length: count }, (_, i) => c.data().get(i));
}

function bytesOf(d: PlutusData | undefined): string | null {
  const b = d?.as_bytes();
  return b ? bytesToHex(b) : null;
}

/** The datum's first field, pool_batching_stake_credential: Inline(ScriptCredential(hash)) → hash. */
export function poolBatchingHashOf(csl: Csl, datumHex: string): string | null {
  try {
    const f = fields(csl.PlutusData.from_hex(datumHex), 0, 10);
    const inline = f ? fields(f[0], 0, 1) : null;
    const script = inline ? fields(inline[0], 1, 1) : null;
    return script ? bytesOf(script[0]) : null;
  } catch {
    return null;
  }
}

/** Every UTxO at OUR pool script holding this LP token and OUR pool NFT. The caller decides which is the pool. */
export async function readOwnPoolCandidates(dep: OwnPools, lpName: string, signal?: AbortSignal): Promise<Read<ChainUtxo[]>> {
  const r = await getJson('ownpool', { lp: lpName }, signal);
  if (r.status !== 'ok') return r;
  if (!Array.isArray(r.data)) return unread('the pool read was not a list');
  const out: ChainUtxo[] = [];
  // A row without our pool NFT can never be the pool (anyone can park one there): dropped unread.
  for (const row of r.data.filter((x) => rowCarries(x, dep.authenPolicy, MINSWAP_V2.poolNftName))) {
    const u = chainUtxoFromKoios(row);
    if (!u) return unread('a pool row could not be read');
    out.push(u);
  }
  return { status: 'ok', data: out };
}

/**
 * The venue's pool for `pair`, read with the venue's own hashes: its pool script, its NFT, its
 * LP policy, and a datum naming its pool-batching script (so our batcher, not anyone's, fills
 * it). null: the chain answered, and no such pool is open.
 */
export function pickOwnPool(csl: Csl, dep: OwnPools, rows: ChainUtxo[], pair: [CardanoAsset, CardanoAsset]): Read<PoolState | null> {
  const pools: PoolState[] = [];
  for (const u of rows) {
    const r = readPool(csl, u, pair, dep);
    // Every row carries our pool NFT, so each is a real pool: one that is another pair's (it holds
    // this LP token as a coin) is passed over; one that cannot be read makes the whole read unread.
    if (r.kind !== 'pool') {
      if (OTHER_PAIR.has(r.reason)) continue;
      return unread(`a pool could not be read (${r.reason})`);
    }
    if (poolBatchingHashOf(csl, u.inlineDatumHex!) !== dep.poolBatchingScriptHash) return unread('a pool names another batcher');
    pools.push(r.pool);
  }
  // The factory keeps one pool per pair; two passing every check is not a state to price.
  if (pools.length > 1) return unread('two pools claim this pair');
  return { status: 'ok', data: pools[0] ?? null };
}

export async function findOwnPool(csl: Csl, dep: OwnPools, token: CardanoAsset, signal?: AbortSignal): Promise<Read<PoolState | null>> {
  const rows = await readOwnPoolCandidates(dep, lpAssetName(ADA, token), signal);
  if (rows.status !== 'ok') return rows;
  return pickOwnPool(csl, dep, rows.data, [ADA, token]);
}

/** readPool's reasons for a real pool that is simply another pair's. */
const OTHER_PAIR: ReadonlySet<string> = new Set(['datum names another pair', "does not hold this pair's LP token"]);

/** One entry of the factory's linked list: the LP names on either side of the gap it holds. */
export interface FactoryEntry {
  utxo: ChainUtxo;
  head: string;
  tail: string;
}

/** A factory UTxO as the factory validator demands it: at our factory, holding only ADA and one MSF, with a FactoryDatum. */
export function readFactoryEntry(csl: Csl, dep: OwnPools, u: ChainUtxo): FactoryEntry | null {
  if (u.addressHex.slice(2, 58) !== dep.factoryScriptHash || (parseInt(u.addressHex.slice(0, 2), 16) >> 4) % 2 !== 1) return null;
  if (u.assets.length !== 1 || u.assets[0]!.policyId !== dep.authenPolicy || u.assets[0]!.assetName !== FACTORY_NFT_NAME || u.assets[0]!.quantity !== 1n) return null;
  if (u.inlineDatumHex === null) return null;
  try {
    const f = fields(csl.PlutusData.from_hex(u.inlineDatumHex), 0, 2);
    const head = f ? bytesOf(f[0]) : null;
    const tail = f ? bytesOf(f[1]) : null;
    return head !== null && tail !== null && head < tail ? { utxo: u, head, tail } : null;
  } catch {
    return null;
  }
}

export async function readFactoryEntries(csl: Csl, dep: OwnPools, signal?: AbortSignal): Promise<Read<FactoryEntry[]>> {
  const r = await getJson('ownfactory', {}, signal);
  if (r.status !== 'ok') return r;
  if (!Array.isArray(r.data)) return unread('the factory read was not a list');
  if (r.data.length >= KOIOS_PAGE) return unread('the factory list is longer than one read');
  const out: FactoryEntry[] = [];
  for (const row of r.data.filter((x) => rowCarries(x, dep.authenPolicy, FACTORY_NFT_NAME))) {
    const u = chainUtxoFromKoios(row);
    const e = u ? readFactoryEntry(csl, dep, u) : null;
    if (!e) return unread('a factory row could not be read');
    out.push(e);
  }
  return { status: 'ok', data: out };
}

/** Where a new pool with this LP name goes: the one entry whose gap holds it, or why there is none. */
export function factorySlotFor(entries: FactoryEntry[], lpName: string): { kind: 'slot'; entry: FactoryEntry } | { kind: 'exists' } | { kind: 'none' } {
  if (entries.some((e) => e.head === lpName || e.tail === lpName)) return { kind: 'exists' };
  const slots = entries.filter((e) => e.head < lpName && lpName < e.tail);
  return slots.length === 1 ? { kind: 'slot', entry: slots[0]! } : { kind: 'none' };
}

export interface GlobalSettingRead {
  utxo: ChainUtxo;
  openingFee: bigint;
  /** pool_creation_fee_receiver's credentials, as the datum names them. */
  receiver: { payment: { kind: 'key' | 'script'; hash: string }; stake: { kind: 'key' | 'script'; hash: string } | null };
}

function credentialOf(d: PlutusData | undefined): { kind: 'key' | 'script'; hash: string } | null {
  const key = fields(d, 0, 1);
  if (key) {
    const h = bytesOf(key[0]);
    return h && /^[0-9a-f]{56}$/.test(h) ? { kind: 'key', hash: h } : null;
  }
  const script = fields(d, 1, 1);
  const h = script ? bytesOf(script[0]) : null;
  return h && /^[0-9a-f]{56}$/.test(h) ? { kind: 'script', hash: h } : null;
}

/** GlobalSetting (types.ak, with #1016's two opening-fee fields): fee and receiver, or null. */
export function readGlobalSettingDatum(csl: Csl, datumHex: string): Pick<GlobalSettingRead, 'openingFee' | 'receiver'> | null {
  try {
    const f = fields(csl.PlutusData.from_hex(datumHex), 0, 8);
    if (!f) return null;
    const fee = f[6]?.as_integer();
    const addr = fields(f[7], 0, 2);
    if (!fee || !addr) return null;
    const payment = credentialOf(addr[0]);
    // stake: Some(Inline(cred)) = Constr 0 [Constr 0 [cred]]; None = Constr 1 []. A pointer is refused.
    const some = fields(addr[1], 0, 1);
    const inline = some ? fields(some[0], 0, 1) : null;
    const stake = inline ? credentialOf(inline[0]) : null;
    if (!payment || (some && !stake) || (!some && !fields(addr[1], 1, 0))) return null;
    return { openingFee: BigInt(fee.to_str()), receiver: { payment, stake } };
  } catch {
    return null;
  }
}

/** The receiver the chain names is exactly this address: both credentials, kind and hash. */
export function receiverIs(r: GlobalSettingRead['receiver'], a: ParsedAddress): boolean {
  const same = (x: { kind: string; hash: string } | null, y: { kind: string; hash: string } | null) => (x === null ? y === null : y !== null && x.kind === y.kind && x.hash === y.hash);
  return same(r.payment, a.payment) && same(r.stake, a.stake);
}

export async function readGlobalSetting(csl: Csl, dep: OwnPools, signal?: AbortSignal): Promise<Read<GlobalSettingRead>> {
  const r = await getJson('ownsetting', {}, signal);
  if (r.status !== 'ok') return r;
  if (!Array.isArray(r.data)) return unread('the settings read was not a list');
  const rows = r.data.filter((x) => rowCarries(x, dep.authenPolicy, GLOBAL_SETTING_NFT_NAME));
  // The authen policy mints one settings token, once (DexInitialization).
  if (rows.length !== 1) return unread(rows.length === 0 ? 'the venue’s pool settings were not found' : 'two settings claim the venue’s pools');
  const u = chainUtxoFromKoios(rows[0]);
  if (!u || u.addressHex.slice(2, 58) !== dep.authenPolicy || u.inlineDatumHex === null) return unread('the settings row could not be read');
  const d = readGlobalSettingDatum(csl, u.inlineDatumHex);
  if (!d) return unread('the settings could not be read');
  return { status: 'ok', data: { utxo: u, ...d } };
}

export interface Rational {
  n: bigint;
  d: bigint;
}

/** A protocol rate as cardano-cli prints it (0.0577, 7.21e-05) as an exact fraction. */
export function rational(x: unknown): Rational | null {
  if (typeof x !== 'number' && typeof x !== 'string') return null;
  const m = /^(\d+)(?:\.(\d*))?(?:e([+-]?\d+))?$/i.exec(String(x).trim());
  if (!m) return null;
  const decimals = m[2] ?? '';
  const exp = Number(m[3] ?? '0') - decimals.length;
  const n = BigInt(m[1]! + decimals);
  return exp >= 0 ? { n: n * 10n ** BigInt(exp), d: 1n } : { n, d: 10n ** BigInt(-exp) };
}

/** What a transaction that runs scripts is priced and pledged by. */
export interface PlutusParams {
  costModelV2: number[];
  priceMem: Rational;
  priceSteps: Rational;
  collateralPercentage: number;
  maxCollateralInputs: number;
}

export async function readPlutusParams(signal?: AbortSignal): Promise<Read<PlutusParams>> {
  const r = await getJson('params', {}, signal);
  if (r.status !== 'ok') return r;
  const p = r.data;
  if (!isRecord(p) || !isRecord(p.costModels) || !isRecord(p.executionUnitPrices)) return unread('the script parameters were malformed');
  const model = p.costModels.PlutusV2;
  if (!Array.isArray(model) || model.length < 100 || !model.every((v) => typeof v === 'number' && Number.isSafeInteger(v))) return unread('the script cost model was unreadable');
  const priceMem = rational(p.executionUnitPrices.priceMemory);
  const priceSteps = rational(p.executionUnitPrices.priceSteps);
  const pct = p.collateralPercentage;
  const maxIn = p.maxCollateralInputs;
  if (!priceMem || !priceSteps || typeof pct !== 'number' || !Number.isInteger(pct) || pct <= 0 || typeof maxIn !== 'number' || !Number.isInteger(maxIn) || maxIn <= 0) {
    return unread('the script prices were unreadable');
  }
  return { status: 'ok', data: { costModelV2: model as number[], priceMem, priceSteps, collateralPercentage: pct, maxCollateralInputs: maxIn } };
}
