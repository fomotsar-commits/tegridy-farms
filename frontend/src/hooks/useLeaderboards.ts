import { useMemo } from 'react';
import { useReadContract } from 'wagmi';
import type { Address } from 'viem';
import { useIndexerQuery } from '../lib/indexer';
import { GAUGE_CONTROLLER_ABI } from '../lib/contracts';
import { GAUGE_CONTROLLER_ADDRESS, CHAIN_ID, isDeployed } from '../lib/constants';

/**
 * Real top-N leaderboards (P1-5).
 *
 * Three feeds in a single GraphQL request: stakers, voters this epoch,
 * creators. The hook aggregates per-user client-side because Ponder 0.8.x
 * doesn't expose GROUP BY in GraphQL — we fetch a generous top-K
 * window per table (200 rows) and reduce. K=200 covers a stable top-100
 * even when whales hold multiple positions.
 *
 * When the indexer URL is unset, every list returns empty and
 * `isAvailable === false`. The consuming page is expected to render
 * nothing in that case (silent fallback policy from P0-2).
 */

export type StakerRow = {
  user: `0x${string}`;
  totalAmount: bigint; // sum across positions, in wei
  boostedAmount: bigint; // sum of (amount * boostBps) / 10_000, in wei
  positions: number;
};

export type VoterRow = {
  user: `0x${string}`;
  totalPower: bigint;
  votes: number;
};

export type CreatorRow = {
  creator: `0x${string}`;
  drops: number;
  newestTimestamp: number;
};

const LEADERBOARD_QUERY = /* GraphQL */ `
  query Leaderboards($epoch: BigInt!, $limit: Int!) {
    stakingPositions: stakingPositions(
      orderBy: "amount"
      orderDirection: "desc"
      limit: $limit
    ) {
      items {
        tokenId
        user
        amount
        boostBps
      }
    }
    gaugeVotes: gaugeVotes(
      where: { epoch: $epoch }
      orderBy: "power"
      orderDirection: "desc"
      limit: $limit
    ) {
      items {
        id
        user
        power
      }
    }
    dropCollections: dropCollections(
      orderBy: "timestamp"
      orderDirection: "desc"
      limit: $limit
    ) {
      items {
        id
        creator
        timestamp
      }
    }
  }
`;

type RawShape = {
  stakingPositions?: { items: Array<{ tokenId: string; user: `0x${string}`; amount: string; boostBps: string }> };
  gaugeVotes?: { items: Array<{ id: string; user: `0x${string}`; power: string }> };
  dropCollections?: { items: Array<{ id: string; creator: `0x${string}`; timestamp: string }> };
};

const PER_TABLE_LIMIT = 200;
const TOP_STAKERS = 100;
const TOP_VOTERS = 20;
const TOP_CREATORS = 20;

export function useLeaderboards() {
  // ─── current epoch from chain (one read, cached an epoch's worth) ──
  const gaugeDeployed = isDeployed(GAUGE_CONTROLLER_ADDRESS);
  const { data: epochData } = useReadContract({
    address: GAUGE_CONTROLLER_ADDRESS,
    abi: GAUGE_CONTROLLER_ABI,
    functionName: 'currentEpoch',
    chainId: CHAIN_ID,
    query: { enabled: gaugeDeployed, staleTime: 30 * 60_000 },
  });
  const currentEpoch = (epochData as bigint | undefined) ?? 0n;

  const q = useIndexerQuery<RawShape>({
    key: ['leaderboards', currentEpoch.toString()],
    query: LEADERBOARD_QUERY,
    variables: { epoch: currentEpoch.toString(), limit: PER_TABLE_LIMIT },
    enabled: gaugeDeployed,
    options: {
      // Leaderboards don't need per-block freshness — a minute of staleness
      // is fine and saves a refetch storm under the P0-3 block invalidator.
      staleTime: 60_000,
    },
  });

  const stakers: StakerRow[] = useMemo(() => {
    if (!q.data?.stakingPositions) return [];
    const map = new Map<`0x${string}`, StakerRow>();
    for (const p of q.data.stakingPositions.items) {
      const user = p.user.toLowerCase() as `0x${string}`;
      const amount = BigInt(p.amount);
      const boost = BigInt(p.boostBps);
      const boosted = (amount * boost) / 10_000n;
      const row = map.get(user);
      if (row) {
        row.totalAmount += amount;
        row.boostedAmount += boosted;
        row.positions += 1;
      } else {
        map.set(user, {
          user,
          totalAmount: amount,
          boostedAmount: boosted,
          positions: 1,
        });
      }
    }
    return [...map.values()]
      .sort((a, b) => (a.boostedAmount > b.boostedAmount ? -1 : a.boostedAmount < b.boostedAmount ? 1 : 0))
      .slice(0, TOP_STAKERS);
  }, [q.data]);

  const voters: VoterRow[] = useMemo(() => {
    if (!q.data?.gaugeVotes) return [];
    const map = new Map<`0x${string}`, VoterRow>();
    for (const v of q.data.gaugeVotes.items) {
      const user = v.user.toLowerCase() as `0x${string}`;
      const power = BigInt(v.power);
      const row = map.get(user);
      if (row) {
        row.totalPower += power;
        row.votes += 1;
      } else {
        map.set(user, { user, totalPower: power, votes: 1 });
      }
    }
    return [...map.values()]
      .sort((a, b) => (a.totalPower > b.totalPower ? -1 : a.totalPower < b.totalPower ? 1 : 0))
      .slice(0, TOP_VOTERS);
  }, [q.data]);

  const creators: CreatorRow[] = useMemo(() => {
    if (!q.data?.dropCollections) return [];
    const map = new Map<`0x${string}`, CreatorRow>();
    for (const d of q.data.dropCollections.items) {
      const creator = d.creator.toLowerCase() as `0x${string}`;
      const ts = Number(d.timestamp);
      const row = map.get(creator);
      if (row) {
        row.drops += 1;
        if (ts > row.newestTimestamp) row.newestTimestamp = ts;
      } else {
        map.set(creator, { creator, drops: 1, newestTimestamp: ts });
      }
    }
    return [...map.values()]
      .sort((a, b) => (b.drops - a.drops) || (b.newestTimestamp - a.newestTimestamp))
      .slice(0, TOP_CREATORS);
  }, [q.data]);

  return {
    stakers,
    voters,
    creators,
    currentEpoch,
    isAvailable: q.isAvailable,
    isLoading: q.isLoading,
    error: q.error,
    refetch: q.refetch,
  };
}

/** Helper used by the table component to mark the connected user's row. */
export function highlightRowIf(
  rowAddress: string,
  connected: Address | undefined,
): boolean {
  if (!connected) return false;
  return rowAddress.toLowerCase() === connected.toLowerCase();
}
