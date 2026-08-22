// What the launcher's fee sink has actually been credited on the graduated-pool locker.
//
// Mirrors `useIntegratorFees`'s currency enumeration on purpose: a locker position carries
// TWO currencies, so reading only the base pairs would under-report exactly the way the
// integrator-fee path did before it was fixed. The launch assets come from the same
// `readOurLaunches` scan, and when that scan cannot complete the shortfall is REPORTED
// (`assetsUnavailable`) rather than silently shortening the list.
//
// Read-only by construction. The underlying module offers no release path — see its
// header for why the position id is not derivable in-app — so there is no button here to
// build, and a surface must not imply one exists.

import { useCallback, useEffect, useRef, useState } from 'react';
import { usePublicClient } from 'wagmi';
import type { Address } from 'viem';
import { readFeeLine, type FeeLineRead } from '../lib/launcher/graduation';
import { readOurLaunches } from '../lib/launcher/ourLaunches';
import { allowedNumeraires } from '../lib/launcher/config';
import { CHAIN_ID } from '../lib/constants';

export interface UseGraduationFeeLineResult {
  /** Null until the first read resolves, or when no client is available. */
  read: FeeLineRead | null;
  isLoading: boolean;
  /** Set only when the read threw outright — distinct from a per-currency failure. */
  error: string | null;
  /** True when launch-asset discovery could not complete, so only base pairs were checked. */
  assetsUnavailable: boolean;
  refetch: () => void;
}

export function useGraduationFeeLine(enabled: boolean): UseGraduationFeeLineResult {
  const publicClient = usePublicClient({ chainId: CHAIN_ID });
  const [read, setRead] = useState<FeeLineRead | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [assetsUnavailable, setAssetsUnavailable] = useState(false);
  const [nonce, setNonce] = useState(0);

  const refetch = useCallback(() => setNonce((n) => n + 1), []);

  const runIdRef = useRef(0);

  useEffect(() => {
    if (!enabled || !publicClient) return;
    const runId = ++runIdRef.current;
    const ac = new AbortController();

    void (async () => {
      setIsLoading(true);
      setError(null);
      try {
        // `readOurLaunches` never throws; `complete` is the only real failure signal,
        // and it is false whenever the log scan could not finish.
        const { baselines, complete } = await readOurLaunches({ client: publicClient, signal: ac.signal });
        if (ac.signal.aborted || runIdRef.current !== runId) return;

        const seen = new Set<string>();
        const currencies: Address[] = [];
        for (const c of [...allowedNumeraires(), ...baselines.map((b) => b.token as Address)]) {
          const k = c.toLowerCase();
          if (seen.has(k)) continue;
          seen.add(k);
          currencies.push(c);
        }

        const result = await readFeeLine(publicClient, currencies);
        if (ac.signal.aborted || runIdRef.current !== runId) return;

        setRead(result);
        setAssetsUnavailable(!complete);
      } catch (e) {
        if (ac.signal.aborted || runIdRef.current !== runId) return;
        setError(
          (e as { shortMessage?: string })?.shortMessage ||
            (e as { message?: string })?.message ||
            'Could not read the fee line.',
        );
      } finally {
        if (runIdRef.current === runId) setIsLoading(false);
      }
    })();

    return () => ac.abort();
  }, [enabled, publicClient, nonce]);

  return { read, isLoading, error, assetsUnavailable, refetch };
}
