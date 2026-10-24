// A placed order, followed to its end. On Cardano the trader's transaction only PLACES the
// order; Minswap's batcher fills it (or returns it) in a later transaction of its own. So the
// page has more states than "sent" and "done", and each is said for what it is:
//
//   not-seen   sent, and the chain has not shown it yet
//   placed     the order is on chain, waiting for the batcher (with its depth)
//   filled     the batcher paid the trader the coins bought
//   returned   the batcher returned the coins (the price moved past the minimum)
//   spent      the order was spent and this page could not tell how; the trader's wallet can
//   unknown    a read failed. NEVER "failed": the order may well have filled.
//
// Notes are kept in this browser so a reload does not lose an order still on its way.

import { readCredentialTxs, readTip, readTx, readTxDepth, readUtxoSpent } from './chain';
import { isAda, MINSWAP_V2, sameAsset, type CardanoAsset } from './minswapV2';

export interface PendingOrder {
  txHash: string;
  /** The order is always output 0 (swapTx.ts). */
  orderIndex: 0;
  traderHex: string;
  traderPaymentCred: string;
  assetIn: CardanoAsset;
  assetOut: CardanoAsset;
  amountIn: string;
  minimumReceive: string;
  /** Unix ms, from this browser's clock, for ordering notes only. */
  placedAt: number;
}

export type OrderStatus =
  | { kind: 'not-seen' }
  | { kind: 'placed'; depth: number }
  | { kind: 'filled'; fillTx: string; received: bigint; depositBack: bigint }
  | { kind: 'returned'; fillTx: string }
  | { kind: 'spent'; fillTx: string | null }
  | { kind: 'unknown'; reason: string };

/** How many history transactions are searched for the fill before saying "spent". */
const FILL_SEARCH = 12;

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
    return depth.data === null ? { kind: 'not-seen' } : { kind: 'placed', depth: depth.data };
  }

  // Spent: find the transaction that spent it, among the trader's own (the fill pays them).
  const [tip, depth] = await Promise.all([readTip(signal), readTxDepth(order.txHash, signal)]);
  if (tip.status !== 'ok') return { kind: 'unknown', reason: tip.reason };
  if (depth.status !== 'ok') return { kind: 'unknown', reason: depth.reason };
  const placedHeight = Math.max(0, tip.data.blockHeight - (depth.data ?? 0));
  const history = await readCredentialTxs(order.traderPaymentCred, placedHeight, signal);
  if (history.status !== 'ok') return { kind: 'unknown', reason: history.reason };
  for (const h of history.data.filter((x) => x.txHash !== order.txHash).slice(0, FILL_SEARCH)) {
    const tx = await readTx(h.txHash, signal);
    if (tx.status !== 'ok') return { kind: 'unknown', reason: tx.reason };
    if (!tx.data || !tx.data.inputs.some((i) => i.txHash === order.txHash && i.index === order.orderIndex)) continue;
    const mine = outputsTo(tx.data, order.traderHex);
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

const NOTES_KEY = 'tegridy.cardano.orders.v1';
/** Notes older than this are dropped: by then the order has long settled one way or the other. */
const NOTE_LIFETIME_MS = 7 * 24 * 3600 * 1000;

function isNote(x: unknown): x is PendingOrder {
  if (typeof x !== 'object' || x === null) return false;
  const o = x as Record<string, unknown>;
  return typeof o.txHash === 'string' && /^[0-9a-f]{64}$/.test(o.txHash) && o.orderIndex === 0 && typeof o.traderHex === 'string' && typeof o.placedAt === 'number';
}

export function readOrderNotes(now: number = Date.now()): PendingOrder[] {
  try {
    const raw = JSON.parse(localStorage.getItem(NOTES_KEY) ?? '[]') as unknown;
    return Array.isArray(raw) ? raw.filter(isNote).filter((n) => now - n.placedAt < NOTE_LIFETIME_MS) : [];
  } catch {
    return [];
  }
}

/** Written BEFORE the transaction leaves, so a reload mid-send still knows the order exists. */
export function writeOrderNote(note: PendingOrder): void {
  try {
    const notes = readOrderNotes().filter((n) => n.txHash !== note.txHash);
    localStorage.setItem(NOTES_KEY, JSON.stringify([note, ...notes].slice(0, 20)));
  } catch {
    /* storage blocked: the page still follows the order until it is closed */
  }
}

export function dropOrderNote(txHash: string): void {
  try {
    localStorage.setItem(NOTES_KEY, JSON.stringify(readOrderNotes().filter((n) => n.txHash !== txHash)));
  } catch {
    /* nothing to drop */
  }
}
