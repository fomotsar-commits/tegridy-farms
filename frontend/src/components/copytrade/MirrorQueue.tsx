import { Link } from 'react-router-dom';
import { MAX_SIGNAL_AGE_SECONDS, MIRROR_EXECUTION, MIRROR_REFUSAL_TEXT } from '../../lib/copytrade/mirror';
import { TAPE_MIRROR_REFUSAL_TEXT } from '../../lib/copytrade/tapeMirror';
import type { MirrorIntent } from '../../lib/copytrade/follows';
import type { QueueRefusal, QueueRow } from './queueRows';
import { shortenAddress } from '../../lib/formatting';

// Every read fill by a followed address — the copyable ones AND the ones that
// are not.
//
// REFUSALS ARE ROWS, NOT OMISSIONS. A queue that showed only the actionable
// fills would present a leader as a stream of clean opportunities while hiding
// that most of what they did could not be mirrored at all: wrong quote token,
// wrong chain, direction unknown, too old to still be the same trade, or — the
// one a copy-trading surface most wants to hide — a SELL. The ratio between the
// two is the most useful thing on this page and it only exists if both are drawn.
//
// The refusal arrives as a tagged reason and the SENTENCE is looked up here, so
// both vocabularies stay in one place: a refusal added to either source and not
// given words fails to compile rather than rendering as a blank row.
//
// The button does exactly what its label says and nothing more. It writes a
// timestamped note in this browser; it does not sign, submit, or pre-fill a
// trade. That note is what lets the fill rate and the entry lag be measured
// later against real fills, and it is the reason the log is written BEFORE the
// trade rather than after it.

export interface MirrorQueueProps {
  candidates: readonly QueueRow[];
  /** Leader tx hashes already logged by this browser. */
  loggedTxHashes: ReadonlySet<string>;
  onLog: (intent: MirrorIntent) => void;
  /** Heading, so the tape queue and the router queue name themselves. */
  heading?: string;
}

function refusalText(refusal: QueueRefusal): string {
  return refusal.source === 'tape'
    ? TAPE_MIRROR_REFUSAL_TEXT[refusal.reason]
    : MIRROR_REFUSAL_TEXT[refusal.reason];
}

export function MirrorQueue({ candidates, loggedTxHashes, onLog, heading = 'Mirror queue' }: MirrorQueueProps) {
  const copyable = candidates.filter((c) => c.plan !== null).length;

  return (
    <section className="rounded-xl border border-white/15 bg-white/[0.02] p-4">
      <h2 className="text-sm font-semibold text-white">{heading}</h2>
      <p className="mt-1.5 text-xs leading-relaxed text-white/70">{MIRROR_EXECUTION}</p>
      <p className="mt-1.5 text-[11px] leading-relaxed text-white/60">
        {candidates.length} fill{candidates.length === 1 ? '' : 's'} read from followed addresses,{' '}
        {copyable} of which can be sized right now. A fill older than{' '}
        {Math.round(MAX_SIGNAL_AGE_SECONDS / 60)} minutes is listed with its reason instead of a
        size — copying it would be a different trade at a different price.
      </p>

      {candidates.length === 0 ? (
        <p className="mt-4 text-xs leading-relaxed text-white/70">
          No fills by the followed addresses came back in what was read. Within what was read this
          is a measurement; outside it, nothing was looked at.
        </p>
      ) : (
        <ul className="mt-4 space-y-3">
          {candidates.map((candidate) => (
            <li key={candidate.key} className="rounded-lg border border-white/10 bg-black/20 px-3 py-2.5">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <p className="font-mono text-xs text-white">{shortenAddress(candidate.leader, 6)}</p>
                <p className="text-[10px] text-white/55">
                  {Math.max(0, candidate.ageSeconds)}s ago · {candidate.sourceLabel}
                </p>
              </div>
              <p className="mt-0.5 text-[10px] leading-snug text-white/50">{candidate.senderLine}</p>

              {candidate.plan ? (
                <div className="mt-2">
                  <p className="text-xs text-white/85">
                    Mirror size {candidate.plan.sizeText}
                    {candidate.plan.cappedText ? (
                      <span className="text-amber-200"> — {candidate.plan.cappedText}</span>
                    ) : null}
                  </p>
                  <p className="mt-1 text-[10px] leading-snug text-white/55">{candidate.plan.minOutReason}</p>
                  <div className="mt-2 flex flex-wrap items-center gap-2">
                    {loggedTxHashes.has(candidate.plan.leaderTxHash) ? (
                      <span className="text-[11px] text-white/60">Logged</span>
                    ) : (
                      <button
                        type="button"
                        disabled={candidate.plan.intent === null}
                        onClick={() => {
                          const intent = candidate.plan === null ? null : candidate.plan.intent;
                          if (intent) onLog(intent);
                        }}
                        className="min-h-11 min-w-11 rounded-md border border-white/25 px-3 py-1 text-[11px] font-medium text-white hover:bg-white/10 disabled:opacity-40"
                      >
                        Log this mirror
                      </button>
                    )}
                    {candidate.plan.trade ? (
                      candidate.plan.trade.to ? (
                        <Link
                          to={candidate.plan.trade.to}
                          className="min-h-11 inline-flex items-center text-[11px] text-white/70 underline hover:text-white"
                        >
                          {candidate.plan.trade.label}
                        </Link>
                      ) : candidate.plan.trade.href ? (
                        <a
                          href={candidate.plan.trade.href}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="min-h-11 inline-flex items-center text-[11px] text-white/70 underline hover:text-white"
                        >
                          {candidate.plan.trade.label} ↗
                        </a>
                      ) : null
                    ) : null}
                    <span className="text-[10px] text-white/50">
                      Logging records that you decided to mirror. It places no trade and fills
                      nothing in — you enter it yourself.
                    </span>
                  </div>
                  {candidate.plan.noIdentityReason ? (
                    <p className="mt-1 text-[10px] text-white/55">{candidate.plan.noIdentityReason}</p>
                  ) : null}
                </div>
              ) : candidate.refusal ? (
                <p className="mt-2 text-xs leading-relaxed text-amber-200/90">
                  {refusalText(candidate.refusal)}
                </p>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
