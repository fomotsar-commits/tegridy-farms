// React binding for lib/referrals/attribution.ts.
//
// Runs the capture on mount for WHATEVER route the app was entered on, not just
// the landing page. The pre-existing capture lives inside HomePage.tsx, so a
// link shared as `/swap?ref=0x…` — which every "buy this token" share produces —
// captured nothing at all. Same key, same first-touch rule, so the two cannot
// disagree; this one just runs everywhere.
//
// The `?r=<code>` path is asynchronous (the code has to be resolved by the code
// store) and is therefore reported as its own state. A code that cannot be
// resolved leaves attribution untouched and surfaces `codeStatus`, because a
// visitor who followed somebody's short link and silently arrived unattributed
// is the failure this whole slice is built around.

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  captureFromUrl,
  applyResolvedCode,
  clearAttribution,
  readAttribution,
  type Attribution,
  type CaptureOutcome,
} from '../lib/referrals/attribution';
import { resolveCode, type CodeStoreStatus } from '../lib/referrals/codesClient';

export type CodeResolutionState =
  /** No `?r=` in the URL. */
  | { phase: 'none' }
  | { phase: 'resolving'; code: string }
  /** Resolved and applied under the first-touch rule. */
  | { phase: 'resolved'; code: string; outcome: CaptureOutcome }
  /**
   * The store answered and the code does not exist, OR we could not ask.
   * `status` distinguishes them and `detail` is renderable copy for either.
   */
  | { phase: 'failed'; code: string; status: CodeStoreStatus; detail: string };

export interface ReferralAttributionState {
  /** Current stored attribution, or null. Survives reload — it is localStorage. */
  attribution: Attribution | null;
  /** What the mount-time capture did. `none` on a normal navigation. */
  lastOutcome: CaptureOutcome;
  /** Progress of a `?r=<code>` link, when there was one. */
  codeResolution: CodeResolutionState;
  /** Forget the attribution. User-initiated only — see attribution.ts. */
  forget: () => void;
}

export interface UseReferralAttributionOptions {
  /** Injection seam for tests; production reads `window.location`. */
  location?: { search: string; pathname: string };
  fetchImpl?: typeof fetch;
  /** False skips capture entirely (e.g. a route that must not attribute). */
  enabled?: boolean;
}

export function useReferralAttribution(
  opts: UseReferralAttributionOptions = {},
): ReferralAttributionState {
  const { enabled = true } = opts;
  const [attribution, setAttribution] = useState<Attribution | null>(null);
  const [lastOutcome, setLastOutcome] = useState<CaptureOutcome>({ kind: 'none' });
  const [codeResolution, setCodeResolution] = useState<CodeResolutionState>({ phase: 'none' });

  // Capture is a WRITE and must happen exactly once per mount. React 18 StrictMode
  // double-invokes effects in development; a second run would append the same
  // link to `ignored` twice and show the user a conflict they never had.
  const captured = useRef(false);
  const fetchImpl = opts.fetchImpl;
  const locationOverride = opts.location;

  useEffect(() => {
    if (!enabled || captured.current) return;
    captured.current = true;

    let search = '';
    let pathname: string | null = null;
    if (locationOverride) {
      search = locationOverride.search;
      pathname = locationOverride.pathname;
    } else {
      try {
        search = window.location.search;
        pathname = window.location.pathname;
      } catch {
        // No window (SSR / test env without jsdom). Nothing to capture, and the
        // stored attribution read below is equally unavailable.
        setAttribution(null);
        return;
      }
    }

    const outcome = captureFromUrl({ search, path: pathname });
    setLastOutcome(outcome);
    setAttribution(readAttribution());

    if (outcome.kind !== 'code-pending') return;

    const code = outcome.code;
    setCodeResolution({ phase: 'resolving', code });
    const ac = new AbortController();
    void (async () => {
      const result = await resolveCode(code, { signal: ac.signal, fetchImpl });
      if (ac.signal.aborted) return;
      if (result.status === 'ready' && result.address) {
        const applied = applyResolvedCode(result.address, { path: pathname });
        setCodeResolution({ phase: 'resolved', code, outcome: applied });
        setLastOutcome(applied);
        setAttribution(readAttribution());
        return;
      }
      setCodeResolution({
        phase: 'failed',
        code,
        status: result.status,
        detail:
          result.detail ??
          'That referral code could not be resolved, so no referrer was recorded for this visit.',
      });
    })();
    return () => ac.abort();
  }, [enabled, locationOverride, fetchImpl]);

  const forget = useCallback(() => {
    clearAttribution();
    setAttribution(null);
    setLastOutcome({ kind: 'none' });
    setCodeResolution({ phase: 'none' });
  }, []);

  return { attribution, lastOutcome, codeResolution, forget };
}
