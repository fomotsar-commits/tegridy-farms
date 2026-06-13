import { useEffect, useState } from "react";

// T10 (F558) — single app-wide reduced-motion gate for the JS-driven motion
// layers. The CSS `animation-duration: 0.01ms` kill in App.css cannot stop
// framer-motion (it animates inline styles) or rAF/canvas physics, so the
// looping background art, splash physics, and orb/ray layers ignored the OS
// preference. Components consult this hook to render static frames instead.
//
// framer's <MotionConfig reducedMotion="user"> (added at the Nakamigos tree
// root) handles the declarative `motion.*` entrances automatically; this hook
// covers the imperative/looping layers that MotionConfig can't reach.

const QUERY = "(prefers-reduced-motion: reduce)";

function getInitial() {
  if (typeof window === "undefined" || !window.matchMedia) return false;
  try {
    return window.matchMedia(QUERY).matches;
  } catch {
    return false;
  }
}

/**
 * @returns {boolean} true when the user has requested reduced motion.
 */
export default function usePrefersReducedMotion() {
  const [reduced, setReduced] = useState(getInitial);

  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return undefined;
    let mql;
    try {
      mql = window.matchMedia(QUERY);
    } catch {
      return undefined;
    }
    const onChange = (e) => setReduced(e.matches);
    // addEventListener is the modern API; addListener is the legacy fallback
    // for older Safari.
    if (mql.addEventListener) mql.addEventListener("change", onChange);
    else if (mql.addListener) mql.addListener(onChange);
    setReduced(mql.matches);
    return () => {
      if (mql.removeEventListener) mql.removeEventListener("change", onChange);
      else if (mql.removeListener) mql.removeListener(onChange);
    };
  }, []);

  return reduced;
}
