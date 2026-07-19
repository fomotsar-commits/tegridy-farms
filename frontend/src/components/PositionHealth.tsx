import { Link } from 'react-router-dom';
import { m } from 'framer-motion';
import { useUserPosition } from '../hooks/useUserPosition';
import { staggerContainer, staggerItem } from '../lib/motion';

/**
 * Position Health Center (#7) — proactive warnings, not just a position readout.
 * The research-backed retention lever: people who get warned BEFORE they lose a
 * boost / get liquidated stay; people blindsided rage-quit. Lending isn't
 * deployed yet, so the live signals here are staking-side: lock expiring, lock
 * ended (boost at risk), and rewards sitting unclaimed.
 *
 * SELF-GATING: renders nothing unless the connected wallet actually has a
 * staking position (nothing to watch otherwise).
 */

type Severity = 'warn' | 'info' | 'good';

interface Health {
  id: string;
  sev: Severity;
  title: string;
  detail: string;
  cta?: { label: string; to: string };
}

const SEV: Record<Severity, { color: string; glyph: string }> = {
  warn: { color: 'var(--color-kenny)', glyph: '⚠' }, // ⚠
  info: { color: 'var(--color-towelie)', glyph: 'ℹ' }, // ℹ
  good: { color: '#22c55e', glyph: '✓' }, // ✓
};

function compact(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0';
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return n.toFixed(n < 1 ? 2 : 0);
}

export function PositionHealth() {
  const pos = useUserPosition();

  // Self-gate: nothing to watch without a live staking position.
  if (!pos.isDeployed || !pos.hasPosition) return null;

  const now = Math.floor(Date.now() / 1000);
  const secsLeft = pos.lockEnd - now;
  const daysLeft = Math.max(0, Math.ceil(secsLeft / 86400));
  const boostX = pos.boostMultiplier;
  const staked = Number(pos.stakedFormatted);
  const claimable = Number(pos.pendingFormatted);

  const alerts: Health[] = [];

  // Lock ending soon (skip if auto-relock keeps it locked).
  if (pos.isLocked && !pos.autoMaxLock && secsLeft > 0 && secsLeft < 7 * 86400) {
    alerts.push({
      id: 'expiring',
      sev: 'warn',
      title: `Your lock ends in ${daysLeft === 0 ? 'under a day' : `${daysLeft}d`}`,
      detail: `Extend it to keep your ${boostX.toFixed(1)}× boost — once it unlocks you drop to the base rate.`,
      cta: { label: 'Extend lock', to: '/farm' },
    });
  }

  // Lock already ended — boost at risk.
  if (!pos.isLocked) {
    alerts.push({
      id: 'ended',
      sev: 'warn',
      title: 'Your lock has ended',
      detail: 'Re-lock to restore your boosted rewards — an unlocked position earns the base rate.',
      cta: { label: 'Re-lock', to: '/farm' },
    });
  }

  // Rewards sitting unclaimed.
  if (claimable > 0.0001) {
    alerts.push({
      id: 'claim',
      sev: 'info',
      title: `${compact(claimable)} TOWELI ready to claim`,
      detail: 'Claim your TOWELI rewards — re-stake on the Farm page to compound.',
      cta: { label: 'Claim rewards', to: '/farm' },
    });
  }

  const healthy = alerts.length === 0;

  return (
    <div className="glass-card rounded-xl p-4 md:p-5">
      <div className="flex items-center justify-between mb-3">
        <h3 className="heading-luxury text-[15px] text-white">Position Health</h3>
        <span
          className="text-[10px] uppercase tracking-wider"
          style={{ color: healthy ? '#22c55e' : 'var(--color-kenny)' }}
        >
          {healthy ? 'all good' : `${alerts.length} to review`}
        </span>
      </div>

      {healthy ? (
        <div className="flex items-center gap-3 px-1 py-1">
          <span
            className="flex-shrink-0 w-7 h-7 rounded-full flex items-center justify-center text-[13px]"
            style={{ background: 'rgba(34,197,94,0.15)', color: '#22c55e' }}
            aria-hidden="true"
          >
            {SEV.good.glyph}
          </span>
          <p className="text-[13px] text-white">
            {compact(staked)} TOWELI staked at{' '}
            <span style={{ color: '#22c55e', fontWeight: 600 }}>{boostX.toFixed(1)}×</span> boost
            {pos.isLocked ? (
              <span className="text-text-secondary"> · unlocks in {daysLeft}d</span>
            ) : null}
            . Nothing needs your attention.
          </p>
        </div>
      ) : (
        <m.ul variants={staggerContainer(0.06)} initial="hidden" animate="show" className="space-y-2 m-0 p-0">
          {alerts.map((a) => {
            const s = SEV[a.sev];
            return (
              <m.li
                key={a.id}
                variants={staggerItem}
                className="list-none flex items-start gap-3 p-3 rounded-lg"
                style={{ background: 'rgba(0,0,0,0.35)', border: `1px solid ${s.color}` }}
              >
                <span
                  className="flex-shrink-0 w-6 h-6 rounded-full flex items-center justify-center text-[12px] mt-0.5"
                  style={{ color: s.color, border: `1px solid ${s.color}` }}
                  aria-hidden="true"
                >
                  {s.glyph}
                </span>
                <div className="min-w-0 flex-1">
                  <p className="text-[13px] font-semibold text-white">{a.title}</p>
                  <p className="text-[12px] text-text-secondary mt-0.5">{a.detail}</p>
                </div>
                {a.cta && (
                  <Link
                    to={a.cta.to}
                    className="flex-shrink-0 self-center text-[12px] font-semibold px-3 py-1.5 rounded-lg whitespace-nowrap"
                    style={{ color: s.color, border: `1px solid ${s.color}` }}
                  >
                    {a.cta.label}
                  </Link>
                )}
              </m.li>
            );
          })}
        </m.ul>
      )}
    </div>
  );
}
