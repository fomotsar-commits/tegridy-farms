import { useEffect, useMemo, useRef, useState } from 'react';
import { useAccount, useChainId, useReadContracts } from 'wagmi';
import { formatUnits } from 'viem';
import { ERC20_ABI } from '../lib/contracts';
import { CHAIN_ID } from '../lib/constants';
import { DEFAULT_TOKENS, NATIVE_ETH_ADDRESS, findToken } from '../lib/tokenList';
import {
  deriveHoldingExposure,
  positionShareOfTotal,
  type HoldingExposure,
  type ScanTokenFn,
  type WalletHolding,
} from '../lib/detection/walletExposure';

// useWalletExposure — lists a connected wallet's ERC-20 positions and scores each
// for concentration / bundle / rug exposure via the shared detection core.
//
// DATA (real, self-contained, no proxy needed for the listing):
//   Balances + total supply are read on-chain via a wagmi multicall over the
//   curated token set (plus any addresses the caller pastes). Symbol/decimals
//   come from the curated list when known, else from the same multicall. This is
//   exact wallet data — no indexer, no API key, no fabricated numbers.
//
// SCORING (honest-gated):
//   The detection core needs each token's HOLDER DISTRIBUTION. A `scanToken`
//   adapter is the injection seam (see ScanTokenFn), and WalletExposurePage
//   supplies one: the live `scanTokenLive` path, which reads a token's TOP-N
//   holders through the deployed erc20scan route. The seam stays optional — when
//   no scanner is passed, or when a scan comes back empty (route unconfigured,
//   rate-limited, token not covered), that holding self-gates to `unmeasured`
//   instead of showing a fabricated band. The position size is exact either way.
//   A scan that fails is NOT retried; see the scan effect below.
//
// SELF-GATING: no wallet ⇒ empty; wrong network ⇒ flagged + empty; a wallet with
// no tracked balances ⇒ empty holdings (the page shows an honest empty state, not
// a fake "you're safe").

const ZERO = '0x0000000000000000000000000000000000000000' as const;
const ETH_ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/;

export interface UseWalletExposureOptions {
  /** Extra token addresses to check beyond the curated list (e.g. a pasted contract). */
  extraTokens?: string[];
  /**
   * Token-distribution scanner. When supplied, each held token is scanned and
   * scored via the detection core — WalletExposurePage injects the live
   * `scanTokenLive` adapter here. Optional: when omitted, or when a scan resolves
   * to `null`, those holdings read as `unmeasured` — never as a passing band.
   */
  scanToken?: ScanTokenFn;
  /** Poll interval for balance refreshes (ms). Default 30s. */
  refetchInterval?: number;
}

export interface WalletExposureState {
  isConnected: boolean;
  isWrongNetwork: boolean;
  isLoading: boolean;
  /** True when the balance multicall itself errored (not merely empty). */
  error: boolean;
  address?: `0x${string}`;
  holdings: WalletHolding[];
  /**
   * Tokens whose `balanceOf` could not be READ this pass — distinct from tokens you
   * hold none of, and distinct from `unmeasured` (a position we DO show whose holder
   * distribution could not be read). These have no size to show, so they are absent
   * from `holdings`; the page must surface the count, because an omitted position
   * silently understates the concentration it reports.
   */
  unreadableBalances: `0x${string}`[];
  /** Exposure per holding, keyed by lowercased token address. */
  exposures: Record<string, HoldingExposure>;
  /** True while any per-token scan is still resolving. */
  scanning: boolean;
}

interface TokenTarget {
  address: `0x${string}`;
  curated: boolean;
}

/** Curated ERC-20 universe (native ETH excluded — it has no holder distribution). */
function curatedErc20Targets(): TokenTarget[] {
  return DEFAULT_TOKENS.filter(
    (t) => !t.isNative && t.address.toLowerCase() !== NATIVE_ETH_ADDRESS.toLowerCase(),
  ).map((t) => ({ address: t.address as `0x${string}`, curated: true }));
}

export function useWalletExposure(opts: UseWalletExposureOptions = {}): WalletExposureState {
  const { extraTokens = [], scanToken, refetchInterval = 30_000 } = opts;
  const { address, isConnected } = useAccount();
  const chainId = useChainId();
  const onRightChain = chainId === CHAIN_ID;

  // Build the token universe: curated ERC-20s + any valid, de-duplicated extras.
  const targets = useMemo<TokenTarget[]>(() => {
    const seen = new Set<string>();
    const out: TokenTarget[] = [];
    for (const t of curatedErc20Targets()) {
      const key = t.address.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(t);
    }
    for (const raw of extraTokens) {
      if (!ETH_ADDRESS_RE.test(raw)) continue;
      const key = raw.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ address: raw as `0x${string}`, curated: false });
    }
    return out;
  }, [extraTokens]);

  // Four reads per token: balanceOf(wallet), totalSupply, symbol, decimals.
  // Curated metadata is preferred for display; on-chain symbol/decimals are the
  // fallback for pasted tokens (and a resilience net if the list drifts).
  const contracts = useMemo(() => {
    const acct = (address ?? ZERO) as `0x${string}`;
    return targets.flatMap((t) => [
      { address: t.address, abi: ERC20_ABI, functionName: 'balanceOf' as const, args: [acct] as const, chainId: CHAIN_ID },
      { address: t.address, abi: ERC20_ABI, functionName: 'totalSupply' as const, chainId: CHAIN_ID },
      { address: t.address, abi: ERC20_ABI, functionName: 'symbol' as const, chainId: CHAIN_ID },
      { address: t.address, abi: ERC20_ABI, functionName: 'decimals' as const, chainId: CHAIN_ID },
    ]);
  }, [targets, address]);

  const { data, isLoading, isError } = useReadContracts({
    contracts,
    query: {
      enabled: !!address && isConnected && onRightChain && targets.length > 0,
      refetchInterval,
    },
  });

  const { holdings, unreadableBalances } = useMemo<{
    holdings: WalletHolding[];
    unreadableBalances: `0x${string}`[];
  }>(() => {
    if (!data || !address || !onRightChain) return { holdings: [], unreadableBalances: [] };
    const out: WalletHolding[] = [];
    const unreadable: `0x${string}`[] = [];
    for (let i = 0; i < targets.length; i++) {
      const t = targets[i];
      if (!t) continue;
      const base = i * 4;
      const balRes = data[base];
      const supRes = data[base + 1];
      const symRes = data[base + 2];
      const decRes = data[base + 3];

      // A FAILED balanceOf is not a zero balance.
      //
      // `status !== 'success' ? 0n` plus the `<= 0n` skip below deleted the position
      // outright: an RPC hiccup on one leg of the multicall and that token silently
      // vanished from your exposure, taking its weight out of the headline
      // concentration with it — the flattering direction, and invisible. The page's
      // own footer promises "the position size stays exact and nothing is inferred",
      // which a dropped position falsifies.
      //
      // Read it and it is zero → skip, as before: you do not hold it, and that IS an
      // answer. Could not read it → count it and disclose it.
      if (balRes?.status !== 'success') {
        unreadable.push(t.address);
        continue;
      }
      const balance = balRes.result as bigint;
      if (balance <= 0n) continue; // only surface positions the wallet actually holds

      const totalSupply = supRes?.status === 'success' ? (supRes.result as bigint) : null;
      const meta = findToken(t.address);
      const symbol =
        meta?.symbol ??
        (symRes?.status === 'success' ? String(symRes.result) : undefined) ??
        `${t.address.slice(0, 6)}…`;
      const decimals =
        meta?.decimals ??
        (decRes?.status === 'success' ? Number(decRes.result) : undefined) ??
        18;

      out.push({
        address: t.address,
        symbol,
        name: meta?.name,
        decimals,
        balance,
        balanceFormatted: formatUnits(balance, decimals),
        totalSupply: totalSupply && totalSupply > 0n ? totalSupply : null,
        positionShareOfTotal: positionShareOfTotal(balance, totalSupply),
        logoURI: meta?.logoURI,
        curated: t.curated,
      });
    }
    // Largest position-share first; unknown-supply positions sink to the bottom.
    out.sort((a, b) => (b.positionShareOfTotal ?? -1) - (a.positionShareOfTotal ?? -1));
    return { holdings: out, unreadableBalances: unreadable };
  }, [data, address, onRightChain, targets]);

  // Per-token exposure. Without a scanner every holding is synchronously
  // `unmeasured` (no fabricated band). With a scanner, resolve asynchronously.
  const [scannedExposures, setScannedExposures] = useState<Record<string, HoldingExposure>>({});
  const [scanning, setScanning] = useState(false);
  const scanKey = holdings.map((h) => h.address.toLowerCase()).join(',');
  const scanTokenRef = useRef(scanToken);
  scanTokenRef.current = scanToken;

  useEffect(() => {
    const fn = scanTokenRef.current;
    if (!fn || holdings.length === 0) {
      setScannedExposures({});
      setScanning(false);
      return;
    }
    const controller = new AbortController();
    let cancelled = false;
    setScanning(true);
    (async () => {
      const entries = await Promise.all(
        holdings.map(async (h) => {
          try {
            const analysis = await fn(
              { address: h.address, chain: 'ethereum', totalSupply: h.totalSupply },
              controller.signal,
            );
            return [h.address.toLowerCase(), deriveHoldingExposure(analysis)] as const;
          } catch {
            // A scan failure is an honest gap, not a hostile signal.
            return [h.address.toLowerCase(), deriveHoldingExposure(null)] as const;
          }
        }),
      );
      if (!cancelled) {
        setScannedExposures(Object.fromEntries(entries));
        setScanning(false);
      }
    })();
    return () => {
      cancelled = true;
      controller.abort();
    };
    // scanKey captures the holding set; scanner identity is read via the ref.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scanKey]);

  const exposures = useMemo<Record<string, HoldingExposure>>(() => {
    const out: Record<string, HoldingExposure> = {};
    for (const h of holdings) {
      const key = h.address.toLowerCase();
      out[key] = scannedExposures[key] ?? deriveHoldingExposure(null);
    }
    return out;
  }, [holdings, scannedExposures]);

  return {
    isConnected,
    isWrongNetwork: isConnected && !onRightChain,
    isLoading: isLoading && holdings.length === 0,
    error: isError,
    address,
    holdings,
    /**
     * Tokens whose `balanceOf` could not be READ this pass — not tokens you hold
     * none of. They are absent from `holdings` (there is no size to show), so the
     * page must disclose them: silently omitting a position understates the
     * headline concentration, and the footer's "the position size stays exact"
     * promise is only true if the omissions are visible.
     */
    unreadableBalances,
    exposures,
    scanning,
  };
}
