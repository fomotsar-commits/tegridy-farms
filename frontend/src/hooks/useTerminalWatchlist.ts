import { useCallback, useState } from 'react';
import {
  isWatched,
  loadWatchlist,
  saveWatchlist,
  toggleWatch,
} from '../lib/terminal/watchlist';

// Local watchlist state for the terminal.
//
// A failed write is REPORTED, not swallowed. `safeSetItem` returns false under
// quota pressure, and a star that appears to stick and is gone on reload teaches
// a trader that this page's state is decorative. `persistError` is the sentence
// the page shows when that happens; in-memory state still updates so the current
// session behaves, and the user is told it will not survive.

export interface TerminalWatchlistState {
  watched: string[];
  isWatched: (address: string) => boolean;
  toggle: (address: string) => void;
  /** Non-null when the last write did not reach storage. */
  persistError: string | null;
}

const PERSIST_FAILED =
  'This watchlist could not be saved to browser storage, so it will not survive a reload. Local storage may be full or blocked.';

export function useTerminalWatchlist(): TerminalWatchlistState {
  const [watched, setWatched] = useState<string[]>(() => loadWatchlist());
  const [persistError, setPersistError] = useState<string | null>(null);

  const toggle = useCallback((address: string) => {
    setWatched((current) => {
      const next = toggleWatch(current, address);
      setPersistError(saveWatchlist(next) ? null : PERSIST_FAILED);
      return next;
    });
  }, []);

  const has = useCallback((address: string) => isWatched(watched, address), [watched]);

  return { watched, isWatched: has, toggle, persistError };
}
