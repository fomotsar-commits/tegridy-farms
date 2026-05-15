import { useMemo } from 'react';
import type { Address } from 'viem';
import { useIndexerQuery } from '../lib/indexer';

/**
 * Unified activity timeline sourced from the Tegridy indexer (P0-2).
 *
 * Why a single GraphQL request instead of one-call-per-table: every Ponder
 * table is independently queryable but the wire cost of N round-trips is
 * silly when GraphQL was designed to fan-out in one request. Aliases below
 * keep the response shape unambiguous.
 *
 * The hook is a no-op when the indexer URL is unset
 * (`isAvailable === false`). Call-sites should render an Etherscan-derived
 * fallback in that case — the existing HistoryPage already does this.
 */

export type IndexerActivity = {
  /** Stable React key — pulled from `event.log.id` server-side. */
  id: string;
  /** Categorical label: "Stake", "Withdraw", "Claim", "Swap", etc. */
  kind: ActivityKind;
  /** Free-text subtitle (e.g. "Epoch 5", "30-day lock"). May be empty. */
  subtitle: string;
  /** Wei-scaled bigint (TOWELI or ETH depending on `kind`). Optional. */
  amount?: bigint;
  /** Asset symbol shown next to the amount. */
  assetSymbol?: 'ETH' | 'TOWELI' | 'LP';
  /** Unix seconds. */
  timestamp: number;
  /** Optional — only some indexer tables persist tx hashes today. */
  txHash?: `0x${string}`;
};

export type ActivityKind =
  | 'Stake'
  | 'Unstake'
  | 'Early Exit'
  | 'Stake Increase'
  | 'Lock Extend'
  | 'Staking Claim'
  | 'Revenue Claim'
  | 'Restake Claim'
  | 'LP Stake'
  | 'LP Withdraw'
  | 'LP Claim'
  | 'Swap'
  | 'Bribe Claim'
  | 'Bribe Refund';

const QUERY = /* GraphQL */ `
  query UserActivity($user: String!, $first: Int!) {
    stakingActions: stakingActions(
      where: { user: $user }
      orderBy: "timestamp"
      orderDirection: "desc"
      limit: $first
    ) {
      items {
        id
        type
        amount
        penalty
        timestamp
        txHash
      }
    }
    revenueClaims: revenueClaims(
      where: { user: $user }
      orderBy: "timestamp"
      orderDirection: "desc"
      limit: $first
    ) {
      items {
        id
        ethAmount
        fromEpoch
        toEpoch
        timestamp
      }
    }
    restakingClaims: restakingClaims(
      where: { user: $user }
      orderBy: "timestamp"
      orderDirection: "desc"
      limit: $first
    ) {
      items {
        id
        type
        amount
        timestamp
      }
    }
    swaps: swaps(
      where: { user: $user }
      orderBy: "timestamp"
      orderDirection: "desc"
      limit: $first
    ) {
      items {
        id
        amountIn
        fee
        timestamp
        txHash
      }
    }
    lpFarmActions: lpFarmActions(
      where: { user: $user }
      orderBy: "timestamp"
      orderDirection: "desc"
      limit: $first
    ) {
      items {
        id
        type
        amount
        timestamp
      }
    }
    bribeClaims: bribeClaims(
      where: { user: $user }
      orderBy: "timestamp"
      orderDirection: "desc"
      limit: $first
    ) {
      items {
        id
        epoch
        amount
        timestamp
      }
    }
  }
`;

type RawNode<T> = { items: T[] };
type RawShape = {
  stakingActions?: RawNode<{
    id: string;
    type: string;
    amount: string;
    penalty: string | null;
    timestamp: string;
    txHash: `0x${string}`;
  }>;
  revenueClaims?: RawNode<{
    id: string;
    ethAmount: string;
    fromEpoch: string;
    toEpoch: string;
    timestamp: string;
  }>;
  restakingClaims?: RawNode<{
    id: string;
    type: string;
    amount: string;
    timestamp: string;
  }>;
  swaps?: RawNode<{
    id: string;
    amountIn: string;
    fee: string;
    timestamp: string;
    txHash: `0x${string}`;
  }>;
  lpFarmActions?: RawNode<{
    id: string;
    type: string;
    amount: string;
    timestamp: string;
  }>;
  bribeClaims?: RawNode<{
    id: string;
    epoch: string;
    amount: string;
    timestamp: string;
  }>;
};

const STAKING_LABEL: Record<string, ActivityKind> = {
  stake: 'Stake',
  withdraw: 'Unstake',
  earlyWithdraw: 'Early Exit',
  claim: 'Staking Claim',
  extend: 'Lock Extend',
  increase: 'Stake Increase',
};
const LP_LABEL: Record<string, ActivityKind> = {
  stake: 'LP Stake',
  withdraw: 'LP Withdraw',
  claim: 'LP Claim',
};

export function useUserHistory(
  address: Address | undefined,
  options: { first?: number } = {},
) {
  const first = options.first ?? 50;
  const enabled = !!address;

  const q = useIndexerQuery<RawShape>({
    key: ['userHistory', address ?? 'none', first],
    query: QUERY,
    variables: { user: address?.toLowerCase(), first },
    enabled,
  });

  const activities: IndexerActivity[] = useMemo(() => {
    if (!q.data) return [];
    const acc: IndexerActivity[] = [];
    const push = (a: IndexerActivity) => acc.push(a);

    q.data.stakingActions?.items.forEach((r) => {
      push({
        id: `staking-${r.id}`,
        kind: STAKING_LABEL[r.type] ?? 'Stake',
        subtitle: r.penalty && BigInt(r.penalty) > 0n
          ? `Penalty ${formatTrimmed(r.penalty)} TOWELI`
          : '',
        amount: BigInt(r.amount),
        assetSymbol: 'TOWELI',
        timestamp: Number(r.timestamp),
        txHash: r.txHash,
      });
    });

    q.data.revenueClaims?.items.forEach((r) => {
      push({
        id: `revenue-${r.id}`,
        kind: 'Revenue Claim',
        subtitle: `Epochs ${r.fromEpoch}–${r.toEpoch}`,
        amount: BigInt(r.ethAmount),
        assetSymbol: 'ETH',
        timestamp: Number(r.timestamp),
      });
    });

    q.data.restakingClaims?.items.forEach((r) => {
      push({
        id: `restaking-${r.id}`,
        kind: 'Restake Claim',
        subtitle: r.type === 'bonus' ? 'Bonus stream' : 'Base stream',
        amount: BigInt(r.amount),
        assetSymbol: r.type === 'bonus' ? 'TOWELI' : 'ETH',
        timestamp: Number(r.timestamp),
      });
    });

    q.data.swaps?.items.forEach((r) => {
      push({
        id: `swap-${r.id}`,
        kind: 'Swap',
        subtitle: '',
        amount: BigInt(r.amountIn),
        assetSymbol: 'TOWELI',
        timestamp: Number(r.timestamp),
        txHash: r.txHash,
      });
    });

    q.data.lpFarmActions?.items.forEach((r) => {
      push({
        id: `lp-${r.id}`,
        kind: LP_LABEL[r.type] ?? 'LP Stake',
        subtitle: '',
        amount: BigInt(r.amount),
        assetSymbol: 'LP',
        timestamp: Number(r.timestamp),
      });
    });

    q.data.bribeClaims?.items.forEach((r) => {
      push({
        id: `bribe-${r.id}`,
        kind: 'Bribe Claim',
        subtitle: `Epoch ${r.epoch}`,
        amount: BigInt(r.amount),
        timestamp: Number(r.timestamp),
      });
    });

    return acc.sort((a, b) => b.timestamp - a.timestamp);
  }, [q.data]);

  return {
    activities,
    isAvailable: q.isAvailable,
    isLoading: q.isLoading,
    isError: q.isError,
    error: q.error,
    refetch: q.refetch,
  };
}

// Light helper — converts a decimal-string wei amount into a 4-decimal
// trimmed display string. The full formatting library is overkill for the
// one place this is used (the penalty subtitle).
function formatTrimmed(decimalWei: string): string {
  try {
    const n = BigInt(decimalWei);
    if (n === 0n) return '0';
    const whole = n / 10n ** 18n;
    const frac = (n / 10n ** 14n) % 10_000n;
    return frac === 0n
      ? whole.toString()
      : `${whole}.${frac.toString().padStart(4, '0').replace(/0+$/, '')}`;
  } catch {
    return decimalWei;
  }
}
