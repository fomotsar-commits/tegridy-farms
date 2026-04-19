/**
 * YieldCalculator — wallet-less read-only estimator for HomePage.
 *
 * Why this exists:
 *   First-time visitors bounced at "Connect Wallet" because they couldn't
 *   see what the yield actually looks like before committing. This lets
 *   them enter an amount and lock duration, see their boost and estimated
 *   APR, and THEN decide to connect.
 *
 * What it is:
 *   Pure client-side math — no reads from chain, no wallet required.
 *   Inputs: TOWELI amount, lock duration.
 *   Outputs: Boost multiplier, monthly and annual yield in ETH equivalent,
 *   assuming a baseline APR published in the Farm stats.
 *
 * The baseline APR is a conservative reference number. Actual yield depends
 * on live TVL, swap volume, and gauge-directed emissions — hence the
 * "estimated" framing throughout.
 */
import { useMemo, useState } from 'react';
import { m } from 'framer-motion';
import { Link } from 'react-router-dom';
import { LOCK_DURATIONS } from '../../lib/copy';

// Conservative reference baseline. Real yield varies with TVL and volume.
// Source: recent RevenueDistributor streams + LP farming emissions.
// Update this quarterly or wire to a live stat when the indexer is in place.
const BASELINE_APR_PCT = 12; // 12% as a starting reference

interface Tier {
  days: number;
  label: string;
  sublabel: string;
  boost: number; // multiplier, e.g. 1.5 means 1.5x
}

const TIERS: Tier[] = LOCK_DURATIONS.map((d) => {
  // Linear-ish boost curve matching TegridyStaking's MIN_BOOST_BPS (0.4x) → MAX_BOOST_BPS (4.0x)
  // over 7 days → 1460 days. Approximation only — actual boost is on-chain math.
  const ratio = Math.max(0, (d.days - 7) / (1460 - 7));
  const boost = 0.4 + ratio * (4.0 - 0.4);
  return {
    days: d.days,
    label: d.label,
    sublabel: d.sublabel,
    boost: Math.round(boost * 10) / 10,
  };
});

function formatUsd(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '$0.00';
  if (n < 1) return `$${n.toFixed(3)}`;
  if (n < 100) return `$${n.toFixed(2)}`;
  if (n < 10000) return `$${n.toLocaleString(undefined, { maximumFractionDigits: 2 })}`;
  return `$${n.toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
}

export function YieldCalculator() {
  const [amountStr, setAmountStr] = useState<string>('1000');
  const [selectedIdx, setSelectedIdx] = useState<number>(3); // default to "The Long Haul" (1yr)
  const [hasJbac, setHasJbac] = useState<boolean>(false);

  const amount = Math.max(0, parseFloat(amountStr) || 0);
  const tier = (TIERS[selectedIdx] ?? TIERS[0])!;

  const result = useMemo(() => {
    const jbacBonus = hasJbac ? 0.5 : 0;
    const effectiveBoost = Math.min(tier.boost + jbacBonus, 4.5);
    // Reference-only: linear scaling of baseline APR by boost multiplier.
    // Real math is share-of-pool weighted; this is deliberately conservative.
    const apr = BASELINE_APR_PCT * effectiveBoost;
    const annualUsd = amount * (apr / 100);
    const monthlyUsd = annualUsd / 12;
    return { effectiveBoost, apr, annualUsd, monthlyUsd };
  }, [amount, tier, hasJbac]);

  return (
    <m.section
      initial={{ opacity: 0, y: 16 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.4, delay: 0.2 }}
      className="rounded-2xl overflow-hidden"
      style={{
        background: 'rgba(13, 21, 48, 0.6)',
        border: '1px solid rgba(245, 228, 184, 0.15)',
        backdropFilter: 'blur(12px)',
      }}
      aria-label="Yield calculator"
    >
      <header className="px-5 py-4 border-b border-white/5 flex items-center justify-between flex-wrap gap-2">
        <div>
          <h3 className="text-white font-semibold text-[15px] tracking-tight">See what you'd earn</h3>
          <p className="text-white/50 text-[11px] mt-0.5">
            Reference estimate. No wallet required. Real yield varies with TVL and swap volume.
          </p>
        </div>
        <span className="text-[10px] uppercase tracking-wider text-white/40 px-2 py-0.5 rounded-full border border-white/10">
          Baseline {BASELINE_APR_PCT}% APR
        </span>
      </header>

      <div className="p-5 space-y-5">
        {/* Amount input */}
        <div>
          <label htmlFor="yc-amount" className="block text-[11px] uppercase tracking-wider text-white/50 mb-1.5">
            TOWELI amount (USD equivalent)
          </label>
          <div className="relative">
            <span className="absolute left-3 top-1/2 -translate-y-1/2 text-white/50 text-[14px]" aria-hidden="true">$</span>
            <input
              id="yc-amount"
              type="number"
              inputMode="decimal"
              min="0"
              step="1"
              value={amountStr}
              onChange={(e) => setAmountStr(e.target.value)}
              placeholder="1000"
              className="w-full bg-transparent text-white text-[16px] font-mono py-2.5 pl-7 pr-3 rounded-lg outline-none"
              style={{ background: 'rgba(0,0,0,0.3)', border: '1px solid rgba(255,255,255,0.08)' }}
              aria-describedby="yc-amount-hint"
            />
          </div>
          <p id="yc-amount-hint" className="text-white/40 text-[10px] mt-1">
            Enter a USD-equivalent amount you'd consider staking.
          </p>
        </div>

        {/* Lock duration picker */}
        <div>
          <span className="block text-[11px] uppercase tracking-wider text-white/50 mb-1.5">
            Lock duration
          </span>
          <div
            role="radiogroup"
            aria-label="Lock duration"
            className="grid grid-cols-2 sm:grid-cols-3 gap-2"
          >
            {TIERS.map((t, idx) => {
              const selected = idx === selectedIdx;
              return (
                <button
                  key={t.days}
                  type="button"
                  role="radio"
                  aria-checked={selected}
                  onClick={() => setSelectedIdx(idx)}
                  className="rounded-lg px-3 py-2 text-left transition-all"
                  style={{
                    background: selected ? 'rgba(245, 228, 184, 0.10)' : 'rgba(0,0,0,0.3)',
                    border: `1px solid ${selected ? 'rgba(245, 228, 184, 0.35)' : 'rgba(255,255,255,0.08)'}`,
                  }}
                >
                  <div className="text-white text-[12px] font-semibold leading-tight">{t.label}</div>
                  <div className="text-white/50 text-[10px] mt-0.5">{t.sublabel} · {t.boost.toFixed(1)}×</div>
                </button>
              );
            })}
          </div>
        </div>

        {/* JBAC bonus toggle */}
        <label className="flex items-center gap-2.5 cursor-pointer select-none">
          <input
            type="checkbox"
            checked={hasJbac}
            onChange={(e) => setHasJbac(e.target.checked)}
            className="w-4 h-4 rounded accent-[#8b5cf6]"
          />
          <span className="text-white/80 text-[12px]">
            I hold a JBAC NFT (+0.5× boost)
          </span>
        </label>

        {/* Results */}
        <div
          className="rounded-xl p-4 grid grid-cols-3 gap-3"
          style={{ background: 'rgba(139, 92, 246, 0.08)', border: '1px solid rgba(139, 92, 246, 0.20)' }}
          aria-live="polite"
        >
          <div>
            <div className="text-[10px] uppercase tracking-wider text-white/50">Effective boost</div>
            <div className="text-white text-[18px] font-semibold mt-0.5 font-mono">{result.effectiveBoost.toFixed(1)}×</div>
          </div>
          <div>
            <div className="text-[10px] uppercase tracking-wider text-white/50">Est. monthly</div>
            <div className="text-white text-[18px] font-semibold mt-0.5 font-mono">{formatUsd(result.monthlyUsd)}</div>
          </div>
          <div>
            <div className="text-[10px] uppercase tracking-wider text-white/50">Est. 1 year</div>
            <div className="text-white text-[18px] font-semibold mt-0.5 font-mono">{formatUsd(result.annualUsd)}</div>
          </div>
        </div>

        {/* CTA */}
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <p className="text-white/50 text-[10px] max-w-[60%]">
            Estimates assume baseline {BASELINE_APR_PCT}% APR scaled by boost. Real yield depends on live pool revenue.
          </p>
          <Link
            to="/farm"
            className="btn-primary px-5 py-2 text-[13px] inline-flex items-center gap-1.5"
            aria-label="Go to Farm page to stake"
          >
            Start farming
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <line x1="5" y1="12" x2="19" y2="12" />
              <polyline points="12 5 19 12 12 19" />
            </svg>
          </Link>
        </div>
      </div>
    </m.section>
  );
}

export default YieldCalculator;
