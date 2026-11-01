import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { useAccount } from 'wagmi';
import { formatEther } from 'viem';
import { LOCK_OPTIONS, OLD_STAKING_CONTRACT } from '../../lib/constants';
import { useUserPosition } from '../../hooks/useUserPosition';
import { usePoolData } from '../../hooks/usePoolData';
import { useFarmActions } from '../../hooks/useFarmActions';
import { useAutoReset } from '../../hooks/useAutoReset';
import { stakingBetaPhase, betaReadsFromHooks } from '../../lib/stakingBetaOver';
import { StakingCard, type ConfirmState } from './StakingCard';
import { StakingBetaOverNotice } from './StakingBetaOverNotice';

const NO_OP = () => {};
// The stake form is never drawn for this contract (StakingCard's `exitOnly`), so its
// inputs are inert. They exist only because the card's props describe both modes.
const INERT_INPUT = {
  amount: '',
  setAmount: NO_OP,
  lock: LOCK_OPTIONS[0]!,
  setLock: NO_OP,
  extendLockDuration: LOCK_OPTIONS[0]!,
  setExtendLockDuration: NO_OP,
};
const INERT_COMPUTED = { boostDisplay: '0', totalBoostBps: 0, amtNum: 0, effectiveStake: 0, stakeNeedsApproval: false };

type OldPosition = ReturnType<typeof useUserPosition>;

/** A position, an IOU (it outlives its position), or a read that did not land. */
const hasSomethingThere = (pos: OldPosition) => pos.hasPosition || pos.positionUnread || pos.unsettledRewards > 0n;

/**
 * Where TOWELI staking v1 (this contract) stands, from ITS reads (lib/stakingBetaOver):
 * the pool's, and the wallet's position when one is given.
 */
function useOldStakingBeta(wallet?: OldPosition) {
  const pool = usePoolData(OLD_STAKING_CONTRACT);
  const phase = stakingBetaPhase(betaReadsFromHooks(pool, wallet));
  const retry = () => { void pool.refetch(); if (wallet) void wallet.refetchAll(); };
  return { pool, phase, retry };
}

/**
 * The door for a position on the FIRST relaunch staking contract
 * (OLD_TEGRIDY_STAKING_ADDRESS) after STAKING RELEASE 1 moved new stakes to the new one.
 *
 * That contract is still live and keeps its own terms, 25% early exit included: a deployed
 * constant cannot change. So this is the same StakingCard, pointed at the old contract,
 * its own monitor view and its own revenue distributor, with every control that would
 * stake or commit there for longer switched off. Claim, claim the IOU, withdraw, leave
 * early at ITS fee, the pause doors, and turning Auto-Max OFF all stay.
 *
 * Renders nothing unless the wallet has a position there, or the read did not land (then
 * the card's own "could not be read" state shows, never a silent nothing).
 */
export function OldStakingCard() {
  const { isConnected } = useAccount();
  const pos = useUserPosition(OLD_STAKING_CONTRACT);
  const actions = useFarmActions(OLD_STAKING_CONTRACT);
  const beta = useOldStakingBeta(pos);
  const lastActionRef = useRef<string | null>(null);
  const submittedAmountRef = useRef<string | null>(null);
  const [confirms, setConfirms] = useState<ConfirmState>({
    withdraw: false,
    earlyWithdraw: false,
    emergencyExit: false,
    extendLock: false,
    autoMaxLock: false,
  });
  const setConfirm = useCallback((key: keyof ConfirmState, val: boolean) =>
    setConfirms((prev) => ({ ...prev, [key]: val })), []);
  const setWithdrawConfirm = useCallback((v: boolean) => setConfirm('withdraw', v), [setConfirm]);
  const setEarlyWithdrawConfirm = useCallback((v: boolean) => setConfirm('earlyWithdraw', v), [setConfirm]);
  useAutoReset(confirms.withdraw, setWithdrawConfirm, 5000);
  useAutoReset(confirms.earlyWithdraw, setEarlyWithdrawConfirm, 5000);

  // Every confirmed write re-reads the position, so a closed one leaves the page.
  const refreshedHashRef = useRef<string | null>(null);
  useEffect(() => {
    if (!actions.isSuccess || !actions.hash || refreshedHashRef.current === actions.hash) return;
    refreshedHashRef.current = actions.hash;
    void pos.refetchAll();
  }, [actions.isSuccess, actions.hash, pos]);

  if (!isConnected || !hasSomethingThere(pos)) return null;

  const busy = actions.isPending || actions.isConfirming;
  const { pool } = beta;
  // The card offers Claim Unsettled only beside a position; an IOU left after one closed
  // is claimed here. claimUnsettled is whenNotPaused.
  const iouOnly = !pos.hasPosition && !pos.positionUnread;
  return (
    <div className="mb-6" data-testid="old-staking-card">
      <StakingCard
        isConnected={isConnected}
        pos={pos}
        actions={actions}
        input={INERT_INPUT}
        confirms={confirms}
        setConfirm={setConfirm}
        computed={INERT_COMPUTED}
        handleStake={NO_OP}
        lastActionRef={lastActionRef}
        submittedAmountRef={submittedAmountRef}
        contract={OLD_STAKING_CONTRACT}
        pool={{ apr: pool.apr, aprNum: pool.aprNum, isDeployed: pool.isDeployed, isDry: pool.isDry, rewardsRemaining: pool.rewardsRemaining, rewardsRemainingUnread: pool.rewardsRemainingUnread }}
        betaOver={{ phase: beta.phase, onRetry: beta.retry }}
      />
      {iouOnly && (
        <div
          className="mt-2 rounded-lg p-3 flex items-center justify-between gap-3"
          style={{ background: 'rgba(0,0,0,0.55)', border: '1px solid rgba(255,255,255,0.15)' }}
          data-testid="old-staking-iou-claim"
        >
          <p className="text-white text-[12px]">
            Unsettled rewards on the old contract:{' '}
            <span className="font-mono font-semibold">{pos.unsettledFormatted} TOWELI</span>
          </p>
          <button
            onClick={() => actions.claimUnsettled()}
            disabled={busy || pos.isPaused === true}
            className="btn-secondary px-4 py-2 min-h-[44px] text-[12px] whitespace-nowrap disabled:opacity-70"
          >
            {busy ? 'Processing...' : 'Claim Unsettled'}
          </button>
        </div>
      )}
      {/* This contract's ETH fee share lives in ITS distributor, and the exit guard
          refuses while any is unclaimed, so the claim has to be here too. Shown only
          on a READ non-zero: null is unknown and the guard already says so. */}
      {actions.pendingEth !== null && actions.pendingEth > 0n && (
        <div
          className="mt-2 rounded-lg p-3 flex items-center justify-between gap-3"
          style={{ background: 'rgba(0,0,0,0.55)', border: '1px solid rgba(255,255,255,0.15)' }}
          data-testid="old-staking-eth-claim"
        >
          <p className="text-white text-[12px]">
            ETH fee share on the old contract:{' '}
            <span className="font-mono font-semibold">{Number(formatEther(actions.pendingEth)).toFixed(6)} ETH</span>
          </p>
          <button
            onClick={() => actions.claimEth()}
            disabled={busy}
            className="btn-secondary px-4 py-2 min-h-[44px] text-[12px] whitespace-nowrap disabled:opacity-70"
          >
            {busy ? 'Processing...' : 'Claim ETH'}
          </button>
        </div>
      )}
    </div>
  );
}

/**
 * TOWELI staking v1's "Beta is over" notice on its own, from this contract's reads.
 * Connected, it shows only to a wallet with something there; a visitor with no wallet
 * always sees it. `art` is a <CardArt/> written at the call site.
 */
export function OldStakingBetaNotice({ art }: { art?: ReactNode }) {
  const { isConnected } = useAccount();
  const pos = useUserPosition(OLD_STAKING_CONTRACT);
  const beta = useOldStakingBeta(isConnected ? pos : undefined);
  if (isConnected && !hasSomethingThere(pos)) return null;
  return <StakingBetaOverNotice phase={beta.phase} onRetry={beta.retry} art={art} />;
}

/**
 * A pointer, not a second copy of the controls: on a page that shows the CURRENT
 * contract's position (the Dashboard), a wallet whose stake is on the old contract would
 * otherwise read "no staking position". The Farm page owns the writes.
 */
export function OldStakingNotice() {
  const { isConnected } = useAccount();
  const pos = useUserPosition(OLD_STAKING_CONTRACT);
  if (!isConnected || !hasSomethingThere(pos)) return null;
  return (
    <div
      className="mb-4 rounded-lg p-3 text-[13px] text-white"
      style={{ background: 'rgba(0,0,0,0.55)', border: '1px solid rgba(245,158,11,0.35)' }}
      data-testid="old-staking-notice"
    >
      {pos.hasPosition
        ? <>You have {Number(pos.stakedFormatted).toLocaleString(undefined, { maximumFractionDigits: 2 })} TOWELI staked on the old contract (early exit there costs {OLD_STAKING_CONTRACT.penaltyBps / 100}%).{' '}</>
        : pos.positionUnread
        ? <>We could not check the old staking contract. Anything staked there is still yours.{' '}</>
        : <>You have {pos.unsettledFormatted} TOWELI of unsettled rewards on the old contract.{' '}</>}
      <Link to="/earn/toweli" className="underline hover:text-amber-100">Manage it on the Farm page</Link>.
    </div>
  );
}
