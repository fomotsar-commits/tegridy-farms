import { useShieldPositions } from '../../hooks/useShieldPositions';
import { useShieldAlerts } from '../../hooks/useShieldAlerts';
import { SHIELD_COPY } from '../../lib/shield/automation';
import { ShieldAutomationNotice } from './ShieldAutomationNotice';
import { ShieldCoverageNotice } from './ShieldCoverageNotice';
import { ShieldPositionCard } from './ShieldPositionCard';

// The shield surface.
//
// Order is load-bearing: the "not automated" notice renders before any position,
// so the claim about who executes is read before the row that makes a user want
// to believe otherwise.
//
// The four snapshot states are four different screens, and `unreadable` is not
// allowed to look like `ready` with nothing in it. That collapse — an outage
// rendering as "no positions at risk" — is the bug this whole slice is arranged
// around.

export function ShieldPanel() {
  const snapshot = useShieldPositions();
  const alerts = useShieldAlerts(snapshot);

  const gaps = alerts.evaluations.filter((e) => e.verdict === 'cannot-evaluate');
  const fired = alerts.evaluations.filter((e) => e.verdict === 'fired');

  return (
    <section className="space-y-3" aria-label={SHIELD_COPY.title}>
      <div>
        <h3 className="heading-luxury text-[15px] text-white">{SHIELD_COPY.title}</h3>
        <p className="text-white/60 text-[12px] mt-0.5">{SHIELD_COPY.subtitle}</p>
      </div>

      <ShieldAutomationNotice />

      {snapshot.status !== 'ready' && (
        <p
          className="text-[12px] leading-snug rounded-xl p-3"
          style={{
            color: snapshot.status === 'unreadable' ? '#FFD37C' : 'rgba(255,255,255,0.7)',
            background: '#000',
            border: '1px solid var(--color-purple-75)',
          }}
          role="status"
        >
          {snapshot.detail}
        </p>
      )}

      {snapshot.status === 'ready' && snapshot.positions.length === 0 && (
        <p
          className="text-white/70 text-[12px] leading-snug rounded-xl p-3"
          style={{ background: '#000', border: '1px solid var(--color-purple-75)' }}
        >
          {SHIELD_COPY.noPositions}
        </p>
      )}

      {snapshot.status === 'ready' && snapshot.positions.length > 0 && (
        <ul className="space-y-3 m-0 p-0">
          {snapshot.positions.map((p) => (
            <ShieldPositionCard key={`${p.lendingContract}-${p.loanId}`} position={p} />
          ))}
        </ul>
      )}

      {/* Rendered whenever there is a position to alert about. Hiding this block
          when no rule exists would let the absence of an alerts section read as
          alerts being taken care of. */}
      {snapshot.status === 'ready' && snapshot.positions.length > 0 && alerts.rules.length === 0 && (
        <p
          className="text-[12px] leading-snug rounded-xl p-3"
          style={{ color: '#FFD37C', background: '#000', border: '1px solid var(--color-purple-75)' }}
          role="status"
        >
          {SHIELD_COPY.noRules}
        </p>
      )}

      {alerts.rules.length > 0 && (
        <section
          className="rounded-xl p-4"
          style={{ background: '#000', border: '1px solid var(--color-purple-75)' }}
          aria-label="Deadline alerts"
        >
          <p className="text-white text-[12px] font-semibold">
            Deadline alerts — {alerts.rules.length} rule{alerts.rules.length === 1 ? '' : 's'}
          </p>
          <p className="mt-1 text-white/55 text-[11px] leading-snug">{alerts.coverage}</p>
          {/* A rule that could not be evaluated is shown as itself. Folding it into
              the quiet majority is how an outage becomes a reassurance. */}
          {gaps.length > 0 && (
            <ul className="mt-2 space-y-1">
              {gaps.map((g) => (
                <li key={g.ruleId} className="text-[11px] leading-snug list-none" style={{ color: '#FFD37C' }}>
                  {g.detail}
                </li>
              ))}
            </ul>
          )}
          {fired.length > 0 && (
            <ul className="mt-2 space-y-1">
              {fired.map((f) => (
                <li key={f.ruleId} className="text-[11px] leading-snug list-none" style={{ color: 'var(--color-kenny)' }}>
                  {f.detail} {SHIELD_COPY.alertIsNotAnAction}
                </li>
              ))}
            </ul>
          )}
          {gaps.length === 0 && fired.length === 0 && alerts.lastRunAt !== null && (
            <p className="mt-2 text-white/55 text-[11px] leading-snug">
              Every rule was evaluated in the last pass and none matched.
            </p>
          )}
        </section>
      )}

      {alerts.storeProblem && (
        <p className="text-[11px] leading-snug" style={{ color: '#FFD37C' }} role="status">
          {SHIELD_COPY.ruleStoreProblem} {alerts.storeProblem}
        </p>
      )}

      <ShieldCoverageNotice />
    </section>
  );
}

export default ShieldPanel;
