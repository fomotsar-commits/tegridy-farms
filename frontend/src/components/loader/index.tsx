import { Suspense, lazy, useEffect, useRef, useState, type ReactNode } from 'react';
import { shouldSkipAtMount } from './skip';

/**
 * The splash's eager shell (PERF-16, 2026-09-03).
 *
 * AppLoader.tsx plus its eight phase modules and three fx modules — an audio
 * engine and a post-processing pass among them — are ~93 KB of source, and they
 * were STATIC imports from the layout, which put the whole intro in the entry
 * chunk. Every visitor paid for it before first paint, including the two groups
 * the loader itself refuses to play for: repeat visitors within a session, and
 * anyone who asked for reduced motion. Measured on this branch: the entry
 * chunk's static closure drops 43,446 bytes raw / 13,246 gzipped.
 *
 * WHAT STAYS EAGER IS THE DECISION, NOT THE ART. `shouldSkipAtMount()` runs in a
 * `useState` initializer here, exactly where it used to run inside AppLoader, so
 * its `tf_loaded` write still lands before AppLayout's `freshSplash` initializer
 * reads it — the ordering that decides who auto-opens the bungalow picker.
 *
 * CHILDREN ARE NOT BEHIND THE SUSPENSE BOUNDARY. Rendering them inside the lazy
 * component would hold the entire app tree until the intro chunk arrived, which
 * is a worse first paint than the one this change is buying. They mount
 * immediately and the overlay lands on top of them a moment later, which is what
 * it did before: AppLoader has always rendered `{children}` and then the
 * overlay, in that order.
 */
const LoaderOverlay = lazy(() => import('./AppLoader').then((m) => ({ default: m.AppLoader })));

export function AppLoader({
  onComplete,
  children,
}: {
  onComplete?: () => void;
  children?: ReactNode;
}) {
  const [skipped] = useState(() => shouldSkipAtMount());
  const fired = useRef(false);

  // Consumers expect exactly one onComplete call whether the splash played or
  // was skipped — AppLayout's whole first-visit sequence (onboarding modal,
  // bungalow picker) hangs off it. When it plays, the overlay fires it from
  // `finalize`; when it does not, nothing else would.
  useEffect(() => {
    if (!skipped || fired.current) return;
    fired.current = true;
    onComplete?.();
  }, [skipped, onComplete]);

  return (
    <>
      {children}
      {!skipped && (
        <Suspense fallback={null}>
          <LoaderOverlay onComplete={onComplete} />
        </Suspense>
      )}
    </>
  );
}
