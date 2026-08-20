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
    if (!data) return emptyState(pool, 'unreadable', UNREADABLE_DETAIL);

    // Named, one per call, in the order the batch above was written, and each
    // checked before it is read. A positional `data[i]` asserts that slot `i`
    // exists and landed without either being true, and the failure mode is
    // silent: `Number(undefined)` is NaN and a cast of `undefined` to bigint is
    // a lie the renderer would print. Checking every entry also keeps the
    // all-or-nothing rule this hook is built on — twelve live figures beside one
    // that failed is a balance sheet that is wrong in exactly one place.
    const [
      tvl,
      outstanding,
      seized,
      utilisation,
      maxPrincipal,
      depositCap,
      ltv,
      apr,
      duration,
      origination,
      interest,
      sink,
      floor,
    ] = data;
    if (
      tvl.status !== 'success' ||
      outstanding.status !== 'success' ||
      seized.status !== 'success' ||
      utilisation.status !== 'success' ||
      maxPrincipal.status !== 'success' ||
      depositCap.status !== 'success' ||
      ltv.status !== 'success' ||
      apr.status !== 'success' ||
      duration.status !== 'success' ||
      origination.status !== 'success' ||
      interest.status !== 'success' ||
      sink.status !== 'success' ||
      floor.status !== 'success'
    ) {
      return emptyState(pool, 'unreadable', UNREADABLE_DETAIL);
    }

    const [hasFloor, floorFresh, floorAgeSeconds] = floor.result;

    return {
      pool,
      status: 'live' as const,
      tvlWei: tvl.result,
      outstandingWei: outstanding.result,
      seizedWei: seized.result,
      utilisationBps: Number(utilisation.result),
      maxPrincipalWei: maxPrincipal.result,
      depositCapWei: depositCap.result,
      ltvBps: Number(ltv.result),
      aprBps: Number(apr.result),
      loanDurationSeconds: Number(duration.result),
      originationFeeBps: Number(origination.result),
      interestFeeBps: Number(interest.result),
      hasLiquidationSink: isDeployed(sink.result),
      hasFloor,
      floorFresh,
      floorAgeSeconds: Number(floorAgeSeconds),
      detail: null,
    };
  }, [deployed, data, pool]);
}

export function usePooledLendingVaults(): PooledVaultState[] {
  // Fixed arity on purpose: hooks cannot be called in a loop over a list that
  // could change length, and the pool list is a compile-time constant. If a
  // fourth collection is added, this gets a fourth line.
  //
  // Destructured rather than indexed so the compiler checks that claim:
  // POOLED_LENDING_POOLS is a tuple, so these three names are pools, not
  // `pool | undefined`. Were the list ever annotated back into a plain array,
  // this is where it would stop compiling instead of where it would crash.
  const [jbac, naka, gnss] = POOLED_LENDING_POOLS;
  const a = usePooledLendingVault(jbac);
  const b = usePooledLendingVault(naka);
  const c = usePooledLendingVault(gnss);
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
