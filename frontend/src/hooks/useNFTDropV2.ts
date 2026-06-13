import { useEffect, useMemo, useRef, useState } from 'react';
import { useAccount, useReadContracts, useWriteContract, useWaitForTransactionReceipt, useChainId } from 'wagmi';
import { toast } from 'sonner';
import { TEGRIDY_DROP_V2_ABI } from '../lib/contracts';
import { CHAIN_ID } from '../lib/constants';
import { formatWei } from '../lib/formatting';
import { surfaceTxError } from '../lib/txErrors';
import type { ContractMetadata } from '../lib/nftMetadata';

/// Resolve an `ar://` URI (or bare Arweave tx ID) into a gateway URL the
/// browser can fetch. `https://arweave.net/...` URIs pass through untouched.
/// Anything else (ipfs://, data:, raw https) passes through as well — the
/// JSON fetch will either succeed or fail gracefully and we fall back to
/// on-chain name/symbol.
// AUDIT FIX 2026-05-26 [H-34]: pipe the contractURI through the shared
// isAllowedUri / resolveSafeUrl gate so attacker-controlled `contractURI`
// values (file://, javascript:, http://192.168...) cannot reach the fetch.
// Returns empty string for disallowed schemes — caller treats empty as
// "metadata fetch failed", falling back to on-chain name/symbol.
import { isAllowedUri as isAllowedUriShared, resolveSafeUrl as resolveSafeUrlShared } from '../lib/imageSafety';

export function resolveContractUri(uri: string): string {
  if (!uri) return '';
  const trimmed = uri.trim();
  if (trimmed.startsWith('ar://')) {
    return `https://arweave.net/${trimmed.slice(5)}`;
  }
  // AUDIT FIX 2026-05-26 [H-34]: scheme allowlist via shared imageSafety helper.
  // Rejects file:/vbscript:/http-LAN/etc. before the upstream fetch.
  if (!isAllowedUriShared(trimmed)) return '';
  return trimmed;
}

/// AUDIT FIX 2026-05-26 [H-32]: pipe image/banner_image through the shared
/// resolveSafeUrl gate so an attacker-controlled creator metadata payload
/// cannot inject tracking pixels (https://attacker.com/?wallet=...) or
/// vbscript:/data:text/html into `<img src>`. Returns undefined for
/// disallowed schemes — caller's UI falls back to a placeholder.
export function resolveAssetUrl(uri: string | undefined): string | undefined {
  if (!uri) return undefined;
  if (uri.startsWith('ar://')) {
    const arweaveUrl = `https://arweave.net/${uri.slice(5)}`;
    return arweaveUrl;
  }
  const safe = resolveSafeUrlShared(uri);
  return safe ?? undefined;
}

export function useNFTDropV2(dropAddress: string) {
  const { address } = useAccount();
  const chainId = useChainId();
  const onMainnet = chainId === CHAIN_ID;
  const contractAddr = dropAddress as `0x${string}`;

  const { writeContract, data: hash, isPending, reset, error: writeError } = useWriteContract();
  // AUDIT FIX FE-LOW-04: pin receipt resolution to CHAIN_ID — see useLPFarming.ts.
  const { isLoading: isConfirming, isSuccess, isError: isTxError } = useWaitForTransactionReceipt({ hash, chainId: CHAIN_ID });

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

  // F265: the single tx-result effect below toasts for every write through this
  // hook (mint AND refund). Track which action fired last so the toast wording
  // matches — otherwise a refund on a cancelled sale toasts "Mint confirmed!".
  const lastActionRef = useRef<'mint' | 'refund'>('mint');

  // AUDIT FIX FE-HIGH-01: `allowedAmount` is the per-wallet cap encoded into the
  // ALLOWLIST merkle leaf (see TegridyDropV2.mint). Pass 0 for PUBLIC / DUTCH where
  // the proof is unused. Default-zero keeps existing PUBLIC-only callers compatible.
  function mint(quantity: number, proof: `0x${string}`[] = [], allowedAmount: bigint = 0n) {
    // AUDIT FIX M-8: refuse on wrong chain so the user doesn't burn ETH
    // minting against a phantom address on Sepolia/Base/Arbitrum.
    if (!onMainnet) { toast.error('Please switch to Ethereum Mainnet'); return; }
    if (isPending || isConfirming || inFlight) {
      toast.error('A mint is already pending');
      return;
    }
    lastActionRef.current = 'mint';
    const totalCost = currentPrice * BigInt(quantity);
    writeContract({
      chainId: CHAIN_ID,
      address: contractAddr,
      abi: TEGRIDY_DROP_V2_ABI,
      functionName: 'mint',
      // FE-HIGH-01: 3-arg signature matches Solidity. allowedAmount is the merkle leaf cap.
      args: [BigInt(quantity), allowedAmount, proof],
      value: totalCost,
    });
  }

  function refund() {
    if (!onMainnet) { toast.error('Please switch to Ethereum Mainnet'); return; }
    if (isPending || isConfirming || inFlight) {
      toast.error('A transaction is already pending');
      return;
    }
    if (!canRefund) {
      toast.error(isCancelled ? 'No refund owed to this wallet' : 'Sale is not cancelled');
      return;
    }
    lastActionRef.current = 'refund';
    writeContract({
      chainId: CHAIN_ID,
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
      // F265: word the toast off the last action so a refund doesn't say "Mint".
      toast.success(lastActionRef.current === 'refund' ? 'Refund confirmed!' : 'Mint confirmed!');
      const t = setTimeout(reset, 0);
      return () => clearTimeout(t);
    }
    if (isTxError || writeError) {
      // F474: a wallet rejection (writeError) becomes a soft "Cancelled" toast
      // instead of "Mint failed"; a bare on-chain revert keeps the action copy.
      if (writeError) {
        surfaceTxError(writeError, toast, { component: 'useNFTDropV2' });
      } else {
        toast.error(lastActionRef.current === 'refund' ? 'Refund failed' : 'Mint failed');
      }
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
