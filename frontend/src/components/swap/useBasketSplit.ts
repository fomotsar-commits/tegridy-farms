import { useCallback, useState } from 'react';
import { evenPcts, isSplit, reweigh, type Split } from '../../lib/islandBasket';
import { safeGetItem, safeJsonParse, safeSetItem } from '../../lib/storage';

const SPLIT_KEY = 'tegridy-island-split-v1';

/**
 * The trader's split for one order, kept in this browser for the next visit. `coins` names the
 * order's coins in order: a split kept for another list of coins (one added or taken away) is not
 * used, and the order starts even again. A convenience: storage that fails just starts even.
 */
export function useBasketSplit(coins: readonly string[]): { split: Split; setPct: (i: number, pct: number) => void; reset: () => void } {
  const id = coins.join(',');
  const recall = (): Split => {
    const kept = safeJsonParse<Record<string, unknown> | null>(safeGetItem(SPLIT_KEY), null)?.[id];
    return Array.isArray(kept) && isSplit(kept as number[], coins.length) ? (kept as number[]) : null;
  };
  const [held, setHeld] = useState<{ id: string; split: Split }>(() => ({ id, split: recall() }));
  // Another list of coins (another chain) is another order: its own kept split, or even.
  const split = held.id === id ? held.split : recall();
  const keep = useCallback((next: Split) => {
    setHeld({ id, split: next });
    const all = { ...safeJsonParse<Record<string, unknown> | null>(safeGetItem(SPLIT_KEY), null) };
    if (next) all[id] = next;
    else delete all[id];
    safeSetItem(SPLIT_KEY, JSON.stringify(all));
  }, [id]);
  const setPct = useCallback((i: number, pct: number) => keep(reweigh(split ?? evenPcts(coins.length), i, pct)), [keep, split, coins.length]);
  const reset = useCallback(() => keep(null), [keep]);
  return { split, setPct, reset };
}
