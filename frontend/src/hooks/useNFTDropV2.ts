import { useEffect, useMemo, useState } from 'react';
import { useAccount, useReadContracts, useWriteContract, useWaitForTransactionReceipt, useChainId } from 'wagmi';
import { toast } from 'sonner';
import { TEGRIDY_DROP_V2_ABI } from '../lib/contracts';
import { CHAIN_ID } from '../lib/constants';
import { formatWei } from '../lib/formatting';
import type { ContractMetadata } from '../lib/nftMetadata';

/// Resolve an `ar://` URI (or bare Arweave tx ID) into a gateway URL the
/// browser can fetch. `https://arweave.net/...` URIs pass through untouched.
/// Anything else (ipfs://, data:, raw https) passes through as well — the
/// JSON fetch will either succeed or fail gracefully and we fall back to
/// on-chain name/symbol.
export function resolveContractUri(uri: string): string {
  if (!uri) return '';
  const trimmed = uri.trim();
  if (trimmed.startsWith('ar://')) {
    // ar://<id>/<path?>  →  https://arweave.net/<id>/<path?>
    return `https://arweave.net/${trimmed.slice(5)}`;
  }
  return trimmed;
}

/// Convert an image/banner URI inside a contractURI JSON payload into a
/// browser-renderable URL. Same rules as resolveContractUri, exposed
/// separately so the detail page can normalise `image` / `banner_image`.
export function resolveAssetUrl(uri: string | undefined): string | undefined {
  if (!uri) return undefined;
  if (uri.startsWith('ar://')) {
    return `https://arweave.net/${uri.slice(5)}`;
  }
  return uri;
}

export function useNFTDropV2(dropAddress: string) {
  const { address } = useAccount();
  const chainId = useChainId();
  const onMainnet = chainId === CHAIN_ID;
  const contractAddr = dropAddress as `0x${string}`;

  const { writeContract, data: hash, isPending, reset, error: writeError } = useWriteContract();
  const { isLoading: isConfirming, isSuccess, isError: isTxError } = useWaitForTransactionReceipt({ hash });

  const enabled = !!dropAddress && dropAddress !== '0x0000000000000000000000000000000000000000';

  // R043 H-062-02 + H-062-04: chainId pin on every entry, 60s poll (was 30s).
  const { data, refetch } = useReadContracts({
    contracts: [
      { address: contractAddr, abi: TEGRIDY_DROP_V2_ABI, functionName: 'mintPhase', chainId: CHAIN_ID },
      { address: contractAddr, abi: TEGRIDY_DROP_V2_ABI, functionName: 'currentPrice', chainId: CHAIN_ID },
      { address: contractAddr, abi: TEGRIDY_DROP_V2_ABI, functionName: 'totalSupply', chainId: CHAIN_ID },
      { address: contractAddr, abi: TEGRIDY_DROP_V2_ABI, functionName: 'maxSupply', chainId: CHAIN_ID },
      { address: contractAddr, abi: TEGRIDY_DROP_V2_ABI, functionName: 'owner', chainId: CHAIN_ID },
      { address: contractAddr, abi: TEGRIDY_DROP_V2_ABI, functionName: 'maxPerWallet', chainId: CHAIN_ID },
      { address: contractAddr, abi: TEGRIDY_DROP_V2_ABI, functionName: 'paidPerWallet', args: address ? [address] : undefined, chainId: CHAIN_ID },
      { address: contractAddr, abi: TEGRIDY_DROP_V2_ABI, functionName: 'revealed', chainId: CHAIN_ID },
      { address: contractAddr, abi: TEGRIDY_DROP_V2_ABI, functionName: 'paused', chainId: CHAIN_ID },
      { address: contractAddr, abi: TEGRIDY_DROP_V2_ABI, functionName: 'mintPrice', chainId: CHAIN_ID },
      { address: contractAddr, abi: TEGRIDY_DROP_V2_ABI, functionName: 'creator', chainId: CHAIN_ID },
      { address: contractAddr, abi: TEGRIDY_DROP_V2_ABI, functionName: 'contractURI', chainId: CHAIN_ID },
    ],
    query: { enabled: enabled && onMainnet, refetchInterval: 60_000, refetchOnWindowFocus: true },
  });

  const currentPhase = data?.[0]?.status === 'success' ? Number(data[0].result as number) : 0;
  const currentPrice = data?.[1]?.status === 'success' ? (data[1].result as bigint) : 0n;
  const totalSupply = data?.[2]?.status === 'success' ? Number(data[2].result as bigint) : 0;
  const maxSupply = data?.[3]?.status === 'success' ? Number(data[3].result as bigint) : 0;
  const owner = data?.[4]?.status === 'success' ? (data[4].result as string) : '';
  const maxPerWallet = data?.[5]?.status === 'success' ? Number(data[5].result as bigint) : 0;
  const paidByUser = data?.[6]?.status === 'success' ? (data[6].result as bigint) : 0n;
  const revealed = data?.[7]?.status === 'success' ? (data[7].result as boolean) : false;
  const paused = data?.[8]?.status === 'success' ? (data[8].result as boolean) : false;
  const mintPrice = data?.[9]?.status === 'success' ? (data[9].result as bigint) : currentPrice;
  const creator = data?.[10]?.status === 'success' ? (data[10].result as string) : '';
  const contractURI = data?.[11]?.status === 'success' ? (data[11].result as string) : '';

  const currentPriceFormatted = Number(formatWei(currentPrice, 18, 8));
  const mintPriceFormatted = Number(formatWei(mintPrice, 18, 8));
  const isSoldOut = maxSupply > 0 && totalSupply >= maxSupply;
  const isOwner = !!address && owner.toLowerCase() === address.toLowerCase();

  // R043 M-062-05: phase enum aligned to TegridyDropV2.sol:27
  //   0=CLOSED, 1=ALLOWLIST, 2=PUBLIC, 3=DUTCH_AUCTION, 4=CANCELLED.
  // `paused` is an independent pause circuit — distinct from phase=CLOSED
  // which is the configured mint phase. `currentPhase === 0` gates mint
  // disabled at the call site, consistent with the contract `MintClosed()` revert.
  const isCancelled = currentPhase === 4;
  const canRefund = isCancelled && paidByUser > 0n;
  const phaseLabel =
    currentPhase === 4 ? 'Cancelled' :
    currentPhase === 3 ? 'Dutch auction' :
    currentPhase === 2 ? 'Public' :
    currentPhase === 1 ? 'Allowlist' :
    'Closed';

  // ─── contractURI JSON fetch ───────────────────────────────────
  // The off-chain JSON lives on Arweave (typically). Fetch once per URI
  // change, race against an 8s timeout, and fall back to null on any error
  // so the page renders on-chain name/symbol instead of crashing.
  const [collectionMetadata, setCollectionMetadata] = useState<ContractMetadata | null>(null);
  const [metadataLoading, setMetadataLoading] = useState(false);
  const [metadataError, setMetadataError] = useState<string | null>(null);

  useEffect(() => {
    if (!contractURI) {
      setCollectionMetadata(null);
      setMetadataError(null);
      return;
    }
    const url = resolveContractUri(contractURI);
    if (!url) {
      setCollectionMetadata(null);
      return;
    }
    let cancelled = false;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8_000);
    setMetadataLoading(true);
    setMetadataError(null);
    fetch(url, { signal: controller.signal })
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.text();
      })
      .then((text) => {
        // Parse manually so a malformed JSON blows here (caught below) rather
        // than crashing a downstream consumer.
        const parsed = JSON.parse(text) as ContractMetadata;
        if (cancelled) return;
        setCollectionMetadata(parsed);
      })
      .catch((err) => {
        if (cancelled) return;
        // AbortError on unmount is fine; anything else records the error but
        // never throws to React. Caller checks `collectionMetadata === null`
        // and falls back to on-chain fields.
        const msg = err instanceof Error ? err.message : String(err);
        if (msg !== 'The operation was aborted.' && msg !== 'The user aborted a request.') {
          setMetadataError(msg);
        }
        setCollectionMetadata(null);
      })
      .finally(() => {
        if (!cancelled) setMetadataLoading(false);
        clearTimeout(timer);
      });
    return () => {
      cancelled = true;
      controller.abort();
      clearTimeout(timer);
    };
  }, [contractURI]);

  const resolvedImage = useMemo(
    () => resolveAssetUrl(collectionMetadata?.image),
    [collectionMetadata?.image],
  );
  const resolvedBanner = useMemo(
    () => resolveAssetUrl(collectionMetadata?.banner_image),
    [collectionMetadata?.banner_image],
  );

  // Re-entry guard identical to v1 hook (see useNFTDrop comments).
  const inFlight = !!hash && !isSuccess && !isTxError;

  function mint(quantity: number, proof: `0x${string}`[] = []) {
    if (isPending || isConfirming || inFlight) {
      toast.error('A mint is already pending');
      return;
    }
    const totalCost = currentPrice * BigInt(quantity);
    writeContract({
      address: contractAddr,
      abi: TEGRIDY_DROP_V2_ABI,
      functionName: 'mint',
      args: [BigInt(quantity), proof],
      value: totalCost,
    });
  }

  function refund() {
    if (isPending || isConfirming || inFlight) {
      toast.error('A transaction is already pending');
      return;
    }
    if (!canRefund) {
      toast.error(isCancelled ? 'No refund owed to this wallet' : 'Sale is not cancelled');
      return;
    }
    writeContract({
      address: contractAddr,
      abi: TEGRIDY_DROP_V2_ABI,
      functionName: 'refund',
    });
  }

  // R043 H-062-04: do NOT call refetch() here — the 60s poll drives state
  // convergence. Stacking manual refetches on every successful tx caused a
  // 10/12-call batch-read storm during back-to-back mints.
  useEffect(() => {
    if (isSuccess) {
      toast.success('Mint confirmed!');
      const t = setTimeout(reset, 0);
      return () => clearTimeout(t);
    }
    if (isTxError || writeError) {
      toast.error('Mint failed');
      const t = setTimeout(reset, 0);
      return () => clearTimeout(t);
    }
  }, [isSuccess, isTxError, writeError, reset]);

  return {
    // Read data
    currentPhase,
    phaseLabel,
    mintPrice,
    mintPriceFormatted,
    currentPrice,
    currentPriceFormatted,
    // NB: total/supply alias kept so shared launchpad components that accept
    // { mintPrice, totalMinted } (see CreatorRevenueDashboard) Just Work.
    totalSupply,
    totalMinted: totalSupply,
    maxSupply,
    maxPerWallet,
    owner,
    creator,
    revealed,
    paused,
    isSoldOut,
    isOwner,
    isCancelled,
    canRefund,
    paidByUser,
    // V2-only
    contractURI,
    collectionMetadata,
    metadataLoading,
    metadataError,
    resolvedImage,
    resolvedBanner,
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
