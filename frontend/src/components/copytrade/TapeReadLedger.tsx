import type { IslandTapeStatus } from '../../hooks/useIslandTape';
import type { IslandTape } from '../../lib/copytrade/tape';
import type { TapeLeaderboard } from '../../lib/copytrade/tapeLeaderboard';
import { TAPE_CAPPED_NOTICE, TAPE_WINDOW_NOTICE } from '../../lib/copytrade/tapeLeaderboard';

// THE READ LEDGER — what was asked, what answered, and what did not.
//
// This is not a spinner and it is not an error banner. It is the part of the
// measurement that a board cannot show: twelve keyless requests to a throttled
// upstream sometimes come back as nine, and the three that did not answer are
// the difference between "these are the island's busiest addresses" and "these
// are the busiest addresses in the nine pools that answered".
//
// So every pool is listed by name with what it said. A pool that could not be
// read is NEVER folded into "no fills" — the reasons are separate words:
//
//   rate-limited   the feed is throttling us. Trying again in a moment works.
//   not-attempted  a 429 stopped the walk before this pool's turn. Never asked.
//   http           it answered, and the answer was a refusal.
//   schema         it answered with a body we will not render.
//   network        it did not answer at all.
//
// And the as-of line leads with the SOURCE's own time (the newest fill's block
// timestamp), not with when we fetched: a read that succeeds against a stale
// feed is current about the fetch and old about the market, and only one of
// those is what a reader is asking.

export interface TapeReadLedgerProps {
  status: IslandTapeStatus;
  tape: IslandTape | null;
  board: TapeLeaderboard | null;
  onRefresh: () => void;
  /** Unix ms when a refresh will be honoured, or null when it will be now. */
  refreshAvailableAt: number | null;
}

const TONES: Record<IslandTapeStatus, string> = {
  idle: 'border-white/20 bg-white/[0.03]',
  loading: 'border-white/20 bg-white/[0.03]',
  ready: 'border-emerald-400/30 bg-emerald-400/[0.06]',
  partial: 'border-amber-400/40 bg-amber-400/[0.07]',
  unavailable: 'border-amber-400/40 bg-amber-400/[0.07]',
};

function title(status: IslandTapeStatus, read: number, total: number): string {
  switch (status) {
    case 'idle':
      return 'The island tape is not being read';
    case 'loading':
      return 'Reading the island tape…';
    case 'ready':
      return `The island tape: all ${total} pools answered`;
    case 'partial':
      return `The island tape: ${read} of ${total} pools answered`;
    case 'unavailable':
      return 'The island tape could not be read';
  }
}

function iso(unixSeconds: number): string {
  return new Date(unixSeconds * 1000).toISOString().replace('.000', '');
}

export function TapeReadLedger({
  status,
  tape,
  board,
  onRefresh,
  refreshAvailableAt,
}: TapeReadLedgerProps) {
  const reads = tape ? tape.reads : [];
  const readCount = reads.filter((r) => r.status === 'read').length;
  const unread = reads.filter((r) => r.status !== 'read');
  const gated = refreshAvailableAt !== null;

  return (
    <div className={`rounded-xl border px-4 py-3 ${TONES[status]}`} role="status">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-semibold text-white">{title(status, readCount, reads.length)}</h3>
        {status === 'ready' || status === 'partial' || status === 'unavailable' ? (
          <button
            type="button"
            onClick={onRefresh}
            className="min-h-11 min-w-11 rounded-md border border-white/25 px-3 py-1 text-xs font-medium text-white hover:bg-white/10"
          >
            Read again
          </button>
        ) : null}
      </div>

      <p className="mt-1.5 text-xs leading-relaxed text-white/80">
        Every fill below comes from GeckoTerminal’s public trade feed for the island’s own pools —
        the same feed this site already uses for each bungalow’s tape. {TAPE_WINDOW_NOTICE}
      </p>

      {gated ? (
        <p className="mt-1.5 text-[11px] leading-relaxed text-amber-200">
          The feed is keyless and rate-limits by address, so this reads at most once a minute. Next
          read available at {new Date(refreshAvailableAt).toISOString().slice(11, 19)} UTC.
        </p>
      ) : null}

      {status === 'unavailable' ? (
        <p className="mt-1.5 text-xs leading-relaxed text-white/80">
          Not one pool answered on this pass, so there is no board below. That is a fact about the
          read, not about the island: nothing here says these pools were quiet.
        </p>
      ) : null}

      {unread.length > 0 ? (
        <div className="mt-2">
          <p className="text-[11px] font-medium uppercase tracking-wide text-white/60">
            Pools not read on this pass
          </p>
          <ul className="mt-1 space-y-1 text-[11px] leading-relaxed text-amber-200/90">
            {unread.map((r) => (
              <li key={`${r.pool.network}:${r.pool.pool}`}>
                <span className="text-white/85">{r.pool.label}</span>{' '}
                {r.status === 'unread' ? (
                  <>
                    — {r.reason}: {r.detail}
                  </>
                ) : null}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {board ? (
        <>
          <p className="mt-2 text-[11px] leading-relaxed text-white/60">
            {board.fillsRead} fill{board.fillsRead === 1 ? '' : 's'} read from {readCount} pool
            {readCount === 1 ? '' : 's'}
            {board.unattributedFills > 0
              ? ` · ${board.unattributedFills} with no sender address upstream (counted, not ranked)`
              : ''}
            {board.undatedFills > 0
              ? ` · ${board.undatedFills} with an unreadable timestamp (dropped, not dated zero)`
              : ''}
            .
          </p>
          {board.window ? (
            <p className="mt-1 text-[11px] leading-relaxed text-white/60">
              Newest fill on the tape: {iso(board.window.to)} · oldest: {iso(board.window.from)} ·
              read at {new Date(board.fetchedAt).toISOString().replace('.000', '')}.
            </p>
          ) : (
            <p className="mt-1 text-[11px] leading-relaxed text-white/60">
              GeckoTerminal returned no fill, so how current this is cannot be stated.
            </p>
          )}
          {board.anyCapped ? (
            <p className="mt-1 text-[11px] leading-relaxed text-amber-200">{TAPE_CAPPED_NOTICE}</p>
          ) : null}
        </>
      ) : null}
    </div>
  );
}
