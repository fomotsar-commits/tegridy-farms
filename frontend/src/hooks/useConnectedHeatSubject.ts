import { useEffect, useState } from 'react';
import { useAccount } from 'wagmi';
import { warmestConnected } from '../lib/heat/connectedHeat';
import type { FillNetwork } from '../lib/heat/walletFill';
import { SOLANA_CONNECT_WAIT_NOTICE_MS, solanaToRestore, useSolanaSurface } from '../lib/solanaSurface';

/**
 * The longest an Ethereum account waits for a saved Solana wallet whose code never reports at all: the
 * last resort only. The wait itself ends when the restore does (below), which on a phone is a second or
 * two; this is for a page where nothing ever answers.
 */
export const SOLANA_RESTORE_LIMIT_MS = 15_000;

// One answer for every card and line on the page. `restoreBy`: the last resort's moment, set when the
// first of them asks; 0 when no Solana wallet was saved to restore, so there is nothing to wait for.
// `connectBy`: set when the saved wallet's connect is first seen. A connect that runs as long as the
// top bar waits on one (a locked wallet's runs for ever, SolanaProviders.tsx) stops holding the account.
let restoreBy: number | null = null;
let connectBy: number | null = null;
function restoreDeadline(connecting: boolean): number {
  restoreBy ??= solanaToRestore() ? Date.now() + SOLANA_RESTORE_LIMIT_MS : 0;
  if (restoreBy !== 0 && connecting) connectBy ??= Date.now() + SOLANA_CONNECT_WAIT_NOTICE_MS;
  return connectBy !== null ? Math.min(restoreBy, connectBy) : restoreBy;
}

/** Tests only: back to a page that has not asked yet. */
export function resetConnectedHeatSubjectForTests(): void {
  restoreBy = null;
  connectBy = null;
}

/**
 * The connected wallet the venue reads heat for, the same answer for the heat card and for Bayla's
 * line (lib/heat/connectedHeat.ts says why they must agree). Null while there is none, and while
 * it is not yet known which:
 *   - one wallet connected: that wallet;
 *   - a Solana wallet and an Ethereum account: both are read, then the warmest (warmestOf);
 *   - an Ethereum account while a Solana wallet saved in this browser is still being restored
 *     (its code loads after the page): nothing yet. The account does not speak alone and get
 *     replaced by an Elder's wallet a moment later. THE WAIT ENDS WHEN THE RESTORE DOES, not on a
 *     clock from the page's start: the Solana connection has reported and is no longer connecting
 *     (SolanaProviders reports "connecting" until its restore has really ended), or its code did
 *     not load (`ownFailed`). A fixed 4 s from the first ask was the first cut, and a slow load
 *     outran it before the wallet's code had even arrived: an Elder read "0° today" and "about
 *     half a year" until the wallet came (WebKit, 2026-11-11 evening). Two bounds stay. A connect
 *     that has itself run SOLANA_CONNECT_WAIT_NOTICE_MS is not ending (a locked wallet's never
 *     does), as the top bar judges it. And SOLANA_RESTORE_LIMIT_MS is the last resort, for a page
 *     where nothing ever reports. Once the account has spoken, a Solana connect opened later by
 *     hand does not silence it.
 * `only`: a page about one network (the heat card's `fillFrom`, a launch door) reads that network's
 * connected wallet and never the other's, at once, as it always has.
 */
export function useConnectedHeatSubject(only?: FillNetwork): string | null {
  const { address: evm } = useAccount();
  const { surface, ownFailed } = useSolanaSurface();
  const sol = surface?.address ?? null;

  // The two bounds: the last resort from the first ask, and the top bar's own wait once a connect is seen.
  const by = restoreDeadline(surface?.connecting === true);
  const [passed, setPassed] = useState<number | null>(null);
  const limitPassed = by === 0 || passed === by;
  useEffect(() => {
    if (by === 0 || passed === by) return;
    const timer = window.setTimeout(() => setPassed(by), Math.max(0, by - Date.now()));
    return () => window.clearTimeout(timer);
  }, [by, passed]);
  // The saved wallet is still on its way while its code has not reported (no connection yet) or it is connecting.
  const restoring = by !== 0 && !ownFailed && (surface === null || surface.connecting);
  // Over for good once the restore has ended or a bound has passed: a later connect by hand is not a restore.
  const [restoreOver, setRestoreOver] = useState(false);
  if (!restoreOver && (!restoring || limitPassed)) setRestoreOver(true);

  const pair = sol && evm ? `${sol}|${evm.toLowerCase()}` : null;
  const [warmest, setWarmest] = useState<{ pair: string; address: string } | null>(null);
  useEffect(() => {
    if (only || !pair || !sol || !evm) return;
    let live = true;
    void warmestConnected([sol, evm]).then((address) => {
      if (live) setWarmest({ pair, address });
    });
    return () => {
      live = false;
    };
  }, [only, pair, sol, evm]);

  if (only === 'ethereum') return evm ?? null;
  if (only === 'solana') return sol;
  if (sol && evm) return warmest !== null && warmest.pair === pair ? warmest.address : null;
  if (sol) return sol;
  return evm && (restoreOver || !restoring || limitPassed) ? evm : null;
}
