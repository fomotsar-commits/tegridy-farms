import { useState, useEffect, useRef, useCallback } from 'react';
import { m } from 'framer-motion';
import { useAccount } from 'wagmi';
import { Link } from 'react-router-dom';
import { toast } from 'sonner';
import { CURRENT_SEASON, LOCK_OPTIONS } from '../lib/constants';
import { parseEventLogs, formatEther } from 'viem';
import { TEGRIDY_STAKING_ABI } from '../lib/contracts';
import { WrongChainBanner } from '../components/ui/WrongChainGuard';
import { calculateBoost } from '../lib/boostCalculations';
import { useFarmStats } from '../hooks/useFarmStats';
import { usePoolData } from '../hooks/usePoolData';
import { useUserPosition } from '../hooks/useUserPosition';
import { useFarmActions } from '../hooks/useFarmActions';
import { useNFTBoost } from '../hooks/useNFTBoost';
import { useTOWELIPrice } from '../contexts/PriceContext';
import { usePriceHistory } from '../hooks/usePriceHistory';
import { useTransactionReceipt } from '../hooks/useTransactionReceipt';
import type { ReceiptType } from '../hooks/useTransactionReceipt';
import { useConfetti } from '../hooks/useConfetti';
import { usePoolTVL } from '../hooks/usePoolTVL';
import { useLPFarming } from '../hooks/useLPFarming';
import { useAutoRefreshBoost } from '../hooks/useAutoRefreshBoost';
import { useOneClickStake } from '../hooks/useOneClickStake';
import { usePageTitle } from '../hooks/usePageTitle';
import { usePoints } from '../hooks/usePoints';
import { useAutoReset } from '../hooks/useAutoReset';
import { useRestaking } from '../hooks/useRestaking';
import { safeParseEther } from '../lib/safeParseEther';
import { surfaceTxError, isUserRejection } from '../lib/txErrors';
import { seasonStatus } from '../lib/season';
import { ErrorBoundary } from '../components/ui/ErrorBoundary';
import { ConnectPrompt } from '../components/ui/ConnectPrompt';

import { getActiveBungalow, DEFAULT_BUNGALOW_ID } from '../lib/bungalows';
import { BungalowFarmPanel } from '../components/bungalow/BungalowFarmPanel';
import { FarmStatsRow } from '../components/farm/FarmStatsRow';
import { IncentivesStrip } from '../components/farm/IncentivesStrip';
import { RealYieldProof } from '../components/RealYieldProof';
import { LPFarmingSection } from '../components/farm/LPFarmingSection';
import { StakingCard } from '../components/farm/StakingCard';
import type { ConfirmState } from '../components/farm/StakingCard';
import { LegacyStakingExit } from '../components/farm/LegacyStakingExit';
import { BoostScheduleTable } from '../components/farm/BoostScheduleTable';
import { UPCOMING_POOLS } from '../components/farm/poolConfig';
import { LivePoolCard } from '../components/farm/LivePoolCard';
import { UpcomingPoolCard } from '../components/farm/UpcomingPoolCard';
import { ArtImg } from '../components/ArtImg';

/**
 * Jungle Bay bungalows: in a non-default bungalow the whole TOWELI farm stack
 * (staking card, LP farming, boosts) is the wrong token and the wrong chain,
 * so the route renders the bungalow's own self-gating farm panel instead.
 * The branch lives in this wrapper — NOT as an early return inside the farm
 * component — so the classic component's hook order is untouched. The active
 * bungalow can only change via persist+reload, so the branch is stable for
 * the lifetime of the document.
 */
export default function FarmPage() {
  const bungalow = getActiveBungalow();
  if (bungalow && bungalow.id !== DEFAULT_BUNGALOW_ID) {
    return <BungalowFarmPanel bungalow={bungalow} />;
  }
  return <ToweliFarm />;
}

function ToweliFarm() {
  usePageTitle('Farm', 'Stake TOWELI and provide liquidity to earn boosted yield on memetics.finance.');
  const { isConnected } = useAccount();
  // Wrong-chain display delegated to <WrongChainBanner/>; button-level chain
  // checks still happen inside useFarmActions / useRestaking before any write.
  const stats = useFarmStats();
  const pool = usePoolData();
  const pos = useUserPosition();
  const actions = useFarmActions();
  const nft = useNFTBoost();
  // F108: the page no longer calls the deprecated points.logAction no-op, but we
  // keep usePoints mounted so the on-chain points/streak state stays warm for the
  // header/leaderboard surfaces that share the engine. (No binding — read-only.)
  usePoints();
  const price = useTOWELIPrice();
  const priceHistory = usePriceHistory();
  const { history: priceData, error: priceError } = priceHistory;

  const { showReceipt } = useTransactionReceipt();
  const confetti = useConfetti();
  const lastActionRef = useRef<ReceiptType | null>(null);
  const receiptShownHashRef = useRef<string | null>(null);
  // Capture values at submission time to avoid stale closures in the receipt effect
  const submittedDataRef = useRef<{ stakeAmount: string; lockLabel: string; boostDisplay: string } | null>(null);
  // F106: snapshot the claim/unstake amount at submit time so a 30s position
  // poll landing mid-flight can't produce a "claimed 0 TOWELI" receipt.
  const submittedAmountRef = useRef<string | null>(null);

  const [stakeAmount, setStakeAmount] = useState('');
  const [selectedLock, setSelectedLock] = useState(LOCK_OPTIONS[2]!); // Default 90 days
  const [extendLockDuration, setExtendLockDuration] = useState(LOCK_OPTIONS[2]!);
  const [confirms, setConfirms] = useState<ConfirmState>({
    withdraw: false,
    earlyWithdraw: false,
    emergencyExit: false,
    extendLock: false,
    autoMaxLock: false,
  });
  // F118: stable identity so useAutoReset's effect (which lists the setter in
  // its deps) doesn't clear + re-arm the 5s confirm-dismiss timer on every
  // background-poll rerender — otherwise the withdraw confirm dismisses at an
  // unpredictable time well past 5s.
  const setConfirm = useCallback((key: keyof ConfirmState, val: boolean) =>
    setConfirms((prev) => ({ ...prev, [key]: val })), []);

  const poolTVL = usePoolTVL();
  const lpFarm = useLPFarming();
  const restaking = useRestaking();

  // AUDIT F-7: the LP farm only recomputes the boost inside stake/withdraw/exit,
  // so a wallet that stakes first and buys a JBAC second keeps earning at the
  // unboosted rate until it touches the farm again. Prompt mode (auto:false) —
  // refreshBoost is a transaction, so the user confirms it rather than having a
  // signature request appear on page load.
  const lpBoost = useAutoRefreshBoost({ onRefreshNeeded: lpFarm.refreshBoost });

  // EIP-5792: collapse approve + stake into one confirmation on wallets that
  // advertise atomic batching. Support is never assumed — `canBatch` stays false
  // until wallet_getCapabilities answers, and `batchUnavailable` retires the path
  // for the rest of the session if a batch is rejected by the wallet for any
  // reason other than the user declining it.
  const oneClickStake = useOneClickStake();
  const [batchUnavailable, setBatchUnavailable] = useState(false);
  const [batchSubmitting, setBatchSubmitting] = useState(false);

  // Auto-dismiss confirmation dialogs after 5 seconds (regular withdrawals only).
  // Emergency exit is a dangerous financial action — never auto-dismiss.
  // F118: memoize the per-key setters so useAutoReset's effect (setter is a dep)
  // doesn't re-arm the 5s timeout on every background-poll rerender.
  const setWithdrawConfirm = useCallback((v: boolean) => setConfirm('withdraw', v), [setConfirm]);
  const setEarlyWithdrawConfirm = useCallback((v: boolean) => setConfirm('earlyWithdraw', v), [setConfirm]);
  useAutoReset(confirms.withdraw, setWithdrawConfirm, 5000);
  useAutoReset(confirms.earlyWithdraw, setEarlyWithdrawConfirm, 5000);

  const boostBps = calculateBoost(selectedLock.seconds);
  // STAKING_LOOK §2.1: this flow calls plain stake(), which the contract
  // explicitly grants NO JBAC bonus (TegridyStaking.sol:1011 — the +0.5x
  // requires stakeWithBoost's NFT deposit, a path this UI does not drive).
  // The preview therefore must NOT add JBAC_BONUS_BPS: it promised 4.5x and
  // delivered 4.0x, in the exact window where the user decides. The bonus
  // returns to this preview if/when the NFT-deposit flow is wired.
  const totalBoostBps = Math.min(boostBps, 45000);
  const boostDisplay = (totalBoostBps / 10000).toFixed(2);

  const amtNum = parseFloat(stakeAmount) || 0;
  const effectiveStake = amtNum * totalBoostBps / 10000;

  // Season countdown. Math.max(0, …) used to live here, which meant the tile froze at
  // "0d left" forever once endDate passed; seasonStatus() reports the phase instead.
  const season = seasonStatus();

  // F101/F123: surface the honest "rewards remaining" (balance − staked −
  // unsettled) + runway on the Farm page itself, sourced from usePoolData (the
  // same hook that powers /tokenomics). pool.rewardsRemaining is a decimal
  // string; format it to a comma TOWELI figure, falling back to '–' when unread.
  const rewardsRemainingNum = parseFloat(pool.rewardsRemaining);
  // STAKING_LOOK §2.2: an EMPTY reserve is a real, displayable zero — '–'
  // means "could not read", and conflating the two was exactly the dry-day
  // display bug. isDry only flips once reads landed, so the distinction holds.
  const rewardsRemainingDisplay = pool.isDeployed && (rewardsRemainingNum > 0 || pool.isDry)
    ? `${Math.round(rewardsRemainingNum).toLocaleString()} TOWELI`
    : '–';

  // F98 (R034 H4): never let raw parseEther throw in the render path — a dust
  // balance routed through Max yields exponent notation that parseEther rejects,
  // which would blank the whole page via ErrorBoundary. safeParseEther returns
  // null instead; treat unparseable input as "no approval needed yet".
  const stakeNeedsApproval = pos.allowance < (amtNum > 0 ? (safeParseEther(stakeAmount) ?? 0n) : 0n);

  // Only worth batching when an approval would otherwise be a separate signature.
  // `batchSubmitting` is deliberately NOT part of this: it gates a second submit
  // inside handleStake, and folding it in here would relabel the button mid-prompt
  // to describe a flow the open wallet dialog is not running.
  const canBatchStake = stakeNeedsApproval && oneClickStake.canBatch && !batchUnavailable;

  const handleStake = () => {
    if (amtNum <= 0) return;
    if (canBatchStake) {
      if (batchSubmitting) return;
      const wei = safeParseEther(stakeAmount);
      if (wei === null || wei <= 0n) { toast.error('Invalid amount'); return; }
      setBatchSubmitting(true);
      // wallet_sendCalls resolves on SUBMISSION and returns a batch id, not a
      // mined tx hash — there is no receipt to key a stake receipt off, so this
      // path deliberately shows no receipt and no confetti. The position poll is
      // what reflects the stake once the batch actually lands.
      oneClickStake
        .stakeOneClick(wei, BigInt(selectedLock.seconds))
        .then(() => {
          toast.success('Approve + stake submitted in one confirmation', {
            description: 'Your position updates here once the batch confirms on-chain.',
          });
        })
        .catch((err: unknown) => {
          // A decline is not a broken wallet — keep the one-click affordance for
          // the retry. Anything else means this wallet cannot complete the batch,
          // so fall back to the proven sequential approve → stake flow.
          if (!isUserRejection(err)) setBatchUnavailable(true);
          surfaceTxError(err, toast, { component: 'FarmPage/oneClickStake' });
        })
        .finally(() => setBatchSubmitting(false));
      return;
    }
    if (stakeNeedsApproval) {
      // F95: tag the approve so the success effect shows an approve receipt (or
      // nothing) instead of fabricating a stake receipt + confetti.
      lastActionRef.current = 'approve';
      actions.approve(stakeAmount);
    } else {
      lastActionRef.current = 'stake';
      submittedDataRef.current = { stakeAmount, lockLabel: selectedLock.label, boostDisplay };
      actions.stake(stakeAmount, BigInt(selectedLock.seconds));
    }
  };

  // Show transaction receipt on farm action success
  useEffect(() => {
    if (actions.isSuccess && actions.hash && receiptShownHashRef.current !== actions.hash) {
      receiptShownHashRef.current = actions.hash;
      // F95: never assume 'stake'. When an action wasn't tagged (extendLock,
      // toggleAutoMaxLock, revalidateBoost, claimUnsettled, emergencyExit) the
      // ref is null — show no receipt + no confetti rather than a fabricated one.
      const actionType = lastActionRef.current;
      // F102 (T5): refresh the section on EVERY confirmed write before the
      // no-receipt early-return below. Untagged actions (extendLock,
      // emergencyExit, toggleAutoMaxLock, revalidateBoost, claimUnsettled) set
      // no actionType and would otherwise return here and never refetch, leaving
      // "Your Position" / lock state stale for up to 30s. A single targeted
      // refetch is not a poll storm.
      pos.refetchAll();
      if (!actionType) return;

      if (actionType === 'stake') {
        const submitted = submittedDataRef.current;
        showReceipt({
          type: 'stake',
          data: {
            amount: submitted?.stakeAmount ?? stakeAmount,
            token: 'TOWELI',
            lockDuration: submitted?.lockLabel ?? selectedLock.label,
            boost: submitted?.boostDisplay ?? boostDisplay,
            estimatedAPR: pool.isDeployed ? pool.apr : undefined,
            txHash: actions.hash,
          },
        });
        submittedDataRef.current = null;
      // 2026-07-26: an approval is a prerequisite, not a completion, so it now
      // gets NO receipt. The old full-screen "PERMISSION GRANTED" receipt (with
      // Share/Copy buttons) read like the stake had already happened — the exact
      // "looks finished but it's only an approval" confusion. useFarmActions now
      // fires a clear "approved — now confirm your stake" toast instead, and the
      // button relabels to "Stake & Lock". (Confetti already excluded approve.)
      } else if (actionType === 'claim') {
        // §2.5 (STAKING_LOOK): report what was PAID, from the tx's own
        // RewardPaid log — under a pool shortfall the contract transfers
        // min(pending, pool) (possibly 0, remainder booked as an IOU), so the
        // submit-time snapshot can overstate the payout exactly when the
        // reserve matters. The snapshot remains only as a last-resort
        // fallback if log parsing fails.
        let paidFromLogs: string | null = null;
        try {
          const paidEvents = parseEventLogs({
            abi: TEGRIDY_STAKING_ABI,
            logs: actions.receipt?.logs ?? [],
            eventName: 'RewardPaid',
          });
          if (paidEvents.length > 0) {
            const total = paidEvents.reduce((s, e) => s + ((e.args as { reward?: bigint }).reward ?? 0n), 0n);
            paidFromLogs = formatEther(total);
          }
        } catch { /* fall back to the snapshot below */ }
        showReceipt({
          type: 'claim',
          data: {
            rewardAmount: paidFromLogs ?? submittedAmountRef.current ?? pos.pendingFormatted,
            token: 'TOWELI',
            txHash: actions.hash,
          },
        });
        submittedAmountRef.current = null;
      } else if (actionType === 'unstake') {
        showReceipt({
          type: 'unstake',
          data: {
            amount: submittedAmountRef.current ?? pos.stakedFormatted,
            token: 'TOWELI',
            txHash: actions.hash,
          },
        });
        submittedAmountRef.current = null;
      }

      // Fire confetti on stake or claim success (approve/unstake excluded).
      if (actionType === 'stake' || actionType === 'claim') {
        confetti.fire();
      }

      // F105: clear the typed amount only after a stake completes (not approve —
      // keep the amount so the user can stake next). The refetch already fired
      // above, before the early-return, so it covers every confirmed action.
      if (actionType === 'stake') setStakeAmount('');
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps -- stakeAmount/selectedLock/boostDisplay captured via submittedDataRef at submission time
  }, [actions.isSuccess, actions.hash, showReceipt, confetti, pool.isDeployed, pool.apr, pos.pendingFormatted, pos.stakedFormatted]);

  // Wallet-gate: render ConnectPrompt instead of broken interactive UI
  // when no wallet is connected. Keeps the scenery, swaps the content.
  if (!isConnected) {
    return (
      <div className="-mt-14 relative min-h-screen">
        <div className="fixed inset-0 z-0" style={{ background: '#060c1a' }}>
          <ArtImg pageId="farm" idx={0} fallbackPosition="center 20%" alt="" loading="lazy" className="w-full h-full object-cover" />
          <div className="absolute inset-0" style={{ background: 'rgba(6, 12, 26, 0.55)' }} aria-hidden="true" />
        </div>
        <div className="relative z-10 pt-20">
          {/* F115 / F169 (T7): render the public read-only data for logged-out
              visitors instead of hiding the whole farm behind the connect wall.
              All of these read from connection-independent hooks already
              instantiated above; only the stake/claim/LP actions stay gated
              (LPFarmingSection renders its own "Connect to stake" CTA, and the
              ConnectPrompt below remains the action-card slot). Additive — the
              jungle art hero and ConnectPrompt are untouched. */}
          <div className="max-w-[1200px] mx-auto px-4 md:px-6 pb-4">
            <IncentivesStrip apr={pool.apr} aprNum={pool.aprNum} rewardPool={stats.rewardPool} dailyEmissions={stats.dailyEmissions} rewardsRemaining={rewardsRemainingDisplay} secondsRemaining={pool.secondsRemaining} stakerSharePct={poolTVL.stakerSharePct} referralFeeBps={poolTVL.referralFeeBps} reserveEmpty={pool.isDry} />

            <FarmStatsRow
              stats={stats}
              pool={pool}
              price={price}
              priceData={priceData}
              priceError={priceError}
              season={season}
            />

            {/* Real-yield thesis surfaced in the staking loop: 100% of swap fees → stakers
                as ETH, live-cumulative once the flywheel turns (graceful pre-volume state). */}
            <RealYieldProof showWhenEmpty />

            {/* Native LP Pools — read-only pool cards (TVL, reserves, fees). */}
            <div className="mb-10 mt-2">
              <div className="flex items-center justify-between mb-5">
                <div>
                  <h2 className="heading-luxury text-white text-[22px] tracking-tight">Liquidity Pools</h2>
                  <p className="text-white text-[13px] mt-0.5">Provide liquidity to native pairs &middot; earn trading fees</p>
                </div>
                <Link to="/liquidity" className="text-white/60 text-[12px] hover:text-white transition-colors">
                  View all pools &#8594;
                </Link>
              </div>
              <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
                <LivePoolCard poolData={poolTVL} />
                {UPCOMING_POOLS.map((p) => (
                  <UpcomingPoolCard key={p.id} pool={p} />
                ))}
              </div>
            </div>

            {/* LP Farming — section renders read-only stats + a Connect-to-stake CTA. */}
            <LPFarmingSection lpFarm={lpFarm} isConnected={false} />

            {/* Boost schedule — pure lock-multiplier table, no wallet needed. */}
            <div className="mb-2">
              <BoostScheduleTable selectedLockLabel={selectedLock.label} aprNum={pool.aprNum} />
            </div>

            {/* Affordance for the wallet-less estimator on the home page. This
                branch only renders while disconnected, which is exactly when
                HomePage renders <YieldCalculator/> (it is gated on !address),
                so the deep-link can never land on a missing anchor. */}
            <div className="mb-6">
              <Link
                to="/#yield-calculator"
                className="inline-flex items-center gap-1.5 text-[12px] text-white/70 hover:text-white transition-colors"
              >
                See what you&rsquo;d earn &mdash; estimate before connecting &#8594;
              </Link>
            </div>
          </div>
          <ConnectPrompt surface="farm" />
        </div>
      </div>
    );
  }

  return (
    <div className="-mt-14 relative min-h-screen">
      <div className="fixed inset-0 z-0" style={{ background: '#060c1a' }}>
        <ArtImg pageId="farm" idx={0} fallbackPosition="center 20%" alt="" loading="lazy" className="w-full h-full object-cover" />
      </div>

      <ErrorBoundary>
      <div className="relative z-10 max-w-[1200px] mx-auto px-4 md:px-6 pt-20 pb-28 md:pb-12">
        {/* Wrong-chain banner via shared primitive. Replaces the inlined
            switch-CTA block added in Phase 4.3 — behavior identical, just
            centralized so Community/Farm/future pages share one component. */}
        <WrongChainBanner
          className="mb-4"
          message="Wrong network detected — switch to the canonical chain to stake, claim, or withdraw."
        />
        <m.div className="mb-8" initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }}>
          <h1 className="heading-luxury text-2xl md:text-3xl lg:text-4xl text-white tracking-tight mb-1">Farm</h1>
          <p className="text-white text-[14px]">Stake TOWELI and earn rewards &middot; <span className="text-white">FAFO</span></p>
        </m.div>

        {/* Incentives strip — real APR + reward-pool / emissions / boost / fee-share */}
        <IncentivesStrip apr={pool.apr} aprNum={pool.aprNum} rewardPool={stats.rewardPool} dailyEmissions={stats.dailyEmissions} rewardsRemaining={rewardsRemainingDisplay} secondsRemaining={pool.secondsRemaining} stakerSharePct={poolTVL.stakerSharePct} referralFeeBps={poolTVL.referralFeeBps} reserveEmpty={pool.isDry} />

        {/* Stats */}
        <FarmStatsRow
          stats={stats}
          pool={pool}
          price={price}
          priceData={priceData}
          priceError={priceError}
          season={season}
        />

        {/* Real-yield thesis in the staking loop — 100% swap fees → stakers as ETH. */}
        <RealYieldProof showWhenEmpty />

        {/* Season banner */}
        <m.div className="relative overflow-hidden rounded-xl glass-card-animated mb-8" style={{ border: '1px solid var(--color-purple-75)' }}
          initial={{ opacity: 0 }} animate={{ opacity: 1 }}>
          <div className="absolute inset-0">
            <ArtImg pageId="farm" idx={1} alt="" loading="lazy" className="w-full h-full object-cover" />
          </div>
          <div className="relative z-10 m-2 md:m-3 rounded-lg p-4 md:p-6 py-6 md:py-7 flex flex-col md:flex-row md:items-center justify-between gap-3" style={{ background: 'rgba(0,0,0,0.55)', backdropFilter: 'blur(2px)', border: '1px solid rgba(255,255,255,0.08)' }}>
            <div>
              <div className="flex items-center gap-2 mb-1.5">
                <span className="text-white text-[17px] font-semibold">{CURRENT_SEASON.name}</span>
                {nft.boostLabel && <span className="badge badge-warning text-[10px]">{nft.boostLabel}</span>}
              </div>
              <p className="text-white text-[13px]">
                Lock TOWELI for up to 4x boost. Longer lock = more rewards + governance power.
              </p>
            </div>
            {nft.holdsJBAC && (
              <div className="md:text-right">
                <p className="stat-value text-[16px] text-white">+0.5x NFT Boost</p>
                <p className="text-white text-[11px]">{nft.holdsGoldCard ? 'Gold Card' : 'JBAC Holder'}</p>
              </div>
            )}
          </div>
        </m.div>

        {/* ── Native LP Pools ── */}
        <m.div className="mb-10" initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.15 }}>
          <div className="flex items-center justify-between mb-5">
            <div>
              <h2 className="heading-luxury text-white text-[22px] tracking-tight">Liquidity Pools</h2>
              <p className="text-white text-[13px] mt-0.5">Provide liquidity to native pairs &middot; earn trading fees</p>
            </div>
            <Link to="/liquidity" className="text-white/60 text-[12px] hover:text-white transition-colors">
              View all pools &#8594;
            </Link>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
            <LivePoolCard poolData={poolTVL} />
            {UPCOMING_POOLS.map((pool) => (
              <UpcomingPoolCard key={pool.id} pool={pool} />
            ))}
          </div>
        </m.div>

        {/* AUDIT F-7: staked before acquiring the JBAC → the farm is still paying
            the unboosted rate. Permissionless on-chain, so the user can fix it
            here in one transaction. */}
        {lpBoost.needsRefresh && (
          <div
            className="mb-4 px-4 py-3 rounded-xl flex flex-col sm:flex-row sm:items-center gap-3"
            style={{ background: 'rgba(245,158,11,0.08)', border: '1px solid rgba(245,158,11,0.25)' }}
          >
            <p className="text-amber-200 text-[12px] leading-snug flex-1">
              Your JBAC boost is not applied to your staked LP. The farm recalculates the boost only
              when you stake, withdraw or exit, so LP staked before you acquired the NFT is still
              earning at the unboosted rate until you refresh it.
            </p>
            <button
              onClick={() => lpFarm.refreshBoost()}
              disabled={lpFarm.isPending || lpFarm.isConfirming}
              className="btn-outline px-4 py-2 min-h-[44px] text-[12px] whitespace-nowrap disabled:opacity-50"
            >
              {lpFarm.isPending || lpFarm.isConfirming ? 'Confirming…' : 'Refresh boost'}
            </button>
          </div>
        )}

        {/* ── LP Farming ── */}
        <LPFarmingSection lpFarm={lpFarm} isConnected={isConnected} />

        {/* ── Restaking (Bonus Yield Layer) ── */}
        {isConnected && pos.hasPosition && restaking.isDeployed && (
          <m.div className="mb-10" initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.2 }}>
            <div className="flex items-center justify-between mb-4">
              <div>
                <h2 className="heading-luxury text-white text-[22px] tracking-tight">Restaking</h2>
                <p className="text-white text-[13px] mt-0.5">Earn bonus TOWELI rewards on top of your staking position</p>
              </div>
              {restaking.bonusAPR > 0 && (
                <span className="stat-value text-[15px] text-green-400">+{restaking.bonusAPR.toFixed(1)}% Bonus APR</span>
              )}
            </div>
            <div className="glass-card p-5 rounded-xl" style={{ border: '1px solid var(--color-purple-12)' }}>
              {/* F112 (R075): when an RPC quotes impossible reward numbers the hook
                  zeroes the values — without this notice users just see 0.0000 with
                  no explanation. Prompt them to verify on-chain instead. */}
              {restaking.rewardSanityBreach && (
                <div className="mb-4 px-3 py-2 rounded-lg flex items-start gap-2" style={{ background: 'rgba(245,158,11,0.08)', border: '1px solid rgba(245,158,11,0.25)' }}>
                  <span className="text-amber-300 text-[13px] leading-none" aria-hidden="true">⚠</span>
                  <p className="text-amber-200 text-[11px] leading-snug">
                    Reward data failed an on-chain sanity check and is being hidden. Verify your pending rewards directly on Etherscan before claiming.
                  </p>
                </div>
              )}
              <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-5">
                <div>
                  <p className="text-white/90 text-[10px] uppercase tracking-wider mb-0.5" style={{ textShadow: '0 1px 6px rgba(0,0,0,0.95)' }}>Status</p>
                  <p className="stat-value text-[14px]" style={{ color: restaking.isRestaked ? '#22c55e' : 'var(--color-purple-75)' }}>
                    {restaking.isRestaked ? 'Active' : 'Not Restaked'}
                  </p>
                </div>
                <div>
                  <p className="text-white/90 text-[10px] uppercase tracking-wider mb-0.5" style={{ textShadow: '0 1px 6px rgba(0,0,0,0.95)' }}>Restaked</p>
                  <p className="stat-value text-[14px] text-white">{restaking.restakedFormatted.toLocaleString()} TOWELI</p>
                </div>
                <div>
                  <p className="text-white/90 text-[10px] uppercase tracking-wider mb-0.5" style={{ textShadow: '0 1px 6px rgba(0,0,0,0.95)' }}>Pending Rewards</p>
                  <p className="stat-value text-[14px] text-green-400">{restaking.pendingTotalFormatted.toFixed(4)} TOWELI</p>
                </div>
                <div>
                  <p className="text-white/90 text-[10px] uppercase tracking-wider mb-0.5" style={{ textShadow: '0 1px 6px rgba(0,0,0,0.95)' }}>Total Restaked (Protocol)</p>
                  <p className="stat-value text-[14px] text-white">{restaking.totalRestakedFormatted.toLocaleString()}</p>
                </div>
              </div>
              {restaking.pendingTotalFormatted > 0 && (
                <div className="flex items-center gap-3 mb-4 px-3 py-2 rounded-lg" style={{ background: 'rgba(34,197,94,0.08)', border: '1px solid rgba(34,197,94,0.2)' }}>
                  <span className="text-white/60 text-[11px]">Base: {restaking.pendingBaseFormatted.toFixed(4)}</span>
                  <span className="text-white/30">+</span>
                  <span className="text-green-400 text-[11px]">Bonus: {restaking.pendingBonusFormatted.toFixed(4)}</span>
                </div>
              )}
              <div className="flex gap-3">
                {!restaking.isRestaked ? (
                  <button
                    onClick={restaking.restake}
                    disabled={restaking.isPending || restaking.isConfirming}
                    className="btn-primary px-6 py-2.5 min-h-[44px] text-[13px] flex-1"
                  >
                    {restaking.isPending ? 'Confirm in wallet...' : restaking.isConfirming ? 'Confirming...' : 'Restake Position'}
                  </button>
                ) : (
                  <>
                    <button
                      onClick={restaking.claimAll}
                      disabled={restaking.isPending || restaking.isConfirming || restaking.pendingTotal === 0n}
                      className="btn-primary px-6 py-2.5 min-h-[44px] text-[13px] flex-1"
                    >
                      {restaking.isPending ? 'Confirm...' : restaking.isConfirming ? 'Confirming...' : `Claim ${restaking.pendingTotalFormatted.toFixed(4)} TOWELI`}
                    </button>
                    <button
                      onClick={restaking.unrestake}
                      disabled={restaking.isPending || restaking.isConfirming}
                      className="btn-outline px-4 py-2.5 min-h-[44px] text-[13px]"
                    >
                      Unrestake
                    </button>
                  </>
                )}
              </div>
            </div>
          </m.div>
        )}

        {/* Exit-only surface for retired pre-relaunch staking contracts; renders
            nothing unless the connected wallet holds a legacy position. */}
        <LegacyStakingExit />

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 mb-12">
          {/* Staking Card */}
          <StakingCard
            isConnected={isConnected}
            pos={pos}
            actions={actions}
            nft={nft}
            pool={{ apr: pool.apr, aprNum: pool.aprNum, isDeployed: pool.isDeployed, isDry: pool.isDry, secondsRemaining: pool.secondsRemaining }}
            input={{
              amount: stakeAmount,
              setAmount: setStakeAmount,
              lock: selectedLock,
              setLock: setSelectedLock,
              extendLockDuration,
              setExtendLockDuration,
            }}
            confirms={confirms}
            setConfirm={setConfirm}
            computed={{
              boostDisplay,
              totalBoostBps,
              amtNum,
              effectiveStake,
              // The CTA labels the next confirmation, not the allowance state: on a
              // batching wallet the single prompt approves AND stakes, so "Approve
              // TOWELI" would understate what the user is about to sign.
              stakeNeedsApproval: stakeNeedsApproval && !canBatchStake,
            }}
            handleStake={handleStake}
            lastActionRef={lastActionRef}
            submittedAmountRef={submittedAmountRef}
          />

          {/* Boost Table */}
          <BoostScheduleTable selectedLockLabel={selectedLock.label} aprNum={pool.aprNum} />
        </div>
      </div>
      </ErrorBoundary>
    </div>
  );
}
