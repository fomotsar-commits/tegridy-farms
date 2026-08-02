import { useCallback, useEffect, useState } from 'react';
import {
  detectChain,
  scanTokenLive,
  ScanError,
  type ScanChain,
  type ScanOutcome,
} from '../lib/scanner';

// Drives the public token scanner: given a pasted address it auto-detects the
// chain, fetches real holders through the hardened proxies, runs the shared
// detection core, and exposes a small state machine to the page.
//
// SELF-GATING: every non-success path is explicit and honest. A malformed address
// is `invalid`; a missing ETH holder route is `unavailable` (a deployment gap, not
// a fault of the token); no holders is `empty`. Nothing is ever fabricated to fill
// a gap — the page renders the matching honest state.

export type ScanStatus =
  | 'idle' // no address entered
  | 'invalid' // address is not a valid ETH/Solana format
  | 'loading'
  | 'success'
  | 'empty' // source returned zero holders
  | 'unavailable' // data source for this chain isn't enabled on this deployment
  | 'error'; // network / upstream failure

export interface TokenScanState {
  status: ScanStatus;
  chain: ScanChain | null;
  outcome: ScanOutcome | null;
  errorMessage: string | null;
  /** Re-run the current scan (bypasses nothing — just refetches). */
  reload: () => void;
}

/**
 * PURE: map a thrown scan failure to the state the page renders.
 *
 * This is the hinge the adapters were written against. Both of them route an
 * unreadable payload to `ScanError('network')` SPECIFICALLY because it lands on
 * `error` — "Couldn't complete the scan", a statement about the READ — while
 * `empty`/`not-found` render "No holder data for this token — double-check the
 * address is a token", a claim about somebody's token, and `unavailable` renders
 * deployment copy. Every one of those adapter comments is an assertion about THIS
 * function, so it is exported and pinned: remapping a code here would silently undo
 * the honesty work upstream without breaking anything else.
 */
export function statusForError(err: unknown): { status: ScanStatus; message: string } {
  if (err instanceof ScanError) {
    switch (err.code) {
      case 'invalid-address':
        return { status: 'invalid', message: err.message };
      case 'unavailable':
        return { status: 'unavailable', message: err.message };
      case 'empty':
      case 'not-found':
        return { status: 'empty', message: err.message };
      case 'rate-limited':
        return { status: 'error', message: err.message };
      default:
        return { status: 'error', message: err.message };
    }
  }
  return { status: 'error', message: 'Something went wrong while scanning this token.' };
}

/**
 * @param address  the pasted token address (may be empty / malformed)
 * @param chainOverride  force a chain instead of auto-detecting
 */
export function useTokenScan(address: string, chainOverride?: ScanChain): TokenScanState {
  const trimmed = (address ?? '').trim();
  const detected = detectChain(trimmed);
  const [reloadKey, setReloadKey] = useState(0);
  const reload = useCallback(() => setReloadKey((k) => k + 1), []);

  const [state, setState] = useState<Omit<TokenScanState, 'reload'>>({
    status: 'idle',
    chain: null,
    outcome: null,
    errorMessage: null,
  });

  useEffect(() => {
    if (!trimmed) {
      setState({ status: 'idle', chain: null, outcome: null, errorMessage: null });
      return;
    }
    if (!detected.valid) {
      setState({
        status: 'invalid',
        chain: null,
        outcome: null,
        errorMessage: 'That does not look like an Ethereum (0x…) or Solana address.',
      });
      return;
    }

    const controller = new AbortController();
    let cancelled = false;
    setState({ status: 'loading', chain: chainOverride ?? detected.chain, outcome: null, errorMessage: null });

    scanTokenLive(trimmed, { signal: controller.signal, chainOverride })
      .then((outcome) => {
        if (cancelled) return;
        setState({ status: 'success', chain: outcome.chain, outcome, errorMessage: null });
      })
      .catch((err) => {
        if (cancelled || controller.signal.aborted) return;
        const { status, message } = statusForError(err);
        setState({ status, chain: chainOverride ?? detected.chain, outcome: null, errorMessage: message });
      });

    return () => {
      cancelled = true;
      controller.abort();
    };
    // detected.chain/valid are derived purely from `trimmed`, so `trimmed` covers them.
  }, [trimmed, chainOverride, reloadKey, detected.chain, detected.valid]);

  return { ...state, reload };
}
