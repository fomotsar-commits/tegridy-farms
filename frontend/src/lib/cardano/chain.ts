// The Cardano chain, read through this site's own /api/cardano (api/cardano.js), which asks
// Koios. The browser never holds a provider key and never names an upstream URL.
//
// EVERY READ ANSWERS ONE OF TWO WAYS: the chain's answer, or 'unread' with a reason. Nothing
// here turns a failed read into an empty list, a zero or a "not found": the house rule
// (reference_unreadable_must_not_read_as_fine) is that a zero is publishable only when a read
// returned it.

import { parseAddressBech32 } from './address';
import type { ChainUtxo } from './minswapV2';

export const CARDANO_PROXY_PATH = '/api/cardano';

export type Read<T> = { status: 'ok'; data: T } | { status: 'unread'; reason: string };

const unread = (reason: string): { status: 'unread'; reason: string } => ({ status: 'unread', reason });

async function getJson(op: string, params: Record<string, string>, signal?: AbortSignal): Promise<Read<unknown>> {
  const qs = new URLSearchParams(params).toString();
  let res: Response;
  try {
    res = await fetch(`${CARDANO_PROXY_PATH}/${op}${qs ? `?${qs}` : ''}`, { signal, headers: { Accept: 'application/json' } });
  } catch {
    return unread('the chain could not be reached');
  }
  if (!res.ok) return unread(res.status === 429 ? 'too many reads just now' : `the chain read failed (${res.status})`);
  try {
    return { status: 'ok', data: await res.json() };
  } catch {
    return unread('the chain answered with something that is not JSON');
  }
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** A decimal string as a bigint, or null. Koios sends amounts as strings; a number is refused. */
function amount(v: unknown): bigint | null {
  return typeof v === 'string' && /^\d{1,40}$/.test(v) ? BigInt(v) : null;
}

/**
 * A Koios UTxO row as a ChainUtxo, or null when any field is missing or malformed. All or
 * nothing: a row with one unreadable asset is not shown with that asset missing.
 */
export function chainUtxoFromKoios(row: unknown): ChainUtxo | null {
  if (!isRecord(row)) return null;
  const { tx_hash, tx_index, address, value, inline_datum, asset_list } = row;
  if (typeof tx_hash !== 'string' || !/^[0-9a-f]{64}$/.test(tx_hash)) return null;
  if (typeof tx_index !== 'number' || !Number.isInteger(tx_index) || tx_index < 0) return null;
  if (typeof address !== 'string') return null;
  const parsed = parseAddressBech32(address);
  if (!parsed) return null;
  const lovelace = amount(value);
  if (lovelace === null) return null;
  const assets: ChainUtxo['assets'] = [];
  if (asset_list !== null && asset_list !== undefined) {
    if (!Array.isArray(asset_list)) return null;
    for (const a of asset_list) {
      if (!isRecord(a)) return null;
      const quantity = amount(a.quantity);
      if (typeof a.policy_id !== 'string' || !/^[0-9a-f]{56}$/.test(a.policy_id)) return null;
      if (typeof a.asset_name !== 'string' || !/^(?:[0-9a-f]{2}){0,32}$/.test(a.asset_name)) return null;
      if (quantity === null) return null;
      assets.push({ policyId: a.policy_id, assetName: a.asset_name, quantity });
    }
  }
  let inlineDatumHex: string | null = null;
  if (inline_datum !== null && inline_datum !== undefined) {
    if (!isRecord(inline_datum) || typeof inline_datum.bytes !== 'string' || !/^(?:[0-9a-f]{2})+$/.test(inline_datum.bytes)) return null;
    inlineDatumHex = inline_datum.bytes;
  }
  return { txHash: tx_hash, index: tx_index, addressHex: parsed.hex, lovelace, assets, inlineDatumHex };
}

/** Minswap V2's pool NFT ("MSP" under the authen policy): minted only into a real pool. */
const POOL_NFT_POLICY = 'f5808c2c990d86da54bfc97d89cee6efa20cd8461616359478d96b4c';
const POOL_NFT_NAME = '4d5350';

function carriesPoolNft(row: unknown): boolean {
  if (!isRecord(row) || !Array.isArray(row.asset_list)) return false;
  return row.asset_list.some((a) => isRecord(a) && a.policy_id === POOL_NFT_POLICY && a.asset_name === POOL_NFT_NAME);
}

/**
 * Every UTxO at Minswap V2's pool script holding this LP token and the pool NFT. The caller
 * decides which is the pool (minswapV2.readPool).
 *
 * A row without the pool NFT is dropped unread: it can never be the pool, and anyone can park
 * such a row at the pool script for about 1.5 ADA (with an address this page cannot parse, it
 * would otherwise turn every quote for the pair into "unread", for good). A row WITH the NFT
 * that cannot be read is a real pool unread, and the whole read says so.
 */
export async function readPoolCandidates(lpName: string, signal?: AbortSignal): Promise<Read<ChainUtxo[]>> {
  const r = await getJson('pool', { lp: lpName }, signal);
  if (r.status !== 'ok') return r;
  if (!Array.isArray(r.data)) return unread('the pool read was not a list');
  const out: ChainUtxo[] = [];
  for (const row of r.data.filter(carriesPoolNft)) {
    const u = chainUtxoFromKoios(row);
    if (!u) return unread('a pool row could not be read');
    out.push(u);
  }
  return { status: 'ok', data: out };
}

export interface ChainTip {
  slot: number;
  blockHeight: number;
  /** Unix seconds. */
  blockTime: number;
}

export async function readTip(signal?: AbortSignal): Promise<Read<ChainTip>> {
  const r = await getJson('tip', {}, signal);
  if (r.status !== 'ok') return r;
  const row = Array.isArray(r.data) ? r.data[0] : null;
  if (!isRecord(row)) return unread('the tip read was empty');
  const { abs_slot, block_height, block_time } = row;
  if (typeof abs_slot !== 'number' || typeof block_height !== 'number' || typeof block_time !== 'number') return unread('the tip read was malformed');
  return { status: 'ok', data: { slot: abs_slot, blockHeight: block_height, blockTime: block_time } };
}

/** The protocol parameters a transaction is priced and sized by. */
export interface ProtocolParams {
  txFeePerByte: bigint;
  txFeeFixed: bigint;
  utxoCostPerByte: bigint;
  maxTxSize: number;
  maxValueSize: number;
  stakeAddressDeposit: bigint;
  stakePoolDeposit: bigint;
  minFeeRefScriptCostPerByte: number;
}

export async function readProtocolParams(signal?: AbortSignal): Promise<Read<ProtocolParams>> {
  const r = await getJson('params', {}, signal);
  if (r.status !== 'ok') return r;
  if (!isRecord(r.data)) return unread('the parameters read was malformed');
  const p = r.data;
  const int = (v: unknown): number | null => (typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? v : null);
  const fields = {
    txFeePerByte: int(p.txFeePerByte),
    txFeeFixed: int(p.txFeeFixed),
    utxoCostPerByte: int(p.utxoCostPerByte),
    maxTxSize: int(p.maxTxSize),
    maxValueSize: int(p.maxValueSize),
    stakeAddressDeposit: int(p.stakeAddressDeposit),
    stakePoolDeposit: int(p.stakePoolDeposit),
    minFeeRefScriptCostPerByte: int(p.minFeeRefScriptCostPerByte),
  };
  for (const [k, v] of Object.entries(fields)) if (v === null) return unread(`the parameter ${k} was unreadable`);
  return {
    status: 'ok',
    data: {
      txFeePerByte: BigInt(fields.txFeePerByte!),
      txFeeFixed: BigInt(fields.txFeeFixed!),
      utxoCostPerByte: BigInt(fields.utxoCostPerByte!),
      maxTxSize: fields.maxTxSize!,
      maxValueSize: fields.maxValueSize!,
      stakeAddressDeposit: BigInt(fields.stakeAddressDeposit!),
      stakePoolDeposit: BigInt(fields.stakePoolDeposit!),
      minFeeRefScriptCostPerByte: fields.minFeeRefScriptCostPerByte!,
    },
  };
}

/** What the chain and the token registry say a token is called, and its decimals. */
export interface TokenInfo {
  policyId: string;
  assetName: string;
  /** The registry's or the token's own CIP-68 ticker; null when neither has one. */
  ticker: string | null;
  name: string | null;
  /** Null when no record names decimals: amounts are then whole units, and the page says so. */
  decimals: number | null;
  fingerprint: string;
}

function cip68Field(meta: unknown, key: string): unknown {
  // CIP-68 fungible (label 333) metadata: Constr 0 [map, version, extra], the map keyed by bytes.
  if (!isRecord(meta)) return undefined;
  const ft = meta['333'];
  if (!isRecord(ft) || !Array.isArray(ft.fields)) return undefined;
  const map = ft.fields[0];
  if (!isRecord(map) || !Array.isArray(map.map)) return undefined;
  const keyHex = Array.from(new TextEncoder().encode(key), (b) => b.toString(16).padStart(2, '0')).join('');
  for (const entry of map.map) {
    if (isRecord(entry) && isRecord(entry.k) && entry.k.bytes === keyHex) return entry.v;
  }
  return undefined;
}

function utf8FromHex(hex: unknown): string | null {
  if (typeof hex !== 'string' || !/^(?:[0-9a-f]{2})*$/.test(hex)) return null;
  try {
    const bytes = new Uint8Array(hex.length / 2);
    for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

export async function readTokenInfo(policyId: string, assetName: string, signal?: AbortSignal): Promise<Read<TokenInfo | null>> {
  const r = await getJson('asset', { policy: policyId, name: assetName }, signal);
  if (r.status !== 'ok') return r;
  if (!Array.isArray(r.data)) return unread('the token read was not a list');
  // An empty answer is the chain saying no such token was ever minted.
  const row = r.data.find((x) => isRecord(x) && x.policy_id === policyId && x.asset_name === assetName);
  if (row === undefined) return { status: 'ok', data: null };
  if (!isRecord(row) || typeof row.fingerprint !== 'string') return unread('the token read was malformed');
  const reg = isRecord(row.token_registry_metadata) ? row.token_registry_metadata : null;
  const cipTicker = utf8FromHex(isRecord(cip68Field(row.cip68_metadata, 'ticker')) ? (cip68Field(row.cip68_metadata, 'ticker') as Record<string, unknown>).bytes : undefined);
  const cipName = utf8FromHex(isRecord(cip68Field(row.cip68_metadata, 'name')) ? (cip68Field(row.cip68_metadata, 'name') as Record<string, unknown>).bytes : undefined);
  const cipDecimalsRaw = cip68Field(row.cip68_metadata, 'decimals');
  const cipDecimals = isRecord(cipDecimalsRaw) && typeof cipDecimalsRaw.int === 'number' ? cipDecimalsRaw.int : null;
  const regDecimals = reg && typeof reg.decimals === 'number' ? reg.decimals : null;
  const decimals = regDecimals ?? cipDecimals;
  if (decimals !== null && (!Number.isInteger(decimals) || decimals < 0 || decimals > 19)) return unread('the token names impossible decimals');
  const text = (v: unknown) => (typeof v === 'string' && v.trim() !== '' ? v.trim().slice(0, 64) : null);
  return {
    status: 'ok',
    data: {
      policyId,
      assetName,
      ticker: text(reg?.ticker) ?? text(cipTicker),
      name: text(reg?.name) ?? text(cipName) ?? text(row.asset_name_ascii),
      decimals,
      fingerprint: row.fingerprint,
    },
  };
}

/** How deep a transaction is. null confirmations: the chain has not seen it (yet). */
export async function readTxDepth(txHash: string, signal?: AbortSignal): Promise<Read<number | null>> {
  const r = await getJson('txstatus', { tx: txHash }, signal);
  if (r.status !== 'ok') return r;
  const row = Array.isArray(r.data) ? r.data.find((x) => isRecord(x) && x.tx_hash === txHash) : undefined;
  if (!isRecord(row)) return unread('the status read was empty');
  const n = row.num_confirmations;
  if (n === null) return { status: 'ok', data: null };
  if (typeof n !== 'number' || !Number.isInteger(n) || n < 0) return unread('the status read was malformed');
  return { status: 'ok', data: n };
}

/** Whether a UTxO has been spent. null: the chain does not know this UTxO (yet). */
export async function readUtxoSpent(txHash: string, index: number, signal?: AbortSignal): Promise<Read<boolean | null>> {
  const r = await getJson('utxo', { ref: `${txHash}#${index}` }, signal);
  if (r.status !== 'ok') return r;
  if (!Array.isArray(r.data)) return unread('the output read was not a list');
  const row = r.data.find((x) => isRecord(x) && x.tx_hash === txHash && x.tx_index === index);
  if (row === undefined) return { status: 'ok', data: null };
  if (!isRecord(row) || typeof row.is_spent !== 'boolean') return unread('the output read was malformed');
  return { status: 'ok', data: row.is_spent };
}

/** Transactions touching a payment credential at or after a block height, newest first. */
export async function readCredentialTxs(paymentCred: string, afterHeight: number, signal?: AbortSignal): Promise<Read<{ txHash: string; blockHeight: number }[]>> {
  const r = await getJson('credtxs', { cred: paymentCred, after: String(afterHeight) }, signal);
  if (r.status !== 'ok') return r;
  if (!Array.isArray(r.data)) return unread('the history read was not a list');
  const out: { txHash: string; blockHeight: number }[] = [];
  for (const row of r.data) {
    if (!isRecord(row) || typeof row.tx_hash !== 'string' || typeof row.block_height !== 'number') return unread('a history row was malformed');
    out.push({ txHash: row.tx_hash, blockHeight: row.block_height });
  }
  return { status: 'ok', data: out.sort((a, b) => b.blockHeight - a.blockHeight) };
}

export interface ChainTx {
  txHash: string;
  inputs: { txHash: string; index: number }[];
  outputs: ChainUtxo[];
}

export async function readTx(txHash: string, signal?: AbortSignal): Promise<Read<ChainTx | null>> {
  const r = await getJson('tx', { tx: txHash }, signal);
  if (r.status !== 'ok') return r;
  if (!Array.isArray(r.data)) return unread('the transaction read was not a list');
  const row = r.data.find((x) => isRecord(x) && x.tx_hash === txHash);
  if (row === undefined) return { status: 'ok', data: null };
  if (!isRecord(row) || !Array.isArray(row.inputs) || !Array.isArray(row.outputs)) return unread('the transaction read was malformed');
  const inputs: ChainTx['inputs'] = [];
  for (const i of row.inputs) {
    if (!isRecord(i) || typeof i.tx_hash !== 'string' || typeof i.tx_index !== 'number') return unread('an input was malformed');
    inputs.push({ txHash: i.tx_hash, index: i.tx_index });
  }
  const outputs: ChainUtxo[] = [];
  for (const [i, o] of row.outputs.entries()) {
    // tx_info nests the address as payment_addr.bech32; flatten it to the UTxO shape. It sends
    // no datum bytes ({ bytes: null }), and nothing that reads a fill needs them.
    const flat = isRecord(o) && isRecord(o.payment_addr) ? { ...o, tx_hash: txHash, address: o.payment_addr.bech32, inline_datum: null } : null;
    // An output this rail cannot parse (a Byron or pointer address) is kept as paying nobody
    // it knows: it can never be the trader's, and one stranger's output must not make every
    // later transaction in a wallet's history unreadable.
    outputs.push(chainUtxoFromKoios(flat) ?? { txHash, index: i, addressHex: '', lovelace: 0n, assets: [], inlineDatumHex: null });
  }
  return { status: 'ok', data: { txHash, inputs, outputs } };
}
