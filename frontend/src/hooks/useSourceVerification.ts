import { useQuery, useQueryClient } from '@tanstack/react-query';
import { safeSetItem, safeGetItem, safeJsonParse } from '../lib/storage';

/**
 * Live per-contract Etherscan source-verification status.
 *
 * THREE states, deliberately — this feature exists to be trustworthy, so it must
 * never guess in either direction:
 *   'verified'   — Etherscan returned a real ContractName + SourceCode.
 *   'unverified' — Etherscan answered cleanly and the source is genuinely absent.
 *   'unchecked'  — we could not find out (network error, rate limit, bad JSON,
 *                  still loading). Renders as "not checked", NEVER as a verdict.
 *
 * A rate-limited request must not be able to render "unverified" against our own
 * deployed contracts, and a failure must never optimistically render "verified".
 * 'unchecked' is both the initial AND the terminal state for every failure path.
 *
 * Rate limits: Etherscan's free tier is ~5 req/s and the Contracts page lists 21
 * non-zero addresses, so requests are issued SEQUENTIALLY with 250ms spacing
 * (~4 req/s) and a 429 aborts the remaining queue rather than burning quota.
 *
 * Caching: verification is effectively irreversible once true, so a hit is cached
 * for a week; 'unverified' is re-checked hourly because we may verify at any time.
 * Results stream into the query cache as they resolve, so early rows light up
 * without waiting for the whole queue.
 */
export type VerificationState = 'verified' | 'unverified' | 'unchecked';

const CACHE_KEY = 'tegridy_source_verified'; // 'tegridy_' => evictable, see lib/storage.ts:18
const CACHE_VERSION = 1;
const VERIFIED_TTL_MS = 7 * 24 * 60 * 60_000;
const UNVERIFIED_TTL_MS = 60 * 60_000;
const REQUEST_SPACING_MS = 250;

type CacheEntry = { state: VerificationState; at: number };
type CacheShape = { version: number; entries: Record<string, CacheEntry> };

function readCache(): Record<string, CacheEntry> {
  const parsed = safeJsonParse<CacheShape | null>(safeGetItem(CACHE_KEY), null);
  if (!parsed || parsed.version !== CACHE_VERSION || typeof parsed.entries !== 'object') return {};
  return parsed.entries || {};
}

function writeCache(entries: Record<string, CacheEntry>): void {
  safeSetItem(CACHE_KEY, JSON.stringify({ version: CACHE_VERSION, entries } satisfies CacheShape));
}

/** A cached entry is usable only while its per-state TTL holds. 'unchecked' is never cached. */
function isFresh(e: CacheEntry | undefined, now: number): e is CacheEntry {
  if (!e) return false;
  if (e.state === 'verified') return now - e.at < VERIFIED_TTL_MS;
  if (e.state === 'unverified') return now - e.at < UNVERIFIED_TTL_MS;
  return false;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Pure classifier for an Etherscan `getsourcecode` payload. Exported so the
 * honesty rule is unit-testable independently of fetch/React:
 * a malformed or error payload MUST yield 'unchecked', never 'unverified'.
 */
export function classifySourceCodeResponse(json: unknown): VerificationState {
  const j = json as { status?: unknown; result?: unknown } | null | undefined;
  if (!j || j.status !== '1' || !Array.isArray(j.result) || !j.result[0]) return 'unchecked';
  const r = j.result[0] as { ContractName?: unknown; SourceCode?: unknown };
  // Etherscan answers status:"1" with empty fields for an unverified address or
  // an EOA — that is a genuine negative, not a failure.
  const hasName = typeof r.ContractName === 'string' && r.ContractName.length > 0;
  const hasSource = typeof r.SourceCode === 'string' && r.SourceCode.length > 0;
  return hasName && hasSource ? 'verified' : 'unverified';
}

/**
 * Resolve ONE address. Returns 'unchecked' for every failure mode — the caller
 * cannot distinguish "we failed" from "not verified", and that is the point.
 */
async function checkOne(address: string, signal?: AbortSignal): Promise<VerificationState> {
  try {
    const res = await fetch(
      `/api/etherscan?module=contract&action=getsourcecode&address=${address}`,
      { signal },
    );
    if (res.status === 429) return 'unchecked'; // caller stops the queue
    if (!res.ok) return 'unchecked';
    return classifySourceCodeResponse(await res.json());
  } catch {
    return 'unchecked'; // network error / abort / non-JSON
  }
}

/**
 * @param addresses non-zero contract addresses. Callers MUST filter out
 *        undeployed/zero addresses before calling — we never query those.
 */
export function useSourceVerification(addresses: string[]): Record<string, VerificationState> {
  const queryClient = useQueryClient();
  const wanted = Array.from(new Set(addresses.map((a) => a.toLowerCase()))).sort();
  const queryKey = ['source-verification', wanted.join(',')];

  const { data } = useQuery({
    queryKey,
    enabled: wanted.length > 0,
    staleTime: Infinity, // verification does not churn; TTLs live in the storage cache
    gcTime: 24 * 60 * 60_000,
    refetchOnWindowFocus: false,
    retry: false, // a retry storm is exactly what trips the rate limit
    queryFn: async ({ signal }) => {
      const now = Date.now();
      const cached = readCache();
      const out: Record<string, VerificationState> = {};
      const misses: string[] = [];

      for (const a of wanted) {
        const e = cached[a];
        if (isFresh(e, now)) out[a] = e.state;
        else {
          out[a] = 'unchecked';
          misses.push(a);
        }
      }
      // Publish cache hits immediately so known rows paint on first frame.
      queryClient.setQueryData(queryKey, { ...out });

      for (let i = 0; i < misses.length; i++) {
        if (signal?.aborted) break;
        const a = misses[i]!;
        const state = await checkOne(a, signal);
        out[a] = state;
        if (state !== 'unchecked') {
          cached[a] = { state, at: Date.now() };
          writeCache(cached);
        }
        // Stream partial progress to the UI as each address resolves.
        queryClient.setQueryData(queryKey, { ...out });
        // A 429 means we are over quota — stop rather than burn the rest of the
        // queue. Everything still outstanding stays 'unchecked' (honest).
        if (state === 'unchecked') {
          const remaining = misses.length - i - 1;
          if (remaining > 0) {
            // Distinguish "one flaky address" from "we are throttled": only bail
            // out early if we have not resolved anything at all this pass.
            const anyResolved = Object.values(out).some((v) => v !== 'unchecked');
            if (!anyResolved && i >= 2) break;
          }
        }
        if (i < misses.length - 1) await sleep(REQUEST_SPACING_MS);
      }
      return out;
    },
  });

  // Default every requested address to 'unchecked' so nothing renders a verdict
  // before its answer actually arrives.
  const result: Record<string, VerificationState> = {};
  for (const a of wanted) result[a] = data?.[a] ?? 'unchecked';
  return result;
}
