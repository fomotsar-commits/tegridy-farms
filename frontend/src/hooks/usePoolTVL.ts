import { useMemo } from 'react';
import { useReadContracts, useChainId } from 'wagmi';
import { formatEther } from 'viem';
import { UNISWAP_V2_PAIR_ABI, ERC20_ABI, SWAP_FEE_ROUTER_ABI, REFERRAL_SPLITTER_ABI } from '../lib/contracts';
import { TEGRIDY_LP_ADDRESS, TOWELI_ADDRESS, SWAP_FEE_ROUTER_ADDRESS, REFERRAL_SPLITTER_ADDRESS, CHAIN_ID, TEGRIDY_LP_CREATED_AT, isDeployed as checkDeployed } from '../lib/constants';
import { useTOWELIPrice } from '../contexts/PriceContext';

const MAX_APR = 500;
const MAX_TVL_USD = 1e12; // $1T sanity cap
// F468: was hardcoded to 2025-03-01 — ~15 months before the pool existed — which
// understated fee-APR / avg-daily-volume by ~100x once real fees accrued. Pinned
// to the actual pair-creation timestamp (see constants.ts).
const POOL_LAUNCH_TIMESTAMP = TEGRIDY_LP_CREATED_AT;

export function usePoolTVL() {
  const price = useTOWELIPrice();
  /**
   * DISPLAY price, not the swap price.
   *
   * This hook produces TVL, APR and 24h volume — figures that are shown, never
   * traded on. It used to read `price.ethUsd`, which carries a 300s freshness
   * window sized for swap quoting. Mainnet ETH/USD publishes on a 3600s
   * heartbeat, so that window is closed ~85% of the time against a perfectly
   * healthy feed (see the note above MAX_LAUNCH_STALENESS_SECONDS in
   * useToweliPrice.ts, and a live reading of 940s taken 2026-09-03). Whenever it
   * was closed, `ethUsd` was 0, the guard below fell through, and the Farm's pool
   * card rendered TVL / APR / 24h volume as an em dash — which reads as a broken
   * venue rather than a cautious one.
   *
   * `ethUsdForDisplay` uses the feed's own heartbeat window and still requires
   * the answer to be well-formed and inside the sanity band, so a genuinely dead
   * or absurd feed still produces 0 and still dashes out. Swap surfaces keep the
   * tight window; nothing about swap pricing changes here.
   */
  const ethUsd = price.ethUsdForDisplay;
  const hasFeeRouter = checkDeployed(SWAP_FEE_ROUTER_ADDRESS);
  const hasReferralSplitter = checkDeployed(REFERRAL_SPLITTER_ADDRESS);
  const chainId = useChainId();
  const onMainnet = chainId === CHAIN_ID;

  // R043 H-062-02 + H-062-04: chainId pin on every entry; 60s poll
  // (was 30s — TVL doesn't move per-block).
  const { data } = useReadContracts({
    contracts: [
      { address: TEGRIDY_LP_ADDRESS, abi: UNISWAP_V2_PAIR_ABI, functionName: 'getReserves', chainId: CHAIN_ID } as const,
      { address: TEGRIDY_LP_ADDRESS, abi: UNISWAP_V2_PAIR_ABI, functionName: 'token0', chainId: CHAIN_ID } as const,
      { address: TEGRIDY_LP_ADDRESS, abi: ERC20_ABI, functionName: 'totalSupply', chainId: CHAIN_ID } as const,
      ...(hasFeeRouter ? [
        { address: SWAP_FEE_ROUTER_ADDRESS, abi: SWAP_FEE_ROUTER_ABI, functionName: 'totalETHFees' as const, chainId: CHAIN_ID },
        { address: SWAP_FEE_ROUTER_ADDRESS, abi: SWAP_FEE_ROUTER_ABI, functionName: 'feeBps' as const, chainId: CHAIN_ID },
        // F109: live staker fee-share so the "100% to stakers" chip derives from
        // chain truth instead of a hardcoded literal that drifts on a re-tune.
        { address: SWAP_FEE_ROUTER_ADDRESS, abi: SWAP_FEE_ROUTER_ABI, functionName: 'stakerShareBps' as const, chainId: CHAIN_ID },
      ] : []),
      // The referrer's cut comes off the top BEFORE the distributor sees a wei
      // (ReferralSplitter.sol:400), so stakerShareBps alone is 100% *of what
      // arrives*, not 100% of the fee. Both reads are needed to state what a
      // staker actually receives. Index 6, and only when index 3-5 are present.
      ...(hasFeeRouter && hasReferralSplitter ? [
        { address: REFERRAL_SPLITTER_ADDRESS, abi: REFERRAL_SPLITTER_ABI, functionName: 'referralFeeBps' as const, chainId: CHAIN_ID },
      ] : []),
    // useReadContracts expects a discriminated-tuple type for `contracts`, which
    // conditional spread breaks. The runtime shape is correct; we widen with an
    // explicit unknown[] cast so TS doesn't try to narrow each tuple slot.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ] as any,
    query: { enabled: onMainnet, refetchInterval: 60_000, refetchOnWindowFocus: true },
  });

  return useMemo(() => {
    const reserves = data?.[0]?.status === 'success' ? data[0].result as readonly [bigint, bigint, number] : undefined;
    const token0 = data?.[1]?.status === 'success' ? (data[1].result as string).toLowerCase() : undefined;
    const lpSupply = data?.[2]?.status === 'success' ? data[2].result as bigint : 0n;

    // F109: live staker fee-share. Loaded-and-zero is meaningful (governance
    // could route 0% to stakers); undefined means the read hasn't landed, so the
    // "Fee Share" chip keeps its honest default copy until then.
    const stakerShareLoaded = hasFeeRouter && data?.[5]?.status === 'success';
    const stakerSharePct = (hasFeeRouter && data?.[5]?.status === 'success')
      ? Number(data[5].result as bigint) / 100
      : undefined;

    // The referral cut, needed to turn stakerShareBps into what a staker really
    // gets. `null` means "not read" and is NOT interchangeable with 0 — 0 is a
    // meaningful live value (no referral cut at all) and would make the chip
    // claim the full router share. feeShareLabel refuses to quote a number
    // unless BOTH reads landed; see its header.
    const referralFeeBps = (hasFeeRouter && hasReferralSplitter && data?.[6]?.status === 'success')
      ? Number(data[6].result as bigint)
      : null;

    if (!reserves || !token0 || ethUsd <= 0) {
      return { tvl: 0, tvlFormatted: '–', toweliReserve: 0n, wethReserve: 0n, lpSupply: 0n, apr: '–', aprNum: 0, vol24hFormatted: '–', aprIsEstimated: true, volIsEstimated: true, isLoaded: false, stakerSharePct, stakerShareLoaded, referralFeeBps, feesReadOk: true };
    }

    const isToken0Toweli = token0 === TOWELI_ADDRESS.toLowerCase();
    const toweliReserve = isToken0Toweli ? reserves[0] : reserves[1];
    const wethReserve = isToken0Toweli ? reserves[1] : reserves[0];

    const wethFloat = parseFloat(formatEther(wethReserve));
    // R043 H-062-03: NaN/Infinity guard + $1T cap. A flash-loan-injected
    // reserve or NaN oracle would otherwise let the high-side dailyVolumeRatio
    // branch fire on garbage inputs. Math.min(raw, MAX_TVL_USD) keeps the
    // upper end sane.
    const rawTvl = wethFloat * 2 * ethUsd;
    const tvl = Number.isFinite(rawTvl) && rawTvl >= 0 ? Math.min(rawTvl, MAX_TVL_USD) : 0;

    let tvlFormatted: string;
    if (tvl >= 1_000_000) tvlFormatted = `$${(tvl / 1_000_000).toFixed(2)}M`;
    else if (tvl >= 1_000) tvlFormatted = `$${(tvl / 1_000).toFixed(1)}K`;
    else if (tvl > 0) tvlFormatted = `$${tvl.toFixed(0)}`;
    else tvlFormatted = '–';

    let aprNum = 0;
    let aprIsEstimated = true;
    let vol24h = 0;
    let volIsEstimated = true;

    const totalETHFees = hasFeeRouter && data?.[3]?.status === 'success' ? data[3].result as bigint : 0n;
    const feeBps = hasFeeRouter && data?.[4]?.status === 'success' ? data[4].result as bigint : 0n;

    /**
     * Did the fee read actually LAND? `totalETHFees` collapses a failed read and
     * a genuine zero into the same 0n, and the F485 branch below then states
     * "no fees yet" — asserting the pool has never traded on the strength of a
     * request that never came back. That is the repo's most repeated bug class,
     * so the two states are separated here and surfaced to the caller.
     */
    const feesReadOk = !hasFeeRouter || data?.[3]?.status === 'success';

    if (totalETHFees > 0n && tvl > 0) {
      const totalFeesUsd = parseFloat(formatEther(totalETHFees)) * ethUsd;
      const now = Math.floor(Date.now() / 1000);
      const poolAgeSec = Math.max(now - POOL_LAUNCH_TIMESTAMP, 86400);
      const poolAgeDays = poolAgeSec / 86400;

      const dailyFees = totalFeesUsd / poolAgeDays;
      const annualFees = dailyFees * 365;
      aprNum = (annualFees / tvl) * 100;

      if (feeBps > 0n) {
        const feeRate = Number(feeBps) / 10000;
        vol24h = feeRate > 0 ? dailyFees / feeRate : 0;
      } else {
        vol24h = dailyFees / 0.003;
      }

      aprIsEstimated = false;
      volIsEstimated = false;
    } else if (tvl > 0 && feesReadOk) {
      // F485: with no on-chain fees we do NOT fabricate volume/APR from an
      // assumed turnover ratio — the honesty mandate forbids rendering a number
      // the chain can't back. Leave aprNum / vol24h at 0 so the existing '–'
      // fall-through renders; the consuming stat card surfaces a "volume
      // appears after first trades" microcopy line instead of a synthetic $.
      //
      // Gated on feesReadOk: reaching here with a FAILED read would say the same
      // thing about a pool we simply could not measure.
      aprNum = 0;
      vol24h = 0;
    }

    if (aprNum > MAX_APR) aprNum = MAX_APR;

    // Mirrors the volume rule above: a real but tiny APR must not print as a
    // flat "0.0%", which reads as "this pool earns nothing".
    const apr = aprNum >= 0.1
      ? `${aprIsEstimated ? '~' : ''}${aprNum.toFixed(1)}%${aprIsEstimated ? ' (est.)' : ''}`
      : aprNum > 0
        ? `${aprIsEstimated ? '~' : ''}<0.1%${aprIsEstimated ? ' (est.)' : ''}`
        : '–';

    let vol24hFormatted: string;
    const volPrefix = volIsEstimated ? '~' : '';
    const volSuffix = volIsEstimated ? ' (est.)' : '';
    if (vol24h >= 1_000_000) vol24hFormatted = `${volPrefix}$${(vol24h / 1_000_000).toFixed(2)}M${volSuffix}`;
    else if (vol24h >= 1_000) vol24hFormatted = `${volPrefix}$${(vol24h / 1_000).toFixed(1)}K${volSuffix}`;
    // A real but sub-dollar figure used to `toFixed(0)` into "$0", which states
    // there was no trading when there was some. "<$1" is the same information
    // without the false claim.
    else if (vol24h >= 1) vol24hFormatted = `${volPrefix}$${vol24h.toFixed(0)}${volSuffix}`;
    else if (vol24h > 0) vol24hFormatted = `${volPrefix}<$1${volSuffix}`;
    else vol24hFormatted = '–';

    return {
      tvl,
      tvlFormatted,
      toweliReserve,
      wethReserve,
      lpSupply,
      apr,
      aprNum,
      vol24hFormatted,
      aprIsEstimated,
      volIsEstimated,
      isLoaded: true,
      stakerSharePct,
      stakerShareLoaded,
      referralFeeBps,
      /** False when the fee read did not land — "no fees yet" is then unknowable. */
      feesReadOk,
    };
  }, [data, ethUsd, hasFeeRouter, hasReferralSplitter]);
}
