// Typed client for the launcher-outcomes serverless adapter.
//
// The heavy lifting (GeckoTerminal market reads + Etherscan chain stats, with
// the Etherscan key kept SERVER-SIDE) lives behind the aggregator catchall at
// `/api/aggregator?resource=launcher-outcomes` (see api/_lib/launcher-outcomes.js).
// This helper is the thin, typed front door the LaunchExplorer / LaunchPage
// calls to get real { launches, outcomes } data for a CONSUMED launch list.
//
// Launch DISCOVERY is out of scope: the caller supplies the LaunchBaseline[]
// (from GeckoTerminal `new_pools` or an indexer). This client only enriches it.
//
// Degradation contract: a network/HTTP failure THROWS (so the caller can decide
// whether to render a stale/empty state) but a malformed-but-200 body is coerced
// into the typed shape rather than trusted blindly — the UI never receives an
// object missing `launches`/`outcomes`.

import type { Address } from 'viem';
import type { LaunchBaseline } from './outcomesReader';
import type { OutcomeRecord } from './outcomes';
import type { LaunchSummary } from './ordering';

/** The shape returned by the launcher-outcomes resource. */
export interface LauncherOutcomesResponse {
  /** Ordering input, one per observed launch (outage-hit launches omitted). */
  launches: LaunchSummary[];
  /** Point-in-time trajectory record per launch, keyed by lowercased token address. */
  outcomes: Record<Address, OutcomeRecord>;
}

export interface FetchLauncherOutcomesOptions {
  /** The consumed launch list to enrich (from discovery — not fetched here). */
  baselines: readonly LaunchBaseline[];
  /**
   * Optional token→pool address map. GeckoTerminal `new_pools` discovery already
   * yields the pool address; passing it here skips a token→pool resolution hop
   * server-side. Keys and values are 0x addresses.
   */
  poolByToken?: Record<string, string>;
  /** Abort signal for cancellation (e.g. component unmount). */
  signal?: AbortSignal;
  /** Override the endpoint (tests / preview). Defaults to the catchall route. */
  endpoint?: string;
  /** Injectable fetch for tests. Defaults to global fetch. */
  fetchImpl?: typeof fetch;
}

/** The catchall resource route. Same-origin; the Etherscan key stays server-side. */
export const LAUNCHER_OUTCOMES_ENDPOINT = '/api/aggregator?resource=launcher-outcomes';

/** Coerce an unknown JSON body into the typed response, never trusting shape. */
function coerceResponse(raw: unknown): LauncherOutcomesResponse {
  const obj = (raw ?? {}) as Partial<LauncherOutcomesResponse>;
  const launches = Array.isArray(obj.launches) ? (obj.launches as LaunchSummary[]) : [];
  const outcomes =
    obj.outcomes && typeof obj.outcomes === 'object' && !Array.isArray(obj.outcomes)
      ? (obj.outcomes as Record<Address, OutcomeRecord>)
      : {};
  return { launches, outcomes };
}

/**
 * Fetch real launcher outcomes for a consumed launch list. Throws on network or
 * non-2xx HTTP failure; returns a well-formed (possibly empty) typed shape on
 * success. Callers should try/catch and fall back to a "data unavailable" state.
 */
export async function fetchLauncherOutcomes(
  opts: FetchLauncherOutcomesOptions,
): Promise<LauncherOutcomesResponse> {
  const {
    baselines,
    poolByToken,
    signal,
    endpoint = LAUNCHER_OUTCOMES_ENDPOINT,
    fetchImpl = fetch,
  } = opts;

  const res = await fetchImpl(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      baselines,
      ...(poolByToken ? { poolByToken } : {}),
    }),
    signal,
  });

  if (!res.ok) {
    throw new Error(`launcher-outcomes request failed: ${res.status}`);
  }

  const json: unknown = await res.json();
  return coerceResponse(json);
}

/** Test-only export of the internal shape-coercion (kept out of the public surface). */
export const coerceResponseForTest = coerceResponse;
