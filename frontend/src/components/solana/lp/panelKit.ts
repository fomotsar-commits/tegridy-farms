import { useEffect, useRef, useState } from 'react';
import type { PublicKey } from '@solana/web3.js';
import { formatSol, formatTokenAmount } from '../../../lib/launcher/solana/curve/format';
import { LOCKED_SHARES_TEXT } from '../../../lib/solana/lp/liquidityMath';
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
 * The pool shares the pool program keeps in every new pool forever (100 of the smallest
 * unit), written as the share counts on this page are: in 9 decimals. One text, shared
 * with the write layer's refusals (lib/solana/lp/liquidityMath.ts).
 */
export { LOCKED_SHARES_TEXT };

/** A share of the pool as a percentage; a real share that rounds to nothing says so. */
export function sharePct(part: bigint, whole: bigint): string {
  if (whole <= 0n || part <= 0n) return 'none';
  const pct = Number((part * 1_000_000n) / whole) / 10_000;
  return pct < 0.01 ? '<0.01%' : `${pct.toFixed(2)}%`;
}

/**
 * The wallet as the panel's hints see it: `null` while reading or with no wallet. Read
 * again whenever `nonce` changes (after each finished flow). An answer is kept only
 * for the question it answers.
 */
export function useWalletFacts(
  writes: LpWrites,
  owner: PublicKey | null,
  a: { tokenMint: string; tokenProgram: string; lpMint: string | null; opening?: true },
  nonce: number,
): WalletFacts | null {
  const ownerKey = owner?.toBase58() ?? null;
  const key = ownerKey ? `${ownerKey}#${a.tokenMint}#${a.tokenProgram}#${a.lpMint ?? ''}#${a.opening ? 'open' : ''}#${nonce}` : null;
  const [answer, setAnswer] = useState<{ key: string; facts: WalletFacts } | null>(null);
  const { readers } = writes;
  useEffect(() => {
    if (!owner || !key) return;
    let live = true;
    (a.opening ? readers.wallet(owner, a.tokenMint, a.tokenProgram, a.lpMint, { opening: true }) : readers.wallet(owner, a.tokenMint, a.tokenProgram, a.lpMint)).then(
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

