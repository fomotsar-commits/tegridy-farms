import { useState } from 'react';
import { m } from 'framer-motion';
import type { ScanOutcome } from '../../lib/scanner';
import type { Band, ConfidenceLevel, HolderCategory } from '../../lib/detection';

// Presentational render of a completed scan — the descriptive measurement, framed
// as a measurement (disclosed method, components, exclusions, timestamp, correction
// path) and NEVER as a fraud verdict. Every share/metric shown is real; anything the
// source did not measure renders as "not measured", not as a flattering zero.

const BAND_STYLE: Record<Band, { label: string; color: string; tint: string; border: string; blurb: string }> = {
  'well-distributed': {
    label: 'Well distributed',
    color: 'var(--color-success)',
    tint: 'rgba(49,208,170,0.12)',
    border: 'rgba(49,208,170,0.40)',
    blurb: 'Supply is spread across many independent holders in this read.',
  },
  mixed: {
    label: 'Mixed',
    color: 'var(--color-warning)',
    tint: 'rgba(255,178,55,0.12)',
    border: 'rgba(255,178,55,0.40)',
    blurb: 'Some concentration alongside a broader base — worth a closer look.',
  },
  concentrated: {
    label: 'Concentrated',
    color: 'var(--color-danger)',
    tint: 'rgba(255,78,163,0.12)',
    border: 'rgba(255,78,163,0.40)',
    blurb: 'A small number of holders control a large share in this read.',
  },
};

const CONFIDENCE_STYLE: Record<ConfidenceLevel, { label: string; color: string }> = {
  high: { label: 'High confidence', color: 'var(--color-success)' },
  medium: { label: 'Medium confidence', color: 'var(--color-warning)' },
  low: { label: 'Low confidence', color: 'var(--color-danger)' },
};

const CATEGORY_LABEL: Record<HolderCategory, string> = {
  eoa: 'Wallet',
  unclassified: 'Unlabeled large wallet',
  lp: 'Liquidity pool',
  cex: 'Exchange wallet',
  bridge: 'Bridge',
  burn: 'Burn address',
  locker: 'Lock / vesting',
  contract: 'Contract',
  pda: 'Program account (PDA)',
};

function pct(x: number | null | undefined, digits = 1): string {
  if (x == null || Number.isNaN(x)) return 'not measured';
  return `${(x * 100).toFixed(digits)}%`;
}

function roundEff(n: number): string {
  if (n <= 0) return '—';
  return n >= 10 ? String(Math.round(n)) : String(Math.round(n * 10) / 10);
}

function StatTile({
  label,
  value,
  sub,
  muted,
}: {
  label: string;
  value: string;
  sub?: string;
  muted?: boolean;
}) {
  return (
    <div
      className="rounded-lg p-3"
      style={{ background: 'var(--color-bg-elevated)', border: '1px solid var(--color-border)', opacity: muted ? 0.7 : 1 }}
    >
      <p className="text-[10px] uppercase tracking-wider text-text-muted mb-1">{label}</p>
      <p className="text-[18px] font-semibold text-text-primary leading-none">{value}</p>
      {sub && <p className="text-[11px] text-text-secondary mt-1">{sub}</p>}
    </div>
  );
}

export function ScanReport({ outcome }: { outcome: ScanOutcome }) {
  const { analysis, token, chain, address } = outcome;
  const band = BAND_STYLE[analysis.band];
  const conf = CONFIDENCE_STYLE[analysis.confidence.level];
  const m2 = analysis.metrics;
  const observed = new Date(analysis.observedAt * 1000);
  const [copied, setCopied] = useState(false);

  const firedFindings = analysis.gate.findings.filter((f) => f.fired);

  function copyCorrection() {
    const report = [
      'Token distribution scan — label / data correction',
      `Chain: ${chain}`,
      `Address: ${address}`,
      `Measured at: ${observed.toISOString()}`,
      `Method: ${analysis.method.version}`,
      `Verdict: ${band.label} (${conf.label})`,
      '',
      'What I believe is mislabeled or missing (please describe the address and the correct label):',
      '',
    ].join('\n');
    navigator.clipboard?.writeText(report).then(
      () => {
        setCopied(true);
        setTimeout(() => setCopied(false), 2500);
      },
      () => setCopied(false),
    );
  }

  return (
    <m.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.25 }} className="space-y-4">
      {/* ── Verdict header ─────────────────────────────────────────── */}
      <div className="rounded-xl p-5" style={{ background: band.tint, border: `1px solid ${band.border}` }}>
        <div className="flex flex-wrap items-center gap-3 mb-2">
          <span className="text-[22px] md:text-[26px] font-bold leading-none" style={{ color: band.color }}>
            {band.label}
          </span>
          <span
            className="rounded-full px-2.5 py-1 text-[11px] font-semibold"
            style={{ background: 'var(--color-bg-elevated)', color: conf.color, border: `1px solid ${conf.color}` }}
          >
            {conf.label}
          </span>
        </div>
        <p className="text-[13.5px] text-text-primary mb-1">{band.blurb}</p>
        {/* LEAD METRIC — inverse-Simpson, as a plain sentence (never a fraud claim). */}
        <p className="text-[13px] text-text-secondary">{analysis.headline}</p>
        <p className="text-[11px] text-text-muted mt-2">
          {(token.symbol || token.name) && (
            <span className="text-text-secondary font-medium">{token.symbol || token.name} · </span>
          )}
          Measured {observed.toLocaleString()} · {outcome.source}
        </p>
      </div>

      {/* ── Why this band ──────────────────────────────────────────── */}
      <div className="glass-card rounded-xl p-4">
        <p className="text-[12px] text-text-secondary">{analysis.bandReason}</p>
      </div>

      {/* ── Concentration components ───────────────────────────────── */}
      <div className="glass-card rounded-xl p-4">
        <h3 className="text-[13px] font-semibold text-text-primary mb-3">Concentration components</h3>
        <div className="grid grid-cols-2 md:grid-cols-3 gap-2.5">
          <StatTile label="Effective holders (N_eff)" value={roundEff(m2.effectiveHolders)} sub={`over ${m2.includedHolders} holders`} />
          <StatTile label="Largest holder" value={pct(m2.top1ShareOfTotal)} sub="of total supply" />
          <StatTile label="Top 10 holders" value={pct(m2.topN.top10)} sub="of person-held supply" />
          <StatTile label="Nakamoto" value={m2.includedHolders > 0 ? String(m2.nakamotoCoefficient) : '—'} sub="holders to pass 50%" />
          <StatTile label="HHI" value={m2.includedHolders > 0 ? m2.hhi.toFixed(3) : '—'} sub="Σ(share²)" />
          <StatTile label="Gini (secondary)" value={m2.includedHolders > 1 ? m2.gini.toFixed(2) : '—'} sub="address ≠ person" muted />
        </div>
        {/* Behavioral shares — only shown as measured; a gap stays a gap. */}
        <div className="grid grid-cols-2 md:grid-cols-3 gap-2.5 mt-2.5">
          <StatTile
            label="Largest cluster"
            value={m2.clusteredSupplyShareOfTotal == null ? 'not measured' : pct(m2.clusteredSupplyShareOfTotal)}
            sub="coordinated, of total"
            muted={m2.clusteredSupplyShareOfTotal == null}
          />
          <StatTile
            label="Bundled (held)"
            value={m2.bundledCurrentHeldShareOfTotal == null ? 'not measured' : pct(m2.bundledCurrentHeldShareOfTotal)}
            sub="of total supply"
            muted={m2.bundledCurrentHeldShareOfTotal == null}
          />
          <StatTile
            label="Sniper held"
            value={m2.sniperHeldShareOfTotal == null ? 'not measured' : pct(m2.sniperHeldShareOfTotal)}
            sub="of total supply"
            muted={m2.sniperHeldShareOfTotal == null}
          />
        </div>
      </div>

      {/* ── Hard-fact checks (the weakest-link gate) ───────────────── */}
      <div className="glass-card rounded-xl p-4">
        <h3 className="text-[13px] font-semibold text-text-primary mb-1">Hard-fact checks</h3>
        <p className="text-[11px] text-text-muted mb-3">
          Facts that can override the distribution read. Unknown facts are shown but never counted against a token.
        </p>
        <ul className="space-y-2">
          {analysis.gate.findings.map((f) => {
            // Split deliberately, not golfed into one regex. CodeQL flagged the
            // original `/unknown|not measured|not present|renounced|locked\.$/i` HIGH
            // for misleading operator precedence, and it was right: `$` binds only to
            // the final alternative, so four of the five matched ANYWHERE while the
            // fifth had to be at the END. That is what the author meant, but nothing
            // in the source said so, and the next person to add an alternative would
            // have had to rediscover it. Behaviour here is identical.
            const hasUnknownPhrase = /unknown|not measured|not present|renounced/i.test(f.detail);
            const endsWithLocked = /locked\.$/i.test(f.detail);
            const unknown = (hasUnknownPhrase || endsWithLocked) && !f.fired;
            const dotColor = f.fired ? 'var(--color-danger)' : unknown ? 'var(--color-text-muted)' : 'var(--color-success)';
            return (
              <li key={f.id} className="flex items-start gap-2">
                <span className="mt-1.5 w-2 h-2 rounded-full flex-shrink-0" style={{ background: dotColor }} />
                <span className="text-[12px] text-text-secondary">{f.detail}</span>
              </li>
            );
          })}
        </ul>
        {firedFindings.length > 0 && (
          <p className="text-[11px] mt-3" style={{ color: 'var(--color-danger)' }}>
            {firedFindings.length} hard-fact {firedFindings.length === 1 ? 'check' : 'checks'} set a floor on this verdict.
          </p>
        )}
      </div>

      {/* ── Exclusions ─────────────────────────────────────────────── */}
      <div className="glass-card rounded-xl p-4">
        <h3 className="text-[13px] font-semibold text-text-primary mb-1">What was excluded before the math</h3>
        <p className="text-[11px] text-text-muted mb-3">
          Pools, exchanges, bridges, burns, lockers and contracts are not people holding the token, so they are removed
          before any concentration is computed. {pct(analysis.includedSupplyShareOfTotal)} of supply counts as person-held.
        </p>
        <div className="overflow-x-auto">
          <table className="w-full text-[12px]">
            <thead>
              <tr className="text-text-muted text-[10px] uppercase tracking-wider">
                <th className="text-left font-medium pb-1.5">Category</th>
                <th className="text-right font-medium pb-1.5">Addresses</th>
                <th className="text-right font-medium pb-1.5">Share of supply</th>
                <th className="text-right font-medium pb-1.5">Counted?</th>
              </tr>
            </thead>
            <tbody>
              {analysis.exclusions.buckets.map((b) => (
                <tr key={b.category} style={{ borderTop: '1px solid var(--color-border)' }}>
                  <td className="py-1.5 text-text-secondary">{CATEGORY_LABEL[b.category]}</td>
                  <td className="py-1.5 text-right text-text-secondary">{b.count.toLocaleString()}</td>
                  <td className="py-1.5 text-right text-text-secondary">{pct(b.shareOfTotal, 2)}</td>
                  <td className="py-1.5 text-right">
                    <span style={{ color: b.excluded ? 'var(--color-text-muted)' : 'var(--color-success)' }}>
                      {b.excluded ? 'excluded' : 'counted'}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* ── Data confidence ────────────────────────────────────────── */}
      <div className="glass-card rounded-xl p-4">
        <h3 className="text-[13px] font-semibold text-text-primary mb-2">
          Data confidence: <span style={{ color: conf.color }}>{conf.label}</span>
        </h3>
        <ul className="space-y-1.5">
          {analysis.confidence.reasons.map((r, i) => (
            <li key={i} className="text-[12px] text-text-secondary flex items-start gap-2">
              <span className="mt-1.5 w-1.5 h-1.5 rounded-full flex-shrink-0" style={{ background: conf.color }} />
              {r}
            </li>
          ))}
        </ul>
      </div>

      {/* ── Coverage + caveats ─────────────────────────────────────── */}
      {(outcome.coverageNotes.length > 0 || analysis.caveats.length > 0) && (
        <div className="glass-card rounded-xl p-4">
          <h3 className="text-[13px] font-semibold text-text-primary mb-2">Read this with</h3>
          <ul className="space-y-1.5">
            {outcome.coverageNotes.map((n, i) => (
              <li key={`c${i}`} className="text-[12px] text-text-secondary">• {n}</li>
            ))}
            {analysis.caveats.map((c, i) => (
              <li key={`v${i}`} className="text-[12px] text-text-muted">• {c}</li>
            ))}
          </ul>
        </div>
      )}

      {/* ── Method + correction path ───────────────────────────────── */}
      <div className="glass-card rounded-xl p-4">
        <details>
          <summary className="text-[13px] font-semibold text-text-primary cursor-pointer select-none">
            Method &amp; how to dispute a label
          </summary>
          <p className="text-[12px] text-text-secondary mt-2">{analysis.method.description}</p>
          <p className="text-[11px] text-text-muted mt-2">Method version: {analysis.method.version}</p>
          <p className="text-[12px] text-text-secondary mt-3">{analysis.correctionPath}</p>
          <button
            onClick={copyCorrection}
            className="btn-secondary text-[12px] px-3 py-1.5 mt-3"
            type="button"
          >
            {copied ? 'Copied correction report' : 'Copy a correction report'}
          </button>
        </details>
      </div>
    </m.div>
  );
}
