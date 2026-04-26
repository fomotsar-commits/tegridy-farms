import { useReadContracts, useAccount, useChainId } from 'wagmi';
import { CHAIN_ID } from '../lib/constants';

// Jungle Bay Ape Club NFT contract
const JBAC_ADDRESS = '0xd37264c71e9af940e49795f0d3a8336afaafdda9' as const;
// Jungle Bay Gold Cards
const JBAY_GOLD_ADDRESS = '0x6aa03f42c5366e2664c887eb2e90844ca00b92f3' as const;
const ZERO_ADDR = '0x0000000000000000000000000000000000000000' as const;

const BALANCE_OF_ABI = [
  {
    type: 'function' as const,
    name: 'balanceOf' as const,
    inputs: [{ name: 'owner', type: 'address' as const }],
    outputs: [{ name: '', type: 'uint256' as const }],
    stateMutability: 'view' as const,
  },
] as const;

/**
 * R034 H3 + R043 H-062-01: tri-state NFT boost.
 *
 * `holdsJBAC` / `holdsGoldCard` are `boolean | null`. `null` = unknown
 * (disconnected / wrong-chain / pending read). The boost only credits
 * +0.5x on a confirmed `true`; `null` falls back to baseline so we never
 * promise a boost we can't confirm on-chain.
 *
 * Every read pins `chainId: CHAIN_ID` so wagmi's queryKey carries chain
 * identity and doesn't return cached L2 data after a wallet switch.
 */
export function useNFTBoost() {
  const { address } = useAccount();
  const chainId = useChainId();
  const onMainnet = chainId === CHAIN_ID;
  const userAddr = (address ?? ZERO_ADDR) as `0x${string}`;

  const { data, isLoading } = useReadContracts({
    contracts: [
      { address: JBAC_ADDRESS, abi: BALANCE_OF_ABI, functionName: 'balanceOf', args: [userAddr], chainId: CHAIN_ID },
      { address: JBAY_GOLD_ADDRESS, abi: BALANCE_OF_ABI, functionName: 'balanceOf', args: [userAddr], chainId: CHAIN_ID },
    ],
    query: { enabled: !!address && onMainnet },
  });

  const jbacResult = data?.[0];
  const goldResult = data?.[1];
  const jbacBalance = jbacResult?.status === 'success' ? (jbacResult.result as bigint) : undefined;
  const goldCardBalance = goldResult?.status === 'success' ? (goldResult.result as bigint) : undefined;

  // Tri-state: null when disconnected / wrong-chain / loading / read failed.
  const holdsJBAC: boolean | null =
    !address || !onMainnet || isLoading || jbacBalance === undefined
      ? null
      : jbacBalance > 0n;
  const holdsGoldCard: boolean | null =
    !address || !onMainnet || isLoading || goldCardBalance === undefined
      ? null
      : goldCardBalance > 0n;

  // Boost only credits on confirmed true. null → baseline.
  const boostMultiplier = holdsJBAC === true ? 1.5 : 1;
  const boostLabel = holdsJBAC === true
    ? 'JBAC +0.5x'
    : holdsGoldCard === true
      ? 'Gold Card (no on-chain boost)'
      : null;

  return {
    holdsJBAC,
    holdsGoldCard,
    jbacCount: jbacBalance && jbacBalance > BigInt(Number.MAX_SAFE_INTEGER)
      ? Number.MAX_SAFE_INTEGER
      : Number(jbacBalance ?? 0n),
    goldCardCount: goldCardBalance && goldCardBalance > BigInt(Number.MAX_SAFE_INTEGER)
      ? Number.MAX_SAFE_INTEGER
      : Number(goldCardBalance ?? 0n),
    boostMultiplier,
    boostLabel,
  };
}
