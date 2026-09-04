import { useMemo, useState } from 'react';
import {
  CUP_SENDER,
  cupShareText,
  findRank,
  formatUsdMicros,
  utcMinute,
  type CupBoard,
  type CupBoardStatus,
} from '../../lib/competitions/islandCup';
import { ShareCard } from './ShareCard';

// FINDING YOURSELF, AND THE SENTENCE FOR WHEN YOU ARE NOT THERE.
//
// The interesting case is the miss. A wallet that does not appear in this read
// has NOT been shown to be idle: it may have traded on a pool the island does
// not register, on a venue this app does not read, or outside the window the
// feed served. "Not found" on a leaderboard reads as "you did nothing", and that
// is a false statement about somebody's own trading, produced by the limits of
// the read rather than by anything they did.
//
// The connected wallet is used as the default query so the common case needs no
// typing, but the field stays editable: the board's senders are transaction
// senders, so somebody trading through a bot or a router will want to look up an
// address that is not the one in their wallet.

export interface YourRankProps {
  board: CupBoard;
  status: CupBoardStatus;
  /** The connected address, or null. Only ever a default for the input. */
  account?: string | null;
}

export function YourRank({ board, status, account }: YourRankProps) {
  const [typed, setTyped] = useState('');
  const query = typed.trim() === '' ? (account ?? '') : typed.trim();
  const hit = useMemo(() => (query ? findRank(board, query) : null), [board, query]);

  const newestIso = board.newestFillAt === null ? null : utcMinute(board.newestFillAt);
  const share =
    hit && newestIso
      ? cupShareText(hit.rank, hit.of, board.poolsAnswered, board.poolsTotal, status, newestIso)
      : null;

  return (
    <section className="rounded-xl border border-white/15 bg-white/[0.02] p-4">
      <h2 className="text-sm font-semibold text-white">Find a sender</h2>

      <label
        htmlFor="competition-find-wallet"
        className="mt-2 block text-[11px] font-medium uppercase tracking-wide text-white/60"
      >
        Wallet or sender address
        <input
          id="competition-find-wallet"
          type="text"
          inputMode="text"
          autoComplete="off"
          spellCheck={false}
          value={typed}
          onChange={(e) => setTyped(e.target.value)}
          placeholder={account ?? '0x… or a base58 address'}
          className="mt-1 block min-h-[44px] w-full max-w-md rounded-md border border-white/20 bg-black/40 px-2.5 py-1 font-mono text-xs text-white placeholder:text-white/35"
        />
      </label>

      {query === '' ? (
        <p className="mt-2.5 text-xs leading-relaxed text-white/70">
          Connect a wallet or paste an address to look it up in this read.
        </p>
      ) : hit ? (
        <>
          <p className="mt-2.5 text-xs leading-relaxed text-white/85">
            You are #{hit.rank} of {hit.of} senders in this read, with{' '}
            {formatUsdMicros(hit.row.countedVolume)} counted over {hit.row.countedTrades} fill
            {hit.row.countedTrades === 1 ? '' : 's'} on {hit.row.poolsTouched} pool
            {hit.row.poolsTouched === 1 ? '' : 's'}
            {hit.row.washedLegs > 0
              ? `, and ${hit.row.washedLegs} leg${hit.row.washedLegs === 1 ? '' : 's'} struck as round trips`
              : ''}
            .
          </p>
          {share ? <ShareCard text={share} /> : null}
        </>
      ) : (
        <p className="mt-2.5 text-xs leading-relaxed text-white/75">
          This wallet does not appear in this read — that is not a statement that it was idle. Only
          the pools listed above were read, only over the window they all cover, and only fills the
          feed priced are scored.
        </p>
      )}

      <p className="mt-3 text-[11px] leading-relaxed text-white/55">{CUP_SENDER}.</p>
    </section>
  );
}
