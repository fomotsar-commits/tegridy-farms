// The network boundary of the fiat on-ramp handoff, browser side.
//
// Fail-closed, in the same shape as heatClient.ts: every failure path resolves to an
// explicit `unavailable`, never to a URL. "We could not prepare a handoff" and "there is
// no on-ramp here" are different facts and must not collapse into each other, because the
// first is temporary and the second is a configuration statement about the venue.
//
// Nothing here opens a window. The hook prepares a destination and the user clicks it — a
// programmatic navigation to a payment page is exactly the surprise this product must not
// spring, and popup blockers punish it anyway.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ConfiguredOnrampProvider } from '../lib/onramp/config';
import {
  buildOnrampUrl,
  isPermittedOnrampUrl,
  isValidOnrampAddress,
  requiresSignature,
  type OnrampChain,
} from '../lib/onramp/widgetUrl';

/**
 * Hard ceiling on the signing round-trip.
 *
 * Shorter than the heat client's 6s because there is a human waiting on a button they
 * just pressed. A signer that needs longer than this is down as far as the user is
 * concerned, and saying so beats a spinner that never resolves.
 */
const SIGN_TIMEOUT_MS = 8000;

export type OnrampSessionState =
  /** No address to send to yet. Not an error — the funnel simply has a step left. */
  | { kind: 'needs-address' }
  /** The address is not valid for the selected chain, so no handoff can be built. */
  | { kind: 'invalid-address' }
  /** Everything is in place; this provider signs, so a round-trip has to happen first. */
  | { kind: 'needs-preparation' }
  /** Ready to hand off. `url` is on the provider's own origin, verified. */
  | { kind: 'ready'; url: string }
  /** A signing round-trip is in flight. */
  | { kind: 'preparing' }
  /** Configured, but the handoff could not be prepared right now. Never a silent zero. */
  | { kind: 'unavailable'; reason: string };

export interface UseOnrampSessionArgs {
  /** Null when no provider is configured — the hook then never claims readiness. */
  provider: ConfiguredOnrampProvider | null;
  chain: OnrampChain;
  /** The connected wallet's receiving address, or undefined when none is connected. */
  walletAddress: string | undefined;
}

export interface UseOnrampSession {
  state: OnrampSessionState;
  /**
   * Ask for a handoff URL. Idempotent to click-spam: an in-flight preparation is not
   * restarted. Only needed for providers that sign; unsigned providers are `ready`
   * without it.
   */
  prepare: () => void;
}

interface SignResponse {
  url?: unknown;
}

/**
 * Resolve the URL a user may be sent to, honestly.
 *
 * Unsigned providers (Transak) reach `ready` synchronously from pure construction —
 * there is nothing to ask anybody. Signed providers (MoonPay) start at `preparing` only
 * once `prepare()` is called, so opening the page does not fire a request at a partner
 * for a user who never intended to buy anything.
 */
/**
 * Identity of one handoff's inputs.
 *
 * A signed URL is only valid for the exact provider, chain and address it was signed for,
 * so the outcome is stored WITH this key and read back only on a match. That is what makes
 * a stale answer unrenderable rather than merely unlikely: switching provider mid-flight
 * cannot leave the previous partner's link on screen, and no effect is needed to clear it.
 */
function sessionKey(
  provider: ConfiguredOnrampProvider | null,
  chain: OnrampChain,
  walletAddress: string | undefined,
): string {
  return provider ? `${provider.id}|${chain}|${walletAddress ?? ''}` : '';
}

export function useOnrampSession({ provider, chain, walletAddress }: UseOnrampSessionArgs): UseOnrampSession {
  const [outcome, setOutcome] = useState<{ key: string; state: OnrampSessionState } | null>(null);
  const inFlight = useRef<AbortController | null>(null);
  const key = sessionKey(provider, chain, walletAddress);

  /** What the inputs alone say, with nothing asked of anybody. */
  const base = useMemo<OnrampSessionState>(() => {
    if (!provider || !walletAddress) return { kind: 'needs-address' };
    if (!isValidOnrampAddress(walletAddress, chain)) return { kind: 'invalid-address' };
    const url = buildOnrampUrl({ provider, chain, walletAddress });
    if (!url) return { kind: 'invalid-address' };
    // Deliberately NOT `ready` for a signing partner: the unsigned URL is an input to the
    // signer, and MoonPay rejects it in live mode. Handing it to a user is a broken widget.
    if (requiresSignature(provider)) return { kind: 'needs-preparation' };
    return { kind: 'ready', url };
  }, [provider, chain, walletAddress]);

  const state = outcome && outcome.key === key ? outcome.state : base;

  // Abandon a signing request whose inputs changed out from under it. Cleanup only — the
  // answer it would have produced is already unreachable via the key check above.
  useEffect(() => () => {
    inFlight.current?.abort();
    inFlight.current = null;
  }, [key]);

  const prepare = useCallback(() => {
    if (!provider || !walletAddress) return;
    if (!requiresSignature(provider)) return;
    if (inFlight.current) return;

    const settle = (next: OnrampSessionState) => setOutcome({ key: sessionKey(provider, chain, walletAddress), state: next });

    const unsigned = buildOnrampUrl({ provider, chain, walletAddress });
    if (!unsigned) {
      settle({ kind: 'invalid-address' });
      return;
    }
    // Narrow to the signed variant so the same-origin path is not an optional field.
    const signUrl = provider.id === 'moonpay' ? provider.signUrl : null;
    if (!signUrl) {
      settle({ kind: 'unavailable', reason: 'No signing endpoint is configured for this provider.' });
      return;
    }

    const ac = new AbortController();
    inFlight.current = ac;
    settle({ kind: 'preparing' });
    const timer = setTimeout(() => ac.abort(), SIGN_TIMEOUT_MS);

    void (async () => {
      try {
        const res = await fetch(signUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          // The unsigned URL carries the wallet address and the asset, and nothing else —
          // see widgetUrl.ts. This body must never grow a personal-data field.
          body: JSON.stringify({ url: unsigned }),
          signal: ac.signal,
        });
        if (!res.ok) {
          settle({ kind: 'unavailable', reason: 'The card-purchase service did not answer. Nothing was charged.' });
          return;
        }
        const body = (await res.json()) as SignResponse;
        const signed = typeof body.url === 'string' ? body.url : '';
        // The signer may append a signature; it may not choose a destination.
        if (!signed || !isPermittedOnrampUrl(signed, provider)) {
          settle({ kind: 'unavailable', reason: 'The card-purchase service returned an unexpected destination, so it was not opened.' });
          return;
        }
        settle({ kind: 'ready', url: signed });
      } catch {
        // AbortError included: a timeout is an outage, and an outage is never a handoff.
        settle({ kind: 'unavailable', reason: 'The card-purchase service could not be reached. Nothing was charged.' });
      } finally {
        clearTimeout(timer);
        if (inFlight.current === ac) inFlight.current = null;
      }
    })();
  }, [provider, chain, walletAddress]);

  return { state, prepare };
}
