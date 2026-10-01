import { useCallback, useEffect, useRef, useState } from 'react';
import { clipDetail } from '../../../lib/launcher/solana/curve';
import type { Prepared, PreparedTx, TxOutcome, TxSigner, WriteApi, WriteRpc } from './ports';

/**
 * One transaction, start to finish, for any of the seven kinds.
 *
 *   idle → preparing → review → submitting → sent → outcome
 *                  ↘ outcome (not-sent: nothing was signed)
 *
 * `submitting` is the wallet's turn. `sent` starts the moment the signature is known,
 * BEFORE the first byte leaves: from then on the transaction may land even if this
 * tab goes away. So `onSent` is called right then (the page writes its "may still
 * land" note there, which survives a reload), and leaving the page asks first.
 *
 * The rules this machine exists to hold:
 *  - Nothing reaches the wallet without a `review` step, and the review shows the
 *    values the prepared transaction carries (the write layer simulated it first).
 *  - A review cannot be signed once its blockhash is about to run out. The blockhash
 *    is fetched while preparing, so the clock starts when Review is pressed, not when
 *    the review appears, and REVIEW_TTL_MS stays well inside the ~150-block (~60 s)
 *    window. Before the wallet is asked, the block height is read too: with fewer
 *    than SIGN_MARGIN_BLOCKS left, the review is marked stale instead of signed.
 *    The user prepares again.
 *  - One submission per review. A second click, a double tap or a re-render cannot
 *    send the transaction twice.
 *  - `unknown` (sent, not confirmed) is not an error and is never called one. While
 *    it stands, the panel's action stays locked until the user checks again, so the
 *    easy mistake (paying twice) takes a deliberate step.
 *  - If the submit call itself throws, we cannot say whether anything was sent, so
 *    that too is `unknown`, and never "failed". It carries the signature when the
 *    transaction had already reached `sent`.
 */
export const REVIEW_TTL_MS = 45_000;
/** Blocks (~0.4 s each) the wallet prompt and the first send must still have. */
export const SIGN_MARGIN_BLOCKS = 25;
const HEIGHT_READ_TIMEOUT_MS = 3_000;

/** The confirmed block height, or null when it cannot be read quickly. */
async function confirmedHeight(rpc: WriteRpc): Promise<number | null> {
  if (typeof rpc.getBlockHeight !== 'function') return null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const h = await Promise.race([
      rpc.getBlockHeight('confirmed'),
      new Promise<null>((r) => {
        timer = setTimeout(() => r(null), HEIGHT_READ_TIMEOUT_MS);
      }),
    ]);
    return typeof h === 'number' && Number.isFinite(h) ? h : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export type TxFlowState =
  | { step: 'idle' }
  | { step: 'preparing' }
  /** `checking`: Sign was pressed and the block height is being read before the wallet opens. */
  | { step: 'review'; prepared: PreparedTx; expired: boolean; expiresAt: number; checking?: boolean }
  | { step: 'submitting'; prepared: PreparedTx }
  | { step: 'sent'; prepared: PreparedTx; signature: string }
  /** `checks`: how many times "Check again" has answered, so each answer reads as new. */
  | { step: 'outcome'; outcome: TxOutcome; prepared: PreparedTx | null; rechecking: boolean; checks?: number };

/**
 * A settled transaction, for the page. `sentSignature` is the signature it had once
 * it reached `sent`, or null: a `not-sent` outcome after `sent` (the network turned it
 * away at the first send) still names the note to clear.
 */
export type OnSettled = (outcome: TxOutcome, prepared: PreparedTx | null, sentSignature?: string | null) => void;
/** The signature is known and the transaction is about to be sent. Write the note here. */
export type OnSent = (signature: string, prepared: PreparedTx) => void;

export interface TxFlow {
  state: TxFlowState;
  /** True while a sent-but-unconfirmed transaction stands. Panels lock their action on it. */
  locked: boolean;
  prepare(build: () => Promise<Prepared>): Promise<void>;
  confirm(signer: TxSigner): Promise<void>;
  recheck(): Promise<void>;
  reset(): void;
}

export function useTxFlow(
  api: Pick<WriteApi, 'submitPrepared' | 'recheckOutcome'>,
  rpc: WriteRpc,
  onSettled?: OnSettled,
  onSent?: OnSent,
): TxFlow {
  const [state, setState] = useState<TxFlowState>({ step: 'idle' });
  const busy = useRef(false);
  const settledRef = useRef(onSettled);
  const sentRef = useRef(onSent);
  useEffect(() => {
    settledRef.current = onSettled;
    sentRef.current = onSent;
  }, [onSettled, onSent]);

  // Sent and not answered yet: a reload or a closed tab would drop the page's watch on
  // it. The note survives that, but the browser asks first.
  const inFlight = state.step === 'sent';
  useEffect(() => {
    if (!inFlight) return;
    const ask = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', ask);
    return () => window.removeEventListener('beforeunload', ask);
  }, [inFlight]);

  // Expire the review. The timer is tied to the prepared transaction it guards.
  const reviewing = state.step === 'review' ? state.prepared : null;
  const expiresAt = state.step === 'review' ? state.expiresAt : 0;
  useEffect(() => {
    if (!reviewing) return;
    const t = setTimeout(
      () => {
        setState((s) => (s.step === 'review' && s.prepared === reviewing ? { ...s, expired: true } : s));
      },
      Math.max(0, expiresAt - Date.now()),
    );
    return () => clearTimeout(t);
  }, [reviewing, expiresAt]);

  const prepare = useCallback(async (build: () => Promise<Prepared>) => {
    if (busy.current) return;
    busy.current = true;
    // The blockhash is fetched inside build(), so its window starts no earlier than now.
    const startedAt = Date.now();
    setState({ step: 'preparing' });
    try {
      const r = await build();
      if (r.ok) setState({ step: 'review', prepared: r.prepared, expired: false, expiresAt: startedAt + REVIEW_TTL_MS });
      else {
        setState({ step: 'outcome', outcome: r.outcome, prepared: null, rechecking: false });
        // A refusal is often "the price moved": the page reads the chain again so the
        // next attempt, and the numbers shown before it, start from the chain now.
        settledRef.current?.(r.outcome, null);
      }
    } catch (e) {
      // Nothing was signed yet, so this is safely "not sent".
      const outcome: TxOutcome = { status: 'not-sent', stage: 'build', message: clipDetail(e) };
      setState({ step: 'outcome', outcome, prepared: null, rechecking: false });
      settledRef.current?.(outcome, null);
    } finally {
      busy.current = false;
    }
  }, []);

  const confirm = useCallback(
    async (signer: TxSigner) => {
      if (busy.current) return;
      const s = state;
      if (s.step !== 'review' || s.expired) return;
      busy.current = true;
      const prepared = s.prepared;
      // A signature the network can no longer accept is wasted: read the height first.
      // Unreadable is not "fine", but it is not "stale" either; the first send runs
      // with preflight, which refuses an expired blockhash before anything is sent.
      setState((cur) => (cur.step === 'review' && cur.prepared === prepared ? { ...cur, checking: true } : cur));
      const height = await confirmedHeight(rpc);
      if (height !== null && height + SIGN_MARGIN_BLOCKS >= prepared.lastValidBlockHeight) {
        busy.current = false;
        setState((cur) =>
          cur.step === 'review' && cur.prepared === prepared ? { ...cur, expired: true, checking: false } : cur,
        );
        return;
      }
      setState({ step: 'submitting', prepared });
      let sentSignature: string | null = null;
      let outcome: TxOutcome;
      try {
        outcome = await api.submitPrepared(rpc, signer, prepared, {
          onSent: (signature) => {
            sentSignature = signature;
            try {
              sentRef.current?.(signature, prepared);
            } catch {
              /* a note that could not be written does not stop the send */
            }
            setState((cur) =>
              cur.step === 'submitting' && cur.prepared === prepared ? { step: 'sent', prepared, signature } : cur,
            );
          },
        });
      } catch (e) {
        outcome = {
          status: 'unknown',
          signature: sentSignature ?? '',
          message: `We lost track of this transaction (${clipDetail(e)}). Check your wallet's activity before trying again.`,
        };
      }
      busy.current = false;
      setState({ step: 'outcome', outcome, prepared, rechecking: false, checks: 0 });
      settledRef.current?.(outcome, prepared, sentSignature);
    },
    [api, rpc, state],
  );

  const recheck = useCallback(async () => {
    const s = state;
    if (s.step !== 'outcome' || busy.current) return;
    const sig = 'signature' in s.outcome ? s.outcome.signature : '';
    if (!sig) return;
    busy.current = true;
    setState({ ...s, rechecking: true });
    let outcome: TxOutcome;
    try {
      // With the blockhash window, "no record and the window has passed" becomes
      // `expired` (safe to retry) instead of staying unknown. A liquidity transaction
      // also passes its config and kind, so a refusal found now is said in its own
      // words; every other kind is asked exactly as it always was.
      const p = s.prepared;
      outcome = await api.recheckOutcome(
        rpc,
        sig,
        p
          ? p.kind === 'lp-deposit' || p.kind === 'lp-withdraw'
            ? { lastValidBlockHeight: p.lastValidBlockHeight, cfg: p.check.intent.cfg, kind: p.kind }
            : { lastValidBlockHeight: p.lastValidBlockHeight }
          : undefined,
      );
    } catch (e) {
      // A failed re-read changes nothing we know. Keep the prior answer.
      outcome = { status: 'unknown', signature: sig, message: `Could not check just now (${clipDetail(e)}).` };
    }
    busy.current = false;
    setState({ step: 'outcome', outcome, prepared: s.prepared, rechecking: false, checks: (s.checks ?? 0) + 1 });
    settledRef.current?.(outcome, s.prepared, sig);
  }, [api, rpc, state]);

  const reset = useCallback(() => {
    if (busy.current) return;
    setState({ step: 'idle' });
  }, []);

  const locked = state.step === 'outcome' && state.outcome.status === 'unknown' && state.outcome.signature !== '';
  return { state, locked, prepare, confirm, recheck, reset };
}

/**
 * Where focus goes when a flow ends (Cancel, Close, Start over). The flow's own
 * buttons are gone, so without this focus falls to the page body. `target` is the
 * panel's Review button; `fallback` (the card heading) is used when that button is
 * missing or switched off.
 */
export function useReturnFocus(step: TxFlowState['step']) {
  const target = useRef<HTMLButtonElement | null>(null);
  const fallback = useRef<HTMLHeadingElement | null>(null);
  const prev = useRef(step);
  useEffect(() => {
    const was = prev.current;
    prev.current = step;
    if (was === 'idle' || step !== 'idle') return;
    const t = target.current;
    if (t && t.isConnected && !t.disabled) t.focus();
    else fallback.current?.focus();
  }, [step]);
  return { target, fallback };
}
