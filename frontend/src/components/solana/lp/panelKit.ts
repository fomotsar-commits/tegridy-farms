import { useEffect, useRef, useState } from 'react';
import type { PublicKey } from '@solana/web3.js';
import { formatSol, formatTokenAmount } from '../../../lib/launcher/solana/curve/format';
import { LOCKED_SHARES_TEXT } from '../../../lib/solana/lp/liquidityMath';
import { SOL_QUOTE, type QuoteCoin } from '../../../lib/solana/lp/quotes';
import type { WalletFacts } from '../../../lib/solana/lp/walletFacts';
import type { TxFlowState } from '../curve/useTxFlow';
import type { LpWrites } from './useLpWrites';

// What the Add and Remove panels share: the wallet read behind their hints and Max
// buttons, the debounced status line, how they report "busy" and "finished" to the
// section. The panel's frame is PanelFrame.tsx.

/** A bound or a share count, to its last digit: rounding "at most" or "you get" would misstate it. */
export const solExact = (lamports: bigint) => `${formatSol(lamports, 9)} SOL`;
export const unitsExact = (raw: bigint, decimals: number) => formatTokenAmount(raw, decimals, decimals).text;
/** An amount said "about": four decimals is plenty for a preview the review restates exactly. */
export const solAbout = (lamports: bigint) => `${formatSol(lamports, 4)} SOL`;
export const tokensAbout = (raw: bigint, decimals: number) => `${formatTokenAmount(raw, decimals, 4).text} tokens`;
/**
 * An amount of the pool's pairing coin (quotes.ts), in that coin's own decimals and with
 * its symbol: "250 USDC". SOL is `solExact` / `solAbout`, to the character, so a SOL
 * pool's words never change. The same forms as the review screen's (TxFlowView.tsx).
 */
export const coinExact = (raw: bigint, quote: QuoteCoin) => (quote.native ? solExact(raw) : `${formatTokenAmount(raw, quote.decimals, quote.decimals).text} ${quote.symbol}`);
export const coinAbout = (raw: bigint, quote: QuoteCoin) => (quote.native ? solAbout(raw) : `${formatTokenAmount(raw, quote.decimals, 4).text} ${quote.symbol}`);

/**
 * A wallet that cannot fund the action at all is told so before it types anything
 * (owner, 2026-10-03: the open-a-pool form only greyed out Review, and the reason was
 * two small hints). `null` whenever a balance is unread or something can go in: nothing
 * is claimed from a read that did not happen. `setAside` is `solSetAside`'s figure.
 *
 * `availableQuote` is what the wallet can put in on the pairing coin's side: for SOL,
 * `spendableSol`; for USDC or BAYLA, the wallet's balance of that coin.
 *
 * A pool paired with USDC or BAYLA puts no SOL in, but the wallet still pays the network
 * fee and the account deposits in SOL. So for those coins three things are checked, and
 * said in this order: the SOL for those costs (short when the wallet holds less than
 * `setAside`, the write layer's own rule), then the coin, then the token. The notice
 * leads with the first one the wallet is short of and names the rest after it, so nobody
 * fixes one thing and comes back to be told about the next.
 */
export function cannotFundText(a: {
  /** "open a pool", "add to this pool". */
  doing: string;
  /** What `setAside` pays for, in the hint's own words. */
  forWhat: string;
  /** The pool's pairing coin. */
  quote: QuoteCoin;
  lamports: bigint | null;
  setAside: bigint | null;
  availableQuote: bigint | null;
  availableToken: bigint | null;
}): string | null {
  const noToken = a.availableToken === 0n;
  if (a.quote.native) {
    if (a.availableQuote === 0n && a.setAside !== null && a.lamports !== null) {
      return `This wallet cannot ${a.doing} yet. That needs about ${solAbout(a.setAside)} for ${a.forWhat} before any SOL goes into the pool, and this wallet has ${solExact(a.lamports)}.${noToken ? ' It also holds none of this token, and a pool needs both.' : ''}`;
    }
    if (noToken) return `This wallet holds none of this token, so it cannot ${a.doing} yet. A pool needs both SOL and the token.`;
    return null;
  }
  const coin = a.quote.symbol;
  const noCoin = a.availableQuote === 0n;
  const needsBoth = `A pool needs both ${coin} and the token.`;
  if (a.setAside !== null && a.lamports !== null && a.lamports < a.setAside) {
    const also = noCoin && noToken ? ` It also holds no ${coin} and none of this token. ${needsBoth}` : noCoin ? ` It also holds no ${coin}. ${needsBoth}` : noToken ? ` It also holds none of this token. ${needsBoth}` : '';
    return `This wallet cannot ${a.doing} yet. That needs about ${solAbout(a.setAside)} for ${a.forWhat}, and this wallet has ${solExact(a.lamports)}. No SOL goes into the pool, but those costs are paid in SOL.${also}`;
  }
  if (noCoin) return `This wallet holds no ${coin}${noToken ? ' and none of this token' : ''}, so it cannot ${a.doing} yet. ${needsBoth}`;
  if (noToken) return `This wallet holds none of this token, so it cannot ${a.doing} yet. ${needsBoth}`;
  return null;
}

/**
 * The pool shares the pool program keeps in every new pool forever (100 of the smallest
 * unit), written as the share counts on this page are: in 9 decimals. One text, shared
 * with the write layer's refusals (lib/solana/lp/liquidityMath.ts).
 */
export { LOCKED_SHARES_TEXT };

/**
 * Above Review on the Add and Open forms. The long notes sit under the form, where the
 * amount boxes used to be: on a phone they filled two screens before the first box, and
 * the form read as if it were not there (owner, 2026-10-03). They are still always on the
 * page, and the review repeats the main ones before the wallet is asked to sign.
 */
export const NOTES_BELOW = 'Read the notes under this form before you review. The main ones are shown again before you sign.';

/**
 * Why Review is greyed out, said right above it. On a phone the Connect button and the
 * "cannot ... yet" notice are a screen above the button they switch off, and a dimmed
 * Review read as a live button that ignored the press (phone walk, 2026-10-03). Only the
 * reasons that are NOT already said beside the button; an amount problem has its own line.
 */
export function reviewOffWhy(a: { hasWallet: boolean; cannot: boolean; hasAmounts: boolean; amountsWord: string }): string | null {
  if (!a.hasWallet) return 'Review needs a wallet: the Connect button is at the top of this form.';
  if (a.cannot) return 'Review is off for this wallet: the top of this form says what it is short of.';
  if (!a.hasAmounts) return `Type ${a.amountsWord} to review.`;
  return null;
}

/** A share of the pool as a percentage; a real share that rounds to nothing says so. */
export function sharePct(part: bigint, whole: bigint): string {
  if (whole <= 0n || part <= 0n) return 'none';
  const pct = Number((part * 1_000_000n) / whole) / 10_000;
  return pct < 0.01 ? '<0.01%' : `${pct.toFixed(2)}%`;
}

/**
 * The wallet as the panel's hints see it: `null` while reading or with no wallet. Read
 * again whenever `nonce` changes (after each finished flow). An answer is kept only
 * for the question it answers, and the pairing coin (`a.quote`, default SOL) is part of
 * the question: switching coin shows "reading" until the new coin's balance is in, never
 * the other coin's.
 */
export function useWalletFacts(
  writes: LpWrites,
  owner: PublicKey | null,
  a: { tokenMint: string; tokenProgram: string; lpMint: string | null; opening?: true; quote?: QuoteCoin },
  nonce: number,
): WalletFacts | null {
  const ownerKey = owner?.toBase58() ?? null;
  const quote = a.quote ?? SOL_QUOTE;
  const key = ownerKey ? `${ownerKey}#${a.tokenMint}#${a.tokenProgram}#${a.lpMint ?? ''}#${a.opening ? 'open' : ''}#${quote.mint}#${nonce}` : null;
  const [answer, setAnswer] = useState<{ key: string; facts: WalletFacts } | null>(null);
  const { readers } = writes;
  useEffect(() => {
    if (!owner || !key) return;
    let live = true;
    // A SOL pool asks exactly as it always has: no options, or `opening` alone.
    const opts = quote.native ? (a.opening ? { opening: true as const } : undefined) : a.opening ? { opening: true as const, quote } : { quote };
    (opts ? readers.wallet(owner, a.tokenMint, a.tokenProgram, a.lpMint, opts) : readers.wallet(owner, a.tokenMint, a.tokenProgram, a.lpMint)).then(
      (facts) => live && setAnswer({ key, facts }),
      (e: unknown) => live && setAnswer({ key, facts: { kind: 'unread', detail: e instanceof Error ? e.message : String(e) } }),
    );
    return () => {
      live = false;
    };
    // key, not owner: a new PublicKey object for the same wallet is not a new wallet.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [readers, key]);
  return answer && answer.key === key ? answer.facts : null;
}

/**
 * A problem line for a `role="alert"`: shown once typing settles (500 ms), so a screen
 * reader is not interrupted on every digit by numbers that change with each one; cleared
 * at once when the problem goes (an empty alert says nothing).
 */
export function useSettledAlert(text: string): string {
  const settled = useDebounced(text);
  return text === '' ? '' : settled;
}

/** `text`, 500 ms after it last changed: a status line that does not speak every keystroke. */
export function useDebounced(text: string, ms = 500): string {
  const [shown, setShown] = useState(text);
  useEffect(() => {
    const t = setTimeout(() => setShown(text), ms);
    return () => clearTimeout(t);
  }, [text, ms]);
  return shown;
}

/**
 * Tell the section when this panel's flow is busy (so no other panel opens over it),
 * and when it went back to idle after an outcome (so the pools and positions are read
 * again). Calls `afterOutcome` for the panel's own re-reads too.
 */
export function useFlowReports(writes: LpWrites, step: TxFlowState['step'], locked: boolean, afterOutcome: () => void) {
  const busy = step === 'preparing' || step === 'submitting' || step === 'sent' || locked;
  const { setBusy, finished } = writes;
  useEffect(() => {
    setBusy(busy);
  }, [busy, setBusy]);
  useEffect(() => () => setBusy(false), [setBusy]);
  const prev = useRef(step);
  const after = useRef(afterOutcome);
  useEffect(() => {
    after.current = afterOutcome;
  }, [afterOutcome]);
  useEffect(() => {
    const was = prev.current;
    prev.current = step;
    if (was === 'outcome' && step === 'idle') {
      after.current();
      finished();
    }
  }, [step, finished]);
}

