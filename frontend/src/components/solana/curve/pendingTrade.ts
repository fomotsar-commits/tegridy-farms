// A per-viewer note of "I sent a transaction here and could not confirm it",
// kept so that a reload, or leaving the page and coming back, does not hand the
// person a fresh, unlocked form while the first transaction may still land. That
// is how someone pays twice.
//
// It covers buy, sell, graduation and pool swaps (one scope per launch mint), adding
// and removing liquidity and opening a pool (one scope for every pool, each note
// naming its pool), and the swap page's swaps by either route (one scope per wallet
// that signed), including a Jupiter swap whose wallet answer was lost before a
// signature came back. The launch create flow has its own note (pendingLaunch.ts).
//
// sessionStorage (localStorage for the swap page's, so every tab of the site holds
// them), and only as a convenience: it can be empty, blocked or throw, and the page
// must still be right without it. The chain is the truth.

import { PublicKey } from '@solana/web3.js';
import type { NoteBlockhash } from '../../../lib/solana/blockhashWindow';
import { isLpKind } from '../../../lib/launcher/solana/write/lpKinds';
import type { TxKind } from './ports';

/**
 * Where a launch's notes live. Byte-identical to the key every earlier build wrote,
 * so a note written just before a deploy is still found after it.
 */
export const curveTradeScope = (mint: string): string => 'curve-launch:pending-trade:' + mint;
/** Where every liquidity note lives, whatever its pool. */
export const LP_PENDING_SCOPE = 'lp:pending';
/** Where every range-position note lives. A note holds every range form until the chain answers for it. */
export const RANGE_PENDING_SCOPE = 'range:pending';
/** The prefix of the swap page's per-wallet scopes. A note an older build kept under this bare key (one tab's) is not read. */
export const SWAP_PENDING_SCOPE = 'swap:pending';
/** Where the swap page keeps the notes of one wallet: every swap it signed here, either route, any pair. */
export const swapPendingScope = (wallet: string): string => `${SWAP_PENDING_SCOPE}:${wallet}`;
/** A scope every tab of this site reads (localStorage): a swap sent in one tab holds Buy in the others. */
export const isSharedScope = (scope: string): boolean => scope.startsWith(`${SWAP_PENDING_SCOPE}:`);

/**
 * Past this, a note is ignored. A transaction can only land inside its blockhash
 * window (about 40 s on mainnet now), so one sent this long ago can no longer land.
 */
export const PENDING_TRADE_TTL_MS = 10 * 60_000;
/**
 * A wallet answer lost before a signature came back (the swap page's Jupiter route): the
 * swap may be out, and nothing can look it up, so its note ends sooner. Past any blockhash
 * window it was built with (about 60 to 90 s), and only on the blockhash before that.
 */
export const LOST_ANSWER_TTL_MS = 2 * 60_000;
/**
 * Kept per scope; past this the oldest are dropped, and dropping a live note reopens
 * the form it held while its transaction can still land. The liquidity scope holds
 * every pool, so it must outlast one note per pool and direction for the most
 * positions a wallet shows (2 × MAX_POSITIONS = 40) and more. Each note is a separate
 * signed send inside a ten-minute window, so 64 at once is not a real situation.
 */
export const MAX_NOTES = 64;

/** `jupiter-swap`: the swap page's trade through Jupiter, sent by the wallet itself. */
export type TradeKind = Exclude<TxKind, 'create'> | 'jupiter-swap';
/** Every kind a note may carry. A Record, so a new kind of transaction is a compile error here until it is listed. */
const KNOWN: Record<TradeKind, true> = {
  buy: true,
  sell: true,
  migrate: true,
  'pool-buy': true,
  'pool-sell': true,
  'venue-swap': true,
  'jupiter-swap': true,
  'lp-deposit': true,
  'lp-withdraw': true,
  'lp-create': true,
  'range-open': true,
  'range-remove': true,
  'range-close': true,
  'range-swap': true,
};
const TRADE_KINDS: ReadonlySet<string> = new Set(Object.keys(KNOWN));

export interface PendingTrade {
  kind: TradeKind;
  /** Null only for a wallet answer lost before a signature came back ('jupiter-swap' alone). */
  signature: string | null;
  /** The blockhash window of the sent transaction, so a later check can say "expired". */
  lastValidBlockHeight: number | null;
  sentAt: number;
  /**
   * Liquidity only: the pool it was sent to. `null` for every other kind, and for a
   * liquidity note whose pool could not be read back, which then holds EVERY pool.
   */
  pool: string | null;
  /** The swap page's Jupiter route: its blockhash, seen valid, so a later check can prove it can no longer land. */
  blockhash?: NoteBlockhash | null;
}

/** A note's name: its signature, or for a lost answer the moment it was written. */
export const noteKey = (n: Pick<PendingTrade, 'signature' | 'sentAt'>): string => n.signature ?? `lost:${n.sentAt}`;
/** How long a note can hold: a lost answer's is shorter. */
export const noteTtl = (n: Pick<PendingTrade, 'signature'>): number => (n.signature === null ? LOST_ANSWER_TTL_MS : PENDING_TRADE_TTL_MS);

const SIGNATURE = /^[1-9A-HJ-NP-Za-km-z]{64,90}$/;
const BASE58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

/**
 * The storage key for a scope. A bare mint address is that launch's scope, as every
 * function here took before scopes existed, so a mint and `curveTradeScope(mint)` name
 * the same notes, and a bare mint never reads a key that nothing writes.
 */
export const pendingStorageKey = (scope: string): string => (BASE58.test(scope) ? curveTradeScope(scope) : scope);
/** Read inside a try: the accessor itself can throw (blocked site data). */
const storeOf = (scope: string): Storage => (isSharedScope(scope) ? localStorage : sessionStorage);

/** A pool address as stored, or null when it is not one. */
function poolOf(v: unknown): string | null {
  if (typeof v !== 'string' || !BASE58.test(v)) return null;
  try {
    return new PublicKey(v).toBase58() === v ? v : null;
  } catch {
    return null;
  }
}

function blockhashOf(v: unknown): NoteBlockhash | null {
  if (!v || typeof v !== 'object') return null;
  const { hash, validAt } = v as { hash?: unknown; validAt?: unknown };
  return typeof hash === 'string' && BASE58.test(hash) && typeof validAt === 'number' && Number.isSafeInteger(validAt) && validAt > 0
    ? { hash, validAt }
    : null;
}

function parse(raw: unknown, now: number): PendingTrade | null {
  if (!raw || typeof raw !== 'object') return null;
  const v = raw as Partial<Record<keyof PendingTrade, unknown>>;
  if (typeof v.kind !== 'string' || !TRADE_KINDS.has(v.kind)) return null;
  const lost = v.signature === null && v.kind === 'jupiter-swap';
  if (!lost && (typeof v.signature !== 'string' || !SIGNATURE.test(v.signature))) return null;
  const signature = lost ? null : (v.signature as string);
  if (typeof v.sentAt !== 'number' || now - v.sentAt > noteTtl({ signature }) || v.sentAt > now + 60_000) return null;
  const lvbh =
    typeof v.lastValidBlockHeight === 'number' && Number.isSafeInteger(v.lastValidBlockHeight) && v.lastValidBlockHeight > 0
      ? v.lastValidBlockHeight
      : null;
  const kind = v.kind as TradeKind;
  return { kind, signature, lastValidBlockHeight: lvbh, sentAt: v.sentAt, pool: isLpKind(kind) ? poolOf(v.pool) : null, blockhash: blockhashOf(v.blockhash) };
}

/** Every live note in this scope, newest first. Unreadable storage = none. */
export function readPendingTrades(scope: string, now: number = Date.now()): PendingTrade[] {
  try {
    const raw = storeOf(scope).getItem(pendingStorageKey(scope));
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

/** The stored form: `pool` for liquidity notes only, `blockhash` when there is one, so a curve note's bytes are what they always were. */
function stored(n: PendingTrade): object {
  const { pool, blockhash, ...rest } = n;
  return { ...rest, ...(isLpKind(n.kind) ? { pool } : {}), ...(blockhash ? { blockhash } : {}) };
}

/** False when storage threw: the page still works, it just cannot remember across a reload. */
function write(scope: string, notes: PendingTrade[]): boolean {
  try {
    if (notes.length === 0) storeOf(scope).removeItem(pendingStorageKey(scope));
    else storeOf(scope).setItem(pendingStorageKey(scope), JSON.stringify(notes.slice(0, MAX_NOTES).map(stored)));
    return true;
  } catch {
    return false;
  }
}

/** What a note is written from. `sentAt`: a note written again keeps its first time. */
export type NewNote = {
  kind: TradeKind;
  signature: string | null;
  lastValidBlockHeight: number | null;
  pool?: string | null;
  blockhash?: NoteBlockhash | null;
  sentAt?: number;
};

/** The note as it is kept. */
export const noteOf = (t: NewNote, now: number): PendingTrade => ({
  kind: t.kind,
  signature: t.signature,
  lastValidBlockHeight: t.lastValidBlockHeight,
  sentAt: t.sentAt ?? now,
  pool: t.pool ?? null,
  blockhash: t.blockhash ?? null,
});

/** True when the note is in storage. */
export function savePendingTrade(scope: string, t: NewNote, now: number = Date.now()): boolean {
  const note = noteOf(t, now);
  const rest = readPendingTrades(scope, now).filter((n) => noteKey(n) !== noteKey(note));
  return write(scope, [note, ...rest]);
}

/** Drop one note (the chain answered for it) by its key (`noteKey`, its signature when it has one), or every note in the scope. */
export function clearPendingTrade(scope: string, key?: string): void {
  if (key === undefined) {
    write(scope, []);
    return;
  }
  const all = readPendingTrades(scope);
  const rest = all.filter((n) => noteKey(n) !== key);
  if (rest.length !== all.length) write(scope, rest);
}
