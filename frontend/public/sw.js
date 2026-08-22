/* Tegridy Farms app-shell service worker.
 *
 * THE ONE RULE: this worker may never answer a question about the chain.
 *
 * A cache that serves a stale read as a fresh one is worse than no cache at
 * all, because the staleness is invisible — a balance, a price, a pool reserve
 * or an allowance handed back from disk looks exactly like one read a moment
 * ago, and every honesty gate in the app above it is bypassed by the time the
 * value reaches a component. So this worker caches EXACTLY two things: the
 * offline notice, and build assets that are content-addressed and therefore
 * cannot go stale. Nothing else is cached, ever, under any storage pressure.
 *
 * The corollary is the shape of the fetch handler: it calls respondWith() only
 * for the requests it actually owns and RETURNS for everything else, leaving the
 * browser's own networking untouched. That is deliberate twice over. It keeps
 * API and RPC traffic out of any cache by construction rather than by an
 * exclusion list somebody has to maintain, and it keeps third-party requests out
 * of the worker entirely — a worker that re-issued them with its own fetch()
 * would be subject to the worker's connect-src, and vercel.json's CSP would
 * start refusing aggregator and RPC calls that work fine today.
 *
 * SCOPE. Registered at "/" from src/lib/pwa/serviceWorker.ts, which refuses to
 * register when the nakamigos push worker already owns that scope — read the
 * comment there before changing either side.
 *
 * NO BACKGROUND WORK. No periodic sync, no background fetch, no push handling
 * (that is /push-sw.js's job and its alone). This venue runs no keeper and this
 * file must not imply otherwise.
 */

const VERSION = 'v1';
const SHELL_CACHE = `tegridy-shell-${VERSION}`;
const ASSET_CACHE = `tegridy-assets-${VERSION}`;
const KEEP = [SHELL_CACHE, ASSET_CACHE];

const OFFLINE_URL = '/offline.html';

/* Prefixes whose contents are immutable for the life of a deployment —
 * vercel.json serves both with `max-age=31536000, immutable`, because the
 * filenames carry a content hash (/assets) or never change (/fonts). Cache-first
 * is safe ONLY because of that: a hit is byte-identical to what the network
 * would return, so there is no such thing as a stale answer here.
 *
 * /art is deliberately absent despite being static-ish: it is served with a
 * 7-day max-age, the art-studio rewrites it, and it is large. */
const IMMUTABLE_PREFIXES = ['/assets/', '/fonts/'];

function isImmutableAsset(pathname) {
  return IMMUTABLE_PREFIXES.some((prefix) => pathname.startsWith(prefix));
}

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE).then((cache) =>
      // `reload` so an install never adopts whatever the HTTP cache happens to
      // be holding for the offline page.
      cache.add(new Request(OFFLINE_URL, { cache: 'reload' })),
    ),
  );
  // skipWaiting() is NOT called. A worker that takes over mid-session can start
  // serving a new deployment's asset cache to a page built against the old one.
  // The update lands on the next navigation instead.
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => !KEEP.includes(key)).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

/* Network first, and the offline notice ONLY as a last resort.
 *
 * Note what is not here: the cached document is never index.html. Booting the
 * app from cache with no network would render every panel's own "unavailable"
 * state, which is honest — but it would also render the app's chrome, its
 * headline numbers' placeholders and its persisted local state, and a reader
 * arriving at a full-looking app has to work out for themselves that none of it
 * was read. A page that says "you are offline" and shows nothing else cannot be
 * misread. */
async function navigateOrExplainOffline(request) {
  try {
    return await fetch(request);
  } catch {
    const cached = await caches.match(OFFLINE_URL, { cacheName: SHELL_CACHE });
    if (cached) return cached;
    return new Response(
      'You are offline, and the offline notice was not cached. Nothing shown here was read from the network.',
      { status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8' } },
    );
  }
}

async function immutableAsset(request) {
  const cache = await caches.open(ASSET_CACHE);
  const hit = await cache.match(request);
  if (hit) return hit;

  const response = await fetch(request);
  // `basic` excludes opaque and CORS responses; 200 excludes partials and
  // redirects. Storing either would put something in the cache whose freshness
  // and completeness this worker cannot reason about.
  if (response && response.status === 200 && response.type === 'basic') {
    cache.put(request, response.clone());
  }
  return response;
}

self.addEventListener('fetch', (event) => {
  const request = event.request;

  // Anything that is not a plain same-origin GET is left entirely alone: the
  // browser performs it exactly as it would with no worker installed.
  if (request.method !== 'GET') return;
  if (request.headers && request.headers.has('range')) return;

  let url;
  try {
    url = new URL(request.url);
  } catch {
    return;
  }
  if (url.origin !== self.location.origin) return;

  // Same-origin API traffic. Already excluded by the allowlist below — repeated
  // as an explicit early return because this is the one path where a future
  // "just cache the GETs" change would silently start serving stale chain reads.
  if (url.pathname === '/api' || url.pathname.startsWith('/api/')) return;

  if (request.mode === 'navigate') {
    event.respondWith(navigateOrExplainOffline(request));
    return;
  }

  if (isImmutableAsset(url.pathname)) {
    event.respondWith(immutableAsset(request));
  }

  // Everything else — HTML fragments, /art, the manifests, anything new someone
  // adds under public/ — falls through uncached and unintercepted.
});
