import { useCallback, useEffect, useMemo, useState } from 'react';
import { clipDetail } from '../../../lib/launcher/solana/curve';
import { isCurveWriteEnabled } from '../../../lib/launcher/solana/curveWriteFlag';
import { loadWriteApi } from './writeApi';
import type { CurveWriteConfig, GateRpc, WriteApi, WriteGate } from './ports';

/**
 * Where the write path stands for this page view.
 *
 *  - `disabled`: the flag is off. The write code was never fetched, and the page
 *    renders exactly what it rendered before any of this existed.
 *  - `loading`: fetching the write code, or reading the chain for the gate.
 *  - `load-failed`: the write code did not arrive. A statement about our download,
 *    not about the program; the page stays read-only.
 *  - `ready`: `gate` says whether anything may be offered. `cfg` is the configured
 *    program pair (null when the write layer found no usable config), so reads can
 *    use the same ids the writes would.
 */
export type WriteGateState =
  | { status: 'disabled' }
  | { status: 'loading' }
  | { status: 'load-failed'; detail: string }
  | { status: 'ready'; api: WriteApi; cfg: CurveWriteConfig | null; gate: WriteGate };

export interface UseWriteGateOptions {
  /** Defaults to the build flag. Tests pass it. */
  enabled?: boolean;
  /** Defaults to the dynamic import. Tests pass a fake. */
  load?: () => Promise<WriteApi>;
}

export function useWriteGate(
  gateRpc: GateRpc,
  opts: UseWriteGateOptions = {},
): WriteGateState & { refresh: () => void } {
  const enabled = opts.enabled ?? isCurveWriteEnabled();
  const load = opts.load ?? loadWriteApi;
  const [state, setState] = useState<WriteGateState>(enabled ? { status: 'loading' } : { status: 'disabled' });
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    // Off is the initial state, and the flag is fixed for the life of a build.
    if (!enabled) return;
    let live = true;
    setState((s) => (s.status === 'ready' ? s : { status: 'loading' }));
    (async () => {
      let api: WriteApi;
      try {
        api = await load();
      } catch (e) {
        if (live) setState({ status: 'load-failed', detail: clipDetail(e) });
        return;
      }
      let cfg: CurveWriteConfig | null;
      let gate: WriteGate;
      try {
        cfg = api.curveWriteConfig();
        gate = await api.readWriteGate(gateRpc, cfg);
      } catch (e) {
        // The gate reader is written not to throw. If it does anyway, that is a
        // failure to read, and it must close the gate, never open it.
        cfg = null;
        gate = { kind: 'blocked', reason: 'unreadable', detail: clipDetail(e) };
      }
      if (live) setState({ status: 'ready', api, cfg, gate });
    })();
    return () => {
      live = false;
    };
  }, [enabled, load, gateRpc, nonce]);

  const refresh = useCallback(() => setNonce((n) => n + 1), []);
  // Stable identity until the state changes, so callers can key effects on it.
  return useMemo(() => ({ ...state, refresh }), [state, refresh]);
}
