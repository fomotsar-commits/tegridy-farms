// The unified portfolio panel.
//
// Rendering rules, in priority order — the layout below is downstream of these:
//
//   1. When `total.usd` is null there is NO figure. Not "$0.00", not a dash standing in
//      for a number, not a shimmer that implies one is coming. The slot says what is
//      missing instead.
//   2. When the total is PARTIAL the notice sits ABOVE the figure and names every
//      excluded source. A caveat placed below a large number is read after the number
//      has already been believed.
//   3. The age stamp is the OLDEST contributing source's, and says so. When the sources
//      were not read together, the spread is stated in seconds rather than softened to
//      "recently".
//   4. Out-of-scope sources are listed on every render, including a `complete` one,
//      because "complete" here means "every source we track", and a user cannot know
//      what we track unless we print it.

import { m } from 'framer-motion';
import { formatCurrency, formatTimeAgo } from '../../lib/formatting';
import type { PortfolioSourceReport, PortfolioSourceState, PortfolioTotal } from '../../lib/portfolio/types';

export interface UnifiedPortfolioProps {
  sources: PortfolioSourceReport[];
  total: PortfolioTotal;
  summary: string;
  onRefresh?: () => void;
  isRefreshing?: boolean;
}

const STATE_LABEL: Record<PortfolioSourceState, string> = {
  ok: 'Read',
  loading: 'Loading',
  unavailable: 'Unavailable',
  unpriced: 'Unpriced',
  'out-of-scope': 'Not tracked',
};

const STATE_STYLE: Record<PortfolioSourceState, { background: string; color: string }> = {
  ok: { background: 'rgba(34,197,94,0.15)', color: '#4ade80' },
  loading: { background: 'rgba(255,255,255,0.10)', color: 'rgba(255,255,255,0.72)' },
  unavailable: { background: 'rgba(239,68,68,0.16)', color: '#fca5a5' },
  unpriced: { background: 'rgba(245,158,11,0.15)', color: '#fbbf24' },
  'out-of-scope': { background: 'rgba(255,255,255,0.07)', color: 'rgba(255,255,255,0.60)' },
};

export function UnifiedPortfolio({ sources, total, summary, onRefresh, isRefreshing }: UnifiedPortfolioProps) {
  const isPartial = total.completeness === 'partial';
  const isUnavailable = total.completeness === 'unavailable';

  return (
    <m.section
      aria-label="Unified portfolio"
      className="relative overflow-hidden rounded-xl glass-card-animated mb-6"
      style={{ border: '1px solid var(--color-purple-75)', background: 'rgba(6,12,26,0.72)' }}
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
    >
      <div className="relative z-10 p-4 md:p-5">
        <div className="flex items-center justify-between gap-3 flex-wrap mb-3">
          <h2 className="heading-luxury text-[16px] text-white">Portfolio</h2>
          {onRefresh && (
            <button
              type="button"
              onClick={onRefresh}
              disabled={isRefreshing}
              aria-label="Refresh portfolio data"
              className="text-white/55 hover:text-white transition-colors disabled:opacity-50"
            >
              <svg
                className={`w-3.5 h-3.5 ${isRefreshing ? 'animate-spin' : ''}`}
                viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
                strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"
              >
                <path d="M21 12a9 9 0 1 1-2.64-6.36" />
                <polyline points="21 3 21 9 15 9" />
              </svg>
            </button>
          )}
        </div>

        {/* Rule 2 — the caveat precedes the figure it qualifies. */}
        {(isPartial || isUnavailable) && (
          <div
            role="status"
            aria-live="polite"
            className="mb-3 px-3 py-2.5 rounded-lg"
            style={{
              background: isUnavailable ? 'rgba(239,68,68,0.10)' : 'rgba(245,158,11,0.10)',
              border: `1px solid ${isUnavailable ? 'rgba(239,68,68,0.30)' : 'rgba(245,158,11,0.30)'}`,
            }}
          >
            <p className="text-[12px] leading-snug" style={{ color: isUnavailable ? '#fca5a5' : '#fcd34d' }}>
              {summary}
            </p>
          </div>
        )}

        {/* Rule 1 — no figure without a total. */}
        <div className="flex items-baseline gap-3 flex-wrap">
          {total.usd === null ? (
            <span className="stat-value text-2xl md:text-3xl" style={{ color: '#fca5a5' }}>
              No total available
            </span>
          ) : (
            <span className="stat-value text-2xl md:text-3xl text-white">{formatCurrency(total.usd)}</span>
          )}
          <span className="text-white/70 text-[13px]">
            {isPartial ? 'Partial portfolio value' : 'Portfolio value'}
          </span>
        </div>

        {/* Rule 3 — the total is only as fresh as its stalest contributing leg. */}
        <p className="text-white/45 text-[11px] mt-1.5" aria-live="polite">
          {total.asOfOldest === null
            ? 'No source has been read yet.'
            : `As of ${formatTimeAgo(total.asOfOldest)} — the oldest of the ${total.counted.length} source${total.counted.length === 1 ? '' : 's'} in this total.`}
          {total.mixedFreshness && total.freshnessSpreadSec !== null && (
            <span style={{ color: '#fbbf24' }}>
              {' '}Sources were not read together: {total.freshnessSpreadSec}s between the oldest and newest.
            </span>
          )}
        </p>

        <ul className="mt-4 space-y-1.5">
          {sources.map((s) => (
            <li
              key={s.id}
              className="flex items-start justify-between gap-3 px-3 py-2 rounded-lg"
              style={{ background: 'rgba(0,0,0,0.35)', border: '1px solid rgba(255,255,255,0.07)' }}
            >
              <div className="min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-white text-[12px]">{s.label}</span>
                  <span
                    className="px-1.5 py-0.5 rounded text-[9px] font-semibold uppercase tracking-wide"
                    style={STATE_STYLE[s.state]}
                  >
                    {STATE_LABEL[s.state]}
                  </span>
                </div>
                {s.detail && <p className="text-white/50 text-[11px] mt-0.5 leading-snug">{s.detail}</p>}
              </div>
              <span className="stat-value text-[13px] shrink-0" style={{ color: s.usd === null ? 'rgba(255,255,255,0.40)' : '#ffffff' }}>
                {s.usd === null ? 'not counted' : formatCurrency(s.usd)}
              </span>
            </li>
          ))}
        </ul>

        {/* Rule 4 — standing scope disclosure, printed even when nothing failed. */}
        {total.outOfScope.length > 0 && (
          <p className="text-white/45 text-[11px] mt-3 leading-snug">
            Outside this total: {total.outOfScope.map((o) => `${o.label} (${o.reason})`).join('; ')}.
          </p>
        )}
      </div>
    </m.section>
  );
}
