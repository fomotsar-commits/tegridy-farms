import { useCallback } from 'react';
import { useReadContracts, useWaitForTransactionReceipt, useWriteContract } from 'wagmi';
import { toast } from 'sonner';
import { isAddress, type Address, type Hex } from 'viem';
import { AIRDROP_DISTRIBUTOR_ABI, AIRDROP_FACTORY_ABI, ERC20_ABI } from '../lib/contracts';
import { AIRDROP_FACTORY_ADDRESS, CHAIN_ID, isDeployed as checkDeployed } from '../lib/constants';
import { surfaceTxError } from '../lib/txErrors';
import type { OnChainCampaign } from '../lib/merkle';

/**
 * One campaign's on-chain state, plus the claim writes.
 *
 * `campaign` is `null` whenever the distributor could not be read. The claim surface
 * turns that into "campaign state unavailable", never into a closed window or an
 * unclaimed allocation — an outage must not read as a verdict.
 */

export interface AirdropCampaignState {
  /** Campaign state, or `null` when the read did not land. */
  campaign: (OnChainCampaign & { token: Address; creator: Address; remaining: bigint }) | null;
  /** Token symbol/decimals, `null` when unread. Decimals matter: a claim amount
   *  rendered with the wrong scale is a wrong number, not a formatting nit. */
  tokenSymbol: string | null;
  tokenDecimals: number | null;
  /**
   * `AirdropFactory.isCampaign(distributor)`. `false` means this address was NOT
   * created by our factory, so none of its parameters were bounds-checked and the
   * bytecode behind it is unverified. `null` when unread — including whenever the
   * factory itself is undeployed, in which case provenance simply cannot be checked.
   */
  fromOurFactory: boolean | null;
  /** `isClaimed(index)` for the queried index. `null` when unread or no index given. */
  claimed: boolean | null;
}

export function useAirdropCampaign(distributor: Address | null, index: number | null) {
  const valid = distributor !== null && isAddress(distributor);
  const factoryDeployed = checkDeployed(AIRDROP_FACTORY_ADDRESS);

  const { data, refetch } = useReadContracts({
    contracts: [
      { address: distributor ?? undefined, abi: AIRDROP_DISTRIBUTOR_ABI, functionName: 'campaignInfo' },
      {
        address: AIRDROP_FACTORY_ADDRESS,
        abi: AIRDROP_FACTORY_ABI,
        functionName: 'isCampaign',
        args: [(distributor ?? '0x0000000000000000000000000000000000000000') as Address],
      },
    ],
    query: { enabled: valid, refetchInterval: 30_000 },
  });

  const info =
    data?.[0]?.status === 'success'
      ? (data[0].result as {
          token: Address;
          merkleRoot: Hex;
          creator: Address;
          expiresAt: bigint;
          claimsOpen: boolean;
          claimFeeWei: bigint;
          feeSink: Address;
          remaining: bigint;
        })
      : null;

  const { data: tokenData } = useReadContracts({
    contracts: [
      { address: info?.token, abi: ERC20_ABI, functionName: 'symbol' },
      { address: info?.token, abi: ERC20_ABI, functionName: 'decimals' },
    ],
    query: { enabled: Boolean(info?.token), refetchInterval: 0 },
  });

  // Built conditionally rather than with a placeholder index, so there is no path
  // where a real `isClaimed(0)` result could be read as the answer for a wallet whose
  // index was never known.
  const claimedCalls =
    valid && distributor !== null && index !== null
      ? ([
          {
            address: distributor,
            abi: AIRDROP_DISTRIBUTOR_ABI,
            functionName: 'isClaimed' as const,
            args: [BigInt(index)] as const,
          },
        ] as const)
      : ([] as const);

  const { data: claimedData, refetch: refetchClaimed } = useReadContracts({
    contracts: claimedCalls,
    query: { enabled: claimedCalls.length > 0, refetchInterval: 30_000 },
  });

  const state: AirdropCampaignState = {
    campaign: info
      ? {
          merkleRoot: info.merkleRoot,
          claimsOpen: info.claimsOpen,
          expiresAt: Number(info.expiresAt),
          claimFeeWei: info.claimFeeWei,
          token: info.token,
          creator: info.creator,
          remaining: info.remaining,
        }
      : null,
    tokenSymbol: tokenData?.[0]?.status === 'success' ? (tokenData[0].result as string) : null,
    tokenDecimals: tokenData?.[1]?.status === 'success' ? Number(tokenData[1].result as number) : null,
    // Unknowable rather than false while the factory address is zero: claiming
    // provenance we did not check is the failure this field exists to prevent.
    fromOurFactory:
      !factoryDeployed ? null : data?.[1]?.status === 'success' ? Boolean(data[1].result) : null,
    claimed:
      index === null ? null : claimedData?.[0]?.status === 'success' ? Boolean(claimedData[0].result) : null,
  };

  const { writeContract, data: hash, isPending, reset } = useWriteContract();
  const { isLoading: isConfirming, isSuccess } = useWaitForTransactionReceipt({ chainId: CHAIN_ID, hash });

  /**
   * Claim. The entry point is chosen by THIS campaign's snapshotted fee, read above —
   * never by the factory's current value, which a landed timelock proposal may have
   * moved after this campaign was created.
   *
   * `account` is the address in the leaf, which is where the tokens go regardless of
   * who sends the transaction.
   */
  const claim = useCallback(
    (args: { index: number; account: Address; amount: bigint; proof: Hex[] }) => {
      if (!valid || !distributor || !state.campaign) return;
      const fee = state.campaign.claimFeeWei;
      const common = {
        address: distributor,
        abi: AIRDROP_DISTRIBUTOR_ABI,
        args: [BigInt(args.index), args.account, args.amount, args.proof] as const,
        chainId: CHAIN_ID,
      };
      writeContract(
        fee === 0n
          ? { ...common, functionName: 'claim' }
          : { ...common, functionName: 'claimWithFee', value: fee },
        { onError: (err) => surfaceTxError(err, toast) },
      );
    },
    [valid, distributor, state.campaign, writeContract],
  );

  return {
    ...state,
    refetch: () => {
      void refetch();
      void refetchClaimed();
    },
    claim,
    isPending,
    isConfirming,
    isSuccess,
    reset,
    txHash: hash,
  };
}
