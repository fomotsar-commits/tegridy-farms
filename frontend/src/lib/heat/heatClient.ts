// Network boundary for the Heat oracle, browser side.
//
// Goes through OUR proxy (`/api/aggregator?resource=heat`), never the upstream
// directly — memetics.wtf answers with `Access-Control-Allow-Origin:
// https://junglebayisland.lat`, so a direct browser fetch is CORS-blocked and no
// client-side workaround exists. See api/_lib/heat.js.
//
// Fail-closed: every failure path returns an ERROR, never a zero-degree reading.
// "We could not ask" and "you are cold" are different facts and must never collapse
// into each other.

import { heatEnvelopeFailure, parseHeatReading, type HeatReading } from './heatOracle';

/** Matches the proxy's own validation, so an obviously-bad address never leaves the browser. */
const ETH_ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/;
const SOLANA_ADDRESS_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

export function isSupportedHeatAddress(address: string): boolean {
  const a = address.trim();
  return ETH_ADDRESS_RE.test(a) || SOLANA_ADDRESS_RE.test(a);
}

export class HeatUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HeatUnavailableError';
  }
}

/** Hard ceiling per the spec's "hard timeout (<=6s)". */
const CLIENT_TIMEOUT_MS = 8000;

export async function fetchHeat(address: string, opts: { signal?: AbortSignal } = {}): Promise<HeatReading> {
  if (!isSupportedHeatAddress(address)) {
    throw new HeatUnavailableError('That is not an Ethereum or Solana address.');
  }

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), CLIENT_TIMEOUT_MS);
  const onAbort = () => ac.abort();
  opts.signal?.addEventListener('abort', onAbort);

  let res: Response;
  try {
    res = await fetch(`/api/aggregator?resource=heat&address=${encodeURIComponent(address.trim())}`, {
      headers: { Accept: 'application/json' },
      signal: ac.signal,
    });
  } catch {
    // Network error or timeout. The instrument is unreachable — say so; do not guess.
    throw new HeatUnavailableError('The instrument is unreachable. Try again in a moment.');
  } finally {
    clearTimeout(timer);
    opts.signal?.removeEventListener('abort', onAbort);
  }

  if (res.status === 400) throw new HeatUnavailableError('That is not an Ethereum or Solana address.');
  if (res.status === 429) throw new HeatUnavailableError('Too many readings requested. Try again shortly.');
  if (!res.ok) throw new HeatUnavailableError('The instrument is unreachable. Try again in a moment.');

  let payload: unknown;
  try {
    payload = await res.json();
  } catch {
    throw new HeatUnavailableError('The instrument returned something unreadable.');
  }

  // A 200 with a malformed body is an OUTAGE, not a low score.
  const failure = heatEnvelopeFailure(payload);
  if (failure) throw new HeatUnavailableError(failure);

  return parseHeatReading(payload);
}
