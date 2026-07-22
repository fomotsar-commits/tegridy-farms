// Presentational renderer for a detection-core DistributionAnalysis.
//
// The FIRST UI consumer of frontend/src/lib/detection. Deliberately pure + prop-
// driven (no data fetching, no simulator coupling) so any surface with a
// DistributionAnalysis — the Launch Simulator today, a live token page later —
// can render the SAME descriptive measurement the same way.
//
// HONEST FRAMING is baked in: it leads with the plain-sentence effective-holder
// headline, shows every component AND the exclusions, flags data-confidence
// SEPARATELY from the band, never dresses a null (not-measured) signal as 0, and
// always prints the method version, timestamp, caveats and correction path.

import type { Band, ConfidenceLevel, DistributionAnalysis, HolderCategory } from '../../lib/detection';

function pct(x: number, dp = 1): string {
  return `${(x * 100).toFixed(dp)}%`;
}

function num(x: number): string {
  if (x >= 100) return Math.round(x).toLocaleString();
  if (x >= 10) return x.toFixed(0);
  return x.toFixed(1);
}

const BAND_STYLE: Record<Band, { label: string; cls: string }> = {
  'well-distributed': { label: 'Well-distributed', cls: 'bg-emerald-500/20 text-emerald-300 border-emerald-500/30' },
  mixed: { label: 'Mixed', cls: 'bg-amber-500/20 text-amber-300 border-amber-500/30' },
  concentrated: { label: 'Concentrated', cls: 'bg-rose-500/20 text-rose-300 border-rose-500/30' },
};

const CONFIDENCE_STYLE: Record<ConfidenceLevel, string> = {
  high: 'bg-emerald-500/15 text-emerald-300 border-emerald-500/25',
  medium: 'bg-amber-500/15 text-amber-300 border-amber-500/25',
  low: 'bg-rose-500/15 text-rose-300 border-rose-500/25',
};

const CATEGORY_LABEL: Record<HolderCategory, string> = {
  eoa: 'Wallets (counted)',
  unclassified: 'Unlabeled large wallets',
  lp: 'Liquidity pools',
  cex: 'Exchange wallets',
  bridge: 'Bridges',
  burn: 'Burn / dead',
  locker: 'Lock / vesting / treasury',
  contract: 'Other contracts',
  pda: 'Program accounts (PDA)',
};

function Metric({ label, value, hint, tone }: { label: string; value: string; hint?: string; tone?: 'muted' }) {
  return (
    <div className="rounded-xl border border-white/10 bg-black/20 p-3">
      <div className="text-white/50 text-[11px] leading-tight">{label}</div>
      <div className={`mt-1 text-lg font-semibold tabular-nums ${tone === 'muted' ? 'text-white/60' : 'text-white'}`}>{value}</div>
      {hint && <div className="text-white/35 text-[10px] mt-0.5 leading-tight">{hint}</div>}
    </div>
  );
}

/** Behavioural share that self-gates to "not measured" when the signal is null. */
function behavioral(value: number | null): { value: string; tone?: 'muted' } {
  return value == null ? { value: 'not measured', tone: 'muted' } : { value: pct(value) };
}

export function DistributionReport({ analysis }: { analysis: DistributionAnalysis }) {
  const m = analysis.metrics;
  const band = BAND_STYLE[analysis.band];
  const clustered = behavioral(m.clusteredSupplyShareOfTotal);
  const bundled = behavioral(m.bundledCurrentHeldShareOfTotal);
  const sniper = behavioral(m.sniperHeldShareOfTotal);
  const observed = new Date(analysis.observedAt * 1000);

  return (
    <div className="rounded-2xl border border-white/12 bg-[rgba(6,12,26,0.6)] p-5 sm:p-6">
      {/* Band + headline + confidence */}
      <div className="flex flex-wrap items-center gap-2 justify-between">
        <span className={`px-2.5 py-1 rounded-full text-xs font-semibold border ${band.cls}`}>{band.label}</span>
        <span className={`px-2 py-0.5 rounded-full text-[11px] font-medium border ${CONFIDENCE_STYLE[analysis.confidence.level]}`}>
          {analysis.confidence.level} data-confidence
        </span>
      </div>
      <p className="text-white/80 text-sm mt-3 leading-relaxed">{analysis.headline}</p>
      <p className="text-white/45 text-xs mt-1.5">{analysis.bandReason}</p>

      {/* Lead + concentration metrics */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5 mt-4">
        <Metric label="Effective holders" value={m.includedHolders > 0 ? num(m.effectiveHolders) : '—'} hint="inverse-Simpson (lead)" />
        <Metric label="Holders counted" value={m.includedHolders.toLocaleString()} hint={`${analysis.holderCounts.excluded} excluded`} />
        <Metric label="Top-1 share" value={m.includedHolders > 0 ? pct(m.topN.top1) : '—'} hint="of person-held supply" />
        <Metric label="Top-10 share" value={m.includedHolders > 0 ? pct(m.topN.top10) : '—'} />
        <Metric label="HHI" value={m.includedHolders > 0 ? m.hhi.toFixed(3) : '—'} hint="Σ(share²)" />
        <Metric label="Nakamoto" value={m.includedHolders > 0 ? String(m.nakamotoCoefficient) : '—'} hint=">50% takes N holders" />
        <Metric label="Gini" value={m.includedHolders > 1 ? m.gini.toFixed(2) : '—'} hint="secondary — address ≠ person" tone="muted" />
        <Metric label="Person-held" value={pct(analysis.includedSupplyShareOfTotal)} hint={`${pct(analysis.excludedSupplyShareOfTotal)} excluded`} />
      </div>

      {/* Behavioural shares (of TOTAL supply) — self-gate to "not measured" */}
      <div className="grid grid-cols-3 gap-2.5 mt-2.5">
        <Metric label="Largest cluster" value={clustered.value} tone={clustered.tone} hint="coordinated, of total" />
        <Metric label="Bundle still held" value={bundled.value} tone={bundled.tone} hint="of total" />
        <Metric label="Sniper-held" value={sniper.value} tone={sniper.tone} hint="of total" />
      </div>

      {/* Exclusions — "show the exclusions" */}
      {analysis.exclusions.buckets.length > 0 && (
        <div className="mt-4">
          <div className="text-white/60 text-xs font-semibold mb-1.5">
            Labels & exclusions{' '}
            <span className="text-white/35 font-normal">(“—” rows are removed before the concentration math; “•” are counted)</span>
          </div>
          <div className="rounded-xl border border-white/10 overflow-hidden">
            {analysis.exclusions.buckets.map((b, i) => (
              <div key={b.category} className={`flex items-center justify-between px-3 py-1.5 text-xs ${i % 2 ? 'bg-white/[0.02]' : ''}`}>
                <span className="flex items-center gap-2">
                  <span className={b.excluded ? 'text-white/30' : 'text-emerald-400/70'}>{b.excluded ? '—' : '•'}</span>
                  <span className="text-white/70">{CATEGORY_LABEL[b.category] ?? b.category}</span>
                  <span className="text-white/30">×{b.count}</span>
                </span>
                <span className="text-white/50 tabular-nums">{pct(b.shareOfTotal)}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Confidence reasons */}
      <div className="mt-4">
        <div className="text-white/60 text-xs font-semibold mb-1">Data-confidence notes</div>
        <ul className="space-y-1">
          {analysis.confidence.reasons.map((r) => (
            <li key={r} className="text-white/45 text-[11px] leading-relaxed flex gap-1.5">
              <span className="text-white/25">·</span>
              <span>{r}</span>
            </li>
          ))}
        </ul>
      </div>

      {/* Caveats + correction path + method/timestamp */}
      <div className="mt-4 pt-3 border-t border-white/10">
        <ul className="space-y-1 mb-2">
          {analysis.caveats.map((c) => (
            <li key={c} className="text-white/35 text-[10px] leading-relaxed">{c}</li>
          ))}
        </ul>
        <p className="text-white/35 text-[10px] leading-relaxed">{analysis.correctionPath}</p>
        <p className="text-white/25 text-[10px] mt-2">
          {analysis.method.version} · measured {observed.toISOString().slice(0, 16).replace('T', ' ')} UTC · this is a descriptive
          measurement, not a verdict.
        </p>
      </div>
    </div>
  );
}
