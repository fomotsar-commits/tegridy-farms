// ─── R041 — image / metadata URI safety helpers ─────────────────────
//
// Centralised URI-scheme allowlist, IPFS round-robin, image fallback.
// Used by:
//   - hooks/useNFTDropV2.ts        (contractURI off-chain JSON fetch)
//   - nakamigos/components/NftImage.jsx (grid metadata fetch fan-out)
//   - components/ArtImg.tsx        (page art rendering)
//
// Why this file exists: an attacker-controlled `contractURI()` can return
// arbitrary schemes (`javascript:`, `file:`, `gopher:`…). Without a strict
// allowlist, those flow into `fetch()` and `<img src>`. SVG `data:` URIs
// can carry inline `<script>` and execute on render. We keep the list of
// allowed schemes narrow and reject anything else.
//
// Battle-tested defaults:
//   - schemes per OpenSea metadata standard: https, ipfs, ar, data
//   - data: limited to a fixed image MIME allowlist (NO svg+xml — see below)
//   - IPFS gateways: the one ordered list in lib/ipfsGateways.ts
//   - concurrency cap of 5 for parallel metadata fetches (Alchemy / OpenSea)
//
// SVG note: rather than ship DOMPurify and parse-then-sanitise, we reject
// `data:image/svg+xml` URIs outright in `isAllowedUri`. The mandate calls
// for sanitising SVG before render — the safest sanitiser is "don't render
// SVG you didn't author". If a future surface needs SVG, swap this single
// helper to allow it through DOMPurify behind an explicit feature flag.

import {
  IPFS_GATEWAYS,
  IPFS_STEP_TIMEOUT_MS,
  fetchIpfsStep,
  ipfsGatewayUrls,
  liveIpfsUrl,
} from './ipfsGateways';

const HTTPS_RE = /^https:\/\//i;
const IPFS_RE = /^ipfs:\/\//i;
const AR_RE = /^ar:\/\//i;
// data:image/(png|jpeg|webp|gif);base64,...
// Intentionally excludes image/svg+xml — see file-level note.
const DATA_RE = /^data:image\/(png|jpeg|webp|gif);base64,[A-Za-z0-9+/=]+$/i;

export const ALLOWED_SCHEMES = ['https', 'ipfs', 'ar', 'data'] as const;

/// Returns true iff the URI uses an allowlisted scheme. Logs (debug) and
/// returns false for anything else so callers can fall back to a placeholder.
export function isAllowedUri(uri: string | null | undefined): boolean {
  if (!uri) return false;
  const trimmed = uri.trim();
  if (HTTPS_RE.test(trimmed)) return true;
  if (IPFS_RE.test(trimmed)) return true;
  if (AR_RE.test(trimmed)) return true;
  // For data: URIs we require a concrete image MIME from the allowlist AND
  // base64 framing. Anything else (svg, html, javascript, plain) is denied.
  if (trimmed.toLowerCase().startsWith('data:')) {
    return DATA_RE.test(trimmed);
  }
  return false;
}

// ─── IPFS gateway round-robin ───────────────────────────────────────
// The gateway list and its order live in ./ipfsGateways (one list for the whole
// site, with the 2026-09-26 measurements and the dead hosts it must not re-add).
// Re-exported here because this module was their first home.
export { IPFS_GATEWAYS };

/// Every gateway URL for an IPFS URI (`ipfs://` or a known gateway URL, dead
/// ones included), in order; any other URI comes back alone.
export function ipfsCandidates(uri: string): string[] {
  if (!uri) return [];
  const gateways = ipfsGatewayUrls(uri);
  return gateways.length ? gateways : [uri.trim()];
}

/// Resolve any allowlisted URI into an HTTPS URL the browser can actually
/// fetch. Returns `null` for disallowed schemes (caller should treat as
/// "no image"). For ipfs:// and for a URL on a dead gateway (ipfs.io,
/// dweb.link...) returns the first live gateway URL; render it with
/// components/IpfsImg so a failed or hung gateway moves to the next one.
export function resolveSafeUrl(uri: string | null | undefined): string | null {
  if (!isAllowedUri(uri)) return null;
  const trimmed = (uri as string).trim();
  if (HTTPS_RE.test(trimmed) || IPFS_RE.test(trimmed)) return liveIpfsUrl(trimmed);
  if (AR_RE.test(trimmed)) return `https://arweave.net/${trimmed.slice(5)}`;
  // data: passes through after isAllowedUri vetted the MIME
  return trimmed;
}

/// Fetch with IPFS round-robin: try each gateway in order, return the
/// first 2xx Response. For non-IPFS URIs falls back to a single fetch.
export async function fetchWithIpfsFallback(
  uri: string,
  init?: RequestInit,
): Promise<Response> {
  if (!isAllowedUri(uri)) throw new Error('Disallowed URI scheme');
  const gateways = ipfsGatewayUrls(uri);
  const urls = gateways.length ? gateways : [resolveSafeUrl(uri) as string];
  let lastErr: unknown = null;
  for (const url of urls) {
    try {
      // Each gateway gets its own time limit: some hang instead of failing,
      // and a hang would otherwise keep every later gateway from being tried.
      const r = gateways.length
        ? await fetchIpfsStep(fetch, url, init?.signal, IPFS_STEP_TIMEOUT_MS, init)
        : await fetch(url, init);
      if (r.ok) return r;
      lastErr = new Error(`HTTP ${r.status}`);
    } catch (err) {
      // The CALLER's abort stops the walk immediately; a step timeout only
      // moves on to the next gateway.
      if (init?.signal?.aborted) throw err;
      lastErr = err;
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error('All gateways failed');
}

// ─── Concurrency limiter ────────────────────────────────────────────
// Tiny inline equivalent of `p-limit(n)` — avoids adding a new top-level
// dependency. Same usage shape: `const limit = createLimit(5); limit(fn)`.
export function createLimit(concurrency: number) {
  if (concurrency < 1) throw new Error('concurrency must be >= 1');
  let active = 0;
  const queue: Array<() => void> = [];

  const next = () => {
    if (active >= concurrency) return;
    const job = queue.shift();
    if (!job) return;
    active++;
    job();
  };

  return function limit<T>(fn: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const run = () => {
        fn()
          .then(resolve, reject)
          .finally(() => {
            active--;
            next();
          });
      };
      queue.push(run);
      next();
    });
  };
}

/// Shared 5-wide gate for grid metadata fan-out (Alchemy / OpenSea).
/// Module-scoped so every NftImage in the same tab shares the same budget.
export const metadataLimit = createLimit(5);

// ─── Placeholder ────────────────────────────────────────────────────
/// Public-path fallback used by `<img onError>`. Tracked here so every
/// surface uses the same asset and a missing file is obvious in QA.
export const PLACEHOLDER_NFT = '/placeholder-nft.svg';

/**
 * One-shot helper for `<img src>` and `<a href>` consumers: resolve to a
 * safe HTTPS URL or fall back to PLACEHOLDER_NFT for image surfaces /
 * undefined for link surfaces. Lets callers do
 *   `<img src={safeUrl(uri) ?? PLACEHOLDER_NFT} />`
 * without spreading the allowlist check across every component.
 */
export function safeUrl(uri: string | null | undefined): string | null {
  return resolveSafeUrl(uri);
}
