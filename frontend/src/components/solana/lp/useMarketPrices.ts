import { useEffect, useRef, useState } from 'react';
import type { PoolView } from '../../../lib/solana/lp/poolFinder';
import { readMarketPrices, type MarketPrices } from '../../../lib/solana/lp/poolList';
import type { LpReaders } from './readers';

/**
 * Jupiter's prices for the listed coins (poolList.ts `readMarketPrices`), read once per list
 * read: a new list is a new array, and the read follows it. The last prices that answered
 * are kept while a later read is on its way, and kept when it fails (`failed` says so, and
 * `at` says how old they are): a figure that was read is said as old, never replaced by
 * nothing. Null before the first answer, and always for a reader without `marketPrices`.
 */
export interface MarketPricesState {
  /** The last answer: prices, or the first read's failure. Null before the first answer. */
  prices: MarketPrices | null;
  /** This device's clock when `prices` landed. */
  at: number | null;
  /** A later read failed while prices stand. Cleared by the next answer. */
  failed: boolean;
}

export function useMarketPrices(readers: LpReaders, pools: readonly PoolView[] | null): MarketPricesState {
  const [state, setState] = useState<MarketPricesState>({ prices: null, at: null, failed: false });
  const hasPrices = useRef(false);
  useEffect(() => {
    if (!readers.marketPrices || !pools) return;
    let live = true;
    void readMarketPrices(pools, readers.marketPrices).then((p) => {
      if (!live) return;
      if (p.kind === 'ok' || !hasPrices.current) {
        hasPrices.current = p.kind === 'ok';
        setState({ prices: p, at: Date.now(), failed: false });
      } else {
        setState((s) => ({ ...s, failed: true }));
      }
    });
    return () => {
      live = false;
    };
  }, [readers, pools]);
  return state;
}
