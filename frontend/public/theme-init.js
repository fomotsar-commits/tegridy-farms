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
  var HERO_SRC = '/art/door-home.jpg';
  // The srcset ArtImg asks for in production, and the static first frame's <img>
  // too (answer ten, ruling 2). Without it this preload fetched the 2,048 px
  // original while the page drew a 960 px webp: the hero, twice, on every phone.
  // Pinned against artSrcSet's own arithmetic by src/lib/heroPreload.test.ts.
  var HERO_SRCSET = '/_derived/art/door-home-jpg-128.webp 128w, /_derived/art/door-home-jpg-480.webp 480w, /_derived/art/door-home-jpg-960.webp 960w, /art/door-home.jpg 2048w';
  var VENUE_ID = 'venue';
  var BUNGALOW_STORAGE_KEY = 'tegridy-bungalow';
  try {
    if (window.location.pathname === '/') {
      var chosen =
        new URLSearchParams(window.location.search).get('bungalow') ||
        localStorage.getItem(BUNGALOW_STORAGE_KEY) ||
        '';
      // '' is a first-ever visit and 'venue' is the "seen, chose nothing"
      // sentinel; both render the venue's backdrop at `/`. Any other stored skin
      // is mid-reset — the index route is a venue door that persists the
      // sentinel and reloads — so it gets no preload rather than the wrong one,
      // which is the trade this file already states: a missed preload is a
      // slightly later paint, a wrong one is a picture the visitor never sees.
      if (chosen === '' || chosen === VENUE_ID) {
        // ANSWER TEN, RULING 2: open the static first frame. index.html ships the
        // hero inside #root, hidden by default, because the SPA fallback serves
        // that same file on every route. This is the one place that knows both
        // conditions under which the venue hero is what `/` will render.
        document.documentElement.setAttribute('data-first-frame', 'venue');
        var link = document.createElement('link');
        // setAttribute for all four, not the IDL properties: `as` is not
        // reflected as a content attribute everywhere (jsdom does not reflect
        // it at all), and a preload whose `as` never reaches the markup is a
        // preload the browser treats as an unknown destination and fetches
        // twice. Setting the attribute is unambiguous in every environment.
        link.setAttribute('rel', 'preload');
        link.setAttribute('as', 'image');
        link.setAttribute('href', HERO_SRC);
        link.setAttribute('imagesrcset', HERO_SRCSET);
        link.setAttribute('imagesizes', '100vw');
        link.setAttribute('fetchpriority', 'high');
        document.head.appendChild(link);
      }
    }
  } catch (_e2) {
    /* No preload is a slower first paint, never a broken one. */
  }

  // ─── The first frame's field (answer ten, ruling 2) ────────────────────────
  //
  // Once the static markup exists: on `/` with the gate open, a shared read link
  // (/?heat=<address>) fills the field so the number a stranger followed is
  // already there before React; any OTHER query parameter rides along as a hidden
  // input, or a native submit would drop a referral's ?ref= on the floor. Off the
  // gate, the frame is removed outright: hidden is not absent, and a crawler or a
  // screen reader on /farm has no business with the venue's H1.
  function wireFirstFrame() {
    try {
      var frame = document.getElementById('first-frame');
      if (!frame) return;
      if (document.documentElement.getAttribute('data-first-frame') !== 'venue') {
        frame.parentNode.removeChild(frame);
        return;
      }
      var form = frame.querySelector('form');
      var field = form && form.querySelector('input[name="heat"]');
      if (!form || !field) return;
      var params = new URLSearchParams(window.location.search);
      var heat = params.get('heat');
      if (heat && !field.value) field.value = heat.trim().slice(0, 64);
      params.forEach(function (value, key) {
        if (key === 'heat') return;
        var hidden = document.createElement('input');
        hidden.type = 'hidden';
        hidden.name = key;
        hidden.value = value;
        form.appendChild(hidden);
      });
    } catch (_e3) {
      /* The frame works as plain HTML without any of this. */
    }
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', wireFirstFrame, { once: true });
  } else {
    wireFirstFrame();
  }
})();
