import { useCallback, useMemo } from 'react';
import { useReadContracts, useWaitForTransactionReceipt, useWriteContract } from 'wagmi';
import { toast } from 'sonner';
import type { Address } from 'viem';
import { ERC20_ABI, VESTING_WALLET_ABI } from '../lib/contracts';
import { CHAIN_ID } from '../lib/constants';
import { surfaceTxError } from '../lib/txErrors';
import { useVestingFactory } from './useVestingFactory';

/**
 * The connected wallet's vesting streams, both directions, with the schedule fields a
 * dashboard needs.
 *
 * A wallet whose `vestingInfo()` read failed appears in the list as `info: null` rather
 * than being dropped or zero-filled. Dropping it would understate what the wallet
 * holds; zero-filling it would claim a stream is empty when nobody asked the chain.
 */

export interface VestingStreamInfo {
  beneficiary: Address;
  token: Address;
  creator: Address;
  /** Unix seconds. */
  start: number;
  cliff: number;
  end: number;
  balance: bigint;
  released: bigint;
  releasable: bigint;
  /** `balance - releasable`: in the wallet and not withdrawable right now. */
  locked: bigint;
  cliffReached: boolean;
  fullyVested: boolean;
}

export interface VestingStream {
  wallet: Address;
  /** Which side of the stream the connected wallet is on. */
  direction: 'incoming' | 'outgoing';
  /** `null` when the wallet's read did not land — NOT an empty stream. */
  info: VestingStreamInfo | null;
  tokenSymbol: string | null;
  tokenDecimals: number | null;
}

/**
 * Linear-with-cliff progress at `now`, as OpenZeppelin computes it.
 *
 * Returned as a fraction of the SCHEDULE, not of the balance: it is what the schedule
 * says has vested by now, which for a stream that has already released some tokens is
 * not the same as the share of the current balance. Exported so the schedule bar and
 * its test agree on one definition.
 */
export function scheduleProgress(info: VestingStreamInfo, nowSeconds: number): number {
  if (nowSeconds < info.cliff) return 0;
  if (nowSeconds >= info.end) return 1;
  const span = info.end - info.start;
  if (span <= 0) return 1;
  return Math.min(1, Math.max(0, (nowSeconds - info.start) / span));
}

export function useVestingStreams() {
  const registry = useVestingFactory();

  const wallets = useMemo(() => {
    const incoming = (registry.incoming ?? []).map((w) => ({ wallet: w, direction: 'incoming' as const }));
    const outgoing = (registry.outgoing ?? [])
      // A wallet a creator funded for THEMSELVES appears in both lists; show it once,
      // as incoming, because that is the side that can act on it.
      .filter((w) => !(registry.incoming ?? []).some((i) => i.toLowerCase() === w.toLowerCase()))
      .map((w) => ({ wallet: w, direction: 'outgoing' as const }));
    return [...incoming, ...outgoing];
  }, [registry.incoming, registry.outgoing]);

  const { data: infoData, refetch: refetchInfo } = useReadContracts({
    contracts: wallets.map((w) => ({
      address: w.wallet,
      abi: VESTING_WALLET_ABI,
      functionName: 'vestingInfo' as const,
      chainId: CHAIN_ID,
    })),
    query: { enabled: wallets.length > 0, refetchInterval: 30_000 },
  });

  const rawInfos = useMemo(
    () =>
      wallets.map((_, i) => {
        const r = infoData?.[i];
        if (r?.status !== 'success') return null;
        const v = r.result as {
          beneficiary: Address;
          token: Address;
          creator: Address;
          start: bigint;
          cliff: bigint;
          end: bigint;
          balance: bigint;
          released: bigint;
          releasable: bigint;
          locked: bigint;
          cliffReached: boolean;
          fullyVested: boolean;
        };
        return {
          beneficiary: v.beneficiary,
          token: v.token,
          creator: v.creator,
          start: Number(v.start),
          cliff: Number(v.cliff),
          end: Number(v.end),
          balance: v.balance,
          released: v.released,
          releasable: v.releasable,
          locked: v.locked,
          cliffReached: v.cliffReached,
          fullyVested: v.fullyVested,
        } satisfies VestingStreamInfo;
      }),
    [wallets, infoData],
  );

  const tokens = useMemo(() => {
    const set = new Map<string, Address>();
    for (const info of rawInfos) {
      if (info && info.token !== '0x0000000000000000000000000000000000000000') {
        set.set(info.token.toLowerCase(), info.token);
      }
    }
    return [...set.values()];
  }, [rawInfos]);

  const { data: tokenData } = useReadContracts({
    contracts: tokens.flatMap((t) => [
      { address: t, abi: ERC20_ABI, functionName: 'symbol' as const, chainId: CHAIN_ID },
      { address: t, abi: ERC20_ABI, functionName: 'decimals' as const, chainId: CHAIN_ID },
    ]),
    query: { enabled: tokens.length > 0 },
  });

  const streams: VestingStream[] = useMemo(
    () =>
      wallets.map((w, i) => {
        const info = rawInfos[i] ?? null;
        const tokenIdx = info ? tokens.findIndex((t) => t.toLowerCase() === info.token.toLowerCase()) : -1;
        const base = tokenIdx * 2;
        return {
          wallet: w.wallet,
          direction: w.direction,
          info,
          tokenSymbol:
            tokenIdx >= 0 && tokenData?.[base]?.status === 'success' ? (tokenData[base]!.result as string) : null,
          tokenDecimals:
            tokenIdx >= 0 && tokenData?.[base + 1]?.status === 'success'
              ? Number(tokenData[base + 1]!.result as number)
              : null,
        };
      }),
    [wallets, rawInfos, tokens, tokenData],
  );

  const { writeContract, data: hash, isPending, reset } = useWriteContract();
  const { isLoading: isConfirming, isSuccess } = useWaitForTransactionReceipt({ chainId: CHAIN_ID, hash });

  /**
   * Crank a stream's release. Permissionless by design — the destination is `owner()`
   * on the wallet, not a parameter, so this can only move vested tokens toward the
   * beneficiary they already belong to.
   */
  const release = useCallback(
    (wallet: Address, token: Address) => {
      writeContract(
        { address: wallet, abi: VESTING_WALLET_ABI, functionName: 'release', args: [token], chainId: CHAIN_ID },
        { onError: (err) => surfaceTxError(err, toast) },
      );
    },
    [writeContract],
  );

  return {
    deployed: registry.deployed,
    factoryAddress: registry.address,
    registryIncomplete: registry.readIncomplete,
    /** True when the registry answered but at least one wallet's own read did not. */
    streamReadIncomplete: wallets.length > 0 && streams.some((s) => s.info === null),
    streams,
    refetch: () => {
      registry.refetch();
      void refetchInfo();
    },
    release,
    isPending,
    isConfirming,
    isSuccess,
    reset,
    txHash: hash,
  };
}
