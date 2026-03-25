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

  // Boost: Gold Card = 2x, JBAC = 1.5x, neither = 1x
  const boostMultiplier = holdsGoldCard ? 2 : holdsJBAC ? 1.5 : 1;
  const boostLabel = holdsGoldCard ? 'Gold Card 2x' : holdsJBAC ? 'JBAC 1.5x' : null;

  return {
    holdsJBAC,
    holdsGoldCard,
    jbacCount: Number(jbacBalance ?? 0n),
    goldCardCount: Number(goldCardBalance ?? 0n),
    boostMultiplier,
    boostLabel,
  };
}
