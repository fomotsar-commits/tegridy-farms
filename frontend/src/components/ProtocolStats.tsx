import { m } from 'framer-motion';
import { useProtocolStats } from '../hooks/useProtocolStats';

function fmtUsd(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '—';
  if (n >= 1e9) return `$${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `$${(n / 1e6).toFixed(2)}M`;
  if (n >= 1e3) return `$${(n / 1e3).toFixed(1)}K`;
  return `$${n.toFixed(0)}`;
}
function fmtToken(n: number, sym = 'TOWELI'): string {
  if (!Number.isFinite(n) || n <= 0) return `0 ${sym}`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(2)}M ${sym}`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}K ${sym}`;
  return `${n.toLocaleString(undefined, { maximumFractionDigits: 0 })} ${sym}`;
}

interface StatItem { l: string; v: string; sub: string; icon: string }

/**
 * Public protocol-analytics showcase, reads on-chain (no wallet needed).
 *
 * CREDIBILITY FIX (2026-06-09): never render an empty stat. The previous
 * version proudly displayed "Total Volume —", "Total Staked $9" and
 * "Total Swaps 0" pre-LP-seed — a wall of zeros that reads as a dead
 * protocol to exactly the DeFi-native audience the page courts. Live
 * metrics now render only once they're meaningful and are backfilled with
 * evergreen protocol guarantees (fee share, LP lock, fixed supply, audit
 * record) that are true on day zero. As volume/fees/swaps light up
 * post-seed they displace the evergreen cards automatically.
 */
export function ProtocolStats() {
  const s = useProtocolStats();
  const live: StatItem[] = [];
  if (s.volumeUsd > 0) live.push({ l: 'Total Volume', v: fmtUsd(s.volumeUsd), sub: 'all-time, on native DEX', icon: '🔄' });
  if (s.feesUsd > 0) live.push({ l: 'Real Yield Generated', v: fmtUsd(s.feesUsd), sub: '100% to stakers, in ETH', icon: '💸' });
  if (s.rewardPoolToweli > 0) live.push({ l: 'Reward Pool', v: fmtToken(s.rewardPoolToweli), sub: 'TOWELI staking rewards', icon: '💰' });
  if (s.dailyEmissionToweli > 0) live.push({ l: 'Daily Emissions', v: `${fmtToken(s.dailyEmissionToweli)}/day`, sub: 'to stakers', icon: '⚡' });
  // Below ~$1k the USD figure undersells the position — show the token count.
  if (s.stakedToweli > 0) live.push({ l: 'Total Staked', v: s.stakedUsd >= 1000 ? fmtUsd(s.stakedUsd) : fmtToken(s.stakedToweli), sub: 'TOWELI locked', icon: '🔒' });
  if (s.totalSwaps > 0) live.push({ l: 'Total Swaps', v: s.totalSwaps.toLocaleString(), sub: 'lifetime trades', icon: '📊' });

  const evergreen: StatItem[] = [
    { l: 'Fee Share', v: '100%', sub: 'of protocol fees → stakers, in ETH', icon: '💸' },
    { l: 'LP Locked', v: '~69 yrs', sub: 'Uniswap LP in UNCX until 2093', icon: '🔐' },
    { l: 'Fixed Supply', v: '1B', sub: 'TOWELI — no mint function, ever', icon: '🧱' },
    { l: 'Security', v: '82+', sub: 'findings resolved · bounty live', icon: '🛡️' },
  ];

  const items = [...live, ...evergreen].slice(0, 6);
  return (
    <m.div
      className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3"
      initial={{ opacity: 0, y: 10 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true }}
    >
      {items.map((it) => (
        <div
          key={it.l}
          className="rounded-xl p-3 md:p-4"
          style={{ border: '1px solid var(--color-purple-75)', background: 'rgba(0,0,0,0.55)', backdropFilter: 'blur(2px)' }}
        >
          <p
            className="text-[11px] uppercase tracking-wider mb-1.5 flex items-center gap-1.5"
            style={{ color: '#22c55e', textShadow: '0 1px 6px rgba(0,0,0,0.95)' }}
          >
            <span aria-hidden="true">{it.icon}</span>{it.l}
          </p>
          <p className="stat-value text-lg md:text-xl" style={{ color: '#22c55e', textShadow: '0 1px 8px rgba(0,0,0,0.95)' }}>
            {it.v}
          </p>
          {it.sub && <p className="text-[10px] mt-0.5" style={{ color: '#22c55e', opacity: 0.75 }}>{it.sub}</p>}
        </div>
      ))}
    </m.div>
  );
}
