// The swaps the Liquidity Room draws: the real ones in a range pool's last page of transactions.
//
// One page (20 signatures, txHistory.ts), behind the proxy's budget gate like every optional
// read. A swap is told by what the pool's two vaults did in the transaction: one gained, the
// other paid out. A deposit fills both, a withdrawal or a fee collection drains them, and
// neither is a swap. Only the pool's program can pay out of its vaults, so the two balances are
// the fact; no instruction is decoded.
//
// No fee is worked out per swap: a pool's fee can change between swaps, so the room shows the
// tier's split as it reads today and never a sum.
import type { SolanaRpc } from '../../launcher/solana/curve/rpc';
import { detailOf, transactionsOf } from '../lp/ledger';
import { optionalReadAllowed } from '../lp/rpcBudget';
import { readSignatures, tokenDelta, type ParsedTx, type SigEntry } from '../lp/txHistory';
import type { PoolStateView } from './program';
import type { Pair } from './rangeMath';

export interface RoomSwap {
  signature: string;
  slot: number;
  /** Unix seconds, or null when the node did not say. */
  blockTime: number | null;
  /** What the trader paid in: the token (a sell, the price falls) or the pairing coin (a buy, it rises). */
  inSide: 'token' | 'coin';
  /** In that coin's smallest unit. */
  inAmount: bigint;
}

/** This transaction as a swap in `pool`, or null for anything else (failed, not read, a deposit, a withdrawal). */
export function classifyRoomSwap(sig: SigEntry, tx: ParsedTx | null, pool: Pick<PoolStateView, 'tokenVault0' | 'tokenVault1'>, pair: Pick<Pair, 'tokenIsToken0'>): RoomSwap | null {
  if (!tx || sig.err !== null || tx.err !== null) return null;
  const d0 = tokenDelta(tx, pool.tokenVault0);
  const d1 = tokenDelta(tx, pool.tokenVault1);
  const in0 = d0 > 0n && d1 < 0n;
  const in1 = d1 > 0n && d0 < 0n;
  if (!in0 && !in1) return null;
  return {
    signature: sig.signature,
    slot: sig.slot,
    blockTime: sig.blockTime,
    inSide: in0 === pair.tokenIsToken0 ? 'token' : 'coin',
    inAmount: in0 ? d0 : d1,
  };
}

export type RoomSwapsRead =
  /** `looked` is how many transactions the page held: 20 with no swap is not "no swaps ever". */
  | { kind: 'ok'; swaps: RoomSwap[]; looked: number }
  | { kind: 'paused' }
  | { kind: 'unread'; detail: string };

/** The swaps in the pool's newest page of transactions, newest first. */
export async function readRoomSwaps(rpc: SolanaRpc, pool: Pick<PoolStateView, 'address' | 'tokenVault0' | 'tokenVault1'>, pair: Pick<Pair, 'tokenIsToken0'>): Promise<RoomSwapsRead> {
  if (!optionalReadAllowed()) return { kind: 'paused' };
  try {
    const page = await readSignatures(rpc, pool.address, {});
    const txs = await transactionsOf(rpc, page.entries);
    const swaps = page.entries.flatMap((e) => classifyRoomSwap(e, txs.get(e.signature) ?? null, pool, pair) ?? []);
    return { kind: 'ok', swaps, looked: page.entries.length };
  } catch (e) {
    return { kind: 'unread', detail: detailOf(e) };
  }
}
