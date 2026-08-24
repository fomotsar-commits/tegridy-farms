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
})();
