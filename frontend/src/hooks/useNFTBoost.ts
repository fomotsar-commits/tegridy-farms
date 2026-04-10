import { useReadContracts, useAccount } from 'wagmi';

// Jungle Bay Ape Club NFT contract
const JBAC_ADDRESS = '0xd37264c71e9af940e49795f0d3a8336afaafdda9' as const;
// Jungle Bay Gold Cards
const JBAY_GOLD_ADDRESS = '0x6aa03f42c5366e2664c887eb2e90844ca00b92f3' as const;

const BALANCE_OF_ABI = [
  {
    type: 'function' as const,
    name: 'balanceOf' as const,
    inputs: [{ name: 'owner', type: 'address' as const }],
    outputs: [{ name: '', type: 'uint256' as const }],
    stateMutability: 'view' as const,
  },
] as const;

export function useNFTBoost() {
  const { address } = useAccount();

  const { data } = useReadContracts({
    contracts: [
      { address: JBAC_ADDRESS, abi: BALANCE_OF_ABI, functionName: 'balanceOf', args: [address!] },
      { address: JBAY_GOLD_ADDRESS, abi: BALANCE_OF_ABI, functionName: 'balanceOf', args: [address!] },
    ],
    query: { enabled: !!address },
  });

  const jbacBalance = data?.[0]?.result as bigint | undefined;
  const goldCardBalance = data?.[1]?.result as bigint | undefined;

  const holdsJBAC = (jbacBalance ?? 0n) > 0n;
  const holdsGoldCard = (goldCardBalance ?? 0n) > 0n;

  // On-chain boost: only JBAC NFT gives +0.5x (1.5x total).
  // Gold Card has no on-chain staking boost — it is a cosmetic/access pass only.
  const boostMultiplier = holdsJBAC ? 1.5 : 1;
  const boostLabel = holdsJBAC ? 'JBAC +0.5x' : holdsGoldCard ? 'Gold Card (no on-chain boost)' : null;

  return {
    holdsJBAC,
    holdsGoldCard,
    jbacCount: (jbacBalance ?? 0n) > BigInt(Number.MAX_SAFE_INTEGER) ? Number.MAX_SAFE_INTEGER : Number(jbacBalance ?? 0n),
    goldCardCount: (goldCardBalance ?? 0n) > BigInt(Number.MAX_SAFE_INTEGER) ? Number.MAX_SAFE_INTEGER : Number(goldCardBalance ?? 0n),
    boostMultiplier,
    boostLabel,
  };
}
