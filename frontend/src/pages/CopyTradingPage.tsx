import { useMemo, useState } from 'react';
import { useAccount } from 'wagmi';
import { usePageTitle } from '../hooks/usePageTitle';
import { useCopyFollows, useSolanaFollowerAddress } from '../hooks/useCopyFollows';
import { useCopyLeaderboard } from '../hooks/useCopyLeaderboard';
import { useCopySignals } from '../hooks/useCopySignals';
import { useCopyFollowerFills } from '../hooks/useCopyFollowerFills';
import { useIslandTape } from '../hooks/useIslandTape';
import { useTapeSignals } from '../hooks/useTapeSignals';
import { useTapeFollowerFills } from '../hooks/useTapeFollowerFills';
import { CopyDataNotice } from '../components/copytrade/CopyDataNotice';
import { FollowForm } from '../components/copytrade/FollowForm';
import { FollowerRecord } from '../components/copytrade/FollowerRecord';
import { LeaderBoard } from '../components/copytrade/LeaderBoard';
import { MirrorQueue } from '../components/copytrade/MirrorQueue';
import { indexedQueueRows, tapeQueueRows } from '../components/copytrade/queueRows';
import { TapeLeaderBoard } from '../components/copytrade/TapeLeaderBoard';
import { TapeReadLedger } from '../components/copytrade/TapeReadLedger';
import { MIRROR_EXECUTION } from '../lib/copytrade/mirror';
import { TAPE_RETURN_RANKING } from '../lib/copytrade/tapeLeaderboard';
import { DEFAULT_QUOTE_TOKEN } from '../lib/copytrade/quoteTokens';
import type { PoolFamily } from '../lib/copytrade/tape';
import { PageArtBackdrop } from '../components/PageArtBackdrop';

// COPY TRADING — follow an address, size the mirror, place it yourself.
//
// Three sentences hold this page up and each of them is enforced somewhere other
// than in this file, so a layout change cannot quietly drop one:
//
//   1. No address on the board carries a profit figure. A pool fill is one leg
//      of one swap, never the round trip, so no realised return exists for
//      anyone — lib/copytrade/tapeLeaderboard.ts, TAPE_RETURN_RANKING.
//   2. Nothing here executes. The venue runs no keeper, so a leader's fill
//      cannot cause yours — lib/copytrade/mirror.ts, MIRROR_EXECUTION.
//   3. The one follower-relative number that IS shown is realised lag, measured
//      against the reader's own fills, and it is never stood in for by the
//      leader's numbers — lib/copytrade/tapeReconcile.ts.
//
// ─── WHAT THE PAGE READS, AND WHAT IT STILL CANNOT ───────────────────────────
//
// The live half is the ISLAND TAPE: GeckoTerminal's trade feed for the twelve
// island pools, the same feed each bungalow's own tape already uses. It needs no
// key, no proxy and no env var, so this page does something on a cold visit.
//
// The other half is the venue router (SwapFeeRouter), which only the Ponder
// indexer can see and which is hosted nowhere. With VITE_INDEXER_URL unset those
// three panels park dark and each says what it could not read — kept visible,
// and kept last, because hiding them would hide the fact that router fills are
// not on the tape at all. None of them draws an empty table, because an empty
// copy-trading board is a claim about every wallet at once.

export default function CopyTradingPage() {
  usePageTitle(
    'Copy Trading',
    'Follow an address seen filling the island’s pools and size a mirror against a per-trade cap. No address here carries a profit figure — a pool fill is one leg, never a round trip — and nothing executes on your behalf.',
  );

  const { address } = useAccount();
  const account = address ?? null;

  const { follows, intents, addFollow, removeFollow, recordMirror, persistError } = useCopyFollows();
  const solanaSelf = useSolanaFollowerAddress();
  const [leaderDraft, setLeaderDraft] = useState('');
  const [venue, setVenue] = useState<PoolFamily>('evm');

  // The board is other people. Both identities are excluded so the reader does
  // not rank against themselves on either chain.
  const exclude = useMemo(() => {
    const out: string[] = [];
    if (account) out.push(account);
    if (solanaSelf.address) out.push(solanaSelf.address);
    return out;
  }, [account, solanaSelf.address]);

  const tape = useIslandTape({ exclude });
  const tapeSignals = useTapeSignals({ tape: tape.tape, follows });
  const tapeFills = useTapeFollowerFills({
    tape: tape.tape,
    intents,
    evmAddress: account,
    solanaAddress: solanaSelf.address,
  });

  const board = useCopyLeaderboard({ quoteToken: DEFAULT_QUOTE_TOKEN.address, exclude });
  const signals = useCopySignals({ follows });
  const fills = useCopyFollowerFills({ follower: account, intents });

  const followed = useMemo(() => new Set(follows.map((f) => f.leader)), [follows]);
  const logged = useMemo(() => new Set(intents.map((i) => i.leaderTxHash)), [intents]);
  const fillsReadable = fills.status === 'ready' || fills.status === 'backfilling';
  const tapeReadable = tape.status === 'ready' || tape.status === 'partial';

  const myIntents = useMemo(
    () =>
      intents.filter((i) =>
        i.venue === 'solana'
          ? solanaSelf.address !== null && i.follower === solanaSelf.address
          : account !== null && i.follower === account.toLowerCase(),
      ),
    [intents, account, solanaSelf.address],
  );

  const tapeRows = useMemo(
    () =>
      tapeQueueRows(tapeSignals.candidates, tapeSignals.now, {
        evmAddress: account,
        solanaAddress: solanaSelf.address,
      }),
    [tapeSignals.candidates, tapeSignals.now, account, solanaSelf.address],
  );

  const routerRows = useMemo(
    () => indexedQueueRows(signals.candidates, signals.now, account),
    [signals.candidates, signals.now, account],
  );

  return (
    <div className="relative">
      <PageArtBackdrop pageId="copy-trading" />
      <div className="relative z-10 mx-auto w-full max-w-6xl px-4 py-8">
        <header>
          <h1 className="text-2xl font-bold text-white">Copy Trading</h1>
          <p className="mt-2 max-w-3xl text-sm leading-relaxed text-white/75">{TAPE_RETURN_RANKING.reason}</p>
          <p className="mt-2 max-w-3xl text-sm leading-relaxed text-white/75">{MIRROR_EXECUTION}</p>
        </header>

        <div className="mt-6 space-y-6">
          <TapeReadLedger
            status={tape.status}
            tape={tape.tape}
            board={tape.board}
            onRefresh={tape.refresh}
            refreshAvailableAt={tape.refreshAvailableAt}
          />

          {tapeReadable && tape.board ? (
            <TapeLeaderBoard
              board={tape.board}
              followerRecord={tapeFills.byLeader}
              followerRecordReadable={tapeFills.readable}
              onUse={(leader, family) => {
                setLeaderDraft(leader);
                setVenue(family);
              }}
              followed={followed}
            />
          ) : null}
        </div>

        <div className="mt-6 grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)]">
          <div className="space-y-6">
            <FollowForm
              follows={follows}
              account={account}
              leader={leaderDraft}
              onLeaderChange={setLeaderDraft}
              venue={venue}
              onVenueChange={setVenue}
              onAdd={(input) =>
                addFollow({
                  ...input,
                  follower: input.venue === 'solana' ? solanaSelf.address : account,
                  now: Math.floor(Date.now() / 1000),
                })
              }
              onRemove={removeFollow}
              persistError={persistError}
            />

            {tapeReadable ? (
              <MirrorQueue
                heading="Mirror queue — island pools"
                candidates={tapeRows}
                loggedTxHashes={logged}
                onLog={recordMirror}
              />
            ) : null}
          </div>

          <div className="space-y-6">
            <FollowerRecord
              outcomes={tapeFills.outcomes}
              byLeader={tapeFills.byLeader}
              account={account}
              solanaAddress={solanaSelf.address}
              onSaveSolanaAddress={(value) => solanaSelf.save(value) !== 'invalid'}
              onClearSolanaAddress={solanaSelf.clear}
              loggedCount={myIntents.length}
              readable={tapeFills.readable}
              unaddressed={tapeFills.unaddressed}
            />
          </div>
        </div>

        <section className="mt-10">
          <h2 className="text-sm font-semibold text-white">Venue router (needs the indexer)</h2>
          <p className="mt-1.5 max-w-3xl text-xs leading-relaxed text-white/70">
            Swaps routed through this venue's own SwapFeeRouter are not on the island tape — only the
            Ponder indexer records them, and it is hosted nowhere yet. These three panels stay
            visible in their unread state on purpose: an absent section would hide the fact that
            router fills are missing from everything above.
          </p>

          <div className="mt-4 grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)]">
            <div className="space-y-6">
              <CopyDataNotice
                status={signals.status}
                detail={signals.detail}
                subject="the followed wallets' router trades"
                notAZero="An unread feed is not a quiet leader. Nothing below is a statement about what these wallets have or have not done."
                syncedAt={signals.syncedAt}
                onRetry={signals.reload}
              />
              {signals.status === 'ready' || signals.status === 'backfilling' ? (
                <MirrorQueue
                  heading="Mirror queue — venue router"
                  candidates={routerRows}
                  loggedTxHashes={logged}
                  onLog={recordMirror}
                />
              ) : null}
            </div>

            <div className="space-y-6">
              <CopyDataNotice
                status={board.status}
                detail={board.detail}
                subject="the router follow board"
                notAZero="An unread board is not an idle venue. Nothing below is a statement about who has been trading."
                syncedAt={board.syncedAt}
                onRetry={board.reload}
              />
              {board.board ? (
                <LeaderBoard
                  board={board.board}
                  followerRecord={fills.byLeader}
                  followerRecordReadable={fillsReadable}
                  onFollow={(leader) => {
                    setLeaderDraft(leader);
                    setVenue('evm');
                  }}
                  followed={followed}
                />
              ) : null}

              <CopyDataNotice
                status={fills.status}
                detail={fills.detail}
                subject="your own router fill history"
                notAZero="An unread history is not a history of failures. A mirror that cannot be looked up has not been shown to have missed."
                syncedAt={fills.syncedAt}
                onRetry={fills.reload}
              />
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}
