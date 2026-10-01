import { PublicKey } from '@solana/web3.js';
import type { SolanaRpc } from '../../launcher/solana/curve/rpc';
import { clipDetail } from '../../launcher/solana/curve/read';
import { deriveAuthority, deriveLpMint } from '../cpswap/program';
import { lpWithdrawValue } from '../cpswap/read';
import { getMultipleAccounts, getTokenAccountsByOwner, type RawAccount } from './accounts';
import { readPoolIndex } from './poolIndex';
import { readPools, type PoolEntry, type ReadPoolsOptions } from './poolFinder';
import { TOKEN_PROGRAM, decodeMintAccount } from './tokenSafety';

/**
 * "Your positions": the pool shares this wallet holds, read from the wallet's own token
 * accounts.
 *
 * A pool share (LP token) is a classic SPL token whose mint authority is the pool
 * program's authority PDA. So: list the wallet's token accounts, keep the ones with a
 * balance, read their mints, keep the ones minted by our pool program. That identifies
 * a share without trusting anything but the chain. Which POOL it belongs to is looked up
 * in the server index by LP mint, and then PROVEN here: the pool's LP mint must be the
 * one the program derives from the pool's own address, and the pool account must say so.
 *
 * A share never silently disappears from this list:
 *   - one we cannot place (the index did not answer, or has no pool for it) is still
 *     listed, with its amount;
 *   - placing costs one index lookup per share MINT, so at most `limit` are placed per
 *     read, and `totalShares` says how many the wallet holds. A proven placement is kept
 *     for the session (`placedPools`), so "more" and "read again" only spend lookups on
 *     shares not placed yet. The page shows the rest as "N
 *     more" and can place them next. Anyone can send pool shares of junk pools to any
 *     wallet, so the order is stable (by share mint) rather than "whatever the RPC
 *     returned", and the placed ones are listed most valuable first.
 */

export interface Position {
  lpMint: string;
  lpAccount: string;
  lpAmount: bigint;
  /**
   * How its pool was found: by our index (`found`), by its own chain history when the
   * index could not answer (`chain`, placeShareOnChain), or not yet.
   */
  placement: 'found' | 'chain' | 'index-unread' | 'not-found';
  /** Why the index could not place it, when it could not be read. */
  placementDetail: string | null;
  /** The pool, read and checked; null when it could not be placed. */
  pool: PoolEntry | null;
  /**
   * What burning the whole share pays out right now; null when the pool was not read,
   * or when the share is `tooSmall` (there is no payout: the program refuses it).
   */
  value: { token0: bigint; token1: bigint; sharePct: number } | null;
  /**
   * The pool was read, and burning the whole share would pay 0 on one side, which the
   * pool program refuses (6006). Never shown as a payout with a zero side.
   */
  tooSmall: boolean;
}

export type PositionsRead =
  | {
      kind: 'ok';
      positions: Position[];
      chainNow: bigint | null;
      /** Every pool share the wallet holds; more than `positions.length` means some are not placed yet. */
      totalShares: number;
    }
  | { kind: 'unread'; detail: string };

/** Pool shares placed per read by default (each needs one index lookup). */
export const MAX_POSITIONS = 20;

/**
 * `${program}:${lpMint}` → its pool, kept for the session, with how it was found. An LP
 * mint is a PDA of its pool (deriveLpMint), so a placement once proven can never change.
 * Only proven matches are kept: a miss or an unread answer is asked again next time.
 * Without this every "more" and "read again" re-spent one rate-limited lookup per share
 * (review 2026-09-30). A share placed from its chain history is kept too, so a re-read
 * while our index is still down keeps its pool, and the way out stays offered.
 */
const placedPools = new Map<string, { pool: string; via: 'found' | 'chain' }>();

type Placement = Pick<Position, 'placement' | 'placementDetail'> & { pool: string | null };

const toBase58 = (b: Uint8Array) => new PublicKey(b).toBase58();

/** The SOL side of what a position pays out now, for ordering; -1 when it has no value read. */
export function positionSolValue(p: Position): bigint {
  if (!p.value || p.pool?.kind !== 'pool') return -1n;
  return p.pool.view.solIsToken0 ? p.value.token0 : p.value.token1;
}

export async function readPositions(
  rpc: SolanaRpc,
  owner: PublicKey,
  opts: ReadPoolsOptions & { fetchImpl?: typeof fetch; limit?: number },
): Promise<PositionsRead> {
  const limit = Math.max(1, Math.floor(opts.limit ?? MAX_POSITIONS));
  let held;
  try {
    held = (await getTokenAccountsByOwner(rpc, owner.toBase58(), TOKEN_PROGRAM, toBase58)).filter((t) => t.amount > 0n);
  } catch (e) {
    return { kind: 'unread', detail: clipDetail(e) };
  }
  if (!held.length) return { kind: 'ok', positions: [], chainNow: null, totalShares: 0 };

  const mints = [...new Set(held.map((t) => t.mint))];
  let mintAccounts: (RawAccount | null)[];
  try {
    mintAccounts = await getMultipleAccounts(rpc, mints);
  } catch (e) {
    return { kind: 'unread', detail: clipDetail(e) };
  }
  const authority = deriveAuthority(opts.programId).toBase58();
  const lpMints = new Set<string>();
  mints.forEach((m, i) => {
    const a = mintAccounts[i];
    if (!a) return;
    const d = decodeMintAccount(a.owner, a.data);
    if (d.ok && d.value.program === 'spl-token' && d.value.mintAuthority === authority) lpMints.add(m);
  });
  const allShares = held
    .filter((t) => lpMints.has(t.mint))
    .sort((a, b) => (a.mint !== b.mint ? (a.mint < b.mint ? -1 : 1) : a.address < b.address ? -1 : a.address > b.address ? 1 : 0));
  if (!allShares.length) return { kind: 'ok', positions: [], chainNow: null, totalShares: 0 };
  const shares = allShares.slice(0, limit);

  // Place each share: index lookup by LP mint, then the derivation proves the match.
  // One lookup per distinct mint, and none for a mint already proven this session.
  const program = opts.programId.toBase58();
  const lookups = new Map<string, Promise<Placement>>();
  const place = async (lpMint: string): Promise<Placement> => {
    const known = placedPools.get(`${program}:${lpMint}`);
    if (known) return { pool: known.pool, placement: known.via, placementDetail: null };
    const idx = await readPoolIndex({ lpMint }, program, opts.fetchImpl);
    if (idx.kind !== 'ok') return { pool: null, placement: 'index-unread', placementDetail: idx.detail };
    const match = idx.pools.find((p) => deriveLpMint(opts.programId, new PublicKey(p)).toBase58() === lpMint) ?? null;
    if (match) placedPools.set(`${program}:${lpMint}`, { pool: match, via: 'found' });
    return { pool: match, placement: match ? 'found' : 'not-found', placementDetail: null };
  };
  const placed = await Promise.all(
    shares.map(async (s) => {
      let p = lookups.get(s.mint);
      if (!p) lookups.set(s.mint, (p = place(s.mint)));
      return { share: s, ...(await p) };
    }),
  );

  const poolAddrs = [...new Set(placed.map((p) => p.pool).filter((p): p is string => p !== null))];
  const read = poolAddrs.length ? await readPools(rpc, poolAddrs, opts) : ({ kind: 'ok', entries: [], chainNow: null } as const);
  const byAddr = new Map<string, PoolEntry>();
  if (read.kind === 'ok') for (const e of read.entries) byAddr.set(e.kind === 'pool' ? e.view.address : e.address, e);

  const positions: Position[] = placed.map(({ share, pool, placement, placementDetail }) => {
    const entry = pool
      ? read.kind === 'ok'
        ? byAddr.get(pool) ?? { kind: 'unread' as const, address: pool, detail: 'the pool was not in the answer' }
        : { kind: 'unread' as const, address: pool, detail: read.detail }
      : null;
    let value: Position['value'] = null;
    let tooSmall = false;
    // The pool must name this LP mint itself, not only derive to it.
    if (entry?.kind === 'pool' && entry.view.snapshot.pool.lpMint === share.mint) {
      const v = lpWithdrawValue(entry.view.snapshot, share.amount);
      if (v && (v.token0Amount === 0n || v.token1Amount === 0n)) tooSmall = true;
      else if (v) value = { token0: v.token0Amount, token1: v.token1Amount, sharePct: v.sharePct };
    }
    return { lpMint: share.mint, lpAccount: share.address, lpAmount: share.amount, placement, placementDetail, pool: entry, value, tooSmall };
  });
  // Most SOL first; shares with no value keep their stable order after them.
  const order = new Map(positions.map((p, i) => [p, i]));
  positions.sort((a, b) => {
    const va = positionSolValue(a);
    const vb = positionSolValue(b);
    if (va !== vb) return va > vb ? -1 : 1;
    return order.get(a)! - order.get(b)!;
  });
  return { kind: 'ok', positions, chainNow: read.kind === 'ok' ? read.chainNow : null, totalShares: allShares.length };
}

// ── finding a share's pool without our index ─────────────────────────────────

/** Transactions read per address, newest first. Two addresses: at most 2 + 2 × 20 history calls. */
export const CHAIN_HISTORY_LIMIT = 20;

export type ChainPlacement =
  | { kind: 'placed'; entry: Extract<PoolEntry, { kind: 'pool' }> }
  | { kind: 'not-found' }
  | { kind: 'unread'; detail: string };

function expectArray(what: string, v: unknown): unknown[] {
  if (!Array.isArray(v)) throw new Error(`${what}: expected a list`);
  return v;
}

function addressList(what: string, v: unknown): string[] {
  return expectArray(what, v).map((k) => {
    if (typeof k !== 'string') throw new Error(`${what}: an account key is not a string`);
    return k;
  });
}

/** Every account a `getTransaction` (json) answer names: its message keys and any loaded from lookup tables. */
function keysOf(tx: unknown): string[] {
  if (tx === null) return [];
  if (typeof tx !== 'object') throw new Error('getTransaction: expected an object');
  const t = tx as { transaction?: { message?: { accountKeys?: unknown } }; meta?: { loadedAddresses?: { writable?: unknown; readonly?: unknown } | null } | null };
  const keys = addressList('getTransaction', t.transaction?.message?.accountKeys);
  const loaded = t.meta?.loadedAddresses;
  if (loaded) keys.push(...addressList('getTransaction', loaded.writable ?? []), ...addressList('getTransaction', loaded.readonly ?? []));
  return keys;
}

/**
 * Find a share's pool from the chain alone, for when our pool index cannot answer
 * (spec D12). Reads the pool-share account's recent history, then the share mint's (at
 * most 20 transactions each, newest first), and takes a key as the pool only when BOTH
 * hold: the program derives this LP mint from it, and the pool, once read, names this
 * LP mint itself. Junk transactions can hide a match; they can never fake one.
 *
 * Calls: at most 2 history lists and 40 transactions, then (on a match) the pool read.
 * A malformed answer is `unread`. A proven match is kept for the session, like an index
 * placement, so a re-read while the index is still down keeps it (`placement: 'chain'`).
 */
export async function placeShareOnChain(rpc: SolanaRpc, opts: ReadPoolsOptions, share: { lpMint: string; lpAccount: string }): Promise<ChainPlacement> {
  const program = opts.programId.toBase58();
  // A key named by many transactions is derived from once.
  const seen = new Set<string>();
  try {
    for (const address of [share.lpAccount, share.lpMint]) {
      const sigs = expectArray('getSignaturesForAddress', await rpc('getSignaturesForAddress', [address, { limit: CHAIN_HISTORY_LIMIT }])).slice(0, CHAIN_HISTORY_LIMIT);
      for (const s of sigs) {
        const signature = (s as { signature?: unknown } | null)?.signature;
        if (typeof signature !== 'string') throw new Error('getSignaturesForAddress: an entry has no signature');
        const tx = await rpc('getTransaction', [signature, { encoding: 'json', maxSupportedTransactionVersion: 0, commitment: 'confirmed' }]);
        const candidate = keysOf(tx).find((k) => {
          if (seen.has(k)) return false;
          seen.add(k);
          try {
            return deriveLpMint(opts.programId, new PublicKey(k)).toBase58() === share.lpMint;
          } catch {
            return false;
          }
        });
        if (!candidate) continue;
        // Only one address can derive this LP mint, so this is the only candidate there
        // will ever be: read it, and it is the pool or there is none.
        const read = await readPools(rpc, [candidate], opts);
        if (read.kind === 'unread') return { kind: 'unread', detail: read.detail };
        const entry = read.entries[0];
        // A pool whose vaults could not be read is a failed read, not an answer: say
        // "try again", never "not on the chain".
        if (entry?.kind === 'unread') return { kind: 'unread', detail: entry.detail };
        if (entry?.kind !== 'pool' || entry.view.snapshot.pool.lpMint !== share.lpMint) return { kind: 'not-found' };
        placedPools.set(`${program}:${share.lpMint}`, { pool: candidate, via: 'chain' });
        return { kind: 'placed', entry };
      }
    }
    return { kind: 'not-found' };
  } catch (e) {
    return { kind: 'unread', detail: clipDetail(e) };
  }
}
