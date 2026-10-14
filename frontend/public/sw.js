/* The app-shell service worker, registered at "/" by src/lib/pwa/serviceWorker.ts,
 * which yields the scope to the notification worker (/push-sw.js).
 * THE ONE RULE: this worker never answers a question about the chain. A balance or
 * a price served from disk looks like one read a moment ago. So it caches two things
 * only, under any storage pressure: the offline notice, and build assets.
 * No push, no sync, no background fetch: this venue runs no keeper. */

// BUMP THIS WHENEVER offline.html CHANGES. Only `install` fills SHELL_CACHE, and it
// runs again only when THIS file changes byte-wise. A bump also empties every
// visitor's asset cache. The cache NAMES keep their `tegridy-` prefix: they are
// storage keys, and `activate` deletes anything not in KEEP.
const VERSION = 'v2';
const SHELL_CACHE = `tegridy-shell-${VERSION}`;
const ASSET_CACHE = `tegridy-assets-${VERSION}`;
const KEEP = [SHELL_CACHE, ASSET_CACHE];

const OFFLINE_URL = '/offline.html';

/* Paths vercel.json serves with `max-age=31536000, immutable`: a name carries a
 * content hash (/assets) or never changes (/fonts). Cache-first is safe ONLY because
 * of that: a stored file is the file the host would send. The one exception is a
 * name the host does not have: see isPage().
 * /art is deliberately absent: a 7-day max-age, rewritten by the art studio, large. */
const IMMUTABLE_PREFIXES = ['/assets/', '/fonts/'];

function isImmutableAsset(pathname) {
  return IMMUTABLE_PREFIXES.some((prefix) => pathname.startsWith(prefix));
}

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE).then((cache) =>
      // `reload`: an install never adopts what the browser's cache holds for this page.
      cache.add(new Request(OFFLINE_URL, { cache: 'reload' })),
    ),
  );
  // skipWaiting() is NOT called. A worker that takes over mid-session can serve a
  // new deployment's asset cache to a page built against the old one. The update
  // lands on the next navigation.
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => !KEEP.includes(key)).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

/* Network first, and the offline notice ONLY when the network fails. The cached
 * document is never index.html: an app booted from disk shows its chrome and its
 * stored local state, and the reader has to work out that none of it was read. A
 * page that says "you are offline" and shows nothing else cannot be misread. */
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

/* The host answers a name it does not have with the app's page: status 200, type
 * `basic`, and the year-long header, which vercel.json keys on the path. No build
 * asset is HTML, so a page under an asset's name is never stored and never served
 * from this cache. */
function isPage(response) {
  return /^\s*text\/html/i.test(response.headers.get('content-type') || '');
}

async function immutableAsset(request) {
  const cache = await caches.open(ASSET_CACHE);
  const hit = await cache.match(request);
  if (hit && !isPage(hit)) return hit;
  // A page an earlier worker stored here: dropped, and the name is asked for again.
  if (hit) await cache.delete(request);

  let response = await fetch(request);
  // The browser's own cache keeps such a page for the same year. `reload` asks the
  // host and replaces what the browser holds, so a name the host has again loads.
  if (isPage(response)) response = await fetch(request, { cache: 'reload' });

  // `basic` excludes opaque and CORS responses; 200 excludes partials and
  // redirects. This worker cannot tell whether either is fresh or whole.
  if (response && response.status === 200 && response.type === 'basic' && !isPage(response)) {
    cache.put(request, response.clone());
  }
  return response;
}

self.addEventListener('fetch', (event) => {
  const request = event.request;

  // respondWith() is called only for the requests this worker owns. Every `return`
  // below leaves the request to the browser, as with no worker installed. So API
  // and RPC traffic meets no cache, with no exclusion list to maintain, and no
  // third-party request is re-issued by the worker, where its connect-src (the CSP
  // in vercel.json) would refuse aggregator and RPC calls that work today.
  if (request.method !== 'GET') return;
  if (request.headers && request.headers.has('range')) return;

  let url;
  try {
    url = new URL(request.url);
  } catch {
    return;
  }
  if (url.origin !== self.location.origin) return;

  // Same-origin API traffic. The two branches below already leave it out. It has
  // its own return because this is the one path where a "just cache the GETs"
  // change would start serving stale chain reads.
  if (url.pathname === '/api' || url.pathname.startsWith('/api/')) return;

  if (request.mode === 'navigate') {
    event.respondWith(navigateOrExplainOffline(request));
    return;
  }

  if (isImmutableAsset(url.pathname)) {
    event.respondWith(immutableAsset(request));
  }

  // Everything else (HTML fragments, /art, the manifests, anything new under
  // public/) falls through, uncached and unintercepted.
});
