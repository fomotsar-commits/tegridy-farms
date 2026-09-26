// ─── IPFS gateways: the ONE list ─────────────────────────────────────
//
// Every IPFS read the site makes, an <img> or a fetch(), goes through this list.
// src/lib/imageSafety.ts, the Solana launcher's metadata check and the Nakamigos
// market (a .js tree) all import it from here, so the order cannot drift apart
// again. The hosts must also be in vercel.json's img-src and connect-src; the CSP
// test (src/lib/ipfsGateways.test.ts) fails when one is missing.
//
// ORDER, measured 2026-09-26 from real CIDs the site renders (Nakamigos, Jungle
// Bay, BAYLA), 8 CIDs x 3 tries, plus real <img> loads in Chromium and WebKit.
// Every gateway below returned byte-identical content, and BAYLA's raw CIDs
// hashed to their own digest:
//   1. ipfs.filebase.io   24/24, median 175ms. Slow on cold content under a burst.
//   2. ipfs.orbitor.dev   24/24, median 240ms, a 48-request burst in 3.1s (ChainSafe).
//   3. gateway.pinata.cloud  24/24 but median 5.6s: a slow last resort.
//   4. ipfs.aleph.cloud   20/24, slow burst: the tail.
// All four are public "light use" gateways (Filebase documents 200 requests/min;
// Pinata says not for production). A dedicated gateway is the long-term answer.
export const IPFS_GATEWAYS = [
  'https://ipfs.filebase.io/ipfs/',
  'https://ipfs.orbitor.dev/ipfs/',
  'https://gateway.pinata.cloud/ipfs/',
  'https://ipfs.aleph.cloud/ipfs/',
] as const;

// DEAD, 2026-09-26. Do not add these back. They are kept here only so a URL
// that already points at one (on-chain metadata, Alchemy's originalUrl, BAYLA's
// Jupiter icon) is rewritten onto a live gateway instead of rendering broken.
//   ipfs.io, dweb.link: Protocol Labs retired them on 2026-09-21. Path form
//     answers 403 with a Cloudflare "Just a moment..." challenge, which an <img>
//     can never pass; subdomain form answers 429 with a Sunset header.
//   w3s.link, storacha.link: redirect to dweb.link.
//   nftstorage.link: redirects to ipfs.io.
//   cloudflare-ipfs.com: no longer resolves (Cloudflare shut it in 2024).
// Also tested and rejected (not rewritten, just never used):
//   gateway.lighthouse.storage (402 for content it does not pin),
//   trustless-gateway.link (raw blocks only, 406), inbrowser.link (a 200
//   text/html service-worker page: a status check reads it as success),
//   4everland and ipfs.raribleuserdata.com (hang 30s without an error, which
//   stalls a fallback chain), ipfs.runfission.com (DNS gone).
export const DEAD_IPFS_GATEWAY_HOSTS = [
  'ipfs.io',
  'dweb.link',
  'w3s.link',
  'storacha.link',
  'nftstorage.link',
  'cloudflare-ipfs.com',
] as const;

// Several gateways HANG instead of failing on content they do not have cached,
// and a hung <img> or fetch never reaches the next gateway on its own. Each
// step gets this long before the caller moves on. Pinata's normal answer is
// 3-8s, so this is the lowest value that does not skip a working slow gateway.
export const IPFS_STEP_TIMEOUT_MS = 6000;

const IPFS_SCHEME = /^ipfs:\/\//i;
const LIVE_HOSTS = new Set(IPFS_GATEWAYS.map((g) => new URL(g).hostname));
const DEAD_HOSTS = new Set<string>(DEAD_IPFS_GATEWAY_HOSTS);

const isDeadHost = (host: string): boolean =>
  DEAD_HOSTS.has(host) || [...DEAD_HOSTS].some((d) => host.endsWith(`.${d}`));

type Parsed = { path: string; host: string | null };

/** The `<cid>/<path>` inside an `ipfs://` URI or a gateway URL we know, else null. */
function parse(uri: string | null | undefined): Parsed | null {
  if (!uri) return null;
  const t = uri.trim();
  if (IPFS_SCHEME.test(t)) {
    const path = t.slice('ipfs://'.length).replace(/^ipfs\//i, '');
    return path ? { path, host: null } : null;
  }
  let u: URL;
  try {
    u = new URL(t);
  } catch {
    return null;
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
  const host = u.hostname.toLowerCase();
  // Subdomain form, e.g. https://<cid>.ipfs.dweb.link/meta.json
  const [, cid, gatewayHost] = host.match(/^([a-z0-9]+)\.ipfs\.(.+)$/) ?? [];
  if (cid && gatewayHost && (LIVE_HOSTS.has(gatewayHost) || isDeadHost(gatewayHost))) {
    const rest = u.pathname === '/' ? '' : u.pathname;
    return { path: `${cid}${rest}${u.search}`, host };
  }
  if ((LIVE_HOSTS.has(host) || isDeadHost(host)) && u.pathname.startsWith('/ipfs/')) {
    const path = u.pathname.slice('/ipfs/'.length);
    return path ? { path: `${path}${u.search}`, host } : null;
  }
  return null;
}

/** True when the URI is IPFS content we can serve from a live gateway. */
export function isIpfsUri(uri: string | null | undefined): boolean {
  return parse(uri) !== null;
}

/**
 * Every gateway URL for an IPFS URI, in order. `ipfs://` and URLs on a known
 * gateway (live or dead) both count. Anything else returns [].
 */
export function ipfsGatewayUrls(uri: string | null | undefined): string[] {
  const p = parse(uri);
  return p ? IPFS_GATEWAYS.map((g) => `${g}${p.path}`) : [];
}

/**
 * The URL to render. `ipfs://` and dead-gateway URLs move onto the first live
 * gateway; a URL already on a live gateway, and every non-IPFS URL, comes back
 * unchanged (trimmed). null/undefined/'' pass through.
 */
export function liveIpfsUrl<T extends string | null | undefined>(uri: T): T | string {
  if (!uri) return uri;
  const p = parse(uri);
  if (!p) return uri.trim();
  if (p.host && LIVE_HOSTS.has(p.host)) return uri.trim();
  return `${IPFS_GATEWAYS[0]}${p.path}`;
}

/**
 * The gateway to try after `current` failed, or null when there is none left
 * (or `current` is not IPFS at all, so the caller's own fallback applies).
 * A URL on a dead gateway, or an `ipfs://` URI, restarts at the first live one.
 */
export function nextIpfsGatewayUrl(current: string | null | undefined): string | null {
  const p = parse(current);
  if (!p) return null;
  const t = (current as string).trim();
  const i = IPFS_GATEWAYS.findIndex((g) => t.startsWith(g));
  if (i === -1) return `${IPFS_GATEWAYS[0]}${p.path}`;
  return i + 1 < IPFS_GATEWAYS.length ? `${IPFS_GATEWAYS[i + 1]}${p.path}` : null;
}

/**
 * `onError` for a plain `<img>` that may show IPFS content: moves it to the
 * next gateway. Returns false when there is none left, so the caller can hide
 * it or show its placeholder.
 */
export function advanceIpfsImg(img: HTMLImageElement): boolean {
  const next = nextIpfsGatewayUrl(img.getAttribute('src'));
  if (!next) return false;
  img.src = next;
  return true;
}

/**
 * One gateway attempt with its own time limit. Aborts when `outer` aborts (the
 * caller's deadline) or after `stepMs` (this gateway is hanging). The caller
 * tells the two apart with `outer.aborted`.
 */
export async function fetchIpfsStep(
  fetchImpl: typeof fetch,
  url: string,
  outer: AbortSignal | null | undefined,
  stepMs: number = IPFS_STEP_TIMEOUT_MS,
  init?: RequestInit,
): Promise<Response> {
  const ac = new AbortController();
  const onAbort = () => ac.abort();
  if (outer) {
    if (outer.aborted) ac.abort();
    else outer.addEventListener('abort', onAbort, { once: true });
  }
  const timer = setTimeout(() => ac.abort(), stepMs);
  try {
    return await fetchImpl(url, { ...init, signal: ac.signal });
  } finally {
    clearTimeout(timer);
    outer?.removeEventListener('abort', onAbort);
  }
}
