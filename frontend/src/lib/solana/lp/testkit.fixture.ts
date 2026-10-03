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
import type { SolanaRpc } from '../../launcher/solana/curve/rpc';

export const PROGRAM = new PublicKey('EKS4C6xvV9A5DMWaWtVnFvi7ru78EhqRAoddEMpQ2BtT');
export const LAUNCH = new PublicKey('64WBTeNcrSHfmBpiqymyifW6FUNNLvJcuiqF9rXmz4q2');
export const WSOL = new PublicKey(WSOL_MINT);
export const CLOCK = 'SysvarC1ock11111111111111111111111111111111';
export const key = () => Keypair.generate().publicKey;

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
  solReserve: bigint;
  tokenReserve: bigint;
  openTime?: bigint;
  status?: number;
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
  const { token0, token1 } = sortMints(WSOL, s.mint);
  const address = s.address ?? (s.plain ? key() : derivePool(PROGRAM, config, token0, token1));
  const v0 = s.plain ? key() : deriveVault(PROGRAM, address, token0);
  const v1 = s.plain ? key() : deriveVault(PROGRAM, address, token1);
  const lpMint = s.plain ? key() : deriveLpMint(PROGRAM, address);
  const observation = s.plain ? key() : deriveObservation(PROGRAM, address);
  const solIs0 = token0.equals(WSOL);
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
  d.set(new PublicKey(TOKEN_PROGRAM).toBytes(), o.token0Program);
  d.set(new PublicKey(TOKEN_PROGRAM).toBytes(), o.token1Program);
  d.set(observation.toBytes(), o.observationKey);
  d[o.status] = s.status ?? 0;
  d[o.lpMintDecimals] = 9;
  d[o.mint0Decimals] = solIs0 ? 9 : (s.tokenDecimals ?? 6);
  d[o.mint1Decimals] = solIs0 ? (s.tokenDecimals ?? 6) : 9;
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
      [solVault.toBase58()]: { owner: TOKEN_PROGRAM, data: tokenAccountBytes(WSOL, authority, s.solReserve + fees) },
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

/** A fetch for /api/pools that answers from a table, keyed `mint:<m>` / `lpMint:<m>`, for the pool program PROGRAM. */
export function fakeIndex(table: Record<string, string[]>, opts: { status?: number; program?: string; truncated?: boolean; calls?: string[] } = {}): typeof fetch {
  return (async (url: string) => {
    const u = new URL(url, 'http://x');
    const [k, v] = [...u.searchParams.entries()][0]!;
    opts.calls?.push(`${k}:${v}`);
    if (opts.status) return new Response('{}', { status: opts.status });
    // `all=1` is answered `all: true`, the way the server does.
    return new Response(JSON.stringify({ [k]: k === 'all' ? true : v, program: opts.program ?? PROGRAM.toBase58(), pools: table[`${k}:${v}`] ?? [], truncated: opts.truncated ?? false }), { status: 200 });
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
  const solIs0 = pool.token0Mint === WSOL_MINT;
  const tokenMint = solIs0 ? pool.token1Mint : pool.token0Mint;
  return {
    address: b.address.toBase58(),
    origin: s.origin ?? 'other',
    snapshot: { pool, vault0Amount: solIs0 ? s.sol : s.tok, vault1Amount: solIs0 ? s.tok : s.sol, reserve0: solIs0 ? s.sol : s.tok, reserve1: solIs0 ? s.tok : s.sol },
    config: s.config === undefined || s.config === 'decoded' ? decodeAmmConfig(b.config.toBase58(), b.accounts[b.config.toBase58()]!.data) : s.config,
    tokenMint,
    solIsToken0: solIs0,
    solReserve: s.sol,
    tokenReserve: s.tok,
    vaultsFrozen: s.frozen ?? false,
    history: s.history ?? { kind: 'not-read' },
  };
}
