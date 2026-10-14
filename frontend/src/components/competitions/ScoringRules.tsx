import {
  PNL_SCORING,
  RESISTANCE_LIMITS,
  RESISTANCE_RULE,
  WASH_WINDOW_SECONDS,
} from '../../lib/competitions/scoring';
import { SETTLEMENT } from '../../lib/competitions/season';
import { CardArt } from '../ui/CardArt';
import { FinePrint } from '../ui/FinePrint';

// The rules, above the board rather than behind a link. The page claims no prize, no
// settlement and no measure of skill, and says why; each sentence is imported from the
// module that enforces it, so a rule cannot drift from its description.
//
// FEWER WORDS (owner, 2026-10-13). The card says the rules in one line; each rule's
// full sentence, with its limits, sits in the FinePrint, still imported verbatim.

export function ScoringRules() {
  return (
    <section className="relative isolate rounded-xl border border-white/15 bg-white/[0.02] p-4">
      <CardArt pageId="competitions" idx={4} />
      <h2 className="text-sm font-semibold text-white">How this is scored, and what it is not</h2>
      <p className="mt-1.5 text-xs leading-relaxed text-white/80">
        Same-wallet round trips are struck. No profit board, no prize.
      </p>
      <p className="mt-1.5 text-[11px] text-white/55">
        Wash window: {Math.round(WASH_WINDOW_SECONDS / 60)} minutes.
      </p>
      <FinePrint summary="Scoring rules" className="mt-1">
        <dl className="space-y-3">
          <div>
            <dt className="font-medium text-white">Wash trading</dt>
            <dd className="mt-0.5">{RESISTANCE_RULE}</dd>
            <dd className="mt-1">{RESISTANCE_LIMITS}</dd>
          </div>
          <div>
            <dt className="font-medium text-white">No profit board</dt>
            <dd className="mt-0.5">{PNL_SCORING}</dd>
          </div>
          <div>
            <dt className="font-medium text-white">No prize, and no settlement</dt>
            <dd className="mt-0.5">{SETTLEMENT}</dd>
          </div>
          <div>
            <dt className="font-medium text-white">One unit only</dt>
            <dd className="mt-0.5">
              Only swaps that spend the season's quote token add to a total. Trades in other tokens
              are counted and shown, never added in: the indexer stores no exchange rate, so a
              mixed total would be a figure with no unit that still looked like money.
            </dd>
          </div>
        </dl>
      </FinePrint>
    </section>
  );
}
