import { useCallback, useEffect, useRef, useState } from 'react';
import { clipDetail } from '../../../lib/launcher/solana/curve';
import { isLpKind } from '../../../lib/launcher/solana/write/lpKinds';
import type { NoteBlockhash } from '../../../lib/solana/blockhashWindow';
import {
  clearPendingTrade,
  isSharedScope,
  noteKey,
  noteOf,
  noteTtl,
  pendingStorageKey,
  readPendingTrades,
  savePendingTrade,
  type NewNote,
  type PendingTrade,
} from './pendingTrade';
import type { LpKind, PreparedTx, TxOutcome, TxSummary } from './ports';

/**
 * The page-level half of "sent, not confirmed yet": a transaction in this scope (one
 * launch's trades, every liquidity change, or one wallet's swaps) that this browser sent
 * and could not confirm survives a reload or a trip away from the page.
 *
 * The note is written the moment the transaction is SENT (`sent`, called before the
 * first byte leaves), not when the wait for it ends: a reload during that wait must
 * not bring back an open trade form while the first trade can still land. It is
 * cleared or kept by the final answer (`record`).
 *
 * While any note stands, the page shows it instead of the trade forms, and checks it
 * against the chain (once on its own, then on "Check again"). A note goes away only
 * when the chain answers (confirmed, refused, or expired: past its blockhash window
 * with no record), when the person says they checked their wallet, or ten minutes
 * after it was sent (PENDING_TRADE_TTL_MS), when it can no longer land either way. A
 * note with no signature (a lost wallet answer) ends on its blockhash, or after two.
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
  /** A transaction this page did not prepare (the wallet sent it, or its answer was lost): write its note now. */
  hold(t: Omit<NewNote, 'pool'>, scope?: string): void;
  /** The chain answered for one of them: drop its note (by `noteKey`: its signature when it has one). */
  release(key: string, scope?: string): void;
  /**
   * Read again now: does a note hold this scope (this hook's own by default)? A note
   * another tab wrote counts before its event arrives. The notes on screen follow.
   */
  holdsNow(scope?: string | null): boolean;
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
 * off on this pool…"), not as a bare program error. A note with a blockhash is told it
 * too; every other note is checked with the two arguments it always was.
 */
export type CheckSignature = (signature: string, lastValidBlockHeight: number | null, kind?: LpKind, blockhash?: NoteBlockhash) => Promise<TxOutcome>;
/** A note with no signature: true once its blockhash can no longer land, null when that could not be read. */
export type CheckLost = (blockhash: NoteBlockhash) => Promise<boolean | null>;
/** Said on the card when a note with no signature could not be checked. */
export const LOST_UNREAD = 'Could not check just now whether it can still land.';

export function usePendingTrades(
  /**
   * The storage scope: `curveTradeScope(mint)` for a launch, `LP_PENDING_SCOPE` for
   * liquidity, `swapPendingScope(wallet)` for the swap page; null holds nothing (no wallet).
   */
  scope: string | null,
  /** `null` until the page can reach the chain; the first check runs once it can. */
  check: CheckSignature | null,
  /** The chain answered for at least one note: read the launch again. */
  onResolved: () => void,
  /**
   * `live`: the notes this hook writes and clears are in `notes` at once, not only after
   * a reload, and a note it wrote stays there while this tab lives even when storage
   * throws. The liquidity section and the swap page ask for it: a note there holds forms
   * the panel that sent it does not own. The curve page does not: its own panel keeps
   * showing the "sent" step, and a non-empty `notes` would hide that panel's form.
   * `scopeFor`: the scope a sent transaction's note belongs in (the wallet that signed it).
   * `recheckEveryMs`: also check standing notes this often, so a hold ends on the chain's answer.
   * `checkLost`: how a note with no signature is checked; without it, only its time ends it.
   */
  o: { live?: boolean; scopeFor?: (p: PreparedTx) => string | null; recheckEveryMs?: number; checkLost?: CheckLost } = {},
): PendingTradesState {
  const live = o.live === true;
  // Live only: notes this tab wrote while storage threw, kept per scope, so they still
  // hold here, and still hold a wallet that is switched away from and back to.
  const written = useRef(new Map<string, Map<string, PendingTrade>>());
  const notesOf = useCallback(
    (at: string): PendingTrade[] => {
      const stored = readPendingTrades(at);
      if (!live) return stored;
      const now = Date.now();
      const seen = new Set(stored.map(noteKey));
      const extra = [...(written.current.get(at)?.values() ?? [])].filter((n) => !seen.has(noteKey(n)) && now - n.sentAt <= noteTtl(n));
      return [...stored, ...extra].sort((a, b) => b.sentAt - a.sentAt);
    },
    [live],
  );
  const current = useCallback((): PendingTrade[] => (scope === null ? [] : notesOf(scope)), [scope, notesOf]);
  const [notes, setNotes] = useState<PendingTrade[]>(() => (scope === null ? [] : readPendingTrades(scope)));
  const [checking, setChecking] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const busy = useRef(false);
  const autoChecked = useRef(false);
  const resolvedRef = useRef(onResolved);
  useEffect(() => {
    resolvedRef.current = onResolved;
  }, [onResolved]);

  // Another scope (another wallet, or none): its own notes, checked on arrival like any found on load.
  const shownScope = useRef(scope);
  useEffect(() => {
    if (shownScope.current === scope) return;
    shownScope.current = scope;
    autoChecked.current = false;
    setMessage(null);
    setNotes(current());
  }, [scope, current]);

  // A scope every tab reads: a note another tab writes or clears is followed here, no reload.
  useEffect(() => {
    if (scope === null || !isSharedScope(scope)) return;
    const key = pendingStorageKey(scope);
    const onStorage = (e: StorageEvent) => {
      if (e.key === key || e.key === null) setNotes(current());
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, [scope, current]);

  const checkLost = o.checkLost;
  const recheck = useCallback(
    async (quiet = false) => {
      if (!check || busy.current) return;
      const toCheck = current();
      if (toCheck.length === 0) {
        setNotes([]);
        return;
      }
      busy.current = true;
      if (!quiet) setChecking(true);
      let resolved = false;
      let last: string | null = null;
      for (const n of toCheck) {
        let ended: boolean;
        if (n.signature === null) {
          // No signature to look up: only its blockhash, once it can no longer land, ends it.
          const gone = n.blockhash && checkLost ? await checkLost(n.blockhash).catch(() => null) : false;
          ended = gone === true;
          if (gone === null) last = LOST_UNREAD;
        } else {
          let o: TxOutcome;
          try {
            o = await (isLpKind(n.kind)
              ? check(n.signature, n.lastValidBlockHeight, n.kind)
              : n.blockhash
                ? check(n.signature, n.lastValidBlockHeight, undefined, n.blockhash)
                : check(n.signature, n.lastValidBlockHeight));
          } catch (e) {
            // A failed read changes nothing we know: the note stays.
            o = { status: 'unknown', signature: n.signature, message: `Could not check just now (${clipDetail(e)}).` };
          }
          ended = o.status === 'confirmed' || o.status === 'reverted' || o.status === 'expired';
          if (o.status === 'unknown') last = o.message;
        }
        if (ended && scope !== null) {
          clearPendingTrade(scope, noteKey(n));
          written.current.get(scope)?.delete(noteKey(n));
        }
        resolved ||= ended;
      }
      busy.current = false;
      if (!quiet) setChecking(false);
      // A check of its own does not re-read the last answer out, unless it settled one.
      if (!quiet || resolved) setMessage(last);
      setNotes(current());
      if (resolved) resolvedRef.current();
    },
    [check, scope, current, checkLost],
  );

  // Check on arrival, before any form this scope holds is shown.
  useEffect(() => {
    if (!check || autoChecked.current || notes.length === 0) return;
    autoChecked.current = true;
    void recheck();
  }, [check, notes.length, recheck]);

  // And again while any stands, when asked to: the hold ends on the chain's answer.
  const every = o.recheckEveryMs;
  useEffect(() => {
    if (!every || !check || notes.length === 0) return;
    const t = setInterval(() => void recheck(true), every);
    return () => clearInterval(t);
  }, [every, check, notes.length, recheck]);

  // Live only: a note past its ten minutes leaves `notes` then, not on the next read.
  useEffect(() => {
    if (!live || notes.length === 0) return;
    const ends = Math.min(...notes.map((n) => n.sentAt + noteTtl(n)));
    const t = setTimeout(() => setNotes(current()), Math.max(0, ends - Date.now()) + 1_000);
    return () => clearTimeout(t);
  }, [live, notes, current]);

  const dismiss = useCallback(() => {
    if (busy.current || scope === null) return;
    clearPendingTrade(scope);
    written.current.delete(scope);
    setNotes([]);
    setMessage(null);
  }, [scope]);

  /** Live only: what this tab now holds, after a write to or a clear of a scope. */
  const follow = useCallback(
    (at: string, note: PendingTrade | null, stored: boolean, cleared: string | null) => {
      if (!live) return;
      if (note && !stored) written.current.set(at, (written.current.get(at) ?? new Map<string, PendingTrade>()).set(noteKey(note), note));
      if (cleared) written.current.get(at)?.delete(cleared);
      if (at !== scope) return;
      // The arrival check is for notes found on load; a note written here has its own
      // panel's answer coming (or Check again on the card).
      autoChecked.current = true;
      setNotes(current());
    },
    [live, scope, current],
  );

  const hold = useCallback<PendingTradesState['hold']>(
    (t, at = scope ?? undefined) => {
      if (!at) return;
      const note = noteOf({ ...t, pool: null }, Date.now());
      const stored = savePendingTrade(at, note);
      follow(at, note, stored, null);
    },
    [scope, follow],
  );

  const release = useCallback<PendingTradesState['release']>(
    (key, at = scope ?? undefined) => {
      if (!at) return;
      clearPendingTrade(at, key);
      follow(at, null, true, key);
    },
    [scope, follow],
  );

  const scopeFor = o.scopeFor;
  const sent = useCallback(
    (signature: string, prepared: PreparedTx) => {
      if (prepared.kind === 'create') return;
      const at = scopeFor?.(prepared) ?? scope;
      if (at === null) return;
      // Storage: the note is what a reload, or a trip away and back, finds. Without
      // `live`, storage only: the panel that sent it keeps showing its own "sent" step.
      const note = noteOf({ kind: prepared.kind, signature, lastValidBlockHeight: prepared.lastValidBlockHeight, pool: poolOf(prepared) }, Date.now());
      const stored = savePendingTrade(at, note);
      follow(at, note, stored, null);
    },
    [scope, scopeFor, follow],
  );

  const record = useCallback(
    (outcome: TxOutcome, prepared: PreparedTx | null, sentSignature?: string | null) => {
      if (!prepared || prepared.kind === 'create') return;
      const at = scopeFor?.(prepared) ?? scope;
      if (at === null) return;
      // A `not-sent` after `sent` (turned away at the first send) has no signature of
      // its own; the one it was sent with names the note to clear.
      const sig = ('signature' in outcome && outcome.signature) || sentSignature || '';
      if (!sig) return;
      if (outcome.status === 'unknown') {
        const note = noteOf({ kind: prepared.kind, signature: sig, lastValidBlockHeight: prepared.lastValidBlockHeight, pool: poolOf(prepared) }, Date.now());
        const stored = savePendingTrade(at, note);
        follow(at, note, stored, null);
      } else {
        // Confirmed, refused or expired: the chain answered for this one.
        clearPendingTrade(at, sig);
        follow(at, null, true, sig);
      }
    },
    [scope, scopeFor, follow],
  );

  const holdsNow = useCallback(
    (at: string | null = scope): boolean => {
      if (at === null) return false;
      const found = notesOf(at);
      if (at === scope) setNotes(found);
      return found.length > 0;
    },
    [scope, notesOf],
  );

  return { notes, checking, message, recheck: () => void recheck(), dismiss, record, sent, hold, release, holdsNow };
}
