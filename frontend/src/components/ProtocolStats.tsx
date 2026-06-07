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

/**
 * Public protocol-analytics showcase: trading volume, real yield (fees) generated,
 * staking reward pool + daily emissions, total staked, swap count. Reads on-chain
 * (no wallet needed). Populates as activity comes in post-LP-seed; reads as 0/—
 * until then. Additive — drop <ProtocolStats/> on any public page.
 */
export function ProtocolStats() {
  const s = useProtocolStats();
  const items = [
    { l: 'Total Volume', v: fmtUsd(s.volumeUsd), sub: 'all-time, on native DEX', icon: '🔄' },
    { l: 'Real Yield Generated', v: fmtUsd(s.feesUsd), sub: '100% to stakers', icon: '💸' },
    { l: 'Reward Pool', v: fmtToken(s.rewardPoolToweli), sub: 'TOWELI staking rewards', icon: '💰' },
    { l: 'Daily Emissions', v: s.dailyEmissionToweli > 0 ? `${fmtToken(s.dailyEmissionToweli)}/day` : '—', sub: 'to stakers', icon: '⚡' },
    { l: 'Total Staked', v: s.stakedUsd > 0 ? fmtUsd(s.stakedUsd) : fmtToken(s.stakedToweli), sub: 'TOWELI locked', icon: '🔒' },
    { l: 'Total Swaps', v: s.totalSwaps > 0 ? s.totalSwaps.toLocaleString() : '0', sub: 'lifetime trades', icon: '📊' },
  ];
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
