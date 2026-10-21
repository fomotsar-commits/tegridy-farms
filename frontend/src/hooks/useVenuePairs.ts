import { useMemo } from 'react';
import { useReadContract, useReadContracts } from 'wagmi';
import { ERC20_ABI, TEGRIDY_FACTORY_ABI, UNISWAP_V2_PAIR_ABI } from '../lib/contracts';
import { liquidityVenueOn } from '../lib/chains/liquidityVenue';

/** The most pools listed at once; a longer list says how many it left out. */
export const VENUE_PAIRS_SHOWN = 50;

type Hex = `0x${string}`;
const ZERO_ADDR = '0x0000000000000000000000000000000000000000' as const;

export interface VenuePairToken {
  readonly address: Hex;
  /** Null: symbol() or decimals() did not answer. */
  readonly symbol: string | null;
  readonly decimals: number | null;
}

/** One pool as read. Every null is a read that did not land, never a zero. */
export interface VenuePair {
  readonly index: number;
  readonly address: Hex | null;
  readonly token0: VenuePairToken | null;
  readonly token1: VenuePairToken | null;
  readonly reserve0: bigint | null;
  readonly reserve1: bigint | null;
  /** Non-zero once the venue's one-sixth cut is switched on for this pool. */
  readonly kLast: bigint | null;
}

export type VenuePairsRead =
  | { readonly status: 'loading' }
  /** allPairsLength() did not answer: nothing is known, not even that the list is empty. */
  | { readonly status: 'unread' }
  /** allPairsLength() answered 0. The only state that may say "no pools". */
  | { readonly status: 'empty' }
  | { readonly status: 'listed'; readonly total: number; readonly pairs: readonly VenuePair[] };

type Result = { status: string; result?: unknown } | undefined;
const ok = <T,>(r: Result): T | null => (r?.status === 'success' ? (r.result as T) : null);

const PAIR_CALLS = ['token0', 'token1', 'getReserves', 'kLast'] as const;

/**
 * Every pool in `chainId`'s own factory: allPairsLength(), then allPairs(i), then each pair's
 * tokens, reserves and kLast, then each token's symbol and decimals. Every read is pinned to
 * the venue's chain, so a wallet on another network never reads this factory's address there.
 */
export function useVenuePairs(chainId: number): VenuePairsRead {
  const venue = useMemo(() => liquidityVenueOn(chainId), [chainId]);
  const readChainId = venue?.chainId ?? 0;
  const factory = venue?.factory ?? ZERO_ADDR;

  const length = useReadContract({
    address: factory,
    abi: TEGRIDY_FACTORY_ABI,
    functionName: 'allPairsLength',
    chainId: readChainId,
    query: { enabled: !!venue, refetchInterval: 60_000 },
  });
  const total = typeof length.data === 'bigint' ? Number(length.data) : null;
  const shown = total === null ? 0 : Math.min(total, VENUE_PAIRS_SHOWN);

  const addressesOn = !!venue && shown > 0;
  const addresses = useReadContracts({
    contracts: Array.from({ length: shown }, (_, i) => ({
      address: factory, abi: TEGRIDY_FACTORY_ABI, functionName: 'allPairs', args: [BigInt(i)], chainId: readChainId,
    } as const)),
    query: { enabled: addressesOn },
  });
  const pairAddrs = useMemo(
    () => Array.from({ length: shown }, (_, i) => ok<Hex>(addresses.data?.[i] as Result)),
    [addresses.data, shown],
  );
  const knownPairs = useMemo(() => pairAddrs.filter((a): a is Hex => a !== null), [pairAddrs]);

  const detailsOn = knownPairs.length > 0;
  const details = useReadContracts({
    contracts: knownPairs.flatMap((address) =>
      PAIR_CALLS.map((functionName) => ({ address, abi: UNISWAP_V2_PAIR_ABI, functionName, chainId: readChainId } as const)),
    ),
    query: { enabled: detailsOn, refetchInterval: 60_000 },
  });
  const detail = (pair: number, call: (typeof PAIR_CALLS)[number]) =>
    details.data?.[pair * PAIR_CALLS.length + PAIR_CALLS.indexOf(call)] as Result;

  const tokenAddrs = useMemo(() => {
    const out = new Map<string, Hex>();
    knownPairs.forEach((_, i) => {
      for (const call of ['token0', 'token1'] as const) {
        const t = ok<Hex>(details.data?.[i * PAIR_CALLS.length + PAIR_CALLS.indexOf(call)] as Result);
        if (t) out.set(t.toLowerCase(), t);
      }
    });
    return [...out.values()];
  }, [details.data, knownPairs]);

  const tokensOn = tokenAddrs.length > 0;
  const tokens = useReadContracts({
    contracts: tokenAddrs.flatMap((address) => [
      { address, abi: ERC20_ABI, functionName: 'symbol', chainId: readChainId } as const,
      { address, abi: ERC20_ABI, functionName: 'decimals', chainId: readChainId } as const,
    ]),
    query: { enabled: tokensOn },
  });

  if (!venue || length.isError) return { status: 'unread' };
  if (total === null) return { status: 'loading' };
  if (total === 0) return { status: 'empty' };
  if ((addressesOn && addresses.isPending) || (detailsOn && details.isPending) || (tokensOn && tokens.isPending)) {
    return { status: 'loading' };
  }

  const tokenOf = (address: Hex | null): VenuePairToken | null => {
    if (!address) return null;
    const i = tokenAddrs.findIndex((t) => t.toLowerCase() === address.toLowerCase());
    const symbol = i < 0 ? null : ok<unknown>(tokens.data?.[i * 2] as Result);
    const decimals = i < 0 ? null : ok<unknown>(tokens.data?.[i * 2 + 1] as Result);
    return {
      address,
      symbol: typeof symbol === 'string' ? symbol : null,
      decimals: typeof decimals === 'number' ? decimals : null,
    };
  };

  const pairs = pairAddrs.map((address, index): VenuePair => {
    const k = address ? knownPairs.indexOf(address) : -1;
    if (k < 0) return { index, address: null, token0: null, token1: null, reserve0: null, reserve1: null, kLast: null };
    const reserves = ok<readonly [bigint, bigint, number]>(detail(k, 'getReserves'));
    return {
      index,
      address,
      token0: tokenOf(ok<Hex>(detail(k, 'token0'))),
      token1: tokenOf(ok<Hex>(detail(k, 'token1'))),
      reserve0: reserves?.[0] ?? null,
      reserve1: reserves?.[1] ?? null,
      kLast: ok<bigint>(detail(k, 'kLast')),
    };
  });
  return { status: 'listed', total, pairs };
}
