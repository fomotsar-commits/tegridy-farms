import { useState } from 'react';
import {
  FILL_MATCH_WINDOW_SECONDS,
  FOLLOWER_RETURN_UNMEASURABLE,
  MATCH_BASIS,
} from '../../lib/copytrade/followerRelative';
import {
  TAPE_AWAITING,
  TAPE_MATCH_LIMIT,
  type TapeFollowerSummary,
  type TapeOutcomeRow,
} from '../../lib/copytrade/tapeReconcile';
import { formatQuoteAmount } from '../../lib/copytrade/quoteTokens';
import { shortenAddress } from '../../lib/formatting';

// Your own mirrors: how late you were, and whether the mirror happened at all.
//
// This is the closest thing to performance anywhere in the slice and it is still
// not performance — `FOLLOWER_RETURN_UNMEASURABLE` says so at the top rather than
// leaving the reader to infer it from the absence of a profit column. The lag and
// the not-filled count are both outcomes; a copy-trading surface that reported
// neither would be reporting only the decision to trade, which always looks good.
//
// ─── AND 'UNVERIFIABLE' IS NOT 'DID NOT HAPPEN' ──────────────────────────────
//
// The tape reaches back only as far as GeckoTerminal returned for each pool. A
// mirror older than that, or on a pool that could not be read, cannot be
// confirmed AND cannot be called missed — so it gets its own word and its own
// count. Folding it into "never filled" would print a personal failure rate
// manufactured by a third-party feed's page size.
//
// ─── THE SOLANA ADDRESS IS PASTED, AND NOTHING IS SIGNED ─────────────────────
//
// This route mounts no Solana wallet provider, so there is no connect button to
// offer and none is faked. What the reconciliation needs is a string to look for
// the reader's own fills under; it is validated as a real 32-byte key before it
// is stored, and it grants nothing.

export interface FollowerRecordProps {
  outcomes: readonly TapeOutcomeRow[];
  byLeader: readonly TapeFollowerSummary[];
  account?: string | null;
  /** The pasted Solana pubkey, when the reader has supplied one. */
  solanaAddress: string | null;
  /** Returns false when the value was not a 32-byte key; the form then says so. */
  onSaveSolanaAddress: (value: string) => boolean;
  onClearSolanaAddress: () => void;
  /**
   * Mirrors this browser has logged for the identities supplied. Checked BEFORE
   * the read state: "you have logged nothing" and "your history could not be
   * read" are different sentences, and showing the second one to somebody who
   * simply has not started would report an outage that is not happening.
   */
  loggedCount: number;
  /** False when the tape did not land — counts below say nothing. */
  readable: boolean;
  /** Logged mirrors on a venue whose address the reader has not supplied. */
  unaddressed: number;
}

export function FollowerRecord({
  outcomes,
  byLeader,
  account,
  solanaAddress,
  onSaveSolanaAddress,
  onClearSolanaAddress,
  loggedCount,
  readable,
  unaddressed,
}: FollowerRecordProps) {
  const hasIdentity = Boolean(account) || solanaAddress !== null;

  return (
    <section className="rounded-xl border border-white/15 bg-white/[0.02] p-4">
      <h2 className="text-sm font-semibold text-white">Your mirrors, as they actually went</h2>
      <p className="mt-1.5 text-xs leading-relaxed text-white/80">{FOLLOWER_RETURN_UNMEASURABLE}</p>
      <p className="mt-1.5 text-[11px] leading-relaxed text-white/60">{MATCH_BASIS}</p>
      <p className="mt-1.5 text-[11px] leading-relaxed text-white/60">{TAPE_MATCH_LIMIT}</p>

      <SolanaIdentityField
        address={solanaAddress}
        onSave={onSaveSolanaAddress}
        onClear={onClearSolanaAddress}
      />

      {unaddressed > 0 ? (
        <p className="mt-3 text-[11px] leading-relaxed text-amber-200">
          {unaddressed} logged mirror{unaddressed === 1 ? '' : 's'} sit on a venue whose address you
          have not supplied here, so {unaddressed === 1 ? 'it is' : 'they are'} not judged either
          way.
        </p>
      ) : null}

      {!hasIdentity ? (
        <p className="mt-4 text-xs leading-relaxed text-white/70">
          No address is available, so there is nothing to look for fills under. Nothing here is a
          statement about mirrors you may have placed.
        </p>
      ) : loggedCount === 0 ? (
        <p className="mt-4 text-xs leading-relaxed text-white/70">
          You have logged no mirrors from this browser. The log lives here and nowhere else, so a
          different browser or a cleared cache starts this record over.
        </p>
      ) : !readable ? (
        <p className="mt-4 text-xs leading-relaxed text-white/70">
          The island tape could not be read, so none of the {loggedCount} mirror
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
                  {row.filled} matched · {row.notFilled} never filled · {row.awaiting} awaiting the
                  next read · {row.unverifiable} unverifiable
                </span>
                {row.medianEntryLagSeconds !== null && row.worstEntryLagSeconds !== null ? (
                  <span>
                    median {formatSeconds(row.medianEntryLagSeconds)} behind them, worst{' '}
                    {formatSeconds(row.worstEntryLagSeconds)}
                  </span>
                ) : (
                  <span className="text-white/55">no matched fill to measure a lag from</span>
                )}
              </li>
            ))}
          </ul>

          <div className="mt-4 overflow-x-auto">
            <table className="w-full min-w-[42rem] text-left text-xs">
              <caption className="sr-only">
                Each mirror you logged, with whether a matching fill was found on the island tape and
                how far behind the leader it landed. No profit figure is shown.
              </caption>
              <thead className="text-[10px] uppercase tracking-wide text-white/55">
                <tr>
                  <th scope="col" className="py-1.5 pr-3 font-medium">Leader</th>
                  <th scope="col" className="py-1.5 pr-3 font-medium">Logged</th>
                  <th scope="col" className="py-1.5 pr-3 font-medium">Outcome</th>
                  <th scope="col" className="py-1.5 pr-3 font-medium">Behind the leader</th>
                  <th scope="col" className="py-1.5 font-medium">You planned</th>
                </tr>
              </thead>
              <tbody className="text-white/85">
                {outcomes.map((row) => (
                  <tr key={`${row.intent.leaderTxHash}:${row.intent.confirmedAt}`} className="border-t border-white/10">
                    <td className="py-2 pr-3 font-mono">{shortenAddress(row.intent.leader, 6)}</td>
                    <td className="py-2 pr-3">
                      {new Date(row.intent.confirmedAt * 1000).toISOString().slice(0, 16).replace('T', ' ')}
                    </td>
                    <td className="py-2 pr-3">
                      {row.state === 'filled' ? (
                        <span className="text-emerald-200">Matched a fill</span>
                      ) : row.state === 'awaiting' ? (
                        <span className="text-white/70">
                          Inside the {Math.round(FILL_MATCH_WINDOW_SECONDS / 60)}-minute window —{' '}
                          {TAPE_AWAITING}
                        </span>
                      ) : row.state === 'unverifiable' ? (
                        <span className="text-white/70">
                          Unverifiable — {row.unverifiableBecause}
                        </span>
                      ) : (
                        <span className="text-amber-200">No matching fill — this mirror did not happen</span>
                      )}
                    </td>
                    <td className="py-2 pr-3">
                      {row.entryLagSeconds === null ? (
                        <span className="text-white/55">—</span>
                      ) : (
                        `${formatSeconds(row.entryLagSeconds)} later`
                      )}
                    </td>
                    <td className="py-2">{formatQuoteAmount(row.intent.notionalWei, row.intent.quoteToken)}</td>
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

function SolanaIdentityField({
  address,
  onSave,
  onClear,
}: {
  address: string | null;
  onSave: (value: string) => boolean;
  onClear: () => void;
}) {
  const [draft, setDraft] = useState('');
  const [error, setError] = useState<string | null>(null);

  return (
    <div className="mt-3 rounded-lg border border-white/10 bg-black/20 px-3 py-2.5">
      <label htmlFor="copy-solana-self" className="block text-[11px] font-medium uppercase tracking-wide text-white/60">
        Your Solana wallet (read-only, pasted — nothing is signed)
      </label>
      {address ? (
        <div className="mt-1 flex flex-wrap items-center gap-2">
          <p id="copy-solana-self" className="font-mono text-xs text-white">{shortenAddress(address, 6)}</p>
          <button
            type="button"
            onClick={onClear}
            className="min-h-11 min-w-11 rounded-md border border-white/25 px-3 py-1 text-[11px] font-medium text-white hover:bg-white/10"
          >
            Forget it
          </button>
        </div>
      ) : (
        <div className="mt-1 flex flex-wrap items-center gap-2">
          <input
            id="copy-solana-self"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="base58 address…"
            spellCheck={false}
            className="min-h-11 min-w-0 flex-1 rounded-md border border-white/20 bg-black/40 px-2.5 py-1.5 font-mono text-xs text-white"
          />
          <button
            type="button"
            onClick={() => {
              const ok = onSave(draft);
              setError(ok ? null : 'That is not a 32-byte Solana address, so nothing was saved.');
              if (ok) setDraft('');
            }}
            className="min-h-11 min-w-11 rounded-md border border-white/25 px-3 py-1 text-[11px] font-medium text-white hover:bg-white/10"
          >
            Save
          </button>
        </div>
      )}
      <p className="mt-1 text-[10px] leading-snug text-white/55">
        Used only to look for your own fills on the Solana pools. This page mounts no Solana wallet
        and asks for no signature.
      </p>
      {error ? (
        <p className="mt-1 text-[11px] text-amber-200" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}

function formatSeconds(seconds: number): string {
  if (seconds < 90) return `${seconds}s`;
  if (seconds < 5400) return `${Math.round(seconds / 60)}m`;
  return `${(seconds / 3600).toFixed(1)}h`;
}
