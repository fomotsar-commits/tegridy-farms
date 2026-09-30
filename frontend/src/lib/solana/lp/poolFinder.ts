import { PublicKey } from '@solana/web3.js';
import type { SolanaRpc } from '../../launcher/solana/curve/rpc';
import { clipDetail } from '../../launcher/solana/curve/read';
import { poolStatePda } from '../../launcher/solana/curve/program';
import {
  decodeAmmConfig,
  decodePoolState,
  deriveAmmConfig,
  derivePool,
  sortMints,
  type AmmConfigView,
} from '../cpswap/program';
import { vaultAmountWithoutFee } from '../cpswap/math';
import type { PoolSnapshot } from '../cpswap/read';
import { getMultipleAccounts, type RawAccount } from './accounts';
import { readPoolIndex, type PoolIndexRead } from './poolIndex';
import { WSOL_MINT } from './tokenSafety';

/**
 * Every pool for a token, found without trusting any single address.
 *
 * THE TRAP. cp-swap has a "standard" address for each pair and fee tier
 * (`["pool", amm_config, token0, token1]`), and anyone can take it first: at a bad
 * price, or with an open time years away so it can never trade. Pools can also sit at
 * ANY address that signed its creation (initialize.rs 385-388). So there is no such thing
 * as "the pool" for a token, and this file never names one. It collects candidates from
 * three places and reads every one of them:
 *
 *   1. the launch pool, `["launchpool", mint]` under the launch program: only that
 *      program can create it, at graduation;
 *   2. the standard address on fee tier 1 (the public tier) and on fee tier 0;
 *   3. the server index (`/api/pools`): one filtered scan of the pool program for pools
 *      holding this token, which is the only way to see pools at other addresses.
 *
 * Then, in the browser, each candidate must be owned by the pool program, decode as a
 * pool, and trade THIS token against SOL; its vaults must belong to the token programs
 * it names; its fee settings are read from its own config account. Reads cost three RPC
 * calls in all, however many pools there are (up to 100 per call).
 */

export type PoolOrigin = 'launch-pool' | 'standard' | 'other';

export interface PoolView {
  address: string;
  origin: PoolOrigin;
  snapshot: PoolSnapshot;
  /** The pool's own fee settings; null when that account could not be read or decoded. */
  config: AmmConfigView | null;
  tokenMint: string;
  /** Which side of the pool is SOL. */
  solIsToken0: boolean;
  solReserve: bigint;
  tokenReserve: bigint;
}

export type PoolEntry =
  | { kind: 'pool'; view: PoolView }
  | { kind: 'absent'; address: string }
  | { kind: 'unread'; address: string; detail: string }
  /** A real pool, but not TOKEN/SOL. Out of scope for this site for now. */
  | { kind: 'other-pair'; address: string; token0Mint: string; token1Mint: string }
  | { kind: 'not-a-pool'; address: string; detail: string };

export type PoolsRead =
  | { kind: 'ok'; entries: PoolEntry[]; chainNow: bigint | null }
  | { kind: 'unread'; detail: string };

const CLOCK_SYSVAR = 'SysvarC1ock11111111111111111111111111111111';
const SYSVAR_OWNER = 'Sysvar1111111111111111111111111111111111111';

function chainTimeOf(a: RawAccount | null): bigint | null {
  if (!a || a.owner !== SYSVAR_OWNER || a.data.length < 40) return null;
  return new DataView(a.data.buffer, a.data.byteOffset, a.data.byteLength).getBigInt64(32, true);
}

function tokenAmount(a: RawAccount | null, expectedOwner: string): bigint | null {
  if (!a || a.owner !== expectedOwner || a.data.length < 72) return null;
  return new DataView(a.data.buffer, a.data.byteOffset, a.data.byteLength).getBigUint64(64, true);
}

export interface ReadPoolsOptions {
  programId: PublicKey;
  launchProgramId: PublicKey;
}

/**
 * Read the pools at `addresses` (in that order, one entry each) plus the chain clock.
 * Two getMultipleAccounts rounds: the pools and the clock, then every vault and config.
 */
export async function readPools(rpc: SolanaRpc, addresses: string[], opts: ReadPoolsOptions): Promise<PoolsRead> {
  const program = opts.programId.toBase58();
  let first: (RawAccount | null)[];
  try {
    first = await getMultipleAccounts(rpc, [...addresses, CLOCK_SYSVAR]);
  } catch (e) {
    return { kind: 'unread', detail: clipDetail(e) };
  }
  const chainNow = chainTimeOf(first[addresses.length] ?? null);

  const entries: PoolEntry[] = [];
  const candidates: { i: number; pool: NonNullable<ReturnType<typeof decodePoolState>> }[] = [];
  addresses.forEach((address, i) => {
    const a = first[i] ?? null;
    if (!a) return entries.push({ kind: 'absent', address });
    if (a.owner !== program) return entries.push({ kind: 'not-a-pool', address, detail: 'the account is not owned by the pool program' });
    const pool = decodePoolState(address, a.data);
    if (!pool) return entries.push({ kind: 'not-a-pool', address, detail: 'the account does not decode as a pool' });
    if (pool.token0Mint !== WSOL_MINT && pool.token1Mint !== WSOL_MINT) {
      return entries.push({ kind: 'other-pair', address, token0Mint: pool.token0Mint, token1Mint: pool.token1Mint });
    }
    entries.push({ kind: 'unread', address, detail: 'not read yet' });
    candidates.push({ i, pool });
  });
  if (!candidates.length) return { kind: 'ok', entries, chainNow };

  const second = candidates.flatMap(({ pool }) => [pool.token0Vault, pool.token1Vault, pool.ammConfig]);
  let vaults: (RawAccount | null)[];
  try {
    vaults = await getMultipleAccounts(rpc, second);
  } catch (e) {
    const detail = clipDetail(e);
    for (const { i } of candidates) entries[i] = { kind: 'unread', address: addresses[i]!, detail };
    return { kind: 'ok', entries, chainNow };
  }

  candidates.forEach(({ i, pool }, k) => {
    const address = addresses[i]!;
    const v0 = tokenAmount(vaults[3 * k] ?? null, pool.token0Program);
    const v1 = tokenAmount(vaults[3 * k + 1] ?? null, pool.token1Program);
    if (v0 === null || v1 === null) {
      entries[i] = { kind: 'unread', address, detail: 'a pool vault is missing or is not owned by the token program the pool names' };
      return;
    }
    const reserve0 = vaultAmountWithoutFee(v0, pool.protocolFeesToken0, pool.fundFeesToken0, pool.creatorFeesToken0);
    const reserve1 = vaultAmountWithoutFee(v1, pool.protocolFeesToken1, pool.fundFeesToken1, pool.creatorFeesToken1);
    if (reserve0 === null || reserve1 === null) {
      entries[i] = { kind: 'unread', address, detail: 'the fees a pool owes are more than its vault holds' };
      return;
    }
    const cfgAcc = vaults[3 * k + 2] ?? null;
    const config = cfgAcc && cfgAcc.owner === program ? decodeAmmConfig(pool.ammConfig, cfgAcc.data) : null;

    const solIsToken0 = pool.token0Mint === WSOL_MINT;
    const tokenMint = solIsToken0 ? pool.token1Mint : pool.token0Mint;
    const { token0, token1 } = sortMints(new PublicKey(pool.token0Mint), new PublicKey(pool.token1Mint));
    let origin: PoolOrigin = 'other';
    if (address === poolStatePda(new PublicKey(tokenMint), opts.launchProgramId).toBase58()) origin = 'launch-pool';
    else if (address === derivePool(opts.programId, new PublicKey(pool.ammConfig), token0, token1).toBase58()) origin = 'standard';

    entries[i] = {
      kind: 'pool',
      view: {
        address,
        origin,
        snapshot: { pool, vault0Amount: v0, vault1Amount: v1, reserve0, reserve1 },
        config,
        tokenMint,
        solIsToken0,
        solReserve: solIsToken0 ? reserve0 : reserve1,
        tokenReserve: solIsToken0 ? reserve1 : reserve0,
      },
    };
  });
  return { kind: 'ok', entries, chainNow };
}

/** The fee tiers the finder checks standard addresses on, public tier first. */
export const STANDARD_CONFIG_INDICES = [1, 0] as const;

export interface KnownAddresses {
  launchPool: string;
  standard: { index: number; config: string; address: string }[];
}

export function knownPoolAddresses(mint: PublicKey, programId: PublicKey, launchProgramId: PublicKey): KnownAddresses {
  const { token0, token1 } = sortMints(mint, new PublicKey(WSOL_MINT));
  return {
    launchPool: poolStatePda(mint, launchProgramId).toBase58(),
    standard: STANDARD_CONFIG_INDICES.map((index) => {
      const config = deriveAmmConfig(programId, index);
      return { index, config: config.toBase58(), address: derivePool(programId, config, token0, token1).toBase58() };
    }),
  };
}

export interface PoolSearch {
  mint: string;
  known: KnownAddresses;
  index: PoolIndexRead;
  /** TOKEN/SOL pools and pools we could not read, deepest SOL side first. */
  pools: Extract<PoolEntry, { kind: 'pool' | 'unread' }>[];
  /** Pools holding this token against something other than SOL. */
  otherPairs: number;
  /** What each known address held. */
  knownState: Record<string, PoolEntry['kind']>;
  chainNow: bigint | null;
}

export type PoolSearchRead = { kind: 'ok'; search: PoolSearch } | { kind: 'unread'; detail: string; index: PoolIndexRead };

/** Cap on addresses read per search: the known three plus the index's 50, with room. */
const MAX_CANDIDATES = 100;

export async function findPools(
  rpc: SolanaRpc,
  mint: PublicKey,
  opts: ReadPoolsOptions & { fetchImpl?: typeof fetch },
): Promise<PoolSearchRead> {
  const known = knownPoolAddresses(mint, opts.programId, opts.launchProgramId);
  const index = await readPoolIndex({ mint: mint.toBase58() }, opts.fetchImpl);
  const addresses = [...new Set([known.launchPool, ...known.standard.map((s) => s.address), ...(index.kind === 'ok' ? index.pools : [])])].slice(0, MAX_CANDIDATES);

  const read = await readPools(rpc, addresses, opts);
  if (read.kind === 'unread') return { kind: 'unread', detail: read.detail, index };

  const knownSet = new Set([known.launchPool, ...known.standard.map((s) => s.address)]);
  const knownState: Record<string, PoolEntry['kind']> = {};
  const pools: PoolSearch['pools'] = [];
  let otherPairs = 0;
  const m = mint.toBase58();
  for (const e of read.entries) {
    const address = e.kind === 'pool' ? e.view.address : e.address;
    if (knownSet.has(address)) knownState[address] = e.kind;
    if (e.kind === 'pool') {
      // A TOKEN/SOL pool for ANOTHER token (the index is not trusted to have filtered).
      if (e.view.tokenMint !== m) continue;
      pools.push(e);
    } else if (e.kind === 'unread') {
      pools.push(e);
    } else if (e.kind === 'other-pair' && (e.token0Mint === m || e.token1Mint === m)) {
      otherPairs++;
    }
  }
  pools.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === 'pool' ? -1 : 1;
    if (a.kind === 'pool' && b.kind === 'pool') {
      if (a.view.solReserve !== b.view.solReserve) return a.view.solReserve > b.view.solReserve ? -1 : 1;
      return a.view.address < b.view.address ? -1 : 1;
    }
    return 0;
  });
  return { kind: 'ok', search: { mint: m, known, index, pools, otherPairs, knownState, chainNow: read.chainNow } };
}

/** The fee tiers as they are on chain right now: read, never assumed (tier 1 may not exist yet). */
export type FeeTierRead =
  | { kind: 'ok'; tiers: { index: number; address: string; config: AmmConfigView | null; state: 'live' | 'absent' | 'not-a-config' }[] }
  | { kind: 'unread'; detail: string };

export async function readFeeTiers(rpc: SolanaRpc, programId: PublicKey, indices: readonly number[] = [0, 1]): Promise<FeeTierRead> {
  const addrs = indices.map((i) => deriveAmmConfig(programId, i).toBase58());
  let accounts: (RawAccount | null)[];
  try {
    accounts = await getMultipleAccounts(rpc, addrs);
  } catch (e) {
    return { kind: 'unread', detail: clipDetail(e) };
  }
  return {
    kind: 'ok',
    tiers: indices.map((index, k) => {
      const a = accounts[k] ?? null;
      if (!a) return { index, address: addrs[k]!, config: null, state: 'absent' as const };
      const c = a.owner === programId.toBase58() ? decodeAmmConfig(addrs[k]!, a.data) : null;
      return { index, address: addrs[k]!, config: c, state: c ? ('live' as const) : ('not-a-config' as const) };
    }),
  };
}
