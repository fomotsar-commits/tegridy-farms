// The browser transport for `tegridy-launch` — JSON-RPC over OUR OWN origin.
//
// `read.ts` is written against the `CurveRpc` interface so it can be exercised
// without a network. This is the one implementation of that interface a page may
// use, plus the two reads that need a raw account rather than a decoded one.
//
// RPC constraints this file lives inside (frontend/api/solrpc.js:34-48):
//   - the browser NEVER talks to a Solana host directly; the keyed URL stays
//     server-side behind /api/solrpc;
//   - `getProgramAccounts` is NOT on the allowlist — deliberately, as an unbounded
//     scan. There is therefore NO way to enumerate launches from the browser.
//     Everything here is keyed by a mint the caller already has, and any "all
//     launches" list is a curated one that must say so;
//   - batches are capped at 20 calls.
//
// ⚠️ THE WRITE SEAM IS NOT HERE. Nothing in this file builds, signs or sends a
// transaction, on purpose:
//   - the program id is a documented PLACEHOLDER (lib.rs:97-100) that is guaranteed
//     to change before any deploy, so an instruction encoded against it today
//     targets an address that will be wrong;
//   - the program is not deployed on any cluster, so a submit path could never be
//     exercised, let alone verified against a confirmed transaction.
// `ix.ts` holds the encoders for when it lands; `CurveWriteClient` below is the
// interface the write client must satisfy. A button that builds a transaction
// against a program id that returns null is worse than an honest "not live yet".
//
// ── THE DEFECT THIS FILE EXISTS TO NOT HAVE ──────────────────────────────────
// A JSON-RPC 200 that carries NEITHER `result` NOR `error` is a malformed
// response. The obvious transport returns `body.result`, which is `undefined`
// there, and every `?? null` / `?? []` downstream then converts that silence into
// a confident negative: `{status:'not-deployed'}`, and a page that states "There
// is no program at this address. No launches exist…". That is a fabricated finding
// manufactured out of a non-answer.
//
// So `browserRpc` THROWS on a malformed body, and every reader below treats a
// throw as `unreadable`. The rule is one line: a shape we did not expect is never
// evidence — see `expectObject` / `expectAccountValue`.

import { PublicKey } from '@solana/web3.js';
import { solanaRpcEndpoint } from '../../../solana';
import { PROGRAM_ID, TOKEN_PROGRAM_ID } from './program';
import { clipDetail, type AccountSnapshot, type CurveRpc, type Read } from './read';

export type SolanaRpc = (method: string, params: unknown[]) => Promise<unknown>;

/** The account fields the proxy returns for `{ encoding: 'base64' }`. */
interface RpcAccount {
  data?: [string, string] | string;
  owner?: string;
  executable?: boolean;
  lamports?: number;
}

/**
 * JSON-RPC over our own origin. Never a Solana host — see the header.
 *
 * Throws on: a non-2xx status, a body that is not an object, an `error` member,
 * and — the fix — a body carrying neither `result` nor `error`. A `result` of
 * `null` is a REAL answer ("no account there") and passes through untouched; the
 * distinction is between a null answer and no answer at all.
 */
export function browserRpc(fetchImpl: typeof fetch = fetch): SolanaRpc {
  const endpoint = solanaRpcEndpoint();
  let id = 0;
  return async (method, params) => {
    const res = await fetchImpl(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }),
    });
    if (!res.ok) throw new Error(`${method}: HTTP ${res.status}`);

    let body: unknown;
    try {
      body = await res.json();
    } catch (e) {
      // `cause` keeps the parser's own error reachable — the clipped detail in the
      // message is for humans, not for whoever has to debug a malformed proxy response.
      throw new Error(`${method}: the response was not JSON (${clipDetail(e)})`, { cause: e });
    }
    if (typeof body !== 'object' || body === null) {
      throw new Error(`${method}: the response was not a JSON-RPC object`);
    }

    const b = body as { result?: unknown; error?: { message?: string } };
    if (b.error) throw new Error(`${method}: ${b.error.message ?? 'unknown RPC error'}`);
    // `'result' in b` rather than `b.result !== undefined`: an explicit
    // `"result": null` is a real answer and must survive, while a body with no
    // `result` member at all is a non-answer and must not be mistaken for one.
    // `'result' in b` rather than `b.result !== undefined`: an explicit
    // `"result": null` is a real answer and must survive, while a body with no
    // `result` member at all is a non-answer and must not be mistaken for one.
    if (!('result' in b)) {
      throw new Error(`${method}: the response carried neither a result nor an error`);
    }
    return b.result;
  };
}

/**
 * Narrow an RPC payload to an object, or say the shape was wrong.
 *
 * Every caller below routes the failure to `unreadable`. Returning `null` and
 * letting a `??` pick a default is the whole bug class.
 */
function expectObject(method: string, v: unknown): Record<string, unknown> {
  if (typeof v !== 'object' || v === null) {
    throw new Error(`${method}: expected an object, got ${v === null ? 'null' : typeof v}`);
  }
  return v as Record<string, unknown>;
}

/**
 * Pull `.value` out of an RPC context wrapper.
 *
 * `value: null` is a real "no account here". A MISSING `value` member is a
 * malformed response and throws, because "the account is absent" and "the server
 * did not answer" are different facts and only one of them is about the chain.
 */
function expectAccountValue(method: string, payload: unknown): RpcAccount | null {
  const o = expectObject(method, payload);
  if (!('value' in o)) throw new Error(`${method}: the response carried no \`value\``);
  const v = o.value;
  if (v === null || v === undefined) return null;
  return expectObject(method, v) as RpcAccount;
}

/** Decode an `{ encoding: 'base64' }` account payload. Throws on an unusable shape. */
function accountData(method: string, account: RpcAccount): Uint8Array {
  const raw = account.data;
  const b64 = Array.isArray(raw) ? raw[0] : raw;
  if (typeof b64 !== 'string') {
    throw new Error(`${method}: the account carried no base64 data`);
  }
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/**
 * Adapt the JSON-RPC transport to the `CurveRpc` shape `read.ts` consumes.
 *
 * Everything `read.ts` does — deployment probe, phase classification, the
 * honest-unknown types — then works over the proxy unchanged, which is why there
 * is exactly one reader and one classifier in this directory rather than two.
 */
export function browserCurveRpc(rpc: SolanaRpc = browserRpc()): CurveRpc {
  return {
    async getAccountInfo(address: PublicKey): Promise<AccountSnapshot | null> {
      const payload = await rpc('getAccountInfo', [address.toBase58(), { encoding: 'base64' }]);
      const account = expectAccountValue('getAccountInfo', payload);
      if (account === null) return null;
      if (typeof account.owner !== 'string') {
        throw new Error('getAccountInfo: the account carried no owner');
      }
      if (typeof account.lamports !== 'number') {
        throw new Error('getAccountInfo: the account carried no lamport balance');
      }
      // `executable` is the field the whole deployment probe gates on, so it gets the
      // same runtime check as `owner` and `lamports` rather than being trusted because
      // the interface says `boolean`. TypeScript does not check a JSON payload, so a
      // proxy returning a string, a number, or null would otherwise flow straight into
      // `AccountSnapshot.executable` and be compared with `=== undefined` — which it is
      // not — landing on the "exists but is not a program" branch off a value nobody
      // validated. ABSENT stays `undefined` deliberately: `readDeployment` turns that
      // into `unreadable`, whereas defaulting to `false` would report a real program as
      // a squatting account.
      if (account.executable !== undefined && typeof account.executable !== 'boolean') {
        throw new Error('getAccountInfo: the account carried a non-boolean executable flag');
      }
      return {
        data: accountData('getAccountInfo', account),
        lamports: account.lamports,
        owner: new PublicKey(account.owner),
        executable: account.executable,
      };
    },

    async getMinimumBalanceForRentExemption(dataLength: number): Promise<number> {
      const v = await rpc('getMinimumBalanceForRentExemption', [dataLength]);
      if (typeof v !== 'number') {
        throw new Error('getMinimumBalanceForRentExemption: expected a number');
      }
      return v;
    },
  };
}

// ── the mint, which is not a program account ─────────────────────────────────

/** What a create-launch surface must know about a candidate mint (lib.rs:1283-1289). */
export interface MintFacts {
  /** Base units. `create_launch` requires 0 — the program mints the whole supply itself. */
  supply: bigint;
  /** NOT constrained by the program and NOT stored on the curve. Never assume 9. */
  decimals: number;
  mintAuthority: string | null;
  /**
   * Load-bearing: a retained freeze authority can freeze `curve_vault`, a
   * deterministic publicly-derivable PDA, and lock 100% of raised SOL forever.
   * `create_launch` rejects a mint that has one (MintHasFreezeAuthority, 6011).
   */
  freezeAuthority: string | null;
  /** True only for the legacy SPL Token program. Token-2022 fails validation. */
  isLegacySplToken: boolean;
}

/** The canonical SPL `Mint` layout is 82 bytes. */
const MINT_SIZE = 82;

/**
 * Read an SPL mint by fixed offset.
 *
 * By offset rather than via @solana/spl-token so this stays a plain account read —
 * the same reason `program.ts` decodes by offset. Returns the same `Read<T>` the
 * rest of the directory uses, so an unreadable mint cannot be mistaken for an
 * absent one.
 */
export async function readMint(rpc: SolanaRpc, mintBase58: string): Promise<Read<MintFacts>> {
  let account: RpcAccount | null;
  try {
    const payload = await rpc('getAccountInfo', [mintBase58, { encoding: 'base64' }]);
    account = expectAccountValue('getAccountInfo', payload);
  } catch (e) {
    return { kind: 'unreadable', detail: clipDetail(e) };
  }
  if (account === null) return { kind: 'absent' };

  let data: Uint8Array;
  try {
    data = accountData('getAccountInfo', account);
  } catch (e) {
    return { kind: 'unreadable', detail: clipDetail(e) };
  }
  if (data.length < MINT_SIZE) {
    return { kind: 'undecodable', reason: 'bad-length' };
  }

  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const optionalKey = (tagOffset: number, keyOffset: number): string | null =>
    view.getUint32(tagOffset, true) === 1
      ? new PublicKey(data.slice(keyOffset, keyOffset + 32)).toBase58()
      : null;

  return {
    kind: 'ok',
    value: {
      mintAuthority: optionalKey(0, 4),
      supply: view.getBigUint64(36, true),
      // Length was verified as >= 82 above; the fallback only satisfies
      // noUncheckedIndexedAccess and is unreachable.
      decimals: data[44] ?? 0,
      freezeAuthority: optionalKey(46, 50),
      isLegacySplToken: account.owner === TOKEN_PROGRAM_ID.toBase58(),
    },
  };
}

// ── the write seam — an interface, deliberately with no implementation here ──

export interface BuyRequest {
  mint: string;
  /** A CEILING, not a spend. The program caps it at the graduation line. */
  maxLamportsIn: bigint;
  /** Slippage floor. Must never be 0 from a user surface. */
  minTokensOut: bigint;
}

export interface SellRequest {
  mint: string;
  tokensIn: bigint;
  minLamportsOut: bigint;
}

/**
 * What a write client must provide before a page can offer a signable action.
 *
 * Implementing it also means honouring the obligations the read path cannot:
 * creating the trader's ATA (nothing in `buy`/`sell` creates it), and — for
 * migration — prepending `setComputeUnitLimit(MIGRATE_COMPUTE_UNITS)`, since
 * `migrate_to_amm` measured 264,128 CU against a 200,000 default and fails with
 * "Program failed to complete" without it.
 *
 * `buy`/`sell` compute cost has never been measured in this repo. Any limit set
 * for them is a guess and must be commented as one.
 */
export interface CurveWriteClient {
  buy(req: BuyRequest): Promise<string>;
  sell(req: SellRequest): Promise<string>;
}

export { PROGRAM_ID };
