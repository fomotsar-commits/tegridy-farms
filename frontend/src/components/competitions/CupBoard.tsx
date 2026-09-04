import {
  CUP_EMPTY_AFTER_COMPLETE,
  CUP_RANK_MEANING,
  CUP_SENDER,
  CUP_UNIT,
  formatUsdMicros,
  utcMinute,
  type CupBoard as CupBoardData,
  type CupBoardStatus,
} from '../../lib/competitions/islandCup';
import { shortenAddress } from '../../lib/formatting';

// THE BOARD.
//
// Three columns here that a volume leaderboard normally hides, for the same
// reason StandingsTable shows its two: `Struck as round trips` is what the wash
// rule removed from that sender, `Pools touched` is how much of the island they
// actually traded, and `Last fill` is a real block timestamp rather than a
// relative phrase.
//
// LAST FILL IS RENDERED IN UTC, NOT AS "3m ago". A relative time is computed
// against the reader's clock and keeps moving after the data stops; on a page
// whose whole claim is "this is the window the feed served", a figure that
// silently ages is a small continuous lie. `utcMinute` prints the fill's own
// time and nothing else — there is no clock read anywhere in this file.
//
// AND NO PROFIT COLUMN. A trade feed gives one leg of a trade. A return exists
// for nobody here, which is stated on the page rather than approximated with a
// column that looks like one.

export interface CupBoardProps {
  board: CupBoardData;
  status: CupBoardStatus;
  /** Highlighted so a sender can find themselves without scanning. */
  account?: string | null;
}

export function CupBoard({ board, status, account }: CupBoardProps) {
  const me = account ? (account.startsWith('0x') ? account.toLowerCase() : account) : null;
  const from = board.windowFrom === null ? board.oldestFillAt : board.windowFrom;

  return (
    <section className="rounded-xl border border-white/15 bg-white/[0.02] p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-sm font-semibold text-white">Island Cup</h2>
        <p className="text-[11px] text-white/60">
          {board.legsRead} fill{board.legsRead === 1 ? '' : 's'} read ·{' '}
          {board.washedLegs} struck as round trips
          {board.legsOutsideWindow > 0
            ? ` · ${board.legsOutsideWindow} older than the common window, counted and not scored`
            : ''}
        </p>
      </div>

      {from !== null && board.newestFillAt !== null ? (
        <p className="mt-1.5 text-xs leading-relaxed text-white/75">
          Scored over {utcMinute(from)} – {utcMinute(board.newestFillAt)}, the widest window every
          answering pool covers, as GeckoTerminal served it.
        </p>
      ) : (
        <p className="mt-1.5 text-xs leading-relaxed text-white/75">
          No fill came back from any pool that answered, so there is no window to state.
        </p>
      )}

      {board.newestFillAt !== null ? (
        <p className="mt-1 text-[11px] leading-relaxed text-white/60">
          Newest fill read: {utcMinute(board.newestFillAt)}.
        </p>
      ) : null}

      <p className="mt-2 text-[11px] leading-relaxed text-white/70">{CUP_RANK_MEANING}</p>

      {board.rows.length === 0 ? (
        <p className="mt-4 text-xs leading-relaxed text-white/75">
          {status === 'complete'
            ? CUP_EMPTY_AFTER_COMPLETE
            : 'The pools that answered reported no fill inside the window they all cover. Pools that did not answer are listed above, and this is not a statement about them.'}
        </p>
      ) : (
        <div className="mt-4 overflow-x-auto">
          <table className="w-full min-w-[46rem] text-left text-xs">
            <caption className="sr-only">
              Senders ranked by {CUP_UNIT}, after same-sender round trips inside the wash window
              are struck from both sides. No profit figure is shown.
            </caption>
            <thead className="text-[10px] uppercase tracking-wide text-white/55">
              <tr>
                <th scope="col" className="py-1.5 pr-3 font-medium">#</th>
                <th scope="col" className="py-1.5 pr-3 font-medium" title={CUP_SENDER}>Sender</th>
                <th scope="col" className="py-1.5 pr-3 font-medium" title={CUP_UNIT}>
                  Counted volume
                </th>
                <th scope="col" className="py-1.5 pr-3 font-medium">Counted fills</th>
                <th scope="col" className="py-1.5 pr-3 font-medium">Struck as round trips</th>
                <th scope="col" className="py-1.5 pr-3 font-medium">Pools touched</th>
                <th scope="col" className="py-1.5 font-medium">Last fill</th>
              </tr>
            </thead>
            <tbody className="text-white/85">
              {board.rows.map((row, index) => (
                <tr
                  key={row.wallet}
                  className={`border-t border-white/10 ${row.wallet === me ? 'bg-white/[0.05]' : ''}`}
                >
                  <td className="py-2 pr-3 tabular-nums text-white/60">{index + 1}</td>
                  <td className="py-2 pr-3 font-mono">
                    {shortenAddress(row.wallet, 6)}
                    {row.wallet === me ? (
                      <span className="ml-2 text-[10px] text-emerald-200">you</span>
                    ) : null}
                  </td>
                  <td className="py-2 pr-3 tabular-nums">{formatUsdMicros(row.countedVolume)}</td>
                  <td className="py-2 pr-3">{row.countedTrades}</td>
                  <td className="py-2 pr-3">
                    {row.washedLegs > 0 ? (
                      <span className="text-amber-200">{row.washedLegs}</span>
                    ) : (
                      <span className="text-white/55">0</span>
                    )}
                  </td>
                  <td className="py-2 pr-3">{row.poolsTouched}</td>
                  <td className="py-2 whitespace-nowrap">{utcMinute(row.lastTradeAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <p className="mt-3 text-[11px] leading-relaxed text-white/55">
        {CUP_SENDER}. Volumes are {CUP_UNIT}.
      </p>
    </section>
  );
}
