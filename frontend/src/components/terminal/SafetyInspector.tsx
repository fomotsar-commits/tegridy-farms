import type { RowSafety } from '../../lib/terminal/rowSafety';
import { SafetyBadge } from './SafetyBadge';

// The selected row's safety, component by component.
//
// Each of the three reads is shown with its own state, because "this row is not
// scored" is not actionable and "the deployer address was never resolved on this
// build, paste it to score the row" is. The inspector is where an unread state
// stops being a shrug and becomes a next step.

export interface SafetyInspectorProps {
  token: string;
  safety: RowSafety;
  loading: boolean;
  deployer: string;
  onDeployerChange: (value: string) => void;
}

export function SafetyInspector({
  token,
  safety,
  loading,
  deployer,
  onDeployerChange,
}: SafetyInspectorProps) {
  return (
    <section className="rounded-xl border border-white/15 bg-white/[0.03] p-4" aria-label="Safety read">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-semibold text-white">Safety read</h2>
        {loading ? <span className="text-[11px] text-white/60">reading…</span> : null}
      </div>

      {!token ? (
        <p className="mt-2 text-xs text-white/70">Select a pair to read it.</p>
      ) : (
        <>
          <div className="mt-2">
            <SafetyBadge safety={safety} withDetail />
          </div>

          {safety.kind === 'scored' && safety.flags.length > 0 ? (
            <ul className="mt-3 space-y-1 text-[11px] leading-snug text-white/80">
              {safety.flags.map((flag) => (
                <li key={flag.id}>· {flag.note}</li>
              ))}
            </ul>
          ) : null}

          {safety.kind === 'scored' && safety.gaps.length > 0 ? (
            <ul className="mt-3 space-y-1 text-[11px] leading-snug text-white/70">
              {safety.gaps.map((gap) => (
                <li key={gap}>· {gap}</li>
              ))}
            </ul>
          ) : null}

          {safety.kind === 'unscored' ? (
            <ul className="mt-3 space-y-1 text-[11px] leading-snug text-white/70">
              {safety.reasons.map((reason) => (
                <li key={reason}>· {reason}</li>
              ))}
            </ul>
          ) : null}

          <div className="mt-3 border-t border-white/10 pt-3">
            <h3 className="text-[11px] font-semibold uppercase tracking-wide text-white/60">
              Heat standing
            </h3>
            {safety.heat.state === 'read' ? (
              <p className="mt-1 text-xs text-white/80">
                {safety.heat.value.tier} · {safety.heat.value.degrees} degrees
                {safety.heat.value.isCold ? ' · no island tokens held' : ''}
              </p>
            ) : (
              <p className="mt-1 text-xs text-white/70">{safety.heat.reason}</p>
            )}
            <p className="mt-1 text-[10px] leading-snug text-white/55">
              Heat measures how long a wallet has held island tokens. It is shown here and is
              deliberately excluded from the safety result: a new wallet is not a hazard and a
              tenured one is not a guarantee.
            </p>
          </div>

          <label className="mt-3 block text-[11px] font-medium uppercase tracking-wide text-white/60">
            Deployer address
            <input
              type="text"
              value={deployer}
              onChange={(e) => onDeployerChange(e.target.value)}
              spellCheck={false}
              className="mt-1 w-full rounded-md border border-white/20 bg-black/30 px-2 py-1.5 font-mono text-xs text-white"
              placeholder="0x…"
            />
          </label>
          <p className="mt-1 text-[10px] leading-snug text-white/55">
            This build has no contract-creator lookup, so the deploying address cannot be resolved
            automatically. Until one is supplied the deployer half of the read is missing and the
            row stays unrated.
          </p>
        </>
      )}
    </section>
  );
}
