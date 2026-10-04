// The Jupiter route's whole send, from "the trader pressed the button" to an
// honest ending. No React and no wallet adapter in here, so every branch is
// unit-testable (SPEC_S3 section 2.1, decisions D13 and D14).
//
// What it promises:
//   1. A FRESH quote is read first. "Jupiter could not be read" and "Jupiter
//      has no route" are different answers and both stop here.
//   2. The display-vs-submit guard: a fresh quote that pays less than the one
//      the trader clicked, beyond their own slippage, is shown, not sent. If
//      either amount or the slippage cannot be read, nothing is sent either.
//   3. Build and simulate go through the fee-retry rule
//      (./jupiterFeeRetry.ts prepareJupiterSwap), unchanged: the fee-bearing
//      build first, and one no-fee rebuild only on Jupiter's own 6014.
//   4. FAIL CLOSED (J1). If any simulation could not be run, nothing goes to
//      the wallet. The fee-retry rule on its own still lets an unreadable FIRST
//      simulation through (that is its pinned behaviour, kept for the swap
//      page's current send path); this function watches the simulation calls
//      and refuses whenever one of them threw.
//   5. Once the wallet returns a signature the swap may be on chain. `onSent`
//      is called at once, before any waiting, so the caller can write its note.
//      From there the only endings are confirmed, reverted (the chain said so,
//      at confirmed or finalized) and unknown. Never "failed" (J2).
//
// The swap page does not call this yet: the page half of SPEC_S3 step S1 moves
// its send path here.
import { VersionedTransaction } from '@solana/web3.js';
import type {
  BuildSwapParams,
  BuiltSwap,
  JupiterQuote,
  PriorityLevel,
  QuoteParams,
  QuoteRead,
  SwapSimulation,
} from '../../jupiter';
import { pollConfirm, type SignatureStatusSource } from '../confirm';
import { prepareJupiterSwap, type PreparedJupiterSwap } from './jupiterFeeRetry';

/** How a sent swap's status is read: the one call lib/solana/confirm.ts polls. */
export type SignatureStatusReader = SignatureStatusSource['getSignatureStatuses'];

/**
 * How long a sent swap is watched before the ending is "unknown": the swap
 * page's own limit (SWAP_CONFIRM_TIMEOUT_MS in SolanaSwapPage.tsx).
 */
export const JUPITER_CONFIRM_TIMEOUT_MS = 90_000;

export interface JupiterSendDeps {
  /** lib/jupiter.ts readQuote. */
  readQuote(params: QuoteParams): Promise<QuoteRead>;
  /** lib/jupiter.ts buildSwapWithExpiry: the build, with the height its blockhash expires at. */
  buildSwapTransaction(params: BuildSwapParams): Promise<BuiltSwap>;
  /** lib/jupiter.ts simulateSwap. A throw means "could not be simulated", and nothing is sent. */
  simulateSwap(b64Tx: string): Promise<SwapSimulation>;
  /** lib/jupiter.ts swapCarriesPlatformFee: was the first build fee-bearing? */
  swapCarriesPlatformFee(inputMint: string, outputMint: string): boolean;
  /** The wallet adapter's: signs AND sends, and returns the signature. */
  sendTransaction(tx: VersionedTransaction): Promise<string>;
  getSignatureStatuses: SignatureStatusReader;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

export type JupiterNotSentReason =
  | 'quote-unread'
  | 'no-route'
  | 'build'
  | 'simulate-failed'
  | 'simulate-unread'
  | 'declined';

export type JupiterSendResult =
  /** Nothing reached the network. `message` is a whole sentence for the trader. */
  | { status: 'not-sent'; reason: JupiterNotSentReason; message: string }
  /**
   * Stopped before the wallet because the trade is no longer the one clicked.
   * `fresh` is the quote to show now; `siteFeeWaived` says whether it is a
   * no-fee quote. `why`: 'price' = it pays less beyond the slippage;
   * 'fee-returned' = the trader clicked a no-fee quote and the fee can be
   * taken again, so they would receive slightly less.
   */
  | { status: 'moved'; why: 'price' | 'fee-returned'; fresh: JupiterQuote; siteFeeWaived: boolean }
  /** The wallet threw without returning a signature, and it was not a cancel: it may or may not have sent. */
  | { status: 'wallet-error'; message: string }
  /** `fresh` is the quote the sent transaction was built from: show ITS amounts. */
  | { status: 'confirmed'; signature: string; fresh: JupiterQuote; siteFeeWaived: boolean }
  /** The chain refused it, seen at confirmed or finalized. */
  | { status: 'reverted'; signature: string; fresh: JupiterQuote; siteFeeWaived: boolean }
  /** Sent, not confirmed in the time allowed. It may still land. Never "failed". */
  | { status: 'unknown'; signature: string; fresh: JupiterQuote; siteFeeWaived: boolean };

export const JUPITER_SEND_COPY = {
  quoteUnread: 'We could not get Jupiter’s price just now, so nothing was sent. Try again in a moment.',
  shownUnread:
    'We could not compare the price you were shown with Jupiter’s price now, so nothing was sent. Wait for a fresh price and try again.',
  noRoute: 'Jupiter has no route for this pair and amount right now. Nothing was sent.',
  build: (detail: string) => `Jupiter could not build this swap (${detail}). Nothing was sent.`,
  simulateUnread: 'We could not test this swap before signing, so it was not sent to your wallet. Try again in a moment.',
  simulateFailed: (detail: string | null) =>
    `This swap would fail on chain${detail ? ` (${detail})` : ''}, so it was not sent to your wallet.`,
  declined: 'You cancelled in your wallet. Nothing was sent.',
  walletError: (detail: string) =>
    `Your wallet reported a problem (${detail}). Check your wallet’s activity before trying again: it may still have sent the swap.`,
} as const;

/**
 * Did the person say no in their wallet? The same words as the write layer's
 * check (lib/launcher/solana/write/submit.ts isDecline), copied rather than
 * imported: that file is in the lazily loaded write chunk, and the swap page
 * must not pull it in to send a Jupiter swap.
 */
function isDecline(e: unknown): boolean {
  const msg = e instanceof Error ? `${e.name} ${e.message}` : String(e ?? '');
  return /reject|declin|denied|cancel|WalletSignTransactionError|User rejected/i.test(msg);
}

/** A raw amount as Jupiter sends it: a string of digits (lib/jupiter.ts RAW_AMOUNT). Anything else is unread: null, never 0. */
function rawAmount(raw: unknown): bigint | null {
  return typeof raw === 'string' && /^\d{1,30}$/.test(raw) ? BigInt(raw) : null;
}

function detailOf(e: unknown): string {
  const raw = e instanceof Error ? e.message : String(e ?? '');
  const one = raw.replace(/\s+/g, ' ').trim();
  return one.length > 0 ? one.slice(0, 140) : 'no detail given';
}

export async function sendJupiterSwap(
  deps: JupiterSendDeps,
  a: {
    /** The quote the trader clicked on. */
    shown: JupiterQuote;
    /** True when `shown` is a no-fee re-quote left on screen by an earlier attempt. */
    shownWaived?: boolean;
    inputMint: string;
    outputMint: string;
    /** Input amount in base units. */
    amount: string;
    slippageBps: number;
    user: string;
    priority: PriorityLevel;
    /**
     * Just before the wallet opens: the quote the transaction was built from,
     * and whether the site fee was dropped for it. The page puts these amounts
     * on screen first, so the wallet prompt never shows over stale numbers.
     */
    onReady?(sent: JupiterQuote, siteFeeWaived: boolean): void;
    /** The moment a signature exists, before any waiting. */
    onSent(signature: string, lastValidBlockHeight: number | null): void;
  },
): Promise<JupiterSendResult> {
  // 1. A fresh quote, so the minimum and the route match the market now.
  let read: QuoteRead;
  try {
    read = await deps.readQuote({ inputMint: a.inputMint, outputMint: a.outputMint, amount: a.amount, slippageBps: a.slippageBps });
  } catch {
    return { status: 'not-sent', reason: 'quote-unread', message: JUPITER_SEND_COPY.quoteUnread };
  }
  if (read.kind === 'unread') return { status: 'not-sent', reason: 'quote-unread', message: JUPITER_SEND_COPY.quoteUnread };
  if (read.kind === 'no-route') return { status: 'not-sent', reason: 'no-route', message: JUPITER_SEND_COPY.noRoute };
  const fresh = read.quote;

  // 2. Display-vs-submit (the page's rule since 2026-07-24, unchanged): the
  // trader agreed to `shown`. Compared on raw outAmount, in whole base units.
  // Not run when the clicked quote is the no-fee one: a fee-bearing `fresh`
  // sits right on that quote's floor before the market moves at all. The
  // like-for-like check for that case is inside prepareJupiterSwap.
  //
  // FAIL CLOSED: an amount or a price limit that cannot be read is not "nothing
  // moved". The simulation further down only proves the FRESH quote's own
  // minimum; it knows nothing about what the trader clicked. So when the
  // comparison cannot be made, nothing is built and nothing reaches the wallet.
  const slippageOk = Number.isInteger(a.slippageBps) && a.slippageBps >= 0 && a.slippageBps <= 10_000;
  const freshOut = rawAmount(fresh.outAmount);
  if (!slippageOk || freshOut === null) return { status: 'not-sent', reason: 'quote-unread', message: JUPITER_SEND_COPY.shownUnread };
  if (!a.shownWaived) {
    const shownOut = rawAmount(a.shown?.outAmount);
    if (shownOut === null) return { status: 'not-sent', reason: 'quote-unread', message: JUPITER_SEND_COPY.shownUnread };
    const floor = shownOut - (shownOut * BigInt(a.slippageBps)) / 10_000n;
    if (freshOut < floor) return { status: 'moved', why: 'price', fresh, siteFeeWaived: false };
  }

  // 3 and 4. Build and simulate through the fee-retry rule, watching every
  // simulation. `expiry` remembers each build's height so the one that is sent
  // reports its own.
  const expiry = new Map<string, number | null>();
  let simulationUnread = false;
  let prepared: PreparedJupiterSwap;
  try {
    prepared = await prepareJupiterSwap(
      {
        getQuote: async (p) => {
          const r = await deps.readQuote(p);
          if (r.kind !== 'quote') throw new Error(r.kind === 'no-route' ? 'no route' : r.detail);
          return r.quote;
        },
        buildSwapTransaction: async (p) => {
          const built = await deps.buildSwapTransaction(p);
          expiry.set(built.swapTransaction, built.lastValidBlockHeight);
          return built.swapTransaction;
        },
        simulateSwap: async (tx) => {
          try {
            return await deps.simulateSwap(tx);
          } catch (e) {
            simulationUnread = true;
            throw e;
          }
        },
        swapCarriesPlatformFee: deps.swapCarriesPlatformFee,
      },
      {
        fresh,
        shown: a.shown,
        inputMint: a.inputMint,
        outputMint: a.outputMint,
        amount: a.amount,
        slippageBps: a.slippageBps,
        user: a.user,
        priority: a.priority,
      },
    );
  } catch (e) {
    // Only the FIRST build can throw out of the rule; its retry steps are caught inside it.
    return { status: 'not-sent', reason: 'build', message: JUPITER_SEND_COPY.build(detailOf(e)) };
  }
  // FAIL CLOSED, checked before anything else the rule answered: whatever it
  // decided, a simulation that could not be run means nothing is signed.
  if (simulationUnread) return { status: 'not-sent', reason: 'simulate-unread', message: JUPITER_SEND_COPY.simulateUnread };
  if (prepared.status === 'blocked') {
    return { status: 'not-sent', reason: 'simulate-failed', message: JUPITER_SEND_COPY.simulateFailed(prepared.reason) };
  }
  if (prepared.status === 'moved') return { status: 'moved', why: 'price', fresh: prepared.quote, siteFeeWaived: true };
  const sent = prepared.quote;
  const siteFeeWaived = prepared.siteFeeWaived;
  if (a.shownWaived && !siteFeeWaived) {
    // The trader clicked a quote that said "no site fee", and this time the
    // fee-bearing build simulates clean. That pays them less than what they
    // clicked: show it, and let them choose it with their own click.
    return { status: 'moved', why: 'fee-returned', fresh: sent, siteFeeWaived: false };
  }

  let tx: VersionedTransaction;
  try {
    tx = VersionedTransaction.deserialize(Uint8Array.from(atob(prepared.swapTransaction), (c) => c.charCodeAt(0)));
  } catch {
    return { status: 'not-sent', reason: 'build', message: JUPITER_SEND_COPY.build('its transaction could not be read') };
  }
  const lastValidBlockHeight = expiry.get(prepared.swapTransaction) ?? null;

  try {
    a.onReady?.(sent, siteFeeWaived);
  } catch {
    /* the caller's screen update must not decide whether a checked swap is offered */
  }

  let signature: string;
  try {
    signature = await deps.sendTransaction(tx);
  } catch (e) {
    if (isDecline(e)) return { status: 'not-sent', reason: 'declined', message: JUPITER_SEND_COPY.declined };
    return { status: 'wallet-error', message: JUPITER_SEND_COPY.walletError(detailOf(e)) };
  }

  // 5. A signature exists. Tell the caller before waiting on anything, and
  // never let its bookkeeping lose the signature.
  try {
    a.onSent(signature, lastValidBlockHeight);
  } catch {
    /* the note failed to write; the ending below still carries the signature */
  }
  // The one shared poller (lib/solana/confirm.ts): only a status at confirmed or
  // finalized is an ending; a read that throws and a run-out clock are 'unknown'.
  const { outcome } = await pollConfirm(
    { getSignatureStatuses: deps.getSignatureStatuses },
    signature,
    JUPITER_CONFIRM_TIMEOUT_MS,
    deps.sleep,
    deps.now,
  );
  return { status: outcome, signature, fresh: sent, siteFeeWaived };
}
