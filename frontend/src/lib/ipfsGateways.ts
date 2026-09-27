// ─── IPFS gateways: the ONE list ─────────────────────────────────────
//
// Every IPFS read the site makes, an <img> or a fetch(), goes through this list.
// src/lib/imageSafety.ts, the Solana launcher's metadata check and the Nakamigos
// market (a .js tree) all import it from here, so the order cannot drift apart
// again. The hosts must also be in vercel.json's img-src and connect-src; the CSP
// test (src/lib/ipfsGateways.test.ts) fails when one is missing.
//
// ORDER, measured 2026-09-26 with curl from real CIDs the site renders
// (Jungle Bay PNGs, 0.56-2.6 MB). "ttfb" is time to the first byte; for an
// <img> that is what the hang timer below measures, not the whole download.
//   COLD: 8 Jungle Bay tokens nobody had requested, all 4 gateways at once.
//   AGAIN: the same 8 a minute later, plus 1.png (long cached) 3 times.
//   1. ipfs.filebase.io   cold: 4/8 at 1.6-2.6s, 1 at 8.9s, 1 at 34s, 2 still
//        silent at 40s. Again: 7/8 at 0.10-1.3s, and 2466 hung again. 1.png 0.1s.
//   2. gateway.pinata.cloud  cold 8/8 at 4.0-7.5s, again 8/8 at 3.3-7.2s, 1.png
//        3.7-6.7s. Slow, but the ONLY gateway that served every uncached token,
//        so it goes second: behind a hung filebase, that is where the image is.
//   3. ipfs.aleph.cloud   cold 0/8 (504 after 30s); again 4/8 at 2.1-16s; 1.png
//        3/3 at 0.6-0.9s. It serves what someone has asked it for before.
//   4. ipfs.orbitor.dev   0/19: every request a 504 after 30s, 1.png included,
//        which it served in 240ms earlier the same day. Kept last, not removed:
//        it costs one step budget only after the three above have all failed.
// Every gateway that answered returned byte-identical content. All four are
// public "light use" gateways (Filebase documents 200 requests/min; Pinata says
// not for production). A dedicated gateway is the long-term answer.
export const IPFS_GATEWAYS = [
  'https://ipfs.filebase.io/ipfs/',
  'https://gateway.pinata.cloud/ipfs/',
  'https://ipfs.aleph.cloud/ipfs/',
  'https://ipfs.orbitor.dev/ipfs/',
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

// Several gateways HANG instead of failing on content they do not have (filebase
// on some uncached tokens, orbitor and aleph for 30s before a 504), and a hung
// <img> or fetch never reaches the next gateway on its own. So each gateway gets
// this long to START answering before the caller moves on:
//   - fetch(): the time until the response headers arrive.
//   - <img>: the time until the first image bytes arrive. From the header onward
//     a browser reports the image's size (naturalWidth) while `complete` is
//     still false: measured 2026-09-26 in Chromium and WebKit on a PNG and a
//     JPEG trickled over 10s, naturalWidth was set within 1s. So a large image
//     that is still downloading is never cut off, however long it takes.
// Pinata, the one gateway that served every uncached token, took up to 7.5s to
// its first byte (19 requests, 3.3-7.5s), so 10s keeps it with room to spare.
//
// THE PRICE of never cutting a slow download: an <img> on a gateway that sends
// the image header and then stalls is never left. Its naturalWidth is set, so
// the timer reads it as a live download, and it stays half-drawn or blank on
// that gateway until the browser gives up on the connection, if it ever does.
// Telling a stalled download from a slow one would need a byte count, which an
// <img> does not expose, and restarting a slow 2.6 MB image on the next gateway
// every 10s (so it never finishes) is the worse failure. Every hang measured on
// 2026-09-26 came before the first byte, which the timer does catch.
// (The metadata check's fetch() has no such blind spot: its step bounds the
// body read too, in lib/launcher/solana/metadataUri.ts.)
export const IPFS_STEP_TIMEOUT_MS = 10_000;

const IPFS_SCHEME = /^ipfs:\/\//i;
const LIVE_HOSTS = new Set(IPFS_GATEWAYS.map((g) => new URL(g).hostname));
const DEAD_HOSTS = new Set<string>(DEAD_IPFS_GATEWAY_HOSTS);

// Other gateways we do not serve from, whose URLs still reach us (collection
// metadata, e.g. Nakamigos' alchemy.mypinata.cloud). Pinata dedicated gateways
// (<name>.mypinata.cloud) are not in the CSP, so the browser blocks them; the
// same CID is moved onto the live list instead, like a dead gateway's URL.
const FOREIGN_GATEWAY_SUFFIXES = ['.mypinata.cloud'] as const;

const isRewrittenHost = (host: string): boolean =>
  DEAD_HOSTS.has(host) ||
  [...DEAD_HOSTS].some((d) => host.endsWith(`.${d}`)) ||
  FOREIGN_GATEWAY_SUFFIXES.some((s) => host.endsWith(s));

type Parsed = { path: string; host: string | null };

/**
 * The `<cid>/<path>` inside an `ipfs://` URI or a gateway URL we know, else null.
 *
 * A gateway URL's query string is dropped: every URL built from `path` is on a
 * different host, and a query belongs to the host it was written for. A Pinata
 * dedicated gateway's URL can carry its access token (?pinataGatewayToken=...),
 * which must not be sent to four other gateways. The content is the CID path.
 */
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
  if (cid && gatewayHost && (LIVE_HOSTS.has(gatewayHost) || isRewrittenHost(gatewayHost))) {
    const rest = u.pathname === '/' ? '' : u.pathname;
    return { path: `${cid}${rest}`, host };
  }
  if ((LIVE_HOSTS.has(host) || isRewrittenHost(host)) && u.pathname.startsWith('/ipfs/')) {
    const path = u.pathname.slice('/ipfs/'.length);
    return path ? { path, host } : null;
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
 * Watches one IPFS `<img>` on one gateway and calls `onHang` when that gateway
 * has sent NO image bytes within `stepMs`. A hung gateway never fires onError,
 * so without this the walk down the list stops at it.
 *
 * "No bytes" is `naturalWidth === 0` while not `complete`: browsers report the
 * size as soon as the image header arrives, long before the download ends (see
 * IPFS_STEP_TIMEOUT_MS), so a slow but live download is left to finish. A
 * `complete` image either loaded or already fired onError, which moves it on.
 *
 * `lazy`: the clock runs only while the browser can be fetching the image, so
 * a lazy image's clock starts once it is IN the viewport, with no margin.
 * Engines request a lazy image at different distances, measured 2026-09-26:
 * Chromium from ~1250px ahead, WebKit (Safari, and every browser on iOS) from
 * about one viewport height (an 800px window: requested at 700px below the
 * fold, not at 1000px). The clock used to start at 1250px, so in WebKit an
 * image 900-1250px below the fold, never requested, walked all four gateways
 * with nobody looking and was given up on. Once an image is in the viewport,
 * both engines have requested it. After that the clock keeps running if it
 * scrolls away again: neither engine cancels the request (measured: a held
 * request stayed open 5s after scrolling away), so the gateway has had its
 * step. The next gateway's clock waits for the image to be in view again, so
 * at most one gateway is left per sighting. Inside a scrolling panel (the
 * market gallery grid) the image must also be inside the panel's visible box.
 * e2e/ipfs-lazy-hang.spec.ts pins this in Chromium and WebKit.
 * Every gateway, the last one included, gets the timer, so a hang on
 * the last one reaches the caller's own fallback instead of waiting ~30s.
 * Returns the cleanup.
 */
export function watchIpfsImg(
  img: HTMLImageElement,
  { lazy = false, stepMs = IPFS_STEP_TIMEOUT_MS, onHang }: { lazy?: boolean; stepMs?: number; onHang: () => void },
): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let io: IntersectionObserver | null = null;
  const arm = () => {
    if (timer !== null) return;
    timer = setTimeout(() => {
      if (img.complete || img.naturalWidth > 0) return;
      onHang();
    }, stepMs);
  };
  if (lazy && typeof IntersectionObserver === 'function') {
    io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          io?.disconnect();
          arm();
        }
      },
      // The viewport itself: see `lazy` above.
      { rootMargin: '0px' },
    );
    io.observe(img);
  } else {
    arm();
  }
  return () => {
    io?.disconnect();
    if (timer !== null) clearTimeout(timer);
  };
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
