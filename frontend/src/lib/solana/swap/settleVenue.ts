// Which venue a swap goes to, settled at the Buy press on fresh numbers: our pool's quote,
// just read, against what this site's Jupiter path would deliver now. Our pool wins a tie.
// Jupiter wins only on a fresh quote that pays strictly more, or a no-fee retry that is
// ready to sign and pays strictly more (jupiterFeeRetry.ts). A Jupiter answer that could
// not be had is never read as "no route": nothing is sent, and the person can ask again.

import { NoRouteError, quoteHasPlatformFee, type JupiterQuote } from '../../jupiter';
import type { PreparedJupiterSwap } from './jupiterFeeRetry';

export type ReadyJupiterSwap = Extract<PreparedJupiterSwap, { status: 'ready' }>;

export type Settled =
  /** `against`: the Jupiter number our pool met, or null when Jupiter has no route. */
  | { venue: 'own'; against: bigint | null }
  /** `prepared`: the transaction compared, when it was built here; null means build it as usual. */
  | { venue: 'jupiter'; fresh: JupiterQuote; prepared: ReadyJupiterSwap | null }
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
  if (a.ownOut < freshOut) return { venue: 'jupiter', fresh, prepared: null };
  // No fee to drop: what Jupiter delivers here is at most this quote.
  if (!quoteHasPlatformFee(fresh)) return { venue: 'own', against: freshOut };

  // Our pool beats the fee-bearing quote; only Jupiter's no-fee retry could beat it. Meeting
  // the no-fee quote settles it. Short of that (or with no answer), the retry's own rule runs:
  // build, simulate, and on its one 6014 the no-fee rebuild.
  try {
    const noFee = await deps.getQuote({ inputMint: a.inputMint, outputMint: a.outputMint, amount: a.amount, slippageBps: a.slippageBps, noPlatformFee: true });
    const noFeeOut = noFee.inAmount === a.amount ? amount(noFee.outAmount) : null;
    if (noFeeOut !== null && a.ownOut >= noFeeOut) return { venue: 'own', against: noFeeOut };
  } catch {
    /* only a shortcut: the rule below decides */
  }
  let p: PreparedJupiterSwap;
  try {
    p = await deps.prepareJupiter(fresh);
  } catch {
    return { venue: 'unavailable', detail: SETTLE_COPY.buildUnread };
  }
  if (p.status === 'blocked') return p.cause === 'unread' ? { venue: 'unavailable', detail: SETTLE_COPY.buildUnread } : { venue: 'own', against: freshOut };
  // The no-fee route pays less than the fee-bearing one: Jupiter's path would not send it.
  if (p.status === 'moved') return { venue: 'own', against: freshOut };
  const out = amount(p.quote.outAmount);
  if (out === null) return { venue: 'unavailable', detail: SETTLE_COPY.quoteOdd };
  return out > a.ownOut ? { venue: 'jupiter', fresh, prepared: p } : { venue: 'own', against: out };
}
