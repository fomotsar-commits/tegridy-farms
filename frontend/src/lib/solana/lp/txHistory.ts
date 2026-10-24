// The one bounded transaction reader the ledger and the pool past share.
//
// A page is 20 signatures and at most 20 getTransaction calls, read at `confirmed`
// (the share it is reconciled against is read there, accounts.ts). A shape this file
// did not expect throws; the caller shows unread. Only an entry the node says is
// `finalized` is kept in memory: a confirmed one can still fall with its fork.
import type { SolanaRpc } from '../../launcher/solana/curve/rpc';

/** Signatures a page asks for, and the most getTransaction calls one page makes. */
export const HISTORY_PAGE = 20;
/** Pages an account is read for in one session; past that, older history is not read. */
export const HISTORY_PAGES_MAX = 5;
/** Classified entries kept in memory, oldest out. */
export const TX_CACHE_MAX = 2_000;

export interface SigEntry {
  signature: string;
  slot: number;
  blockTime: number | null;
  err: unknown;
  confirmationStatus: 'processed' | 'confirmed' | 'finalized' | null;
}

export interface Ix { programId: string; accounts: string[]; data: Uint8Array }
export interface Bal { accountIndex: number; mint: string; owner: string | null; amount: bigint }
export interface ParsedTx {
  signature: string;
  slot: number;
  blockTime: number | null;
  err: unknown;
  /** The message's keys, then the addresses loaded from lookup tables, writable then readonly. */
  keys: string[];
  /** The first `numRequiredSignatures` keys. */
  signers: string[];
  instructions: Ix[];
  inner: Ix[];
  pre: Bal[];
  post: Bal[];
  preLamports: number[];
  postLamports: number[];
}

const STATUSES = new Set(['processed', 'confirmed', 'finalized']);

function obj(what: string, v: unknown): Record<string, unknown> {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new Error(`${what}: expected an object`);
  return v as Record<string, unknown>;
}

function list(what: string, v: unknown): unknown[] {
  if (!Array.isArray(v)) throw new Error(`${what}: expected a list`);
  return v;
}

function num(what: string, v: unknown): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) throw new Error(`${what}: expected a number`);
  return v;
}

function str(what: string, v: unknown): string {
  if (typeof v !== 'string') throw new Error(`${what}: expected a string`);
  return v;
}

const BASE58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

/** Base58 to bytes, or `null` for a character outside the alphabet. (A copy of discover/list.ts: the discover folder is the launcher's.) */
function fromBase58(s: string): Uint8Array | null {
  let n = 0n;
  for (const ch of s) {
    const v = BASE58.indexOf(ch);
    if (v < 0) return null;
    n = n * 58n + BigInt(v);
  }
  const out: number[] = [];
  while (n > 0n) {
    out.push(Number(n & 0xffn));
    n >>= 8n;
  }
  for (const ch of s) {
    if (ch !== '1') break;
    out.push(0);
  }
  return Uint8Array.from(out.reverse());
}

function sigEntry(v: unknown): SigEntry {
  const o = obj('getSignaturesForAddress: an entry', v);
  if (!('err' in o)) throw new Error('getSignaturesForAddress: an entry has no err');
  const status = o.confirmationStatus ?? null;
  if (status !== null && !(typeof status === 'string' && STATUSES.has(status))) throw new Error('getSignaturesForAddress: an entry has an unknown confirmationStatus');
  return {
    signature: str('getSignaturesForAddress: signature', o.signature),
    slot: num('getSignaturesForAddress: slot', o.slot),
    blockTime: o.blockTime === undefined || o.blockTime === null ? null : num('getSignaturesForAddress: blockTime', o.blockTime),
    err: o.err,
    confirmationStatus: status as SigEntry['confirmationStatus'],
  };
}

/**
 * One page of an account's signatures, newest first, read at confirmed. `more` is
 * true only when the page is full; a short page is "the server had no more", never
 * "the beginning". A malformed entry throws.
 */
export async function readSignatures(rpc: SolanaRpc, address: string, opts: { before?: string }): Promise<{ entries: SigEntry[]; more: boolean }> {
  const config: Record<string, unknown> = { limit: HISTORY_PAGE };
  if (opts.before !== undefined) config.before = opts.before;
  config.commitment = 'confirmed';
  const answer = list('getSignaturesForAddress', await rpc('getSignaturesForAddress', [address, config]));
  if (answer.length > HISTORY_PAGE) throw new Error(`getSignaturesForAddress: more than ${HISTORY_PAGE} entries for a page of ${HISTORY_PAGE}`);
  const entries = answer.map(sigEntry);
  return { entries, more: entries.length === HISTORY_PAGE };
}

/** A `getTransaction` (json) answer as this reader uses it. Throws on any unexpected shape. */
export function parseTx(signature: string, raw: unknown): ParsedTx {
  const t = obj('getTransaction', raw);
  const tx = obj('getTransaction: transaction', t.transaction);
  const message = obj('getTransaction: message', tx.message);
  const meta = obj('getTransaction: meta', t.meta);
  if (!('err' in meta)) throw new Error('getTransaction: meta has no err');
  const keys = list('getTransaction: accountKeys', message.accountKeys).map((k) => str('getTransaction: an account key', k));
  if (meta.loadedAddresses !== undefined && meta.loadedAddresses !== null) {
    const loaded = obj('getTransaction: loadedAddresses', meta.loadedAddresses);
    for (const side of ['writable', 'readonly'] as const) {
      keys.push(...list(`getTransaction: loadedAddresses.${side}`, loaded[side] ?? []).map((k) => str('getTransaction: a loaded address', k)));
    }
  }
  const header = obj('getTransaction: header', message.header);
  const numSigners = num('getTransaction: numRequiredSignatures', header.numRequiredSignatures);
  if (numSigners < 1 || numSigners > keys.length) throw new Error('getTransaction: numRequiredSignatures outside the keys');
  const keyAt = (what: string, i: unknown): string => {
    const k = keys[num(what, i)];
    if (k === undefined) throw new Error(`${what}: index outside the keys`);
    return k;
  };
  const ix = (v: unknown): Ix => {
    const o = obj('getTransaction: an instruction', v);
    const data = fromBase58(str('getTransaction: instruction data', o.data));
    if (!data) throw new Error('getTransaction: instruction data is not base58');
    return {
      programId: keyAt('getTransaction: programIdIndex', o.programIdIndex),
      accounts: list('getTransaction: instruction accounts', o.accounts).map((i) => keyAt('getTransaction: an instruction account', i)),
      data,
    };
  };
  const bal = (v: unknown): Bal => {
    const o = obj('getTransaction: a token balance', v);
    const amount = obj('getTransaction: uiTokenAmount', o.uiTokenAmount).amount;
    if (typeof amount !== 'string' || !/^\d+$/.test(amount)) throw new Error('getTransaction: a token amount is not a decimal string');
    const owner = o.owner === undefined || o.owner === null ? null : str('getTransaction: a token balance owner', o.owner);
    const accountIndex = num('getTransaction: accountIndex', o.accountIndex);
    if (keys[accountIndex] === undefined) throw new Error('getTransaction: accountIndex outside the keys');
    return { accountIndex, mint: str('getTransaction: a token balance mint', o.mint), owner, amount: BigInt(amount) };
  };
  const balances = (what: string, v: unknown): Bal[] => (v === undefined || v === null ? [] : list(what, v).map(bal));
  const lamports = (what: string, v: unknown): number[] => {
    const out = list(what, v).map((n) => num(what, n));
    if (out.length !== keys.length) throw new Error(`${what}: one entry per key expected`);
    return out;
  };
  const innerGroups = meta.innerInstructions === undefined || meta.innerInstructions === null ? [] : list('getTransaction: innerInstructions', meta.innerInstructions);
  return {
    signature,
    slot: num('getTransaction: slot', t.slot),
    blockTime: t.blockTime === undefined || t.blockTime === null ? null : num('getTransaction: blockTime', t.blockTime),
    err: meta.err,
    keys,
    signers: keys.slice(0, numSigners),
    instructions: list('getTransaction: instructions', message.instructions).map(ix),
    inner: innerGroups.flatMap((g) => list('getTransaction: an inner instruction group', obj('getTransaction: an inner instruction group', g).instructions).map(ix)),
    pre: balances('getTransaction: preTokenBalances', meta.preTokenBalances),
    post: balances('getTransaction: postTokenBalances', meta.postTokenBalances),
    preLamports: lamports('getTransaction: preBalances', meta.preBalances),
    postLamports: lamports('getTransaction: postBalances', meta.postBalances),
  };
}

/**
 * The transactions of one page, at most 20 getTransaction calls at confirmed, version 0
 * allowed. `null` is "no record", a real answer, kept apart from a throw. One refused or
 * malformed answer fails the whole page, but only after every call has settled and each
 * finalized transaction that did answer is remembered: the next press asks only for the rest.
 */
export async function readTransactions(rpc: SolanaRpc, entries: SigEntry[]): Promise<Map<string, ParsedTx | null>> {
  if (entries.length > HISTORY_PAGE) throw new Error(`readTransactions: ${entries.length} entries is more than a page of ${HISTORY_PAGE}`);
  const answers = await Promise.allSettled(
    entries.map(async (e) => {
      const raw = await rpc('getTransaction', [e.signature, { encoding: 'json', maxSupportedTransactionVersion: 0, commitment: 'confirmed' }]);
      const tx = raw === null ? null : parseTx(e.signature, raw);
      if (tx) remember(e, tx);
      return tx;
    }),
  );
  const out = new Map<string, ParsedTx | null>();
  for (const [i, a] of answers.entries()) {
    if (a.status === 'rejected') throw a.reason;
    out.set(entries[i]!.signature, a.value);
  }
  return out;
}

/**
 * What `address` gained in this transaction: post minus pre by its index in the keys.
 * A side it is absent from is 0 (the account was created or closed inside). Keyed by
 * index, never by owner: two accounts of one owner stay apart. An address the
 * transaction does not name did not move.
 */
export function tokenDelta(tx: ParsedTx, address: string): bigint {
  const index = tx.keys.indexOf(address);
  if (index < 0) return 0n;
  const at = (side: Bal[]) => side.find((b) => b.accountIndex === index)?.amount ?? 0n;
  return at(tx.post) - at(tx.pre);
}

const cache = new Map<string, unknown>();

/** The value remembered for a finalized signature this session, if any. */
export function cached<T>(signature: string): T | undefined {
  return cache.get(signature) as T | undefined;
}

/** Keep `value` for the session, only when the chain has finalized the entry. Past TX_CACHE_MAX, the oldest leaves. */
export function remember<T>(entry: SigEntry, value: T): void {
  if (entry.confirmationStatus !== 'finalized') return;
  cache.delete(entry.signature);
  cache.set(entry.signature, value);
  while (cache.size > TX_CACHE_MAX) cache.delete(cache.keys().next().value!);
}
