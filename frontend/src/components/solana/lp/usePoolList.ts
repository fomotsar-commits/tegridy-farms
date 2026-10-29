import { useEffect, useState } from 'react';
import type { PoolListRead } from '../../../lib/solana/lp/poolList';
import type { LpReaders } from './readers';

/**
 * Every pool on the venue (All pools, VenuePoolList.tsx; Every position, EveryPosition.tsx),
 * read on mount and again whenever `reloadKey` moves (a liquidity flow finished). A re-read
 * keeps the last answer on screen until the new one arrives; null only before the first answer.
 */
export function usePoolList(readers: LpReaders, reloadKey: number): PoolListRead | null {
  const [read, setRead] = useState<PoolListRead | null>(null);
  useEffect(() => {
    if (!readers.listPools) return;
    let live = true;
    readers.listPools().then(
      (r) => live && setRead(r),
      (e: unknown) => live && setRead({ kind: 'unread', detail: e instanceof Error ? e.message : String(e) }),
    );
    return () => {
      live = false;
    };
  }, [readers, reloadKey]);
  return read;
}
