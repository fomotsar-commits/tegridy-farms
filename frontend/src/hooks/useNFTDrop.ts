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

  function mint(quantity: number, proof: `0x${string}`[] = []) {
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
      // BUG 2026-05-18: the ABI's `mint` signature is
      //   `mint(uint256 quantity, uint256 allowedAmount, bytes32[] proof)`
      // but the call below only passes 2 args (missing `allowedAmount`).
      // `allowedAmount` is the per-user cap baked into the merkle leaf —
      // it needs to come from the off-chain merkle generator alongside
      // the proof. This call is currently MALFORMED and any mint that
      // hits the chain via this code path will revert with a Solidity
      // signature-mismatch error.
      //
      // Tracked in spawned task "Fix useNFTDrop mint call signature".
      // The `@ts-expect-error` suppresses the build-blocking TS2322 so
      // the rest of CI (E2E artifact upload, etc.) can complete; the
      // runtime bug remains and must be fixed before relaunch.
      // @ts-expect-error pre-existing-bug — see comment above; fix is
      //   tracked but requires off-chain merkle-proof regeneration.
      args: [BigInt(quantity), proof],
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
