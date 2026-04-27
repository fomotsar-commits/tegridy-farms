import { useEffect, useRef } from 'react';
import { useAccount, useChainId, useReadContracts } from 'wagmi';
import { LP_FARMING_ABI } from '../lib/contracts';
import { LP_FARMING_ADDRESS, CHAIN_ID, isDeployed as checkDeployed } from '../lib/constants';
import { useNFTBoost } from './useNFTBoost';

/// AUDIT F-7 (post-Batch-J sweep): auto-fire LPFarming.refreshBoost when the
/// connected wallet acquires a JBAC NFT after staking.
///
/// Why this is needed: the contract auto-refreshes on stake() / withdraw() /
/// exit() via the inline `_refreshIfBoostChanged` path, but a user who already
/// staked AND THEN acquires a JBAC keeps their pre-acquisition (no-boost)
/// effective balance until they next call any state-mutating function. This
/// hook closes that gap by detecting the mismatch and asking the user to fire
/// refreshBoost via the supplied callback (or auto-firing if `auto` is true).
///
/// Detection: rawBalanceOf > 0 (user has stake) AND holdsJBAC === true AND
/// effectiveBalanceOf < rawBalanceOf * 1.5 (the 1.5x baseline boost). The
/// localStorage gate on (address, jbacCount) prevents loops when the user
/// declines or the tx fails.
export function useAutoRefreshBoost(opts: {
  /// Callback to call when a refresh is needed. Pass useLPFarming().refreshBoost.
  onRefreshNeeded: (target: `0x${string}`) => void;
  /// If true, fire onRefreshNeeded automatically when conditions are met.
  /// If false, only set `needsRefresh = true` and let the UI prompt the user.
  /// Default: false (UI-prompt mode is safer — surfaces a confirmation step).
  auto?: boolean;
}): { needsRefresh: boolean; effectiveBalance: bigint; rawBalance: bigint } {
  const { address } = useAccount();
  const chainId = useChainId();
  const onMainnet = chainId === CHAIN_ID;
  const isDeployed = checkDeployed(LP_FARMING_ADDRESS);
  const { holdsJBAC, jbacCount } = useNFTBoost();

  const { data } = useReadContracts({
    contracts: [
      { address: LP_FARMING_ADDRESS, abi: LP_FARMING_ABI, functionName: 'rawBalanceOf', args: [address ?? '0x0000000000000000000000000000000000000000'], chainId: CHAIN_ID },
      { address: LP_FARMING_ADDRESS, abi: LP_FARMING_ABI, functionName: 'effectiveBalanceOf', args: [address ?? '0x0000000000000000000000000000000000000000'], chainId: CHAIN_ID },
    ],
    query: { enabled: !!address && onMainnet && isDeployed && holdsJBAC === true, refetchInterval: 60_000 },
  });

  const rawBalance = (data?.[0]?.status === 'success' ? data[0].result : 0n) as bigint;
  const effectiveBalance = (data?.[1]?.status === 'success' ? data[1].result : 0n) as bigint;

  // Boost expected when holdsJBAC: 1.5x (15000 bps) on the contract side. We
  // detect "boost not applied" when effectiveBalance < rawBalance * 1.4 — using
  // 1.4 (slightly under 1.5) as the threshold tolerates rounding and excludes
  // the case where boost is already applied. Without JBAC, effective ≤ raw.
  const needsRefresh =
    !!address &&
    onMainnet &&
    isDeployed &&
    holdsJBAC === true &&
    rawBalance > 0n &&
    effectiveBalance > 0n &&
    effectiveBalance < (rawBalance * 14n) / 10n;

  // Per-(address, jbacCount) gate to avoid auto-firing in a loop if the tx
  // fails or the user declines. Keyed by the JBAC count so a future acquisition
  // re-arms detection.
  const firedRef = useRef<string | null>(null);
  const sessionKey = `lpFarmingBoostSync_${address ?? 'unknown'}_${jbacCount}`;

  useEffect(() => {
    if (!opts.auto || !needsRefresh || !address) return;
    if (firedRef.current === sessionKey) return;
    try {
      const stored = typeof window !== 'undefined' ? window.localStorage.getItem(sessionKey) : null;
      if (stored) {
        firedRef.current = sessionKey;
        return;
      }
      window.localStorage.setItem(sessionKey, String(Date.now()));
    } catch {
      /* localStorage may be unavailable; proceed without persistence */
    }
    firedRef.current = sessionKey;
    opts.onRefreshNeeded(address as `0x${string}`);
  }, [opts, needsRefresh, address, sessionKey]);

  return { needsRefresh, effectiveBalance, rawBalance };
}
