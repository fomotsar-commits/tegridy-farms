// A placed LP order (add or remove) or a pool opening, followed to its end, as orderWatch.ts
// follows a swap: placed, filled, returned, spent, or unknown when a read failed (never
// "failed": it may well have filled). A pool opening is no order: it is done once it lands.
//
// FEES EARNED. A constant-product pool keeps its fees inside: each LP token is worth more
// as trades pay in. So when a deposit made here fills, this browser notes the pool's value
// per LP token it entered at (lpMath.ts entryIndex); "fees earned" is the growth since then.
// A position this browser saw no deposit for has no such note, and the page says so.

import { readTip, readTxDepth } from '../chain';
import type { CardanoAsset } from '../minswapV2';
import { held, readOrderSpend, EXPIRY_MARGIN_SLOTS, type CoinLabel } from '../orderWatch';
import { entryIndex } from './lpMath';
import { ORDER_DEPOSIT } from './lpTx';

export interface LpOrderNote {
  kind: 'deposit' | 'withdraw' | 'open';
  txHash: string;
  /** The order is output 0 (lpTx.ts); a pool opening's pool is output 0 too. */
  orderIndex: 0;
  traderHex: string;
  traderPaymentHash: string;
  /** The pair's coin (ADA is the other side) and the pool's LP token. */
  token: CardanoAsset;
  lp: CardanoAsset;
  tokenLabel: CoinLabel;
  /** Decimal strings. deposit/open: the coins put in. withdraw: the LP burned. */
  amountAda: string;
  amountToken: string;
  lpAmount: string;
  /** open: the pool's whole first liquidity, its entry index's denominator. */
  totalLiquidity?: string;
  ttlSlot: number;
  submitted: boolean;
  placedAt: number;
  settled?: LpSettled;
}

export type LpSettled =
  | { kind: 'filled'; fillTx: string; lp: string; ada: string; token: string }
  | { kind: 'returned'; fillTx: string }
  | { kind: 'spent'; fillTx: string }
  | { kind: 'opened' };

export type LpOrderStatus =
  | { kind: 'not-seen' }
  | { kind: 'expired' }
  | { kind: 'placed'; depth: number }
  /** deposit: `lp` received. withdraw: `ada` (the deposit taken off) and `token` received. */
  | { kind: 'filled'; fillTx: string; lp: bigint; ada: bigint; token: bigint }
  | { kind: 'returned'; fillTx: string }
  | { kind: 'spent'; fillTx: string | null }
  | { kind: 'opened' }
  | { kind: 'unknown'; reason: string };

export async function readLpOrderStatus(note: LpOrderNote, signal?: AbortSignal): Promise<LpOrderStatus> {
  if (note.kind === 'open') {
    const depth = await readTxDepth(note.txHash, signal);
    if (depth.status !== 'ok') return { kind: 'unknown', reason: depth.reason };
    if (depth.data !== null) return { kind: 'opened' };
    const tip = await readTip(signal);
    if (tip.status !== 'ok') return { kind: 'unknown', reason: tip.reason };
    return tip.data.slot > note.ttlSlot + EXPIRY_MARGIN_SLOTS ? { kind: 'expired' } : { kind: 'not-seen' };
  }
  const s = await readOrderSpend(note, signal);
  if (s.kind !== 'spent-by') return s;
  const { fillTx, mine } = s;
  // One output to the trader is this order's; two or none is not guessed at (orderWatch.ts).
  if (mine.length !== 1) return { kind: 'spent', fillTx };
  const o = mine[0]!;
  const lp = held(o, note.lp);
  const token = held(o, note.token);
  if (note.kind === 'deposit') {
    if (lp > 0n) return { kind: 'filled', fillTx, lp, ada: 0n, token: 0n };
    return token > 0n || o.lovelace > ORDER_DEPOSIT ? { kind: 'returned', fillTx } : { kind: 'spent', fillTx };
  }
  if (lp > 0n) return { kind: 'returned', fillTx };
  if (token > 0n && o.lovelace >= ORDER_DEPOSIT) return { kind: 'filled', fillTx, lp: 0n, ada: o.lovelace - ORDER_DEPOSIT, token };
  return { kind: 'spent', fillTx };
}

const ORDERS_KEY = 'tegridy.ownpools.orders.v1';
const ENTRIES_KEY = 'tegridy.ownpools.entries.v1';
/** A settled note is kept this long; one still open is kept until it settles, however long that takes. */
const NOTE_LIFETIME_MS = 7 * 24 * 3600 * 1000;
const TX_HASH = /^[0-9a-f]{64}$/;
const DECIMAL = /^\d{1,40}$/;
const isAsset = (a: unknown): a is CardanoAsset =>
  typeof a === 'object' && a !== null && typeof (a as CardanoAsset).policyId === 'string' && typeof (a as CardanoAsset).assetName === 'string';

function isSettled(s: unknown): s is LpSettled {
  if (typeof s !== 'object' || s === null) return false;
  const o = s as Record<string, unknown>;
  if (o.kind === 'opened') return true;
  if (typeof o.fillTx !== 'string' || !TX_HASH.test(o.fillTx)) return false;
  if (o.kind === 'filled') return [o.lp, o.ada, o.token].every((v) => typeof v === 'string' && DECIMAL.test(v));
  return o.kind === 'returned' || o.kind === 'spent';
}

function isNote(x: unknown): x is LpOrderNote {
  if (typeof x !== 'object' || x === null) return false;
  const o = x as Record<string, unknown>;
  const label = o.tokenLabel as CoinLabel | undefined;
  return (
    (o.kind === 'deposit' || o.kind === 'withdraw' || o.kind === 'open') && typeof o.txHash === 'string' && TX_HASH.test(o.txHash) && o.orderIndex === 0 &&
    typeof o.traderHex === 'string' && typeof o.traderPaymentHash === 'string' && isAsset(o.token) && isAsset(o.lp) &&
    typeof label === 'object' && label !== null && (label.ticker === null || typeof label.ticker === 'string') && Number.isInteger(label.decimals) &&
    [o.amountAda, o.amountToken, o.lpAmount].every((v) => typeof v === 'string' && DECIMAL.test(v)) &&
    typeof o.ttlSlot === 'number' && typeof o.placedAt === 'number' && typeof o.submitted === 'boolean'
  );
}

export function settledLpStatus(note: LpOrderNote): LpOrderStatus | null {
  const s = note.settled;
  if (!isSettled(s)) return null;
  return s.kind === 'filled' ? { kind: 'filled', fillTx: s.fillTx, lp: BigInt(s.lp), ada: BigInt(s.ada), token: BigInt(s.token) } : s;
}

export function readLpNotes(now: number = Date.now()): LpOrderNote[] {
  try {
    const raw = JSON.parse(localStorage.getItem(ORDERS_KEY) ?? '[]') as unknown;
    if (!Array.isArray(raw)) return [];
    return raw
      .filter(isNote)
      .filter((n) => n.settled === undefined || !isSettled(n.settled) || now - n.placedAt < NOTE_LIFETIME_MS)
      .map((n) => (n.settled === undefined || isSettled(n.settled) ? n : { ...n, settled: undefined }));
  } catch {
    return [];
  }
}

function writeNotes(notes: LpOrderNote[]): void {
  localStorage.setItem(ORDERS_KEY, JSON.stringify(notes.slice(0, 20)));
}

/** Written before the transaction leaves; false when this browser would not keep it. */
export function writeLpNote(note: LpOrderNote): boolean {
  try {
    writeNotes([note, ...readLpNotes().filter((n) => n.txHash !== note.txHash)]);
    return readLpNotes().some((n) => n.txHash === note.txHash);
  } catch {
    return false;
  }
}

export function markLpSubmitted(txHash: string): void {
  try {
    writeNotes(readLpNotes().map((n) => (n.txHash === txHash ? { ...n, submitted: true } : n)));
  } catch {
    /* storage blocked: the page holds it in memory */
  }
}

export function dropLpNote(txHash: string): void {
  try {
    writeNotes(readLpNotes().filter((n) => n.txHash !== txHash));
  } catch {
    /* nothing to drop */
  }
}

/**
 * Saves how it ended, and for a filled deposit or an opening, where the LP entered. Only
 * endings read off the chain are kept ("spent, spender not found" is read again next visit).
 */
export function markLpSettled(note: LpOrderNote, status: LpOrderStatus): void {
  const settled: LpSettled | null =
    status.kind === 'filled' ? { kind: 'filled', fillTx: status.fillTx, lp: status.lp.toString(), ada: status.ada.toString(), token: status.token.toString() }
    : status.kind === 'returned' ? status
    : status.kind === 'spent' && status.fillTx !== null ? { kind: 'spent', fillTx: status.fillTx }
    : status.kind === 'opened' ? status
    : null;
  if (!settled) return;
  try {
    writeNotes(readLpNotes().map((n) => (n.txHash === note.txHash ? { ...n, settled } : n)));
  } catch {
    /* storage blocked */
  }
  if (status.kind === 'filled' && note.kind === 'deposit') {
    addEntry({ traderHex: note.traderHex, lpName: note.lp.assetName, lp: status.lp.toString(), index: entryIndex(BigInt(note.amountAda), BigInt(note.amountToken), status.lp).toString(), txHash: note.txHash });
  }
  if (status.kind === 'filled' && note.kind === 'withdraw') retireEntries(note.traderHex, note.lp.assetName, BigInt(note.lpAmount));
  if (status.kind === 'opened' && note.kind === 'open' && note.totalLiquidity) {
    addEntry({ traderHex: note.traderHex, lpName: note.lp.assetName, lp: note.lpAmount, index: entryIndex(BigInt(note.amountAda), BigInt(note.amountToken), BigInt(note.totalLiquidity)).toString(), txHash: note.txHash });
  }
}

/** Where some of a wallet's LP tokens entered a pool: `index` is lpMath.ts growthIndex then. */
export interface LpEntry {
  traderHex: string;
  lpName: string;
  lp: string;
  index: string;
  txHash: string;
}

const isEntry = (x: unknown): x is LpEntry => {
  if (typeof x !== 'object' || x === null) return false;
  const o = x as Record<string, unknown>;
  return typeof o.traderHex === 'string' && typeof o.lpName === 'string' && typeof o.txHash === 'string' && [o.lp, o.index].every((v) => typeof v === 'string' && DECIMAL.test(v));
};

export function readLpEntries(): LpEntry[] {
  try {
    const raw = JSON.parse(localStorage.getItem(ENTRIES_KEY) ?? '[]') as unknown;
    return Array.isArray(raw) ? raw.filter(isEntry) : [];
  } catch {
    return [];
  }
}

/** A withdrawal burned `lp`: it is taken from this wallet's oldest entries for the pool first. */
function retireEntries(traderHex: string, lpName: string, lp: bigint): void {
  try {
    let left = lp;
    // Newest first in storage, so the oldest are at the end: walk it backwards.
    const all = readLpEntries();
    for (let i = all.length - 1; i >= 0 && left > 0n; i--) {
      const e = all[i]!;
      if (e.traderHex !== traderHex || e.lpName !== lpName) continue;
      const held = BigInt(e.lp);
      const take = held < left ? held : left;
      all[i] = { ...e, lp: (held - take).toString() };
      left -= take;
    }
    localStorage.setItem(ENTRIES_KEY, JSON.stringify(all.filter((e) => e.lp !== '0')));
  } catch {
    /* storage blocked */
  }
}

function addEntry(e: LpEntry): void {
  try {
    const rest = readLpEntries().filter((x) => x.txHash !== e.txHash);
    localStorage.setItem(ENTRIES_KEY, JSON.stringify([e, ...rest].slice(0, 100)));
  } catch {
    /* storage blocked: fees earned is then "not known on this browser" */
  }
}
