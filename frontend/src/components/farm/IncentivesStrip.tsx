import { m } from 'framer-motion';
import { isBootstrapApr, BOOTSTRAP_APR_NOTE } from '../../lib/copy';
import { CardArt } from '../ui/CardArt';

// The strip's five tiles; a tile added later reuses a registered art surface (idx wraps).
const INCENTIVE_ART_SLOTS = 5;

interface IncentivesStripProps {
  apr: string;
  aprNum?: number;
  rewardPool: string;
  dailyEmissions: string;
  /** F101/F123: honest "rewards remaining" (balance − staked − unsettled), already formatted. */
  rewardsRemaining?: string;
  /** F123: seconds of emission runway left at the current rate (0 if unknown/dry). */
  secondsRemaining?: number;
  /** STAKING_LOOK §2.2: reads landed AND the reward pool is EMPTY — render real zeros, never nominal figures. */
  reserveEmpty?: boolean;
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
 * daily emissions, max boost) and where swap fees go, so visitors see it BEFORE connecting
 * a wallet. Additive only; reuses the kyle-green stat styling from FarmStatsRow.
 * No art or existing sections removed.
 *
 * APR HONESTY (2026-06-09): the displayed APR is the REAL on-chain rate by
 * explicit operator choice — but pre-LP-seed it's fixed-emissions ÷ tiny-TVL,
 * a five-digit number that pattern-matches to a rug for exactly the DeFi-native
 * audience we court. Above the threshold we keep the real number and add the
 * "early-TVL bootstrap" context line so it reads as opportunity, not bait.
 */
export function IncentivesStrip({ apr, aprNum, rewardPool, dailyEmissions, rewardsRemaining, secondsRemaining, reserveEmpty }: IncentivesStripProps) {
  const isBootstrap = isBootstrapApr(aprNum);
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
      sub: reserveEmpty ? drySub : runway ? `≈ ${runway} left at this rate` : undefined,
    },
    { l: 'Daily Emissions', v: reserveEmpty ? '0 / day' : dailyEmissions === '–' ? '–' : `${dailyEmissions} / day`, icon: '⚡' },
    { l: 'Max Boost', v: '4.0× · 4-yr lock', icon: '🚀' },
    // Every router pays the treasury Safe (owner ruling 2026-11-15): no swap fee reaches a staker.
    { l: 'Swap Fees', v: 'Treasury', icon: '💎', sub: 'not shared with stakers' },
  ];
  return (
    <m.div
      className="grid grid-cols-2 lg:grid-cols-5 gap-3 mb-8"
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: 0.05 }}
    >
      {items.map((s, i) => (
        <div
          key={s.l}
          className="relative isolate rounded-xl p-3 md:p-4"
          style={{ border: '1px solid var(--color-purple-75)', background: 'rgba(0,0,0,0.55)', backdropFilter: 'blur(2px)' }}
        >
          <CardArt pageId="incentives-strip" idx={0 + (i % INCENTIVE_ART_SLOTS)} />
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
