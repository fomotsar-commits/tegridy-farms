import { m } from 'framer-motion';

interface IncentivesStripProps {
  apr: string;
  rewardPool: string;
  dailyEmissions: string;
}

/**
 * Public incentives strip — surfaces the concrete staking incentives (reward pool,
 * daily emissions, max boost, fee share) so visitors see the value BEFORE connecting
 * a wallet. Additive only; reuses the kyle-green stat styling from FarmStatsRow.
 * No art or existing sections removed.
 */
export function IncentivesStrip({ apr, rewardPool, dailyEmissions }: IncentivesStripProps) {
  const items = [
    { l: 'Staking APR', v: apr && apr !== '0' && apr !== '–' ? `${apr}%` : '–', icon: '📈' },
    { l: 'Reward Pool', v: rewardPool, icon: '💰' },
    { l: 'Daily Emissions', v: dailyEmissions === '–' ? '–' : `${dailyEmissions} / day`, icon: '⚡' },
    { l: 'Max Boost', v: '4.0× · 4-yr lock', icon: '🚀' },
    { l: 'Fee Share', v: '100% to stakers', icon: '💎' },
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
        </div>
      ))}
    </m.div>
  );
}
