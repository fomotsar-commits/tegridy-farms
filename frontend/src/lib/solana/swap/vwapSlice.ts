// One slice of a VWAP order (vwapOrder.ts), tried once, and a slice already out settled.
// Every read and the wallet come in as deps, so the order of the checks is pinned by tests:
// nothing reaches the wallet unless the 24h average was read, the slice's own quote is
// within the person's limit of it, and Jupiter's transaction passed its test run and is
// still within the limit at the quote it was built from.

import type { JupiterQuote } from '../../jupiter';
import { refusedSaid, type PreparedJupiterSwap } from './jupiterFeeRetry';
import type { PairAverage } from './pairAverage';
import type { WalletSwapEnd } from './walletSwapSend';
import { SLICE_SLIPPAGE_BPS, UNLANDED_AFTER_MS, sliceVerdict, type VwapOrder, type VwapSlice } from './vwapOrder';

export interface SliceDeps {
  average(): Promise<PairAverage>;
  quote(amount: string): Promise<JupiterQuote>;
  prepare(fresh: JupiterQuote, amount: string): Promise<PreparedJupiterSwap>;
  /** "≈12 BAYLA with 0.1 SOL" for these base-unit amounts. */
  words(paid: bigint, out: bigint): string;
  /** The wallet signs and the page sends (sendWalletSwap). `onSent` runs once a signature exists and its note is written. */
  send(b64: string, words: string, onSent: (signature: string) => void): Promise<WalletSwapEnd>;
}

export type SliceTry =
  /** Not sent and the wallet was not asked: why, in words. */
  | { kind: 'wait'; why: string; vsAveragePct?: number }
  /** The wallet was asked (or a note held it) and nothing reached the network. */
  | { kind: 'not-sent'; why: string; declined: boolean; vsAveragePct: number }
  /** Only a wallet that sends by itself: it may be out with no signature. The order stops. */
  | { kind: 'lost'; why: string }
  | { kind: 'sent'; signature: string; outcome: 'confirmed' | 'reverted' | 'unknown'; quotedOut: string; vsAveragePct: number };

const toBig = (s: string): bigint | null => (/^\d+$/.test(s) ? BigInt(s) : null);

const REFUSED_ON_CHAIN = 'The network refused this slice. Only the network fee was spent.';

export const SLICE_NOT_TEST_RUN = 'The test run of Jupiter’s transaction for this slice could not run just now, so nothing was sent. It tries again in a minute.';

export async function trySlice(d: SliceDeps, o: Pick<VwapOrder, 'pay' | 'buy' | 'bandBps'>, amount: bigint, onSent: (signature: string) => void): Promise<SliceTry> {
  let avg: PairAverage;
  try {
    avg = await d.average();
  } catch {
    avg = { kind: 'unread' };
  }
  // Not one request to Jupiter for a slice that cannot be priced against the average.
  if (avg.kind !== 'ok') {
    const v = sliceVerdict(avg, o, amount, 1n);
    return { kind: 'wait', why: v.go ? '' : v.why };
  }
  let q: JupiterQuote;
  try {
    q = await d.quote(amount.toString());
  } catch {
    return { kind: 'wait', why: 'Jupiter’s price could not be read just now. This slice tries again in a minute.' };
  }
  const quoted = toBig(String(q.outAmount));
  if (quoted === null || quoted <= 0n) return { kind: 'wait', why: 'Jupiter gave no price for this slice just now. It tries again in a minute.' };
  const first = sliceVerdict(avg, o, amount, quoted);
  if (!first.go) return { kind: 'wait', why: first.why, vsAveragePct: first.vsAveragePct };

  let prepared: PreparedJupiterSwap;
  try {
    prepared = await d.prepare(q, amount.toString());
  } catch {
    return { kind: 'wait', why: 'Jupiter’s transaction for this slice could not be built just now. It tries again in a minute.', vsAveragePct: first.vsAveragePct };
  }
  if (prepared.status === 'blocked') {
    return { kind: 'wait', why: prepared.unchecked ? SLICE_NOT_TEST_RUN : refusedSaid(prepared, SLICE_SLIPPAGE_BPS), vsAveragePct: first.vsAveragePct };
  }
  if (prepared.status === 'moved') {
    return { kind: 'wait', why: 'The price moved while this slice was being built. It tries again in a minute.', vsAveragePct: first.vsAveragePct };
  }
  // The quote the transaction was built from can be another (a no-fee re-quote): it is held to the limit too.
  const builtOut = toBig(String(prepared.quote.outAmount));
  if (builtOut === null || builtOut <= 0n) return { kind: 'wait', why: 'Jupiter gave no price for this slice just now. It tries again in a minute.' };
  const built = sliceVerdict(avg, o, amount, builtOut);
  if (!built.go) return { kind: 'wait', why: built.why, vsAveragePct: built.vsAveragePct };

  const end = await d.send(prepared.swapTransaction, d.words(amount, builtOut), onSent);
  if (end.kind === 'not-sent') return { kind: 'not-sent', why: end.message, declined: end.declined, vsAveragePct: built.vsAveragePct };
  if (end.kind === 'lost') return { kind: 'lost', why: end.message };
  return { kind: 'sent', signature: end.signature, outcome: end.outcome, quotedOut: builtOut.toString(), vsAveragePct: built.vsAveragePct };
}

export interface SettleDeps {
  /** A swap this wallet sent, in any tab, is still held by its note. */
  holdsNow(): boolean;
  /** The chain's voted status of a signature, searching history: null when it has none. Throws when it could not be read. */
  status(signature: string): Promise<'confirmed' | 'reverted' | null>;
  /** The transaction as the chain's history holds it: null when it holds none. Throws when it could not be read. */
  history(signature: string): Promise<'confirmed' | 'reverted' | null>;
}

export type Settled =
  /** It landed: the slice filled. */
  | { kind: 'landed' }
  /** It landed and the chain refused it, or it never left the page: the slice is free to go again. */
  | { kind: 'free'; why: string }
  /** Not known yet: nothing else is sent until it is. */
  | { kind: 'open' };

/**
 * What became of a slice that was out ("sending" or "unconfirmed"). A slice with no signature
 * never left the page (the page sends; its signature is recorded before the first send), so
 * it is free once no note holds this wallet. One with a signature is "did not land" only when
 * the chain has no status for it, no note holds it, it was sent at least UNLANDED_AFTER_MS ago,
 * AND its history has no such transaction: an unread answer is never a failed one.
 */
export async function settleSlice(d: SettleDeps, s: Pick<VwapSlice, 'state' | 'sig' | 'sentAt'>, now: number): Promise<Settled> {
  if (s.state === 'sending' && !s.sig) {
    return d.holdsNow() ? { kind: 'open' } : { kind: 'free', why: 'The page closed before this slice was sent. Nothing was sent.' };
  }
  if (!s.sig || s.sentAt === undefined) return { kind: 'open' };
  try {
    const st = await d.status(s.sig);
    if (st === 'confirmed') return { kind: 'landed' };
    if (st === 'reverted') return { kind: 'free', why: REFUSED_ON_CHAIN };
    if (now - s.sentAt < UNLANDED_AFTER_MS || d.holdsNow()) return { kind: 'open' };
    const held = await d.history(s.sig);
    if (held === 'confirmed') return { kind: 'landed' };
    if (held === 'reverted') return { kind: 'free', why: REFUSED_ON_CHAIN };
    return { kind: 'free', why: 'This slice never reached the chain. Nothing was spent.' };
  } catch {
    return { kind: 'open' };
  }
}
