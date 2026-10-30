import type { ReactNode } from 'react';
import { FinePrint } from '../ui/FinePrint';
import { BETA_OVER_HEADING, BETA_OVER_LINE, type StakingBetaPhase } from '../../lib/stakingBetaOver';
import { EARLY_WITHDRAWAL_PENALTY_BPS } from '../../lib/constants';

const PENALTY_PCT = EARLY_WITHDRAWAL_PENALTY_BPS / 100;

/**
 * "Beta is over" for TOWELI staking v1: heading, one line for the phase the chain
 * reports (lib/stakingBetaOver), the plan and its caveats in the fine print. `art`
 * (a <CardArt/>, written at the call site so the art inventory sees it) makes it a
 * card of its own; inside a card that already has art, leave it out.
 */
export function StakingBetaOverNotice({
  phase,
  onRetry,
  art,
}: {
  phase: StakingBetaPhase;
  onRetry?: () => void;
  art?: ReactNode;
}) {
  const warn = phase === 'unread' || phase === 'reserve-empty' || phase === 'reserve-short';
  return (
    <div
      role="status"
      data-testid="staking-beta-over"
      data-phase={phase}
      className={`${art ? 'relative isolate overflow-hidden mb-6' : 'mb-4'} rounded-lg border p-3 text-[12px] ${
        warn ? 'border-amber-500/40 bg-amber-500/10 text-amber-100' : 'border-white/20 bg-black/40 text-white'
      }`}
    >
      {art}
      <h3 className="font-semibold text-[13px] mb-1">{BETA_OVER_HEADING}</h3>
      <p>{BETA_OVER_LINE[phase]}</p>
      {phase === 'unread' && onRetry && (
        <button type="button" className="btn-secondary mt-2 px-4 py-1.5 text-[12px]" onClick={onRetry}>
          Retry
        </button>
      )}
      <FinePrint summary="How it closes">
        <p>
          Rewards stop first: the reward rate goes to 0, a change that waits 48 hours on chain.
          The reward reserve is then refilled with what is owed, so every claim pays in full,
          and there are about 14 days to claim.
        </p>
        <p>
          Then the pool pauses. While it is paused, Claim and Claim Unsettled can&apos;t be used,
          and the exit on your position gives your whole stake back with no {PENALTY_PCT}% penalty.
          On a lock that has not ended, that exit gives up the rewards you have not claimed, so
          claim first. On an ended lock it pays them out too.
        </p>
        <p>
          Until then, Withdraw works as before once a lock ends, and an early exit still costs{' '}
          {PENALTY_PCT}%, which goes to the treasury. The site takes no new stakes, top-ups or
          lock extensions into v1.
        </p>
        <p>
          A new staking contract replaces it: no pool cap, up to 10,000,000 TOWELI per wallet,
          rewards spread over four years. Its date is not set.
        </p>
      </FinePrint>
    </div>
  );
}
