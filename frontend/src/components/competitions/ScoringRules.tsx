import {
  PNL_SCORING,
  RESISTANCE_LIMITS,
  RESISTANCE_RULE,
  WASH_WINDOW_SECONDS,
} from '../../lib/competitions/scoring';
import { SETTLEMENT } from '../../lib/competitions/season';

// The rules, above the board rather than behind a link.
//
// Three claims a competition page is expected to make and this one does not:
// that there is a prize, that the season will be settled, and that the ranking
// measures skill. Each is answered here with the reason, and each sentence is
// imported from the module that enforces it rather than retyped — a rule that
// can drift from its own description is a rule nobody can rely on.

export function ScoringRules() {
  return (
    <section className="rounded-xl border border-white/15 bg-white/[0.02] p-4">
      <h2 className="text-sm font-semibold text-white">How this is scored, and what it is not</h2>
      <dl className="mt-3 space-y-3 text-xs leading-relaxed">
        <div>
          <dt className="font-medium text-white">Wash trading</dt>
          <dd className="mt-0.5 text-white/80">{RESISTANCE_RULE}</dd>
          <dd className="mt-1 text-white/60">{RESISTANCE_LIMITS}</dd>
        </div>
        <div>
          <dt className="font-medium text-white">No profit board</dt>
          <dd className="mt-0.5 text-white/80">{PNL_SCORING}</dd>
        </div>
        <div>
          <dt className="font-medium text-white">No prize, and no settlement</dt>
          <dd className="mt-0.5 text-white/80">{SETTLEMENT}</dd>
        </div>
        <div>
          <dt className="font-medium text-white">One unit only</dt>
          <dd className="mt-0.5 text-white/80">
            Only swaps that spend the season's quote token add to a total. Trades in other tokens
            are counted and shown, never summed in — the indexer stores no exchange rate, so a
            mixed total would be a figure with no unit that still looked like money.
          </dd>
        </div>
      </dl>
      <p className="mt-3 text-[11px] text-white/55">
        Wash window: {Math.round(WASH_WINDOW_SECONDS / 60)} minutes.
      </p>
    </section>
  );
}
