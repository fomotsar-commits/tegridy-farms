/**
 * Pre-hydration theme bootstrap — must run synchronously before CSS parse to
 * prevent FOUC. Reads the same localStorage key the runtime ThemeProvider
 * writes (`tegridy-theme`) and sets data-theme on <html> + updates the
 * theme-color meta. Default is `dark`; keep in lock-step with
 * frontend/src/contexts/ThemeContext.tsx.
 *
 * Served as a classic (non-module) script so it blocks until execution,
 * matching the old inline behaviour. Moved out of index.html so we can drop
 * 'unsafe-inline' from script-src in vercel.json.
 */
(function () {
  // The app is dark-only: the light theme was removed and ThemeContext migrates
  // any stale `tegridy-theme: 'light'` out of localStorage on mount. Honoring
  // 'light' here stamped data-theme="light" + a lavender theme-color for the
  // pre-hydration window with no light CSS behind it. Always dark; the
  // localStorage read stays only so the storage key remains documented in one
  // greppable place alongside ThemeContext.
  try {
    document.documentElement.setAttribute('data-theme', 'dark');
    var meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', '#060c1a');
  } catch (_e) {
    /* dark is the default markup state; nothing to recover */
  }

  // ─── The home hero preload (PERF-14) ──────────────────────────────────────
  //
  // This used to be an unconditional <link rel=preload> in index.html, so 274 KB
  // was fetched at high priority on EVERY route — the eight SOON routes and
  // every prerendered bungalow door included, none of which render it — and for
  // every bungalow visitor, whose home:0 resolves into their own art pool and
  // never into this file.
  //
  // Two conditions, both readable here and neither readable from a static tag:
  //   * we are on `/`. The hero is home:0 and nothing else renders it;
  //   * the CLASSIC skin is active. Only the default bungalow and a visitor who
  //     has chosen nothing draw from the classic pool.
  //
  // Deliberately fail-closed: any bungalow id other than the default loses the
  // preload, even the two that currently have no art pool of their own. A missed
  // preload is a slightly later paint; a wrong one is 274 KB of a picture the
  // visitor will not see. src/lib/heroPreload.test.ts pins the href against
  // pageArt('home', 0) and this id against DEFAULT_BUNGALOW_ID.
  var HERO_SRC = '/art/iphone/IMG_0148.jpg';
  var DEFAULT_BUNGALOW_ID = 'toweli';
  var BUNGALOW_STORAGE_KEY = 'tegridy-bungalow';
  try {
    if (window.location.pathname === '/') {
      var chosen =
        new URLSearchParams(window.location.search).get('bungalow') ||
        localStorage.getItem(BUNGALOW_STORAGE_KEY) ||
        '';
      if (chosen === '' || chosen === DEFAULT_BUNGALOW_ID) {
        var link = document.createElement('link');
        // setAttribute for all four, not the IDL properties: `as` is not
        // reflected as a content attribute everywhere (jsdom does not reflect
        // it at all), and a preload whose `as` never reaches the markup is a
        // preload the browser treats as an unknown destination and fetches
        // twice. Setting the attribute is unambiguous in every environment.
        link.setAttribute('rel', 'preload');
        link.setAttribute('as', 'image');
        link.setAttribute('href', HERO_SRC);
        link.setAttribute('fetchpriority', 'high');
        document.head.appendChild(link);
      }
    }
  } catch (_e2) {
    /* No preload is a slower first paint, never a broken one. */
  }
})();
