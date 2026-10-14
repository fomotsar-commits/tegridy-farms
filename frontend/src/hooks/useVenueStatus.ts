// Polyfill MUST load before any @solana/* import, the same rule as SolanaProviders.
import '../lib/solanaPolyfill';
import { useCallback, useEffect, useState } from 'react';
import { browserCurveRpc, browserRpc } from '../lib/launcher/solana/curve/rpc';
import { readVenue, type VenueStatus } from '../lib/solana/cpswap/read';
import { lpFetch } from '../lib/solana/lp/readFetch';
import { noteResponse } from '../lib/solana/lp/rpcBudget';

/**
 * The venue's Solana AMM, read live from the chain: null while reading. A read that
 * throws is 'unreadable', never live. `refresh` keeps the last answer on screen while
 * it reads again; `retry` goes back to reading, so a second failure shows as new.
 */
export function useVenueStatus(): { status: VenueStatus | null; refresh: () => void; retry: () => void } {
  const [status, setStatus] = useState<VenueStatus | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let cancelled = false;
    readVenue(browserCurveRpc(browserRpc(lpFetch({ what: 'the chain', onResponse: noteResponse }))))
      .then((s) => { if (!cancelled) setStatus(s); })
      .catch(() => {
        if (!cancelled) setStatus({ kind: 'unreadable', detail: 'the RPC proxy did not answer' });
      });
    return () => { cancelled = true; };
  }, [reloadKey]);

  const refresh = useCallback(() => setReloadKey((k) => k + 1), []);
  const retry = useCallback(() => { setStatus(null); setReloadKey((k) => k + 1); }, []);
  return { status, refresh, retry };
}
