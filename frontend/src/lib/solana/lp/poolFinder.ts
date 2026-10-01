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
import { decodeObservationState, type ObservationStateView } from './ownPrice';
import { POOL_INDEX_MAX, readPoolIndex, type PoolIndexRead } from './poolIndex';
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
 *   3. the server index (`/api/pools`): one filtered scan of the pool program for
 *      TOKEN/SOL pools of this token, deepest SOL side first, which is the only way to
 *      see pools at other addresses.
 *
 * Then, in the browser, each candidate must be owned by the pool program, decode as a
 * pool, and trade THIS token against SOL; its vaults must be initialized accounts of the
 * token programs it names (and a frozen vault is said); its fee settings are read from
 * its own config account; a launch pool's own price record is read too. Reads cost three
 * RPC calls in all, however many pools there are (up to 100 per call).
 */

export type PoolOrigin = 'launch-pool' | 'standard' | 'other';

export type PoolHistory =
  | { kind: 'not-read' }
  | { kind: 'unread'; detail: string }
  | { kind: 'ok'; obs: ObservationStateView };

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
  /**
   * Whether either vault is frozen (SPL account state 2). A frozen vault cannot send or
   * receive, so nobody can withdraw. USDC and USDT keep a freeze authority, so their
   * pools are in scope and this can happen.
   */
  vaultsFrozen: boolean;
  /** The pool's own price record: read for a launch pool only (see ownPrice.ts). */
  history: PoolHistory;
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

export const CLOCK_SYSVAR = 'SysvarC1ock11111111111111111111111111111111';
const SYSVAR_OWNER = 'Sysvar1111111111111111111111111111111111111';

/** The cluster clock's unix time from the Clock sysvar account, or null when it is not one. */
export function chainTimeOf(a: RawAccount | null): bigint | null {
  if (!a || a.owner !== SYSVAR_OWNER || a.data.length < 40) return null;
  return new DataView(a.data.buffer, a.data.byteOffset, a.data.byteLength).getBigInt64(32, true);
}

/** SPL token account `state` byte: mint 32 + owner 32 + amount 8 + delegate option 36. */
const TOKEN_ACCOUNT_STATE_OFFSET = 108;
const STATE_INITIALIZED = 1;
const STATE_FROZEN = 2;

/**
 * A vault's amount and whether it is frozen; null when the account is missing, is not
 * owned by `expectedOwner`, or is not an initialized token account.
 */
export function tokenVault(a: RawAccount | null, expectedOwner: string): { amount: bigint; frozen: boolean } | null {
  if (!a || a.owner !== expectedOwner || a.data.length <= TOKEN_ACCOUNT_STATE_OFFSET) return null;
  const state = a.data[TOKEN_ACCOUNT_STATE_OFFSET];
  if (state !== STATE_INITIALIZED && state !== STATE_FROZEN) return null;
  return {
    amount: new DataView(a.data.buffer, a.data.byteOffset, a.data.byteLength).getBigUint64(64, true),
    frozen: state === STATE_FROZEN,
  };
}

export interface ReadPoolsOptions {
  programId: PublicKey;
  launchProgramId: PublicKey;
}

type DecodedPool = NonNullable<ReturnType<typeof decodePoolState>>;

/**
 * The first look at a candidate address: is it one of our TOKEN/SOL pools at all?
 * Either an entry that ends the read, or the decoded pool (and whether it sits at the
 * launch program's address for its token) to read further.
 */
function firstLook(address: string, a: RawAccount | null, opts: ReadPoolsOptions): { entry: PoolEntry } | { pool: DecodedPool; launchPool: boolean } {
  if (!a) return { entry: { kind: 'absent', address } };
  if (a.owner !== opts.programId.toBase58()) return { entry: { kind: 'not-a-pool', address, detail: 'the account is not owned by the pool program' } };
  const pool = decodePoolState(address, a.data);
  if (!pool) return { entry: { kind: 'not-a-pool', address, detail: 'the account does not decode as a pool' } };
  if (pool.token0Mint !== WSOL_MINT && pool.token1Mint !== WSOL_MINT) {
    return { entry: { kind: 'other-pair', address, token0Mint: pool.token0Mint, token1Mint: pool.token1Mint } };
  }
  const tokenMint = pool.token0Mint === WSOL_MINT ? pool.token1Mint : pool.token0Mint;
  const launchPool = address === poolStatePda(new PublicKey(tokenMint), opts.launchProgramId).toBase58();
  return { pool, launchPool };
}

/**
 * The second look: the pool's vaults, its fee settings and (a launch pool only) its
 * price record, all read already. `observation` is ignored for any other pool.
 */
function secondLook(
  address: string,
  pool: DecodedPool,
  launchPool: boolean,
  a: { vault0: RawAccount | null; vault1: RawAccount | null; config: RawAccount | null; observation: RawAccount | null; opts: ReadPoolsOptions },
): PoolEntry {
  const program = a.opts.programId.toBase58();
  const t0 = tokenVault(a.vault0, pool.token0Program);
  const t1 = tokenVault(a.vault1, pool.token1Program);
  if (t0 === null || t1 === null) {
    return { kind: 'unread', address, detail: 'a pool vault is missing, is not a working token account, or is not owned by the token program the pool names' };
  }
  const reserve0 = vaultAmountWithoutFee(t0.amount, pool.protocolFeesToken0, pool.fundFeesToken0, pool.creatorFeesToken0);
  const reserve1 = vaultAmountWithoutFee(t1.amount, pool.protocolFeesToken1, pool.fundFeesToken1, pool.creatorFeesToken1);
  if (reserve0 === null || reserve1 === null) {
    return { kind: 'unread', address, detail: 'the fees a pool owes are more than its vault holds' };
  }
  const cfgAcc = a.config;
  const config = cfgAcc && cfgAcc.owner === program ? decodeAmmConfig(pool.ammConfig, cfgAcc.data) : null;

  const solIsToken0 = pool.token0Mint === WSOL_MINT;
  const tokenMint = solIsToken0 ? pool.token1Mint : pool.token0Mint;
  const { token0, token1 } = sortMints(new PublicKey(pool.token0Mint), new PublicKey(pool.token1Mint));
  let origin: PoolOrigin = 'other';
  if (launchPool) origin = 'launch-pool';
  else if (address === derivePool(a.opts.programId, new PublicKey(pool.ammConfig), token0, token1).toBase58()) origin = 'standard';

  let history: PoolHistory = { kind: 'not-read' };
  if (launchPool) {
    const acc = a.observation;
    const obs = acc && acc.owner === program ? decodeObservationState(acc.data) : null;
    history = !acc
      ? { kind: 'unread', detail: 'its price record account is missing' }
      : !obs
        ? { kind: 'unread', detail: 'its price record is not one the pool program wrote' }
        : new PublicKey(obs.poolId).toBase58() !== address
          ? { kind: 'unread', detail: 'its price record belongs to another pool' }
          : { kind: 'ok', obs };
  }

  return {
    kind: 'pool',
    view: {
      address,
      origin,
      snapshot: { pool, vault0Amount: t0.amount, vault1Amount: t1.amount, reserve0, reserve1 },
      config,
      tokenMint,
      solIsToken0,
      solReserve: solIsToken0 ? reserve0 : reserve1,
      tokenReserve: solIsToken0 ? reserve1 : reserve0,
      vaultsFrozen: t0.frozen || t1.frozen,
      history,
    },
  };
}

/**
 * One pool's entry from accounts already read: the pool, its two vaults, its fee
 * settings and its price record (read for every pool, used for a launch pool only).
 * Pure. `readPools` builds every entry with it, and the liquidity builders build the
 * pool they write to with it from their own single read, so both judge a pool alike.
 */
export function poolViewFrom(a: {
  address: string;
  pool: RawAccount | null;
  vault0: RawAccount | null;
  vault1: RawAccount | null;
  config: RawAccount | null;
  observation: RawAccount | null;
  opts: ReadPoolsOptions;
}): PoolEntry {
  const first = firstLook(a.address, a.pool, a.opts);
  if ('entry' in first) return first.entry;
  return secondLook(a.address, first.pool, first.launchPool, a);
}

/**
 * Read the pools at `addresses` (in that order, one entry each) plus the chain clock.
 * Two getMultipleAccounts rounds: the pools and the clock, then every vault and config
 * (and a launch pool's price record).
 */
export async function readPools(rpc: SolanaRpc, addresses: string[], opts: ReadPoolsOptions): Promise<PoolsRead> {
  let first: (RawAccount | null)[];
  try {
    first = await getMultipleAccounts(rpc, [...addresses, CLOCK_SYSVAR]);
  } catch (e) {
    return { kind: 'unread', detail: clipDetail(e) };
  }
  const chainNow = chainTimeOf(first[addresses.length] ?? null);

  const entries: PoolEntry[] = [];
  const candidates: { i: number; pool: DecodedPool; launchPool: boolean }[] = [];
  addresses.forEach((address, i) => {
    const look = firstLook(address, first[i] ?? null, opts);
    if ('entry' in look) return entries.push(look.entry);
    entries.push({ kind: 'unread', address, detail: 'not read yet' });
    candidates.push({ i, pool: look.pool, launchPool: look.launchPool });
  });
  if (!candidates.length) return { kind: 'ok', entries, chainNow };

  // Every vault and config, then each launch pool's price record (at most one per token:
  // only the launch program can open one, and only its deposit check leans on it).
  const second = candidates.flatMap(({ pool }) => [pool.token0Vault, pool.token1Vault, pool.ammConfig]);
  const historyAt = new Map<number, number>();
  candidates.forEach(({ pool, launchPool }, k) => {
    if (!launchPool) return;
    historyAt.set(k, second.length);
    second.push(pool.observationKey);
  });
  let vaults: (RawAccount | null)[];
  try {
    vaults = await getMultipleAccounts(rpc, second);
  } catch (e) {
    const detail = clipDetail(e);
    for (const { i } of candidates) entries[i] = { kind: 'unread', address: addresses[i]!, detail };
    return { kind: 'ok', entries, chainNow };
  }

  candidates.forEach(({ i, pool, launchPool }, k) => {
    const h = historyAt.get(k);
    entries[i] = secondLook(addresses[i]!, pool, launchPool, {
      vault0: vaults[3 * k] ?? null,
      vault1: vaults[3 * k + 1] ?? null,
      config: vaults[3 * k + 2] ?? null,
      observation: h === undefined ? null : vaults[h] ?? null,
      opts,
    });
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

/**
 * Cap on addresses read per search: the three known addresses plus everything the index
 * may return (POOL_INDEX_MAX), so nothing the index names is dropped here.
 */
export const MAX_CANDIDATES = 3 + POOL_INDEX_MAX;

/**
 * Pools this page opened, kept for the session (cleared only by a page load). A pool
 * opened at a one-off address is found by the index or by this memory alone, so a
 * search right after an opening lists it even when the index has not caught up or is
 * down. Every search reads them; a remembered pool that holds another token's pool is
 * never listed for this one (the same tokenMint filter as the index's answers).
 */
const createdPools = new Set<string>();

/** Remember a pool this page just opened (a confirmed `lp-create`). */
export function rememberCreatedPool(pool: string): void {
  createdPools.add(pool);
}

/** Did this page open this pool in this session? */
export function isCreatedPool(pool: string): boolean {
  return createdPools.has(pool);
}

export async function findPools(
  rpc: SolanaRpc,
  mint: PublicKey,
  opts: ReadPoolsOptions & { fetchImpl?: typeof fetch },
): Promise<PoolSearchRead> {
  const known = knownPoolAddresses(mint, opts.programId, opts.launchProgramId);
  const index = await readPoolIndex({ mint: mint.toBase58() }, opts.programId.toBase58(), opts.fetchImpl);
  const addresses = [
    ...new Set([known.launchPool, ...known.standard.map((s) => s.address), ...createdPools, ...(index.kind === 'ok' ? index.pools : [])]),
  ].slice(0, MAX_CANDIDATES);

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

/**
 * What opening a pool locks up in account deposits (rent) that are never refunded: the
 * pool, its price record, its LP mint and its two vaults. None of them can be closed.
 * (The opener's own LP token account is also paid for, but can be closed later.)
 */
export const NEVER_REFUNDED_ACCOUNT_SIZES = [637, 4075, 82, 165, 165] as const;

/** The fee tiers as they are on chain right now: read, never assumed (tier 1 may not exist yet). */
export type FeeTierRead =
  | {
      kind: 'ok';
      tiers: { index: number; address: string; config: AmmConfigView | null; state: 'live' | 'absent' | 'not-a-config' }[];
      /** Lamports of never-refunded account deposits to open a pool; null when not read. */
      openingDeposits: bigint | null;
    }
  | { kind: 'unread'; detail: string };

async function readOpeningDeposits(rpc: SolanaRpc): Promise<bigint | null> {
  try {
    const sizes = [...new Set(NEVER_REFUNDED_ACCOUNT_SIZES)];
    const each = await Promise.all(sizes.map((n) => rpc('getMinimumBalanceForRentExemption', [n])));
    const bySize = new Map<number, bigint>();
    for (let k = 0; k < sizes.length; k++) {
      const v = each[k];
      if (typeof v !== 'number' || !Number.isSafeInteger(v) || v <= 0) return null;
      bySize.set(sizes[k]!, BigInt(v));
    }
    return NEVER_REFUNDED_ACCOUNT_SIZES.reduce((sum, n) => sum + bySize.get(n)!, 0n);
  } catch {
    return null;
  }
}

export async function readFeeTiers(rpc: SolanaRpc, programId: PublicKey, indices: readonly number[] = [0, 1]): Promise<FeeTierRead> {
  const addrs = indices.map((i) => deriveAmmConfig(programId, i).toBase58());
  let accounts: (RawAccount | null)[];
  let openingDeposits: bigint | null;
  try {
    [accounts, openingDeposits] = await Promise.all([getMultipleAccounts(rpc, addrs), readOpeningDeposits(rpc)]);
  } catch (e) {
    return { kind: 'unread', detail: clipDetail(e) };
  }
  return {
    kind: 'ok',
    openingDeposits,
    tiers: indices.map((index, k) => {
      const a = accounts[k] ?? null;
      if (!a) return { index, address: addrs[k]!, config: null, state: 'absent' as const };
      const c = a.owner === programId.toBase58() ? decodeAmmConfig(addrs[k]!, a.data) : null;
      return { index, address: addrs[k]!, config: c, state: c ? ('live' as const) : ('not-a-config' as const) };
    }),
  };
}
