import { TRUNCATED_NOTICE, type Standings } from '../../lib/competitions/scoring';
import { formatQuoteAmount } from '../../lib/copytrade/quoteTokens';
import { formatTimeAgo, shortenAddress } from '../../lib/formatting';

// The board itself.
//
// Two columns exist here that a volume leaderboard normally hides. `Struck` is
// the count of legs the wash rule removed from that wallet, shown because a
// competitor is entitled to see what was discounted and a reader is entitled to
// see how much of the field is round-tripping. `Other tokens` is the count of
// trades that could not be added to the total at all — without it, a wallet that
// traded heavily in a token this season does not measure would appear idle.
//
// The rank number is a position in THIS read. When the page was truncated the
// notice above says so, and the number is not dressed up as a standing.

export interface StandingsTableProps {
  standings: Standings;
  /** Highlighted so a competitor can find themselves without scanning. */
  account?: string | null;
}

export function StandingsTable({ standings, account }: StandingsTableProps) {
  const me = account ? account.toLowerCase() : null;

  return (
    <section className="rounded-xl border border-white/15 bg-white/[0.02] p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-sm font-semibold text-white">{standings.season.name}</h2>
        <p className="text-[11px] text-white/60">
          {standings.swapsRead} swap{standings.swapsRead === 1 ? '' : 's'} read ·{' '}
          {standings.washedLegs} leg{standings.washedLegs === 1 ? '' : 's'} struck as round trips
        </p>
      </div>
      <p className="mt-1.5 text-xs leading-relaxed text-white/70">{standings.season.blurb}</p>
      {standings.truncated ? (
        <p className="mt-2 text-[11px] leading-relaxed text-amber-200">{TRUNCATED_NOTICE}</p>
      ) : null}

      {standings.rows.length === 0 ? (
        <p className="mt-4 text-xs text-white/70">
          The read succeeded and found no venue-routed swaps inside this season's dates. That is a
          measurement of this router over this window, and not a statement about trading elsewhere.
        </p>
      ) : (
        <div className="mt-4 overflow-x-auto">
          <table className="w-full min-w-[42rem] text-left text-xs">
            <caption className="sr-only">
              Competitors ranked by quote token spent after round-trip legs are struck. No profit
              figure is shown.
            </caption>
            <thead className="text-[10px] uppercase tracking-wide text-white/55">
              <tr>
                <th scope="col" className="py-1.5 pr-3 font-medium">#</th>
                <th scope="col" className="py-1.5 pr-3 font-medium">Wallet</th>
                <th scope="col" className="py-1.5 pr-3 font-medium">Counted volume</th>
                <th scope="col" className="py-1.5 pr-3 font-medium">Counted trades</th>
                <th scope="col" className="py-1.5 pr-3 font-medium">Struck as round trips</th>
                <th scope="col" className="py-1.5 pr-3 font-medium">Other tokens</th>
                <th scope="col" className="py-1.5 font-medium">Last trade</th>
              </tr>
            </thead>
            <tbody className="text-white/85">
              {standings.rows.map((row, index) => (
                <tr
                  key={row.wallet}
                  className={`border-t border-white/10 ${row.wallet === me ? 'bg-white/[0.05]' : ''}`}
                >
                  <td className="py-2 pr-3 tabular-nums text-white/60">{index + 1}</td>
                  <td className="py-2 pr-3 font-mono">
                    {shortenAddress(row.wallet, 6)}
                    {row.wallet === me ? <span className="ml-2 text-[10px] text-emerald-200">you</span> : null}
                  </td>
                  <td className="py-2 pr-3">
                    {formatQuoteAmount(row.countedVolume, standings.season.quoteToken)}
                  </td>
                  <td className="py-2 pr-3">{row.countedTrades}</td>
                  <td className="py-2 pr-3">
                    {row.washedLegs > 0 ? (
                      <span className="text-amber-200">{row.washedLegs}</span>
                    ) : (
                      <span className="text-white/55">0</span>
                    )}
                  </td>
                  <td className="py-2 pr-3">{row.offQuoteTrades}</td>
                  <td className="py-2">{formatTimeAgo(Number(row.lastTradeAt))}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
