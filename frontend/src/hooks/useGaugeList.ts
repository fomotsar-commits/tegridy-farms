import { useCallback, useMemo } from 'react';
import { useReadContract, useReadContracts, useWatchContractEvent } from 'wagmi';
import { type Address } from 'viem';
import { GAUGE_CONTROLLER_ADDRESS, VOTE_INCENTIVES_ADDRESS, isDeployed } from '../lib/constants';
import { GAUGE_CONTROLLER_ABI, UNISWAP_V2_PAIR_ABI, ERC20_ABI, VOTE_INCENTIVES_ABI } from '../lib/contracts';

export interface GaugeInfo {
  pair: Address;
  token0?: Address;
  token1?: Address;
  symbol0?: string;
  symbol1?: string;
  /** Human label like "TOWELI / WETH"; falls back to truncated address. */
  label: string;
  /** Absolute gauge weight (current epoch). */
  weight: bigint;
  /** Relative weight in BPS-like units (contract-specific scale). */
  relativeWeight: bigint;
  /** Pro-rata TOWELI emission this epoch for this gauge. */
  emission: bigint;
}

/**
 * Read every whitelisted gauge plus the pair's token0/token1 symbols and the
 * gauge's current weight/emission. All reads batch through wagmi's multicall,
 * so this is one RPC round-trip per logical step (gauges → pair tokens →
 * token symbols). Safe to render on any page without hammering the node.
 */
export function useGaugeList(): { gauges: GaugeInfo[]; isLoading: boolean } {
  const enabled = isDeployed(GAUGE_CONTROLLER_ADDRESS);

  const { data: gaugesData, isLoading: isLoadingGauges, refetch: refetchGauges } = useReadContract({
    address: GAUGE_CONTROLLER_ADDRESS,
    abi: GAUGE_CONTROLLER_ABI,
    functionName: 'getGauges',
    query: { enabled, refetchInterval: 60_000 },
  });

  const pairs = useMemo(
    () => ((gaugesData as Address[] | undefined) ?? []),
    [gaugesData],
  );

  // Per-pair reads: token0, token1, weight, relativeWeight, emission (5 calls each).
  const pairReads = useMemo(
    () =>
      pairs.flatMap((pair) => [
        { address: pair, abi: UNISWAP_V2_PAIR_ABI, functionName: 'token0' as const },
        { address: pair, abi: UNISWAP_V2_PAIR_ABI, functionName: 'token1' as const },
        { address: GAUGE_CONTROLLER_ADDRESS, abi: GAUGE_CONTROLLER_ABI, functionName: 'getGaugeWeight' as const, args: [pair] as const },
        { address: GAUGE_CONTROLLER_ADDRESS, abi: GAUGE_CONTROLLER_ABI, functionName: 'getRelativeWeight' as const, args: [pair] as const },
        { address: GAUGE_CONTROLLER_ADDRESS, abi: GAUGE_CONTROLLER_ABI, functionName: 'getGaugeEmission' as const, args: [pair] as const },
      ]),
    [pairs],
  );

  const { data: pairData, isLoading: isLoadingPairs, refetch: refetchPairs } = useReadContracts({
    contracts: pairReads,
    query: { enabled: enabled && pairs.length > 0, refetchInterval: 60_000 },
  });

  // R075: refetch gauges + pair stats on every gauge-relevant event so
  // retired gauges and post-roll weights flush immediately instead of
  // waiting up to a minute for the poll. Memoised so all 5 watchers
  // share the same handler identity.
  const refetchAll = useCallback(() => {
    refetchGauges();
    refetchPairs();
  }, [refetchGauges, refetchPairs]);

  useWatchContractEvent({
    address: GAUGE_CONTROLLER_ADDRESS,
    abi: GAUGE_CONTROLLER_ABI,
    eventName: 'GaugeAdded',
    onLogs: refetchAll,
    enabled,
  });
  useWatchContractEvent({
    address: GAUGE_CONTROLLER_ADDRESS,
    abi: GAUGE_CONTROLLER_ABI,
    eventName: 'GaugeRemoved',
    onLogs: refetchAll,
    enabled,
  });
  useWatchContractEvent({
    address: GAUGE_CONTROLLER_ADDRESS,
    abi: GAUGE_CONTROLLER_ABI,
    eventName: 'Voted',
    onLogs: refetchAll,
    enabled,
  });
  useWatchContractEvent({
    address: GAUGE_CONTROLLER_ADDRESS,
    abi: GAUGE_CONTROLLER_ABI,
    eventName: 'VoteRevealed',
    onLogs: refetchAll,
    enabled,
  });
  // EpochAdvanced sourced from VoteIncentives — strongest emission-roll signal.
  useWatchContractEvent({
    address: VOTE_INCENTIVES_ADDRESS,
    abi: VOTE_INCENTIVES_ABI,
    eventName: 'EpochAdvanced',
    onLogs: refetchAll,
    enabled,
  });

  // Collect unique token addresses across all pairs, then batch symbol reads.
  const uniqueTokens = useMemo(() => {
    if (!pairData) return [] as Address[];
    const set = new Set<string>();
    pairs.forEach((_, i) => {
      const t0 = pairData[i * 5]?.status === 'success' ? (pairData[i * 5]!.result as Address) : undefined;
      const t1 = pairData[i * 5 + 1]?.status === 'success' ? (pairData[i * 5 + 1]!.result as Address) : undefined;
      if (t0) set.add(t0.toLowerCase());
      if (t1) set.add(t1.toLowerCase());
    });
    return Array.from(set) as Address[];
  }, [pairData, pairs]);

  const symbolReads = useMemo(
    () =>
      uniqueTokens.map((token) => ({
        address: token,
        abi: ERC20_ABI,
        functionName: 'symbol' as const,
      })),
    [uniqueTokens],
  );

  const { data: symbolData } = useReadContracts({
    contracts: symbolReads,
    query: { enabled: uniqueTokens.length > 0 },
  });

  const symbolMap = useMemo(() => {
    const m = new Map<string, string>();
    if (!symbolData) return m;
    uniqueTokens.forEach((t, i) => {
      if (symbolData[i]?.status === 'success') {
        m.set(t.toLowerCase(), symbolData[i]!.result as string);
      }
    });
    return m;
  }, [symbolData, uniqueTokens]);

  const gauges = useMemo<GaugeInfo[]>(
    () =>
      pairs.map((pair, i) => {
        const token0 = pairData?.[i * 5]?.status === 'success' ? (pairData[i * 5]!.result as Address) : undefined;
        const token1 = pairData?.[i * 5 + 1]?.status === 'success' ? (pairData[i * 5 + 1]!.result as Address) : undefined;
        const weight = pairData?.[i * 5 + 2]?.status === 'success' ? (pairData[i * 5 + 2]!.result as bigint) : 0n;
        const relativeWeight = pairData?.[i * 5 + 3]?.status === 'success' ? (pairData[i * 5 + 3]!.result as bigint) : 0n;
        const emission = pairData?.[i * 5 + 4]?.status === 'success' ? (pairData[i * 5 + 4]!.result as bigint) : 0n;
        const symbol0 = token0 ? symbolMap.get(token0.toLowerCase()) : undefined;
        const symbol1 = token1 ? symbolMap.get(token1.toLowerCase()) : undefined;
        const label = symbol0 && symbol1
          ? `${symbol0} / ${symbol1}`
          : `${pair.slice(0, 6)}…${pair.slice(-4)}`;
        return { pair, token0, token1, symbol0, symbol1, label, weight, relativeWeight, emission };
      }),
    [pairs, pairData, symbolMap],
  );

  return { gauges, isLoading: isLoadingGauges || isLoadingPairs };
}
