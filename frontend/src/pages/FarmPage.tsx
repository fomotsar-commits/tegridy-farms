import { useState, useEffect, useRef, useCallback } from 'react';
import { m } from 'framer-motion';
import { useAccount } from 'wagmi';
import { Link, useParams } from 'react-router-dom';
import { toast } from 'sonner';
import { CURRENT_SEASON, LOCK_OPTIONS } from '../lib/constants';
import { formatEther } from 'viem';
import { stakingClaimPaid, NOTHING_PAID_COPY } from '../lib/stakingClaimPaid';
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
import { useAutoReset } from '../hooks/useAutoReset';
import { safeParseEther } from '../lib/safeParseEther';
import { surfaceTxError, isUserRejection } from '../lib/txErrors';
import { seasonStatus } from '../lib/season';
import { ErrorBoundary } from '../components/ui/ErrorBoundary';
import { ConnectPrompt } from '../components/ui/ConnectPrompt';

import { BUNGALOWS, DEFAULT_BUNGALOW_ID } from '../lib/bungalows';
import { useActiveBungalowId } from '../hooks/useActiveBungalowId';
import { BungalowFarmPanel } from '../components/bungalow/BungalowFarmPanel';
import { VenuePoolIndex } from '../components/farm/VenuePoolIndex';
import { BackToEarn } from '../components/farm/BackToEarn';
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
import { CardArt } from '../components/ui/CardArt';
import { PageArtBackdrop } from '../components/PageArtBackdrop';
import { FinePrint } from '../components/ui/FinePrint';
import { lpFarmDeposit } from '../lib/lpEmissions';

/**
 * Earn's Staking tab. `/earn` is the list of every pool (VenueEarn) whatever
 * room is active, so the top-bar word and the tab always lead back to it.
 * `/earn/<id>` is one pool, its room already entered (App.tsx EarnPoolRoute):
 * a room with its own token gets its self-gating farm panel, and the TOWELI
 * room gets the classic farm. Until 2026-09-30 the ROOM picked the pool on a
 * single /farm, so a visitor inside one pool had no way back to the list.
 * The branch lives in this wrapper so ToweliFarm's hook order never changes,
 * and it re-reads when the skin switches in place.
 */
export default function FarmPage() {
  useActiveBungalowId();
  const { poolId } = useParams();
  const bungalow = poolId ? BUNGALOWS.find((b) => b.id === poolId && b.live) : undefined;
  // The venue speaks for the whole island, not for one resident.
  if (!bungalow) return <VenueEarn />;
  if (bungalow.id === DEFAULT_BUNGALOW_ID) return <ToweliFarm />;
  return <BungalowFarmPanel key={bungalow.id} bungalow={bungalow} />;
}

/**
 * The venue's own /earn: every resident's pool.
 *
 * ⚠️ ITS OWN COMPONENT, NOT JSX INLINED IN THE WRAPPER, and the reason is the
 * same one the wrapper's note gives for keeping the bungalow branch out of
 * ToweliFarm: hooks. This branch needs `usePageTitle`, and calling it inside a
 * wrapper that returns three different trees would make it conditional. As a
 * component it owns its own hook order.
 *
 * It shipped without a title for exactly one build, and e2e/smoke.spec.ts caught
 * it — the document kept the venue's default title, so "did this route mount?"
 * had no honest answer on the page a stranger sees first.
 */
function VenueEarn() {
  usePageTitle(
    'Earn',
    'Every resident pool on Jungle Bay Island — stake a token for a share of its rewards, or provide liquidity and earn a cut of the swaps.',
  );
  return (
    <div className="relative">
      <PageArtBackdrop pageId="earn" />
      {/* `relative` with no z-index: above the backdrop by coming after it, and
          not a stacking context that would trap a dialog under the tab strip. */}
      <div className="relative mx-auto w-full max-w-[900px] px-4 py-8 sm:py-10">
        {/* One heading, one line (owner, 2026-10-14: as few words as possible).
            The island's name is in the list's own heading below; the "Jungle
            Bay Island" eyebrow that stood above the h1 was a third line of
            words before the first row. */}
        <header className="mb-6">
          <h1 className="heading-luxury text-3xl md:text-4xl text-white leading-tight mb-2">Earn</h1>
          <p className="text-white/75 text-[14px] md:text-[15px] leading-relaxed max-w-[62ch]">
            Pick a coin, open its pool, stake.
          </p>
          <FinePrint summary="How it works" className="mt-1 max-w-[62ch]">
            <p>
              Stake for a share of a pool&rsquo;s rewards. Longer locks earn more.
            </p>
            <p>
              Stake a token to earn a share of its pool, or provide liquidity and take a cut of every
              swap that routes through it. The longer you lock, the larger your share of the same
              rewards.
            </p>
          </FinePrint>
        </header>
        <VenuePoolIndex />
      </div>
    </div>
  );
}

function ToweliFarm() {
  usePageTitle('Farm', 'Stake TOWELI and provide liquidity to earn boosted yield on memetics.finance.');
  const { isConnected } = useAccount();
  // Wrong-chain display delegated to <WrongChainBanner/>; button-level chain
  // checks still happen inside useFarmActions before any write.
  const stats = useFarmStats();
  const pool = usePoolData();
  const pos = useUserPosition();
  const actions = useFarmActions();
  const nft = useNFTBoost();
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

  // AUDIT F-7: the LP farm only recomputes the boost inside stake/withdraw/exit,
  // so a wallet that stakes first and buys a JBAC second keeps earning at the
  // unboosted rate until it touches the farm again. Prompt mode (auto:false) —
  // refreshBoost is a transaction, so the user confirms it rather than having a
  // signature request appear on page load.
  const lpBoost = useAutoRefreshBoost({ onRefreshNeeded: lpFarm.refreshBoost });
  // A refresh earns nothing once the farm's rewards have ended (a landed periodFinish
  // in the past), so the prompt to pay gas for "the boosted rate" is not shown then.
  const lpDeposit = lpFarmDeposit(lpFarm.periodFinishUnread ? null : lpFarm.periodFinish);
  const lpRewardsEnded = !lpDeposit.open && lpDeposit.reason === 'ended';

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
        // min(pending, pool), so the submit-time snapshot can overstate the
        // payout exactly when the reserve matters. On an EMPTY reserve it pays
        // 0 and logs no RewardPaid at all; that used to fall through to the
        // snapshot and print a receipt for TOWELI nobody sent. The snapshot is
        // now only for a receipt that could not be read.
        const paid = stakingClaimPaid(actions.receipt);
        if (paid === 0n) {
          toast.warning(NOTHING_PAID_COPY);
          submittedAmountRef.current = null;
          return; // no receipt, no confetti
        }
        showReceipt({
          type: 'claim',
          data: {
            rewardAmount: paid !== null ? formatEther(paid) : submittedAmountRef.current ?? pos.pendingFormatted,
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
          <div className="page-column mx-auto px-4 md:px-6 pb-4">
            <BackToEarn />
            {/* The thing a logged-out visitor came to press is Connect, so the
                action card is the FIRST card, not the last: on a 390px phone it
                sat 6,400px down, under five sections of figures (the lead's
                walk, 2026-10-14). The read-only figures follow it unchanged. */}
            <ConnectPrompt surface="farm" />
            <IncentivesStrip apr={pool.apr} aprNum={pool.aprNum} rewardPool={stats.rewardPool} dailyEmissions={stats.dailyEmissions} rewardsRemaining={rewardsRemainingDisplay} secondsRemaining={pool.secondsRemaining} stakerSharePct={poolTVL.stakerSharePct} referralFeeBps={poolTVL.referralFeeBps} reserveEmpty={pool.isDry} />

            <FarmStatsRow
              stats={stats}
              pool={pool}
              price={price}
              priceData={priceData}
              priceError={priceError}
              season={season}
            />

            {/* Real-yield thesis surfaced in the staking loop: swap fees → stakers as
                ETH, live-cumulative once the flywheel turns (graceful pre-volume state).
                NOT "100%" — that was this comment's old wording and it is wrong the same
                way the strip above was: the referral carve precedes the distributor, so
                the end-to-end ceiling is ~80%. IncentivesStrip now reads both values live
                and states the real figure; RealYieldProof itself was always correct. */}
            <RealYieldProof showWhenEmpty />

            {/* Native LP Pools — read-only pool cards (TVL, reserves, fees). */}
            <div className="mb-10 mt-2">
              <div className="flex items-center justify-between mb-5">
                <div>
                  <h2 className="heading-luxury text-white text-[22px] tracking-tight">Liquidity Pools</h2>
                  <p className="text-white text-[13px] mt-0.5">Add two coins. Earn from every trade.</p>
                </div>
                <Link to="/liquidity" className="text-white/60 text-[12px] hover:text-white transition-colors">
                  All pools &#8594;
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

            {/* The wallet-less estimate is on the TOWELI room's own home: HomePage
                draws <YieldCalculator/> only in the TOWELI voice and only with no
                wallet, as here. Never `/`: that is the venue's door, which leaves
                the room and has no estimate. e2e/section-links.spec.ts walks it. */}
            <div className="mb-6">
              <Link
                to="/toweli#yield-calculator"
                className="inline-flex items-center gap-1.5 text-[12px] text-white/70 hover:text-white transition-colors"
              >
                See what you&rsquo;d earn before connecting &#8594;
              </Link>
            </div>
          </div>
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
      <div className="relative z-10 page-column mx-auto px-4 md:px-6 pt-20 pb-28 md:pb-12">
        <BackToEarn />
        {/* Wrong-chain banner via shared primitive. Replaces the inlined
            switch-CTA block added in Phase 4.3 — behavior identical, just
            centralized so Community/Farm/future pages share one component. */}
        <WrongChainBanner
          className="mb-4"
          message="Wrong network. Switch chains to stake, claim or withdraw."
        />
        <m.div className="mb-8" initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }}>
          <h1 className="heading-luxury text-2xl md:text-3xl lg:text-4xl text-white tracking-tight mb-1">Farm</h1>
          <p className="text-white text-[14px]">Stake TOWELI and earn rewards &middot; <span className="text-white">FAFO</span></p>
        </m.div>

        {/* THE STAKE FORM AND THE POSITION COME FIRST (owner, 2026-10-14: "not
            even see the stuff they are to interact with"). This grid sat at the
            foot of the page, under the strip, the stats, the real-yield proof,
            the season banner, the pool cards and the LP farm: five phone
            screens before the amount field. Everything that was above it still
            renders, below it, in the same order it had. */}

        {/* Exit-only surface for retired pre-relaunch staking contracts; renders
            nothing unless the connected wallet holds a legacy position. */}
        <LegacyStakingExit />

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 mb-10">
          {/* Staking Card */}
          <StakingCard
            isConnected={isConnected}
            pos={pos}
            actions={actions}
            nft={nft}
            pool={{ apr: pool.apr, aprNum: pool.aprNum, isDeployed: pool.isDeployed, isDry: pool.isDry, secondsRemaining: pool.secondsRemaining, rewardsRemaining: pool.rewardsRemaining, rewardsRemainingUnread: pool.rewardsRemainingUnread }}
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

        {/* Real-yield thesis in the staking loop — swap fees → stakers as ETH. Not
            "100%": see the twin comment on the other RealYieldProof mount above. */}
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
                Lock longer for a bigger boost, up to 4x.
              </p>
              <FinePrint summary="Details">
                <p>
                  Lock TOWELI for up to 4x boost. Longer lock = more rewards + governance power.
                </p>
              </FinePrint>
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
              <p className="text-white text-[13px] mt-0.5">Add two coins. Earn from every trade.</p>
            </div>
            <Link to="/liquidity" className="text-white/60 text-[12px] hover:text-white transition-colors">
              All pools &#8594;
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
        {lpBoost.needsRefresh && !lpRewardsEnded && (
          <div
            className="relative isolate mb-4 px-4 py-3 rounded-xl flex flex-col sm:flex-row sm:items-center gap-3"
            style={{ background: 'rgba(245,158,11,0.08)', border: '1px solid rgba(245,158,11,0.25)' }}
          >
            <CardArt pageId="farm" idx={2} />
            <div className="text-amber-200 text-[12px] leading-snug flex-1">
              <p>Your JBAC boost is not applied to your staked LP. Refresh it to earn the boosted rate.</p>
              <FinePrint summary="Why">
                <p>
                  The farm recalculates the boost only
                  when you stake, withdraw or exit, so LP staked before you acquired the NFT is still
                  earning at the unboosted rate until you refresh it.
                </p>
              </FinePrint>
            </div>
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

      </div>
      </ErrorBoundary>
    </div>
  );
}
