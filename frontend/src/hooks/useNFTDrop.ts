import { useEffect } from 'react';
import { useAccount, useReadContracts, useWriteContract, useWaitForTransactionReceipt, useChainId } from 'wagmi';
import { toast } from 'sonner';
import { TEGRIDY_DROP_V2_ABI } from '../lib/contracts';
import { CHAIN_ID } from '../lib/constants';
import { formatWei } from '../lib/formatting';

export function useNFTDrop(dropAddress: string) {
  const { address } = useAccount();
  const chainId = useChainId();
  const contractAddr = dropAddress as `0x${string}`;

  const { writeContract, data: hash, isPending, reset, error: writeError } = useWriteContract();
  const { isLoading: isConfirming, isSuccess, isError: isTxError } = useWaitForTransactionReceipt({ hash });

  const enabled = !!dropAddress && dropAddress !== '0x0000000000000000000000000000000000000000';

  const { data, refetch } = useReadContracts({
    contracts: [
      { address: contractAddr, abi: TEGRIDY_DROP_V2_ABI, functionName: 'mintPhase' },
      { address: contractAddr, abi: TEGRIDY_DROP_V2_ABI, functionName: 'currentPrice' },
      { address: contractAddr, abi: TEGRIDY_DROP_V2_ABI, functionName: 'totalSupply' },
      { address: contractAddr, abi: TEGRIDY_DROP_V2_ABI, functionName: 'maxSupply' },
      { address: contractAddr, abi: TEGRIDY_DROP_V2_ABI, functionName: 'owner' },
      { address: contractAddr, abi: TEGRIDY_DROP_V2_ABI, functionName: 'maxPerWallet' },
      { address: contractAddr, abi: TEGRIDY_DROP_V2_ABI, functionName: 'paidPerWallet', args: address ? [address] : undefined },
    ],
    query: { enabled, refetchInterval: 30_000, refetchOnWindowFocus: true },
  });

  const currentPhase = data?.[0]?.status === 'success' ? Number(data[0].result as number) : 0;
  const mintPrice = data?.[1]?.status === 'success' ? (data[1].result as bigint) : 0n;
  const totalMinted = data?.[2]?.status === 'success' ? Number(data[2].result as bigint) : 0;
  const maxSupply = data?.[3]?.status === 'success' ? Number(data[3].result as bigint) : 0;
  const owner = data?.[4]?.status === 'success' ? (data[4].result as string) : '';
  const maxPerWallet = data?.[5]?.status === 'success' ? Number(data[5].result as bigint) : 0;
  const paidByUser = data?.[6]?.status === 'success' ? (data[6].result as bigint) : 0n;

  const mintPriceFormatted = Number(formatWei(mintPrice, 18, 8));
  const isSoldOut = maxSupply > 0 && totalMinted >= maxSupply;
  const isOwner = !!address && owner.toLowerCase() === address.toLowerCase();

  // Phase labels: 0 = Paused, 1 = Allowlist, 2 = Public, 3 = Dutch auction, 4 = Closed, 5 = Cancelled.
  // Keep enum-numeric matches aligned with TegridyDrop.MintPhase; anything >= 5 surfaces as Cancelled.
  const isCancelled = currentPhase === 5;
  const canRefund = isCancelled && paidByUser > 0n;
  const phaseLabel =
    currentPhase === 5 ? 'Cancelled' :
    currentPhase === 4 ? 'Closed' :
    currentPhase === 3 ? 'Dutch auction' :
    currentPhase === 2 ? 'Public' :
    currentPhase === 1 ? 'Allowlist' :
    'Paused';

  // Audit H-F8: wagmi's isPending is only true once wallet signs — between
  // clicking mint and MetaMask popping, it's false, so a second click races
  // in and both txns land in the mempool. Defence: reject re-entry while a
  // tx hash is already in flight AND no terminal receipt has settled.
  const inFlight = !!hash && !isSuccess && !isTxError;

  // FE-HIGH-01: mint() takes 3 args to match the Solidity dispatcher:
  //   mint(uint256 quantity, uint256 allowedAmount, bytes32[] proof)
  // For PUBLIC/DUTCH phases the contract ignores allowedAmount and proof; default both
  // to 0 / []. ALLOWLIST callers must pass the leaf-encoded per-wallet cap that was
  // hashed into the merkle root, otherwise verifyProof reverts.
  function mint(quantity: number, allowedAmount: number | bigint = 0n, proof: `0x${string}`[] = []) {
    // AUDIT FIX M-8: refuse on wrong chain so the user doesn't burn ETH
    // minting against a phantom address on Sepolia/Base/Arbitrum.
    if (chainId !== CHAIN_ID) { toast.error('Please switch to Ethereum Mainnet'); return; }
    if (isPending || isConfirming || inFlight) {
      toast.error('A mint is already pending');
      return;
    }
    const totalCost = mintPrice * BigInt(quantity);
    writeContract({
      chainId: CHAIN_ID,
      address: contractAddr,
      abi: TEGRIDY_DROP_V2_ABI,
      functionName: 'mint',
      args: [BigInt(quantity), BigInt(allowedAmount), proof],
      value: totalCost,
    });
  }

  function refund() {
    if (chainId !== CHAIN_ID) { toast.error('Please switch to Ethereum Mainnet'); return; }
    if (isPending || isConfirming || inFlight) {
      toast.error('A transaction is already pending');
      return;
    }
    if (!canRefund) {
      toast.error(isCancelled ? 'No refund owed to this wallet' : 'Sale is not cancelled');
      return;
    }
    writeContract({
      chainId: CHAIN_ID,
      address: contractAddr,
      abi: TEGRIDY_DROP_V2_ABI,
      functionName: 'refund',
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
    isCancelled,
    canRefund,
    paidByUser,
    // Actions
    mint,
    refund,
    refetch,
    // TX state
    hash,
    isPending,
    isConfirming,
    isSuccess,
    reset,
  };
}
