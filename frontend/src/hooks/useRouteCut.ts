import { useMemo } from 'react';
import { useReadContracts } from 'wagmi';
import { TEGRIDY_FACTORY_ABI, UNISWAP_V2_PAIR_ABI } from '../lib/contracts';
import { hopsOf, isNoPool, routeCutOf, venueCutOf, type VenueCut } from '../lib/evm/venueCut';

type Hex = `0x${string}`;
type Result = { status: string; result?: unknown } | undefined;
const ZERO_ADDR = '0x0000000000000000000000000000000000000000' as const;
const PAIR = /^0x[0-9a-fA-F]{40}$/;

/**
 * The venue cut of every pool a swap along `path` on `factory` trades through (lib/evm/venueCut.ts),
 * read live on `chainId`. 'loading' until every read has answered; off when `enabled` is false.
 */
export function useRouteCut(factory: Hex | undefined, path: readonly Hex[], chainId: number, enabled: boolean): VenueCut | 'loading' {
  const hops = useMemo(() => hopsOf(path), [path]);
  const on = enabled && !!factory && hops.length > 0;
  const pairs = useReadContracts({
    contracts: hops.map(([a, b]) => ({
      address: factory ?? ZERO_ADDR, abi: TEGRIDY_FACTORY_ABI, functionName: 'getPair', args: [a, b], chainId,
    } as const)),
    query: { enabled: on },
  });
  const pairAddrs = useMemo(
    () => hops.map((_, i) => {
      const r = pairs.data?.[i] as Result;
      return r?.status === 'success' && typeof r.result === 'string' && PAIR.test(r.result) ? (r.result as Hex) : null;
    }),
    [hops, pairs.data],
  );
  const live = useMemo(() => pairAddrs.filter((p): p is Hex => p !== null && !isNoPool(p)), [pairAddrs]);
  const kLasts = useReadContracts({
    contracts: live.map((address) => ({ address, abi: UNISWAP_V2_PAIR_ABI, functionName: 'kLast', chainId } as const)),
    query: { enabled: on && live.length > 0, refetchInterval: 60_000 },
  });

  if (!on) return 'unread';
  if (pairs.isPending || (live.length > 0 && kLasts.isPending)) return 'loading';
  return routeCutOf(pairAddrs.map((p): VenueCut => {
    if (p === null) return 'unread';
    if (isNoPool(p)) return 'off';
    const r = kLasts.data?.[live.indexOf(p)] as Result;
    return r?.status === 'success' ? venueCutOf(r.result) : 'unread';
  }));
}
