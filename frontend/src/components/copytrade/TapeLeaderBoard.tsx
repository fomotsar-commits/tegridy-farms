import { ArtCard } from '../ui/ArtCard';
import {
  TAPE_EMPTY_AFTER_READ,
  TAPE_RETURN_RANKING,
  TAPE_SENDER_NOTICE,
  type TapeLeaderboard,
  type TapeLeaderRow,
} from '../../lib/copytrade/tapeLeaderboard';
import { marketTxUrl } from '../../lib/copytrade/tape';
import type { TapeFollowerSummary } from '../../lib/copytrade/tapeReconcile';
import { formatTimeAgo, shortenAddress } from '../../lib/formatting';

// The board, with the column everybody expects deliberately absent.
//
// There is no profit column here and no rank badge implying one. The header
// carries `TAPE_RETURN_RANKING.reason` IN FULL rather than an asterisk, because
// the reader's default assumption about a copy-trading leaderboard is that the
// top row made the most money, and a footnote does not displace a default.
//
// The second thing printed above the table is `TAPE_SENDER_NOTICE`, and it is
// not a disclaimer — it is what the column actually contains. GeckoTerminal
// gives the address that SENT the transaction. That is the trader when the
// trader signed and submitted it themselves, and it is an aggregator, a relayer
// or a bot the rest of the time, so the column is headed "Sender" and the row is
// never described as a person.
//
// The one performance-adjacent figure that IS shown is the reader's OWN median
// entry lag against that address, and only for addresses they have actually
// mirrored. An address with no mirrors shows "not measured" — never a dash that
// could pass for zero, and never the leader's own numbers standing in for the
// follower's.
//
// ART: the card is an ArtCard on the copy-trading surface, so the studio can
// place it and the page is not a bare dark box. It shares idx 0 with the page
// backdrop for now; registering (copy-trading, 1) is a shared edit to
// lib/artSurfaces.ts that this lane cannot make, and rendering an unregistered
// index would make the card invisible in the studio.

export interface TapeLeaderBoardProps {
  board: TapeLeaderboard;
  /** The reader's realised record, keyed by leader. Empty when they have none. */
  followerRecord: readonly TapeFollowerSummary[];
  /** Whether the reader's own record could be read at all. */
  followerRecordReadable: boolean;
  onUse?: (leader: string, venue: 'evm' | 'solana') => void;
  /** Addresses already followed, so the action does not offer a duplicate. */
  followed: ReadonlySet<string>;
}

const CHAIN_LABEL: Record<TapeLeaderRow['network'], string> = {
  eth: 'Ethereum',
  base: 'Base',
  solana: 'Solana',
};

export function TapeLeaderBoard({
  board,
  followerRecord,
  followerRecordReadable,
  onUse,
  followed,
}: TapeLeaderBoardProps) {
  const byLeader = new Map(followerRecord.map((r) => [r.leader, r]));

  return (
    <ArtCard pageId="copy-trading" idx={0} padding="p-4 md:p-5">
      <section>
        <h2 className="text-sm font-semibold text-white">Addresses filling the island’s pools</h2>
        <p className="mt-1.5 text-xs leading-relaxed text-white/80">{TAPE_RETURN_RANKING.reason}</p>
        <p className="mt-1.5 text-xs leading-relaxed text-white/70">{TAPE_RETURN_RANKING.rankedInstead}</p>
        <p className="mt-1.5 text-[11px] leading-relaxed text-amber-200/90">{TAPE_SENDER_NOTICE}</p>

        {board.rows.length === 0 ? (
          <p className="mt-4 text-xs leading-relaxed text-white/70">{TAPE_EMPTY_AFTER_READ}</p>
        ) : (
          <div className="mt-4 overflow-x-auto">
            <table className="w-full min-w-[52rem] text-left text-xs">
              <caption className="sr-only">
                Addresses that sent fills through the island’s pools, ranked by GeckoTerminal’s USD
                valuation of those fills. No profit figure is shown for any address.
              </caption>
              <thead className="text-[10px] uppercase tracking-wide text-white/55">
                <tr>
                  <th scope="col" className="py-1.5 pr-3 font-medium">Sender</th>
                  <th scope="col" className="py-1.5 pr-3 font-medium">Chain</th>
                  <th scope="col" className="py-1.5 pr-3 font-medium">Island volume</th>
                  <th scope="col" className="py-1.5 pr-3 font-medium">Fills</th>
                  <th scope="col" className="py-1.5 pr-3 font-medium">Pools</th>
                  <th scope="col" className="py-1.5 pr-3 font-medium">Last fill</th>
                  <th scope="col" className="py-1.5 pr-3 font-medium">Your lag behind them</th>
                  <th scope="col" className="py-1.5 font-medium">
                    <span className="sr-only">Follow</span>
                  </th>
                </tr>
              </thead>
              <tbody className="text-white/85">
                {board.rows.map((row) => {
                  const record = byLeader.get(row.wallet);
                  const txUrl = marketTxUrl(row.lastNetwork, row.lastTxHash);
                  return (
                    <tr key={row.key} className="border-t border-white/10">
                      <td className="py-2 pr-3 font-mono">{shortenAddress(row.wallet, 6)}</td>
                      <td className="py-2 pr-3">{CHAIN_LABEL[row.network]}</td>
                      <td className="py-2 pr-3">
                        {row.usdVolume === null ? (
                          <span className="text-white/55">
                            unpriced ({row.unpricedFills} fill{row.unpricedFills === 1 ? '' : 's'})
                          </span>
                        ) : (
                          <>
                            ${Math.round(row.usdVolume).toLocaleString()}
                            {row.unpricedFills > 0 ? (
                              <span className="text-white/55"> (+{row.unpricedFills} unpriced)</span>
                            ) : null}
                          </>
                        )}
                      </td>
                      <td className="py-2 pr-3">
                        {row.fills}
                        <span className="text-white/55">
                          {' '}
                          ({row.buys} buy / {row.sells} sell
                          {row.unclassified > 0 ? ` / ${row.unclassified} unclassified` : ''})
                        </span>
                      </td>
                      <td className="py-2 pr-3">{row.poolsTouched.join(', ')}</td>
                      <td className="py-2 pr-3">
                        {txUrl ? (
                          <a
                            href={txUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            aria-label="View the most recent fill on a block explorer (opens in new tab)"
                            className="underline underline-offset-2 hover:text-white"
                          >
                            {formatTimeAgo(row.lastSeen)} ↗
                          </a>
                        ) : (
                          <span className="text-white/55" title="unlinkable upstream value">
                            {formatTimeAgo(row.lastSeen)}
                          </span>
                        )}
                      </td>
                      <td className="py-2 pr-3">
                        <LagCell record={record} readable={followerRecordReadable} />
                      </td>
                      <td className="py-2">
                        {followed.has(row.wallet) ? (
                          <span className="text-[11px] text-white/55">Followed</span>
                        ) : onUse ? (
                          <button
                            type="button"
                            onClick={() => onUse(row.wallet, row.family)}
                            className="min-h-11 min-w-11 rounded-md border border-white/25 px-3 py-1 text-[11px] font-medium text-white hover:bg-white/10"
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
    </ArtCard>
  );
}

function LagCell({
  record,
  readable,
}: {
  record: TapeFollowerSummary | undefined;
  readable: boolean;
}) {
  if (!readable) {
    return <span className="text-white/55">Your own fills could not be read</span>;
  }
  if (!record || record.filled === 0 || record.medianEntryLagSeconds === null) {
    return <span className="text-white/55">Not measured — you have no matched mirror of this address</span>;
  }
  return (
    <span>
      {formatSeconds(record.medianEntryLagSeconds)} later
      <span className="text-white/55"> (median of {record.filled})</span>
    </span>
  );
}

function formatSeconds(seconds: number): string {
  if (seconds < 90) return `${seconds}s`;
  if (seconds < 5400) return `${Math.round(seconds / 60)}m`;
  return `${(seconds / 3600).toFixed(1)}h`;
}
