// A per-viewer note of "I sent a transaction here and could not confirm it",
// kept so that a reload, or leaving the page and coming back, does not hand the
// person a fresh, unlocked form while the first transaction may still land. That
// is how someone pays twice.
//
// It covers buy, sell, graduation and pool swaps (one scope per launch mint), adding
// and removing liquidity and opening a pool (one scope for every pool, each note
// naming its pool), and the swap page's swaps by either route (one scope per wallet
// that signed). The launch create flow has its own note (pendingLaunch.ts).
//
// sessionStorage (localStorage for the swap page's, so every tab of the site holds
// them), and only as a convenience: it can be empty, blocked or throw, and the page
// must still be right without it. The chain is the truth.

import { PublicKey } from '@solana/web3.js';
import { isLpKind } from '../../../lib/launcher/solana/write/lpKinds';
import type { TxKind } from './ports';

/**
 * Where a launch's notes live. Byte-identical to the key every earlier build wrote,
 * so a note written just before a deploy is still found after it.
 */
export const curveTradeScope = (mint: string): string => 'curve-launch:pending-trade:' + mint;
/** Where every liquidity note lives, whatever its pool. */
export const LP_PENDING_SCOPE = 'lp:pending';
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
};
const TRADE_KINDS: ReadonlySet<string> = new Set(Object.keys(KNOWN));

export interface PendingTrade {
  kind: TradeKind;
  signature: string;
  /** The blockhash window of the sent transaction, so a later check can say "expired". */
  lastValidBlockHeight: number | null;
  sentAt: number;
  /**
   * Liquidity only: the pool it was sent to. `null` for every other kind, and for a
   * liquidity note whose pool could not be read back, which then holds EVERY pool.
   */
  pool: string | null;
}

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

function parse(raw: unknown, now: number): PendingTrade | null {
  if (!raw || typeof raw !== 'object') return null;
  const v = raw as Partial<Record<keyof PendingTrade, unknown>>;
  if (typeof v.kind !== 'string' || !TRADE_KINDS.has(v.kind)) return null;
  if (typeof v.signature !== 'string' || !SIGNATURE.test(v.signature)) return null;
  if (typeof v.sentAt !== 'number' || now - v.sentAt > PENDING_TRADE_TTL_MS || v.sentAt > now + 60_000) return null;
  const lvbh =
    typeof v.lastValidBlockHeight === 'number' && Number.isSafeInteger(v.lastValidBlockHeight) && v.lastValidBlockHeight > 0
      ? v.lastValidBlockHeight
      : null;
  const kind = v.kind as TradeKind;
  return { kind, signature: v.signature, lastValidBlockHeight: lvbh, sentAt: v.sentAt, pool: isLpKind(kind) ? poolOf(v.pool) : null };
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

/** The stored form: `pool` is written for liquidity notes only, so a curve note's bytes are what they always were. */
function stored(n: PendingTrade): object {
  const { pool, ...rest } = n;
  return isLpKind(n.kind) ? { ...rest, pool } : rest;
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

/** True when the note is in storage. */
export function savePendingTrade(
  scope: string,
  t: { kind: TradeKind; signature: string; lastValidBlockHeight: number | null; pool?: string | null },
  now: number = Date.now(),
): boolean {
  const rest = readPendingTrades(scope, now).filter((n) => n.signature !== t.signature);
  return write(scope, [{ kind: t.kind, signature: t.signature, lastValidBlockHeight: t.lastValidBlockHeight, sentAt: now, pool: t.pool ?? null }, ...rest]);
}

/** Drop one note (the chain answered for it), or every note in the scope when no signature is given. */
export function clearPendingTrade(scope: string, signature?: string): void {
  if (signature === undefined) {
    write(scope, []);
    return;
  }
  const all = readPendingTrades(scope);
  const rest = all.filter((n) => n.signature !== signature);
  if (rest.length !== all.length) write(scope, rest);
}
