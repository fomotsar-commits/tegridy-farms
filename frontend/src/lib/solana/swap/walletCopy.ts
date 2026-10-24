// What the swap page says about the wallet and what it sent, on both routes. Here, with
// no imports, so the page can say it without loading the send path (write/submit.ts).
export const DECLINED_IN_WALLET = 'You cancelled in your wallet. Nothing was sent.';

/** The rule a held Buy ends on (usePendingTrades, PENDING_TRADE_TTL_MS). */
export const HELD_UNTIL =
  'Buy stays off for this wallet until the network says it landed, failed, or can no longer land. After 10 minutes Buy comes back on by itself: by then the swap has landed or never will.';
export const HOLD_DISMISS_LABEL = 'Turn Buy back on now';
export const HOLD_DISMISS_MEANS = 'This does not cancel the swap. If it lands, it lands. It only turns Buy back on for this wallet.';
/** The hold after a lost wallet answer (no signature): it ends on the blockhash, or at most 2 minutes on (LOST_ANSWER_TTL_MS). */
export const LOST_HOLD_TITLE = 'A swap may have been sent';
export const LOST_HELD_UNTIL = 'Buy stays off for this wallet until this swap can no longer land: 2 minutes at most.';
export const LOST_NO_SIGNATURE = 'Through Jupiter. No signature is known: your wallet did not hand one back.';

/** A press stopped before the wallet: a swap this wallet sent, in this tab or another, is not confirmed yet. */
export const HELD_NOT_SENT = 'A swap this wallet sent is not confirmed yet, so this one was not sent. Your wallet was not asked.';

/** A wallet's sendTransaction threw in a way that can come after it signed: the transaction may be out. */
export const LOST_ANSWER_TITLE = 'Sent or not, we cannot tell';
/** `did` completes "whether ___", e.g. "it sent ≈12 BAYLA with 0.1 SOL". */
export const lostAnswerCopy = (reason: string, did: string) =>
  `Your wallet stopped without handing back a signature (${reason}). This page cannot tell whether ${did}. Check your wallet's activity before you press again.`;

/** Jupiter's test run could not run twice in a row (owner, 2026-10-14, D2). */
export const CHECK_KEEPS_FAILING = 'This check keeps failing on our side. Nothing was sent.';
export const OWN_POOL_REVIEW_OFFER = 'Review this swap in our pool';

/** Nothing reached the wallet: the press stopped on a read (a quote, Jupiter's transaction). */
export const nothingSentCopy = (what: string, why: string) => `${what} could not be fetched just now (${why}). Nothing was sent, and the form is as you left it.`;
