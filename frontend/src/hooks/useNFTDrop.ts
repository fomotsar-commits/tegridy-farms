import { useEffect } from 'react';
import { useAccount, useReadContracts, useWriteContract, useWaitForTransactionReceipt } from 'wagmi';
import { formatEther } from 'viem';
import { toast } from 'sonner';
import { TEGRIDY_DROP_ABI } from '../lib/contracts';

export function useNFTDrop(dropAddress: string) {
  const { address } = useAccount();
  const contractAddr = dropAddress as `0x${string}`;

  const { writeContract, data: hash, isPending, reset, error: writeError } = useWriteContract();
  const { isLoading: isConfirming, isSuccess, isError: isTxError } = useWaitForTransactionReceipt({ hash });

  const enabled = !!dropAddress && dropAddress !== '0x0000000000000000000000000000000000000000';

  const { data, refetch } = useReadContracts({
    contracts: [
      { address: contractAddr, abi: TEGRIDY_DROP_ABI, functionName: 'currentPhase' },
      { address: contractAddr, abi: TEGRIDY_DROP_ABI, functionName: 'currentPrice' },
      { address: contractAddr, abi: TEGRIDY_DROP_ABI, functionName: 'totalMinted' },
      { address: contractAddr, abi: TEGRIDY_DROP_ABI, functionName: 'maxSupply' },
      { address: contractAddr, abi: TEGRIDY_DROP_ABI, functionName: 'owner' },
      { address: contractAddr, abi: TEGRIDY_DROP_ABI, functionName: 'maxPerWallet' },
    ],
    query: { enabled, refetchInterval: 30_000, refetchOnWindowFocus: true },
  });

  const currentPhase = data?.[0]?.status === 'success' ? Number(data[0].result as number) : 0;
  const mintPrice = data?.[1]?.status === 'success' ? (data[1].result as bigint) : 0n;
  const totalMinted = data?.[2]?.status === 'success' ? Number(data[2].result as bigint) : 0;
  const maxSupply = data?.[3]?.status === 'success' ? Number(data[3].result as bigint) : 0;
  const owner = data?.[4]?.status === 'success' ? (data[4].result as string) : '';
  const maxPerWallet = data?.[5]?.status === 'success' ? Number(data[5].result as bigint) : 0;

  const mintPriceFormatted = Number(formatEther(mintPrice));
  const isSoldOut = maxSupply > 0 && totalMinted >= maxSupply;
  const isOwner = !!address && owner.toLowerCase() === address.toLowerCase();

  // Phase labels: 0 = Paused, 1 = Allowlist, 2 = Public
  const phaseLabel = currentPhase === 2 ? 'Public' : currentPhase === 1 ? 'Allowlist' : 'Paused';

  function mint(quantity: number, proof: `0x${string}`[] = []) {
    const totalCost = mintPrice * BigInt(quantity);
    writeContract({
      address: contractAddr,
      abi: TEGRIDY_DROP_ABI,
      functionName: 'mint',
      args: [BigInt(quantity), proof],
      value: totalCost,
    });
  }

  // Toast feedback — defer reset to next tick so isSuccess is readable by consumers this render
  useEffect(() => {
    if (isSuccess) {
      toast.success('Mint confirmed!');
      refetch();
      const t = setTimeout(reset, 0);
      return () => clearTimeout(t);
    }
    if (isTxError || writeError) {
      toast.error('Mint failed');
      const t = setTimeout(reset, 0);
      return () => clearTimeout(t);
    }
  }, [isSuccess, isTxError, writeError, refetch, reset]);

  return {
    // Read data
    currentPhase,
    phaseLabel,
    mintPrice,
    mintPriceFormatted,
    totalMinted,
    maxSupply,
    maxPerWallet,
    owner,
    isSoldOut,
    isOwner,
    // Actions
    mint,
    refetch,
    // TX state
    hash,
    isPending,
    isConfirming,
    isSuccess,
    reset,
  };
}
