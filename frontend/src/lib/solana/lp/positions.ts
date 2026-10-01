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
 *   - placing costs one index lookup per share, so at most `limit` are placed per read,
 *     and `totalShares` says how many the wallet holds. The page shows the rest as "N
 *     more" and can place them next. Anyone can send pool shares of junk pools to any
 *     wallet, so the order is stable (by share mint) rather than "whatever the RPC
 *     returned", and the placed ones are listed most valuable first.
 */

export interface Position {
  lpMint: string;
  lpAccount: string;
  lpAmount: bigint;
  placement: 'found' | 'index-unread' | 'not-found';
  /** Why the index could not place it, when it could not be read. */
  placementDetail: string | null;
  /** The pool, read and checked; null when it could not be placed. */
  pool: PoolEntry | null;
  /** What burning the whole share pays out right now; null when the pool was not read. */
  value: { token0: bigint; token1: bigint; sharePct: number } | null;
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
  const program = opts.programId.toBase58();
  const placed = await Promise.all(
    shares.map(async (s) => {
      const idx = await readPoolIndex({ lpMint: s.mint }, program, opts.fetchImpl);
      if (idx.kind !== 'ok') return { share: s, pool: null as string | null, placement: 'index-unread' as const, placementDetail: idx.detail as string | null };
      const match = idx.pools.find((p) => deriveLpMint(opts.programId, new PublicKey(p)).toBase58() === s.mint) ?? null;
      return { share: s, pool: match, placement: match ? ('found' as const) : ('not-found' as const), placementDetail: null };
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
    // The pool must name this LP mint itself, not only derive to it.
    if (entry?.kind === 'pool' && entry.view.snapshot.pool.lpMint === share.mint) {
      const v = lpWithdrawValue(entry.view.snapshot, share.amount);
      if (v) value = { token0: v.token0Amount, token1: v.token1Amount, sharePct: v.sharePct };
    }
    return { lpMint: share.mint, lpAccount: share.address, lpAmount: share.amount, placement, placementDetail, pool: entry, value };
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
