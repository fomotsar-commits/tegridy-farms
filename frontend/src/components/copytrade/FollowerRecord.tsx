import {
  FILL_MATCH_WINDOW_SECONDS,
  FOLLOWER_RETURN_UNMEASURABLE,
  MATCH_BASIS,
  type FollowerRelativeSummary,
  type MirrorOutcomeRow,
} from '../../lib/copytrade/followerRelative';
import { formatQuoteAmount } from '../../lib/copytrade/quoteTokens';
import { shortenAddress } from '../../lib/formatting';

// Your own realised record: how late you were, and how often the mirror never
// happened at all.
//
// This is the closest thing to performance anywhere in the slice and it is still
// not performance — `FOLLOWER_RETURN_UNMEASURABLE` says so at the top rather than
// leaving the reader to infer it from the absence of a profit column. The lag and
// the not-filled count are both outcomes; a copy-trading surface that reported
// neither would be reporting only the decision to trade, which always looks good.

export interface FollowerRecordProps {
  outcomes: readonly MirrorOutcomeRow[];
  byLeader: readonly FollowerRelativeSummary[];
  account?: string | null;
  /**
   * Mirrors this browser has logged for this wallet. Checked BEFORE the read
   * state: "you have logged nothing" and "your history could not be read" are
   * different sentences, and showing the second one to somebody who simply has
   * not started would report an outage that is not happening.
   */
  loggedCount: number;
  /** False when the indexed read did not succeed — counts below say nothing. */
  readable: boolean;
}

export function FollowerRecord({
  outcomes,
  byLeader,
  account,
  loggedCount,
  readable,
}: FollowerRecordProps) {
  return (
    <section className="rounded-xl border border-white/15 bg-white/[0.02] p-4">
      <h2 className="text-sm font-semibold text-white">Your mirrors, as they actually went</h2>
      <p className="mt-1.5 text-xs leading-relaxed text-white/80">{FOLLOWER_RETURN_UNMEASURABLE}</p>
      <p className="mt-1.5 text-[11px] leading-relaxed text-white/60">{MATCH_BASIS}</p>

      {!account ? (
        <p className="mt-4 text-xs text-white/70">
          No wallet is connected, so there is no address to look for fills under. Nothing here is a
          statement about mirrors you may have placed.
        </p>
      ) : loggedCount === 0 ? (
        <p className="mt-4 text-xs text-white/70">
          You have logged no mirrors from this browser. The log lives here and nowhere else, so a
          different browser or a cleared cache starts this record over.
        </p>
      ) : !readable ? (
        <p className="mt-4 text-xs text-white/70">
          Your swap history could not be read, so none of the {loggedCount} mirror
          {loggedCount === 1 ? '' : 's'} you logged can be shown to have filled — or to have failed.
          Unread is not unfilled.
        </p>
      ) : (
        <>
          <ul className="mt-4 space-y-1.5 text-xs text-white/85">
            {byLeader.map((row) => (
              <li key={row.leader} className="flex flex-wrap items-baseline gap-x-2">
                <span className="font-mono">{shortenAddress(row.leader, 6)}</span>
                <span className="text-white/70">
                  {row.filled} filled · {row.notFilled} never filled · {row.awaiting} still inside
                  the match window
                </span>
                {row.medianEntryLagSeconds !== null ? (
                  <span>
                    median {formatSeconds(row.medianEntryLagSeconds)} behind them, worst{' '}
                    {formatSeconds(row.worstEntryLagSeconds!)}
                  </span>
                ) : (
                  <span className="text-white/55">no fill to measure a lag from</span>
                )}
              </li>
            ))}
          </ul>

          <div className="mt-4 overflow-x-auto">
            <table className="w-full min-w-[40rem] text-left text-xs">
              <caption className="sr-only">
                Each mirror you logged, with whether a matching swap was found and how far behind the
                leader it landed.
              </caption>
              <thead className="text-[10px] uppercase tracking-wide text-white/55">
                <tr>
                  <th scope="col" className="py-1.5 pr-3 font-medium">Leader</th>
                  <th scope="col" className="py-1.5 pr-3 font-medium">Logged</th>
                  <th scope="col" className="py-1.5 pr-3 font-medium">Outcome</th>
                  <th scope="col" className="py-1.5 pr-3 font-medium">Behind the leader</th>
                  <th scope="col" className="py-1.5 font-medium">You spent</th>
                </tr>
              </thead>
              <tbody className="text-white/85">
                {outcomes.map((row) => (
                  <tr key={`${row.intent.leaderTxHash}:${row.intent.confirmedAt}`} className="border-t border-white/10">
                    <td className="py-2 pr-3 font-mono">{shortenAddress(row.intent.leader, 6)}</td>
                    <td className="py-2 pr-3">{new Date(row.intent.confirmedAt * 1000).toISOString().slice(0, 16).replace('T', ' ')}</td>
                    <td className="py-2 pr-3">
                      {row.state === 'filled' ? (
                        <span className="text-emerald-200">Matched a swap</span>
                      ) : row.state === 'awaiting' ? (
                        <span className="text-white/70">
                          Still inside the {Math.round(FILL_MATCH_WINDOW_SECONDS / 60)}-minute match
                          window
                        </span>
                      ) : (
                        <span className="text-amber-200">No matching swap — this mirror did not happen</span>
                      )}
                    </td>
                    <td className="py-2 pr-3">
                      {row.entryLagSeconds === null ? (
                        <span className="text-white/55">—</span>
                      ) : (
                        `${formatSeconds(row.entryLagSeconds)} later`
                      )}
                    </td>
                    <td className="py-2">
                      {row.filledAmountIn === null ? (
                        <span className="text-white/55">—</span>
                      ) : (
                        formatQuoteAmount(row.filledAmountIn, row.intent.quoteToken)
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </section>
  );
}

function formatSeconds(seconds: number): string {
  if (seconds < 90) return `${seconds}s`;
  if (seconds < 5400) return `${Math.round(seconds / 60)}m`;
  return `${(seconds / 3600).toFixed(1)}h`;
}
