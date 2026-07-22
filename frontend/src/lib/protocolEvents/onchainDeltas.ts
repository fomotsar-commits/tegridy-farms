// Pure delta-detection for on-chain protocol events.
//
// WHY POLL-DELTA (not logs): eth_getLogs is rejected across the free public-RPC
// roster, the /api/alchemy proxy allowlists getLogs to 3 NFT contracts only (not our
// protocol contracts), and the Ponder indexer isn't deployed. What IS cheap and
// keyless-via-wallet-RPC is reading a monotonic counter. RevenueDistributor exposes
// totalDistributed + epochCount; POLAccumulator exposes totalLPCreated +
// totalAccumulations + totalETHUsed. When one of those STRICTLY INCREASES between two
// observed polls, a real on-chain settlement happened in the interim — an honest,
// self-gating "proof of life" signal.
//
// HONEST-FRAMING LAW enforced here:
//   - An event is emitted ONLY when BOTH the previous and current snapshots were
//     actually observed (no fabricating a jump out of an outage-hit read) AND the
//     counter strictly increased. First observation emits nothing (we set a baseline).
//   - The event id is keyed by the NEW counter value (epochCount / accumulation index)
//     so the same settlement can never be double-emitted across re-diffs.
//   - `observedAt` is INJECTED (deterministic tests); the timestamp is the observation
//     time, which the UI states as "just now" — we do not claim a precise block time.
//
// This module is PURE: no network, no clock, no React. It takes two typed snapshots
// and returns PulseItem[]. The React seam (wallet reads + cross-poll memory) lives in
// src/hooks/useProtocolEvents.ts.

import { formatEther } from 'viem';
import type { PulseItem } from './types';

/** RevenueDistributor counters, read via wagmi. `null` = not observed this poll. */
export interface RevenueSnapshot {
  /** Cumulative ETH distributed to stakers (wei). */
  totalDistributedWei: bigint;
  /** Number of settled distribution epochs (monotonic). */
  epochCount: number;
}

/** POLAccumulator counters, read via wagmi. `null` = not observed this poll. */
export interface PolSnapshot {
  /** Cumulative LP tokens minted into protocol-owned liquidity (wei). */
  totalLPCreatedWei: bigint;
  /** Number of accumulate() operations (monotonic). */
  totalAccumulations: number;
  /** Cumulative ETH spent buying TOWELI + adding liquidity (wei). */
  totalETHUsedWei: bigint;
}

/** A single poll's observation of every counter surface we watch. */
export interface CounterSnapshot {
  revenue: RevenueSnapshot | null;
  pol: PolSnapshot | null;
}

export interface DeltaThresholds {
  /** ETH delta at/above which a fee distribution is highlighted (whale). */
  feeWhaleEth: number;
  /** ETH-used delta at/above which a POL deepening is highlighted (whale). */
  polWhaleEth: number;
}

export const DEFAULT_DELTA_THRESHOLDS: DeltaThresholds = {
  feeWhaleEth: 0.05,
  polWhaleEth: 0.05,
};

/** Format a non-negative wei delta as a trimmed ETH string, e.g. "0.0123". */
function ethStr(wei: bigint): string {
  if (wei <= 0n) return '0';
  const n = Number(formatEther(wei));
  if (!Number.isFinite(n) || n <= 0) return '0';
  // 4 sig-ish decimals for small protocol amounts, no trailing-zero noise.
  return n < 1 ? n.toFixed(4).replace(/0+$/, '').replace(/\.$/, '') : n.toFixed(3).replace(/0+$/, '').replace(/\.$/, '');
}

function ethNum(wei: bigint): number {
  const n = Number(formatEther(wei > 0n ? wei : 0n));
  return Number.isFinite(n) ? n : 0;
}

/**
 * Diff two counter snapshots into proof-of-life events. Pure and total: never throws,
 * never emits without a real strict increase across two observed reads.
 *
 * @param prev the previous poll's snapshot, or null on the very first poll.
 * @param cur  the current poll's snapshot.
 * @param observedAt unix seconds of THIS observation (injected).
 */
export function diffCounters(
  prev: CounterSnapshot | null,
  cur: CounterSnapshot,
  observedAt: number,
  thresholds: DeltaThresholds = DEFAULT_DELTA_THRESHOLDS,
): PulseItem[] {
  const out: PulseItem[] = [];
  if (!prev) return out; // first observation → set baseline, emit nothing.

  // ── Fees captured (RevenueDistributor) ─────────────────────────────────────
  // Trigger on the monotonic epochCount so float/wei noise can't spuriously fire;
  // the ETH delta rides along as the detail. Guard both reads observed + strict up.
  if (prev.revenue && cur.revenue && cur.revenue.epochCount > prev.revenue.epochCount) {
    const deltaWei =
      cur.revenue.totalDistributedWei > prev.revenue.totalDistributedWei
        ? cur.revenue.totalDistributedWei - prev.revenue.totalDistributedWei
        : 0n;
    const nEpochs = cur.revenue.epochCount - prev.revenue.epochCount;
    const eth = ethNum(deltaWei);
    out.push({
      id: `fee:${cur.revenue.epochCount}`,
      kind: 'fee',
      usd: 0,
      actor: '',
      txHash: '',
      ts: observedAt,
      whale: eth >= thresholds.feeWhaleEth,
      title: nEpochs > 1 ? 'Protocol fees distributed' : 'Protocol fees distributed to stakers',
      detail: deltaWei > 0n ? `${ethStr(deltaWei)} ETH → stakers` : 'new distribution epoch settled',
    });
  }

  // ── Protocol-owned liquidity deepened (POLAccumulator) ──────────────────────
  // Trigger on totalAccumulations (monotonic op count). Prefer the ETH-used delta
  // for the detail (what the protocol actually deployed); fall back to LP minted.
  if (prev.pol && cur.pol && cur.pol.totalAccumulations > prev.pol.totalAccumulations) {
    const ethUsedWei =
      cur.pol.totalETHUsedWei > prev.pol.totalETHUsedWei
        ? cur.pol.totalETHUsedWei - prev.pol.totalETHUsedWei
        : 0n;
    const lpWei =
      cur.pol.totalLPCreatedWei > prev.pol.totalLPCreatedWei
        ? cur.pol.totalLPCreatedWei - prev.pol.totalLPCreatedWei
        : 0n;
    const eth = ethNum(ethUsedWei);
    const detail =
      ethUsedWei > 0n
        ? `${ethStr(ethUsedWei)} ETH deployed into protocol-owned liquidity`
        : lpWei > 0n
          ? `${ethStr(lpWei)} LP minted to the treasury`
          : 'protocol-owned liquidity compounded';
    out.push({
      id: `pol:${cur.pol.totalAccumulations}`,
      kind: 'pol',
      usd: 0,
      actor: '',
      txHash: '',
      ts: observedAt,
      whale: eth >= thresholds.polWhaleEth,
      title: 'Protocol-owned liquidity deepened',
      detail,
    });
  }

  return out;
}
