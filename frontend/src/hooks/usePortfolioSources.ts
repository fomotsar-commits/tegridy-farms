// The I/O half of the unified portfolio: two multicalls, one price context, no decisions.
//
// ── Why this hook owns its reads instead of composing the existing position hooks ────
// useUserPosition / useLpPosition / useRevenueStats each return amounts, and none of
// them returns WHEN those amounts were read or WHETHER the read failed. A portfolio
// built on them can print a total but cannot date it or qualify it, which is the only
// thing that makes a total safe to publish. So the portfolio reads its own legs, and
// gets `dataUpdatedAt` and per-call status as a consequence.
//
// ── Read cost ───────────────────────────────────────────────────────────────────────
// Two `useReadContracts` batches. viem folds each into ONE `eth_call` against
// Multicall3, so a connected wallet on mainnet costs:
//
//   batch A  17 contract reads  → 1 eth_call        every 60s
//   batch B   4 contract reads  → 1 eth_call        every 60s, ONLY when the wallet
//                                                   owns a staking NFT
//   native ETH balance          → 1 eth_getBalance  every 60s, shared query key with
//                                                   the dashboard's existing useBalance,
//                                                   so TanStack dedupes it to zero extra
//
// 2–3 JSON-RPC requests per minute, flat, regardless of position count. Both batches
// carry a `staleTime` at half the poll so a tab refocus does not re-fan-out.
//
// ── Why two batches, and why that is load-bearing ───────────────────────────────────
// The staking position is keyed by token id, and the token id is itself a read. Batch B
// therefore lands a round-trip AFTER batch A and is genuinely older. That lag is not
// hidden: each batch's `dataUpdatedAt` rides its legs into the aggregator, which reports
// the spread. Merging them into one batch is impossible; pretending they are contemporaneous
// is possible, and is what this hook exists not to do.

import { useMemo } from 'react';
import { useAccount, useBalance, useReadContracts } from 'wagmi';
import { formatEther, formatUnits } from 'viem';
import {
  CHAIN_ID,
  JBAC_NFT_ADDRESS,
  LP_FARMING_ADDRESS,
  OLD_LP_FARMING_ADDRESS,
  OLD_REVENUE_DISTRIBUTOR_ADDRESS,
  OLD_STAKING_MONITOR_VIEW_ADDRESS,
  OLD_TEGRIDY_STAKING_ADDRESS,
  REFERRAL_SPLITTER_ADDRESS,
  REVENUE_DISTRIBUTOR_ADDRESS,
  STAKING_MONITOR_VIEW_ADDRESS,
  TEGRIDY_LP_ADDRESS,
  TEGRIDY_STAKING_ADDRESS,
  TOWELI_ADDRESS,
} from '../lib/constants';
import {
  ERC20_ABI,
  LP_FARMING_ABI,
  REFERRAL_SPLITTER_ABI,
  REVENUE_DISTRIBUTOR_ABI,
  TEGRIDY_STAKING_ABI,
  UNISWAP_V2_PAIR_ABI,
} from '../lib/contracts';
import { useTOWELIPrice } from '../contexts/PriceContext';
import { buildPortfolioSources, type BatchLiveness, type PortfolioSnapshot } from '../lib/portfolio/sources';
import type { PortfolioSourceReport } from '../lib/portfolio/types';

const POLL_MS = 60_000;
const STALE_MS = 30_000;
/** wagmi needs a well-formed address even on a disabled query. */
const ZERO_ADDR = '0x0000000000000000000000000000000000000000' as const;

/** `dataUpdatedAt` is epoch ms and is 0 before the first successful fetch. */
function readAsOf(dataUpdatedAt: number | undefined): number | null {
  return dataUpdatedAt && dataUpdatedAt > 0 ? Math.floor(dataUpdatedAt / 1000) : null;
}

/** A multicall entry's result, or null when that entry reverted / was never fetched. */
function ok<T>(entry: { status: 'success' | 'failure'; result?: unknown } | undefined): T | null {
  return entry?.status === 'success' ? (entry.result as T) : null;
}

/** The sum of legs, or null when any one was not read: a partial sum is not a total. */
function sumKnown(...legs: (bigint | null)[]): bigint | null {
  let total = 0n;
  for (const v of legs) {
    if (v === null) return null;
    total += v;
  }
  return total;
}

/** Wei → whole units, preserving `null` so an unread leg never becomes a zero. */
function units(v: bigint | null, decimals = 18): number | null {
  return v === null ? null : Number(formatUnits(v, decimals));
}

export interface UsePortfolioSourcesResult {
  sources: PortfolioSourceReport[];
  /** Re-reads both batches and the native balance. Resolves once all have settled. */
  refetch: () => Promise<void>;
}

export function usePortfolioSources(): UsePortfolioSourcesResult {
  const { address, isConnected } = useAccount();
  const user = (address ?? ZERO_ADDR) as `0x${string}`;
  // Every read below is pinned to mainnet, so it is this portfolio's subject from
  // any wallet chain. NOT gated on useChainId() as well: that gate made every leg
  // "unavailable" for a wallet on Base or Robinhood while the Dashboard around it
  // showed the same positions, read from the same contracts.
  const enabled = !!address;
  const price = useTOWELIPrice();

  // Native ETH. Same {address, chainId} as the dashboard's own useBalance, so this
  // shares that query rather than issuing a second eth_getBalance.
  const ethBal = useBalance({
    address,
    chainId: CHAIN_ID,
    query: { enabled, refetchInterval: POLL_MS, staleTime: STALE_MS },
  });

  // ── Batch A ───────────────────────────────────────────────────────────────────────
  const baseQuery = useReadContracts({
    contracts: [
      { address: TOWELI_ADDRESS, abi: ERC20_ABI, functionName: 'balanceOf', args: [user], chainId: CHAIN_ID },
      { address: TEGRIDY_STAKING_ADDRESS, abi: TEGRIDY_STAKING_ABI, functionName: 'userTokenId', args: [user], chainId: CHAIN_ID },
      { address: TEGRIDY_STAKING_ADDRESS, abi: TEGRIDY_STAKING_ABI, functionName: 'unsettledRewards', args: [user], chainId: CHAIN_ID },
      { address: TEGRIDY_LP_ADDRESS, abi: ERC20_ABI, functionName: 'balanceOf', args: [user], chainId: CHAIN_ID },
      { address: TEGRIDY_LP_ADDRESS, abi: ERC20_ABI, functionName: 'totalSupply', chainId: CHAIN_ID },
      { address: TEGRIDY_LP_ADDRESS, abi: UNISWAP_V2_PAIR_ABI, functionName: 'getReserves', chainId: CHAIN_ID },
      { address: TEGRIDY_LP_ADDRESS, abi: UNISWAP_V2_PAIR_ABI, functionName: 'token0', chainId: CHAIN_ID },
      { address: LP_FARMING_ADDRESS, abi: LP_FARMING_ABI, functionName: 'rawBalanceOf', args: [user], chainId: CHAIN_ID },
      { address: LP_FARMING_ADDRESS, abi: LP_FARMING_ABI, functionName: 'earned', args: [user], chainId: CHAIN_ID },
      { address: REVENUE_DISTRIBUTOR_ADDRESS, abi: REVENUE_DISTRIBUTOR_ABI, functionName: 'pendingETH', args: [user], chainId: CHAIN_ID },
      { address: REFERRAL_SPLITTER_ADDRESS, abi: REFERRAL_SPLITTER_ABI, functionName: 'pendingETH', args: [user], chainId: CHAIN_ID },
      { address: JBAC_NFT_ADDRESS, abi: ERC20_ABI, functionName: 'balanceOf', args: [user], chainId: CHAIN_ID },
      // STAKING RELEASE 1: the first relaunch contracts keep their own positions, LP and
      // ETH share. A wallet's worth includes them; leaving them out would read as "less".
      { address: OLD_TEGRIDY_STAKING_ADDRESS, abi: TEGRIDY_STAKING_ABI, functionName: 'userTokenId', args: [user], chainId: CHAIN_ID },
      { address: OLD_TEGRIDY_STAKING_ADDRESS, abi: TEGRIDY_STAKING_ABI, functionName: 'unsettledRewards', args: [user], chainId: CHAIN_ID },
      { address: OLD_REVENUE_DISTRIBUTOR_ADDRESS, abi: REVENUE_DISTRIBUTOR_ABI, functionName: 'pendingETH', args: [user], chainId: CHAIN_ID },
      { address: OLD_LP_FARMING_ADDRESS, abi: LP_FARMING_ABI, functionName: 'rawBalanceOf', args: [user], chainId: CHAIN_ID },
      { address: OLD_LP_FARMING_ADDRESS, abi: LP_FARMING_ABI, functionName: 'earned', args: [user], chainId: CHAIN_ID },
    ],
    query: { enabled, refetchInterval: POLL_MS, staleTime: STALE_MS, refetchOnWindowFocus: true },
  });

  const b = baseQuery.data;
  const toweliWei = ok<bigint>(b?.[0]);
  const tokenId = ok<bigint>(b?.[1]);
  const oldTokenId = ok<bigint>(b?.[12]);
  const unsettledWei = sumKnown(ok<bigint>(b?.[2]), ok<bigint>(b?.[13]));
  const walletLp = ok<bigint>(b?.[3]);
  const lpTotalSupply = ok<bigint>(b?.[4]);
  const reserves = ok<readonly [bigint, bigint, number]>(b?.[5]);
  const token0 = ok<string>(b?.[6]);
  const stakedLp = sumKnown(ok<bigint>(b?.[7]), ok<bigint>(b?.[15]));
  const lpEarnedWei = sumKnown(ok<bigint>(b?.[8]), ok<bigint>(b?.[16]));
  const revenueWei = sumKnown(ok<bigint>(b?.[9]), ok<bigint>(b?.[14]));
  const referralWei = ok<bigint>(b?.[10]);
  const jbacBal = ok<bigint>(b?.[11]);

  const hasNewNft = tokenId !== null && tokenId > 0n;
  const hasOldNft = oldTokenId !== null && oldTokenId > 0n;
  const hasStakingNft = hasNewNft || hasOldNft;

  // ── Batch B ───────────────────────────────────────────────────────────────────────
  // getPosition / earned live on StakingMonitorView (EIP-170 split), keyed by token id,
  // one monitor per staking contract. A contract where the wallet holds no NFT is read
  // with a dummy id and counted as zero below, never as its dummy position.
  const positionQuery = useReadContracts({
    contracts: [
      { address: STAKING_MONITOR_VIEW_ADDRESS, abi: TEGRIDY_STAKING_ABI, functionName: 'getPosition', args: [hasNewNft ? (tokenId as bigint) : 1n], chainId: CHAIN_ID },
      { address: STAKING_MONITOR_VIEW_ADDRESS, abi: TEGRIDY_STAKING_ABI, functionName: 'earned', args: [hasNewNft ? (tokenId as bigint) : 1n], chainId: CHAIN_ID },
      { address: OLD_STAKING_MONITOR_VIEW_ADDRESS, abi: TEGRIDY_STAKING_ABI, functionName: 'getPosition', args: [hasOldNft ? (oldTokenId as bigint) : 1n], chainId: CHAIN_ID },
      { address: OLD_STAKING_MONITOR_VIEW_ADDRESS, abi: TEGRIDY_STAKING_ABI, functionName: 'earned', args: [hasOldNft ? (oldTokenId as bigint) : 1n], chainId: CHAIN_ID },
    ],
    query: { enabled: enabled && hasStakingNft, refetchInterval: POLL_MS, staleTime: STALE_MS, refetchOnWindowFocus: true },
  });

  const p = positionQuery.data;
  // One contract's leg: unknown when its token id was not read, a real zero only when the
  // id READ as 0 (no NFT there), otherwise the position read itself.
  const leg = (id: bigint | null, value: bigint | null): bigint | null =>
    id === null ? null : id === 0n ? 0n : value;
  const amountAt = (i: number): bigint | null => {
    const t = ok<readonly [bigint, bigint, bigint, bigint, boolean, boolean]>(p?.[i]);
    return t === null ? null : t[0];
  };
  const stakedWei = sumKnown(leg(tokenId, amountAt(0)), leg(oldTokenId, amountAt(2)));
  const pendingWei = sumKnown(leg(tokenId, ok<bigint>(p?.[1])), leg(oldTokenId, ok<bigint>(p?.[3])));

  // ── LP redeemable underlying ──────────────────────────────────────────────────────
  // Derived, not read: the share of reserves this wallet's LP (held + staked) redeems.
  // Any missing input makes the WHOLE derivation null — a half-known share would be a
  // number that looks like a measurement.
  const lpUnderlying = useMemo(() => {
    if (walletLp === null || stakedLp === null || lpTotalSupply === null || !reserves || token0 === null) {
      return { toweli: null as number | null, weth: null as number | null };
    }
    const totalLp = walletLp + stakedLp;
    if (totalLp === 0n) return { toweli: 0, weth: 0 };
    if (lpTotalSupply === 0n) return { toweli: null as number | null, weth: null as number | null };
    const toweliIsToken0 = token0.toLowerCase() === TOWELI_ADDRESS.toLowerCase();
    const toweliReserve = toweliIsToken0 ? reserves[0] : reserves[1];
    const wethReserve = toweliIsToken0 ? reserves[1] : reserves[0];
    return {
      toweli: Number(formatEther((toweliReserve * totalLp) / lpTotalSupply)),
      weth: Number(formatEther((wethReserve * totalLp) / lpTotalSupply)),
    };
  }, [walletLp, stakedLp, lpTotalSupply, reserves, token0]);

  // Held as primitives rather than objects so the memo below re-runs on a liveness
  // CHANGE and not on every render — a `BatchLiveness` literal is a new identity each time.
  const baseAsOf = readAsOf(baseQuery.dataUpdatedAt);
  const baseLoading = baseQuery.isLoading;
  const baseFailed = baseQuery.isError;
  const posAsOf = readAsOf(positionQuery.dataUpdatedAt);
  const posLoading = positionQuery.isLoading;
  const posFailed = positionQuery.isError;

  const sources = useMemo<PortfolioSourceReport[]>(() => {
    const base: BatchLiveness = { asOf: baseAsOf, isLoading: baseLoading, failed: baseFailed };
    // With no staking NFT there is no batch B; the leg settles on batch A, so batch B must
    // not report itself as perpetually loading and drag the whole total to PARTIAL.
    const position: BatchLiveness = hasStakingNft
      ? { asOf: posAsOf, isLoading: posLoading, failed: posFailed }
      : base;
    const snapshot: PortfolioSnapshot = {
      connected: isConnected && !!address,
      price: {
        toweliUsd: price.priceInUsd,
        ethUsd: price.ethUsd,
        // Mirrors the price context's own gates. `priceUnavailable` means nothing was
        // read at all; `displayPriceStale` means only a localStorage echo survived — a
        // cached figure is not a current mark and must not silently value a position.
        toweliPriceable: price.isLoaded && price.priceInUsd > 0 && !price.priceUnavailable && !price.displayPriceStale,
        // `oracleStale` is the Chainlink heartbeat/band verdict. Failing it removes the
        // ETH legs from the sum instead of marking them at zero.
        ethPriceable: price.isLoaded && price.ethUsd > 0 && !price.oracleStale,
      },
      base,
      position,
      wallet: {
        eth: ethBal.isError ? null : ethBal.data ? Number(formatEther(ethBal.data.value)) : null,
        toweli: units(toweliWei),
      },
      staking: {
        hasPosition: hasStakingNft,
        staked: units(stakedWei),
        pending: units(pendingWei),
        unsettled: units(unsettledWei),
      },
      lp: { ...lpUnderlying, pendingRewards: units(lpEarnedWei) },
      claimable: { revenueEth: units(revenueWei), referralEth: units(referralWei) },
      nft: { jbac: jbacBal === null ? null : Number(jbacBal) },
    };
    return buildPortfolioSources(snapshot);
  }, [
    isConnected, address,
    price.priceInUsd, price.ethUsd, price.isLoaded, price.priceUnavailable, price.displayPriceStale, price.oracleStale,
    baseAsOf, baseLoading, baseFailed,
    posAsOf, posLoading, posFailed,
    ethBal.data, ethBal.isError,
    toweliWei, stakedWei, pendingWei, unsettledWei, hasStakingNft,
    lpUnderlying, lpEarnedWei, revenueWei, referralWei, jbacBal,
  ]);

  const refetch = async () => {
    await Promise.all([baseQuery.refetch(), positionQuery.refetch(), ethBal.refetch()]);
  };

  return { sources, refetch };
}
