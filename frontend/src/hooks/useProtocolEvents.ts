import { useEffect, useMemo, useRef, useState } from 'react';
import { useReadContracts } from 'wagmi';
import { REVENUE_DISTRIBUTOR_ABI } from '../lib/contracts';
import { POL_ACCUMULATOR_ABI } from '../lib/abi-supplement';
import {
  REVENUE_DISTRIBUTOR_ADDRESS,
  POL_ACCUMULATOR_ADDRESS,
  CHAIN_ID,
  isDeployed,
} from '../lib/constants';
import { useProtocolActivity } from './useProtocolActivity';
import {
  diffCounters,
  mergeProtocolEvents,
  launchOutcomesToEvents,
  type CounterSnapshot,
  type PulseItem,
} from '../lib/protocolEvents';
import type { LauncherOutcomesResponse } from '../lib/launcher/outcomesClient';

// ═══ Proof-of-Life: the whole protocol, not just TOWELI trades ═══
//
// useProtocolActivity surfaces real TOWELI buys/sells. This hook COMPOSES that with
// more TRUE protocol events into one self-gating feed:
//   - 'fee'    RevenueDistributor settled a distribution (ETH → stakers)
//   - 'pol'    POLAccumulator deployed ETH into protocol-owned liquidity
//   - 'gauge'  GaugeController voting weight changed  ← DORMANT: contract is zeroed
//              (not redeployed post-relaunch). Wired to emit nothing until it returns.
//   - 'launch' a graded launch graduated (/api/launcher-outcomes) ← no live discovery
//              feed yet; self-gates to [] until one is passed in.
//
// MECHANISM (fee/pol): poll a monotonic on-chain counter and emit an event only when
// it STRICTLY INCREASES between two observed reads (see onchainDeltas.ts). eth_getLogs
// is dead on free RPCs and the alchemy proxy allowlists it to NFT contracts only, so a
// counter delta is the honest, zero-new-serverless-surface signal. First read sets a
// baseline and emits nothing; a quiet protocol yields ZERO items and the UI renders
// nothing — never a fabricated number (HONEST-FRAMING law).

const REV_DEPLOYED = isDeployed(REVENUE_DISTRIBUTOR_ADDRESS);
const POL_DEPLOYED = isDeployed(POL_ACCUMULATOR_ADDRESS);

const MAX_OBSERVED = 12; // cap on session-observed delta events kept in memory
const POLL_MS = 30_000;

export interface ProtocolEventsResult {
  items: PulseItem[];
  loading: boolean;
  error: boolean;
}

export interface UseProtocolEventsOptions {
  /**
   * Optional graded-launch feed. When a caller has a real launcher-outcomes response
   * (a CONSUMED launch list enriched server-side), pass it here to surface graduated
   * launches in the pulse. Omitted in production today — no live discovery feed is
   * wired — so launch events self-gate to []. Never synthesize one.
   */
  launchOutcomes?: LauncherOutcomesResponse | null;
  /** Max items in the merged feed. Default 24 (the component slices to its own limit). */
  limit?: number;
}

export function useProtocolEvents(opts: UseProtocolEventsOptions = {}): ProtocolEventsResult {
  const { launchOutcomes = null, limit = 24 } = opts;

  // 1) Real TOWELI trades (unchanged source).
  const trades = useProtocolActivity();

  // 2) On-chain counters for fee + POL delta detection.
  const { data, dataUpdatedAt } = useReadContracts({
    contracts: [
      { address: REVENUE_DISTRIBUTOR_ADDRESS, abi: REVENUE_DISTRIBUTOR_ABI, functionName: 'totalDistributed', chainId: CHAIN_ID },
      { address: REVENUE_DISTRIBUTOR_ADDRESS, abi: REVENUE_DISTRIBUTOR_ABI, functionName: 'epochCount', chainId: CHAIN_ID },
      { address: POL_ACCUMULATOR_ADDRESS, abi: POL_ACCUMULATOR_ABI, functionName: 'totalLPCreated', chainId: CHAIN_ID },
      { address: POL_ACCUMULATOR_ADDRESS, abi: POL_ACCUMULATOR_ABI, functionName: 'totalAccumulations', chainId: CHAIN_ID },
      { address: POL_ACCUMULATOR_ADDRESS, abi: POL_ACCUMULATOR_ABI, functionName: 'totalETHUsed', chainId: CHAIN_ID },
    ],
    query: {
      enabled: REV_DEPLOYED || POL_DEPLOYED,
      refetchInterval: POLL_MS,
      // Only poll when the tab is visible (mirrors useProtocolActivity's gating).
      refetchIntervalInBackground: false,
    },
  });

  // Last OBSERVED counter snapshot (per-surface), preserved across a transient outage
  // so a surface that briefly fails to read still diffs against its true prior value.
  const prevRef = useRef<CounterSnapshot | null>(null);
  // Session-observed delta events, newest-first, capped + deduped by id.
  const [observed, setObserved] = useState<PulseItem[]>([]);

  useEffect(() => {
    if (!data) return;

    const revOk = data[0]?.status === 'success' && data[1]?.status === 'success';
    const polOk =
      data[2]?.status === 'success' && data[3]?.status === 'success' && data[4]?.status === 'success';

    const cur: CounterSnapshot = {
      revenue: revOk
        ? {
            totalDistributedWei: data[0].result as bigint,
            epochCount: Number(data[1].result as bigint),
          }
        : null,
      pol: polOk
        ? {
            totalLPCreatedWei: data[2].result as bigint,
            totalAccumulations: Number(data[3].result as bigint),
            totalETHUsedWei: data[4].result as bigint,
          }
        : null,
    };

    const observedAt = Math.floor(Date.now() / 1000);
    // Attach an Etherscan verify path: delta events carry no single tx hash, so link
    // the contract itself so anyone can check the counter (RealYieldProof ethos).
    const newEvents = diffCounters(prevRef.current, cur, observedAt).map((e) =>
      e.kind === 'fee'
        ? { ...e, href: `https://etherscan.io/address/${REVENUE_DISTRIBUTOR_ADDRESS}` }
        : e.kind === 'pol'
          ? { ...e, href: `https://etherscan.io/address/${POL_ACCUMULATOR_ADDRESS}` }
          : e,
    );

    // Preserve last-observed per surface (don't clobber a good baseline with a null).
    prevRef.current = {
      revenue: cur.revenue ?? prevRef.current?.revenue ?? null,
      pol: cur.pol ?? prevRef.current?.pol ?? null,
    };

    if (newEvents.length > 0) {
      setObserved((prev) => {
        const ids = new Set(prev.map((e) => e.id));
        const add = newEvents.filter((e) => !ids.has(e.id));
        if (add.length === 0) return prev;
        return [...add, ...prev].slice(0, MAX_OBSERVED);
      });
    }
    // dataUpdatedAt changes on every successful refetch — the honest "new poll" trigger.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dataUpdatedAt]);

  // 3) Graded launches (self-gates to [] until a real feed is passed in).
  const launchEvents = useMemo(
    () => launchOutcomesToEvents(launchOutcomes),
    [launchOutcomes],
  );

  // 4) Merge every stream into one newest-first, deduped, capped feed.
  const items = useMemo(
    () => mergeProtocolEvents([trades.items, observed, launchEvents], { limit }),
    [trades.items, observed, launchEvents, limit],
  );

  // Self-gating signals: only "loading"/"error" while there is genuinely nothing to
  // show. The moment any real item exists (a trade, a fee delta, a launch) we render.
  const loading = trades.loading && items.length === 0;
  const error = trades.error && items.length === 0;

  return { items, loading, error };
}
