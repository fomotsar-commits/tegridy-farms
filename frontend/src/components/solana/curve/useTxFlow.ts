import { useCallback, useEffect, useRef, useState } from 'react';
import { clipDetail } from '../../../lib/launcher/solana/curve';
import type { Prepared, PreparedTx, TxOutcome, TxSigner, WriteApi, WriteRpc } from './ports';

/**
 * One transaction, start to finish, for any of the seven kinds.
 *
 *   idle → preparing → review → submitting → outcome
 *                  ↘ outcome (not-sent: nothing was signed)
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
 *    that too is `unknown`, with no signature, and never "failed".
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
  | { step: 'review'; prepared: PreparedTx; expired: boolean; expiresAt: number }
  | { step: 'submitting'; prepared: PreparedTx }
  | { step: 'outcome'; outcome: TxOutcome; prepared: PreparedTx | null; rechecking: boolean };

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
  onSettled?: (outcome: TxOutcome, prepared: PreparedTx | null) => void,
): TxFlow {
  const [state, setState] = useState<TxFlowState>({ step: 'idle' });
  const busy = useRef(false);
  const settledRef = useRef(onSettled);
  useEffect(() => {
    settledRef.current = onSettled;
  }, [onSettled]);

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
      const height = await confirmedHeight(rpc);
      if (height !== null && height + SIGN_MARGIN_BLOCKS >= prepared.lastValidBlockHeight) {
        busy.current = false;
        setState((cur) => (cur.step === 'review' && cur.prepared === prepared ? { ...cur, expired: true } : cur));
        return;
      }
      setState({ step: 'submitting', prepared });
      let outcome: TxOutcome;
      try {
        outcome = await api.submitPrepared(rpc, signer, prepared);
      } catch (e) {
        outcome = {
          status: 'unknown',
          signature: '',
          message: `We lost track of this transaction (${clipDetail(e)}). Check your wallet's activity before trying again.`,
        };
      }
      busy.current = false;
      setState({ step: 'outcome', outcome, prepared, rechecking: false });
      settledRef.current?.(outcome, prepared);
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
      // `expired` (safe to retry) instead of staying unknown.
      outcome = await api.recheckOutcome(
        rpc,
        sig,
        s.prepared ? { lastValidBlockHeight: s.prepared.lastValidBlockHeight } : undefined,
      );
    } catch (e) {
      // A failed re-read changes nothing we know. Keep the prior answer.
      outcome = { status: 'unknown', signature: sig, message: `Could not check just now (${clipDetail(e)}).` };
    }
    busy.current = false;
    setState({ step: 'outcome', outcome, prepared: s.prepared, rechecking: false });
    settledRef.current?.(outcome, s.prepared);
  }, [api, rpc, state]);

  const reset = useCallback(() => {
    if (busy.current) return;
    setState({ step: 'idle' });
  }, []);

  const locked = state.step === 'outcome' && state.outcome.status === 'unknown' && state.outcome.signature !== '';
  return { state, locked, prepare, confirm, recheck, reset };
}
