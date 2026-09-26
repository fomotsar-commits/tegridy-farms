import { useCallback, useEffect, useRef, useState } from 'react';
import { clipDetail } from '../../../lib/launcher/solana/curve';
import { clearPendingTrade, readPendingTrades, savePendingTrade, type PendingTrade } from './pendingTrade';
import type { PreparedTx, TxOutcome } from './ports';

/**
 * The page-level half of "sent, not confirmed yet": a trade on this mint that this
 * browser sent and could not confirm survives a reload or a trip away from the page.
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
  /** "I checked my wallet": drop every note for this mint. */
  dismiss(): void;
  /** Feed every settled transaction here (a panel's onSettled). */
  record(outcome: TxOutcome, prepared: PreparedTx | null): void;
}

export type CheckSignature = (signature: string, lastValidBlockHeight: number | null) => Promise<TxOutcome>;

export function usePendingTrades(
  mint: string,
  /** `null` until the page can reach the chain; the first check runs once it can. */
  check: CheckSignature | null,
  /** The chain answered for at least one note: read the launch again. */
  onResolved: () => void,
): PendingTradesState {
  const [notes, setNotes] = useState<PendingTrade[]>(() => readPendingTrades(mint));
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
    const current = readPendingTrades(mint);
    if (current.length === 0) {
      setNotes([]);
      return;
    }
    busy.current = true;
    setChecking(true);
    let resolved = false;
    let last: string | null = null;
    for (const n of current) {
      let o: TxOutcome;
      try {
        o = await check(n.signature, n.lastValidBlockHeight);
      } catch (e) {
        // A failed read changes nothing we know: the note stays.
        o = { status: 'unknown', signature: n.signature, message: `Could not check just now (${clipDetail(e)}).` };
      }
      if (o.status === 'confirmed' || o.status === 'reverted' || o.status === 'expired') {
        clearPendingTrade(mint, n.signature);
        resolved = true;
      } else if (o.status === 'unknown') {
        last = o.message;
      }
    }
    busy.current = false;
    setChecking(false);
    setMessage(last);
    setNotes(readPendingTrades(mint));
    if (resolved) resolvedRef.current();
  }, [check, mint]);

  // Check on arrival, before any trade form is shown for this mint.
  useEffect(() => {
    if (!check || autoChecked.current || notes.length === 0) return;
    autoChecked.current = true;
    void recheck();
  }, [check, notes.length, recheck]);

  const dismiss = useCallback(() => {
    if (busy.current) return;
    clearPendingTrade(mint);
    setNotes([]);
    setMessage(null);
  }, [mint]);

  const record = useCallback(
    (outcome: TxOutcome, prepared: PreparedTx | null) => {
      if (!prepared || prepared.kind === 'create') return;
      const sig = 'signature' in outcome ? outcome.signature : '';
      if (!sig) return;
      if (outcome.status === 'unknown') {
        savePendingTrade(mint, { kind: prepared.kind, signature: sig, lastValidBlockHeight: prepared.lastValidBlockHeight });
      } else {
        // Confirmed, refused or expired: the chain answered for this one.
        clearPendingTrade(mint, sig);
      }
    },
    [mint],
  );

  return { notes, checking, message, recheck: () => void recheck(), dismiss, record };
}
