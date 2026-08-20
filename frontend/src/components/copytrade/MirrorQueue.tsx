import { Link } from 'react-router-dom';
import {
  MAX_SIGNAL_AGE_SECONDS,
  MIRROR_EXECUTION,
  MIRROR_REFUSAL_TEXT,
  type MirrorCandidate,
} from '../../lib/copytrade/mirror';
import { formatQuoteAmount } from '../../lib/copytrade/quoteTokens';
import type { MirrorIntent } from '../../lib/copytrade/follows';
import { shortenAddress } from '../../lib/formatting';

// Every read trade by a followed wallet — the copyable ones AND the ones that
// are not.
//
// REFUSALS ARE ROWS, NOT OMISSIONS. A queue that showed only the actionable
// trades would present a leader as a stream of clean opportunities while hiding
// that most of what they did could not be mirrored at all: wrong quote token,
// too old to still be the same trade. The ratio between the two is the single
// most useful thing on this page and it only exists if both are drawn.
//
// The button does exactly what its label says and nothing more. It writes a
// timestamped note in this browser; it does not sign, submit, or pre-fill a
// trade. That note is what lets the fill rate and the entry lag be measured
// later against real swaps, and it is the reason the log is written BEFORE the
// trade rather than after it.

export interface MirrorQueueProps {
  candidates: readonly MirrorCandidate[];
  /** Unix seconds the plans were judged against. */
  now: number;
  account?: string | null;
  /** Leader tx hashes already logged by this browser. */
  loggedTxHashes: ReadonlySet<string>;
  onLog: (intent: MirrorIntent) => void;
}

export function MirrorQueue({ candidates, now, account, loggedTxHashes, onLog }: MirrorQueueProps) {
  const copyable = candidates.filter((c) => c.outcome.ok).length;

  return (
    <section className="rounded-xl border border-white/15 bg-white/[0.02] p-4">
      <h2 className="text-sm font-semibold text-white">Mirror queue</h2>
      <p className="mt-1.5 text-xs leading-relaxed text-white/70">{MIRROR_EXECUTION}</p>
      <p className="mt-1.5 text-[11px] leading-relaxed text-white/60">
        {candidates.length} trade{candidates.length === 1 ? '' : 's'} read from followed wallets,{' '}
        {copyable} of which can be sized right now. A trade older than{' '}
        {Math.round(MAX_SIGNAL_AGE_SECONDS / 60)} minutes is listed with its reason instead of a
        size — copying it would be a different trade at a different price.
      </p>

      {candidates.length === 0 ? (
        <p className="mt-4 text-xs text-white/70">
          No trades came back for the followed wallets inside the window read. Within that window
          this is a measurement; outside it, nothing was looked at.
        </p>
      ) : (
        <ul className="mt-4 space-y-3">
          {candidates.map((candidate) => (
            <li
              key={`${candidate.follow.leader}:${candidate.swap.id}`}
              className="rounded-lg border border-white/10 bg-black/20 px-3 py-2.5"
            >
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <p className="font-mono text-xs text-white">{shortenAddress(candidate.follow.leader, 6)}</p>
                <p className="text-[10px] text-white/55">
                  {Math.max(0, now - Number(candidate.swap.timestamp))}s ago ·{' '}
                  {shortenAddress(candidate.swap.tokenIn, 4)} → {shortenAddress(candidate.swap.tokenOut, 4)}
                </p>
              </div>

              {candidate.outcome.ok ? (
                <div className="mt-2">
                  <p className="text-xs text-white/85">
                    Mirror size {formatQuoteAmount(candidate.outcome.plan.notionalWei, candidate.outcome.plan.tokenIn)}
                    {candidate.outcome.plan.capped ? (
                      <span className="text-amber-200">
                        {' '}
                        — your cap, not their size (they spent{' '}
                        {formatQuoteAmount(candidate.outcome.plan.leaderAmountIn, candidate.outcome.plan.tokenIn)})
                      </span>
                    ) : null}
                  </p>
                  <p className="mt-1 text-[10px] leading-snug text-white/55">
                    {candidate.outcome.plan.minOutReason}
                  </p>
                  <div className="mt-2 flex flex-wrap items-center gap-2">
                    {loggedTxHashes.has(candidate.outcome.plan.leaderTxHash) ? (
                      <span className="text-[11px] text-white/60">Logged</span>
                    ) : (
                      <button
                        type="button"
                        disabled={!account}
                        onClick={() => {
                          if (!account || !candidate.outcome.ok) return;
                          onLog({
                            leader: candidate.follow.leader,
                            leaderTxHash: candidate.outcome.plan.leaderTxHash,
                            leaderTimestamp: candidate.outcome.plan.leaderTimestamp,
                            confirmedAt: Math.floor(Date.now() / 1000),
                            follower: account.toLowerCase(),
                            quoteToken: candidate.outcome.plan.tokenIn,
                            tokenOut: candidate.outcome.plan.tokenOut,
                            notionalWei: candidate.outcome.plan.notionalWei,
                          });
                        }}
                        className="rounded-md border border-white/25 px-2.5 py-1 text-[11px] font-medium text-white hover:bg-white/10 disabled:opacity-40"
                      >
                        Log this mirror
                      </button>
                    )}
                    <Link to="/swap" className="text-[11px] text-white/70 underline hover:text-white">
                      Open Trade
                    </Link>
                    <span className="text-[10px] text-white/50">
                      Logging records that you decided to mirror. It places no trade and fills
                      nothing in — you enter it yourself on the Trade page.
                    </span>
                  </div>
                  {account ? null : (
                    <p className="mt-1 text-[10px] text-white/55">
                      Connect a wallet to log this. Without one there is no address to measure a
                      fill against later.
                    </p>
                  )}
                </div>
              ) : (
                <p className="mt-2 text-xs leading-relaxed text-amber-200/90">
                  {MIRROR_REFUSAL_TEXT[candidate.outcome.reason]}
                </p>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
