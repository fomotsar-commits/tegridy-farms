import { useEffect, useState } from 'react';
import type { ApiTier, ApiRoute, ApiRoadmapEntry } from '../../../api/_lib/apiTiers';

export type PlatformFlag = 'configured' | 'not_configured';

export interface ApiPlatformStatus {
  platform: {
    keyVerification: PlatformFlag;
    keyIssuance: PlatformFlag;
    metering: PlatformFlag;
    billing: PlatformFlag;
  };
  pricingState: 'proposed' | 'published';
  billingEnabled: boolean;
  tiers: ApiTier[];
  routes: ApiRoute[];
  roadmap: ApiRoadmapEntry[];
}

/**
 * Three states, and 'unreachable' is NOT a fourth spelling of 'not_configured'.
 *
 * A docs page that renders "issuance unavailable" after a failed fetch is making a
 * claim about the deployment it did not read. The panel says it could not find out,
 * which is the only true thing available, and offers no button either way.
 */
export type ApiStatusState =
  | { phase: 'loading' }
  | { phase: 'ready'; data: ApiPlatformStatus }
  | { phase: 'unreachable'; reason: string };

export function useApiPlatformStatus(): ApiStatusState {
  const [state, setState] = useState<ApiStatusState>({ phase: 'loading' });

  useEffect(() => {
    const ac = new AbortController();
    (async () => {
      try {
        const res = await fetch('/api/v1?route=status', {
          headers: { accept: 'application/json' },
          signal: ac.signal,
        });
        if (!res.ok) {
          setState({ phase: 'unreachable', reason: `status endpoint returned ${res.status}` });
          return;
        }
        const json = (await res.json()) as ApiPlatformStatus;
        // A body that does not carry the field we are about to render is a failed
        // read, not a deployment with nothing configured. Same rule as the scan
        // route: a shape we cannot parse is silence.
        if (!json || typeof json !== 'object' || !json.platform) {
          setState({ phase: 'unreachable', reason: 'status endpoint returned an unrecognised body' });
          return;
        }
        setState({ phase: 'ready', data: json });
      } catch (err) {
        if (ac.signal.aborted) return;
        setState({ phase: 'unreachable', reason: err instanceof Error ? err.message : 'network error' });
      }
    })();
    return () => ac.abort();
  }, []);

  return state;
}
