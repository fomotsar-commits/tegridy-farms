// Resolve a curve launch's creator-published identity (image/description/
// socials) for display. Thin stateful wrapper over the pure resolver in
// lib/launcher/curveIdentity.ts — all validation and spoof-filtering lives
// there, where it is unit-tested without React.
//
// `creator` is the launch's on-chain creator (from getLaunch). Until the
// caller knows it, pass undefined and the hook idles at 'resolving' — never
// query un-anchored, or the owners filter (the spoof defence) would be empty.

import { useEffect, useState } from 'react';
import {
  resolveCurveIdentity,
  type CurveIdentityResolution,
} from '../lib/launcher/curveIdentity';

export function useCurveIdentity(
  token: string | undefined,
  chainId: number,
  creator: string | undefined,
): CurveIdentityResolution {
  const [resolution, setResolution] = useState<CurveIdentityResolution>({ status: 'resolving' });

  useEffect(() => {
    if (!token || !creator) {
      setResolution({ status: 'resolving' });
      return;
    }
    let cancelled = false;
    setResolution({ status: 'resolving' });
    resolveCurveIdentity({ token, chainId, creator }).then((r) => {
      if (!cancelled) setResolution(r);
    });
    return () => {
      cancelled = true;
    };
  }, [token, chainId, creator]);

  return resolution;
}
