import { m } from 'framer-motion';
import { isBootstrapApr, BOOTSTRAP_APR_NOTE } from '../../lib/copy';

interface IncentivesStripProps {
  apr: string;
  aprNum?: number;
  rewardPool: string;
  dailyEmissions: string;
  /** F101/F123: honest "rewards remaining" (balance − staked − unsettled), already formatted. */
  rewardsRemaining?: string;
  /** F123: seconds of emission runway left at the current rate (0 if unknown/dry). */
  secondsRemaining?: number;
  /** F109: live staker fee-share % read from SwapFeeRouter.stakerShareBps (undefined until loaded). */
  stakerSharePct?: number;
  /**
   * Live referrer cut from ReferralSplitter.referralFeeBps, taken off the top
   * before the distributor sees anything. `null` = not read (NOT zero). Without
   * it the chip cannot state what a staker actually receives — see feeShareLabel.
   */
  referralFeeBps?: number | null;
  /** STAKING_LOOK §2.2: reads landed AND the reward pool is EMPTY — render real zeros, never nominal figures. */
  reserveEmpty?: boolean;
}

/**
 * F109, CORRECTED 2026-09-03: derive the "Fee Share" chip from BOTH live reads.
 *
 * The chip used to read "100% to stakers", and that was not true. It quoted
 * SwapFeeRouter.stakerShareBps (genuinely 10000) on its own — but that is 100%
 * of what REACHES the distributor. ReferralSplitter.referralFeeBps (live: 2000)
 * takes its cut off the top first (ReferralSplitter.sol:400), so the end-to-end
 * ceiling a staker can receive is ~80%, and the app cannot raise it. This is the
 * same overclaim retired everywhere else on 2026-08-12; this strip was missed.
 *
 * `referralFeeBps` is READ, never hardcoded: it is settable up to
 * MAX_REFERRAL_FEE (3000) behind a timelock, so a literal 2000 would be
 * tomorrow's drift — the exact failure F109 was created to prevent.
 *
 * WHY THE UNREAD CASE RENDERS '–' RATHER THAN A NUMBER: the old `undefined`
 * branch returned the "honest current default" of 100%, which is how a literal
 * outlived the truth in the first place. A share is only quotable when both
 * reads landed; anything else is an unread value, and this codebase does not
 * render unread values as real ones. '–' is already this strip's vocabulary for
 * a stat that has not loaded. Note 0 is NOT unread — a real 0% referral cut, or
 * a real 0% staker share, both render as numbers.
 *
 * Whole percentages drop the trailing ".00".
 */
export function feeShareLabel(
  stakerSharePct: number | undefined,
  referralFeeBps: number | null,
): string {
  if (stakerSharePct === undefined || referralFeeBps === null) return '–';
  const endToEndPct = stakerSharePct * (1 - referralFeeBps / 10_000);
  const pct = Number.isInteger(endToEndPct) ? `${endToEndPct}` : endToEndPct.toFixed(2);
  return `${pct}% to stakers`;
}

/** F123: humanize an emission-runway second count into "Xd"/"Yh" left. */
function formatRunway(seconds: number): string {
  if (seconds <= 0) return '';
  const days = Math.floor(seconds / 86400);
  if (days >= 1) return `${days.toLocaleString()}d`;
  const hours = Math.floor(seconds / 3600);
  return `${hours}h`;
}

/**
 * Public incentives strip — surfaces the concrete staking incentives (reward pool,
 * daily emissions, max boost, fee share) so visitors see the value BEFORE connecting
 * a wallet. Additive only; reuses the kyle-green stat styling from FarmStatsRow.
 * No art or existing sections removed.
 *
 * APR HONESTY (2026-06-09): the displayed APR is the REAL on-chain rate by
 * explicit operator choice — but pre-LP-seed it's fixed-emissions ÷ tiny-TVL,
 * a five-digit number that pattern-matches to a rug for exactly the DeFi-native
 * audience we court. Above the threshold we keep the real number and add the
 * "early-TVL bootstrap" context line so it reads as opportunity, not bait.
 */
export function IncentivesStrip({ apr, aprNum, rewardPool, dailyEmissions, rewardsRemaining, secondsRemaining, stakerSharePct, referralFeeBps = null, reserveEmpty }: IncentivesStripProps) {
  const isBootstrap = isBootstrapApr(aprNum);
  // F109: derive the fee-share chip from the live on-chain split when loaded —
  // BOTH halves of it, since the referral cut precedes the distributor.
  const feeShareValue = feeShareLabel(stakerSharePct, referralFeeBps);
  // Name the deduction rather than leaving an unexplained 80%. Only rendered
  // when the read landed, so the sentence can never quote a number we don't have.
  const feeShareSub = referralFeeBps !== null && referralFeeBps > 0
    ? `after the ${Number.isInteger(referralFeeBps / 100) ? referralFeeBps / 100 : (referralFeeBps / 100).toFixed(2)}% referral cut taken off the top`
    : undefined;
  // F101: prefer the honest "rewards remaining" figure (balance − staked −
  // unsettled) over the cumulative totalFunded when it's available, and label it
  // accordingly so the chip never implies a never-decreasing number is "remaining".
  const hasRemaining = rewardsRemaining !== undefined && rewardsRemaining !== '–';
  // F123: Synthetix-style runway countdown — surfaced from the same hook that
  // already powers /tokenomics, so the Farm page no longer hides emission runway.
  const runway = secondsRemaining && secondsRemaining > 0 ? formatRunway(secondsRemaining) : '';
  // STAKING_LOOK §2.2 — the dry-day contract, pinned by IncentivesStrip.dry
  // test: an EMPTY reserve renders REAL ZEROS with the reason attached. The
  // old behavior fell back to the cumulative "Reward Pool 6,400,000" with a
  // nominal APR — a dead pool advertising a live one.
  const drySub = 'reserve empty — emissions paused until refilled';
  const items = [
    {
      l: 'Emissions APR',
      v: reserveEmpty ? '0%' : apr && apr !== '0' && apr !== '–' ? `${apr}%` : '–',
      icon: '📈',
      sub: reserveEmpty ? drySub : isBootstrap ? BOOTSTRAP_APR_NOTE : undefined,
    },
    {
      l: hasRemaining ? 'Rewards Remaining' : 'Reward Pool',
      v: hasRemaining ? rewardsRemaining! : reserveEmpty ? '0 TOWELI' : rewardPool,
      icon: '💰',
      sub: reserveEmpty ? drySub : runway ? `≈ ${runway} of runway left at the current rate` : undefined,
    },
    { l: 'Daily Emissions', v: reserveEmpty ? '0 / day' : dailyEmissions === '–' ? '–' : `${dailyEmissions} / day`, icon: '⚡' },
    { l: 'Max Boost', v: '4.0× · 4-yr lock', icon: '🚀' },
    { l: 'Fee Share', v: feeShareValue, icon: '💎', sub: feeShareSub },
  ];
  return (
    <m.div
      className="grid grid-cols-2 lg:grid-cols-5 gap-3 mb-8"
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: 0.05 }}
    >
      {items.map((s) => (
        <div
          key={s.l}
          className="rounded-xl p-3 md:p-4"
          style={{ border: '1px solid var(--color-purple-75)', background: 'rgba(0,0,0,0.55)', backdropFilter: 'blur(2px)' }}
        >
          <p
            className="text-[11px] uppercase tracking-wider mb-1.5 flex items-center gap-1.5"
            style={{ color: '#22c55e', textShadow: '0 1px 6px rgba(0,0,0,0.95)' }}
          >
            <span aria-hidden="true">{s.icon}</span>{s.l}
          </p>
          <p className="stat-value text-lg md:text-xl" style={{ color: '#22c55e', textShadow: '0 1px 8px rgba(0,0,0,0.95)' }}>
            {s.v}
          </p>
          {s.sub && (
            <p className="text-[10px] mt-0.5 leading-snug" style={{ color: '#22c55e', opacity: 0.75, textShadow: '0 1px 4px rgba(0,0,0,0.9)' }}>
              {s.sub}
            </p>
          )}
        </div>
      ))}
    </m.div>
  );
}
