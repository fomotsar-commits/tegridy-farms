import { useEffect, useRef, useState } from 'react';
import type { Read } from '../../../lib/solana/clmm/read';
import type { CurveWriteConfig, RangeWriteApi } from '../curve/ports';

/**
 * One chain read for the Range tab. `id` names what is read; `nonce` asks for it again.
 * While a read of the same `id` runs, the last answer stays on screen (`reading` is set);
 * an answer for another `id` is never shown. A throw is an unread, never an empty answer.
 */
export function useChainRead<T>(id: string | null, nonce: number, run: () => Promise<Read<T>>): { read: Read<T> | null; reading: boolean } {
  const [loaded, setLoaded] = useState<{ id: string; nonce: number; read: Read<T> } | null>(null);
  const runRef = useRef(run);
  useEffect(() => {
    runRef.current = run;
  });
  useEffect(() => {
    if (id === null) return;
    let live = true;
    runRef.current().then(
      (read) => live && setLoaded({ id, nonce, read }),
      (e: unknown) => live && setLoaded({ id, nonce, read: { kind: 'unread', detail: e instanceof Error ? e.message : String(e) } }),
    );
    return () => {
      live = false;
    };
  }, [id, nonce]);
  const mine = id !== null && loaded?.id === id ? loaded : null;
  return { read: mine?.read ?? null, reading: id !== null && (mine === null || mine.nonce !== nonce) };
}

export type RangeWrites =
  | { status: 'off' }
  | { status: 'loading' }
  | { status: 'failed'; retry: () => void }
  /** `cfg` null: this build names no write ids, so nothing can be sent from it. */
  | { status: 'ready'; api: RangeWriteApi; cfg: CurveWriteConfig | null };

/** The range write code, fetched only when `enabled` (range pools show and LP's switch is not 'off'). */
export function useRangeWrites(enabled: boolean, load: () => Promise<RangeWriteApi>): RangeWrites {
  // The config is read once, with the code: the same object for the life of the load.
  const [state, setState] = useState<{ attempt: number; api: RangeWriteApi | null; cfg: CurveWriteConfig | null; failed: boolean }>({ attempt: 0, api: null, cfg: null, failed: false });
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!enabled) return;
    let live = true;
    load().then(
      (api) => live && setState({ attempt, api, cfg: api.rangeWriteConfig(), failed: false }),
      () => live && setState({ attempt, api: null, cfg: null, failed: true }),
    );
    return () => {
      live = false;
    };
  }, [enabled, load, attempt]);
  if (!enabled) return { status: 'off' };
  if (state.attempt !== attempt || (!state.api && !state.failed)) return { status: 'loading' };
  if (!state.api) return { status: 'failed', retry: () => setAttempt((n) => n + 1) };
  return { status: 'ready', api: state.api, cfg: state.cfg };
}

/**
 * A range panel's flow, reported to the section: busy from Review until it is back to idle
 * (so no other range form starts meanwhile), and finished when an outcome is closed (the
 * pools and positions are read again).
 */
export function useFlowReports(step: string, locked: boolean, onBusy: (busy: boolean) => void, onFinished: () => void) {
  const busy = step !== 'idle' || locked;
  const report = useRef({ onBusy, onFinished });
  useEffect(() => {
    report.current = { onBusy, onFinished };
  });
  useEffect(() => {
    report.current.onBusy(busy);
  }, [busy]);
  useEffect(() => () => report.current.onBusy(false), []);
  const prev = useRef(step);
  useEffect(() => {
    const was = prev.current;
    prev.current = step;
    if (was === 'outcome' && step === 'idle') report.current.onFinished();
  }, [step]);
}
