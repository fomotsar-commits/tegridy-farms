// Launch Afterlife — the honest cohort ledger (docs/LAUNCHER_STRATEGY.md §2.5).
//
// The credibility centerpiece of the launcher: "nobody keeps public, permanent
// post-launch statistics — we do, INCLUDING our failures." LaunchExplorer lists
// the PER-LAUNCH ranked outcomes; this component is the COHORT summary above it —
// of every launch we've powered, how many are still liquid, how many drained,
// how many went quiet — measured over the SAME OutcomeRecord[] the explorer lists.
//
// Gate-safe + testable by construction: it fetches NOTHING. The parent supplies
// `outcomes` (the values of the page's outcomes map), so the surface degrades to a
// clean, honest empty state while the launcher is gated / no discovery feed has
// populated launches, and the aggregation stays pure and unit-testable in
// afterlifeLedger.ts. Nothing here endorses a token or calls one "safe"/"rug" —
// every figure is a disclosed, timestamped measurement.

import { useMemo } from 'react';
import { m } from 'framer-motion';
import {
  summarizeAfterlife,
  type AfterlifeLedgerSummary,
} from '../../lib/launcher/afterlifeLedger';
import type { OutcomeRecord } from '../../lib/launcher/outcomes';
import { ArtCard } from '../ui/ArtCard';

export interface LaunchAfterlifeProps {
  /** Tracked-launch outcome records (parent-supplied; this component never fetches). */
  outcomes: OutcomeRecord[];
}

/** Factual, signed median-price label. Null median → "—" (never a fabricated 0%). Pure; exported for tests. */
export function formatMedianReturn(median: number | null): string {
  if (median == null) return '—';
  const pct = Math.round(median * 1000) / 10;
  const sign = pct > 0 ? '+' : '';
  return `${sign}${pct}% vs launch`;
}

/** Human "as of" stamp, or null when there is nothing to stamp. Pure; exported for tests. */
export function formatAsOf(asOf: number | null): string | null {
  if (asOf == null || !Number.isFinite(asOf)) return null;
  try {
    return new Date(asOf * 1000).toLocaleString(undefined, {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return null;
  }
}

const METHOD_NOTE =
  'Measured from live pool + on-chain reads (GeckoTerminal price/liquidity, Etherscan holder + creator-activity) at the time shown. Descriptive disclosures of market-risk outcomes — not a safety rating, endorsement, or accusation.';

export function LaunchAfterlife({ outcomes }: LaunchAfterlifeProps) {
  const summary = useMemo<AfterlifeLedgerSummary>(() => summarizeAfterlife(outcomes), [outcomes]);
  const asOf = formatAsOf(summary.asOf);

  return (
    <section aria-label="Launch Afterlife ledger" className="space-y-4">
      <header>
        <h2 className="text-lg font-semibold text-white">Launch Afterlife</h2>
        <p className="text-white/50 text-xs mt-1 max-w-xl leading-relaxed">
          The permanent, public ledger of every launch this rail has powered — the ones that worked
          and the ones that didn&rsquo;t. We publish the failures too; that is the whole point.
        </p>
      </header>

      {summary.tracked === 0 ? (
        <ArtCard pageId="launch" idx={40} padding="p-8">
          <p className="text-white/80 text-sm font-medium">No launches have graduated through this rail yet</p>
          <p className="text-white/50 text-xs mt-1 max-w-md leading-relaxed">
            When they do, every one is recorded here permanently — price and liquidity versus
            graduation, holder count, and whether the team stayed active — including the launches
            that don&rsquo;t work out. Nothing is seeded and no number is invented.
          </p>
        </ArtCard>
      ) : (
        <ArtCard pageId="launch" idx={41} padding="p-4 sm:p-5">
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
            <Stat label="Launches tracked" value={summary.tracked.toLocaleString()} />
            <Stat
              label="Still liquid"
              value={summary.stillLiquid.toLocaleString()}
              tone="good"
              sub={`of ${summary.observed.toLocaleString()} read`}
            />
            <Stat label="Median price" value={formatMedianReturn(summary.medianPriceReturn)} />
            <Stat
              label="Liquidity drained"
              value={summary.liquidityDrained.toLocaleString()}
              tone={summary.liquidityDrained > 0 ? 'warn' : 'muted'}
            />
            <Stat
              label="Likely abandoned"
              value={summary.likelyAbandoned.toLocaleString()}
              tone={summary.likelyAbandoned > 0 ? 'warn' : 'muted'}
            />
            <Stat
              label="Unlock dumps"
              value={summary.unlockDumped.toLocaleString()}
              tone={summary.unlockDumped > 0 ? 'warn' : 'muted'}
            />
          </div>

          {summary.unavailable > 0 && (
            <p className="text-white/35 text-[11px] mt-3">
              {summary.unavailable.toLocaleString()} launch{summary.unavailable === 1 ? '' : 'es'} had
              market data unavailable at the last check and are excluded from the outcome tallies
              above (counted only under &ldquo;tracked&rdquo;).
            </p>
          )}

          <p className="text-white/40 text-[11px] mt-3 leading-relaxed">{METHOD_NOTE}</p>
          {asOf && <p className="text-white/35 text-[11px] mt-1">As of {asOf}.</p>}
        </ArtCard>
      )}
    </section>
  );
}

type Tone = 'good' | 'warn' | 'muted';

function Stat({
  label,
  value,
  sub,
  tone = 'muted',
}: {
  label: string;
  value: string;
  sub?: string;
  tone?: Tone;
}) {
  const valueCls =
    tone === 'good' ? 'text-emerald-300' : tone === 'warn' ? 'text-amber-300' : 'text-white/90';
  return (
    <m.div
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.25 }}
      className="rounded-xl px-3 py-2.5"
      style={{ border: '1px solid rgba(255,255,255,0.08)', background: 'rgba(255,255,255,0.02)' }}
    >
      <div className={`text-lg font-semibold tabular-nums ${valueCls}`}>{value}</div>
      <div className="text-white/45 text-[11px] mt-0.5">
        {label}
        {sub && <span className="text-white/25"> · {sub}</span>}
      </div>
    </m.div>
  );
}

export default LaunchAfterlife;
