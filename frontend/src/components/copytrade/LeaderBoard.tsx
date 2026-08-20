import {
  RETURN_RANKING,
  TRUNCATED_NOTICE,
  type Leaderboard,
} from '../../lib/copytrade/leaderboard';
import type { FollowerRelativeSummary } from '../../lib/copytrade/followerRelative';
import { formatQuoteAmount } from '../../lib/copytrade/quoteTokens';
import { formatTimeAgo, shortenAddress } from '../../lib/formatting';

// The board, with the column everybody expects deliberately absent.
//
// There is no profit column here and there is no rank badge implying one. The
// header carries `RETURN_RANKING.reason` in full rather than a asterisk, because
// the reader's default assumption about a copy-trading leaderboard is that the
// top wallet made the most money, and a footnote does not displace a default.
//
// The one performance-adjacent figure that IS shown is the reader's OWN median
// entry lag against that wallet, and only for wallets they have actually
// mirrored. A wallet with no mirrors shows "not measured" — never a dash that
// could pass for zero and never the leader's own numbers standing in for the
// follower's.

export interface LeaderBoardProps {
  board: Leaderboard;
  /** The viewer's realised record, keyed by leader. Empty when they have none. */
  followerRecord: readonly FollowerRelativeSummary[];
  /** Whether the follower record itself could be read. */
  followerRecordReadable: boolean;
  onFollow?: (leader: string) => void;
  /** Leaders already followed, so the action does not offer a duplicate. */
  followed: ReadonlySet<string>;
}

export function LeaderBoard({
  board,
  followerRecord,
  followerRecordReadable,
  onFollow,
  followed,
}: LeaderBoardProps) {
  const byLeader = new Map(followerRecord.map((r) => [r.leader, r]));

  return (
    <section className="rounded-xl border border-white/15 bg-white/[0.02] p-4">
      <h2 className="text-sm font-semibold text-white">Wallets trading the venue</h2>
      <p className="mt-1.5 text-xs leading-relaxed text-white/80">{RETURN_RANKING.reason}</p>
      <p className="mt-1.5 text-xs leading-relaxed text-white/70">{RETURN_RANKING.rankedInstead}</p>
      {board.truncated ? (
        <p className="mt-2 text-[11px] leading-relaxed text-amber-200">{TRUNCATED_NOTICE}</p>
      ) : null}

      {board.rows.length === 0 ? (
        <p className="mt-4 text-xs text-white/70">
          The read succeeded and returned no venue-routed swaps in this window. That is a
          measurement: nobody put a trade through this router inside the window shown above. It is
          not a statement about trading anywhere else.
        </p>
      ) : (
        <div className="mt-4 overflow-x-auto">
          <table className="w-full min-w-[46rem] text-left text-xs">
            <caption className="sr-only">
              Wallets ranked by quote token spent through the venue router. No profit figure is
              shown for any wallet.
            </caption>
            <thead className="text-[10px] uppercase tracking-wide text-white/55">
              <tr>
                <th scope="col" className="py-1.5 pr-3 font-medium">Wallet</th>
                <th scope="col" className="py-1.5 pr-3 font-medium">Spent (window)</th>
                <th scope="col" className="py-1.5 pr-3 font-medium">Trades</th>
                <th scope="col" className="py-1.5 pr-3 font-medium">Tokens bought</th>
                <th scope="col" className="py-1.5 pr-3 font-medium">Last seen</th>
                <th scope="col" className="py-1.5 pr-3 font-medium">Your lag behind them</th>
                <th scope="col" className="py-1.5 font-medium">
                  <span className="sr-only">Follow</span>
                </th>
              </tr>
            </thead>
            <tbody className="text-white/85">
              {board.rows.map((row) => {
                const record = byLeader.get(row.leader);
                return (
                  <tr key={row.leader} className="border-t border-white/10">
                    <td className="py-2 pr-3 font-mono">{shortenAddress(row.leader, 6)}</td>
                    <td className="py-2 pr-3">{formatQuoteAmount(row.quoteDeployed, board.quoteToken)}</td>
                    <td className="py-2 pr-3">
                      {row.trades}
                      {row.offQuoteTrades > 0 ? (
                        <span className="text-white/55">
                          {' '}
                          ({row.offQuoteTrades} in another token, not added in)
                        </span>
                      ) : null}
                    </td>
                    <td className="py-2 pr-3">{row.tokensBought}</td>
                    <td className="py-2 pr-3">{formatTimeAgo(Number(row.lastSeen))}</td>
                    <td className="py-2 pr-3">
                      <LagCell record={record} readable={followerRecordReadable} />
                    </td>
                    <td className="py-2">
                      {followed.has(row.leader) ? (
                        <span className="text-[11px] text-white/55">Followed</span>
                      ) : onFollow ? (
                        <button
                          type="button"
                          onClick={() => onFollow(row.leader)}
                          className="rounded-md border border-white/25 px-2.5 py-1 text-[11px] font-medium text-white hover:bg-white/10"
                        >
                          Use address
                        </button>
                      ) : null}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function LagCell({
  record,
  readable,
}: {
  record: FollowerRelativeSummary | undefined;
  readable: boolean;
}) {
  if (!readable) {
    return <span className="text-white/55">Your history could not be read</span>;
  }
  if (!record || record.filled === 0) {
    return <span className="text-white/55">Not measured — you have no filled mirror of this wallet</span>;
  }
  return (
    <span>
      {formatSeconds(record.medianEntryLagSeconds!)} later
      <span className="text-white/55"> (median of {record.filled})</span>
    </span>
  );
}

function formatSeconds(seconds: number): string {
  if (seconds < 90) return `${seconds}s`;
  if (seconds < 5400) return `${Math.round(seconds / 60)}m`;
  return `${(seconds / 3600).toFixed(1)}h`;
}
