// A per-viewer note of "I sent a trade on this launch and could not confirm it",
// kept so that a reload, or leaving the page and coming back, does not hand the
// person a fresh, unlocked trade form while the first trade may still land. That
// is how someone pays twice.
//
// It covers buy, sell, graduation and pool swaps. The create flow
// has its own note (pendingLaunch.ts).
//
// sessionStorage, and only as a convenience: it can be empty, blocked or throw (a
// private window, cleared site data), and the page must still be right without it.
// The chain is the truth. The page checks every note against the chain before it
// shows any trade form for the mint.

import type { TxKind } from './ports';

const KEY = 'curve-launch:pending-trade:';
/**
 * Past this, a note is ignored. A transaction can only land inside its blockhash
 * window (about a minute and a half), so one sent this long ago can no longer land.
 */
export const PENDING_TRADE_TTL_MS = 10 * 60_000;
/** Kept per mint. More than this at once is not a real situation; the oldest are dropped. */
const MAX_NOTES = 5;

export type TradeKind = Exclude<TxKind, 'create'>;
const TRADE_KINDS: ReadonlySet<string> = new Set<TradeKind>(['buy', 'sell', 'migrate', 'pool-buy', 'pool-sell']);

export interface PendingTrade {
  kind: TradeKind;
  signature: string;
  /** The blockhash window of the sent transaction, so a later check can say "expired". */
  lastValidBlockHeight: number | null;
  sentAt: number;
}

const SIGNATURE = /^[1-9A-HJ-NP-Za-km-z]{64,90}$/;

function parse(raw: unknown, now: number): PendingTrade | null {
  if (!raw || typeof raw !== 'object') return null;
  const v = raw as Partial<PendingTrade>;
  if (typeof v.kind !== 'string' || !TRADE_KINDS.has(v.kind)) return null;
  if (typeof v.signature !== 'string' || !SIGNATURE.test(v.signature)) return null;
  if (typeof v.sentAt !== 'number' || now - v.sentAt > PENDING_TRADE_TTL_MS || v.sentAt > now + 60_000) return null;
  const lvbh =
    typeof v.lastValidBlockHeight === 'number' && Number.isSafeInteger(v.lastValidBlockHeight) && v.lastValidBlockHeight > 0
      ? v.lastValidBlockHeight
      : null;
  return { kind: v.kind as TradeKind, signature: v.signature, lastValidBlockHeight: lvbh, sentAt: v.sentAt };
}

/** Every live note for this mint, newest first. Unreadable storage = none. */
export function readPendingTrades(mint: string, now: number = Date.now()): PendingTrade[] {
  try {
    const raw = sessionStorage.getItem(KEY + mint);
    if (!raw) return [];
    const list: unknown = JSON.parse(raw);
    if (!Array.isArray(list)) return [];
    return list
      .map((x) => parse(x, now))
      .filter((x): x is PendingTrade => x !== null)
      .sort((a, b) => b.sentAt - a.sentAt);
  } catch {
    return [];
  }
}

function write(mint: string, notes: PendingTrade[]): void {
  try {
    if (notes.length === 0) sessionStorage.removeItem(KEY + mint);
    else sessionStorage.setItem(KEY + mint, JSON.stringify(notes.slice(0, MAX_NOTES)));
  } catch {
    /* storage unavailable: the page still works, it just cannot remember across a reload */
  }
}

export function savePendingTrade(
  mint: string,
  t: { kind: TradeKind; signature: string; lastValidBlockHeight: number | null },
  now: number = Date.now(),
): void {
  const rest = readPendingTrades(mint, now).filter((n) => n.signature !== t.signature);
  write(mint, [{ ...t, sentAt: now }, ...rest]);
}

/** Drop one note (the chain answered for it), or every note for the mint when no signature is given. */
export function clearPendingTrade(mint: string, signature?: string): void {
  if (signature === undefined) {
    write(mint, []);
    return;
  }
  const all = readPendingTrades(mint);
  const rest = all.filter((n) => n.signature !== signature);
  if (rest.length !== all.length) write(mint, rest);
}
