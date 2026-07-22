import { useState, useEffect } from 'react';
import { TOWELI_WETH_LP_ADDRESS } from '../lib/constants';
import type { PulseItem, PulseKind } from '../lib/protocolEvents/types';

// A live "what's moving in TOWELI" feed — the research-backed on-chain-intelligence
// hook. Sourced from GeckoTerminal's public trades API (free, keyless, CORS-OK)
// because eth_getLogs is rejected across the entire free public-RPC roster
// (publicnode -32602 "archive token required", drpc err 30) and the Ponder indexer
// isn't deployed yet. Reads real recent buys/sells on the TOWELI/WETH pool.
//
// SELF-GATING: when the protocol is dormant (currently ~0 trades/24h) this returns
// zero items and the UI renders NOTHING — it must never show an empty "activity"
// box (that's the "advertises its own emptiness" trap). It lights up automatically
// the moment real trading exists (post-liquidity-seed / go-live).

// PulseItem is the UNIFIED proof-of-life render model, now owned by the pure
// protocol-events lib (src/lib/protocolEvents/types.ts) so the on-chain + launch
// event adapters share ONE shape with this trades hook. Trades populate only the
// base fields; protocol-level events add title/detail/href.
export type { PulseItem, PulseKind };

export interface ProtocolActivity {
  items: PulseItem[];
  loading: boolean;
  error: boolean;
}

const ENDPOINT = `https://api.geckoterminal.com/api/v2/networks/eth/pools/${TOWELI_WETH_LP_ADDRESS}/trades`;
const WHALE_USD = 250; // flag sizeable moves for a sub-cent token
const POLL_MS = 60_000;

interface GeckoTrade {
  attributes?: {
    kind?: string;
    volume_in_usd?: string;
    tx_from_address?: string;
    tx_hash?: string;
    block_number?: number;
    block_timestamp?: string;
  };
}

export function useProtocolActivity(): ProtocolActivity {
  const [state, setState] = useState<ProtocolActivity>({ items: [], loading: true, error: false });

  useEffect(() => {
    let cancelled = false;

    async function load() {
      try {
        const res = await fetch(ENDPOINT, { headers: { accept: 'application/json' } });
        if (!res.ok) throw new Error(`gecko ${res.status}`);
        const json = (await res.json()) as { data?: GeckoTrade[] };
        const items: PulseItem[] = (json.data ?? [])
          .map((t) => {
            const a = t.attributes ?? {};
            const usd = Number(a.volume_in_usd) || 0;
            return {
              id: `${a.tx_hash ?? ''}:${a.block_number ?? ''}`,
              kind: (a.kind === 'sell' ? 'sell' : 'buy') as 'buy' | 'sell',
              usd,
              actor: a.tx_from_address ?? '',
              txHash: a.tx_hash ?? '',
              ts: a.block_timestamp ? Math.floor(Date.parse(a.block_timestamp) / 1000) : 0,
              whale: usd >= WHALE_USD,
            };
          })
          .filter((x) => x.usd > 0 && x.txHash);
        if (!cancelled) setState({ items, loading: false, error: false });
      } catch {
        if (!cancelled) setState((s) => ({ ...s, loading: false, error: true }));
      }
    }

    load();
    const iv = setInterval(() => {
      if (typeof document === 'undefined' || document.visibilityState === 'visible') load();
    }, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(iv);
    };
  }, []);

  return state;
}
