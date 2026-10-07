import { useCallback, useEffect, useMemo, useState } from 'react';
import { clipDetail } from '../../../lib/launcher/solana/curve';
import { isCurveWriteEnabled } from '../../../lib/launcher/solana/curveWriteFlag';
import { lpWriteMode } from '../../../lib/launcher/solana/lpWriteFlag';
import { loadWriteApi } from './writeApi';
import type { CurveWriteConfig, GateRpc, LpGate, WriteApi, WriteGate } from './ports';

/**
 * Where a write path stands for this page view. One body for every write path, so the
 * rule "a gate read that throws closes, never opens" lives in exactly one place.
 * `disabled`: the flag is off, and the write code was never fetched. `load-failed`: the
 * write code did not arrive, which says nothing about the program. `ready`: `gate` says
 * what may be offered, and `cfg` is the configured program pair (null when none is usable).
 */
export type LoadedGateState<A, C, G> =
  | { status: 'disabled' }
  | { status: 'loading' }
  | { status: 'load-failed'; detail: string }
  | { status: 'ready'; api: A; cfg: C | null; gate: G };

export interface LoadedGateOptions<A, C, G> {
  enabled: boolean;
  load: () => Promise<A>;
  /** Pass a stable function (module-level or memoized): a new one re-reads the gate. */
  config(api: A): C | null;
  /** Pass a stable function (memoized on its own inputs): a new one re-reads the gate. */
  read(api: A, cfg: C | null): Promise<G>;
  /** The gate for a read that threw. It must be closed. */
  blocked(detail: string): G;
  /**
   * True only for a gate that says its read failed. Given, such a gate, and write code
   * that did not load, are asked for again every GATE_RETRY_MS. A gate that was read
   * and is closed is an answer: return false for it, and it is never asked again.
   */
  unread?(gate: G): boolean;
}

/** A gate that could not be read, or write code that did not load, is asked for again this often. */
export const GATE_RETRY_MS = 15_000;

export function useLoadedGate<A, C, G>(o: LoadedGateOptions<A, C, G>): LoadedGateState<A, C, G> & { refresh(): void } {
  const { enabled, load, config, read, blocked, unread } = o;
  const [state, setState] = useState<LoadedGateState<A, C, G>>(enabled ? { status: 'loading' } : { status: 'disabled' });
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    // Off is the initial state, and the flag is fixed for the life of a build.
    if (!enabled) return;
    let live = true;
    // What is on screen stays while it is asked for again, a failed answer included.
    // Only an `enabled` that came on after mount goes from off to "loading" here.
    setState((s) => (s.status === 'disabled' ? { status: 'loading' } : s));
    (async () => {
      let api: A;
      try {
        api = await load();
      } catch (e) {
        if (live) setState({ status: 'load-failed', detail: clipDetail(e) });
        return;
      }
      let cfg: C | null;
      let gate: G;
      try {
        cfg = config(api);
        gate = await read(api, cfg);
      } catch (e) {
        // The gate reader is written not to throw. If it does anyway, that is a
        // failure to read, and it must close the gate, never open it.
        cfg = null;
        gate = blocked(clipDetail(e));
      }
      if (live) setState({ status: 'ready', api, cfg, gate });
    })();
    return () => {
      live = false;
    };
  }, [enabled, load, config, read, blocked, nonce]);

  const refresh = useCallback(() => setNonce((n) => n + 1), []);

  // A failed read is not this page view's answer: without this, one bad moment at page
  // load leaves the page read-only until someone reloads it. `state` is a dependency
  // because each answer is a new object, so one that failed again arms the next try, a
  // whole period after it landed. The try only reads, and a read that throws still closes.
  const again = !!unread && (state.status === 'load-failed' || (state.status === 'ready' && unread(state.gate)));
  useEffect(() => {
    if (!again) return;
    const t = setTimeout(refresh, GATE_RETRY_MS);
    return () => clearTimeout(t);
  }, [again, refresh, state]);

  // Stable identity until the state changes, so callers can key effects on it.
  return useMemo(() => ({ ...state, refresh }), [state, refresh]);
}

// ── the launch page's write path ─────────────────────────────────────────────

export type WriteGateState = LoadedGateState<WriteApi, CurveWriteConfig, WriteGate>;

export interface UseWriteGateOptions {
  /** Defaults to the build flag. Tests pass it. */
  enabled?: boolean;
  /** Defaults to the dynamic import. Tests pass a fake. */
  load?: () => Promise<WriteApi>;
}

const unreadable = (detail: string) => ({ kind: 'blocked' as const, reason: 'unreadable' as const, detail });
/** Only "the read failed" is asked again. Every other closed gate was read, and stands. */
const isUnread = (gate: WriteGate | LpGate) => gate.kind === 'blocked' && gate.reason === 'unreadable';
const curveConfig = (api: WriteApi) => api.curveWriteConfig();

export function useWriteGate(gateRpc: GateRpc, opts: UseWriteGateOptions = {}): WriteGateState & { refresh: () => void } {
  const read = useCallback((api: WriteApi, cfg: CurveWriteConfig | null) => api.readWriteGate(gateRpc, cfg), [gateRpc]);
  return useLoadedGate<WriteApi, CurveWriteConfig, WriteGate>({ enabled: opts.enabled ?? isCurveWriteEnabled(), load: opts.load ?? loadWriteApi, config: curveConfig, read, blocked: unreadable, unread: isUnread });
}

// ── the pools page's liquidity path ──────────────────────────────────────────

/** What the liquidity gate needs from its write layer. The full LP API extends it. */
export interface LpGateApi {
  lpWriteConfig(): CurveWriteConfig | null;
  readLpGate(rpc: GateRpc, cfg: CurveWriteConfig | null): Promise<LpGate>;
}

export interface UseLpGateOptions<A extends LpGateApi> {
  /** Defaults to LP's own switch: anything but 'off'. Tests pass it. */
  enabled?: boolean;
  /** The liquidity write layer's loader. */
  load: () => Promise<A>;
}

const lpConfig = (api: LpGateApi) => api.lpWriteConfig();

/**
 * The liquidity gate. It reads only the cluster and the pool program (write/config.ts
 * `readLpGate`): nothing about the launch program can close it.
 */
export function useLpGate<A extends LpGateApi>(gateRpc: GateRpc, opts: UseLpGateOptions<A>): LoadedGateState<A, CurveWriteConfig, LpGate> & { refresh: () => void } {
  const read = useCallback((api: A, cfg: CurveWriteConfig | null) => api.readLpGate(gateRpc, cfg), [gateRpc]);
  return useLoadedGate<A, CurveWriteConfig, LpGate>({ enabled: opts.enabled ?? lpWriteMode() !== 'off', load: opts.load, config: lpConfig, read, blocked: unreadable, unread: isUnread });
}
