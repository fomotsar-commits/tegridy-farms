// "Delta to pass each band" — the design-tool half of the simulator.
//
// For each band better than where the token currently sits, it shows exactly
// what is blocking it: the hard gate findings (each with a plain-language fix)
// and, when the soft blend is over the cutoff, the ranked levers with per-signal
// guideline thresholds. This turns the detection score into a checklist a dev
// can act on BEFORE launching, instead of an opaque grade.
//
// HONEST FRAMING: single-lever targets are labelled as one-change-in-isolation
// guidance (signals interact), never as a guaranteed recipe; guideline endpoints
// are read straight from the scoring ramps, not invented.

import type { BandTarget, SoftLever } from '../../lib/launchSim/simulate';
import type { Band } from '../../lib/detection';

const BAND_TITLE: Record<Band, string> = {
  'well-distributed': 'Well-distributed',
  mixed: 'Mixed',
  concentrated: 'Concentrated',
};

function pct(x: number, dp = 1): string {
  return `${(x * 100).toFixed(dp)}%`;
}

/** Format a lever value/target in the signal's natural unit. */
function leverUnit(id: string, v: number): string {
  if (id === 'effectiveHolders') return `${v >= 10 ? Math.round(v) : v.toFixed(1)} holders`;
  if (id === 'nakamoto') return `${Math.max(1, Math.round(v))} holders`;
  if (id === 'gini') return v.toFixed(2);
  return pct(v);
}

function LeverRow({ lever }: { lever: SoftLever }) {
  const arrow = lever.direction === 'lower' ? '↓' : '↑';
  const guide =
    lever.direction === 'lower'
      ? `guideline ≤ ${leverUnit(lever.id, lever.guidelineGood)}`
      : `guideline ≥ ${leverUnit(lever.id, lever.guidelineGood)}`;
  const target =
    lever.singleLeverTarget != null
      ? `${lever.direction === 'lower' ? '≤' : '≥'} ${leverUnit(lever.id, lever.singleLeverTarget)} would clear this band on its own`
      : 'also address the other levers below to clear this band';
  return (
    <li className="rounded-lg border border-white/10 bg-black/20 px-3 py-2">
      <div className="flex items-center justify-between gap-2">
        <span className="text-white/75 text-xs">{lever.label}</span>
        <span className="text-white/40 text-[10px] tabular-nums shrink-0">{Math.round(lever.contribution * 100)}% of risk</span>
      </div>
      <div className="text-white/45 text-[11px] mt-0.5">
        now <span className="text-white/70 tabular-nums">{leverUnit(lever.id, lever.value)}</span>
        <span className="text-white/30"> · {guide}</span>
      </div>
      <div className="text-emerald-300/70 text-[11px] mt-0.5">
        {arrow} {target}
      </div>
    </li>
  );
}

function TargetCard({ target }: { target: BandTarget }) {
  const met = target.met;
  return (
    <div
      className={`rounded-xl border p-4 ${
        met ? 'border-emerald-500/30 bg-emerald-500/[0.06]' : 'border-white/12 bg-black/20'
      }`}
    >
      <div className="flex items-center justify-between mb-2">
        <span className="text-white font-semibold text-sm">{BAND_TITLE[target.band]}</span>
        <span
          className={`px-2 py-0.5 rounded-full text-[11px] font-semibold border ${
            met ? 'bg-emerald-500/20 text-emerald-300 border-emerald-500/30' : 'bg-white/10 text-white/50 border-white/20'
          }`}
        >
          {met ? 'reached' : 'not yet'}
        </span>
      </div>

      {met && (
        <p className="text-emerald-200/70 text-xs">This configuration already reaches this band.</p>
      )}

      {!met && target.gateBlockers.length > 0 && (
        <div className="mb-3">
          <div className="text-rose-300/80 text-[11px] font-semibold mb-1">Hard blockers — must fix</div>
          <ul className="space-y-1.5">
            {target.gateBlockers.map((b) => (
              <li key={b.id} className="text-xs">
                <div className="text-white/70">{b.detail}</div>
                <div className="text-emerald-300/70 text-[11px] mt-0.5">→ {b.fix}</div>
              </li>
            ))}
          </ul>
        </div>
      )}

      {!met && !target.softMet && (
        <div>
          <div className="flex items-center justify-between text-[11px] mb-1.5">
            <span className="text-amber-300/80 font-semibold">Distribution levers</span>
            <span className="text-white/40 tabular-nums">
              risk {pct(target.softRisk, 0)} → need ≤ {pct(target.softCutoff, 0)}
            </span>
          </div>
          {/* single risk bar: current vs cutoff */}
          <div className="h-1.5 rounded-full bg-white/10 overflow-hidden mb-2 relative">
            <div className="h-full bg-amber-400/70" style={{ width: `${Math.min(100, target.softRisk * 100)}%` }} />
            <div
              className="absolute top-0 h-full w-px bg-emerald-300"
              style={{ left: `${Math.min(100, target.softCutoff * 100)}%` }}
              title="cutoff"
            />
          </div>
          <ul className="space-y-1.5">
            {target.levers.slice(0, 4).map((l) => (
              <LeverRow key={l.id} lever={l} />
            ))}
          </ul>
        </div>
      )}

      {!met && target.softMet && target.gateBlockers.length === 0 && (
        <p className="text-white/50 text-xs">Distribution is within range for this band.</p>
      )}
    </div>
  );
}

export function BandDeltaPanel({ targets }: { targets: BandTarget[] }) {
  return (
    <div>
      <h3 className="text-white font-semibold text-sm mb-1">What it takes to reach each band</h3>
      <p className="text-white/50 text-xs mb-3 leading-relaxed">
        Every item is derived from the same detection method buyers will see. Single-lever targets assume that one change
        in isolation — because the signals interact, treat them as direction, not a recipe. Fix the hard blockers first.
      </p>
      <div className="grid gap-3 sm:grid-cols-2">
        {targets.map((t) => (
          <TargetCard key={t.band} target={t} />
        ))}
      </div>
    </div>
  );
}
