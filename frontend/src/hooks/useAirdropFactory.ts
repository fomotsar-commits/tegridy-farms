import { useCallback } from 'react';
import { useAccount, useReadContracts, useWaitForTransactionReceipt, useWriteContract } from 'wagmi';
import { toast } from 'sonner';
import type { Address, Hex } from 'viem';
import { AIRDROP_FACTORY_ABI, ERC20_ABI } from '../lib/contracts';
import { AIRDROP_FACTORY_ADDRESS, CHAIN_ID, isDeployed as checkDeployed } from '../lib/constants';
import { surfaceTxError } from '../lib/txErrors';

/**
 * AirdropFactory reads + the campaign-creation write.
 *
 * Every returned figure is `null` when its read did not land. There are no zero
 * defaults here on purpose: `claimFeeWei = 0` is a real and meaningful state (the fee
 * ships disarmed), so defaulting a failed read to 0 would print "free to claim" during
 * an RPC outage. `null` means "we do not know", and the surface says so.
 */

export interface AirdropFactoryState {
  /** Factory address is non-zero, i.e. a deploy ceremony has run. */
  deployed: boolean;
  /** The address gated on, exposed so a surface can print what it checked. */
  address: Address;
  /** Per-claim ETH fee a campaign created NOW would snapshot. `null` = unread. */
  claimFeeWei: bigint | null;
  /** Where that fee goes. `null` = unread; zero address = no sink wired. */
  feeSink: Address | null;
  /** Campaigns created by this factory. `null` = unread. */
  campaignCount: number | null;
  /** New-campaign creation halted by the owner or guardian. `null` = unread. */
  paused: boolean | null;
  /** Claim-window bounds the factory enforces, in seconds. `null` = unread. */
  minWindowSeconds: number | null;
  maxWindowSeconds: number | null;
  /** True when at least one of the reads above failed — the surface must disclose it. */
  readIncomplete: boolean;
}

export function useAirdropFactory() {
  const { address: account } = useAccount();
  const deployed = checkDeployed(AIRDROP_FACTORY_ADDRESS);

  const { data, refetch } = useReadContracts({
    contracts: [
      { address: AIRDROP_FACTORY_ADDRESS, abi: AIRDROP_FACTORY_ABI, functionName: 'currentCampaignFee', chainId: CHAIN_ID },
      { address: AIRDROP_FACTORY_ADDRESS, abi: AIRDROP_FACTORY_ABI, functionName: 'campaignCount', chainId: CHAIN_ID },
      { address: AIRDROP_FACTORY_ADDRESS, abi: AIRDROP_FACTORY_ABI, functionName: 'paused', chainId: CHAIN_ID },
      { address: AIRDROP_FACTORY_ADDRESS, abi: AIRDROP_FACTORY_ABI, functionName: 'MIN_CLAIM_WINDOW', chainId: CHAIN_ID },
      { address: AIRDROP_FACTORY_ADDRESS, abi: AIRDROP_FACTORY_ABI, functionName: 'MAX_CLAIM_WINDOW', chainId: CHAIN_ID },
    ],
    query: { enabled: deployed, refetchInterval: 60_000 },
  });

  const feeTuple = data?.[0]?.status === 'success' ? (data[0].result as readonly [bigint, Address]) : null;
  const state: AirdropFactoryState = {
    deployed,
    address: AIRDROP_FACTORY_ADDRESS,
    claimFeeWei: feeTuple ? feeTuple[0] : null,
    feeSink: feeTuple ? feeTuple[1] : null,
    campaignCount: data?.[1]?.status === 'success' ? Number(data[1].result as bigint) : null,
    paused: data?.[2]?.status === 'success' ? Boolean(data[2].result) : null,
    minWindowSeconds: data?.[3]?.status === 'success' ? Number(data[3].result as bigint) : null,
    maxWindowSeconds: data?.[4]?.status === 'success' ? Number(data[4].result as bigint) : null,
    readIncomplete: deployed ? !data || data.some((r) => r.status !== 'success') : false,
  };

  const { writeContract, data: hash, isPending, reset } = useWriteContract();
  const { isLoading: isConfirming, isSuccess } = useWaitForTransactionReceipt({ chainId: CHAIN_ID, hash });

  /** Approve the factory to pull the funding amount. Required before `createCampaign`. */
  const approve = useCallback(
    (token: Address, amount: bigint) => {
      if (!deployed) return;
      writeContract(
        { address: token, abi: ERC20_ABI, functionName: 'approve', args: [AIRDROP_FACTORY_ADDRESS, amount], chainId: CHAIN_ID },
        { onError: (err) => surfaceTxError(err, toast) },
      );
    },
    [deployed, writeContract],
  );

  /**
   * @param fundingAmount Base units pulled from the caller into the fresh distributor.
   *        The caller is responsible for this equalling the manifest total — the factory
   *        does not know the tree, so an under-funded campaign is accepted on-chain and
   *        only fails when a late claimant finds nothing left.
   * @param claimWindowSeconds Bounded by the factory's MIN/MAX; both are read above so
   *        the form can reject out-of-range input before a wallet prompt.
   */
  const createCampaign = useCallback(
    (token: Address, merkleRoot: Hex, fundingAmount: bigint, claimWindowSeconds: number) => {
      if (!deployed) return;
      writeContract(
        {
          address: AIRDROP_FACTORY_ADDRESS,
          abi: AIRDROP_FACTORY_ABI,
          functionName: 'createCampaign',
          args: [token, merkleRoot, fundingAmount, BigInt(claimWindowSeconds)],
          chainId: CHAIN_ID,
        },
        { onError: (err) => surfaceTxError(err, toast) },
      );
    },
    [deployed, writeContract],
  );

  return {
    ...state,
    account: account ?? null,
    refetch,
    approve,
    createCampaign,
    isPending,
    isConfirming,
    isSuccess,
    reset,
    txHash: hash,
  };
}
