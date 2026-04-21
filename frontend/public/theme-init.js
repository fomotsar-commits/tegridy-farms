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
  try {
    var t = localStorage.getItem('tegridy-theme');
    if (t !== 'dark' && t !== 'light') t = 'dark';
    document.documentElement.setAttribute('data-theme', t);
    var meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', t === 'dark' ? '#060c1a' : '#f5f3ff');
  } catch (_e) {
    document.documentElement.setAttribute('data-theme', 'dark');
  }
})();
