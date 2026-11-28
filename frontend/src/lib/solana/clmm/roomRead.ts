// What the Liquidity Room reads from the chain: the pool as it stands now, its depth, its swaps.
//
// Three reads, each its own answer, each `unread` on any throw: a room with no hills must mean
// "no liquidity", never "the read failed".
import { PublicKey } from '@solana/web3.js';
import type { SolanaRpc } from '../../launcher/solana/curve/rpc';
import { clipDetail } from '../../launcher/solana/curve/read';
import { getMultipleAccounts } from '../lp/accounts';
import { optionalReadAllowed } from '../lp/rpcBudget';
import { depthProfile, type DepthProfile } from './depthProfile';
import { decodePoolState, type PoolStateView } from './program';
import type { Pair } from './rangeMath';
import { readBandsNear, readExtension, type Read } from './read';
import { readRoomSwaps, type RoomSwapsRead } from './roomSwaps';

/** `paused`: the proxy's budget is low, so this optional read was not sent. */
export type RoomRead<T> = Read<T> | { kind: 'paused' };

export interface RoomReaders {
  /** The pool's account again, for its price now. */
  poolNow(address: string): Promise<RoomRead<PoolStateView>>;
  /** The depth across the bands nearest the pool's price; null when no band holds a position. */
  depth(pool: PoolStateView): Promise<Read<DepthProfile | null>>;
  /** The swaps in the pool's newest page of transactions. */
  swaps(pool: PoolStateView, pair: Pick<Pair, 'tokenIsToken0'>): Promise<RoomSwapsRead>;
}

export function browserRoomReaders(rpc: SolanaRpc, programId: PublicKey): RoomReaders {
  return {
    poolNow: async (address) => {
      if (!optionalReadAllowed()) return { kind: 'paused' };
      try {
        const a = (await getMultipleAccounts(rpc, [address]))[0] ?? null;
        if (a === null || a.owner !== programId.toBase58()) throw new Error('the pool’s address did not answer with the program’s account');
        const pool = decodePoolState(address, a.data);
        if (!pool) throw new Error('the pool did not decode');
        return { kind: 'ok', value: pool };
      } catch (e) {
        return { kind: 'unread', detail: clipDetail(e) };
      }
    },
    depth: async (pool) => {
      try {
        const bands = await readBandsNear(rpc, programId, pool, await readExtension(rpc, programId, pool));
        return { kind: 'ok', value: depthProfile(pool, bands) };
      } catch (e) {
        return { kind: 'unread', detail: clipDetail(e) };
      }
    },
    swaps: (pool, pair) => readRoomSwaps(rpc, pool, pair),
  };
}
