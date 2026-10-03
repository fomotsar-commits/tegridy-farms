import { useCallback, useEffect, useRef, useState } from 'react';
import { clipDetail } from '../../../lib/launcher/solana/curve';
import { isLpKind } from '../../../lib/launcher/solana/write/lpKinds';
import { PENDING_TRADE_TTL_MS, clearPendingTrade, readPendingTrades, savePendingTrade, type PendingTrade } from './pendingTrade';
import type { LpKind, PreparedTx, TxOutcome, TxSummary } from './ports';

/**
 * The page-level half of "sent, not confirmed yet": a transaction in this scope (one
 * launch's trades, or every liquidity change) that this browser sent and could not
 * confirm survives a reload or a trip away from the page.
 *
 * The note is written the moment the transaction is SENT (`sent`, called before the
 * first byte leaves), not when the wait for it ends: a reload during that wait must
 * not bring back an open trade form while the first trade can still land. It is
 * cleared or kept by the final answer (`record`).
 *
 * While any note stands, the page shows it instead of the trade forms, and checks it
 * against the chain (once on its own, then on "Check again"). A note goes away only
 * when the chain answers (confirmed, refused, or expired: past its blockhash window
 * with no record), or when the person says they checked their wallet.
 */
export interface PendingTradesState {
  /** Newest first. Non-empty = trade forms stay hidden. */
  notes: PendingTrade[];
  checking: boolean;
  /** Why the last check could not settle it, in plain words. */
  message: string | null;
  recheck(): void;
  /** "I checked my wallet": drop every note in this scope. */
  dismiss(): void;
  /** Feed every settled transaction here (a panel's onSettled). */
  record(outcome: TxOutcome, prepared: PreparedTx | null, sentSignature?: string | null): void;
  /** A trade is about to be sent (a panel's onSent): write its note now. */
  sent(signature: string, prepared: PreparedTx): void;
}

type LpSummary = Extract<TxSummary, { kind: LpKind }>;

/** A liquidity summary (adding, removing or opening a pool), each of which names its pool. */
function isLpSummary(s: TxSummary): s is LpSummary {
  return isLpKind(s.kind);
}

/** The pool a liquidity note names; nothing for any other kind. */
function poolOf(p: PreparedTx): string | null {
  return isLpSummary(p.summary) ? p.summary.pool.toBase58() : null;
}

/**
 * Look a note's transaction up again. A liquidity note's check is also told its kind,
 * so a refusal found there is said in that kind's own words ("Withdrawals are switched
 * off on this pool…"), not as a bare program error. Every other note is checked with
 * the two arguments it always was.
 */
export type CheckSignature = (signature: string, lastValidBlockHeight: number | null, kind?: LpKind) => Promise<TxOutcome>;

export function usePendingTrades(
  /** The storage scope: `curveTradeScope(mint)` for a launch, `LP_PENDING_SCOPE` for liquidity. */
  scope: string,
  /** `null` until the page can reach the chain; the first check runs once it can. */
  check: CheckSignature | null,
  /** The chain answered for at least one note: read the launch again. */
  onResolved: () => void,
  /**
   * `live`: the notes this hook writes and clears are in `notes` at once, not only after
   * a reload, and a note it wrote stays there while this tab lives even when
   * sessionStorage throws. The liquidity section asks for it: its notes hold forms on
   * EVERY card in the tab (another pool, another token), and the panel that sent one can
   * be closed or left. The curve page does not: its own panel keeps showing the "sent"
   * step, and a non-empty `notes` would hide that panel's form.
   */
  o: { live?: boolean } = {},
): PendingTradesState {
  const live = o.live === true;
  // Live only: the notes this tab wrote, so a blocked sessionStorage still holds here.
  const written = useRef(new Map<string, PendingTrade>());
  const current = useCallback((): PendingTrade[] => {
    const stored = readPendingTrades(scope);
    if (!live) return stored;
    const now = Date.now();
    const seen = new Set(stored.map((n) => n.signature));
    const extra = [...written.current.values()].filter((n) => !seen.has(n.signature) && now - n.sentAt <= PENDING_TRADE_TTL_MS);
    return [...stored, ...extra].sort((a, b) => b.sentAt - a.sentAt);
  }, [scope, live]);
  const [notes, setNotes] = useState<PendingTrade[]>(() => readPendingTrades(scope));
  const [checking, setChecking] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const busy = useRef(false);
  const autoChecked = useRef(false);
  const resolvedRef = useRef(onResolved);
  useEffect(() => {
    resolvedRef.current = onResolved;
  }, [onResolved]);

  const recheck = useCallback(async () => {
    if (!check || busy.current) return;
    const toCheck = current();
    if (toCheck.length === 0) {
      setNotes([]);
      return;
    }
    busy.current = true;
    setChecking(true);
    let resolved = false;
    let last: string | null = null;
    for (const n of toCheck) {
      let o: TxOutcome;
      try {
        o = await (isLpKind(n.kind)
          ? check(n.signature, n.lastValidBlockHeight, n.kind)
          : check(n.signature, n.lastValidBlockHeight));
      } catch (e) {
        // A failed read changes nothing we know: the note stays.
        o = { status: 'unknown', signature: n.signature, message: `Could not check just now (${clipDetail(e)}).` };
      }
      if (o.status === 'confirmed' || o.status === 'reverted' || o.status === 'expired') {
        clearPendingTrade(scope, n.signature);
        written.current.delete(n.signature);
        resolved = true;
      } else if (o.status === 'unknown') {
        last = o.message;
      }
    }
    busy.current = false;
    setChecking(false);
    setMessage(last);
    setNotes(current());
    if (resolved) resolvedRef.current();
  }, [check, scope, current]);

  // Check on arrival, before any form this scope holds is shown.
  useEffect(() => {
    if (!check || autoChecked.current || notes.length === 0) return;
    autoChecked.current = true;
    void recheck();
  }, [check, notes.length, recheck]);

  const dismiss = useCallback(() => {
    if (busy.current) return;
    clearPendingTrade(scope);
    written.current.clear();
    setNotes([]);
    setMessage(null);
  }, [scope]);

  /** Live only: what this tab now holds, after a write or a clear of `signature`. */
  const follow = useCallback(
    (note: PendingTrade | null, cleared: string | null) => {
      if (!live) return;
      if (note) written.current.set(note.signature, note);
      if (cleared) written.current.delete(cleared);
      // The arrival check is for notes found on load; a note written here has its own
      // panel's answer coming (or Check again on the card).
      autoChecked.current = true;
      setNotes(current());
    },
    [live, current],
  );

  const sent = useCallback(
    (signature: string, prepared: PreparedTx) => {
      if (prepared.kind === 'create') return;
      // Storage: the note is what a reload, or a trip away and back, finds. Without
      // `live`, storage only: the panel that sent it keeps showing its own "sent" step.
      const note = { kind: prepared.kind, signature, lastValidBlockHeight: prepared.lastValidBlockHeight, pool: poolOf(prepared) };
      savePendingTrade(scope, note);
      follow({ ...note, sentAt: Date.now() }, null);
    },
    [scope, follow],
  );

  const record = useCallback(
    (outcome: TxOutcome, prepared: PreparedTx | null, sentSignature?: string | null) => {
      if (!prepared || prepared.kind === 'create') return;
      // A `not-sent` after `sent` (turned away at the first send) has no signature of
      // its own; the one it was sent with names the note to clear.
      const sig = ('signature' in outcome && outcome.signature) || sentSignature || '';
      if (!sig) return;
      if (outcome.status === 'unknown') {
        const note = { kind: prepared.kind, signature: sig, lastValidBlockHeight: prepared.lastValidBlockHeight, pool: poolOf(prepared) };
        savePendingTrade(scope, note);
        follow({ ...note, sentAt: Date.now() }, null);
      } else {
        // Confirmed, refused or expired: the chain answered for this one.
        clearPendingTrade(scope, sig);
        follow(null, sig);
      }
    },
    [scope, follow],
  );

  return { notes, checking, message, recheck: () => void recheck(), dismiss, record, sent };
}
