import { useSyncExternalStore } from 'react';
import { RECEIPT_WORDS } from './arrival';
import { markLanded } from './landed';
import type { HeatReading } from './heat/heatOracle';

/**
 * The receipt card (island answer twenty-five, screen 3, build 6): every swap and every add
 * on Solana ends on one card that says what was done, what the fee was and where it went,
 * and what it did to the wallet's clock. The card is raised the moment the chain confirms;
 * its figures are then read from the confirmed transaction itself (lib/solana/receiptRead.ts),
 * never typed: until they are read the card says so. In memory only; the last one raised is
 * kept for Bayla's Receipt. Entry-chunk code: no Solana import here.
 */
export type ReceiptFee =
  | { kind: 'reading' }
  /** A swap in the venue's own pool: its trade fee and that fee's split, from the swap's own event. */
  | { kind: 'pool'; unit: string; fee: string; lps: string; venue: string; creator: string | null }
  /** A swap through Jupiter: what the venue's fee account received in this transaction; null when nothing. */
  | { kind: 'site'; venue: string | null }
  /** An add of both coins pays the pool no fee: the network's cost instead. */
  | { kind: 'add'; network: string }
  | { kind: 'unread' };

export type ClockLine = 'day1' | 'double' | 'kept';

export interface Receipt {
  signature: string;
  explorerUrl: string;
  wallet: string;
  action: 'bought' | 'sold' | 'added';
  /** The coin the card is about, as the venue names it. */
  coin: { symbol: string; mint: string };
  /** The action's words, from what the transaction moved; null until read. */
  title: string | null;
  under: string | null;
  fee: ReceiptFee;
  clock: ClockLine | null;
  /**
   * How many other wallets hold a share of this pool, read after an add (lib/solana/lp/holders.ts,
   * the adder's own share left out): that many LP bricks on the add's floor (island answer
   * thirty-two). Null until read, when the read fails, and for a swap.
   */
  lps: number | null;
}

let current: Receipt | null = null;
let open = false;
let snapshot: { receipt: Receipt | null; open: boolean } = { receipt: null, open: false };
const listeners = new Set<() => void>();

function emit(): void {
  snapshot = { receipt: current, open };
  for (const l of listeners) l();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The chain confirmed it: the card rises, and Bayla's line says Done for a minute. */
export function raiseReceipt(r: Receipt): void {
  current = r;
  open = true;
  markLanded(r.action === 'added' ? 'add' : 'trade');
  emit();
}

/** What the transaction was read to have done, for the receipt it belongs to (a later receipt is not touched). */
export function settleReceipt(signature: string, patch: Partial<Pick<Receipt, 'title' | 'under' | 'fee' | 'lps'>>): void {
  if (!current || current.signature !== signature) return;
  current = { ...current, ...patch };
  emit();
}

export function closeReceipt(): void {
  if (!open) return;
  open = false;
  emit();
}

/** Bayla's Receipt: the last card again. False when there is none to show. */
export function reopenReceipt(): boolean {
  if (!current) return false;
  open = true;
  emit();
  return true;
}

/** The card raised last, open or not. */
export function lastReceipt(): Receipt | null {
  return current;
}

export function useReceipt(): { receipt: Receipt | null; open: boolean } {
  return useSyncExternalStore(subscribe, () => snapshot, () => snapshot);
}

/** Tests only. */
export function clearReceipt(): void {
  current = null;
  open = false;
  emit();
}

/**
 * The clock line, one of three (answer twenty-four, build 6): an add counts double from
 * tomorrow; a sell cools and never resets, so the clock kept counting (the card says nothing
 * of the cooling); a buy starts day 1 tonight unless this wallet's reading already holds the
 * coin. A buy with no reading of this wallet says nothing: a fact not read is left out.
 */
export function clockFor(action: Receipt['action'], coinMint: string, wallet: string, reading: HeatReading | null, island: boolean): ClockLine | null {
  if (!island) return null;
  if (action === 'added') return 'double';
  if (action === 'sold') return 'kept';
  if (!reading || reading.address.toLowerCase() !== wallet.toLowerCase()) return null;
  return reading.breakdown.some((row) => row.tokenAddress === coinMint) ? 'kept' : 'day1';
}

export function clockText(line: ClockLine, coin: string): string {
  return line === 'day1' ? RECEIPT_WORDS.dayOne(coin) : line === 'double' ? RECEIPT_WORDS.double : RECEIPT_WORDS.kept(coin);
}
