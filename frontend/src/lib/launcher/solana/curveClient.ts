// tegridy-launch — the READ seam. The only place in the curve surface that does I/O.
//
// Split from curve.ts on the same doctrine as dbc.ts / dbcClient.ts: all the
// arithmetic that can be wrong about money lives in the pure module and is unit
// tested without a network; this file is a thin transport plus PDA derivation.
//
// ⚠️ THE WRITE SEAM IS NOT HERE. Nothing in this file builds, signs or sends a
// transaction, on purpose:
//   - the program id is a documented PLACEHOLDER (lib.rs:97-100) that is
//     guaranteed to change before any deploy, so an instruction encoded against
//     it today targets an address that will be wrong;
//   - the program is not deployed on any cluster, so a submit path could never
//     be exercised, let alone verified against a confirmed transaction.
// `CurveWriteClient` at the bottom is the interface the write client must
// satisfy when it lands. The page renders a quote and a disabled action until
// one is supplied — a button that builds a transaction against a program id
// that returns null is worse than an honest "not live yet".
//
// RPC constraints this file lives inside (frontend/api/solrpc.js:34-48):
//   - the browser NEVER talks to a Solana RPC host directly; the keyed URL
//     stays server-side behind /api/solrpc;
//   - `getProgramAccounts` is NOT on the allowlist — deliberately, as an
//     unbounded scan. There is therefore NO way to enumerate launches from the
//     browser. Everything here is keyed by a mint the caller already has;
//   - batches are capped at 20 calls. The reads below use 3.

import { solanaRpcEndpoint } from '../../solana';
import {
  TEGRIDY_LAUNCH_PROGRAM_ID,
  CURVE_SEEDS,
  decodeBondingCurve,
  decodeGlobalConfig,
  type AccountRead,
  type BondingCurveState,
  type GlobalConfigState,
  type ProgramProbe,
} from './curve';

/** Legacy SPL Token. `tegridy-launch` types every token account `Program<'info, Token>`. */
export const TOKEN_PROGRAM_ID = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
/** Token-2022 is NOT supported — a 2022 mint fails account validation on chain. */
export const TOKEN_2022_PROGRAM_ID = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';

/**
 * Bound an RPC error before it reaches a page. Mirrors tokenDossier.ts's
 * `clipMessage`: a transport error can carry an entire request body, and the
 * leading sentence is the whole diagnostic value.
 */
export function clipMessage(s: string, max = 180): string {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max)}…` : t;
}

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------

export type SolanaRpc = (method: string, params: unknown[]) => Promise<unknown>;

/** JSON-RPC over our own origin. Never a Solana host — see the header. */
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
    const body = (await res.json()) as { result?: unknown; error?: { message?: string } };
    if (body.error) throw new Error(`${method}: ${body.error.message ?? 'unknown RPC error'}`);
    return body.result;
  };
}

interface RpcAccount {
  data?: [string, string] | string;
  owner?: string;
  executable?: boolean;
  lamports?: number;
}

/** Decode an `{ encoding: 'base64' }` account payload. Returns null for a missing account. */
function accountData(account: RpcAccount | null | undefined): Uint8Array | null {
  const raw = account?.data;
  const b64 = Array.isArray(raw) ? raw[0] : raw;
  if (typeof b64 !== 'string') return null;
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// ---------------------------------------------------------------------------
// PDA derivation
// ---------------------------------------------------------------------------

/**
 * Derive the launch PDAs.
 *
 * `Anchor.toml` sets `[features] seeds = false`, so the IDL carries no seed
 * metadata and Anchor's JS client can auto-resolve NOTHING here. Every address
 * is the client's job (both test suites pass all of them via
 * `.accountsPartial`). Dynamic import so @solana/web3.js stays out of any
 * bundle that only needs the pure math.
 */
export async function deriveLaunchPdas(mintBase58: string): Promise<{
  global: string;
  curve: string;
  vault: string;
  migrationAuthority: string;
  /** ⚠️ OUR seed, never cp-swap's canonical derivation — see CURVE_SEEDS.pool. */
  pool: string;
}> {
  // Seeds as `Buffer`, matching squads.ts's derivation rather than a
  // TextEncoder Uint8Array: web3.js's sync sha256 path is realm-sensitive, and
  // Buffer here is the same polyfilled class web3.js itself uses.
  const [{ PublicKey }, { Buffer }] = await Promise.all([import('@solana/web3.js'), import('buffer')]);
  const programId = new PublicKey(TEGRIDY_LAUNCH_PROGRAM_ID);
  const mint = new PublicKey(mintBase58);
  const seed = (s: string) => Buffer.from(s, 'utf8');
  const pda = (seeds: (Uint8Array | Buffer)[]) =>
    PublicKey.findProgramAddressSync(seeds as Uint8Array[], programId)[0].toBase58();
  return {
    global: pda([seed(CURVE_SEEDS.global)]),
    curve: pda([seed(CURVE_SEEDS.curve), mint.toBytes()]),
    vault: pda([seed(CURVE_SEEDS.vault), mint.toBytes()]),
    migrationAuthority: pda([seed(CURVE_SEEDS.migrationAuthority), mint.toBytes()]),
    pool: pda([seed(CURVE_SEEDS.pool), mint.toBytes()]),
  };
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/**
 * The FIRST read any surface performs. `null` → not deployed, stop; do not go
 * on to derive PDAs and render their absence as data.
 *
 * An account that exists but is not executable is neither "deployed" nor a
 * clean negative — something occupies the address that is not a program — so it
 * is reported as unreadable with the reason stated, not silently rounded to
 * either answer.
 */
export async function probeProgram(rpc: SolanaRpc, programId = TEGRIDY_LAUNCH_PROGRAM_ID): Promise<ProgramProbe> {
  try {
    const res = (await rpc('getAccountInfo', [programId, { encoding: 'base64' }])) as { value?: RpcAccount | null };
    const value = res?.value ?? null;
    if (value === null) return { status: 'not-deployed' };
    if (value.executable !== true) {
      return { status: 'unreadable', reason: 'That address holds a non-executable account, so it is not a program.' };
    }
    return { status: 'deployed' };
  } catch (e) {
    return { status: 'unreadable', reason: clipMessage((e as Error).message) };
  }
}

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

/**
 * Read an SPL mint by fixed offset (the canonical 82-byte `Mint` layout).
 *
 * By offset rather than via @solana/spl-token so this stays a plain account
 * read: the same reason curve.ts decodes by offset.
 */
export async function readMint(rpc: SolanaRpc, mintBase58: string): Promise<AccountRead<MintFacts>> {
  let res: { value?: RpcAccount | null };
  try {
    res = (await rpc('getAccountInfo', [mintBase58, { encoding: 'base64' }])) as { value?: RpcAccount | null };
  } catch (e) {
    return { status: 'unreadable', reason: clipMessage((e as Error).message) };
  }
  const account = res?.value ?? null;
  if (account === null) return { status: 'absent' };

  const data = accountData(account);
  if (data === null || data.length < 82) {
    return { status: 'unreadable', reason: `Mint account is ${data?.length ?? 0} bytes; expected at least 82.` };
  }

  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const { PublicKey } = await import('@solana/web3.js');
  const optionalKey = (tagOffset: number, keyOffset: number): string | null =>
    view.getUint32(tagOffset, true) === 1 ? new PublicKey(data.slice(keyOffset, keyOffset + 32)).toBase58() : null;

  return {
    status: 'present',
    value: {
      mintAuthority: optionalKey(0, 4),
      supply: view.getBigUint64(36, true),
      // Length was verified as >= 82 above; the fallback only satisfies
      // noUncheckedIndexedAccess and is unreachable.
      decimals: data[44] ?? 0,
      freezeAuthority: optionalKey(46, 50),
      isLegacySplToken: account.owner === TOKEN_PROGRAM_ID,
    },
  };
}

/**
 * A launch, as far as the chain will tell us.
 *
 * Note what is deliberately absent: no price, no volume, no holder count, no
 * market cap, no USD figure. None of them are in program state, and there is no
 * indexer — see §9 of docs/OWN_CURVE_FRONTEND_CONTRACT.md.
 */
export interface LaunchSnapshot {
  global: AccountRead<GlobalConfigState>;
  curve: AccountRead<BondingCurveState>;
  /**
   * The curve PDA's ACTUAL lamport balance — `rent + real_sol_reserves +
   * anything anyone donated`. Distinct from `real_sol_reserves`, and the two
   * are not interchangeable: progress renders the FIELD, while the sell rent
   * guard and the migration budget check read THIS. `null` when unread.
   */
  curveAccountLamports: bigint | null;
  /** Rent exemption for a 162-byte account; read, never hardcoded. */
  curveRentExemptLamports: bigint | null;
  pdas: { global: string; curve: string; vault: string; migrationAuthority: string; pool: string };
}

/**
 * Read everything a launch page needs for one mint.
 *
 * `getMultipleAccounts` keeps global + curve to a single round trip. A failure
 * marks the reads unreadable rather than absent — the distinction is the whole
 * point, and "absent" is a claim we have no right to make after a failed call.
 */
export async function readLaunch(rpc: SolanaRpc, mintBase58: string): Promise<LaunchSnapshot> {
  const pdas = await deriveLaunchPdas(mintBase58);
  const empty: LaunchSnapshot = {
    global: { status: 'unreadable', reason: 'not read' },
    curve: { status: 'unreadable', reason: 'not read' },
    curveAccountLamports: null,
    curveRentExemptLamports: null,
    pdas,
  };

  let accounts: (RpcAccount | null)[];
  try {
    const res = (await rpc('getMultipleAccounts', [[pdas.global, pdas.curve], { encoding: 'base64' }])) as {
      value?: (RpcAccount | null)[];
    };
    accounts = res?.value ?? [];
  } catch (e) {
    const reason = clipMessage((e as Error).message);
    return { ...empty, global: { status: 'unreadable', reason }, curve: { status: 'unreadable', reason } };
  }

  const curveAccount = accounts[1] ?? null;
  // Rent exemption is a separate call and is allowed to fail on its own: a
  // missing rent figure disables the checks that need it rather than
  // substituting a guess for it.
  let rentExempt: bigint | null = null;
  try {
    const r = await rpc('getMinimumBalanceForRentExemption', [162]);
    if (typeof r === 'number') rentExempt = BigInt(r);
  } catch {
    rentExempt = null;
  }

  return {
    global: decodeGlobalConfig(accountData(accounts[0] ?? null)),
    curve: decodeBondingCurve(accountData(curveAccount)),
    curveAccountLamports: typeof curveAccount?.lamports === 'number' ? BigInt(curveAccount.lamports) : null,
    curveRentExemptLamports: rentExempt,
    pdas,
  };
}

// ---------------------------------------------------------------------------
// The write seam — an interface, deliberately with no implementation here
// ---------------------------------------------------------------------------

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
 * What a write client must provide before this page can offer a signable action.
 *
 * Implementing it also means honouring the obligations the read path cannot:
 * creating the trader's ATA (nothing in `buy`/`sell` creates it), and — for
 * migration — prepending `setComputeUnitLimit(400_000)`, since `migrate_to_amm`
 * measured 264,128 CU against a 200,000 default and fails with "Program failed
 * to complete" without it.
 *
 * `buy`/`sell` compute cost has never been measured in this repo. Any limit set
 * for them is a guess and must be commented as one.
 */
export interface CurveWriteClient {
  buy(req: BuyRequest): Promise<string>;
  sell(req: SellRequest): Promise<string>;
}
