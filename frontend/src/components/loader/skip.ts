/**
 * Does the splash play at all, decided synchronously at mount.
 *
 * Split out of AppLoader.tsx (PERF-16, 2026-09-03) because it is the ONE part
 * of the loader that has to be eager. AppLoader and its eight phase modules and
 * three fx modules — an audio engine among them — total ~93 KB of source and
 * landed in the ENTRY chunk, so every visitor downloaded the whole intro before
 * first paint even though this function decides, before a single frame, that
 * repeat visitors and `prefers-reduced-motion` users will never see it. The
 * decision is ~20 lines; it stays. The choreography is now fetched only by the
 * visitors who actually watch it.
 *
 * R007 Pattern B — the decision happens during `useState` lazy init so the
 * loader never renders for those visitors, rather than being unmounted by an
 * effect one frame later.
 *
 * SIDE EFFECT, DELIBERATE: a reduced-motion visitor's `tf_loaded` is written
 * here, during render of the loader's own shell and therefore BEFORE AppLayout's
 * `freshSplash` initializer reads it. Moving this write later changes which
 * visitors auto-open the bungalow picker.
 */
export function shouldSkipAtMount(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    if (sessionStorage.getItem('tf_loaded')) return true;
  } catch { /* SSR / privacy mode */ }
  try {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      try { sessionStorage.setItem('tf_loaded', '1'); } catch { /* noop */ }
      return true;
    }
  } catch { /* matchMedia unavailable */ }
  return false;
}
