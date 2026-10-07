// Which venue a swap goes to, settled at the Buy press on fresh numbers: our pool's quote,
// just read, against what this site's Jupiter path would deliver now. Our pool wins a tie.
// Jupiter wins only with a transaction its own path has built and simulated (its one no-fee
// retry included, jupiterFeeRetry.ts) that pays strictly more. A Jupiter answer that could
// not be had is never read as "no route": nothing is sent, and the person can ask again.

import { NoRouteError, quoteHasPlatformFee, type JupiterQuote } from '../../jupiter';
import type { PreparedJupiterSwap } from './jupiterFeeRetry';

export type ReadyJupiterSwap = Extract<PreparedJupiterSwap, { status: 'ready' }>;

export type Settled =
  /** `against`: the Jupiter number our pool met, or null when Jupiter can deliver nothing. */
  | { venue: 'own'; against: bigint | null }
  /** `prepared`: the transaction compared, built and simulated: the one to send. */
  | { venue: 'jupiter'; fresh: JupiterQuote; prepared: ReadyJupiterSwap }
  /** Jupiter's retry pays less than the quote it replaces, and more than our pool: shown, not sent. */
  | { venue: 'moved'; quote: JupiterQuote }
  | { venue: 'unavailable'; detail: string };

export interface SettleDeps {
  getQuote(p: { inputMint: string; outputMint: string; amount: string; slippageBps: number; noPlatformFee?: boolean }): Promise<JupiterQuote>;
  /** prepareJupiterSwap for this trade and wallet, with `fresh` as the fee-bearing quote. */
  prepareJupiter(fresh: JupiterQuote): Promise<PreparedJupiterSwap>;
}

export const SETTLE_COPY = {
  quoteUnread: 'Jupiter could not be asked for a quote just now',
  quoteOdd: 'Jupiter answered with a quote this page cannot read',
  buildUnread: 'Jupiter could not build its trade just now',
} as const;

function amount(raw: unknown): bigint | null {
  return typeof raw === 'string' && /^\d+$/.test(raw) ? BigInt(raw) : null;
}

export async function settleVenue(
  deps: SettleDeps,
  a: { ownOut: bigint; inputMint: string; outputMint: string; amount: string; slippageBps: number },
): Promise<Settled> {
  let fresh: JupiterQuote;
  try {
    fresh = await deps.getQuote({ inputMint: a.inputMint, outputMint: a.outputMint, amount: a.amount, slippageBps: a.slippageBps });
  } catch (e) {
    return e instanceof NoRouteError ? { venue: 'own', against: null } : { venue: 'unavailable', detail: SETTLE_COPY.quoteUnread };
  }
  const freshOut = amount(fresh.outAmount);
  if (freshOut === null || fresh.inAmount !== a.amount || fresh.inputMint !== a.inputMint || fresh.outputMint !== a.outputMint) {
    return { venue: 'unavailable', detail: SETTLE_COPY.quoteOdd };
  }
  if (a.ownOut >= freshOut) {
    // No fee to drop: what Jupiter delivers here is at most this quote.
    if (!quoteHasPlatformFee(fresh)) return { venue: 'own', against: freshOut };
    // Only Jupiter's no-fee retry could beat our pool now, and meeting its quote settles it.
    try {
      const noFee = await deps.getQuote({ inputMint: a.inputMint, outputMint: a.outputMint, amount: a.amount, slippageBps: a.slippageBps, noPlatformFee: true });
      const noFeeOut = noFee.inAmount === a.amount ? amount(noFee.outAmount) : null;
      if (noFeeOut !== null && a.ownOut >= noFeeOut) return { venue: 'own', against: noFeeOut };
    } catch {
      /* only a shortcut: the rule below decides */
    }
  }
  // What Jupiter's path would really send: its build, its simulation, its one 6014 retry.
  let p: PreparedJupiterSwap;
  try {
    p = await deps.prepareJupiter(fresh);
  } catch {
    return { venue: 'unavailable', detail: SETTLE_COPY.buildUnread };
  }
  // Refused by its own simulation, Jupiter delivers nothing: there is no number to meet.
  if (p.status === 'blocked') return p.cause === 'unread' ? { venue: 'unavailable', detail: SETTLE_COPY.buildUnread } : { venue: 'own', against: null };
  const out = amount(p.quote.outAmount);
  if (out === null) return { venue: 'unavailable', detail: SETTLE_COPY.quoteOdd };
  // Its retry pays less than the quote it replaces: Jupiter's path would show it, not send it.
  if (p.status === 'moved') return a.ownOut >= out ? { venue: 'own', against: out } : { venue: 'moved', quote: p.quote };
  return out > a.ownOut ? { venue: 'jupiter', fresh, prepared: p } : { venue: 'own', against: out };
}
