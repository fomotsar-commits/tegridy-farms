import { PublicKey } from '@solana/web3.js';
import type { SolanaRpc } from '../../launcher/solana/curve/rpc';
import { lpWithdrawValue } from '../cpswap/read';
import { decodeTokenAccount, getMultipleAccounts } from './accounts';
import type { PoolView } from './poolFinder';
import { TOKEN_PROGRAM } from './tokenSafety';

/**
 * "Every position": who holds a share of one of our pools, read from the chain.
 *
 * The RPC's getTokenLargestAccounts names the share mint's largest token accounts (at most
 * 20); each is then read back and kept only when it is a classic SPL token account of THIS
 * pool's share mint, so a stale or odd answer cannot put a stranger's coin in the list. A
 * wallet holding the share in more than one account is one row, its accounts added up.
 * What a row pays out is worked out as for "Your positions" (positions.ts): the program's
 * own withdraw rounding, and no payout when one side would be 0 (it refuses that).
 */

export interface Holder {
  /** The wallet that owns the share account(s). */
  owner: string;
  amount: bigint;
  /** What burning the whole share pays out now; null when there is no payout to show. */
  value: { token0: bigint; token1: bigint; sharePct: number } | null;
  /** Burning it would pay 0 on one side, which the program refuses. */
  tooSmall: boolean;
}

export type HoldersRead =
  | {
      kind: 'ok';
      /** Largest first. */
      holders: Holder[];
      /** The RPC names at most this many accounts: there may be smaller holders past them. */
      capped: boolean;
    }
  | { kind: 'unread'; detail: string };

/** How many accounts getTokenLargestAccounts names at most. */
export const LARGEST_ACCOUNTS = 20;

const toBase58 = (b: Uint8Array) => new PublicKey(b).toBase58();

export async function readPoolHolders(rpc: SolanaRpc, view: PoolView): Promise<HoldersRead> {
  const lpMint = view.snapshot.pool.lpMint;
  try {
    const payload = await rpc('getTokenLargestAccounts', [lpMint, { commitment: 'confirmed' }]);
    const list = (payload as { value?: unknown })?.value;
    if (!Array.isArray(list)) throw new Error('getTokenLargestAccounts: the response carried no `value` list');
    const named = list.map((v) => {
      const o = v as { address?: unknown; amount?: unknown };
      if (typeof o.address !== 'string' || typeof o.amount !== 'string') throw new Error('getTokenLargestAccounts: an entry carried no address or amount');
      return { address: o.address, amount: BigInt(o.amount) };
    });
    const held = named.filter((n) => n.amount > 0n);
    const accounts = held.length ? await getMultipleAccounts(rpc, held.map((n) => n.address)) : [];
    const byOwner = new Map<string, bigint>();
    for (const acc of accounts) {
      if (!acc || acc.owner !== TOKEN_PROGRAM) continue;
      const t = decodeTokenAccount(acc.address, acc.data, toBase58);
      if (!t || t.mint !== lpMint || t.amount === 0n) continue;
      byOwner.set(t.owner, (byOwner.get(t.owner) ?? 0n) + t.amount);
    }
    const holders = [...byOwner.entries()]
      .map(([owner, amount]): Holder => {
        const v = lpWithdrawValue(view.snapshot, amount);
        const tooSmall = !!v && (v.token0Amount === 0n || v.token1Amount === 0n);
        return { owner, amount, tooSmall, value: v && !tooSmall ? { token0: v.token0Amount, token1: v.token1Amount, sharePct: v.sharePct } : null };
      })
      .sort((a, b) => (a.amount === b.amount ? a.owner.localeCompare(b.owner) : a.amount > b.amount ? -1 : 1));
    return { kind: 'ok', holders, capped: named.length >= LARGEST_ACCOUNTS };
  } catch (e) {
    return { kind: 'unread', detail: e instanceof Error ? e.message : String(e) };
  }
}
