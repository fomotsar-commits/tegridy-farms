import { useCallback, useEffect, useMemo, useState } from 'react';
import { useAccount, usePublicClient, useReadContracts, useSwitchChain, useWriteContract } from 'wagmi';
import { ERC20_ABI, LIGHTHOUSE_LADDER_ABI } from '../lib/contracts';
import { getWalletCapabilities, isBatchSupported, type Eip1193Like } from '../lib/eip5792';
import { EVM_CHAIN_IDS, evmHarvestRooms, planEvmPool, receiptResult, sendCallsTogether, type EvmClaim } from '../lib/harvest/evm';
import type { SendTogether, SwitchResult } from '../lib/harvest/run';
import type { ClaimResult, HarvestChain, HarvestPlan } from '../lib/harvest/types';
import { extractErrorMessage, isUserRejection, waitForReceiptOutcome } from '../lib/txErrors';

type EvmChain = Exclude<HarvestChain, 'solana'>;

const ZERO = '0x0000000000000000000000000000000000000000' as const;
const CHAIN_OF: Record<number, EvmChain> = { 1: 'ethereum', 8453: 'base' };
const ONE_BY_ONE: Record<EvmChain, boolean> = { ethereum: false, base: false };

/**
 * Harvest's Ethereum and Base half: every island pool there, read for the connected
 * account, the send for one claim, and one chain's claims on one prompt where the
 * wallet says it takes `wallet_sendCalls` there.
 *
 * Both pool kinds answer `earned(address)`, `getReward()`, `stakingToken()` and
 * `rewardsToken()` with the same selectors, so one ABI serves both; only a lock ladder
 * has `rewardSurplus()`, and only a ladder is asked for it.
 */
export function useEvmHarvest() {
  const { address, chainId, connector } = useAccount();
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
    query: { enabled: Boolean(address) },
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

  // Asked only when a chain has two claims to put together, and kept with the wallet it
  // was asked of. No `wallet_getCapabilities` is the common case: one prompt per claim.
  const capsFor = address && connector && plan && hasPair(plan.claims) ? `${connector.uid}:${address}` : null;
  const [caps, setCaps] = useState<{ of: string; on: Record<EvmChain, boolean> } | null>(null);
  useEffect(() => {
    if (!capsFor || !address || !connector) return;
    let live = true;
    void (async () => {
      let on = ONE_BY_ONE;
      try {
        const provider = (await connector.getProvider()) as Eip1193Like;
        const c = await getWalletCapabilities(provider, address);
        on = { ethereum: isBatchSupported(c, '0x1'), base: isBatchSupported(c, '0x2105') };
      } catch {
        /* one prompt per claim */
      }
      if (live) setCaps({ of: capsFor, on });
    })();
    return () => {
      live = false;
    };
  }, [capsFor, address, connector]);
  const batchable = caps && caps.of === capsFor ? caps.on : ONE_BY_ONE;

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
    return receiptResult(await waitForReceiptOutcome(client, hash), hash);
  }, [writeContractAsync, ethClient, baseClient]);

  /** One chain's claims on one prompt, or null: this wallet did not say it takes a batch there. */
  const together = useCallback((chain: EvmChain): SendTogether<EvmClaim> | null => {
    const client = chain === 'base' ? baseClient : ethClient;
    if (!batchable[chain] || !address || !connector || !client) return null;
    return async (claims, settle) => {
      const provider = (await connector.getProvider()) as Eip1193Like;
      return sendCallsTogether({ provider, from: address, client }, EVM_CHAIN_IDS[chain])(claims, settle);
    };
  }, [batchable, address, connector, ethClient, baseClient]);

  return {
    address: address ?? null,
    /** The EVM chain the wallet is on now, if it is one Harvest uses. */
    chain: chainId !== undefined ? CHAIN_OF[chainId] ?? null : null,
    plan,
    send,
    /** Per chain: its claims go on one prompt. */
    batchable,
    together,
    switchTo,
    refetch: reads.refetch,
  };
}

/** Some chain has two or more claims, so a batch could save a prompt. */
function hasPair(claims: readonly EvmClaim[]): boolean {
  return claims.filter((c) => c.chain === 'ethereum').length > 1 || claims.filter((c) => c.chain === 'base').length > 1;
}
