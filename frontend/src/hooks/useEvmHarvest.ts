import { useCallback, useMemo } from 'react';
import { useAccount, usePublicClient, useReadContracts, useSwitchChain, useWriteContract } from 'wagmi';
import { ERC20_ABI, LIGHTHOUSE_LADDER_ABI } from '../lib/contracts';
import { EVM_CHAIN_IDS, evmHarvestRooms, planEvmPool, type EvmClaim } from '../lib/harvest/evm';
import type { SwitchResult } from '../lib/harvest/run';
import type { ClaimResult, HarvestChain, HarvestPlan } from '../lib/harvest/types';
import { extractErrorMessage, isUserRejection, waitForReceiptOutcome } from '../lib/txErrors';

const ZERO = '0x0000000000000000000000000000000000000000' as const;
const CHAIN_OF: Record<number, Exclude<HarvestChain, 'solana'>> = { 1: 'ethereum', 8453: 'base' };

/**
 * Harvest's Ethereum and Base half: every island pool there, read for the connected
 * account, and the send for one claim.
 *
 * Both pool kinds answer `earned(address)`, `getReward()`, `stakingToken()` and
 * `rewardsToken()` with the same selectors, so one ABI serves both; only a lock ladder
 * has `rewardSurplus()`, and only a ladder is asked for it.
 */
export function useEvmHarvest() {
  const { address, chainId } = useAccount();
  const rooms = useMemo(() => evmHarvestRooms(), []);
  const user = address ?? ZERO;

  // Five reads per pool, in this fixed order: earned, stakingToken, rewardsToken,
  // rewardSurplus (a plain pool asks earned again in its place, and ignores it), decimals.
  const reads = useReadContracts({
    contracts: rooms.flatMap((b) => {
      const p = { address: b.stakePool as `0x${string}`, abi: LIGHTHOUSE_LADDER_ABI, chainId: EVM_CHAIN_IDS[b.chain] } as const;
      const ladder = b.poolKind === 'ladder';
      return [
        { ...p, functionName: 'earned', args: [user] } as const,
        { ...p, functionName: 'stakingToken' } as const,
        { ...p, functionName: 'rewardsToken' } as const,
        ladder ? ({ ...p, functionName: 'rewardSurplus' } as const) : ({ ...p, functionName: 'earned', args: [user] } as const),
        { address: b.address as `0x${string}`, abi: ERC20_ABI, chainId: EVM_CHAIN_IDS[b.chain], functionName: 'decimals' } as const,
      ];
    }),
    // Every 30 s, as the EVM pool cards read themselves (EvmLadderPoolLive): a claim made on one
    // of those cards shows here within that, with no word passed between them.
    query: { enabled: Boolean(address), refetchInterval: 30_000 },
  });

  const plan: HarvestPlan<EvmClaim> | null = useMemo(() => {
    if (!address || reads.isLoading || !reads.data) return null;
    const at = (i: number) => {
      const r = reads.data?.[i];
      return r && r.status === 'success' ? r.result : null;
    };
    const parts = rooms.map((b, i) => {
      const k = i * 5;
      const dec = at(k + 4);
      return planEvmPool(b, {
        earnedRaw: at(k) as bigint | null,
        stakingToken: at(k + 1) as string | null,
        rewardsToken: at(k + 2) as string | null,
        ...(b.poolKind === 'ladder' ? { surplusRaw: at(k + 3) as bigint | null } : {}),
        // Display only: the amount the pool sends is the pool's, whatever is printed here.
        decimals: dec === null ? b.decimals ?? 18 : Number(dec),
      });
    });
    return {
      claims: parts.flatMap((p) => p.claims),
      held: parts.flatMap((p) => p.held),
      unread: parts.flatMap((p) => p.unread),
    };
  }, [address, reads.isLoading, reads.data, rooms]);

  const { writeContractAsync } = useWriteContract();
  const { switchChainAsync } = useSwitchChain();
  const ethClient = usePublicClient({ chainId: EVM_CHAIN_IDS.ethereum });
  const baseClient = usePublicClient({ chainId: EVM_CHAIN_IDS.base });

  const switchTo = useCallback(async (chain: Exclude<HarvestChain, 'solana'>): Promise<SwitchResult> => {
    try {
      await switchChainAsync({ chainId: EVM_CHAIN_IDS[chain] });
      return { kind: 'ok' };
    } catch (e) {
      if (isUserRejection(e)) return { kind: 'declined' };
      return { kind: 'failed', reason: extractErrorMessage(e, 'no reason given').slice(0, 140) };
    }
  }, [switchChainAsync]);

  /** One claim: `getReward()`, then its own receipt, read the way every direct wait reads it (lib/txErrors). */
  const send = useCallback(async (claim: EvmClaim): Promise<ClaimResult> => {
    const client = claim.chainId === EVM_CHAIN_IDS.base ? baseClient : ethClient;
    if (!client) return { kind: 'unconfirmed', reason: `The ${claim.chain === 'base' ? 'Base' : 'Ethereum'} network could not be reached, so nothing was sent.` };
    let hash: `0x${string}`;
    try {
      hash = await writeContractAsync({ address: claim.pool, abi: LIGHTHOUSE_LADDER_ABI, functionName: 'getReward', chainId: claim.chainId });
    } catch (e) {
      if (isUserRejection(e)) return { kind: 'declined' };
      return { kind: 'unconfirmed', reason: `Your wallet did not send it (${extractErrorMessage(e, 'no reason given').slice(0, 140)}).`, stop: true };
    }
    const outcome = await waitForReceiptOutcome(client, hash);
    if (outcome.kind === 'success') return { kind: 'claimed', tx: outcome.replacement?.hash ?? hash };
    if (outcome.kind === 'reverted') return { kind: 'reverted', reason: 'Refused on chain: nothing was claimed, and only the network fee was spent.', tx: hash };
    if (outcome.kind === 'replaced') {
      return { kind: 'unconfirmed', reason: 'Your wallet replaced this transaction (a cancel, or another call), so this claim did not run.', tx: hash, stop: true };
    }
    return { kind: 'unconfirmed', reason: 'Sent, but its receipt could not be read. Check it on the explorer before claiming again.', tx: hash, stop: true };
  }, [writeContractAsync, ethClient, baseClient]);

  return {
    address: address ?? null,
    /** The EVM chain the wallet is on now, if it is one Harvest uses. */
    chain: chainId !== undefined ? CHAIN_OF[chainId] ?? null : null,
    plan,
    send,
    switchTo,
    refetch: reads.refetch,
  };
}
