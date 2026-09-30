import type { SolanaRpc } from '../../launcher/solana/curve/rpc';

/**
 * Batched account reads for the LP pages, over the same `/api/solrpc` transport the
 * /curve-launch pages use (`browserRpc`).
 *
 * The rule from `curve/rpc.ts` holds here too: a response we did not expect is never
 * evidence. Every function below THROWS on a malformed answer, and every caller turns
 * a throw into "unread". `null` in the returned list means the chain said "no account
 * at this address", which is a real answer and a different one.
 */

export interface RawAccount {
  address: string;
  data: Uint8Array;
  owner: string;
  lamports: number;
}

/** The RPC's own limit for one getMultipleAccounts call. */
export const MAX_ACCOUNTS_PER_CALL = 100;

function expectObject(what: string, v: unknown): Record<string, unknown> {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new Error(`${what}: expected an object`);
  return v as Record<string, unknown>;
}

export function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** One `{ encoding: 'base64' }` account payload. Throws on any shape but the expected one. */
export function decodeRpcAccount(what: string, address: string, v: unknown): RawAccount {
  const a = expectObject(what, v);
  const raw = a.data;
  const b64 = Array.isArray(raw) ? raw[0] : raw;
  if (typeof b64 !== 'string') throw new Error(`${what}: an account carried no base64 data`);
  if (typeof a.owner !== 'string') throw new Error(`${what}: an account carried no owner`);
  if (typeof a.lamports !== 'number') throw new Error(`${what}: an account carried no lamport balance`);
  return { address, data: base64ToBytes(b64), owner: a.owner, lamports: a.lamports };
}

/**
 * Read up to any number of accounts, 100 per call, in the order given. `null` = no
 * account there. Throws if any call fails or answers with the wrong shape or length.
 */
export async function getMultipleAccounts(rpc: SolanaRpc, addresses: string[]): Promise<(RawAccount | null)[]> {
  const out: (RawAccount | null)[] = [];
  for (let i = 0; i < addresses.length; i += MAX_ACCOUNTS_PER_CALL) {
    const chunk = addresses.slice(i, i + MAX_ACCOUNTS_PER_CALL);
    const payload = expectObject('getMultipleAccounts', await rpc('getMultipleAccounts', [chunk, { encoding: 'base64' }]));
    if (!('value' in payload) || !Array.isArray(payload.value)) {
      throw new Error('getMultipleAccounts: the response carried no `value` list');
    }
    const list = payload.value as unknown[];
    if (list.length !== chunk.length) {
      throw new Error(`getMultipleAccounts: asked for ${chunk.length} accounts, got ${list.length} answers`);
    }
    list.forEach((v, j) => {
      out.push(v === null ? null : decodeRpcAccount('getMultipleAccounts', chunk[j]!, v));
    });
  }
  return out;
}

export interface TokenAccountEntry {
  address: string;
  mint: string;
  owner: string;
  amount: bigint;
}

/** SPL token account: mint(32) owner(32) amount(u64 LE @64). The same for Token-2022. */
export function decodeTokenAccount(address: string, data: Uint8Array, toBase58: (b: Uint8Array) => string): TokenAccountEntry | null {
  if (data.length < 72) return null;
  return {
    address,
    mint: toBase58(data.subarray(0, 32)),
    owner: toBase58(data.subarray(32, 64)),
    amount: new DataView(data.buffer, data.byteOffset, data.byteLength).getBigUint64(64, true),
  };
}

/**
 * Every token account `owner` holds under one token program. The commitment is set
 * here because this method's second parameter is a filter, not a config object, so
 * `withReadCommitment` does not reach it.
 */
export async function getTokenAccountsByOwner(
  rpc: SolanaRpc,
  owner: string,
  programId: string,
  toBase58: (b: Uint8Array) => string,
): Promise<TokenAccountEntry[]> {
  const payload = expectObject(
    'getTokenAccountsByOwner',
    await rpc('getTokenAccountsByOwner', [owner, { programId }, { encoding: 'base64', commitment: 'confirmed' }]),
  );
  if (!('value' in payload) || !Array.isArray(payload.value)) {
    throw new Error('getTokenAccountsByOwner: the response carried no `value` list');
  }
  const out: TokenAccountEntry[] = [];
  for (const item of payload.value as unknown[]) {
    const o = expectObject('getTokenAccountsByOwner', item);
    if (typeof o.pubkey !== 'string') throw new Error('getTokenAccountsByOwner: an entry carried no pubkey');
    const acc = decodeRpcAccount('getTokenAccountsByOwner', o.pubkey, o.account);
    if (acc.owner !== programId) throw new Error('getTokenAccountsByOwner: an entry is owned by another program');
    const t = decodeTokenAccount(acc.address, acc.data, toBase58);
    if (!t) throw new Error('getTokenAccountsByOwner: an entry is too short to be a token account');
    if (t.owner !== owner) throw new Error('getTokenAccountsByOwner: an entry belongs to another wallet');
    out.push(t);
  }
  return out;
}
