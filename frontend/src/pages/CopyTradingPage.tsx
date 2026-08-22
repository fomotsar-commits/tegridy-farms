import { useMemo, useState } from 'react';
import { useAccount } from 'wagmi';
import { usePageTitle } from '../hooks/usePageTitle';
import { useCopyFollows } from '../hooks/useCopyFollows';
import { useCopyLeaderboard } from '../hooks/useCopyLeaderboard';
import { useCopySignals } from '../hooks/useCopySignals';
import { useCopyFollowerFills } from '../hooks/useCopyFollowerFills';
import { CopyDataNotice } from '../components/copytrade/CopyDataNotice';
import { FollowForm } from '../components/copytrade/FollowForm';
import { FollowerRecord } from '../components/copytrade/FollowerRecord';
import { LeaderBoard } from '../components/copytrade/LeaderBoard';
import { MirrorQueue } from '../components/copytrade/MirrorQueue';
import { MIRROR_EXECUTION } from '../lib/copytrade/mirror';
import { DEFAULT_QUOTE_TOKEN } from '../lib/copytrade/quoteTokens';
import { PageArtBackdrop } from '../components/PageArtBackdrop';

// COPY TRADING — follow a wallet, size the mirror, place it yourself.
//
// Three sentences hold this page up and each of them is enforced somewhere other
// than in this file, so a layout change cannot quietly drop one:
//
//   1. No wallet on the board carries a profit figure. Indexed swaps record what
//      was spent and never what came back, so no return exists for anyone —
//      lib/copytrade/leaderboard.ts, RETURN_RANKING.
//   2. Nothing here executes. The venue runs no keeper, so a leader's trade
//      cannot cause yours — lib/copytrade/mirror.ts, MIRROR_EXECUTION.
//   3. The one follower-relative number that IS shown is realised lag, measured
//      against the reader's own swaps, and it is never stood in for by the
//      leader's numbers — lib/copytrade/followerRelative.ts.
//
// And the resting state of the whole page is "unavailable": the indexer is not
// hosted, so with VITE_INDEXER_URL unset every read parks dark and each panel
// says what it could not read. None of them draws an empty table, because an
// empty copy-trading board is a claim about every wallet on the chain.

export default function CopyTradingPage() {
  usePageTitle(
    'Copy Trading',
    'Follow a wallet and size a mirror against a per-trade cap. No wallet here carries a profit figure — indexed swaps record what was spent and never what came back — and nothing executes on your behalf.',
  );

  const { address } = useAccount();
  const account = address ?? null;

  const { follows, intents, addFollow, removeFollow, recordMirror, persistError } = useCopyFollows();
  const [leaderDraft, setLeaderDraft] = useState('');

  const exclude = useMemo(() => (account ? [account] : []), [account]);

  const board = useCopyLeaderboard({ quoteToken: DEFAULT_QUOTE_TOKEN.address, exclude });
  const signals = useCopySignals({ follows });
  const fills = useCopyFollowerFills({ follower: account, intents });

  const followed = useMemo(() => new Set(follows.map((f) => f.leader)), [follows]);
  const logged = useMemo(() => new Set(intents.map((i) => i.leaderTxHash)), [intents]);
  const fillsReadable = fills.status === 'ready' || fills.status === 'backfilling';

  return (
    <div className="relative">
      <PageArtBackdrop pageId="copy-trading" />
      <div className="relative z-10 mx-auto w-full max-w-6xl px-4 py-8">
        <header>
          <h1 className="text-2xl font-bold text-white">Copy Trading</h1>
          <p className="mt-2 max-w-3xl text-sm leading-relaxed text-white/75">
            Most copied edges disappear once they are mirrored: you see the trade after it happened,
            you buy later, and you sell later. So no wallet on this page is ranked by its own
            returns — the number a follower would actually receive is not the number a leader
            earned, and neither one can be computed from this venue's indexed history anyway.
          </p>
          <p className="mt-2 max-w-3xl text-sm leading-relaxed text-white/75">{MIRROR_EXECUTION}</p>
        </header>

        <div className="mt-6 grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)]">
          <div className="space-y-6">
            <FollowForm
              follows={follows}
              account={account}
              leader={leaderDraft}
              onLeaderChange={setLeaderDraft}
              onAdd={(input) => addFollow({ ...input, follower: account, now: Math.floor(Date.now() / 1000) })}
              onRemove={removeFollow}
              persistError={persistError}
            />

            <CopyDataNotice
              status={signals.status}
              detail={signals.detail}
              subject="the followed wallets' recent trades"
              notAZero="An unread feed is not a quiet leader. Nothing below is a statement about what these wallets have or have not done."
              syncedAt={signals.syncedAt}
              onRetry={signals.reload}
            />
            {signals.status === 'ready' || signals.status === 'backfilling' ? (
              <MirrorQueue
                candidates={signals.candidates}
                now={signals.now}
                account={account}
                loggedTxHashes={logged}
                onLog={recordMirror}
              />
            ) : null}
          </div>

          <div className="space-y-6">
            <CopyDataNotice
              status={board.status}
              detail={board.detail}
              subject="the follow board"
              notAZero="An unread board is not an idle venue. Nothing below is a statement about who has been trading."
              syncedAt={board.syncedAt}
              onRetry={board.reload}
            />
            {board.board ? (
              <LeaderBoard
                board={board.board}
                followerRecord={fills.byLeader}
                followerRecordReadable={fillsReadable}
                onFollow={setLeaderDraft}
                followed={followed}
              />
            ) : null}

            <CopyDataNotice
              status={fills.status}
              detail={fills.detail}
              subject="your own mirror history"
              notAZero="An unread history is not a history of failures. A mirror that cannot be looked up has not been shown to have missed."
              syncedAt={fills.syncedAt}
              onRetry={fills.reload}
            />
            <FollowerRecord
              outcomes={fills.outcomes}
              byLeader={fills.byLeader}
              account={account}
              loggedCount={account ? intents.filter((i) => i.follower === account.toLowerCase()).length : 0}
              readable={fillsReadable}
            />
          </div>
        </div>
      </div>
    </div>
  );
}
