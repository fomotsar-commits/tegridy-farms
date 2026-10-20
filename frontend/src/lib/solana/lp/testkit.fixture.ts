// Shared builders for the LP read tests: pool, config, vault and mint bytes by the
// program's own offsets, and a fake JSON-RPC transport over an account map.
import { Buffer } from 'buffer';
import { Keypair, PublicKey } from '@solana/web3.js';
import {
  ACCOUNT_AMM_CONFIG,
  ACCOUNT_POOL_STATE,
  AMM_CONFIG_LEN,
  AMM_CONFIG_OFFSETS,
  POOL_STATE_LEN,
  POOL_STATE_OFFSETS,
  decodeAmmConfig,
  decodePoolState,
  deriveAmmConfig,
  deriveAuthority,
  deriveLpMint,
  deriveObservation,
  derivePool,
  deriveVault,
  sortMints,
} from '../cpswap/program';
import { TOKEN_PROGRAM, WSOL_MINT } from './tokenSafety';
import type { PoolView } from './poolFinder';
import { SOL_QUOTE, readPair, type QuoteCoin } from './quotes';
import type { SigEntry } from './txHistory';
import type { SolanaRpc } from '../../launcher/solana/curve/rpc';

export const PROGRAM = new PublicKey('EKS4C6xvV9A5DMWaWtVnFvi7ru78EhqRAoddEMpQ2BtT');
export const LAUNCH = new PublicKey('64WBTeNcrSHfmBpiqymyifW6FUNNLvJcuiqF9rXmz4q2');
export const WSOL = new PublicKey(WSOL_MINT);
export const CLOCK = 'SysvarC1ock11111111111111111111111111111111';
export const key = () => Keypair.generate().publicKey;
/**
 * A fresh key whose first byte is `first`. A pool stores its two mints in byte order, so a
 * test that needs a token on a chosen side of a coin's mint asks for it here instead of
 * hoping a random key lands there (USDC's mint starts with byte 198, wrapped SOL's with 6).
 */
export function keyStartingWith(first: number): PublicKey {
  const bytes = Keypair.generate().publicKey.toBytes();
  bytes[0] = first;
  return new PublicKey(bytes);
}

export interface FakeAccount { owner: string; data: Uint8Array; lamports?: number }

export function configBytes(index: number, tradeFeeRate = 10_000n, protocolFeeRate = 160_000n): Uint8Array {
  const d = new Uint8Array(AMM_CONFIG_LEN);
  d.set(ACCOUNT_AMM_CONFIG, 0);
  const v = new DataView(d.buffer);
  v.setUint16(AMM_CONFIG_OFFSETS.index, index, true);
  v.setBigUint64(AMM_CONFIG_OFFSETS.tradeFeeRate, tradeFeeRate, true);
  v.setBigUint64(AMM_CONFIG_OFFSETS.protocolFeeRate, protocolFeeRate, true);
  return d;
}

/** An SPL token account; `state` 1 = initialized (the default), 2 = frozen. */
export function tokenAccountBytes(mint: PublicKey, owner: PublicKey, amount: bigint, state = 1): Uint8Array {
  const d = new Uint8Array(165);
  d.set(mint.toBytes(), 0);
  d.set(owner.toBytes(), 32);
  new DataView(d.buffer).setBigUint64(64, amount, true);
  d[108] = state;
  return d;
}

export function mintBytes(mintAuthority: PublicKey | null, decimals = 6): Uint8Array {
  const d = new Uint8Array(82);
  const v = new DataView(d.buffer);
  if (mintAuthority) {
    v.setUint32(0, 1, true);
    d.set(mintAuthority.toBytes(), 4);
  }
  d[44] = decimals;
  d[45] = 1;
  return d;
}

export interface PoolSpec {
  mint: PublicKey;
  configIndex?: number;
  /** Where the pool sits; default the standard address for its config. */
  address?: PublicKey;
  /** The coin the token is paired with; default SOL. */
  quote?: QuoteCoin;
  /** The quote side's reserve, in the quote coin's base units. */
  quoteReserve: bigint;
  tokenReserve: bigint;
  openTime?: bigint;
  status?: number;
  /** Protocol fees owed on the quote side (named for the default, SOL). */
  protocolFeesSol?: bigint;
  lpSupply?: bigint;
  tokenDecimals?: number;
  /** Freeze the token-side vault (SPL account state 2). */
  frozenVault?: boolean;
  /**
   * Random keys instead of program-derived addresses. For jsdom tests, where
   * findProgramAddressSync fails every bump; nothing under test derives there.
   */
  plain?: boolean;
}

export interface BuiltPool { address: PublicKey; lpMint: PublicKey; config: PublicKey; observation: PublicKey; accounts: Record<string, FakeAccount> }

export function buildPool(s: PoolSpec): BuiltPool {
  const config = s.plain ? key() : deriveAmmConfig(PROGRAM, s.configIndex ?? 1);
  const quote = s.quote ?? SOL_QUOTE;
  const quoteMint = new PublicKey(quote.mint);
  const { token0, token1 } = sortMints(quoteMint, s.mint);
  const address = s.address ?? (s.plain ? key() : derivePool(PROGRAM, config, token0, token1));
  const v0 = s.plain ? key() : deriveVault(PROGRAM, address, token0);
  const v1 = s.plain ? key() : deriveVault(PROGRAM, address, token1);
  const lpMint = s.plain ? key() : deriveLpMint(PROGRAM, address);
  const observation = s.plain ? key() : deriveObservation(PROGRAM, address);
  const solIs0 = token0.equals(quoteMint);
  const d = new Uint8Array(POOL_STATE_LEN);
  d.set(ACCOUNT_POOL_STATE, 0);
  const o = POOL_STATE_OFFSETS;
  const v = new DataView(d.buffer);
  d.set(config.toBytes(), o.ammConfig);
  d.set(key().toBytes(), o.poolCreator);
  d.set(v0.toBytes(), o.token0Vault);
  d.set(v1.toBytes(), o.token1Vault);
  d.set(lpMint.toBytes(), o.lpMint);
  d.set(token0.toBytes(), o.token0Mint);
  d.set(token1.toBytes(), o.token1Mint);
  d.set(new PublicKey(solIs0 ? quote.program : TOKEN_PROGRAM).toBytes(), o.token0Program);
  d.set(new PublicKey(solIs0 ? TOKEN_PROGRAM : quote.program).toBytes(), o.token1Program);
  d.set(observation.toBytes(), o.observationKey);
  d[o.status] = s.status ?? 0;
  d[o.lpMintDecimals] = 9;
  d[o.mint0Decimals] = solIs0 ? quote.decimals : (s.tokenDecimals ?? 6);
  d[o.mint1Decimals] = solIs0 ? (s.tokenDecimals ?? 6) : quote.decimals;
  v.setBigUint64(o.lpSupply, s.lpSupply ?? 1_000_000n, true);
  const fees = s.protocolFeesSol ?? 0n;
  v.setBigUint64(solIs0 ? o.protocolFeesToken0 : o.protocolFeesToken1, fees, true);
  v.setBigUint64(o.openTime, s.openTime ?? 1n, true);
  const authority = s.plain ? key() : deriveAuthority(PROGRAM);
  const solVault = solIs0 ? v0 : v1;
  const tokVault = solIs0 ? v1 : v0;
  return {
    address,
    lpMint,
    config,
    observation,
    accounts: {
      [address.toBase58()]: { owner: PROGRAM.toBase58(), data: d },
      [solVault.toBase58()]: { owner: quote.program, data: tokenAccountBytes(quoteMint, authority, s.quoteReserve + fees) },
      [tokVault.toBase58()]: { owner: TOKEN_PROGRAM, data: tokenAccountBytes(s.mint, authority, s.tokenReserve, s.frozenVault ? 2 : 1) },
      [config.toBase58()]: { owner: PROGRAM.toBase58(), data: configBytes(s.configIndex ?? 1) },
      [lpMint.toBase58()]: { owner: TOKEN_PROGRAM, data: mintBytes(authority, 9) },
    },
  };
}

export function clockAccount(unix: bigint): FakeAccount {
  const d = new Uint8Array(40);
  new DataView(d.buffer).setBigInt64(32, unix, true);
  return { owner: 'Sysvar1111111111111111111111111111111111111', data: d };
}

const b64 = (d: Uint8Array) => Buffer.from(d).toString('base64');

/** A JSON-RPC transport over `accounts`. `fail` names methods that throw. */
export function fakeRpc(accounts: Record<string, FakeAccount>, opts: { fail?: Set<string>; calls?: [string, unknown[]][] } = {}): SolanaRpc {
  return async (method, params) => {
    opts.calls?.push([method, params]);
    if (opts.fail?.has(method)) throw new Error(`${method}: HTTP 502`);
    if (method === 'getMultipleAccounts') {
      const [addrs] = params as [string[]];
      return { context: { slot: 1 }, value: addrs.map((a) => (accounts[a] ? { data: [b64(accounts[a]!.data), 'base64'], owner: accounts[a]!.owner, lamports: accounts[a]!.lamports ?? 1 } : null)) };
    }
    if (method === 'getTokenAccountsByOwner') {
      const [owner, filter] = params as [string, { programId: string }];
      const value = Object.entries(accounts)
        .filter(([, a]) => a.owner === filter.programId && a.data.length === 165 && new PublicKey(a.data.subarray(32, 64)).toBase58() === owner)
        .map(([pubkey, a]) => ({ pubkey, account: { data: [b64(a.data), 'base64'], owner: a.owner, lamports: 1 } }));
      return { context: { slot: 1 }, value };
    }
    if (method === 'getMinimumBalanceForRentExemption') return (128 + (params as [number])[0]) * 6960;
    throw new Error(`fake rpc: ${method} not handled`);
  };
}

/**
 * `fakeRpc` plus history. `getSignaturesForAddress` answers from `history` (newest first,
 * honouring `limit` and `before`); an address not in `history` throws, so "no history" and
 * "not configured" stay apart. `getTransaction` answers from `txs` by signature, `null`
 * being "no record"; a signature not in `txs` throws.
 */
export function fakeRpcWithHistory(accounts: Record<string, FakeAccount>, history: Record<string, SigEntry[]>, txs: Record<string, unknown>, opts: { fail?: Set<string>; calls?: [string, unknown[]][] } = {}): SolanaRpc {
  const base = fakeRpc(accounts, opts);
  return async (method, params) => {
    if (method !== 'getSignaturesForAddress' && method !== 'getTransaction') return base(method, params);
    opts.calls?.push([method, params]);
    if (opts.fail?.has(method)) throw new Error(`${method}: HTTP 502`);
    if (method === 'getSignaturesForAddress') {
      const [address, o] = params as [string, { limit?: number; before?: string } | undefined];
      const all = history[address];
      if (!all) throw new Error(`fake rpc: no history configured for ${address}`);
      let from = 0;
      if (o?.before !== undefined) {
        const at = all.findIndex((e) => e.signature === o.before);
        if (at < 0) throw new Error(`fake rpc: before names a signature not in the history of ${address}`);
        from = at + 1;
      }
      return all.slice(from, from + (o?.limit ?? 1000));
    }
    const [signature] = params as [string];
    if (!(signature in txs)) throw new Error(`fake rpc: no transaction configured for ${signature}`);
    return txs[signature];
  };
}

const BASE58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

/** Bytes to base58, leading zero bytes as leading '1's (the inverse of txHistory's decoder). */
function toBase58(bytes: Uint8Array): string {
  let n = 0n;
  for (const b of bytes) n = (n << 8n) | BigInt(b);
  let out = '';
  while (n > 0n) {
    out = BASE58[Number(n % 58n)] + out;
    n /= 58n;
  }
  for (const b of bytes) {
    if (b !== 0) break;
    out = '1' + out;
  }
  return out;
}

export interface TxIxSpec { program: string; accounts: string[]; data: Uint8Array }
export interface TxJsonSpec {
  keys: string[];
  numSigners?: number;
  /** Addresses loaded from lookup tables: present makes the transaction v0. */
  loaded?: { writable?: string[]; readonly?: string[] };
  instructions: TxIxSpec[];
  inner?: { index: number; instructions: TxIxSpec[] }[];
  /** `null` on a side = absent on that side (the account was created or closed inside). */
  balances: { account: string; mint: string; owner?: string; pre: bigint | null; post: bigint | null }[];
  lamports?: { account: string; pre: number; post: number }[];
  err?: unknown;
  slot: number;
  blockTime: number | null;
}

/** A `getTransaction` (json) answer. Accounts by name; the builder encodes indices and base58 data. */
export function txJson(o: TxJsonSpec): unknown {
  const all = [...o.keys, ...(o.loaded?.writable ?? []), ...(o.loaded?.readonly ?? [])];
  const index = (name: string) => {
    const i = all.indexOf(name);
    if (i < 0) throw new Error(`txJson: ${name} is not among the keys`);
    return i;
  };
  const ix = (s: TxIxSpec) => ({ programIdIndex: index(s.program), accounts: s.accounts.map(index), data: toBase58(s.data) });
  const side = (which: 'pre' | 'post') =>
    o.balances
      .filter((b) => b[which] !== null)
      .map((b) => ({
        accountIndex: index(b.account),
        mint: b.mint,
        ...(b.owner === undefined ? {} : { owner: b.owner }),
        uiTokenAmount: { amount: b[which]!.toString(), decimals: 0, uiAmount: null, uiAmountString: b[which]!.toString() },
      }));
  const lamports = (which: 'pre' | 'post') => all.map((k) => o.lamports?.find((l) => l.account === k)?.[which] ?? 0);
  const err = o.err ?? null;
  return {
    slot: o.slot,
    blockTime: o.blockTime,
    version: o.loaded ? 0 : 'legacy',
    transaction: {
      message: {
        header: { numRequiredSignatures: o.numSigners ?? 1, numReadonlySignedAccounts: 0, numReadonlyUnsignedAccounts: 0 },
        accountKeys: o.keys,
        recentBlockhash: '11111111111111111111111111111111',
        instructions: o.instructions.map(ix),
      },
    },
    meta: {
      err,
      status: err === null ? { Ok: null } : { Err: err },
      fee: 5000,
      preBalances: lamports('pre'),
      postBalances: lamports('post'),
      preTokenBalances: side('pre'),
      postTokenBalances: side('post'),
      innerInstructions: (o.inner ?? []).map((g) => ({ index: g.index, instructions: g.instructions.map(ix) })),
      ...(o.loaded ? { loadedAddresses: { writable: o.loaded.writable ?? [], readonly: o.loaded.readonly ?? [] } } : {}),
      logMessages: [],
      rewards: [],
    },
  };
}

/** A fetch for /api/pools that answers from a table, keyed `mint:<m>` / `lpMint:<m>`, for the pool program PROGRAM. */
export function fakeIndex(table: Record<string, string[]>, opts: { status?: number; program?: string; truncated?: boolean; calls?: string[] } = {}): typeof fetch {
  return (async (url: string) => {
    const u = new URL(url, 'http://x');
    const [k, v] = [...u.searchParams.entries()][0]!;
    opts.calls?.push(`${k}:${v}`);
    if (opts.status) return new Response('{}', { status: opts.status });
    return new Response(JSON.stringify({ [k]: v, program: opts.program ?? PROGRAM.toBase58(), pools: table[`${k}:${v}`] ?? [], truncated: opts.truncated ?? false }), { status: 200 });
  }) as unknown as typeof fetch;
}

/** Observation (price record) bytes, by the oracle.rs layout. `obs`: [slot, timestamp, cumulative0, cumulative1]. */
export function observationBytes(o: { pool: PublicKey; initialized?: boolean; index?: number; lastUpdate?: bigint; obs?: [number, bigint, bigint, bigint][] }): Uint8Array {
  const d = new Uint8Array(4075);
  d.set([122, 174, 197, 53, 129, 9, 165, 132], 0);
  const v = new DataView(d.buffer);
  d[8] = o.initialized === false ? 0 : 1;
  v.setUint16(9, o.index ?? 0, true);
  d.set(o.pool.toBytes(), 11);
  const U64 = (1n << 64n) - 1n;
  for (const [slot, t, c0, c1] of o.obs ?? []) {
    const at = 43 + slot * 40;
    v.setBigUint64(at, t, true);
    v.setBigUint64(at + 8, c0 & U64, true);
    v.setBigUint64(at + 16, c0 >> 64n, true);
    v.setBigUint64(at + 24, c1 & U64, true);
    v.setBigUint64(at + 32, c1 >> 64n, true);
  }
  v.setBigUint64(43 + 4000, o.lastUpdate ?? 0n, true);
  return d;
}

/** A PoolView over a built pool, with the reserves it was built with. */
export function viewOf(b: BuiltPool, s: { sol: bigint; tok: bigint; origin?: PoolView['origin']; frozen?: boolean; history?: PoolView['history']; config?: PoolView['config'] | 'decoded' }): PoolView {
  const pool = decodePoolState(b.address.toBase58(), b.accounts[b.address.toBase58()]!.data)!;
  // The pool's one reading (quotes.ts); `s.sol` is the quote side's reserve, whichever coin that is.
  const pair = readPair(pool.token0Mint, pool.token1Mint)!;
  const solIs0 = pair.quoteIsToken0;
  const tokenMint = pair.tokenMint;
  return {
    address: b.address.toBase58(),
    origin: s.origin ?? 'other',
    snapshot: { pool, vault0Amount: solIs0 ? s.sol : s.tok, vault1Amount: solIs0 ? s.tok : s.sol, reserve0: solIs0 ? s.sol : s.tok, reserve1: solIs0 ? s.tok : s.sol },
    config: s.config === undefined || s.config === 'decoded' ? decodeAmmConfig(b.config.toBase58(), b.accounts[b.config.toBase58()]!.data) : s.config,
    tokenMint,
    quote: pair.quote,
    quoteIsToken0: solIs0,
    quoteReserve: s.sol,
    tokenReserve: s.tok,
    vaultsFrozen: s.frozen ?? false,
    history: s.history ?? { kind: 'not-read' },
  };
}
