import { useMemo } from 'react';
import { useReadContracts } from 'wagmi';
import { CHAIN_ID, isDeployed } from '../lib/constants';
import { isIndexerConfigured, indexerConfigProblem } from '../lib/indexer/client';
import {
  NFTFI_POOLED_VAULT_ABI,
  POOLED_LENDING_POOLS,
  type PooledLendingPool,
} from './usePooledLendingConfig';

// Live state of one pooled-lending vault.
//
// THE THREE STATES ARE NOT INTERCHANGEABLE, and collapsing them is the whole
// failure this hook is shaped to prevent:
//
//   not-deployed — there is no contract. Nothing was asked and nothing here is
//                  a fact about anything. A zero TVL in this state would be a
//                  fabricated zero.
//   unreadable   — there IS a contract and the reads did not land. Also not a
//                  fact about the pool.
//   live         — the reads landed. Now, and only now, a zero means zero.
//
// A caller that renders `tvlWei` without branching on `status` will present an
// RPC outage as an empty pool.

export type PooledVaultStatus = 'not-deployed' | 'unreadable' | 'live';

export interface PooledVaultState {
  pool: PooledLendingPool;
  status: PooledVaultStatus;
  /** Meaningful only in `live`. */
  tvlWei: bigint | null;
  outstandingWei: bigint | null;
  seizedWei: bigint | null;
  utilisationBps: number | null;
  /** The largest draw the pool would make right now. Zero has many causes. */
  maxPrincipalWei: bigint | null;
  depositCapWei: bigint | null;
  ltvBps: number | null;
  aprBps: number | null;
  loanDurationSeconds: number | null;
  originationFeeBps: number | null;
  interestFeeBps: number | null;
  /** False means `seize` and `surrender` revert: nothing can be liquidated. */
  hasLiquidationSink: boolean | null;
  /** A floor has ever been pushed. */
  hasFloor: boolean | null;
  /** That floor is inside the contract's freshness window. */
  floorFresh: boolean | null;
  floorAgeSeconds: number | null;
  /** Plain-language reason the surface should show instead of numbers. */
  detail: string | null;
}

const NOT_DEPLOYED_DETAIL =
  'This pool has no contract on any chain yet, so there is nothing to read. Nothing on this card is a measurement.';

const UNREADABLE_DETAIL =
  'The pool contract could not be read just now. Nothing shown is a statement about its balance sheet.';

function emptyState(pool: PooledLendingPool, status: PooledVaultStatus, detail: string): PooledVaultState {
  return {
    pool,
    status,
    tvlWei: null,
    outstandingWei: null,
    seizedWei: null,
    utilisationBps: null,
    maxPrincipalWei: null,
    depositCapWei: null,
    ltvBps: null,
    aprBps: null,
    loanDurationSeconds: null,
    originationFeeBps: null,
    interestFeeBps: null,
    hasLiquidationSink: null,
    hasFloor: null,
    floorFresh: null,
    floorAgeSeconds: null,
    detail,
  };
}

export function usePooledLendingVault(pool: PooledLendingPool): PooledVaultState {
  const deployed = isDeployed(pool.vault);

  const { data } = useReadContracts({
    contracts: [
      { address: pool.vault, abi: NFTFI_POOLED_VAULT_ABI, functionName: 'totalAssets', chainId: CHAIN_ID },
      { address: pool.vault, abi: NFTFI_POOLED_VAULT_ABI, functionName: 'principalOutstanding', chainId: CHAIN_ID },
      { address: pool.vault, abi: NFTFI_POOLED_VAULT_ABI, functionName: 'seizedPrincipal', chainId: CHAIN_ID },
      { address: pool.vault, abi: NFTFI_POOLED_VAULT_ABI, functionName: 'utilisationBps', chainId: CHAIN_ID },
      { address: pool.vault, abi: NFTFI_POOLED_VAULT_ABI, functionName: 'maxPrincipal', chainId: CHAIN_ID },
      { address: pool.vault, abi: NFTFI_POOLED_VAULT_ABI, functionName: 'depositCapWei', chainId: CHAIN_ID },
      { address: pool.vault, abi: NFTFI_POOLED_VAULT_ABI, functionName: 'ltvBps', chainId: CHAIN_ID },
      { address: pool.vault, abi: NFTFI_POOLED_VAULT_ABI, functionName: 'aprBps', chainId: CHAIN_ID },
      { address: pool.vault, abi: NFTFI_POOLED_VAULT_ABI, functionName: 'loanDuration', chainId: CHAIN_ID },
      { address: pool.vault, abi: NFTFI_POOLED_VAULT_ABI, functionName: 'originationFeeBps', chainId: CHAIN_ID },
      { address: pool.vault, abi: NFTFI_POOLED_VAULT_ABI, functionName: 'interestFeeBps', chainId: CHAIN_ID },
      { address: pool.vault, abi: NFTFI_POOLED_VAULT_ABI, functionName: 'liquidationSink', chainId: CHAIN_ID },
      { address: pool.vault, abi: NFTFI_POOLED_VAULT_ABI, functionName: 'floorStatus', chainId: CHAIN_ID },
      // The gate is on the query, not on the address: a zero address must never
      // reach an eth_call, because the node answers "0x" and viem decodes that
      // into a shape a careless caller would render as a real reading.
    ] as const,
    query: { enabled: deployed, refetchInterval: 60_000 },
  });

  return useMemo(() => {
    if (!deployed) return emptyState(pool, 'not-deployed', NOT_DEPLOYED_DETAIL);
    if (!data || data.some((r) => r.status !== 'success')) {
      return emptyState(pool, 'unreadable', UNREADABLE_DETAIL);
    }

    const num = (i: number) => Number(data[i].result as bigint);
    const floor = data[12].result as readonly [boolean, boolean, bigint];

    return {
      pool,
      status: 'live' as const,
      tvlWei: data[0].result as bigint,
      outstandingWei: data[1].result as bigint,
      seizedWei: data[2].result as bigint,
      utilisationBps: num(3),
      maxPrincipalWei: data[4].result as bigint,
      depositCapWei: data[5].result as bigint,
      ltvBps: num(6),
      aprBps: num(7),
      loanDurationSeconds: num(8),
      originationFeeBps: num(9),
      interestFeeBps: num(10),
      hasLiquidationSink: isDeployed(data[11].result as string),
      hasFloor: floor[0],
      floorFresh: floor[1],
      floorAgeSeconds: Number(floor[2]),
      detail: null,
    };
  }, [deployed, data, pool]);
}

export function usePooledLendingVaults(): PooledVaultState[] {
  const a = usePooledLendingVault(POOLED_LENDING_POOLS[0]);
  const b = usePooledLendingVault(POOLED_LENDING_POOLS[1]);
  const c = usePooledLendingVault(POOLED_LENDING_POOLS[2]);
  // Fixed arity on purpose: hooks cannot be called in a loop over a list that
  // could change length, and the pool list is a compile-time constant. If a
  // fourth collection is added, this gets a fourth line.
  return useMemo(() => [a, b, c], [a, b, c]);
}

/**
 * Why a pool's history strip cannot be drawn.
 *
 * Live contract reads give the pool's state RIGHT NOW. Realized APY, past
 * liquidations and the loan book over time are indexed data, and this venue has
 * no hosted indexer — `VITE_INDEXER_URL` is unset. Returning the reason rather
 * than an empty array keeps "we could not ask" from rendering as "it never
 * happened", which for a lending pool is the difference between "no defaults"
 * and "no idea".
 */
export function pooledLendingHistoryGate(): { available: boolean; detail: string } {
  if (isIndexerConfigured()) {
    return { available: true, detail: '' };
  }
  const problem = indexerConfigProblem();
  return {
    available: false,
    detail:
      problem ??
      'Realized yield and liquidation history come from the indexer, and this deployment has no indexer configured. No history is shown because none could be read - not because none exists.',
  };
}
