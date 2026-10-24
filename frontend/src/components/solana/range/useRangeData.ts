import { useEffect, useRef, useState } from 'react';
import type { Read } from '../../../lib/solana/clmm/read';
import { marketGap, type MarketGap } from '../../../lib/solana/clmm/priceCheck';
import type { Pair } from '../../../lib/solana/clmm/rangeMath';
import type { OutsidePrice } from '../../../lib/solana/lp/outsidePrice';
import { optionalReadAllowed } from '../../../lib/solana/lp/rpcBudget';
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

/**
 * The market's price beside this pool's own, read once when a pool is picked (Review asks
 * again, fresh). Kept with the pool and price it was read for, so a stale answer is never
 * shown for another. Card 03 draws it and card 04 says it.
 */
export function useMarketGap(
  ask: (mint: string, decimals: number) => Promise<OutsidePrice>,
  pair: Pair | null,
  pool: { address: string; sqrtPriceX64: bigint } | null,
): MarketGap | null {
  const [read, setRead] = useState<{ key: string; gap: MarketGap } | null>(null);
  const key = pool ? `${pool.address}:${pool.sqrtPriceX64}` : null;
  const askRef = useRef(ask);
  useEffect(() => {
    askRef.current = ask;
  });
  const sqrt = pool?.sqrtPriceX64 ?? null;
  useEffect(() => {
    if (!pair || key === null || sqrt === null) return;
    let live = true;
    const one = (mint: string, decimals: number) =>
      askRef.current(mint, decimals).catch((e: unknown): OutsidePrice => ({ kind: 'unread', detail: e instanceof Error ? e.message : String(e) }));
    void Promise.all([one(pair.tokenMint, pair.tokenDecimals), pair.quote.native ? Promise.resolve(null) : one(pair.quote.mint, pair.quote.decimals)]).then(([token, coin]) => {
      if (live) setRead({ key, gap: marketGap(pair, sqrt, token, coin) });
    });
    return () => {
      live = false;
    };
  }, [pair, key, sqrt]);
  return read && read.key === key ? read.gap : null;
}

/**
 * A count that goes up every `ms` while the page is in view and the chain budget allows an
 * optional read: a card's refresh, never its first read. Hidden tabs and busy budgets skip.
 */
export function usePoll(ms: number, enabled: boolean): number {
  const [n, setN] = useState(0);
  useEffect(() => {
    if (!enabled) return;
    const id = setInterval(() => {
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
      if (!optionalReadAllowed()) return;
      setN((x) => x + 1);
    }, ms);
    return () => clearInterval(id);
  }, [ms, enabled]);
  return n;
}
