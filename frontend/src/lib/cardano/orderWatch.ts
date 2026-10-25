// A placed order, followed to its end. On Cardano the trader's transaction only PLACES the
// order; Minswap's batcher fills it (or returns it) in a later transaction of its own. So the
// page has more states than "sent" and "done", and each is said for what it is:
//
//   not-seen   sent (or maybe sent), and the chain has not shown it yet
//   expired    never seen, and its expiry slot is well past: it can never land, so a retry is
//              safe. Well past (EXPIRY_MARGIN_SLOTS), because the reads come from separate
//              indexer calls that can lag each other: a transaction that landed just before
//              its expiry must never read as "never placed" and be paid for twice.
//   placed     the order is on chain, waiting for the batcher (with its depth)
//   filled     the batcher paid the trader the coins bought
//   returned   the coins came back (the price moved past the minimum, or the order was cancelled)
//   spent      the order was spent and this page could not tell how; the trader's wallet can.
//              Also when one transaction pays the trader twice (two of their orders in one
//              batch): the outputs are not attributed by guesswork.
//   unknown    a read failed. NEVER "failed": the order may well have filled.
//
// Notes are kept in this browser so a reload does not lose an order still on its way.

import { readCredentialTxs, readTip, readTx, readTxDepth, readUtxoSpent } from './chain';
import { isAda, MINSWAP_V2, sameAsset, type CardanoAsset } from './minswapV2';
import { TTL_SLOTS } from './swapTx';

export interface PendingOrder {
  txHash: string;
  /** The order is always output 0 (swapTx.ts). */
  orderIndex: 0;
  traderHex: string;
  traderPaymentHash: string;
  assetIn: CardanoAsset;
  assetOut: CardanoAsset;
  amountIn: string;
  minimumReceive: string;
  /** The coins' names and decimals as read when the order was placed: each row is said in its own coins, never the form's. */
  inLabel: CoinLabel;
  outLabel: CoinLabel;
  /** The transaction's expiry slot: past it, a transaction never seen can never land. */
  ttlSlot: number;
  /** False from the note's writing until the wallet said it sent the transaction. */
  submitted: boolean;
  /** Unix ms, from this browser's clock, for ordering notes only. */
  placedAt: number;
  /**
   * How the order ended, once read: a later visit shows it without reading the chain again
   * (a week of notes, each up to ~16 reads, would otherwise spend the visitor's read limit).
   * Amounts as decimal strings, like amountIn.
   */
  settled?: SettledNote;
  /** The trader's own cancel of this order, once signed (cancelFlow.ts). */
  cancel?: CancelNote;
}

export interface CancelNote {
  txHash: string;
  /** Unix ms, from this browser's clock. */
  sentAt: number;
  /** The cancel's expiry slot. */
  ttlSlot: number;
}

/**
 * Only endings read off the spending transaction itself. "Spent, and the spender not found"
 * is never kept: it can be one read lagging another (the history not yet indexed), and a later
 * visit should look again rather than show it for a week.
 */
export type SettledNote =
  | { kind: 'filled'; fillTx: string; received: string; depositBack: string }
  | { kind: 'returned'; fillTx: string }
  | { kind: 'spent'; fillTx: string };

export interface CoinLabel {
  /** The ticker, or 'ADA'; null when the coin has none on record. */
  ticker: string | null;
  decimals: number;
}

export type OrderStatus =
  | { kind: 'not-seen' }
  | { kind: 'expired' }
  | { kind: 'placed'; depth: number }
  | { kind: 'filled'; fillTx: string; received: bigint; depositBack: bigint }
  | { kind: 'returned'; fillTx: string }
  | { kind: 'spent'; fillTx: string | null }
  | { kind: 'unknown'; reason: string };

/** How many history transactions, oldest first from the order's block, are searched for the fill before saying "spent". */
const FILL_SEARCH = 12;

const POLL_MS = 10_000;
const POLL_SLOW_MS = 60_000;
/** An order still open this long after it was placed is read once a minute, not every 10 s. */
const POLL_SLOW_AFTER_MS = 10 * 60_000;

/**
 * How long until the page reads its open orders again: 10 s while any open order was placed, or
 * cancelled, under 10 minutes ago, else a minute. A fill or a cancel normally lands within a
 * minute; a page left open on a stuck order would otherwise spend the visitor's daily read
 * limit (api/cardano.js) and stop their quotes with it.
 */
export function pollDelayMs(orders: readonly Pick<PendingOrder, 'txHash' | 'placedAt' | 'cancel'>[], isFinal: (txHash: string) => boolean, now: number): number {
  return orders.some((o) => !isFinal(o.txHash) && now - Math.max(o.placedAt, o.cancel?.sentAt ?? 0) < POLL_SLOW_AFTER_MS) ? POLL_MS : POLL_SLOW_MS;
}

/** 20 minutes of slots past the expiry before a never-seen transaction is called expired. */
export const EXPIRY_MARGIN_SLOTS = 1200;

/**
 * Whether a cancel sent from here may still land: until its 15-minute expiry and the margin
 * have passed (one slot is one second). Until then the order shows "cancel sent", not a second
 * Cancel; after, the button comes back. Two cancels of one order can never both land.
 */
export function cancelInFlight(order: Pick<PendingOrder, 'cancel'>, now: number): boolean {
  return order.cancel !== undefined && now - order.cancel.sentAt < (TTL_SLOTS + EXPIRY_MARGIN_SLOTS) * 1000;
}

function outputsTo(tx: { outputs: { addressHex: string; lovelace: bigint; assets: { policyId: string; assetName: string; quantity: bigint }[] }[] }, hex: string) {
  return tx.outputs.filter((o) => o.addressHex === hex);
}

function held(o: { lovelace: bigint; assets: { policyId: string; assetName: string; quantity: bigint }[] }, a: CardanoAsset): bigint {
  if (isAda(a)) return o.lovelace;
  return o.assets.filter((x) => sameAsset(x, a)).reduce((s, x) => s + x.quantity, 0n);
}

export async function readOrderStatus(order: PendingOrder, signal?: AbortSignal): Promise<OrderStatus> {
  const spent = await readUtxoSpent(order.txHash, order.orderIndex, signal);
  if (spent.status !== 'ok') return { kind: 'unknown', reason: spent.reason };
  if (spent.data === false) {
    const depth = await readTxDepth(order.txHash, signal);
    return { kind: 'placed', depth: depth.status === 'ok' && depth.data !== null ? depth.data : 0 };
  }
  if (spent.data === null) {
    const depth = await readTxDepth(order.txHash, signal);
    if (depth.status !== 'ok') return { kind: 'unknown', reason: depth.reason };
    if (depth.data !== null) return { kind: 'placed', depth: depth.data };
    // Never seen. Well past its expiry it can never land; before then, it still may.
    const tip = await readTip(signal);
    if (tip.status !== 'ok') return { kind: 'unknown', reason: tip.reason };
    return tip.data.slot > order.ttlSlot + EXPIRY_MARGIN_SLOTS ? { kind: 'expired' } : { kind: 'not-seen' };
  }

  // Spent: find the transaction that spent it, among the trader's own (the fill pays them).
  const [tip, depth] = await Promise.all([readTip(signal), readTxDepth(order.txHash, signal)]);
  if (tip.status !== 'ok') return { kind: 'unknown', reason: tip.reason };
  if (depth.status !== 'ok') return { kind: 'unknown', reason: depth.reason };
  const placedHeight = Math.max(0, tip.data.blockHeight - (depth.data ?? 0));
  const history = await readCredentialTxs(order.traderPaymentHash, placedHeight, signal);
  if (history.status !== 'ok') return { kind: 'unknown', reason: history.reason };
  for (const h of history.data.filter((x) => x.txHash !== order.txHash).slice(0, FILL_SEARCH)) {
    const tx = await readTx(h.txHash, signal);
    if (tx.status !== 'ok') return { kind: 'unknown', reason: tx.reason };
    if (!tx.data || !tx.data.inputs.some((i) => i.txHash === order.txHash && i.index === order.orderIndex)) continue;
    const mine = outputsTo(tx.data, order.traderHex);
    // Exactly one output to the trader is this order's. Two (two of their orders in one batch)
    // or none cannot be attributed without the batch's redeemer: said as spent, not guessed.
    if (mine.length !== 1) return { kind: 'spent', fillTx: h.txHash };
    const bought = mine.reduce((s, o) => s + held(o, order.assetOut), 0n);
    const back = mine.reduce((s, o) => s + held(o, order.assetIn), 0n);
    if (!isAda(order.assetOut) && bought > 0n) {
      // The order's 2 ADA deposit rides back with the coins bought.
      return { kind: 'filled', fillTx: h.txHash, received: bought, depositBack: mine.reduce((s, o) => s + o.lovelace, 0n) };
    }
    if (isAda(order.assetOut)) {
      // Selling a token for ADA: the token coming back means returned; ADA alone means filled.
      if (back > 0n) return { kind: 'returned', fillTx: h.txHash };
      const ada = mine.reduce((s, o) => s + o.lovelace, 0n);
      if (ada > MINSWAP_V2.orderDeposit) return { kind: 'filled', fillTx: h.txHash, received: ada - MINSWAP_V2.orderDeposit, depositBack: MINSWAP_V2.orderDeposit };
    }
    if (isAda(order.assetIn) && back > 0n) return { kind: 'returned', fillTx: h.txHash };
    return { kind: 'spent', fillTx: h.txHash };
  }
  return { kind: 'spent', fillTx: null };
}

const NOTES_KEY = 'tegridy.minswap.orders.v1';
/** Notes older than this are dropped: by then the order has long settled one way or the other. */
const NOTE_LIFETIME_MS = 7 * 24 * 3600 * 1000;

const TX_HASH = /^[0-9a-f]{64}$/;
const DECIMAL = /^\d{1,40}$/;

function isSettled(s: unknown): s is SettledNote {
  if (typeof s !== 'object' || s === null) return false;
  const o = s as Record<string, unknown>;
  const tx = (v: unknown) => typeof v === 'string' && TX_HASH.test(v);
  if (o.kind === 'filled') return tx(o.fillTx) && typeof o.received === 'string' && DECIMAL.test(o.received) && typeof o.depositBack === 'string' && DECIMAL.test(o.depositBack);
  if (o.kind === 'returned') return tx(o.fillTx);
  if (o.kind === 'spent') return tx(o.fillTx);
  return false;
}

/** The status a note saved when its order ended, or null: never one read off a malformed note. */
export function settledStatus(note: PendingOrder): OrderStatus | null {
  const s = note.settled;
  if (!isSettled(s)) return null;
  return s.kind === 'filled' ? { kind: 'filled', fillTx: s.fillTx, received: BigInt(s.received), depositBack: BigInt(s.depositBack) } : s;
}

/** Saves how the order ended, when it was read off the spending transaction: filled, returned, or spent by a known transaction. Anything else is not kept. */
export function markOrderSettled(txHash: string, status: OrderStatus): void {
  const settled: SettledNote | null =
    status.kind === 'filled' ? { kind: 'filled', fillTx: status.fillTx, received: status.received.toString(), depositBack: status.depositBack.toString() }
    : status.kind === 'returned' ? status
    : status.kind === 'spent' && status.fillTx !== null ? { kind: 'spent', fillTx: status.fillTx }
    : null;
  if (!settled) return;
  try {
    const notes = readOrderNotes();
    localStorage.setItem(NOTES_KEY, JSON.stringify(notes.map((n) => (n.txHash === txHash ? { ...n, settled } : n))));
  } catch {
    /* storage blocked: the page holds the status in memory */
  }
}

function isNote(x: unknown): x is PendingOrder {
  if (typeof x !== 'object' || x === null) return false;
  const o = x as Record<string, unknown>;
  const label = (l: unknown) =>
    typeof l === 'object' && l !== null && ((l as CoinLabel).ticker === null || typeof (l as CoinLabel).ticker === 'string') && Number.isInteger((l as CoinLabel).decimals);
  return (
    typeof o.txHash === 'string' && /^[0-9a-f]{64}$/.test(o.txHash) && o.orderIndex === 0 && typeof o.traderHex === 'string' &&
    typeof o.traderPaymentHash === 'string' && typeof o.ttlSlot === 'number' && typeof o.placedAt === 'number' &&
    typeof o.submitted === 'boolean' && label(o.inLabel) && label(o.outLabel)
  );
}

function isCancelNote(c: unknown): c is CancelNote {
  if (typeof c !== 'object' || c === null) return false;
  const o = c as Record<string, unknown>;
  return typeof o.txHash === 'string' && TX_HASH.test(o.txHash) && Number.isFinite(o.sentAt) && Number.isInteger(o.ttlSlot);
}

export function readOrderNotes(now: number = Date.now()): PendingOrder[] {
  try {
    const raw = JSON.parse(localStorage.getItem(NOTES_KEY) ?? '[]') as unknown;
    if (!Array.isArray(raw)) return [];
    // A malformed `settled` or `cancel` is dropped, never the note: the order is then read again.
    return raw
      .filter(isNote)
      .filter((n) => now - n.placedAt < NOTE_LIFETIME_MS)
      .map((n) => (n.settled === undefined || isSettled(n.settled) ? n : { ...n, settled: undefined }))
      .map((n) => (n.cancel === undefined || isCancelNote(n.cancel) ? n : { ...n, cancel: undefined }));
  } catch {
    return [];
  }
}

/** The trader signed a cancel of this order: noted before it leaves, so a reload knows it is on its way. */
export function markOrderCancelSent(txHash: string, cancel: CancelNote): void {
  try {
    const notes = readOrderNotes();
    localStorage.setItem(NOTES_KEY, JSON.stringify(notes.map((n) => (n.txHash === txHash ? { ...n, cancel } : n))));
  } catch {
    /* storage blocked: the page holds the cancel in memory */
  }
}

/**
 * Written BEFORE the transaction leaves, so a reload mid-send still knows the order exists.
 * False when this browser would not keep it: the page then says the order will not be
 * followed after a reload.
 */
export function writeOrderNote(note: PendingOrder): boolean {
  try {
    const notes = readOrderNotes().filter((n) => n.txHash !== note.txHash);
    localStorage.setItem(NOTES_KEY, JSON.stringify([note, ...notes].slice(0, 20)));
    return readOrderNotes().some((n) => n.txHash === note.txHash);
  } catch {
    return false;
  }
}

/** The wallet said it sent the transaction: the note stops saying it may not have been sent. */
export function markOrderSubmitted(txHash: string): void {
  try {
    const notes = readOrderNotes();
    localStorage.setItem(NOTES_KEY, JSON.stringify(notes.map((n) => (n.txHash === txHash ? { ...n, submitted: true } : n))));
  } catch {
    /* storage blocked: the page holds the order in memory */
  }
}

export function dropOrderNote(txHash: string): void {
  try {
    localStorage.setItem(NOTES_KEY, JSON.stringify(readOrderNotes().filter((n) => n.txHash !== txHash)));
  } catch {
    /* nothing to drop */
  }
}
